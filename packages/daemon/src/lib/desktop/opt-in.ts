import type { Database } from '../../storage/sqlite-compat.ts';

export type DesktopTodoRow = {
  worker: string;
  id: string;
  title: string;
  named: string | null;
  active: number;
};

export function readDesktopTodos(db: Pick<Database, 'prepare'>, worker?: string) {
  return db
    .prepare(
      `SELECT * FROM (SELECT json_extract(s.ref, '$.id') AS worker, t.id, t.title, t.named,
        (t.state = 'doing' AND t.approved_at IS NOT NULL AND a.status = 'open') AS active
      FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id JOIN neo_todo_sessions s ON s.todo_id = t.id
      WHERE json_extract(s.ref, '$.daemon') IS NULL)
      WHERE worker IS NOT NULL AND (? IS NULL OR worker = ?) AND (? IS NOT NULL OR active)`
    )
    .all(worker ?? null, worker ?? null, worker ?? null) as DesktopTodoRow[];
}

export function desktopOptIn(rows: readonly DesktopTodoRow[], worker: string) {
  const own = rows.filter((row) => row.worker === worker && row.active);
  return own.length === 1 && JSON.parse(own[0].named ?? '{}').desktopControl === true
    ? own[0]
    : null;
}
