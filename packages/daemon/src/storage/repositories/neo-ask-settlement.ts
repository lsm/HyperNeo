import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import { requireNeoOpenAsk } from '../../lib/neo/todo-operations.ts';
import { neoSplitOutcome } from '../../lib/neo/todo-repo.ts';
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
  records?: string[];
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

const settle = (superpipe({})('neo.ask.commit-settlement') as PipelineAPI)
  .input(['store', 'sessions', 'input', 'now', 'changes'])
  .pipe(
    (store: NeoAskTodoRepository, input: Input) => requireNeoOpenAsk(store.getAsk(input.askId)),
    ['store', 'input'],
    'result:outcome'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      currentAsk: NeoAsk,
      input: Input,
      now: number,
      changes: Changes
    ): Receipt => {
      const before = store.listTodos(currentAsk.id);
      const unfinished =
        input.status === 'done'
          ? before.filter(
              (todo) =>
                !['done', 'closed_unverified'].includes(todo.state) &&
                !(todo.state === 'removed' && todo.reason)
            )
          : [];
      const questionOpen = store
        .listQuestions(currentAsk.id)
        .some((question) => question.state === 'open');
      const ask = store.settleAsk(
        currentAsk,
        input.status,
        input.outcome,
        now,
        unfinished.map((todo) => todo.id)
      );
      const todos = store.listTodos(ask.id);
      changes?.notifyChange('neo_asks');
      if (
        unfinished.length ||
        before.some((todo) => ['todo', 'doing', 'blocked'].includes(todo.state))
      )
        changes?.notifyChange('neo_todos');
      if (questionOpen) changes?.notifyChange('neo_questions');
      return {
        ok: true,
        ask,
        todos,
        refs: todos.map((todo) => ({ todoId: todo.id, ref: sessions.readRef(todo.id) })),
        ...(unfinished.length
          ? {
              records: [
                `todos_unfinished: closed unverified: ${unfinished.map((todo) => `${todo.title} (${todo.id}): ${todo.doneWhen}`).join('; ')}`,
              ],
            }
          : {}),
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

const splitParent = (superpipe({})('neo.ask.commit-split-parent') as PipelineAPI)
  .input(['store', 'sessions', 'id', 'now', 'changes'])
  .pipe(
    (store: NeoAskTodoRepository, id: string): { value: Input } | { reason: null } => {
      const parent = store.getAsk(id);
      const children = store.listChildAsks(id);
      return parent?.status === 'open' && children.length && !store.listTodos(id).length
        ? {
            value: {
              askId: id,
              status: 'done',
              outcome: neoSplitOutcome(
                children,
                children.reduce((count, child) => count + store.listTodos(child.id).length, 0)
              ),
            },
          }
        : { reason: null };
    },
    ['store', 'id'],
    'result:outcome'
  )
  .pipe(settle, ['store', 'sessions', 'outcome', 'now', 'changes'], 'outcome')
  .end('outcome') as (
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  id: string,
  now: number,
  changes: Changes
) => Receipt | Rejection | null;

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
  splitParent(id: string, now: number) {
    return splitParent(this.store, this.sessions, id, now, this.changes);
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
  ['settle', 'splitParent']
);
