import type { Database } from '../sqlite-compat.ts';

export function runMigration464(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'depends_on'))
    db.exec(
      'ALTER TABLE neo_todos ADD COLUMN depends_on TEXT CHECK (depends_on IS NULL OR json_valid(depends_on))'
    );
}
