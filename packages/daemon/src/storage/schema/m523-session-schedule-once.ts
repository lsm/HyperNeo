import type { Database } from '../sqlite-compat.ts';

export function runMigration523(db: Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE session_schedules_next (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      note TEXT,
      cadence_kind TEXT NOT NULL CHECK (cadence_kind IN ('every', 'cron', 'once')),
      every_ms INTEGER,
      cron TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      once_at INTEGER,
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
      delivery_receipt TEXT,
      created_by_session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_kind, source_id)
    );
    INSERT INTO session_schedules_next (id, target, source_kind, source_id, note, cadence_kind,
      every_ms, cron, timezone, nudge_every, status, next_run_at, pending_job_id, due_count,
      facts_digest, last_run_at, last_outcome, last_skip_reason, last_message_id,
      created_by_session, created_at, updated_at)
    SELECT id, target, source_kind, source_id, note, cadence_kind, every_ms, cron, timezone,
      nudge_every, status, next_run_at, pending_job_id, due_count, facts_digest, last_run_at,
      last_outcome, last_skip_reason, last_message_id, created_by_session, created_at, updated_at
    FROM session_schedules;
    DROP TABLE session_schedules;
    ALTER TABLE session_schedules_next RENAME TO session_schedules;
    CREATE INDEX idx_session_schedules_due ON session_schedules(status, next_run_at);
    CREATE INDEX idx_session_schedules_target
      ON session_schedules(json_extract(target, '$.adapter'), json_extract(target, '$.id'));`);
  })();
}
