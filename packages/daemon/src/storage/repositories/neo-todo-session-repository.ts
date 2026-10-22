import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import type { WorkRef } from '../../lib/drivers/types.ts';
import type { NeoDriverTarget } from '../../lib/neo/driver-work.ts';
import type { Database } from '../sqlite-compat.ts';
import { WorkDeliveryInputRepository } from './work-delivery-input-repository.ts';
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

type StoredLinks = {
  target?: string | null;
  ref: string | null;
  link: string | null;
  remote: string | null;
};

function sessionLinks(row: StoredLinks | null | undefined) {
  const ref: WorkRef | null = row?.ref
    ? JSON.parse(row.ref)
    : row?.target
      ? (JSON.parse(row.target).ref ?? null)
      : null;
  const remote = neoSafeSessionLink(row?.remote, true);
  return {
    worker: ref ? workerIdentity(ref, null) : null,
    link:
      neoSafeSessionLink(row?.link, !!ref?.daemon) ??
      remote ??
      (ref?.adapter === 'hyperneo' && !ref.daemon ? `/session/${ref.id}` : null),
    remoteLink: remote?.startsWith('https://') ? remote : null,
  };
}

export class NeoTodoSessionRepository extends NeoDriverSessionRows {
  readonly inputs: WorkDeliveryInputRepository;
  constructor(db: Database) {
    super(db, 'neo_todo_sessions', 'todo_id');
    this.inputs = new WorkDeliveryInputRepository(db);
  }

  readNudge(todoId: string): { since: number; nudges: number } | null {
    const row = this.db
      .prepare(
        "SELECT value_json FROM pack_facts WHERE todo_id = ? AND pack = 'core' AND key = 'nudge'"
      )
      .get(todoId) as { value_json: string } | null;
    return row ? JSON.parse(row.value_json) : null;
  }

  recordNudge(todoId: string, incident: { since: number; nudges: number }): void {
    this.db
      .prepare(
        "INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'core', 'nudge', ?) ON CONFLICT(todo_id, pack, key) DO UPDATE SET value_json = excluded.value_json"
      )
      .run(todoId, JSON.stringify(incident));
  }

  doingTodoOn(
    ref: WorkRef,
    startedAfter: number | null = null
  ): { id: string; title: string } | null {
    return (
      (this.db
        .prepare(
          `SELECT t.id, t.title FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
            WHERE t.state = 'doing' AND (? IS NULL OR t.started_at > ?)
              AND COALESCE(json_extract(s.ref, '$.adapter'), json_extract(s.target, '$.ref.adapter')) = ?
              AND COALESCE(json_extract(s.ref, '$.id'), json_extract(s.target, '$.ref.id')) = ?
              AND COALESCE(json_extract(s.ref, '$.daemon'), json_extract(s.target, '$.ref.daemon')) IS ?
            LIMIT 1`
        )
        .get(startedAfter, startedAfter, ref.adapter, ref.id, ref.daemon ?? null) as {
        id: string;
        title: string;
      } | null) ?? null
    );
  }

  create(todoId: string, target: NeoDriverTarget): void {
    this.db
      .prepare('INSERT OR IGNORE INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)')
      .run(todoId, JSON.stringify(target));
  }

  readLinks(todoId: string): { link: string | null; remoteLink: string | null } {
    const row = this.db
      .prepare(
        'SELECT target, ref, link, remote_link AS remote FROM neo_todo_sessions WHERE todo_id = ?'
      )
      .get(todoId) as StoredLinks | null;
    return sessionLinks(row);
  }

  readLinksForTodos(todoIds: readonly string[]) {
    const rows = this.db
      .prepare(`SELECT todo_id AS todoId, target, ref, link, remote_link AS remote
        FROM neo_todo_sessions WHERE todo_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(todoIds)) as (StoredLinks & { todoId: string })[];
    return new Map(rows.map((row) => [row.todoId, sessionLinks(row)]));
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
