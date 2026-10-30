import { escalateWorkerBlocker, recordWorkerBlocker } from '../../lib/neo/worker-blocker.ts';
import type { WorkRef } from '../../lib/drivers/types.ts';
import { recoverNeoTodoStart } from './neo-todo-start-recovery.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoDriverTarget } from '../../lib/neo/driver-work.ts';
import type { NeoTodoJudgement } from '../../lib/neo/pack-contract.ts';
import type { NeoTodoPolicy } from '../../lib/neo/todo-operations.ts';
import { neoTodoPolicies } from '../../lib/neo/packs/todo-policies.ts';
import { neoMoveTodo, neoTodoRepo } from '../../lib/neo/todo-repo.ts';
import { requireNeoTodoStartable } from '../../lib/neo/todo-runner.ts';
import { sameNeoTodoCheck } from '../../lib/neo/todo-completion.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { NeoAskTodoRepository, type NeoTodoPatch } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

type State = { todo: NeoTodo | null; startNext: string | null; records?: string[] };
type Start = {
  todo: NeoTodo;
  ask: NeoAsk;
  target: Extract<NeoDriverTarget, { verb: 'start' | 'send' }>;
};
type Claim =
  | { ok: false; reason: string }
  | ({ ok: true; todo: NeoTodo; records?: string[] } & Partial<Start>);

const recompute = (superpipe({})('neo.todo.runner-state') as PipelineAPI)
  .input(['store', 'id', 'check', 'change', 'now', 'judgement'])
  .pipe((store: NeoAskTodoRepository, id: string) => store.getTodo(id), ['store', 'id'], 'current')
  .pipe(
    (todo: NeoTodo | null, check: NeoTodo['check'], judgement: NeoTodoJudgement) =>
      todo && judgement.state !== 'no_opinion' && !sameNeoTodoCheck({ ...todo, check }, todo)
        ? {
            reason: {
              todo,
              startNext: null,
              records: ['todo_changed: completion check changed; no state was changed.'],
            },
          }
        : { value: todo },
    ['current', 'check', 'judgement'],
    'result:outcome'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      id: string,
      change: NeoTodoPatch,
      now: number,
      judgement: NeoTodoJudgement
    ) => store.commitState(id, change, now, judgement),
    ['store', 'id', 'change', 'now', 'judgement'],
    'outcome'
  )
  .end('outcome') as (
  store: NeoAskTodoRepository,
  id: string,
  check: NeoTodo['check'],
  change: NeoTodoPatch,
  now: number,
  judgement: NeoTodoJudgement
) => State;

const claim = (superpipe({})('neo.todo.claim-start-state') as PipelineAPI)
  .input(['store', 'sessions', 'policies', 'id', 'now'])
  .pipe(
    (store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository, id: string) => {
      const todo = store.getTodo(id);
      return { todo, ask: todo ? store.getAsk(todo.askId) : null, target: sessions.get(id) };
    },
    ['store', 'sessions', 'id'],
    'facts'
  )
  .pipe(requireNeoTodoStartable, 'facts', 'result:outcome')
  .pipe(
    (store: NeoAskTodoRepository, plan: Start, now: number) => {
      const todo = store.claimStart(plan.todo, now);
      return todo
        ? { value: { ...plan, todo } }
        : { reason: { ok: false as const, reason: 'already_started: this todo started.' } };
    },
    ['store', 'outcome', 'now'],
    'result:outcome'
  )
  .pipe(
    (store: NeoAskTodoRepository, plan: Start, policies: readonly NeoTodoPolicy[]) => {
      const repo = neoTodoRepo({ ...plan.todo, target: plan.target }, policies, plan.todo);
      const todo = neoMoveTodo(store, plan.todo, repo) ?? plan.todo;
      return {
        ok: true as const,
        todo,
        ask: store.getAsk(todo.askId) ?? plan.ask,
        target: plan.target,
      };
    },
    ['store', 'outcome', 'policies'],
    'outcome'
  )
  .end('outcome') as (
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  policies: readonly NeoTodoPolicy[],
  id: string,
  now: number
) => Claim;

class NeoTodoRunnerState {
  private readonly store: NeoAskTodoRepository;
  private readonly sessions: NeoTodoSessionRepository;
  private readonly policies: readonly NeoTodoPolicy[];
  private changed = false;
  constructor(
    db: Database,
    private readonly changes?: Pick<ReactiveDatabase, 'notifyChange'>
  ) {
    const notify = (table: string) => {
      this.changed = true;
      changes?.notifyChange(table);
    };
    this.store = new NeoAskTodoRepository(
      db,
      () => {
        notify('neo_todos');
        notify('neo_asks');
      },
      undefined,
      () => notify('neo_questions'),
      changes
    );
    this.sessions = new NeoTodoSessionRepository(db, changes);
    this.policies = neoTodoPolicies(db);
  }
  recompute(
    id: string,
    check: NeoTodo['check'],
    change: NeoTodoPatch,
    now: number,
    judgement: NeoTodoJudgement
  ) {
    return { ...recompute(this.store, id, check, change, now, judgement), changed: this.changed };
  }
  claim(id: string, now: number) {
    return { ...claim(this.store, this.sessions, this.policies, id, now), changed: this.changed };
  }
  blocker(
    todo: NeoTodo,
    ref: WorkRef,
    dispatchId: string,
    turn: { id: string; at: number; message: string },
    now: number
  ) {
    const result = recordWorkerBlocker(this.store, this.sessions, todo, ref, dispatchId, turn, now);
    return { todo: result, changed: this.changed };
  }
  escalate(id: string, now: number) {
    return escalateWorkerBlocker(this.store, this.sessions, id, now);
  }
  recover(id: string, now: number) {
    const recovery = recoverNeoTodoStart(this.store, this.sessions, id, now);
    if (recovery) this.changes?.notifyChange('neo_todo_sessions');
    return { recovery, changed: this.changed };
  }
}

export const neoTodoRunnerWrites = defineRepositoryOp(
  'neo.todoRunnerWrites',
  'write',
  NeoTodoRunnerState,
  ['recompute', 'claim', 'recover', 'blocker', 'escalate']
);
