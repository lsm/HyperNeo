import type { Database } from '../sqlite-compat.ts';

export function runMigration308(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_continues (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
    count INTEGER NOT NULL,
    continued_at INTEGER NOT NULL,
    last_message TEXT NOT NULL
  )`);
}
