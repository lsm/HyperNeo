import type { ReactiveDatabase } from '../reactive-database.ts';
import type { NeoStepRead } from '../../lib/neo/attention/sweep.ts';
import { neoTodoWithoutFollowUp } from '../../lib/neo/todo-follow-up.ts';
import { neoTodoWaitReason } from '../../lib/neo/todo-start-gate.ts';
import { neoTodoCovered } from '../../lib/neo/todo-state.ts';
import { NeoTurnReportReceipts } from '../../lib/neo/turn-report-receipts.ts';
import {
  advanceFollowThrough,
  type FollowThroughIncident,
} from '../../lib/work-queue/follow-through.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { markWorkUnusable, readStartedWork, recordStartedWork } from '../work-started-sessions.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import type { WorkRef, WorkStatus, WorkTurnQuestion } from '../../lib/drivers/types.ts';
import type { DriverSent, NeoDriverTarget, readDriverOutcome } from '../../lib/neo/driver-work.ts';
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

function storedRefForms({ adapter, id, daemon }: WorkRef): [string, string] {
  return daemon
    ? [JSON.stringify({ adapter, id, daemon }), JSON.stringify({ adapter, daemon, id })]
    : [JSON.stringify({ adapter, id }), JSON.stringify({ adapter, id })];
}

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

export const neoWorkerKey = (ref: WorkRef | null | undefined) =>
  ref ? `${ref.adapter}:${ref.id}${ref.daemon ? `@${ref.daemon}` : ''}` : null;

const LIVE_TODO_STATES = ['todo', 'doing', 'blocked'];

