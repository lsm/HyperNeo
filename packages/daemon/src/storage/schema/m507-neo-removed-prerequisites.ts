import type { Database } from '../sqlite-compat.ts';

export function runMigration507(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'cause')) return;
  db.exec('ALTER TABLE neo_questions ADD COLUMN cause TEXT');
}
