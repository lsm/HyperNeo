import superpipe, { type PipelineAPI } from 'superpipe';
import type { z } from 'zod';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoTodoPolicies } from '../../lib/neo/packs/todo-policies.ts';
import { type NeoTodoDraftSchema, planNeoTodoDraft } from '../../lib/neo/todo-operations.ts';
import { neoTodoRepository } from '../../lib/neo/pack-contract.ts';
import {
  neoTodoDependencyRefusal,
  planNeoTodoDependencies,
} from '../../lib/neo/todo-dependencies.ts';
import { planNeoTodoAwaitingStart } from '../../lib/neo/todo-runner.ts';
import { ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

type Input = {
  askId: string;
  todoId: string;
  draft: z.infer<typeof NeoTodoDraftSchema>;
  now: number;
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
      const peers = store.listTodos(ask.id);
      const repo = neoTodoRepository(input.draft, policies, { ask });
      const accepted = planNeoTodoDraft(input.draft, policies, peers);
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
      const dependsOn = planNeoTodoDependencies(
        store.listFamilyTodos(plan.ask.id),
        input.todoId,
        plan.draft.after.map(String)
      );
      return typeof dependsOn === 'string'
        ? { reason: { ok: false, reason: neoTodoDependencyRefusal(dependsOn) } }
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
      let todo = store.addTodo(
        input.todoId,
        plan.ask.id,
        { ...draft, dependsOn: plan.dependsOn },
        input.now,
        plan.repo
      );
      if (draft.target) new NeoTodoSessionRepository(db).create(todo.id, draft.target);
      if (!draft.start && todo.instruction) {
        store.joinStartQuestion(todo, input.now);
        changes.notifyChange('neo_questions');
        const blocked = planNeoTodoAwaitingStart(todo);
        if (blocked) todo = store.updateTodo(todo, blocked, input.now);
      }
      if (draft.target) changes.notifyChange('neo_todo_sessions');
      return {
        ok: true,
        todo,
        ...(draft.start ? { start: todo.id } : {}),
        ...(draft.records ? { records: draft.records } : {}),
      };
    },
    ['db', 'store', 'input', 'outcome', 'changes'],
    'outcome'
  )
  .end('outcome') as (db: Database, input: Input, changes: ChangeRecorder) => Receipt;

export const neoTodoAddWrites = defineDbOp({ name: 'neo.todoAddWrites', mode: 'write', run: add });
