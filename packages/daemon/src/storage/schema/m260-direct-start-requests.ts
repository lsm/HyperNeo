import type { Database } from '../sqlite-compat.ts';

export function runMigration260(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS direct_task_start_requests (
    attempt_id TEXT PRIMARY KEY REFERENCES direct_task_execution_attempts(id) ON DELETE CASCADE,
    request_json TEXT NOT NULL,
    lifecycle_generation INTEGER NOT NULL,
    job_id TEXT NOT NULL
  )`);
  const columns = db.prepare('PRAGMA table_info(direct_task_start_requests)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'lifecycle_generation'))
    db.exec(
      'ALTER TABLE direct_task_start_requests ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT -1'
    );
}
