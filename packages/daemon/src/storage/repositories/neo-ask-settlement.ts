import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import { requireNeoOpenAsk } from '../../lib/neo/todo-operations.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

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
