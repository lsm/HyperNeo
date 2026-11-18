import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { z } from 'zod';
import { neoEvidencePathRefusal } from '../../lib/neo/core-todo-checks.ts';
import { getDataDir } from '../../lib/data-dir.ts';
import { neoTodoRepository } from '../../lib/neo/pack-contract.ts';
import { neoTodoPolicies } from '../../lib/neo/packs/todo-policies.ts';
import {
  neoTodoAfterRefusal,
  neoTodoDependencyRefusal,
  planNeoTodoDependencies,
} from '../../lib/neo/todo-dependencies.ts';
import {
  type NeoTodoDraftSchema,
  neoTodoBindRefusal,
  neoTodoPlaceRefusal,
  planNeoTodoDraft,
  recordNeoTodoTarget,
} from '../../lib/neo/todo-operations.ts';
import { type ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

type Input = {
  askId: string;
  todoId: string;
  draft: z.infer<typeof NeoTodoDraftSchema> & { workerRemotes?: readonly string[] };
  now: number;
  userFolder?: string;
};
type Receipt =
  | { ok: false; reason: string }
  | { ok: true; todo?: NeoTodo; start?: string; records?: string[] };
type Plan = {
  ask: NeoAsk;
  repo: string | null;
  draft: Input['draft'] & { doneWhen: string; records?: string[] };
  dependsOn: string[];
};

const add = (superpipe({})('neo.todo.commit-add') as PipelineAPI)
  .input(['db', 'input', 'changes'])
  .pipe(
    (db: Database, changes: ChangeRecorder) =>
      new NeoAskTodoRepository(
        db,
        () => {
          changes.notifyChange('neo_asks');
          changes.notifyChange('neo_todos');
        },
        undefined,
        () => changes.notifyChange('neo_questions'),
        changes
      ),
    ['db', 'changes'],
    'store'
  )
  .pipe(
    (
      db: Database,
      store: NeoAskTodoRepository,
      input: Input
    ): { value: Plan } | { reason: Receipt } => {
      const ask = store.getAsk(input.askId);
      if (!ask) return { reason: { ok: false, reason: 'not_found: no such ask.' } };
      if (ask.status !== 'open')
        return {
          reason: {
            ok: true,
            records: [`ask_settled: this ask is ${ask.status}; no change was made.`],
          },
        };
      const policies = neoTodoPolicies(db);
      const planned = planNeoTodoDraft(input.draft, policies);
      if ('reason' in planned) return planned;
      const draft = planned.value;
      const scope = { ask, workerRemotes: input.draft.workerRemotes };
      const repo = neoTodoRepository(draft, policies, scope);
      const placeless = neoTodoPlaceRefusal(draft, policies, scope);
      if (placeless) return { reason: { ok: false, reason: placeless } };
      const misplaced = neoEvidencePathRefusal(input.draft.check, null, getDataDir());
      if (misplaced) return { reason: { ok: false, reason: misplaced } };
      const peers = store.listTodos(ask.id);
      const accepted = planNeoTodoDraft(draft, policies, peers);
      return 'reason' in accepted
        ? accepted
        : { value: { ask, repo, draft: accepted.value, dependsOn: [] } };
    },
    ['db', 'store', 'input'],
    'result:outcome'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      input: Input,
      plan: Plan
    ): { value: Plan } | { reason: Receipt } => {
      const family = store.listFamilyTodos(plan.ask.id);
      const refused = neoTodoAfterRefusal(family, null, plan.draft.after);
      if (refused) return { reason: { ok: false, reason: refused } };
      const dependsOn = planNeoTodoDependencies(family, input.todoId, plan.draft.after.map(String));
      if (typeof dependsOn === 'string')
        return { reason: { ok: false, reason: neoTodoDependencyRefusal(dependsOn) } };
      const unfinished = neoTodoBindRefusal(plan.draft.target, family, dependsOn);
      return unfinished
        ? { reason: { ok: false, reason: unfinished } }
        : { value: { ...plan, dependsOn } };
    },
    ['store', 'input', 'outcome'],
    'result:outcome'
  )
  .pipe(
    (
      db: Database,
      store: NeoAskTodoRepository,
      input: Input,
      plan: Plan,
      changes: ChangeRecorder
    ): Receipt => {
      const { draft } = plan;
      const inserted = store.addTodo(
        input.todoId,
        plan.ask.id,
        { ...draft, dependsOn: plan.dependsOn, approvedAt: input.now },
        input.now,
        plan.repo
      );
      const sessions = new NeoTodoSessionRepository(db);
      const todo = draft.target
        ? recordNeoTodoTarget(store, sessions, inserted, draft.target, input.now)
        : inserted;
      if (draft.target) changes.notifyChange('neo_todo_sessions');
      return {
        ok: true,
        todo,
        ...(todo.instruction ? { start: todo.id } : {}),
        ...(draft.records ? { records: draft.records } : {}),
      };
    },
    ['db', 'store', 'input', 'outcome', 'changes'],
    'outcome'
  )
  .end('outcome') as (db: Database, input: Input, changes: ChangeRecorder) => Receipt;

export const neoTodoAddWrites = defineDbOp({ name: 'neo.todoAddWrites', mode: 'write', run: add });
