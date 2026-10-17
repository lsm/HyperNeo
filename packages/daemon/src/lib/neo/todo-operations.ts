import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type TodoReceipt = { ok: true; todo: NeoTodo; todos: NeoTodo[] };

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

const Text = z.string().trim().min(1);

const TodoCheck = z.object({
  pack: Text,
  kind: Text,
  params: z.record(z.string(), z.unknown()).default({}),
});

const Add = z.object({
  askId: Text,
  title: Text,
  doneWhen: Text,
  check: TodoCheck.nullable().default(null),
  instruction: Text.nullable().default(null),
  named: z.record(z.string(), z.unknown()).nullable().default(null),
});

const Edit = z.object({
  todoId: Text,
  title: Text.optional(),
  doneWhen: Text.optional(),
  done: z.enum(['met', 'reported']).optional(),
  evidence: Text.optional(),
});

const Remove = z.object({
  todoId: Text,
  reason: Text,
  replacedBy: Text.optional(),
});

const NeoTodoSchema = z.object({
  id: z.string(),
  askId: z.string(),
  position: z.number(),
  title: z.string(),
  doneWhen: z.string(),
  check: TodoCheck.nullable(),
  instruction: z.string().nullable(),
  named: z.record(z.string(), z.unknown()).nullable(),
  state: z.enum(['todo', 'doing', 'done', 'failed', 'removed']),
  reason: z.string().nullable(),
  replacedBy: z.string().nullable(),
  addedAfterStart: z.boolean(),
  report: z.string().nullable(),
  evidence: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

const TodoResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), todo: NeoTodoSchema, todos: z.array(NeoTodoSchema) }),
]);

export function requireNeoAskOwner(ask: NeoAsk | null, caller: OperationCaller): Gate<NeoAsk> {
  if (!ask) return fail('not_found: no such ask.');
  if (ask.status !== 'open') return fail(`ask_settled: this ask is ${ask.status}.`);
  if (!isLocalUser(caller) && caller.sessionId !== ask.sessionId)
    return fail('not_owner: another Neo session owns this ask.');
  return { value: ask };
}

export function requireNeoTodoOwner(
  todo: NeoTodo | null,
  ask: NeoAsk | null,
  caller: OperationCaller
): Gate<NeoTodo> {
  if (!todo) return fail('not_found: no such todo.');
  const owned = requireNeoAskOwner(ask, caller);
  return 'reason' in owned ? owned : { value: todo };
}

export function planNeoTodoEdit(
  todo: NeoTodo,
  input: z.infer<typeof Edit>
): Gate<{ todo: NeoTodo; patch: NeoTodoPatch }> {
  if (todo.state === 'removed') return fail('todo_removed: this todo was removed.');
  if (input.done && !input.evidence)
    return fail('evidence_missing: ticking a todo needs evidence.');
  return {
    value: {
      todo,
      patch: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}),
        ...(input.done === 'met' ? { state: 'done', evidence: input.evidence } : {}),
        ...(input.done === 'reported' ? { state: 'done', report: input.evidence } : {}),
      },
    },
  };
}

export function planNeoTodoRemove(
  todo: NeoTodo,
  todos: NeoTodo[],
  input: z.infer<typeof Remove>
): Gate<{ todo: NeoTodo; patch: NeoTodoPatch }> {
  if (todo.state === 'removed') return fail('todo_removed: this todo was already removed.');
  if (
    input.replacedBy &&
    !todos.some((other) => other.id === input.replacedBy && other.id !== todo.id)
  )
    return fail('replacement_missing: replacedBy is not another todo on this ask.');
  return {
    value: {
      todo,
      patch: { state: 'removed', reason: input.reason, replacedBy: input.replacedBy ?? null },
    },
  };
}

export function createNeoTodoOperations(todos: NeoAskTodoRepository) {
  const write = (plan: { todo: NeoTodo; patch: NeoTodoPatch }): TodoReceipt => {
    const todo = todos.updateTodo(plan.todo, plan.patch, Date.now());
    return { ok: true, todo, todos: todos.listTodos(todo.askId) };
  };
  const owned = (pipeline: PipelineAPI) =>
    pipeline
      .input(['input', 'caller'])
      .pipe((input: { todoId: string }) => todos.getTodo(input.todoId), 'input', 'todo')
      .pipe((todo: NeoTodo | null) => (todo ? todos.getAsk(todo.askId) : null), 'todo', 'ask')
      .pipe(requireNeoTodoOwner, ['todo', 'ask', 'caller'], 'result:outcome');

  const add = (superpipe({})('neo.todo.add') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Add>, caller: OperationCaller) =>
        requireNeoAskOwner(todos.getAsk(input.askId), caller),
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk, input: z.infer<typeof Add>): TodoReceipt => {
        const todo = todos.addTodo(crypto.randomUUID(), ask.id, input, Date.now());
        return { ok: true, todo, todos: todos.listTodos(ask.id) };
      },
      ['outcome', 'input'],
      'outcome'
    )
    .end('outcome') as (
    input: z.infer<typeof Add>,
    caller: OperationCaller
  ) => TodoReceipt | Rejection;

  const edit = owned(superpipe({})('neo.todo.edit') as PipelineAPI)
    .pipe(planNeoTodoEdit, ['outcome', 'input'], 'result:outcome')
    .pipe(write, 'outcome', 'outcome')
    .end('outcome') as (
    input: z.infer<typeof Edit>,
    caller: OperationCaller
  ) => TodoReceipt | Rejection;

  const remove = owned(superpipe({})('neo.todo.remove') as PipelineAPI)
    .pipe(
      (todo: NeoTodo, input: z.infer<typeof Remove>) =>
        planNeoTodoRemove(todo, todos.listTodos(todo.askId), input),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(write, 'outcome', 'outcome')
    .end('outcome') as (
    input: z.infer<typeof Remove>,
    caller: OperationCaller
  ) => TodoReceipt | Rejection;

  return [
    defineOperation({
      name: 'neo.todo.add',
      description:
        'Add a todo to an open ask you own: title, doneWhen (one sentence), and check {pack, kind, params} when a pack can read it. instruction is the task for a session; without it the daemon checks the todo itself. named records what the human named for it (engine, session, repository, folder).',
      inputSchema: Add,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => add(input, caller),
    }),
    defineOperation({
      name: 'neo.todo.edit',
      description:
        'Change a todo on an open ask you own: title or doneWhen, or tick it done with evidence (done met for what you read, reported for a claim you cannot read).',
      inputSchema: Edit,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => edit(input, caller),
    }),
    defineOperation({
      name: 'neo.todo.remove',
      description:
        'Remove a todo from an open ask you own, with the reason. replacedBy names the todo that replaces it. A removed todo stays listed, struck through.',
      inputSchema: Remove,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => remove(input, caller),
    }),
  ];
}
