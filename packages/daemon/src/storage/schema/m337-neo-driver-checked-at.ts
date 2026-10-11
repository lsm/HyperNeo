import type { Database } from '../sqlite-compat.ts';

export function runMigration337(db: Database): void {
  const table = 'neo_work_driver_targets';
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(table))
    return;
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('checked_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN checked_at INTEGER`);
  if (!columns.has('unchecked'))
    db.exec(`ALTER TABLE ${table} ADD COLUMN unchecked INTEGER NOT NULL DEFAULT 0`);
}
