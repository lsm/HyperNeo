import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SpaceExternalEventSourceConfig } from '../../lib/external-events/types.ts';
import { schemaTableExists } from '../schema/extensions.ts';
import { parseJsonRecord } from './extension-config-json.ts';

const SPACE_CONFIG_TABLE = 'space_external_event_source_configs';

interface SpaceConfigRow {
  space_id: string;
  source: string;
  enabled: number;
  settings_json: string;
}

export function lookupSpaceExtensionConfig(
  db: BunDatabase,
  spaceId: string,
  source: string
): SpaceExternalEventSourceConfig | null {
  if (!schemaTableExists(db, SPACE_CONFIG_TABLE)) return null;
  const row = db
    .prepare(`SELECT * FROM space_external_event_source_configs WHERE space_id = ? AND source = ?`)
    .get(spaceId, source) as SpaceConfigRow | undefined;
  return row ? spaceRowToConfig(row) : null;
}

export function listEnabledSpaceExtensionConfigs(
  db: BunDatabase,
  source: string
): SpaceExternalEventSourceConfig[] {
  if (!schemaTableExists(db, SPACE_CONFIG_TABLE)) return [];
  const rows = db
    .prepare(
      `SELECT * FROM space_external_event_source_configs
				 WHERE source = ? AND enabled = 1
				 ORDER BY space_id`
    )
    .all(source) as SpaceConfigRow[];
  return rows.map(spaceRowToConfig);
}

function spaceRowToConfig(row: SpaceConfigRow): SpaceExternalEventSourceConfig {
  return {
    spaceId: row.space_id,
    source: row.source,
    enabled: row.enabled === 1,
    settings: parseJsonRecord(row.settings_json),
  };
}
