import type { Database } from '../sqlite-compat.ts';

export function runMigration518(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_cleanup_gone (
    key TEXT PRIMARY KEY,
    gone_at INTEGER NOT NULL
  )`);
}
