import type { Database } from '../sqlite-compat.ts';

export function runMigration516(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'stalled_wake_at')) return;
  db.exec('ALTER TABLE neo_asks DROP COLUMN stalled_wake_at');
}
