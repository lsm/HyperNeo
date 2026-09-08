import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

export function runMigration237(db: BunDatabase): void {
  if (!tableHasColumn(db, 'space_tasks', 'id')) return;
  if (tableHasColumn(db, 'space_tasks', 'reconcile_checked_at')) return;
  db.exec(`ALTER TABLE space_tasks ADD COLUMN reconcile_checked_at INTEGER`);
}
