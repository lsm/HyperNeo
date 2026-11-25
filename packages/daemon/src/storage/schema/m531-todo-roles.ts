import type { Database } from '../sqlite-compat.ts';

export function runMigration531(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_todo_roles (
    todo_id TEXT NOT NULL REFERENCES neo_todos(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    adapter TEXT NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    model TEXT,
    effort TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_neo_todo_roles_todo_role ON neo_todo_roles(todo_id, role, at);
  INSERT INTO neo_todo_roles (todo_id, role, adapter, id, at, model, effort)
  SELECT bound.todo_id, 'do', worker.adapter, worker.id,
         COALESCE(bound.started_at, 0), bound.actual_model, bound.actual_effort
  FROM neo_todo_sessions bound JOIN work_started_sessions worker
    ON worker.adapter = json_extract(bound.ref, '$.adapter')
    AND worker.id = json_extract(bound.ref, '$.id') AND worker.kind = 'worker'
  WHERE bound.ref IS NOT NULL AND json_extract(bound.ref, '$.daemon') IS NULL
    AND NOT EXISTS (SELECT 1 FROM neo_todo_roles roles WHERE roles.todo_id = bound.todo_id AND roles.role = 'do')`);
}
