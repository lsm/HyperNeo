import type { Database } from '../sqlite-compat.ts';

export function runMigration260(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS direct_task_start_requests (
    attempt_id TEXT PRIMARY KEY REFERENCES direct_task_execution_attempts(id) ON DELETE CASCADE,
    request_json TEXT NOT NULL,
    job_id TEXT NOT NULL
  )`);
}
