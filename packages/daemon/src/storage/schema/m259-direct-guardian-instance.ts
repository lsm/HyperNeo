import type { Database } from '../sqlite-compat.ts';

export function runMigration259(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(direct_task_process_launches)').all() as Array<{
    name: string;
  }>;
  if (!columns.some(({ name }) => name === 'guardian_instance'))
    db.exec('ALTER TABLE direct_task_process_launches ADD COLUMN guardian_instance TEXT');
}
