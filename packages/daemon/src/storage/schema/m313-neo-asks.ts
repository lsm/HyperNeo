import type { Database } from '../sqlite-compat.ts';

export function runMigration313(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_asks (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    concern_id TEXT,
    origin_session_id TEXT NOT NULL,
    origin_message_id TEXT,
    title TEXT NOT NULL,
    ask TEXT NOT NULL,
    done_when TEXT NOT NULL,
    done_source TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('open', 'waiting', 'achieved', 'abandoned', 'blocked')),
    outcome TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settled_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_asks_concern ON neo_asks(concern_id, updated_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS neo_ask_work (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_ask_work_ask ON neo_ask_work(ask_id)`);
}
