import type { Database } from '../sqlite-compat.ts';

export function runMigration279(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_consultations (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL,
    concern_id TEXT NOT NULL REFERENCES neo_concerns(id),
    origin_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'reported', 'failed')),
    answer TEXT,
    returned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(origin_session_id, request_key)
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_neo_consultations_pending
    ON neo_consultations(concern_id) WHERE status = 'pending'`);
}
