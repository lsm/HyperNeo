import type { Database } from '../sqlite-compat.ts';

export function runMigration456(db: Database): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('neo_todos', 'neo_todo_sessions')"
    )
    .all();
  if (tables.length !== 2) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_todos_ask_order
    ON neo_todos(ask_id, position, created_at);
    CREATE INDEX IF NOT EXISTS idx_neo_todos_state_ask ON neo_todos(state, ask_id);
    CREATE INDEX IF NOT EXISTS idx_neo_todo_sessions_ref ON neo_todo_sessions(ref, todo_id)`);
}
