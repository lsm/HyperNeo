import type { Database } from '../sqlite-compat.ts';

export function runMigration375(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'start_intent_at'))
    db.exec('ALTER TABLE neo_work_driver_targets ADD COLUMN start_intent_at INTEGER');
}
