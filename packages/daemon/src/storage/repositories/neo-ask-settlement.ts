import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import { requireNeoOpenAsk } from '../../lib/neo/todo-operations.ts';
import { defineDbOp, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';
import { SESSION_BILLING_TERMINAL, CONSUMED_INPUT } from './sdk-message-input-predicates.ts';

type Input = { askId: string; status: 'done' | 'dropped'; outcome: string };
type Snapshot = { ask: NeoAsk; todos: NeoTodo[] };
type Rejection = { ok: false; reason: string };
type Receipt = {
  ok: true;
  refs: { todoId: string; ref: WorkRef | null }[];
} & Snapshot;
type Changes = Pick<ReactiveDatabase, 'notifyChange'> | undefined;

const snapshot = (superpipe({})('neo.ask.settlement-snapshot') as PipelineAPI)
  .input(['store', 'id'])
  .pipe(
    (store: NeoAskTodoRepository, id: string) => requireNeoOpenAsk(store.getAsk(id)),
    ['store', 'id'],
    'result:outcome'
  )
  .pipe(
    (store: NeoAskTodoRepository, ask: NeoAsk) => ({ ask, todos: store.listTodos(ask.id) }),
    ['store', 'outcome'],
    'outcome'
  )
  .end('outcome') as (store: NeoAskTodoRepository, id: string) => Snapshot | Rejection;

export function requireNeoAskSettlement(
  current: Snapshot | Rejection,
  input: Input
): { value: Snapshot } | { reason: Rejection } {
  if ('ok' in current) return { reason: current };
  const unfinished =
    input.status === 'done'
      ? current.todos.filter(
          (todo) =>
            !['done', 'closed_unverified'].includes(todo.state) &&
            !(todo.state === 'removed' && todo.reason)
        )
      : [];
  return unfinished.length
    ? {
        reason: {
          ok: false,
          reason: `todos_unfinished: ${unfinished.map((todo) => `${todo.title} (${todo.id}): ${todo.doneWhen}`).join('; ')}. Finish these todos, remove them with reasons, or settle dropped.`,
        },
      }
    : { value: current };
}

const settle = (superpipe({})('neo.ask.commit-settlement') as PipelineAPI)
  .input(['store', 'sessions', 'input', 'now', 'changes'])
  .pipe(
    (store: NeoAskTodoRepository, input: Input) =>
      requireNeoAskSettlement(snapshot(store, input.askId), input),
    ['store', 'input'],
    'result:outcome'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      current: Snapshot,
      input: Input,
      now: number,
      changes: Changes
    ): Receipt => {
      const before = current.todos;
      const questionOpen = store
        .listQuestions(current.ask.id)
        .some((question) => question.state === 'open');
      const ask = store.settleAsk(current.ask, input.status, input.outcome, now);
      const todos = store.listTodos(ask.id);
      changes?.notifyChange('neo_asks');
      if (before.some((todo) => ['todo', 'doing', 'blocked'].includes(todo.state)))
        changes?.notifyChange('neo_todos');
      if (questionOpen) changes?.notifyChange('neo_questions');
      return {
        ok: true,
        ask,
        todos,
        refs: todos.map((todo) => ({ todoId: todo.id, ref: sessions.readRef(todo.id) })),
      };
    },
    ['store', 'sessions', 'outcome', 'input', 'now', 'changes'],
    'outcome'
  )
  .end('outcome') as (
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  input: Input,
  now: number,
  changes: Changes
) => Receipt | Rejection;

class NeoAskSettlement {
  private readonly store: NeoAskTodoRepository;
  private readonly sessions: NeoTodoSessionRepository;
  constructor(
    db: Database,
    private readonly changes: Changes = undefined
  ) {
    this.store = new NeoAskTodoRepository(db, undefined, undefined, undefined, changes);
    this.sessions = new NeoTodoSessionRepository(db, changes);
  }
  snapshot(id: string) {
    return snapshot(this.store, id);
  }
  settle(input: Input, now: number) {
    return settle(this.store, this.sessions, input, now, this.changes);
  }
}

export const neoAskSettlementReads = defineRepositoryOp(
  'neo.askSettlementReads',
  'read',
  NeoAskSettlement,
  ['snapshot']
);
export const neoAskSettlementWrites = defineRepositoryOp(
  'neo.askSettlementWrites',
  'write',
  NeoAskSettlement,
  ['settle']
);

const WAKE_NOTE_PREFIX = 'neo-stalled-ask:';
const MAX_IN_LIST = 500;

type SessionFacts = {
  maxConsumedInput: number | null;
  lastTerminal: { seq: number; timestamp: string } | null;
  batchUuidsByAsk: Map<string, Set<string>>;
};

