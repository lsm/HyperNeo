import type { Database } from '../sqlite-compat.ts';

export function createNeoPackPreferencesTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_pack_preferences (
    pack TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'repo', 'project')),
    scope_key TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (pack, scope_kind, scope_key, key),
    CHECK (scope_kind <> 'global' OR scope_key = '')
  )`);
}

export function runMigration426(db: Database): void {
  createNeoPackPreferencesTable(db);
}
