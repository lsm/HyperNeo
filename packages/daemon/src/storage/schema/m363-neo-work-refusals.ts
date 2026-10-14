import type { Database } from '../sqlite-compat.ts';

export function runMigration363(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_refusals (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    what TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
}
