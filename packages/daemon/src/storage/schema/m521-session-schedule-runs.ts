import type { Database } from '../sqlite-compat.ts';

export function runMigration521(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_schedule_runs (
    id INTEGER PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    due_at INTEGER,
    fired_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    message_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_session_schedule_runs_occurrence
    ON session_schedule_runs(schedule_id, due_at)`);
}
