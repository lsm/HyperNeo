import type { Database } from '../sqlite-compat.ts';

export function runMigration369(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_project_merges (
    source_id TEXT PRIMARY KEY REFERENCES neo_concerns(id),
    target_id TEXT NOT NULL REFERENCES neo_concerns(id),
    source_session_id TEXT,
    merged_at INTEGER NOT NULL,
    CHECK (source_id <> target_id)
  )`);
}
