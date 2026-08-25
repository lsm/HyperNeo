import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

export function runMigration218(db: BunDatabase): void {
  if (!tableExists(db, 'space_goals')) return;
  if (tableHasColumn(db, 'space_goals', 'workspace_path')) return;
  db.exec(`ALTER TABLE space_goals ADD COLUMN workspace_path TEXT`);
}
