import type { Database } from '../sqlite-compat.ts';

export function runMigration506(db: Database): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('neo_todos', 'neo_asks')"
    )
    .all() as { name: string }[];
  if (tables.length < 2) return;
  db.exec(`
    UPDATE neo_todos SET depends_on = COALESCE((
      SELECT json_array(before.id) FROM neo_todos before
      WHERE before.ask_id = neo_todos.ask_id AND before.position < neo_todos.position
      ORDER BY before.position DESC LIMIT 1
    ), '[]') WHERE depends_on IS NULL AND state IN ('todo', 'doing', 'blocked', 'failed')
      AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open');
  `);
}
