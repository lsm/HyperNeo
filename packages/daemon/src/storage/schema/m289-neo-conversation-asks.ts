import type { Database } from '../sqlite-compat.ts';

export function createNeoConversationAskTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_conversation_asks (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(conversation_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_neo_conversation_asks_cursor
    ON neo_conversation_asks(conversation_id, sequence)`);
}

export function runMigration289(db: Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_session_bindings' AND type = 'table'")
      .get()
  )
    return;
  createNeoConversationAskTable(db);
}
