import type { Database } from '../sqlite-compat.ts';

export function runMigration408(db: Database): void {
  const vectors = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_search_vectors' AND type = 'table'")
    .get();
  if (!vectors) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_search_vectors_model
    ON message_search_vectors(model, dimensions, content_id)`);
}
