import type { Database } from '../sqlite-compat.ts';

export function runMigration412(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_schedules (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    note TEXT,
    cadence_kind TEXT NOT NULL CHECK (cadence_kind IN ('every', 'cron')),
    every_ms INTEGER,
    cron TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    nudge_every INTEGER NOT NULL DEFAULT 4,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
    next_run_at INTEGER,
    pending_job_id TEXT,
    due_count INTEGER NOT NULL DEFAULT 0,
    facts_digest TEXT,
    last_run_at INTEGER,
    last_outcome TEXT,
    last_skip_reason TEXT,
    last_message_id TEXT,
    created_by_session TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_kind, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_schedules_status ON session_schedules(status)`);
}
