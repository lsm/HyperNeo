import type { Database } from '../sqlite-compat.ts';

export function runMigration451(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'stalled_wake_at'))
    db.exec('ALTER TABLE neo_asks ADD COLUMN stalled_wake_at INTEGER');
}
