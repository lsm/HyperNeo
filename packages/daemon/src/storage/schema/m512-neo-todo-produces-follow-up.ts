import type { Database } from '../sqlite-compat.ts';

export function runMigration512(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[];
  if (!columns.length) return;
  if (columns.some((column) => column.name === 'produces_follow_up')) return;
  db.exec('ALTER TABLE neo_todos ADD COLUMN produces_follow_up INTEGER NOT NULL DEFAULT 0');
}
