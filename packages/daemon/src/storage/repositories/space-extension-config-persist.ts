import type { Database } from '../sqlite-compat.ts';
import type { SpaceExternalEventSourceConfig } from '../../lib/external-events/types.ts';

export function persistSpaceExtensionConfig(
  db: Database,
  spaceId: string,
  source: string,
  config: SpaceExternalEventSourceConfig,
  now: number
): void {
  db.prepare(
    `INSERT INTO space_external_event_source_configs (
					space_id, source, enabled, settings_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(space_id, source) DO UPDATE SET
					enabled = excluded.enabled,
					settings_json = excluded.settings_json,
					updated_at = excluded.updated_at`
  ).run(spaceId, source, config.enabled ? 1 : 0, JSON.stringify(config.settings), now, now);
}
