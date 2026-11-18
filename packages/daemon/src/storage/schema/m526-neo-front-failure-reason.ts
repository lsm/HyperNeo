import type { Database } from '../sqlite-compat.ts';

export function runMigration526(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_front_inputs)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'failure_reason'))
    db.exec('ALTER TABLE neo_front_inputs ADD COLUMN failure_reason TEXT');
}
