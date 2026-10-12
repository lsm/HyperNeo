import type { Database } from '../sqlite-compat.ts';

export function runMigration353(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_wakes (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
    wakes INTEGER NOT NULL,
    note TEXT,
    progress TEXT,
    stalled INTEGER NOT NULL,
    woke_at INTEGER,
    continued_wake INTEGER
  )`);
}
