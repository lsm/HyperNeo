import type { Database } from '../sqlite-compat.ts';

export function runMigration382(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_publication_anchors (
    session_id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    compaction INTEGER NOT NULL
  )`);
}
