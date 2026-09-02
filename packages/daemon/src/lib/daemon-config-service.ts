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

export type DaemonConfigUpdateStatus = 'applied' | 'superseded';

export interface DaemonConfigUpdateResult {
  status: DaemonConfigUpdateStatus;
  config: DaemonBehaviorConfig;
  changedKeys: string[];
}

interface DaemonConfigRow {
  config_json: string;
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
    if (familyPatch === undefined) continue;
    if (typeof familyPatch !== 'object' || familyPatch === null || Array.isArray(familyPatch)) {
      throw new DaemonConfigValidationError(
        family,
        `daemon config family ${family} must be an object`
      );
    }
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

function superseded(applied: boolean | undefined): boolean {
  return applied === false;
}

function adopted(existingRow: DaemonConfigRow | null | undefined): boolean {
  return existingRow != null;
}

function loadConfigRow(
  readConfigRow: () => DaemonConfigRow | null | undefined
): DaemonConfigRow | null | undefined {
  return readConfigRow();
}

function storedConfigFromRow(
  row: DaemonConfigRow | null | undefined
): Partial<DaemonBehaviorConfig> {
  if (!row) return {};
  try {
    return JSON.parse(row.config_json) as Partial<DaemonBehaviorConfig>;
  } catch {
    return {};
  }
}

function completeDaemonConfigUpdate(
  config: DaemonBehaviorConfig,
  changedKeys: string[]
): DaemonConfigUpdateResult {
  return { status: 'applied', config, changedKeys: changedKeys ?? [] };
}

function finalizeDaemonConfigUpdate(
  result: DaemonConfigUpdateResult,
  applied: boolean
): DaemonConfigUpdateResult {
  return applied ? result : { ...result, status: 'superseded' };
}

function persistDaemonConfigUpdate(
  casStoredConfig: (
    expectedConfigJson: string | null,
    config: Partial<DaemonBehaviorConfig>
  ) => boolean,
  existingRow: DaemonConfigRow | null | undefined,
  merged: Partial<DaemonBehaviorConfig>
): boolean {
  return casStoredConfig(existingRow ? existingRow.config_json : null, merged);
}

export function casDaemonConfigRow(
  db: BunDatabase,
  expectedConfigJson: string | null,
  config: Partial<DaemonBehaviorConfig>
): boolean {
  const configJson = JSON.stringify(config);
  if (expectedConfigJson === null) {
    const result = db
      .prepare(`INSERT OR IGNORE INTO daemon_config (id, config_json, updated_at) VALUES (1, ?, ?)`)
      .run(configJson, Date.now());
    return result.changes > 0;
  }
  const result = db
    .prepare(
      `UPDATE daemon_config SET config_json = ?, updated_at = ? WHERE id = 1 AND config_json = ?`
    )
    .run(configJson, Date.now(), expectedConfigJson);
  return result.changes > 0;
}

const runUpdateDaemonConfig = (
  superpipe({ unchanged, superseded })('update-daemon-config') as PipelineAPI
)
  .input(['patch', 'readConfigRow', 'casStoredConfig', 'publishConfigUpdated'])
  .pipe(loadConfigRow, 'readConfigRow', 'existingRow')
  .pipe(storedConfigFromRow, 'existingRow', 'stored')
  .pipe(resolveDaemonConfig, 'stored', 'before')
  .pipe(applyValidatedPatch, ['stored', 'patch'], 'merged')
  .pipe(resolveDaemonConfig, 'merged', 'after')
  .pipe(changedCatalogKeys, ['before', 'after'], 'changedKeys')
  .pipe(completeDaemonConfigUpdate, ['after', 'changedKeys'], 'result')
  .pipe('!unchanged', 'changedKeys')
  .pipe(persistDaemonConfigUpdate, ['casStoredConfig', 'existingRow', 'merged'], 'applied')
  .pipe(finalizeDaemonConfigUpdate, ['result', 'applied'], 'result')
  .pipe('!superseded', 'applied')
  .pipe('publishConfigUpdated', 'changedKeys')
  .end('result') as (
  patch: Partial<DaemonBehaviorConfig>,
  readConfigRow: () => DaemonConfigRow | null | undefined,
  casStoredConfig: (
    expectedConfigJson: string | null,
    config: Partial<DaemonBehaviorConfig>
  ) => boolean,
  publishConfigUpdated: (changedKeys: string[]) => void
) => DaemonConfigUpdateResult;

interface DaemonConfigSeedPlan {
  patch: Record<string, Record<string, number | boolean>>;
  seededKeys: number;
}

function planLegacySeed(env: Record<string, string | undefined>): DaemonConfigSeedPlan {
  const patch: Record<string, Record<string, number | boolean>> = {};
  let seededKeys = 0;
  for (const entry of DAEMON_CONFIG_KEY_CATALOG) {
    const raw = env[entry.legacyEnvName];
    if (raw === undefined) continue;
    const resolved = resolveDaemonConfig({
      [entry.family]: { [entry.key]: raw },
    } as Partial<DaemonBehaviorConfig>);
    const value = catalogValue(resolved, entry);
    if (value === undefined) continue;
    const familyPatch = (patch[entry.family] ??= {});
    familyPatch[entry.key] = value;
    seededKeys++;
  }
  return { patch, seededKeys };
}

function completeLegacySeed(claimed: boolean, seedPlan: DaemonConfigSeedPlan): { seeded: boolean } {
  return { seeded: claimed && seedPlan.seededKeys > 0 };
}

function persistLegacySeed(
  claimStoredConfig: (config: Partial<DaemonBehaviorConfig>) => boolean,
  seedPlan: DaemonConfigSeedPlan
): boolean {
  return claimStoredConfig(seedPlan.patch as Partial<DaemonBehaviorConfig>);
}

const runSeedDaemonConfigFromLegacyEnv = (
  superpipe({ adopted })('seed-daemon-config-from-legacy-env') as PipelineAPI
)
  .input(['env', 'readConfigRow', 'claimStoredConfig'])
  .pipe(loadConfigRow, 'readConfigRow', 'existingRow')
  .pipe(planLegacySeed, 'env', 'seedPlan')
  .pipe('!adopted', 'existingRow')
  .pipe(persistLegacySeed, ['claimStoredConfig', 'seedPlan'], 'claimed')
  .pipe(completeLegacySeed, ['claimed', 'seedPlan'], 'result')
  .end('result') as (
  env: Record<string, string | undefined>,
  readConfigRow: () => DaemonConfigRow | null | undefined,
  claimStoredConfig: (config: Partial<DaemonBehaviorConfig>) => boolean
) => { seeded: boolean } | undefined;

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
      () => this.readConfigRow(),
      (expectedConfigJson, config) => this.casStoredConfig(expectedConfigJson, config),
      (changedKeys) => {
        this.internalEventBus?.publishAsync(DAEMON_CONFIG_UPDATED, { changedKeys });
      }
    );
    if (outcome.status === 'applied') {
      this.cachedConfig = outcome.config;
    }
    return {
      status: outcome.status,
      config: structuredClone(outcome.config),
      changedKeys: [...outcome.changedKeys],
    };
  }

  seedFromLegacyEnv(env: Record<string, string | undefined> = process.env): boolean {
    const outcome = runSeedDaemonConfigFromLegacyEnv(
      env,
      () => this.readConfigRow(),
      (config) => this.claimStoredConfig(config)
    );
    return outcome?.seeded ?? false;
  }

  private readConfigRow(): DaemonConfigRow | null | undefined {
    return this.db.prepare(`SELECT config_json FROM daemon_config WHERE id = 1`).get() as
      | DaemonConfigRow
      | null
      | undefined;
  }

  private readStoredConfig(): Partial<DaemonBehaviorConfig> {
    return storedConfigFromRow(this.readConfigRow());
  }

  private casStoredConfig(
    expectedConfigJson: string | null,
    config: Partial<DaemonBehaviorConfig>
  ): boolean {
    const applied = casDaemonConfigRow(this.db, expectedConfigJson, config);
    if (applied) this.cachedConfig = undefined;
    return applied;
  }

  private claimStoredConfig(config: Partial<DaemonBehaviorConfig>): boolean {
    const applied = casDaemonConfigRow(this.db, null, config);
    if (applied) this.cachedConfig = undefined;
    return applied;
  }
}
