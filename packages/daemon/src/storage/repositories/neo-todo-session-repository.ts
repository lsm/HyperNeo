import type { WorkRef } from '../../lib/drivers/types.ts';
import type { NeoDriverTarget } from '../../lib/neo/driver-work.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoDriverSessionRows } from './neo-driver-session-rows.ts';

export function neoSafeSessionLink(
  link: string | null | undefined,
  remote: boolean
): string | null {
  if (!link || [...link].some((char) => char <= ' ' || char === '\\')) return null;
  if (/^(codex|claude|ghapp):\/\//.test(link)) return link;
  if (remote) return /^https?:\/\//.test(link) ? link : null;
  return /^\/(?!\/)/.test(link) ? link : null;
}

export class NeoTodoSessionRepository extends NeoDriverSessionRows {
  constructor(db: Database) {
    super(db, 'neo_todo_sessions', 'todo_id');
  }

  doingTodoOn(ref: WorkRef): { id: string; title: string } | null {
    return (
      (this.db
        .prepare(
          `SELECT t.id, t.title FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
            WHERE t.state = 'doing'
              AND COALESCE(json_extract(s.ref, '$.adapter'), json_extract(s.target, '$.ref.adapter')) = ?
              AND COALESCE(json_extract(s.ref, '$.id'), json_extract(s.target, '$.ref.id')) = ?
              AND COALESCE(json_extract(s.ref, '$.daemon'), json_extract(s.target, '$.ref.daemon')) IS ?
            LIMIT 1`
        )
        .get(ref.adapter, ref.id, ref.daemon ?? null) as { id: string; title: string } | null) ??
      null
    );
  }

  create(todoId: string, target: NeoDriverTarget): void {
    this.db
      .prepare('INSERT OR IGNORE INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)')
      .run(todoId, JSON.stringify(target));
  }

  readLinks(todoId: string): { link: string | null; remoteLink: string | null } {
    const row = this.db
      .prepare('SELECT ref, link, remote_link AS remote FROM neo_todo_sessions WHERE todo_id = ?')
      .get(todoId) as { ref: string | null; link: string | null; remote: string | null } | null;
    const ref = row?.ref ? (JSON.parse(row.ref) as WorkRef) : null;
    const remote = neoSafeSessionLink(row?.remote, true);
    const remoteLink = remote?.startsWith('https://') ? remote : null;
    return {
      link:
        neoSafeSessionLink(row?.link, !!ref?.daemon) ??
        remote ??
        (ref?.adapter === 'hyperneo' && !ref.daemon ? `/session/${ref.id}` : null),
      remoteLink,
    };
  }

  unrecordedStarts(): string[] {
    return (
      this.db
        .prepare(
          `SELECT s.todo_id AS todoId FROM neo_todo_sessions s
             JOIN neo_todos t ON t.id = s.todo_id
            WHERE s.ref IS NULL AND t.state = 'doing'`
        )
        .all() as { todoId: string }[]
    ).map((row) => row.todoId);
  }

  awaitingReports(): { todoId: string; ref: WorkRef }[] {
    return (
      this.db
        .prepare(
          `SELECT s.todo_id AS todoId, s.ref FROM neo_todo_sessions s
             JOIN neo_todos t ON t.id = s.todo_id
            WHERE s.ref IS NOT NULL AND t.state = 'doing'`
        )
        .all() as { todoId: string; ref: string }[]
    ).map((row) => ({ todoId: row.todoId, ref: JSON.parse(row.ref) as WorkRef }));
  }
}
