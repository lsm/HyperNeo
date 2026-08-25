import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration215(db: BunDatabase): void {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_agents'`)
    .get();
  if (!tableExists) return;
  const hasColumn = db
    .prepare(`SELECT 1 FROM pragma_table_info('space_agents') WHERE name = 'model_pool'`)
    .get();
  if (hasColumn) return;
  db.exec(`ALTER TABLE space_agents ADD COLUMN model_pool TEXT`);
}
