import { recordWorkerBlocker } from '../../lib/neo/worker-blocker.ts';
import type { WorkRef } from '../../lib/drivers/types.ts';
import { recoverNeoTodoStart } from './neo-todo-start-recovery.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoDriverTarget } from '../../lib/neo/driver-work.ts';
import type { NeoTodoJudgement } from '../../lib/neo/pack-contract.ts';
import { requireNeoTodoStartable } from '../../lib/neo/todo-runner.ts';
import { neoTodoStartRefusal } from '../../lib/neo/todo-start-gate.ts';
import { neoPlanRefusal, neoRecordedPlanFacts } from '../../lib/neo/todo-follow-up.ts';
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
  .input(['store', 'id', 'check', 'change', 'now', 'judgement', 'packPlan'])
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
      todo: NeoTodo | null,
      id: string,
      change: NeoTodoPatch,
      now: number,
      judgement: NeoTodoJudgement,
      packPlan = false
    ) => {
      const reason =
        todo && (todo.plan || packPlan) && (change.state === 'done' || judgement.state === 'done')
          ? neoPlanRefusal(
              neoRecordedPlanFacts(
                todo,
                store.listFamilyTodos(todo.askId),
                store.listQuestions(todo.askId),
                packPlan
              )
            )
          : null;
      return reason
        ? store.commitState(
            id,
            { state: 'blocked', blockedBy: 'check', blockedReason: reason, nextAction: reason },
            now,
            { state: 'no_opinion' }
          )
        : store.commitState(id, change, now, judgement);
    },
    ['store', 'outcome', 'id', 'change', 'now', 'judgement', 'packPlan'],
    'outcome'
  )
  .end('outcome') as (
  store: NeoAskTodoRepository,
  id: string,
  check: NeoTodo['check'],
  change: NeoTodoPatch,
  now: number,
  judgement: NeoTodoJudgement,
  packPlan?: boolean
) => State;

const claim = (superpipe({})('neo.todo.claim-start-state') as PipelineAPI)
  .input(['store', 'sessions', 'id', 'now', 'trackerHold'])
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
    (store: NeoAskTodoRepository, plan: Start, trackerHold: string | null) => {
      const reason = neoTodoStartRefusal(
        plan.todo,
        store.listFamilyTodos(plan.ask.id),
        store.gateQuestions(plan.ask),
        trackerHold
      );
      return reason ? { reason: { ok: false as const, reason } } : { value: plan };
    },
    ['store', 'outcome', 'trackerHold'],
    'result:outcome'
  )
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
  .pipe((plan: Start) => ({ ok: true as const, ...plan }), 'outcome', 'outcome')
  .end('outcome') as (
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  id: string,
  now: number,
  trackerHold: string | null
) => Claim;

class NeoTodoRunnerState {
  private readonly store: NeoAskTodoRepository;
  private readonly sessions: NeoTodoSessionRepository;
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
  }
  recompute(
    id: string,
    check: NeoTodo['check'],
    change: NeoTodoPatch,
    now: number,
    judgement: NeoTodoJudgement,
    packPlan = false
  ) {
    return {
      ...recompute(this.store, id, check, change, now, judgement, packPlan),
      changed: this.changed,
    };
  }
  claim(id: string, now: number, trackerHold: string | null = null) {
    return { ...claim(this.store, this.sessions, id, now, trackerHold), changed: this.changed };
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
  ['recompute', 'claim', 'recover', 'blocker']
);
