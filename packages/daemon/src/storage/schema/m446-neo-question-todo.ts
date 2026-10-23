import type { Database } from '../sqlite-compat.ts';

export function runMigration446(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'todo_id'))
    db.exec('ALTER TABLE neo_questions ADD COLUMN todo_id TEXT');
}
