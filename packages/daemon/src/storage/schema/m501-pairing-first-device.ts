import type { Database } from '../sqlite-compat.ts';

export function runMigration501(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(pairing_requests)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'first_device'))
    db.exec('ALTER TABLE pairing_requests ADD COLUMN first_device INTEGER NOT NULL DEFAULT 0');
  const codeColumns = db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[];
  if (!codeColumns.some((column) => column.name === 'first_device'))
    db.exec('ALTER TABLE pairing_codes ADD COLUMN first_device INTEGER NOT NULL DEFAULT 0');
}
