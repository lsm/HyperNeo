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

const settleReadyAsks = (db: Database): string[] =>
  (
    db
      .prepare(`SELECT id FROM neo_asks WHERE status = 'open'
    AND EXISTS (SELECT 1 FROM neo_todos t WHERE t.ask_id = neo_asks.id)
    AND NOT EXISTS (SELECT 1 FROM neo_todos t WHERE t.ask_id = neo_asks.id
      AND t.state IN ('todo', 'doing', 'blocked'))
    AND NOT EXISTS (SELECT 1 FROM neo_questions q WHERE q.ask_id = neo_asks.id AND q.state = 'open')
    AND NOT EXISTS (SELECT 1 FROM neo_asks child WHERE child.parent_id = neo_asks.id
      AND child.status = 'open')
    AND EXISTS (
      SELECT 1 FROM sdk_messages m WHERE m.session_id = neo_asks.session_id
        AND m.message_type = 'user' AND m.consumed_seq IS NOT NULL
        AND (m.sdk_uuid LIKE ? || neo_asks.id || ':%'
          OR m.sdk_uuid IN (SELECT json_extract(j.payload, '$.neoBatchUuid')
            FROM job_queue j WHERE j.queue = 'neo_notes' AND j.status = 'completed'
            AND json_extract(j.payload, '$.to.sessionId') = neo_asks.session_id
            AND json_extract(j.payload, '$.messageUuid') LIKE ? || neo_asks.id || ':%'))
        AND EXISTS (SELECT 1 FROM sdk_messages r WHERE r.session_id = m.session_id
          AND ${SESSION_BILLING_TERMINAL}
          AND r.consumed_seq >= m.consumed_seq
          AND r.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', neo_asks.updated_at / 1000.0,
            'unixepoch')))
    AND NOT EXISTS (
      SELECT 1 FROM sdk_messages p WHERE p.session_id = neo_asks.session_id
        AND p.consumed_seq IS NOT NULL AND ${CONSUMED_INPUT}
        AND NOT EXISTS (SELECT 1 FROM sdk_messages r2 WHERE r2.session_id = p.session_id
          AND ${SESSION_BILLING_TERMINAL}
          AND r2.consumed_seq >= p.consumed_seq))`)
      .all(WAKE_NOTE_PREFIX, WAKE_NOTE_PREFIX) as { id: string }[]
  ).map((row) => row.id);

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

export const neoAskTurnedSettleWrites = defineDbOp<{ now: number }, string[]>({
  name: 'neo.turnedAskSettles',
  mode: 'write',
  run(db, { now }, changes) {
    const store = new NeoAskTodoRepository(db, undefined, undefined, undefined, changes);
    const settled: string[] = [];
    for (const id of settleReadyAsks(db)) {
      const outcome = turnedSettle(store, id, now, changes);
      if (typeof outcome === 'string') settled.push(outcome);
    }
    return settled;
  },
});