const latestConsumedSeq = (db: Database, sessionId: string, predicate: string): number | null =>
  (
    db
      .prepare(`SELECT consumed_seq AS seq FROM sdk_messages
        WHERE session_id = ? AND consumed_seq IS NOT NULL AND ${predicate}
        ORDER BY consumed_seq DESC LIMIT 1`)
      .get(sessionId) as { seq: number } | undefined
  )?.seq ?? null;

const wakeTurnSeqs = (
  db: Database,
  sessionId: string,
  askId: string,
  batchUuids: Set<string> | undefined
): number[] => {
  const seqs: number[] = [];
  const direct = db.prepare(`SELECT consumed_seq AS seq FROM sdk_messages
    WHERE session_id = ? AND message_type = 'user' AND consumed_seq IS NOT NULL
      AND sdk_uuid >= ? AND sdk_uuid < ?`);
  for (const row of direct.iterate(
    sessionId,
    `${WAKE_NOTE_PREFIX}${askId}:`,
    `${WAKE_NOTE_PREFIX}${askId};`
  ) as Iterable<{ seq: number }>)
    seqs.push(row.seq);
  const uuidList = [...(batchUuids ?? [])];
  for (let at = 0; at < uuidList.length; at += MAX_IN_LIST) {
    const chunk = uuidList.slice(at, at + MAX_IN_LIST);
    const marks = chunk.map(() => '?').join(',');
    const batch = db.prepare(`SELECT consumed_seq AS seq FROM sdk_messages
      WHERE session_id = ? AND message_type = 'user' AND consumed_seq IS NOT NULL
        AND sdk_uuid IN (${marks})`);
    for (const row of batch.iterate(sessionId, ...chunk) as Iterable<{ seq: number }>)
      seqs.push(row.seq);
  }
  return seqs;
};

const wakeTurnEnded = (
  db: Database,
  sessionId: string,
  terminal: { seq: number; timestamp: string } | null,
  wakeSeqs: number[],
  askUpdatedAt: number
): boolean => {
  if (!terminal) return false;
  const since = new Date(askUpdatedAt).toISOString();
  if (terminal.timestamp >= since) return wakeSeqs.some((seq) => seq <= terminal.seq);
  const ended =
    db.prepare(`SELECT 1 AS ended FROM sdk_messages INDEXED BY idx_sdk_messages_session_consumed
    WHERE session_id = ? AND ${SESSION_BILLING_TERMINAL}
      AND consumed_seq >= ? AND timestamp >= ? LIMIT 1`);
  return wakeSeqs.some((seq) => seq <= terminal.seq && ended.get(sessionId, seq, since) != null);
};

const sessionFacts = (
  db: Database,
  sessionId: string,
  batchesBySession: Map<string, Map<string, Set<string>>>
): SessionFacts => ({
  maxConsumedInput: latestConsumedSeq(db, sessionId, CONSUMED_INPUT),
  lastTerminal: db
    .prepare(`SELECT consumed_seq AS seq, timestamp FROM sdk_messages
      WHERE session_id = ? AND consumed_seq IS NOT NULL AND ${SESSION_BILLING_TERMINAL}
      ORDER BY consumed_seq DESC LIMIT 1`)
    .get(sessionId) as { seq: number; timestamp: string } | null,
  batchUuidsByAsk: batchesBySession.get(sessionId) ?? new Map(),
});

const wakeBatchesBySession = (db: Database): Map<string, Map<string, Set<string>>> => {
  const batches = new Map<string, Map<string, Set<string>>>();
  for (const row of db
    .prepare(`SELECT json_extract(payload, '$.to.sessionId') AS session_id,
      json_extract(payload, '$.messageUuid') AS message_uuid,
      json_extract(payload, '$.neoBatchUuid') AS batch_uuid
      FROM job_queue WHERE queue = 'neo_notes' AND status = 'completed'`)
    .iterate() as Iterable<{
    session_id: string | null;
    message_uuid: string | null;
    batch_uuid: string | null;
  }>) {
    if (!row.session_id || !row.message_uuid || !row.batch_uuid) continue;
    if (!row.message_uuid.startsWith(WAKE_NOTE_PREFIX)) continue;
    const askId = row.message_uuid.slice(WAKE_NOTE_PREFIX.length).split(':')[0]!;
    let byAsk = batches.get(row.session_id);
    if (!byAsk) batches.set(row.session_id, (byAsk = new Map()));
    let uuids = byAsk.get(askId);
    if (!uuids) byAsk.set(askId, (uuids = new Set()));
    uuids.add(row.batch_uuid);
  }
  return batches;
};

