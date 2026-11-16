import type { Database } from '../sqlite-compat.ts';

export function runMigration522(db: Database): void {
  db.exec(`ALTER TABLE neo_goals ADD COLUMN daily_run_limit INTEGER NOT NULL DEFAULT 24;
  ALTER TABLE session_schedule_runs ADD COLUMN source_kind TEXT;
  ALTER TABLE session_schedule_runs ADD COLUMN source_id TEXT;
  UPDATE session_schedule_runs SET
    source_kind = (SELECT source_kind FROM session_schedules s WHERE s.id = schedule_id),
    source_id = (SELECT source_id FROM session_schedules s WHERE s.id = schedule_id);
  CREATE INDEX IF NOT EXISTS idx_session_schedule_runs_source
    ON session_schedule_runs(source_kind, source_id, fired_at)`);
}
