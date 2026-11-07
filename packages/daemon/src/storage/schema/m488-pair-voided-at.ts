import type { Database } from '../sqlite-compat.ts';

export function runMigration488(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'voided_at'))
    db.exec('ALTER TABLE pairing_codes ADD COLUMN voided_at INTEGER');
}