const settleReadyAsks = (db: Database): string[] => {
  const candidates = db
    .prepare(`SELECT id, session_id, updated_at FROM neo_asks WHERE status = 'open'
      AND EXISTS (SELECT 1 FROM neo_todos t WHERE t.ask_id = neo_asks.id)
      AND NOT EXISTS (SELECT 1 FROM neo_todos t WHERE t.ask_id = neo_asks.id
        AND t.state IN ('todo', 'doing', 'blocked'))
      AND NOT EXISTS (SELECT 1 FROM neo_questions q WHERE q.ask_id = neo_asks.id AND q.state = 'open')
      AND NOT EXISTS (SELECT 1 FROM neo_asks child WHERE child.parent_id = neo_asks.id
        AND child.status = 'open')`)
    .all() as { id: string; session_id: string; updated_at: number }[];
  if (!candidates.length) return [];
  const batches = wakeBatchesBySession(db);
  const facts = new Map<string, SessionFacts>();
  const ready: string[] = [];
  for (const ask of candidates) {
    let fact = facts.get(ask.session_id);
    if (!fact) facts.set(ask.session_id, (fact = sessionFacts(db, ask.session_id, batches)));
    if (
      fact.maxConsumedInput !== null &&
      (fact.lastTerminal === null || fact.lastTerminal.seq < fact.maxConsumedInput)
    )
      continue;
    const wakeSeqs = wakeTurnSeqs(db, ask.session_id, ask.id, fact.batchUuidsByAsk.get(ask.id));
    if (wakeTurnEnded(db, ask.session_id, fact.lastTerminal, wakeSeqs, ask.updated_at))
      ready.push(ask.id);
  }
  return ready;
};

const settleOutcomeSentence = (todos: readonly NeoTodo[]): string => {
  const names = (states: readonly string[]) =>
    todos
      .filter((todo) => states.includes(todo.state))
      .map((todo) => todo.title)
      .join(', ');
  const finished = names(['done', 'closed_unverified']);
  const dropped = names(['removed', 'failed']);
  const sentence = [
    ...(finished ? [`Finished ${finished}`] : []),
    ...(dropped ? [`cancelled or removed ${dropped}`] : []),
  ].join('; ');
  return sentence ? `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.` : 'No steps recorded.';
};

type TurnedSnapshot = Snapshot & { questions: NeoQuestion[]; children: NeoAsk[] };

export function requireNeoAskTurnedSettle(
  current: TurnedSnapshot | Rejection
): { value: TurnedSnapshot } | { reason: Rejection } {
  if ('ok' in current) return { reason: current };
  if (!current.todos.length) return { reason: { ok: false, reason: 'todos_empty' } };
  if (current.todos.some((todo) => ['todo', 'doing', 'blocked'].includes(todo.state)))
    return { reason: { ok: false, reason: 'todos_live' } };
  if (current.questions.some((card) => card.state === 'open'))
    return { reason: { ok: false, reason: 'card_open' } };
  if (current.children.some((child) => child.status === 'open'))
    return { reason: { ok: false, reason: 'child_open' } };
  return { value: current };
}

const turnedSettle = (superpipe({})('neo.ask.turned-settle') as PipelineAPI)
  .input(['store', 'id', 'now', 'changes'])
  .pipe(
    (store: NeoAskTodoRepository, id: string) => {
      const current = snapshot(store, id);
      return 'ok' in current
        ? current
        : requireNeoAskTurnedSettle({
            ...current,
            questions: store.listQuestions(id),
            children: store.listChildAsks(id),
          });
    },
    ['store', 'id'],
    'result:outcome'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      current: TurnedSnapshot,
      now: number,
      changes: Changes
    ): string => {
      const status = current.todos.some((todo) =>
        ['done', 'closed_unverified'].includes(todo.state)
      )
        ? 'done'
        : 'dropped';
      const ask = store.settleAsk(
        current.ask,
        status,
        current.ask.outcome ?? settleOutcomeSentence(current.todos),
        now
      );
      changes?.notifyChange('neo_asks');
      return ask.id;
    },
    ['store', 'outcome', 'now', 'changes'],
    'outcome'
  )
  .end('outcome') as (
  store: NeoAskTodoRepository,
  id: string,
  now: number,
  changes: Changes
) => string | Rejection;

export const neoAskTurnedSettleReads = defineDbOp<Record<string, never>, string[]>({
  name: 'neo.turnedAskSettleReads',
  mode: 'read',
  run(db) {
    return settleReadyAsks(db);
  },
});

export const neoAskTurnedSettleWrites = defineDbOp<{ now: number; ids: string[] }, string[]>({
  name: 'neo.turnedAskSettles',
  mode: 'write',
  run(db, { now, ids }, changes) {
    const ready = new Set(settleReadyAsks(db));
    const store = new NeoAskTodoRepository(db, undefined, undefined, undefined, changes);
    const settled: string[] = [];
    for (const id of ids) {
      if (!ready.has(id)) continue;
      const outcome = turnedSettle(store, id, now, changes);
      if (typeof outcome === 'string') settled.push(outcome);
    }
    return settled;
  },
});
