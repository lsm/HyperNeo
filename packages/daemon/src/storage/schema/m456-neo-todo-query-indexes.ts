import type { Database } from '../sqlite-compat.ts';

export function runMigration456(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_todos_ask_order
    ON neo_todos(ask_id, position, created_at);
    CREATE INDEX IF NOT EXISTS idx_neo_todos_state_ask ON neo_todos(state, ask_id);
    CREATE INDEX IF NOT EXISTS idx_neo_todo_sessions_ref ON neo_todo_sessions(ref, todo_id)`);
}
