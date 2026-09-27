import type { Database } from '../sqlite-compat.ts';

export function createNeoTables(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_concerns (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    context TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS neo_session_bindings (
    session_id TEXT PRIMARY KEY,
    concern_id TEXT REFERENCES neo_concerns(id),
    kind TEXT NOT NULL CHECK (kind IN ('neo', 'concern', 'worker')),
    CHECK (kind = 'worker' OR (kind = 'neo' AND concern_id IS NULL)
      OR (kind = 'concern' AND concern_id IS NOT NULL))
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_neo_session_bindings_coordinator
    ON neo_session_bindings(COALESCE(concern_id, '')) WHERE kind IN ('neo', 'concern')`);
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    concern_id TEXT REFERENCES neo_concerns(id),
    origin_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'queued', 'reported', 'failed', 'cancelled')),
    report TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_work_concern ON neo_work(concern_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_work_session
    ON neo_work(session_id, created_at) WHERE session_id IS NOT NULL`);
}
