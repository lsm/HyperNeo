import {
  DAEMON_CONFIG_KEY_CATALOG,
  resolveDaemonConfig,
  type DaemonBehaviorConfig,
  type DaemonConfigKeyEntry,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../storage/sqlite-compat.ts';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus.ts';

export const DAEMON_CONFIG_UPDATED = 'daemonConfig.updated';

export class DaemonConfigValidationError extends Error {
  constructor(
    public readonly key: string,
    message: string
  ) {
    super(message);
    this.name = 'DaemonConfigValidationError';
  }
}

export interface DaemonConfigUpdateResult {
  config: DaemonBehaviorConfig;
  changedKeys: string[];
}

const CATALOG_BY_FAMILY = new Map<string, Map<string, DaemonConfigKeyEntry>>();
for (const entry of DAEMON_CONFIG_KEY_CATALOG) {
  let familyKeys = CATALOG_BY_FAMILY.get(entry.family);
  if (!familyKeys) {
    familyKeys = new Map();
    CATALOG_BY_FAMILY.set(entry.family, familyKeys);
  }
  familyKeys.set(entry.key, entry);
}

function catalogValue(
  config: DaemonBehaviorConfig,
  entry: DaemonConfigKeyEntry
): number | boolean | undefined {
  const family = config[entry.family] as Record<string, unknown> | undefined;
  return family?.[entry.key] as number | boolean | undefined;
}

function validatePatchValue(entry: DaemonConfigKeyEntry, value: unknown): void {
  if (entry.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new DaemonConfigValidationError(entry.key, `${entry.key} must be a boolean`);
    }
    return;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DaemonConfigValidationError(entry.key, `${entry.key} must be an integer`);
  }
  if (entry.min !== undefined && value < entry.min) {
    throw new DaemonConfigValidationError(entry.key, `${entry.key} must be >= ${entry.min}`);
  }
  if (entry.max !== undefined && value > entry.max) {
    throw new DaemonConfigValidationError(entry.key, `${entry.key} must be <= ${entry.max}`);
  }
}

function applyValidatedPatch(
  stored: Partial<DaemonBehaviorConfig>,
  patch: Partial<DaemonBehaviorConfig>
): Partial<DaemonBehaviorConfig> {
  const merged = { ...stored } as Record<string, Record<string, unknown>>;
  for (const [family, familyPatch] of Object.entries(patch) as Array<
    [string, Record<string, unknown> | undefined]
  >) {
    if (!familyPatch) continue;
    const familyCatalog = CATALOG_BY_FAMILY.get(family);
    if (!familyCatalog) {
      throw new DaemonConfigValidationError(family, `unknown daemon config family: ${family}`);
    }
    const target: Record<string, unknown> = { ...merged[family] };
    merged[family] = target;
    for (const [key, value] of Object.entries(familyPatch)) {
      if (value === undefined) continue;
      const entry = familyCatalog.get(key);
      if (!entry) {
        throw new DaemonConfigValidationError(key, `unknown daemon config key: ${family}.${key}`);
      }
      validatePatchValue(entry, value);
      target[key] = value;
    }
  }
  return merged as Partial<DaemonBehaviorConfig>;
}

function changedCatalogKeys(before: DaemonBehaviorConfig, after: DaemonBehaviorConfig): string[] {
  return DAEMON_CONFIG_KEY_CATALOG.filter(
    (entry) => catalogValue(before, entry) !== catalogValue(after, entry)
  ).map((entry) => entry.key);
}

function unchanged(changedKeys: string[] | undefined): boolean {
  return (changedKeys?.length ?? 0) === 0;
}

function completeDaemonConfigUpdate(
  config: DaemonBehaviorConfig,
  changedKeys: string[]
): DaemonConfigUpdateResult {
  return { config, changedKeys: changedKeys ?? [] };
}

const runUpdateDaemonConfig = (superpipe({ unchanged })('update-daemon-config') as PipelineAPI)
  .input(['patch', 'readStoredConfig', 'writeStoredConfig', 'publishConfigUpdated'])
  .pipe('readStoredConfig', [], 'stored')
  .pipe(resolveDaemonConfig, 'stored', 'before')
  .pipe(applyValidatedPatch, ['stored', 'patch'], 'merged')
  .pipe(resolveDaemonConfig, 'merged', 'after')
  .pipe(changedCatalogKeys, ['before', 'after'], 'changedKeys')
  .pipe(completeDaemonConfigUpdate, ['after', 'changedKeys'], 'result')
  .pipe('!unchanged', 'changedKeys')
  .pipe('writeStoredConfig', 'merged')
  .pipe('publishConfigUpdated', 'changedKeys')
  .end('result') as (
  patch: Partial<DaemonBehaviorConfig>,
  readStoredConfig: () => Partial<DaemonBehaviorConfig>,
  writeStoredConfig: (config: Partial<DaemonBehaviorConfig>) => void,
  publishConfigUpdated: (changedKeys: string[]) => void
) => DaemonConfigUpdateResult;

export class DaemonConfigService {
  private cachedConfig: DaemonBehaviorConfig | undefined;

  constructor(
    private readonly db: BunDatabase,
    private readonly internalEventBus?: InternalEventBus<DaemonInternalEventMap>
  ) {}

  getConfig(): DaemonBehaviorConfig {
    if (this.cachedConfig === undefined) {
      this.cachedConfig = resolveDaemonConfig(this.readStoredConfig());
    }
    return structuredClone(this.cachedConfig);
  }

  updateConfig(patch: Partial<DaemonBehaviorConfig>): DaemonConfigUpdateResult {
    const outcome = runUpdateDaemonConfig(
      patch,
      () => this.readStoredConfig(),
      (config) => this.writeStoredConfig(config),
      (changedKeys) => {
        this.internalEventBus?.publishAsync(DAEMON_CONFIG_UPDATED, { changedKeys });
      }
    );
    this.cachedConfig = outcome.config;
    return { config: structuredClone(outcome.config), changedKeys: outcome.changedKeys };
  }

  seedFromLegacyEnv(env: Record<string, string | undefined> = process.env): boolean {
    if (this.readConfigRow()) return false;

    const patch: Record<string, Record<string, number | boolean>> = {};
    let seededKeys = 0;
    for (const entry of DAEMON_CONFIG_KEY_CATALOG) {
      const raw = env[entry.legacyEnvName];
      if (raw === undefined || raw === '') continue;
      const resolved = resolveDaemonConfig({
        [entry.family]: { [entry.key]: raw },
      } as Partial<DaemonBehaviorConfig>);
      const value = catalogValue(resolved, entry);
      if (value === undefined) continue;
      const familyPatch = (patch[entry.family] ??= {});
      familyPatch[entry.key] = value;
      seededKeys++;
    }

    this.writeStoredConfig(patch as Partial<DaemonBehaviorConfig>);
    return seededKeys > 0;
  }

  private readConfigRow(): { config_json: string } | null | undefined {
    return this.db.prepare(`SELECT config_json FROM daemon_config WHERE id = 1`).get() as
      | { config_json: string }
      | null
      | undefined;
  }

  private readStoredConfig(): Partial<DaemonBehaviorConfig> {
    const row = this.readConfigRow();
    if (!row) return {};
    try {
      return JSON.parse(row.config_json) as Partial<DaemonBehaviorConfig>;
    } catch {
      return {};
    }
  }

  private writeStoredConfig(config: Partial<DaemonBehaviorConfig>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO daemon_config (id, config_json, updated_at) VALUES (1, ?, ?)`
      )
      .run(JSON.stringify(config), Date.now());
    this.cachedConfig = undefined;
  }
}
