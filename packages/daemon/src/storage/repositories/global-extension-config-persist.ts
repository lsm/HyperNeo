import type { Database } from '../sqlite-compat.ts';
import type { ExternalEventExtensionConfig } from '../../lib/external-events/types.ts';

export function persistGlobalExtensionConfig(
  db: Database,
  source: string,
  config: ExternalEventExtensionConfig,
  now: number
): void {
  db.prepare(
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
  ).run(
    source,
    config.globallyEnabled ? 1 : 0,
    JSON.stringify(config.capabilities),
    config.secretsRef ?? null,
    JSON.stringify(config.settings ?? {}),
    now,
    now
  );
}
