import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { openHumanCard } from '../../lib/neo/human-card.ts';
import type { NeoTodoCheckResult } from '../../lib/neo/pack-contract.ts';
import { requireNeoTodoMayFinish, sameNeoTodoCheck } from '../../lib/neo/todo-completion.ts';
import {
  NEO_REMOVED_PREREQUISITE,
  NEO_REMOVED_PREREQUISITE_OPTIONS,
  planNeoTodoRemoval,
} from '../../lib/neo/todo-removal.ts';
import { type ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository, type NeoTodoPatch } from './neo-ask-todo-repository.ts';
import { neoTodoMutationReads } from './neo-todo-mutation-planning.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

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
      args.input.kind === 'done' ||
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
    (plan: Plan, args: Input) =>
      args.input.kind === 'done'
        ? { value: plan }
        : requireNeoTodoMayFinish(plan, args.checked?.result ?? null),
    ['outcome', 'args'],
    'result:outcome'
  )
  .pipe(
    (db: Database, changes: ChangeRecorder) =>
      new NeoAskTodoRepository(
        db,
        () => changes.notifyChange('neo_todos'),
        undefined,
        undefined,
        changes
      ),
    ['db', 'changes'],
    'store'
  )
  .pipe(
    (store: NeoAskTodoRepository, plan: Plan, args: Input) =>
      args.input.kind === 'remove'
        ? {
            family: store.listFamilyTodos(plan.todo.askId),
            cards: store.familyQuestions(plan.todo.askId),
          }
        : null,
    ['store', 'outcome', 'args'],
    'facts'
  )
  .pipe(
    (plan: Plan, args: Input, facts: { family: NeoTodo[]; cards: NeoQuestion[] } | null) =>
      facts && args.input.kind === 'remove'
        ? planNeoTodoRemoval(
            plan.todo,
            facts.family,
            facts.cards,
            { replacedBy: plan.patch.replacedBy, dependents: args.input.dependents },
            args.now
          )
        : null,
    ['outcome', 'args', 'facts'],
    'removal'
  )
  .pipe(
    (
      db: Database,
      todos: NeoAskTodoRepository,
      plan: Plan,
      args: Input,
      removal: ReturnType<typeof planNeoTodoRemoval<NeoTodo>> | null,
      changes: ChangeRecorder
    ): Outcome => {
      const committed = todos.commitState(
        plan.todo.id,
        plan.patch,
        args.now,
        { state: 'no_opinion' },
        args.input.kind === 'done'
      );
      for (const { todo, patch } of removal?.writes ?? []) todos.updateTodo(todo, patch, args.now);
      if (removal?.card)
        openHumanCard(
          todos,
          crypto.randomUUID(),
          removal.card.askId,
          {
            text: removal.card.text,
            kind: 'choice',
            options: NEO_REMOVED_PREREQUISITE_OPTIONS,
            multiple: false,
            noLabel: null,
            yesLabel: null,
            startTodos: null,
            todos: removal.card.todos,
            cause: NEO_REMOVED_PREREQUISITE,
          },
          args.now
        );
      if (args.input.kind === 'edit' && args.input.target)
        new NeoTodoSessionRepository(db, changes).create(plan.todo.id, args.input.target);
      return {
        ok: true,
        todo: committed.todo!,
        todos: todos.listTodos(plan.todo.askId),
        startNext: committed.startNext ?? removal?.writes[0]?.todo.id ?? null,
        ...(plan.records ? { records: plan.records } : {}),
      };
    },
    ['db', 'store', 'outcome', 'args', 'removal', 'changes'],
    'outcome'
  )
  .end('outcome') as (db: Database, args: Input, changes: ChangeRecorder) => Outcome;

export const neoTodoMutations = defineDbOp({
  name: 'neo.todoMutations',
  mode: 'write',
  run: commit,
});
