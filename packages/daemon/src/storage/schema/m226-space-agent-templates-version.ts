import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration226(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_templates')) return;
  if (tableHasColumn(db, 'space_agent_templates', 'version')) return;

  db.exec(`ALTER TABLE space_agent_templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}
