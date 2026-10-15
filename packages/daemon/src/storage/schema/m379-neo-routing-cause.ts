import type { Database } from '../sqlite-compat.ts';

export function runMigration379(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_routing_log' AND type = 'table'")
    .get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(neo_routing_log)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'cause'))
    db.exec('ALTER TABLE neo_routing_log ADD COLUMN cause TEXT');
}
