import type { Database } from '../sqlite-compat.ts';

export function runMigration383(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS operation_refusals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    reason TEXT NOT NULL,
    session_id TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_operation_refusals_at ON operation_refusals(at)`);
}
