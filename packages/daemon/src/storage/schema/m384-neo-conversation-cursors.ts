import type { Database } from '../sqlite-compat.ts';

export function runMigration384(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_publication_anchors)').all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === 'cursor_json'))
    db.exec('ALTER TABLE neo_publication_anchors ADD COLUMN cursor_json TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_conversation_asks_chronology
    ON neo_conversation_asks(conversation_id, created_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_neo_publications_chronology
    ON neo_publications(conversation_id, created_at, sequence)`);
}
