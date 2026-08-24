import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type {
  ExternalEventExtensionConfig,
  ExternalEventExtensionConfigStore as ExternalEventExtensionConfigStoreContract,
  SpaceExternalEventSourceConfig,
} from './types.ts';

interface GlobalConfigRow {
  source: string;
  globally_enabled: number;
  capabilities_json: string;
  secrets_ref: string | null;
  settings_json: string | null;
}

interface SpaceConfigRow {
  space_id: string;
  source: string;
  enabled: number;
  settings_json: string;
}

export type { ExternalEventExtensionConfig, SpaceExternalEventSourceConfig } from './types.ts';

export class ExternalEventExtensionConfigStore
  implements ExternalEventExtensionConfigStoreContract
{
  constructor(private readonly db: BunDatabase) {
    ensureExternalEventExtensionConfigTables(this.db);
  }

  async getGlobalConfig(source: string): Promise<ExternalEventExtensionConfig> {
    validateSourceId(source);
    const row = this.db
      .prepare(`SELECT * FROM external_event_extension_configs WHERE source = ?`)
      .get(source) as GlobalConfigRow | undefined;

    if (!row) {
      return {
        source,
        globallyEnabled: false,
        capabilities: {},
      };
    }

    return globalRowToConfig(row);
  }

  async getSpaceConfig(
    spaceId: string,
    source: string
  ): Promise<SpaceExternalEventSourceConfig | null> {
    validateSpaceId(spaceId);
    validateSourceId(source);
    const row = this.db
      .prepare(
        `SELECT * FROM space_external_event_source_configs WHERE space_id = ? AND source = ?`
      )
      .get(spaceId, source) as SpaceConfigRow | undefined;
    return row ? spaceRowToConfig(row) : null;
  }

  async listEnabledSpaces(source: string): Promise<SpaceExternalEventSourceConfig[]> {
    validateSourceId(source);
    const rows = this.db
      .prepare(
        `SELECT * FROM space_external_event_source_configs
				 WHERE source = ? AND enabled = 1
				 ORDER BY space_id`
      )
      .all(source) as SpaceConfigRow[];
    return rows.map(spaceRowToConfig);
  }

  async setGlobalConfig(source: string, config: ExternalEventExtensionConfig): Promise<void> {
    validateSourceId(source);
    validateGlobalConfig(source, config);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO external_event_extension_configs (
					source, globally_enabled, capabilities_json, secrets_ref,
					settings_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(source) DO UPDATE SET
					globally_enabled = excluded.globally_enabled,
					capabilities_json = excluded.capabilities_json,
					secrets_ref = excluded.secrets_ref,
					settings_json = excluded.settings_json,
					updated_at = excluded.updated_at`
      )
      .run(
        source,
        config.globallyEnabled ? 1 : 0,
        JSON.stringify(config.capabilities),
        config.secretsRef ?? null,
        JSON.stringify(config.settings ?? {}),
        now,
        now
      );
  }

  async setSpaceConfig(
    spaceId: string,
    source: string,
    config: SpaceExternalEventSourceConfig
  ): Promise<void> {
    validateSpaceId(spaceId);
    validateSourceId(source);
    validateSpaceConfig(spaceId, source, config);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_external_event_source_configs (
					space_id, source, enabled, settings_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(space_id, source) DO UPDATE SET
					enabled = excluded.enabled,
					settings_json = excluded.settings_json,
					updated_at = excluded.updated_at`
      )
      .run(spaceId, source, config.enabled ? 1 : 0, JSON.stringify(config.settings), now, now);
  }
}

export function ensureExternalEventExtensionConfigTables(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS external_event_extension_configs (
			source TEXT PRIMARY KEY,
			globally_enabled INTEGER NOT NULL DEFAULT 0,
			capabilities_json TEXT NOT NULL,
			secrets_ref TEXT,
			settings_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_external_event_source_configs (
			space_id TEXT NOT NULL,
			source TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			settings_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(space_id, source),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
}

function globalRowToConfig(row: GlobalConfigRow): ExternalEventExtensionConfig {
  const config: ExternalEventExtensionConfig = {
    source: row.source,
    globallyEnabled: row.globally_enabled === 1,
    capabilities: parseJsonRecord(row.capabilities_json),
  };
  if (row.secrets_ref !== null) config.secretsRef = row.secrets_ref;
  if (row.settings_json !== null) config.settings = parseJsonRecord(row.settings_json);
  return config;
}

function spaceRowToConfig(row: SpaceConfigRow): SpaceExternalEventSourceConfig {
  return {
    spaceId: row.space_id,
    source: row.source,
    enabled: row.enabled === 1,
    settings: parseJsonRecord(row.settings_json),
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}

function validateGlobalConfig(source: string, config: ExternalEventExtensionConfig): void {
  if (config.source !== source) {
    throw new Error(
      `Global external-event config source "${config.source}" must match "${source}"`
    );
  }
  if (!isRecord(config.capabilities)) {
    throw new Error('Global external-event config capabilities must be an object');
  }
  if (config.settings !== undefined && !isRecord(config.settings)) {
    throw new Error('Global external-event config settings must be an object when present');
  }
}

function validateSpaceConfig(
  spaceId: string,
  source: string,
  config: SpaceExternalEventSourceConfig
): void {
  if (config.spaceId !== spaceId) {
    throw new Error(
      `Space external-event config spaceId "${config.spaceId}" must match "${spaceId}"`
    );
  }
  if (config.source !== source) {
    throw new Error(`Space external-event config source "${config.source}" must match "${source}"`);
  }
  if (!isRecord(config.settings)) {
    throw new Error('Space external-event config settings must be an object');
  }
}

function validateSourceId(source: string): void {
  if (!source || source.trim().length === 0 || source !== source.trim()) {
    throw new Error('External event source must be non-empty and must not include edge whitespace');
  }
}

function validateSpaceId(spaceId: string): void {
  if (!spaceId || spaceId.trim().length === 0 || spaceId !== spaceId.trim()) {
    throw new Error('Space id must be non-empty and must not include edge whitespace');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
