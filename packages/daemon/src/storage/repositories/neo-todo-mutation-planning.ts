import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import { neoTodoPolicies } from '../../lib/neo/packs/todo-policies.ts';
import { sameNeoTodoCheck } from '../../lib/neo/todo-completion.ts';
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
type Plan = { todo: NeoTodo; patch: NeoTodoPatch; records?: string[] };
type Outcome =
  | { ok: false; reason: string }
  | { ok: true; todo: NeoTodo; todos: NeoTodo[]; records?: string[] };

class NeoTodoMutationPlanner {
  private readonly todos: NeoAskTodoRepository;
  private readonly policies: readonly NeoTodoPolicy[];
  constructor(db: Database) {
    this.todos = new NeoAskTodoRepository(db);
    this.policies = neoTodoPolicies(db);
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
      .pipe(
        (plan: Plan) => requireNeoTodoCardsAnswered(plan, todos.listQuestions(plan.todo.askId)),
        'outcome',
        'result:outcome'
      )
      .pipe((plan: Plan) => ({ ok: true as const, ...plan }), 'outcome', 'outcome')
      .end('outcome') as NeoTodoMutationPlanner['plan'];
    return execute(input, now, registered);
  }
}

export const neoTodoMutationReads = defineRepositoryOp(
  'neo.todoMutationReads',
  'read',
  NeoTodoMutationPlanner,
  ['plan']
);
