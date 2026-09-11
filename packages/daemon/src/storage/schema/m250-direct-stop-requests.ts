import type { Database } from '../sqlite-compat.ts';

export function runMigration250(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS direct_task_stop_requests (
    attempt_id TEXT PRIMARY KEY REFERENCES direct_task_execution_attempts(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    requested_at INTEGER NOT NULL
  )`);
}
