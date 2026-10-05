import type { Database } from '../sqlite-compat.ts';

export function runMigration297(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_search_vectors (
      content_id INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      embedded_at INTEGER NOT NULL
    )
  `);
  const content = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_search_content' AND type = 'table'")
    .get();
  if (!content) return;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS message_search_content_vectors_ad
    AFTER DELETE ON message_search_content BEGIN
      DELETE FROM message_search_vectors WHERE content_id = old.id;
    END
  `);
}
