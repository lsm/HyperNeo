import type { Database } from '../sqlite-compat.ts';

export function runMigration314(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_prs (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
    prs_json TEXT NOT NULL,
    open INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    delivered TEXT,
    read_at INTEGER NOT NULL,
    read_ok_at INTEGER NOT NULL
  )`);
}
