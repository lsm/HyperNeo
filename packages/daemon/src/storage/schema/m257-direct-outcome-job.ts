import type { Database } from '../sqlite-compat.ts';

export function runMigration257(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(direct_task_stop_requests)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'finalization_job_id'))
    db.exec('ALTER TABLE direct_task_stop_requests ADD COLUMN finalization_job_id TEXT');
}