export class NeoTodoSessionRepository extends NeoDriverSessionRows {
  read(
    method: 'unrecordedStarts'
  ): Promise<ReturnType<NeoTodoSessionRepository['unrecordedStarts']>>;
  read(method: 'awaitingReports'): Promise<ReturnType<NeoTodoSessionRepository['awaitingReports']>>;
  read(
    method: 'nudgeContext',
    todoId: string
  ): Promise<ReturnType<NeoTodoSessionRepository['nudgeContext']>>;
  read(
    method: 'stopContext',
    todoId: string
  ): Promise<ReturnType<NeoTodoSessionRepository['stopContext']>>;
  read(
    method: 'queueFacts',
    trackerHolds?: Record<string, string | null>
  ): Promise<ReturnType<NeoTodoSessionRepository['queueFacts']>>;
  read(method: 'neoStepFacts'): Promise<ReturnType<NeoTodoSessionRepository['neoStepFacts']>>;
  read(method: 'syncedActivity'): Promise<ReturnType<NeoTodoSessionRepository['syncedActivity']>>;
  read(
    method: 'syncedLive',
    ref: WorkRef
  ): Promise<ReturnType<NeoTodoSessionRepository['syncedLive']>>;
  read(
    method: 'finishedWorkers',
    since: number
  ): Promise<ReturnType<NeoTodoSessionRepository['finishedWorkers']>>;
  read(
    method: (typeof neoTodoSessionReads.methods)[number],
    key?: string | number | WorkRef | Record<string, string | null>
  ) {
    return gatewayFor(this.db).call(
      neoTodoSessionReads,
      method,
      ...((key === undefined ? [] : [key]) as never)
    );
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
    target?: NeoDriverTarget;
  }) {
    const recorded = input.keepIdentity ? this.readCard(input.todoId) : null;
    const observed =
      input.observed.model !== undefined || input.observed.effort !== undefined
        ? input.observed
        : recorded;
    this.recordRef(
      input.todoId,
      input.ref,
      input.startedAt,
      input.link,
      {
        model: observed?.model ?? undefined,
        effort: observed?.effort ?? undefined,
      },
      input.target
    );
    this.recordSent(input.todoId, input.sent);
    const todos = new NeoAskTodoRepository(this.db);
    return {
      todo: todos.getTodo(input.todoId),
      askOpen: todos.getAsk(input.askId)?.status === 'open',
    };
  }

  readonly inputs: WorkDeliveryInputRepository;
  readonly turnReports: NeoTurnReportReceipts;
  constructor(
    db: Database,
    private readonly changes?: Pick<ReactiveDatabase, 'notifyChange'>
  ) {
    super(db, 'neo_todo_sessions', 'todo_id');
    this.inputs = new WorkDeliveryInputRepository(db);
    this.turnReports = new NeoTurnReportReceipts(db);
  }

  completeFollowUp(
    todoId: string,
    delivered: Exclude<ReturnType<typeof readDriverOutcome>, { failure: string }>,
    sent: DriverSent | null,
    now: number
  ): void {
    const store = new NeoAskTodoRepository(this.db);
    const todo = store.getTodo(todoId);
    if (!todo || store.getAsk(todo.askId)?.status !== 'open') return;
    this.recordStartedAt(todoId, 'queued' in delivered ? null : (delivered.startedAt ?? null));
    this.recordSent(todoId, sent);
    const prior = this.readNudge(todoId);
    this.recordNudge(todoId, {
      since: now,
      nudges: 0,
      ...(prior?.redispatched ? { redispatched: true } : {}),
      ...(prior?.live ? { live: prior.live } : {}),
    });
    if (todo.blockedBy === 'needs-human')
      for (const card of store.listQuestions(todo.askId))
        if (card.state === 'open' && card.todoId === todoId)
          store.retireQuestion(card, 'Neo sent the worker on.', null, now);
    store.updateTodo(todo, { state: 'doing', report: null, evidence: null, finishedAt: null }, now);
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

  claimNeedsYou(todoId: string, now: number) {
    const since = this.readNeedsYouSince(todoId);
    const todo = new NeoAskTodoRepository(this.db).getTodo(todoId);
    const followed =
      todo?.state === 'doing' || (todo?.state === 'blocked' && todo.blockedBy === 'worker');
    if (since !== null || !todo || !followed) return null;
    this.recordNeedsYouSince(todoId, now);
    return todo;
  }

  stageTurnQuestion(todoId: string, question: WorkTurnQuestion, now: number) {
    this.recordNudge(todoId, {
      ...(this.readNudge(todoId) ?? { since: now, nudges: 0 }),
      turnQuestion: question.id,
      workerQuestion: {
        kind: 'question',
        title: question.text,
        options: question.actions,
        language: 'en',
        report: question.text,
      },
    });
  }

  nudgeContext(todoId: string) {
    const store = new NeoAskTodoRepository(this.db),
      todo = store.getTodo(todoId);
    const ask = todo && store.getAsk(todo.askId),
      ref = this.readRef(todoId),
      verb = this.get(todoId)?.verb;
    return todo?.state === 'doing' && ref && ask?.status === 'open'
      ? {
          todo,
          ask,
          ref,
          follow: {
            remind: !ask.originMessageId?.startsWith('neo-track:'),
            redispatch: !!todo.instruction && verb === 'start',
          },
        }
      : null;
  }

  private openAskFacts() {
    const store = new NeoAskTodoRepository(this.db);
    const asks = store.listOpenAsks();
    const roots = [...new Set(asks.map((ask) => ask.parentId ?? ask.id))];
    const children = store.listChildAsksOf(roots);
    const members = (root: string) => [
      root,
      ...children.filter((child) => child.parentId === root).map((child) => child.id),
    ];
    const ids = [...new Set(roots.flatMap(members))];
    const todos = store.listTodosForAsks(ids);
    const questions = store.listQuestionsForAsks(ids);
    const sessions = this.readMany(todos.map((todo) => todo.id));
    const nudges = this.readNudges(todos.map((todo) => todo.id));
    const nudge = (id: string) => nudges.get(id) ?? null;
    return {
      store,
      asks,
      todos: todos.filter((todo) => asks.some((ask) => ask.id === todo.askId)),
      plan: (ask: NeoAsk) => todos.filter((todo) => todo.askId === ask.id),
      family: (ask: NeoAsk) => {
        const family = members(ask.parentId ?? ask.id);
        return todos.filter((todo) => family.includes(todo.askId));
      },
      cards: (ask: NeoAsk) => {
        const gate = ask.parentId ? [ask.parentId, ask.id] : [ask.id];
        return questions.filter((question) => gate.includes(question.askId));
      },
      target: (id: string) => sessions.get(id)?.target ?? null,
      ref: (id: string) => sessions.get(id)?.ref ?? null,
      nudge,
      idle: (id: string) =>
        ['done', 'stopped', 'failed', 'needs_you'].includes(nudge(id)?.live ?? ''),
    };
  }

  queueFacts(trackerHolds: Record<string, string | null> = {}, open = this.openAskFacts()) {
    const { asks } = open;
    const running = open.todos.flatMap((todo) =>
      todo.state === 'doing'
        ? [
            {
              group: asks.find((ask) => ask.id === todo.askId)?.projectId ?? null,
              worker: neoWorkerKey(open.ref(todo.id)),
              title: todo.title,
              idle: open.idle(todo.id),
            },
          ]
        : []
    );
    const waiting = asks.flatMap((ask) => {
      const asked = open.cards(ask);
      const family = open.family(ask);
      return open
        .plan(ask)
        .flatMap((next) =>
          (next.state === 'todo' || (next.state === 'blocked' && next.blockedBy === 'question')) &&
          next.startedAt === null &&
          !neoTodoWaitReason(next, family, asked, next.instruction ? trackerHolds[next.id] : null)
            ? [{ ask, next, target: open.target(next.id) }]
            : []
        );
    });
    const candidates = waiting.flatMap(({ ask, next, target }) =>
      next.approvedAt !== null &&
      next.instruction &&
      (target?.verb === 'start' || target?.verb === 'send')
        ? [
            {
              id: next.id,
              group: ask.projectId ?? null,
              priority: next.priority,
              createdAt: next.createdAt,
              worker: target.verb === 'send' ? neoWorkerKey(target.ref) : null,
              ref: target.verb === 'send' ? target.ref : null,
            },
          ]
        : []
    );
    const unworked = waiting.flatMap(({ next, target }) =>
      next.approvedAt === null ||
      !next.instruction ||
      !target ||
      !['start', 'send'].includes(target.verb)
        ? [next.id]
        : []
    );
    return { candidates, running, unworked };
  }

  neoStepFacts() {
    const open = this.openAskFacts();
    const { store } = open;
    const { candidates, running, unworked } = this.queueFacts({}, open);
    const pending = new Set(store.questionAnswers.pending().map((route) => route.todoId));
    const failedAt = (todo: NeoTodo) =>
      todo.state === 'blocked' && todo.blockedBy === 'failure' ? todo.updatedAt : null;
    const asks = open.asks.map((ask) => ({
      ask,
      family: open.family(ask),
      cards: open.cards(ask),
    }));
    const step = (todo: NeoTodo, family: NeoTodo[], cards: NeoQuestion[]): NeoStepRead => {
      const nudge = open.nudge(todo.id);
      const answered = cards.flatMap((card) =>
        card.state === 'answered' && card.todos.includes(todo.id) ? (card.answeredAt ?? []) : []
      );
      return {
        todo,
        facts: {
          covered: neoTodoCovered(todo, cards),
          held: todo.blockedBy === 'held',
          prerequisites: (todo.dependsOn ?? []).flatMap((id) =>
            family.flatMap((item) =>
              item.id === id
                ? [
                    {
                      state: item.state,
                      blockedBy: item.blockedBy,
                      finishedAt: item.finishedAt,
                      failedAt: failedAt(item),
                    },
                  ]
                : []
            )
          ),
          answerPending: pending.has(todo.id),
          cardClosedAt: answered.length ? Math.max(...answered) : null,
          failedAt: failedAt(todo),
          worker: open.ref(todo.id)
            ? {
                status: ['running', 'queued'].includes(nudge?.live ?? '')
                  ? 'running'
                  : open.idle(todo.id)
                    ? 'idle'
                    : 'unknown',
                since: Math.max(
                  nudge?.since ?? 0,
                  nudge?.liveSince ?? 0,
                  todo.startedAt ?? todo.createdAt
                ),
              }
            : null,
          packWaiting: false,
          start: candidates.some((item) => item.id === todo.id) ? 'ready' : null,
        },
      };
    };
    return {
      candidates,
      running,
      unapproved: asks.flatMap(({ ask, family, cards }) =>
        family.filter(
          (todo) =>
            todo.askId === ask.id &&
            todo.approvedAt === null &&
            unworked.includes(todo.id) &&
            !neoTodoCovered(todo, cards)
        )
      ),
      followUps: asks.flatMap(({ ask, family }) => {
        const todo = neoTodoWithoutFollowUp(family.filter((item) => item.askId === ask.id));
        return todo ? [{ ask, todo }] : [];
      }),
      steps: asks.flatMap(({ ask, family, cards }) =>
        family
          .filter((todo) => todo.askId === ask.id && LIVE_TODO_STATES.includes(todo.state))
          .map((todo) => step(todo, family, cards))
      ),
      cards: asks.flatMap(({ ask, cards }) =>
        cards.filter((card) => card.askId === ask.id && card.state === 'open')
      ),
    };
  }

  claimNudge(
    todoId: string,
    ref: WorkRef,
    live: NonNullable<NeoDriverProgress['live']>,
    now: number,
    updatedAt: number,
    move: boolean
  ) {
    const context = this.nudgeContext(todoId);
    if (
      !context ||
      context.todo.updatedAt !== updatedAt ||
      JSON.stringify(context.ref) !== JSON.stringify(ref) ||
      live.status === 'queued' ||
      neoTodoCovered(context.todo, new NeoAskTodoRepository(this.db).todoCards(context.todo))
    )
      return null;
    const since = Math.max(
      context.todo.startedAt ?? context.todo.createdAt,
      live.lastReplyAt ?? live.lastActivityAt
    );
    const { incident, plan, next } = advanceFollowThrough(
      this.readNudge(todoId),
      { since, live: live.status, idle: ['done', 'stopped'].includes(live.status) },
      now,
      { ...context.follow, move }
    );
    this.recordNudge(todoId, next);
    return plan ? { ...context, incident, plan } : null;
  }

  finishNudge(todoId: string, since: number, expectedNudges: number, nudges: number): void {
    const current = this.readNudge(todoId);
    if (current?.since === since && current.nudges === expectedNudges)
      this.recordNudge(todoId, { ...current, nudges });
  }

  noteWorkerStatus(todoId: string, status: string, now: number): void {
    const prior = this.readNudge(todoId);
    if (prior?.live !== status)
      this.recordNudge(todoId, {
        ...(prior ?? { since: 0, nudges: 0 }),
        live: status,
        liveSince: now,
      });
  }

  markWorkerUnusable(ref: WorkRef): void {
    markWorkUnusable(this.db, ref);
  }

  workerIdle(todoId: string): boolean {
    return ['done', 'stopped', 'failed', 'needs_you'].includes(this.readNudge(todoId)?.live ?? '');
  }

  readNudge(todoId: string): FollowThroughIncident | null {
    return this.readNudges([todoId]).get(todoId) ?? null;
  }

  private readNudges(todoIds: readonly string[]) {
    return new Map(
      (
        this.db
          .prepare(
            `SELECT todo_id AS id, value_json FROM pack_facts
             WHERE pack = 'core' AND key = 'nudge' AND todo_id IN (SELECT value FROM json_each(?))`
          )
          .all(JSON.stringify(todoIds)) as { id: string; value_json: string }[]
      ).map((row) => [row.id, JSON.parse(row.value_json) as FollowThroughIncident])
    );
  }

  recordNudge(todoId: string, incident: FollowThroughIncident): void {
    const prior = this.readNudge(todoId);
    const blockerReport = incident.blockerReport ?? prior?.blockerReport;
    const liveSince =
      incident.liveSince ?? (prior?.live === incident.live ? prior?.liveSince : undefined);
    this.writeCoreFact(todoId, 'nudge', {
      ...incident,
      ...(blockerReport ? { blockerReport } : {}),
      ...(liveSince !== undefined ? { liveSince } : {}),
    });
  }

  private writeCoreFact(todoId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'core', ?, ?) ON CONFLICT(todo_id, pack, key) DO UPDATE SET value_json = excluded.value_json"
      )
      .run(todoId, key, JSON.stringify(value));
  }

  doingTodoOn(
    ref: WorkRef,
    startedAfter: number | null = null,
    states: readonly string[] = ['doing']
  ): { id: string; title: string } | null {
    return (
      (this.db
        .prepare(
          `SELECT t.id, t.title FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
            WHERE t.state IN (SELECT value FROM json_each(?)) AND (? IS NULL OR t.started_at > ?)
              AND COALESCE(json_extract(s.ref, '$.adapter'), json_extract(s.target, '$.ref.adapter')) = ?
              AND COALESCE(json_extract(s.ref, '$.id'), json_extract(s.target, '$.ref.id')) = ?
              AND COALESCE(json_extract(s.ref, '$.daemon'), json_extract(s.target, '$.ref.daemon')) IS ?
            LIMIT 1`
        )
        .get(
          JSON.stringify(states),
          startedAfter,
          startedAfter,
          ref.adapter,
          ref.id,
          ref.daemon ?? null
        ) as {
        id: string;
        title: string;
      } | null) ?? null
    );
  }

  sendsNow(todoId: string, ref: WorkRef): boolean {
    const target = this.get(todoId);
    const state = new NeoAskTodoRepository(this.db).getTodo(todoId)?.state;
    const worker = neoWorkerKey(ref);
    return (
      !state ||
      (neoWorkerKey(this.readRef(todoId)) === worker &&
        (state === 'doing' || state === 'blocked')) ||
      (target?.verb === 'send' && neoWorkerKey(target.ref) === worker && state === 'doing')
    );
  }

  queueOn(todoId: string, ref: WorkRef, message: string): 'message' | 'instruction' | 'none' {
    const store = new NeoAskTodoRepository(this.db);
    const todo = store.getTodo(todoId);
    if (todo?.state !== 'todo' || todo.startedAt !== null) return 'none';
    this.db
      .prepare(`INSERT INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)
        ON CONFLICT(todo_id) DO UPDATE SET target = excluded.target`)
      .run(todoId, JSON.stringify({ verb: 'send', ref }));
    if (todo.instruction) return 'instruction';
    store.updateTodo(todo, { instruction: message }, Date.now());
    return 'message';
  }

  create(todoId: string, target: NeoDriverTarget): void {
    this.db
      .prepare('INSERT OR IGNORE INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)')
      .run(todoId, JSON.stringify(target));
  }

  recordIdentity(
    todoId: string,
    ref: WorkRef,
    identity: { model: string | null; effort: string | null }
  ): void {
    this.recordRef(
      todoId,
      ref,
      undefined,
      undefined,
      {
        model: identity.model ?? undefined,
        effort: identity.effort ?? undefined,
      },
      undefined,
      true
    );
  }

  bind(todoId: string, ref: WorkRef, now: number): void {
    const previous = this.readRef(todoId);
    const same =
      previous?.id === ref.id && previous.adapter === ref.adapter && previous.daemon === ref.daemon;
    this.db
      .prepare(`INSERT INTO neo_todo_sessions
      (todo_id, target, ref, started_at, follow_anchor)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(todo_id) DO UPDATE SET
        target = excluded.target, ref = excluded.ref, started_at = excluded.started_at,
        follow_anchor = excluded.follow_anchor,
        actual_model = CASE WHEN ?6 THEN actual_model ELSE NULL END,
        actual_effort = CASE WHEN ?6 THEN actual_effort ELSE NULL END,
        link = NULL, remote_link = NULL, input_before = NULL, sent_opening = NULL,
        sent_receipt = NULL, live_status = NULL, start_interrupted = 0, needs_you_since = NULL`)
      .run(
        todoId,
        JSON.stringify({ verb: 'adopt', ref, boundAt: now }),
        JSON.stringify(ref),
        now,
        now,
        Number(same)
      );
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

  syncedLive(ref: WorkRef): { status: WorkStatus; lastActivityAt: number } | null {
    if (ref.daemon) return null;
    return this.db
      .prepare(
        `SELECT status, last_activity_at AS lastActivityAt FROM work_sessions
         WHERE adapter = ? AND id = ?`
      )
      .get(ref.adapter, ref.id) as { status: WorkStatus; lastActivityAt: number } | null;
  }

  syncedActivity(): { adapter: string; id: string; status: string; at: number }[] {
    return this.db
      .prepare('SELECT adapter, id, status, last_activity_at AS at FROM work_sessions')
      .all() as { adapter: string; id: string; status: string; at: number }[];
  }

  workerName(ref: WorkRef): string | null {
    const synced = ref.daemon
      ? null
      : (this.db
          .prepare('SELECT name FROM work_sessions WHERE adapter = ? AND id = ?')
          .get(ref.adapter, ref.id) as { name: string } | null);
    if (synced?.name) return synced.name;
    const todo = this.db
      .prepare(
        `SELECT t.title FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
         WHERE s.ref IN (?1, ?2) OR (s.ref IS NULL
           AND json_extract(s.target, '$.ref.adapter') = ?3
           AND json_extract(s.target, '$.ref.id') = ?4
           AND json_extract(s.target, '$.ref.daemon') IS ?5)
         ORDER BY t.updated_at DESC LIMIT 1`
      )
      .get(...storedRefForms(ref), ref.adapter, ref.id, ref.daemon ?? null) as {
      title: string;
    } | null;
    return todo?.title ?? null;
  }

  stopContext(id: string) {
    const store = new NeoAskTodoRepository(this.db);
    const todo = store.getTodo(id);
    return todo
      ? {
          todo,
          ask: store.getAsk(todo.askId),
          ref: this.readRef(id),
          live: this.readLiveStatus(id),
          adopted: this.get(id)?.verb === 'adopt',
        }
      : null;
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

  finishedWorkers(since: number): {
    todoId: string;
    target: NeoDriverTarget;
    ref: WorkRef;
    shared: boolean;
    humanNamed: boolean;
    releasedBy: string | null;
  }[] {
    const match = (column: string, key: string) =>
      `COALESCE(json_extract(o.ref, '$.${key}'), json_extract(o.target, '$.ref.${key}')) ${column} json_extract(s.ref, '$.${key}')`;
    return (
      this.db
        .prepare(
          `SELECT s.todo_id AS todoId, s.target, s.ref,
              EXISTS (SELECT 1 FROM neo_todo_sessions o JOIN neo_todos ot ON ot.id = o.todo_id
                WHERE json_extract(ot.named, '$.session') IS NOT NULL
                  AND ${match('=', 'adapter')} AND ${match('=', 'id')} AND ${match('IS', 'daemon')}
              ) AS humanNamed,
              EXISTS (SELECT 1 FROM neo_todo_sessions o JOIN neo_todos ot ON ot.id = o.todo_id
                WHERE o.todo_id <> s.todo_id AND ot.state IN ('todo', 'doing', 'blocked')
                  AND ${match('=', 'adapter')} AND ${match('=', 'id')} AND ${match('IS', 'daemon')}
              ) AS shared,
              (SELECT o.todo_id FROM neo_todo_sessions o JOIN pack_facts f
                  ON f.todo_id = o.todo_id AND f.pack = 'core' AND f.key = 'released'
                WHERE o.todo_id <> s.todo_id
                  AND ${match('=', 'adapter')} AND ${match('=', 'id')} AND ${match('IS', 'daemon')}
                LIMIT 1) AS releasedBy
             FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
            WHERE t.state IN ('done', 'removed')
              AND CASE t.state WHEN 'removed' THEN t.updated_at ELSE t.finished_at END > ?
              AND s.ref IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM pack_facts f
                WHERE f.todo_id = s.todo_id AND f.pack = 'core' AND f.key = 'released')`
        )
        .all(since) as {
        todoId: string;
        target: string;
        ref: string;
        shared: number;
        humanNamed: number;
        releasedBy: string | null;
      }[]
    ).map((row) => ({
      todoId: row.todoId,
      target: JSON.parse(row.target) as NeoDriverTarget,
      ref: JSON.parse(row.ref) as WorkRef,
      shared: row.shared === 1,
      humanNamed: row.humanNamed === 1,
      releasedBy: row.releasedBy,
    }));
  }

  fenceRelease(ref: WorkRef, now: number): boolean {
    if (this.doingTodoOn(ref, null, LIVE_TODO_STATES)) return false;
    if (this.liveTodo(this.startedFacts(ref)?.claimedBy ?? null)) return false;
    recordStartedWork(this.db, ref, now, false, true);
    return true;
  }

  claimWorker(ref: WorkRef, todoId: string | null): boolean {
    const workers = readStartedWork(this.db);
    const own = workers.find((worker) => worker.adapter === ref.adapter && worker.id === ref.id);
    if (own?.releasedAt) return false;
    if (own?.claimedBy !== todoId && this.liveTodo(own?.claimedBy ?? null)) return false;
    const holders = todoId ? LIVE_TODO_STATES : [...LIVE_TODO_STATES, 'done', 'removed'];
    if (this.doingTodoOn(ref, null, holders)) return false;
    if (!todoId) return true;
    if (!this.liveTodo(todoId)) return false;
    if (workers.some((worker) => worker.claimedBy === todoId && worker !== own)) return false;
    recordStartedWork(this.db, ref, Date.now(), false, false, { todoId });
    return true;
  }

  unclaimWorker(todoId: string, ref: WorkRef): void {
    if (this.startedFacts(ref)?.claimedBy === todoId)
      recordStartedWork(this.db, ref, Date.now(), false, false, { todoId: null });
  }

  private startedFacts(ref: WorkRef) {
    return readStartedWork(this.db).find(
      (worker) => worker.adapter === ref.adapter && worker.id === ref.id
    );
  }

  private liveTodo(todoId: string | null): boolean {
    const todo = todoId ? new NeoAskTodoRepository(this.db).getTodo(todoId) : null;
    return !!todo && LIVE_TODO_STATES.includes(todo.state);
  }

  recordReleased(todoId: string, released: unknown): void {
    this.writeCoreFact(todoId, 'released', released);
  }

  awaitingReports(): { todoId: string; ref: WorkRef }[] {
    return (
      this.db
        .prepare(
          `SELECT s.todo_id AS todoId, s.ref FROM neo_todo_sessions s
             JOIN neo_todos t ON t.id = s.todo_id
             JOIN neo_asks a ON a.id = t.ask_id
            WHERE s.ref IS NOT NULL AND a.status = 'open'`
        )
        .all() as { todoId: string; ref: string }[]
    ).map((row) => ({ todoId: row.todoId, ref: JSON.parse(row.ref) as WorkRef }));
  }
}

export const neoTodoSessionReads = defineRepositoryOp(
  'neo.todoSessionReads',
  'read',
  NeoTodoSessionRepository,
  [
    'unrecordedStarts',
    'awaitingReports',
    'nudgeContext',
    'stopContext',
    'queueFacts',
    'neoStepFacts',
    'workerName',
    'syncedActivity',
    'syncedLive',
    'finishedWorkers',
  ]
);
export const neoTodoSessionWrites = defineRepositoryOp(
  'neo.todoSessionWrites',
  'write',
  NeoTodoSessionRepository,
  [
    'recordLive',
    'recordFollowAnchor',
    'recordDispatch',
    'recordIdentity',
    'recordProgress',
    'claimNeedsYou',
    'stageTurnQuestion',
    'claimNudge',
    'finishNudge',
    'noteWorkerStatus',
    'markWorkerUnusable',
    'queueOn',
    'fenceRelease',
    'claimWorker',
    'unclaimWorker',
    'recordReleased',
  ]
);
