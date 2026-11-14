import type { Database } from '../sqlite-compat.ts';

export function runMigration511(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(providers)').all() as { name: string }[];
  if (!columns.length) return;
  if (columns.some((column) => column.name === 'needs_login_at')) return;
  db.exec('ALTER TABLE providers ADD COLUMN needs_login_at INTEGER DEFAULT NULL');
}
