import type { Database } from '../../storage/sqlite-compat.ts';

export type DesktopTodoRow = { worker: string; id: string; title: string; named: string | null };

export function readDesktopTodos(db: Pick<Database, 'prepare'>, worker?: string) {
  return db
    .prepare(
      `SELECT json_extract(s.ref, '$.id') AS worker, t.id, t.title, t.named FROM neo_todos t
      JOIN neo_asks a ON a.id = t.ask_id JOIN neo_todo_sessions s ON s.todo_id = t.id
      WHERE t.state = 'doing' AND t.approved_at IS NOT NULL AND a.status = 'open'
      AND json_extract(s.ref, '$.id') IS NOT NULL AND json_extract(s.ref, '$.daemon') IS NULL
      AND (? IS NULL OR json_extract(s.ref, '$.id') = ?)`
    )
    .all(worker ?? null, worker ?? null) as DesktopTodoRow[];
}

export function desktopOptIn(rows: readonly DesktopTodoRow[], worker: string) {
  const own = rows.filter((row) => row.worker === worker);
  return own.length === 1 && JSON.parse(own[0].named ?? '{}').desktopControl === true
    ? own[0]
    : null;
}
