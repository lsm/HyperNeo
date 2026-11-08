import type { Database } from '../sqlite-compat.ts';

export function runMigration491(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'denied_at'))
    db.exec('ALTER TABLE pairing_codes ADD COLUMN denied_at INTEGER');
}
