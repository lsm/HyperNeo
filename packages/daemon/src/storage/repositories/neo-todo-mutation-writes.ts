import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { NeoTodoCheckResult } from '../../lib/neo/pack-contract.ts';
import { neoTodoWritePolicies } from '../../lib/neo/packs/todo-write-policies.ts';
import { requireNeoTodoMayFinish, sameNeoTodoCheck } from '../../lib/neo/todo-completion.ts';
import {
  planNeoTodoDraft,
  planNeoTodoEdit,
  planNeoTodoClose,
  planNeoTodoRemove,
  requireNeoOpenTodo,
  requireNeoTodoArtifacts,
  requireNeoTodoCardsAnswered,
  type NeoTodoPolicy,
} from '../../lib/neo/todo-operations.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository, type NeoTodoPatch } from './neo-ask-todo-repository.ts';

type Input =
  | ({ kind: 'edit' } & Parameters<typeof planNeoTodoEdit>[1])
  | ({ kind: 'close' } & Parameters<typeof planNeoTodoClose>[1])
  | ({ kind: 'remove' } & Parameters<typeof planNeoTodoRemove>[2]);
type Checked = { check: NeoTodo['check']; result: NeoTodoCheckResult | null };
type Plan = { todo: NeoTodo; patch: NeoTodoPatch; records?: string[] };
type Outcome =
  | { ok: false; reason: string }
  | { ok: true; todo: NeoTodo; todos: NeoTodo[]; startNext?: string | null; records?: string[] };

class NeoTodoMutationWriter {
  private readonly todos: NeoAskTodoRepository;
  private readonly policies: readonly NeoTodoPolicy[];
  constructor(db: Database) {
    this.todos = new NeoAskTodoRepository(db);
    this.policies = neoTodoWritePolicies(db);
  }

  private withCheck(plan: Plan, input: Input) {
    if (input.kind !== 'edit' || (!input.addUrls && !input.check)) return { value: plan };
    const requested = { ...plan.todo, check: input.check ?? plan.todo.check };
    const policy = this.policies.find((pack) => pack.id === requested.check?.pack)?.todos;
    const appended = input.addUrls ? policy?.addUrls?.(requested, input.addUrls) : null;
    const check = appended ?? input.check;
    if (!check)
      return {
        value: {
          ...plan,
          records: [
            `check_urls_unsupported: URLs recorded without changing the check: ${input.addUrls?.join(', ')}`,
          ],
        },
      };
    const accepted = planNeoTodoDraft(
      { ...plan.todo, check },
      this.policies,
      this.todos.listTodos(plan.todo.askId)
    );
    if ('reason' in accepted) return accepted;
    const records = [
      ...(accepted.value.records ?? []),
      ...(input.addUrls && !appended
        ? [
            `check_urls_unsupported: URLs recorded without changing the check: ${input.addUrls.join(', ')}`,
          ]
        : []),
    ];
    return {
      value: {
        todo: accepted.value,
        patch: {
          ...plan.patch,
          check,
          doneWhen: accepted.value.doneWhen,
          ...(plan.todo.state === 'done' &&
          !input.done &&
          !sameNeoTodoCheck(plan.todo, { ...plan.todo, check })
            ? {
                state: plan.todo.startedAt === null ? ('todo' as const) : ('doing' as const),
                finishedAt: null,
                reason: null,
              }
            : {}),
        },
        ...(records.length ? { records } : {}),
      },
    };
  }

  plan(
    input: Input,
    now: number,
    registered: readonly (ArtifactRef | null)[] = []
  ): ({ ok: true } & Plan) | Outcome {
    const todos = this.todos;
    const execute = (superpipe({})('neo.todo.prepare-mutation') as PipelineAPI)
      .input(['input', 'now', 'registered'])
      .pipe((input: Input) => todos.getTodo(input.todoId), 'input', 'current')
      .pipe(
        (todo: NeoTodo | null) => {
          const ask = todo ? todos.getAsk(todo.askId) : null;
          return todo && ask && ask.status !== 'open'
            ? {
                reason: {
                  ok: true as const,
                  todo,
                  todos: todos.listTodos(ask.id),
                  records: [`ask_settled: this ask is ${ask.status}; no change was made.`],
                },
              }
            : requireNeoOpenTodo(todo, ask);
        },
        'current',
        'result:outcome'
      )
      .pipe(
        (todo: NeoTodo, input: Input, now: number) =>
          input.kind === 'edit'
            ? planNeoTodoEdit(todo, input, now)
            : input.kind === 'close'
              ? planNeoTodoClose(todo, input, now)
              : planNeoTodoRemove(todo, todos.listTodos(todo.askId), input),
        ['outcome', 'input', 'now'],
        'result:outcome'
      )
      .pipe(requireNeoTodoArtifacts, ['outcome', 'registered'], 'result:outcome')
      .pipe(
        (plan: Plan, input: Input) => this.withCheck(plan, input),
        ['outcome', 'input'],
        'result:outcome'
      )
      .pipe((plan: Plan) => ({ ok: true as const, ...plan }), 'outcome', 'outcome')
      .end('outcome') as (
      input: Input,
      now: number,
      registered: readonly (ArtifactRef | null)[]
    ) => ({ ok: true } & Plan) | Outcome;
    return execute(input, now, registered);
  }

  commit(
    input: Input,
    checked: Checked | undefined,
    now: number,
    registered: readonly (ArtifactRef | null)[] = []
  ): Outcome {
    const todos = this.todos;
    const execute = (superpipe({})('neo.todo.commit-mutation') as PipelineAPI)
      .input(['input', 'checked', 'now', 'registered'])
      .pipe(
        (input: Input, now: number, registered: readonly (ArtifactRef | null)[]) => {
          const plan = this.plan(input, now, registered);
          return 'patch' in plan ? { value: plan } : { reason: plan };
        },
        ['input', 'now', 'registered'],
        'result:outcome'
      )
      .pipe(
        (plan: Plan, checked: Checked | undefined) =>
          !['done', 'closed_unverified'].includes(plan.patch.state ?? '') ||
          !checked ||
          sameNeoTodoCheck({ ...plan.todo, check: checked.check }, plan.todo)
            ? { value: plan }
            : {
                reason: {
                  ok: false as const,
                  reason: 'todo_changed: completion check changed; retry with the current check.',
                },
              },
        ['outcome', 'checked'],
        'result:outcome'
      )
      .pipe(
        (plan: Plan, checked: Checked | undefined) =>
          requireNeoTodoMayFinish(plan, checked?.result ?? null),
        ['outcome', 'checked'],
        'result:outcome'
      )
      .pipe(
        (plan: Plan) =>
          requireNeoTodoCardsAnswered(
            plan,
            ['done', 'closed_unverified'].includes(plan.patch.state ?? '')
              ? todos.listQuestions(plan.todo.askId)
              : []
          ),
        'outcome',
        'result:outcome'
      )
      .pipe(
        (plan: Plan, now: number): Outcome => {
          const committed = todos.commitState(plan.todo.id, plan.patch, now, {
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
        ['outcome', 'now'],
        'outcome'
      )
      .end('outcome') as (
      input: Input,
      checked: Checked | undefined,
      now: number,
      registered: readonly (ArtifactRef | null)[]
    ) => Outcome;
    return execute(input, checked, now, registered);
  }
}

export const neoTodoMutations = defineRepositoryOp(
  'neo.todoMutations',
  'write',
  NeoTodoMutationWriter,
  ['commit']
);

export const neoTodoMutationReads = defineRepositoryOp(
  'neo.todoMutationReads',
  'read',
  NeoTodoMutationWriter,
  ['plan']
);
