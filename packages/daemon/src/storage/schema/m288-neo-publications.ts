import type { Database } from '../sqlite-compat.ts';

export function createNeoPublicationTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_publications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(conversation_id, publication_id)
  );
  CREATE INDEX IF NOT EXISTS idx_neo_publications_conversation_sequence
    ON neo_publications(conversation_id, sequence)`);
}

export function runMigration288(db: Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_session_bindings' AND type = 'table'")
      .get()
  )
    return;
  createNeoPublicationTable(db);
}
