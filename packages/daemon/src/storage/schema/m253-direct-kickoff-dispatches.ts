import type { Database } from '../sqlite-compat.ts';

export function runMigration253(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS direct_task_kickoff_dispatches (
    attempt_id TEXT PRIMARY KEY REFERENCES direct_task_execution_attempts(id) ON DELETE CASCADE,
    job_id TEXT
  )`);
}
