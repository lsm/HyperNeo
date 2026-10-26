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
  | { ok: true; todo: NeoTodo; todos: NeoTodo[]; startNext: string | null; records?: string[] };

class NeoTodoMutationWriter {
  private readonly todos: NeoAskTodoRepository;
  private readonly policies: readonly NeoTodoPolicy[];
  constructor(db: Database) {
    this.todos = new NeoAskTodoRepository(db);
    this.policies = neoTodoWritePolicies(db);
  }

  private withUrls(plan: Plan, input: Input) {
    if (input.kind !== 'edit' || !input.addUrls) return { value: plan };
    const policy = this.policies.find((pack) => pack.id === plan.todo.check?.pack)?.todos;
    const check = policy?.addUrls?.(plan.todo, input.addUrls);
    if (!check)
      return {
        value: {
          ...plan,
          records: [
            `check_urls_unsupported: URLs recorded without changing the check: ${input.addUrls.join(', ')}`,
          ],
        },
      };
    const accepted = planNeoTodoDraft(
      { ...plan.todo, check },
      this.policies,
      this.todos.listTodos(plan.todo.askId)
    );
    if ('reason' in accepted) return accepted;
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
        ...(accepted.value.records ? { records: accepted.value.records } : {}),
      },
    };
  }

  plan(
    input: Input,
    now: number,
    registered: readonly (ArtifactRef | null)[] = []
  ): ({ ok: true } & Plan) | Extract<Outcome, { ok: false }> {
    const todos = this.todos;
    const execute = (superpipe({})('neo.todo.prepare-mutation') as PipelineAPI)
      .input(['input', 'now', 'registered'])
      .pipe((input: Input) => todos.getTodo(input.todoId), 'input', 'current')
      .pipe(
        (todo: NeoTodo | null) => requireNeoOpenTodo(todo, todo ? todos.getAsk(todo.askId) : null),
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
        (plan: Plan, input: Input) => this.withUrls(plan, input),
        ['outcome', 'input'],
        'result:outcome'
      )
      .pipe((plan: Plan) => ({ ok: true as const, ...plan }), 'outcome', 'outcome')
      .end('outcome') as (
      input: Input,
      now: number,
      registered: readonly (ArtifactRef | null)[]
    ) => ({ ok: true } & Plan) | Extract<Outcome, { ok: false }>;
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
          return plan.ok ? { value: plan } : { reason: plan };
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
                  reason:
                    'todo_changed: PR URLs changed during completion; retry with the current check.',
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
