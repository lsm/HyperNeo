import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration219(db: BunDatabase): void {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_tasks'`)
    .get();
  if (!tableExists) return;
  const hasColumn = db
    .prepare(`SELECT 1 FROM pragma_table_info('space_tasks') WHERE name = 'workspace_path'`)
    .get();
  if (hasColumn) return;
  db.exec(`ALTER TABLE space_tasks ADD COLUMN workspace_path TEXT`);
}
