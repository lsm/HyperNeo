import type { Database } from '../sqlite-compat.ts';

export function runMigration477(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_held_sends (
    key TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL,
    ref TEXT NOT NULL CHECK (json_valid(ref)),
    message TEXT NOT NULL,
    held_at INTEGER NOT NULL,
    sending_at INTEGER
  )`);
}
