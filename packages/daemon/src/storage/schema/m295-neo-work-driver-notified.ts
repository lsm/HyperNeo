import type { Database } from '../sqlite-compat.ts';

export function runMigration295(db: Database): void {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name = 'neo_work_driver_targets' AND type = 'table'"
    )
    .get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'needs_you_since')) {
    db.exec('ALTER TABLE neo_work_driver_targets ADD COLUMN needs_you_since INTEGER');
  }
}
