import type { Database } from '../sqlite-compat.ts';

export function addNeoRoutingTurnNoteColumns(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_routing_log' AND type = 'table'")
    .get();
  if (!table) return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_routing_log)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('ask_summary'))
    db.exec('ALTER TABLE neo_routing_log ADD COLUMN ask_summary TEXT');
  if (!columns.has('awaiting')) db.exec('ALTER TABLE neo_routing_log ADD COLUMN awaiting TEXT');
}

export function runMigration301(db: Database): void {
  addNeoRoutingTurnNoteColumns(db);
}
