import type { Database } from '../sqlite-compat.ts';

export function runMigration455(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_started_sessions (
    adapter TEXT NOT NULL,
    id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (adapter, id)
  )`);
}
