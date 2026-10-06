import type { Database } from '../sqlite-compat.ts';

export function addNeoRoutingDigestedColumn(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_routing_log' AND type = 'table'")
    .get();
  if (!table) return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_routing_log)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('digested_at'))
    db.exec('ALTER TABLE neo_routing_log ADD COLUMN digested_at INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_routing_log_undigested ON neo_routing_log(id)
    WHERE digested_at IS NULL AND destination != 'main'`);
}

export function runMigration300(db: Database): void {
  addNeoRoutingDigestedColumn(db);
}
