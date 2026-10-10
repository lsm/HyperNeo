import type { Database } from '../sqlite-compat.ts';

export function runMigration325(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_asks' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_ask_checks (
    ask_id TEXT PRIMARY KEY REFERENCES neo_asks(id) ON DELETE CASCADE,
    signature TEXT NOT NULL,
    told_at INTEGER NOT NULL
  )`);
}
