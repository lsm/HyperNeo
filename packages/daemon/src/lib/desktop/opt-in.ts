import type { Database } from '../../storage/sqlite-compat.ts';

export type DesktopTodoRow = {
  worker: string;
  id: string;
  title: string;
  named: string | null;
  active: number;
  finished?: number;
  doing?: number;
};

export function readDesktopTodos(db: Pick<Database, 'prepare'>, worker?: string) {
  return db
    .prepare(
      `SELECT * FROM (SELECT json_extract(s.ref, '$.id') AS worker, t.id, t.title, t.named,
        (t.state IN ('todo', 'doing', 'blocked') AND t.approved_at IS NOT NULL AND a.status = 'open') AS active,
        (t.state IN ('done', 'removed')) AS finished,
        (t.state = 'doing') AS doing
      FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id JOIN neo_todo_sessions s ON s.todo_id = t.id
      WHERE json_extract(s.ref, '$.daemon') IS NULL)
      WHERE worker IS NOT NULL AND (? IS NULL OR worker = ?) AND (? IS NOT NULL OR active)`
    )
    .all(worker ?? null, worker ?? null, worker ?? null) as DesktopTodoRow[];
}

export const desktopAllowedRow = (row: DesktopTodoRow) =>
  JSON.parse(row.named ?? '{}').desktopControl !== false;

export function desktopAllowed(rows: readonly DesktopTodoRow[], worker: string) {
  const own = rows.filter((row) => row.worker === worker && row.active);
  const doing = own.filter((row) => row.doing);
  const candidates = doing.length ? doing : own;
  return candidates.length === 1 && desktopAllowedRow(candidates[0]) ? candidates[0] : null;
}
