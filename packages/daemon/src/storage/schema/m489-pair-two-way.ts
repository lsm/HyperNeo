import type { Database } from '../sqlite-compat.ts';

export function runMigration489(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'two_way'))
    db.exec('ALTER TABLE pairing_codes ADD COLUMN two_way INTEGER NOT NULL DEFAULT 0');
}
