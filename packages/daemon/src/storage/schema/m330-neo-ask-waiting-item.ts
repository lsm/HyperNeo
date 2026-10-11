import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name);

export function runMigration330(db: Database): void {
  if (!hasTable(db, 'neo_asks')) return;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(neo_asks)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (columns.has('waiting_item')) return;
  db.exec('ALTER TABLE neo_asks ADD COLUMN waiting_item TEXT');
  if (hasTable(db, 'neo_ask_items'))
    db.exec(`UPDATE neo_asks SET waiting_item = (
        SELECT i.id FROM neo_ask_items i
        WHERE i.ask_id = neo_asks.id AND i.removed = 0 AND i.text = neo_asks.outcome
        ORDER BY i.position LIMIT 1)
      WHERE status = 'waiting'`);
}
