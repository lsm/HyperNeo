import type { Database } from '../sqlite-compat.ts';

export function runMigration285(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_consultation_waiters (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL,
    concern_id TEXT NOT NULL REFERENCES neo_concerns(id),
    origin_session_id TEXT NOT NULL,
    origin_message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'admitted', 'cancelled')),
    created_at INTEGER NOT NULL,
    UNIQUE(origin_session_id, request_key)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_consultation_waiters_queued
    ON neo_consultation_waiters(concern_id, created_at) WHERE status = 'queued'`);
}
