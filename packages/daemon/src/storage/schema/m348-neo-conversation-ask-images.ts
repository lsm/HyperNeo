import type { Database } from '../sqlite-compat.ts';

export function createNeoConversationAskImageTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_conversation_ask_images (
    conversation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    block_index INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    thumbnail_media_type TEXT,
    thumbnail_data TEXT,
    PRIMARY KEY (conversation_id, request_id, block_index)
  )`);
}

export function runMigration348(db: Database): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name = 'neo_conversation_asks' AND type = 'table'"
      )
      .get()
  )
    return;
  createNeoConversationAskImageTable(db);
}
