import type { Database } from '../sqlite-compat.ts';

export function runMigration310(db: Database): void {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name = 'neo_work_driver_targets' AND type = 'table'"
    )
    .get();
  if (!table) return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('input_before'))
    db.exec('ALTER TABLE neo_work_driver_targets ADD COLUMN input_before INTEGER');
}
