import type { Database } from '../sqlite-compat.ts';

export function runMigration530(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'desktop_app'))
    db.exec('ALTER TABLE neo_questions ADD COLUMN desktop_app TEXT');
}
