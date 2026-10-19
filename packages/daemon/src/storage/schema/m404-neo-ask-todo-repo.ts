import type { Database } from '../sqlite-compat.ts';

export function runMigration404(db: Database): void {
  for (const table of ['neo_asks', 'neo_todos']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length && !columns.some((column) => column.name === 'repo'))
      db.exec(`ALTER TABLE ${table} ADD COLUMN repo TEXT`);
  }
}
