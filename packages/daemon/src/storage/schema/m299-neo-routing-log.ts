import type { Database } from '../sqlite-compat.ts';

export function createNeoRoutingLogTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_routing_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    ask TEXT NOT NULL,
    destination TEXT NOT NULL CHECK(destination IN ('main', 'holder', 'new')),
    target_session_id TEXT,
    concern_id TEXT,
    signal TEXT NOT NULL,
    confidence REAL,
    outcome TEXT,
    outcome_at INTEGER
  )`);
}

export function runMigration299(db: Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_session_bindings' AND type = 'table'")
      .get()
  )
    return;
  createNeoRoutingLogTable(db);
}
