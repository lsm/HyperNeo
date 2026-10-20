import type { Database } from '../sqlite-compat.ts';

export function runMigration411(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_session_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      from_session TEXT NOT NULL,
      from_name TEXT,
      to_session TEXT NOT NULL,
      to_name TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_session_messages_conversation
    ON neo_session_messages(conversation_id, created_at, sequence)`);
}
