import type { Database } from '../sqlite-compat.ts';

export function runMigration254(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(direct_task_stop_requests)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'verified_generation'))
    db.exec('ALTER TABLE direct_task_stop_requests ADD COLUMN verified_generation INTEGER');
  if (!columns.some((column) => column.name === 'verification_token'))
    db.exec('ALTER TABLE direct_task_stop_requests ADD COLUMN verification_token TEXT');
}
