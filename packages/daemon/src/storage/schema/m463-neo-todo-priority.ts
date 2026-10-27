import type { Database } from '../sqlite-compat.ts';

export function runMigration463(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'priority'))
    db.exec(
      "ALTER TABLE neo_todos ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent'))"
    );
}
