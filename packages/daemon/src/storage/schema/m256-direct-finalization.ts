import type { Database } from '../sqlite-compat.ts';

export function runMigration256(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(direct_task_stop_requests)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'finalization_json'))
    db.exec('ALTER TABLE direct_task_stop_requests ADD COLUMN finalization_json TEXT');
}
