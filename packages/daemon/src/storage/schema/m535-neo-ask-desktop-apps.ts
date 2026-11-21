import type { Database } from '../sqlite-compat.ts';

export function runMigration535(db: Database): void {
  for (const table of ['neo_asks', 'neo_todos']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length && !columns.some((column) => column.name === 'desktop_apps'))
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN desktop_apps TEXT CHECK (desktop_apps IS NULL OR json_valid(desktop_apps))`
      );
  }
}
