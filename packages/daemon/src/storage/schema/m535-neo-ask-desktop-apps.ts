import type { Database } from '../sqlite-compat.ts';

export function runMigration535(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'desktop_apps'))
    db.exec(
      'ALTER TABLE neo_asks ADD COLUMN desktop_apps TEXT CHECK (desktop_apps IS NULL OR json_valid(desktop_apps))'
    );
}
