import { parseJsonRecord } from './extension-config-json.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ExternalEventExtensionConfig } from '../../lib/external-events/types.ts';

interface GlobalConfigRow {
  source: string;
  globally_enabled: number;
  capabilities_json: string;
  secrets_ref: string | null;
  settings_json: string | null;
}

export function lookupGlobalExtensionConfig(
  db: Database,
  source: string
): ExternalEventExtensionConfig {
  const row = db
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
