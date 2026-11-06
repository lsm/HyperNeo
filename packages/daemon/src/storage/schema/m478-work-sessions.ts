import type { Database } from '../sqlite-compat.ts';

export function runMigration478(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_sessions (
    adapter TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (adapter, id)
  )`);
}
