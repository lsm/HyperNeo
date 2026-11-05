import { ExternalEventExtensionConfigStore } from '../../../src/lib/external-events/extension-config-store.ts';
import type { Database as BunDatabase } from '../../../src/storage/sqlite-compat.ts';

export function createExternalEventConfigStore(db: BunDatabase): ExternalEventExtensionConfigStore {
  db.exec(`
		CREATE TABLE IF NOT EXISTS external_event_extension_configs (
			source TEXT PRIMARY KEY,
			globally_enabled INTEGER NOT NULL DEFAULT 0,
			capabilities_json TEXT NOT NULL,
			secrets_ref TEXT,
			settings_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
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
  return new ExternalEventExtensionConfigStore(db);
}
