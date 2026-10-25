import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import type { WorkRef } from '../../lib/drivers/types.ts';
import type { DriverSent, NeoDriverTarget } from '../../lib/neo/driver-work.ts';
import type { NeoDriverProgress } from '../../lib/neo/settle-driver-work.ts';
import type { NeoWorkDriverReceipt } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
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
  read(
    method: 'unrecordedStarts'
  ): Promise<ReturnType<NeoTodoSessionRepository['unrecordedStarts']>>;
  read(method: 'awaitingReports'): Promise<ReturnType<NeoTodoSessionRepository['awaitingReports']>>;
  read(method: (typeof neoTodoSessionReads.methods)[number]) {
    return gatewayFor(this.db).call(neoTodoSessionReads, method);
  }

  write<K extends (typeof neoTodoSessionWrites.methods)[number]>(
    method: K,
    ...args: Parameters<NeoTodoSessionRepository[K]>
  ): Promise<ReturnType<NeoTodoSessionRepository[K]>> {
    return gatewayFor(this.db).call(neoTodoSessionWrites, method, ...(args as never)) as Promise<
      ReturnType<NeoTodoSessionRepository[K]>
    >;
  }

  recordDispatch(input: {
    todoId: string;
    askId: string;
    ref: WorkRef;
    startedAt?: number;
    link?: string;
    observed: Pick<NeoWorkDriverReceipt, 'model' | 'effort'>;
    sent: DriverSent | null;
    keepIdentity: boolean;
  }) {
    const recorded = input.keepIdentity ? this.readCard(input.todoId) : null;
    this.recordRef(input.todoId, input.ref, input.startedAt, input.link, {
      model: input.observed.model ?? recorded?.model ?? undefined,
      effort: input.observed.effort ?? recorded?.effort ?? undefined,
    });
    this.recordSent(input.todoId, input.sent);
    const todos = new NeoAskTodoRepository(this.db);
    return {
      todo: todos.getTodo(input.todoId),
      askOpen: todos.getAsk(input.askId)?.status === 'open',
    };
  }

  readonly inputs: WorkDeliveryInputRepository;
  constructor(db: Database) {
    super(db, 'neo_todo_sessions', 'todo_id');
    this.inputs = new WorkDeliveryInputRepository(db);
  }

  recordProgress(todoId: string, progress: NeoDriverProgress, now: number): boolean {
    if (progress.landed !== null) this.recordStartedAt(todoId, progress.landed);
    let changed = false;
    if (progress.live && progress.cardStatus) {
      if (progress.cardStatus !== 'needs_you' && this.readNeedsYouSince(todoId) !== null)
        this.recordNeedsYouSince(todoId, null);
      changed = this.recordLive(
        todoId,
        progress.cardStatus,
        progress.live.link,
        progress.live.remoteLink
      );
    }
    this.recordCardCheck(todoId, { checkedAt: now, unchecked: progress.live === null });
    return changed;
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

  bind(todoId: string, ref: WorkRef, now: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO neo_todo_sessions
      (todo_id, target, ref, started_at, follow_anchor)
      VALUES (?, ?, ?, ?, ?)`)
      .run(todoId, JSON.stringify({ verb: 'adopt', ref }), JSON.stringify(ref), now, now);
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

export const neoTodoSessionReads = defineRepositoryOp(
  'neo.todoSessionReads',
  'read',
  NeoTodoSessionRepository,
  ['unrecordedStarts', 'awaitingReports']
);
export const neoTodoSessionWrites = defineRepositoryOp(
  'neo.todoSessionWrites',
  'write',
  NeoTodoSessionRepository,
  ['recordLive', 'recordDispatch', 'recordProgress']
);
