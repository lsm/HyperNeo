import type { Database } from '../sqlite-compat.ts';

export function runMigration375(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'neo_work'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_start_intents (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id),
    intent_at INTEGER NOT NULL
  )`);
}
