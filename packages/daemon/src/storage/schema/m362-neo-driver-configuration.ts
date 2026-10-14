import type { Database } from '../sqlite-compat.ts';

export function runMigration362(db: Database): void {
  const table = 'neo_work_driver_targets';
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(table))
    return;
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('actual_model')) db.exec(`ALTER TABLE ${table} ADD COLUMN actual_model TEXT`);
  if (!columns.has('actual_effort')) db.exec(`ALTER TABLE ${table} ADD COLUMN actual_effort TEXT`);
}
