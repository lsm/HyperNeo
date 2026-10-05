import type { Database } from '../sqlite-compat.ts';

export function runMigration298(db: Database): void {
  const content = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_search_content' AND type = 'table'")
    .get();
  if (!content) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_search_content_session_turns
    ON message_search_content(session_id, timestamp, id) WHERE kind = 'message'
  `);
}
