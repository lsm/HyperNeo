import type { Database } from '../sqlite-compat.ts';

export function runMigration334(db: Database): void {
  const table = 'neo_work_driver_targets';
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(table))
    return;
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (columns.has('start_interrupted')) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN start_interrupted INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE ${table} SET start_interrupted = 1
    WHERE work_id IN (SELECT id FROM neo_work WHERE report LIKE 'Starting was interrupted before%')`);
}
