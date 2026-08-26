import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration220(db: BunDatabase): void {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_external_events'`)
    .get();
  if (!tableExists) return;
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('space_external_events')`)
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('urgency')) {
    db.exec(`ALTER TABLE space_external_events ADD COLUMN urgency TEXT`);
  }
  if (!names.has('render')) {
    db.exec(`ALTER TABLE space_external_events ADD COLUMN render TEXT`);
  }
}
