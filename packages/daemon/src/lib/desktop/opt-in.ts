import type { NeoDesktopApp } from '@hyperneo/shared/types/neo-ask';
import type { Database } from '../../storage/sqlite-compat.ts';

export type DesktopTodoRow = {
  worker: string;
  id: string;
  title: string;
  named: string | null;
  apps?: string | null;
  askApps?: string | null;
  open?: number;
  active: number;
  finished?: number;
  doing?: number;
};

export function readDesktopTodos(db: Pick<Database, 'prepare'>, worker?: string) {
  return db
    .prepare(
      `SELECT * FROM (SELECT json_extract(s.ref, '$.id') AS worker, t.id, t.title, t.named, t.desktop_apps AS apps,
        a.desktop_apps AS askApps,
        (a.status = 'open' AND t.state IN ('todo', 'doing', 'blocked')) AS open,
        (t.state IN ('todo', 'doing', 'blocked') AND t.approved_at IS NOT NULL AND a.status = 'open') AS active,
        (t.state IN ('done', 'removed')) AS finished,
        (t.state = 'doing') AS doing
      FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id JOIN neo_todo_sessions s ON s.todo_id = t.id
      WHERE json_extract(s.ref, '$.daemon') IS NULL)
      WHERE worker IS NOT NULL AND (? IS NULL OR worker = ?) AND (? IS NOT NULL OR active)`
    )
    .all(worker ?? null, worker ?? null, worker ?? null) as DesktopTodoRow[];
}

export const desktopApps = (row: DesktopTodoRow): string[] =>
  (JSON.parse(row.apps ?? '[]') as NeoDesktopApp[]).map((app) => app.bundleId);

export function desktopConsent(row: DesktopTodoRow) {
  const requested = desktopApps(row);
  if (!requested.length || JSON.parse(row.named ?? '{}').desktopControl === false)
    return 'desktop_not_enabled';
  const approved = JSON.parse(row.askApps ?? '[]') as NeoDesktopApp[];
  const scope = requested.map((id) => approved.find((app) => app.bundleId === id));
  if (scope.some((app) => !app)) return 'desktop_not_enabled';
  if (scope.some((app) => app?.seen !== 'all')) return 'desktop_consent_outdated';
  return null;
}

export const desktopAllowedRow = (row: DesktopTodoRow) => desktopConsent(row) === null;

export function desktopAllowed(rows: readonly DesktopTodoRow[], worker: string) {
  const own = rows.filter((row) => row.worker === worker && row.active);
  const doing = own.filter((row) => row.doing);
  const candidates = doing.length ? doing : own.filter(desktopAllowedRow);
  return candidates.length === 1 && desktopAllowedRow(candidates[0]) ? candidates[0] : null;
}
