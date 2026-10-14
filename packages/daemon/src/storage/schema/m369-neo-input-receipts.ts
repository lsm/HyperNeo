import type { Database } from '../sqlite-compat.ts';

export function runMigration369(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'sent_receipt'))
    db.exec('ALTER TABLE neo_work_driver_targets ADD COLUMN sent_receipt TEXT');
}
