import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { NeoTodoCheckResult } from '../../lib/neo/pack-contract.ts';
import { requireNeoTodoMayFinish, sameNeoTodoCheck } from '../../lib/neo/todo-completion.ts';
import { ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository, type NeoTodoPatch } from './neo-ask-todo-repository.ts';
import { neoTodoMutationReads } from './neo-todo-mutation-planning.ts';

type Planner = InstanceType<typeof neoTodoMutationReads.Repository>;
type Plan = { todo: NeoTodo; patch: NeoTodoPatch; records?: string[] };
type Input = {
  input: Parameters<Planner['plan']>[0];
  checked?: { check: NeoTodo['check']; result: NeoTodoCheckResult | null };
  now: number;
  registered?: readonly (ArtifactRef | null)[];
};
type Outcome =
  | { ok: false; reason: string }
  | { ok: true; todo: NeoTodo; todos: NeoTodo[]; records?: string[]; startNext?: string | null };

const commit = (superpipe({})('neo.todo.commit-mutation') as PipelineAPI)
  .input(['db', 'args', 'changes'])
  .pipe(
    (db: Database, args: Input) => {
      const plan = new neoTodoMutationReads.Repository(db).plan(
        args.input,
        args.now,
        args.registered ?? []
      );
      return 'patch' in plan ? { value: plan } : { reason: plan };
    },
    ['db', 'args'],
    'result:outcome'
  )
  .pipe(
    (plan: Plan, args: Input) =>
      !['done', 'closed_unverified'].includes(plan.patch.state ?? '') ||
      !args.checked ||
      sameNeoTodoCheck({ ...plan.todo, check: args.checked.check }, plan.todo)
        ? { value: plan }
        : {
            reason: {
              ok: false as const,
              reason: 'todo_changed: completion check changed; retry with the current check.',
            },
          },
    ['outcome', 'args'],
    'result:outcome'
  )
  .pipe(
    (plan: Plan, args: Input) => requireNeoTodoMayFinish(plan, args.checked?.result ?? null),
    ['outcome', 'args'],
    'result:outcome'
  )
  .pipe(
    (db: Database, plan: Plan, args: Input, changes: ChangeRecorder): Outcome => {
      const todos = new NeoAskTodoRepository(db, () => changes.notifyChange('neo_todos'));
      const committed = todos.commitState(plan.todo.id, plan.patch, args.now, {
        state: 'no_opinion',
      });
      return {
        ok: true,
        todo: committed.todo!,
        todos: todos.listTodos(plan.todo.askId),
        startNext: committed.startNext,
        ...(plan.records ? { records: plan.records } : {}),
      };
    },
    ['db', 'outcome', 'args', 'changes'],
    'outcome'
  )
  .end('outcome') as (db: Database, args: Input, changes: ChangeRecorder) => Outcome;

export const neoTodoMutations = defineDbOp({
  name: 'neo.todoMutations',
  mode: 'write',
  run: commit,
});
