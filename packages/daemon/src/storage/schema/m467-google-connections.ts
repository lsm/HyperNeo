import type { Database } from '../sqlite-compat.ts';

export function runMigration467(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS google_connections (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    status_json TEXT NOT NULL CHECK (json_valid(status_json))
  )`);
}
