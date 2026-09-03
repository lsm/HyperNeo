import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration225(db: BunDatabase): void {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_schedules'`)
    .get();
  if (!tableExists) return;
  const hasColumn = db
    .prepare(`SELECT 1 FROM pragma_table_info('task_schedules') WHERE name = 'workspace_path'`)
    .get();
  if (hasColumn) return;
  db.exec(`ALTER TABLE task_schedules ADD COLUMN workspace_path TEXT`);
}
