import type { Database } from '../sqlite-compat.ts';

export function runMigration513(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'start_todos')) return;
  db.exec('ALTER TABLE neo_questions DROP COLUMN start_todos');
}
