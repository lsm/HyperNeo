import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { NeoTodoTargetSchema } from './driver-work.ts';
import type { NeoPack } from './packs/types.ts';
import { neoStartQuestionTitle } from './start-question.ts';
import { readNeoTodoCompletion, requireNeoTodoMayFinish } from './todo-completion.ts';
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

type Ran = Promise<{ ok: true; todo: NeoTodo } | Rejection>;

export interface NeoTodoControls {
  start(todoId: string): Ran;
  proceed(todoId: string, message: string): Ran;
  retry(todoId: string): Ran;
  stop(todo: NeoTodo): Promise<string | null>;
}

const TodoDraft = z.object({
  title: Text,
  doneWhen: Text,
  check: TodoCheck.nullable().default(null),
  instruction: Text.nullable().default(null),
  target: NeoTodoTargetSchema.optional(),
  named: z.record(z.string(), z.unknown()).nullable().default(null),
  start: z.boolean().default(false),
});

function refineNeoTodoDraft(
  input: Pick<z.infer<typeof TodoDraft>, 'instruction' | 'target' | 'start'>,
  context: z.RefinementCtx
): void {
  if (!input.instruction !== !input.target)
    context.addIssue({
      code: 'custom',
      message: 'A todo with an instruction needs a target, and a target needs an instruction.',
    });
  if (input.start && !input.target)
    context.addIssue({ code: 'custom', message: 'start needs a target.' });
}

export const NeoTodoDraftSchema = TodoDraft.superRefine(refineNeoTodoDraft);

const Add = TodoDraft.extend({ askId: Text }).superRefine(refineNeoTodoDraft);

export async function addNeoTodo(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  start: NeoTodoControls['start'],
  askId: string,
  input: z.infer<typeof NeoTodoDraftSchema>
): Promise<{ ok: true; todo: NeoTodo } | Rejection> {
  const added = todos.addTodo(crypto.randomUUID(), askId, input, Date.now());
  if (input.target) sessions.create(added.id, input.target);
  if (input.start) return start(added.id);
  if (added.instruction) joinNeoStartQuestion(todos, added);
  return { ok: true, todo: added };
}

export function planNeoStartQuestionJoin(
  todo: NeoTodo,
  questions: readonly NeoQuestion[],
  todos: readonly NeoTodo[]
): { questionId: string | null; startTodos: string[]; text: string } {
  const open = questions.find((question) => question.kind === 'start' && question.state === 'open');
  const startable = (id: string) =>
    todos.some((item) => item.id === id && item.state === 'todo' && item.instruction);
  const startTodos = [...new Set([...(open?.startTodos ?? []).filter(startable), todo.id])];
  const text = neoStartQuestionTitle(
    startTodos.map((id) => ({ title: todos.find((item) => item.id === id)?.title }))
  );
  return { questionId: open?.id ?? null, startTodos, text };
}

function joinNeoStartQuestion(todos: NeoAskTodoRepository, todo: NeoTodo): void {
  const plan = planNeoStartQuestionJoin(
    todo,
    todos.listQuestions(todo.askId),
    todos.listTodos(todo.askId)
  );
  const now = Date.now();
  if (plan.questionId) todos.extendStartQuestion(plan.questionId, plan.startTodos, plan.text, now);
  else
    todos.askQuestion(
      crypto.randomUUID(),
      todo.askId,
      {
        text: plan.text,
        kind: 'start',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: plan.startTodos,
      },
      now
    );
}

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

export const NeoTodoSchema = z.object({
  id: z.string(),
  askId: z.string(),
  position: z.number(),
  title: z.string(),
  doneWhen: z.string(),
  check: TodoCheck.nullable(),
  instruction: z.string().nullable(),
  named: z.record(z.string(), z.unknown()).nullable(),
  state: z.enum(['todo', 'doing', 'blocked', 'done', 'failed', 'removed']),
  reason: z.string().nullable(),
  blockedReason: z.string().nullable(),
  nextAction: z.string().nullable(),
  blockedBy: z.enum(['check', 'worker', 'failure', 'question']).nullable(),
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
  input: z.infer<typeof Edit>,
  now = Date.now()
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
        ...(input.done ? { state: 'done', finishedAt: now } : {}),
        ...(input.done === 'met' ? { evidence: input.evidence } : {}),
        ...(input.done === 'reported' ? { report: input.evidence } : {}),
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

const Continue = z.object({ todoId: Text, message: Text });
const Retry = z.object({ todoId: Text });
const Close = z.object({ todoId: Text, reason: Text });

export function planNeoTodoClose(
  todo: NeoTodo,
  input: z.infer<typeof Close>,
  now = Date.now()
): Gate<{ todo: NeoTodo; patch: NeoTodoPatch }> {
  if (todo.state === 'removed') return fail('todo_removed: this todo was removed.');
  return {
    value: { todo, patch: { state: 'done', evidence: input.reason, finishedAt: now } },
  };
}

export function createNeoTodoOperations(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: NeoTodoControls,
  packs: () => readonly NeoPack[]
) {
  const completion = (plan: { todo: NeoTodo; patch: NeoTodoPatch }) =>
    plan.patch.state === 'done' ? readNeoTodoCompletion(packs(), plan.todo) : null;
  const write = (plan: { todo: NeoTodo; patch: NeoTodoPatch }): TodoReceipt => {
    const todo = todos.updateTodo(plan.todo, plan.patch, Date.now());
    return { ok: true, todo, todos: todos.listTodos(todo.askId) };
  };
  const stopAndWrite = async (plan: {
    todo: NeoTodo;
    patch: NeoTodoPatch;
  }): Promise<TodoReceipt | Rejection> => {
    const failed = await controls.stop(plan.todo);
    return failed
      ? { ok: false, reason: `${failed}; the todo is unchanged, its session may still run.` }
      : write(plan);
  };
  const ran = async (result: Awaited<Ran>): Promise<TodoReceipt | Rejection> =>
    result.ok ? { ok: true, todo: result.todo, todos: todos.listTodos(result.todo.askId) } : result;
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
      async (ask: NeoAsk, input: z.infer<typeof Add>): Promise<TodoReceipt | Rejection> =>
        ran(await addNeoTodo(todos, sessions, controls.start, ask.id, input)),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Add>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const edit = owned(superpipe({})('neo.todo.edit') as PipelineAPI)
    .pipe(planNeoTodoEdit, ['outcome', 'input'], 'result:outcome')
    .pipe(completion, 'outcome', 'completion')
    .pipe(requireNeoTodoMayFinish, ['outcome', 'completion'], 'result:outcome')
    .pipe(write, 'outcome', 'outcome')
    .endAsync('outcome') as (
    input: z.infer<typeof Edit>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const remove = owned(superpipe({})('neo.todo.remove') as PipelineAPI)
    .pipe(
      (todo: NeoTodo, input: z.infer<typeof Remove>) =>
        planNeoTodoRemove(todo, todos.listTodos(todo.askId), input),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(stopAndWrite, 'outcome', 'outcome')
    .endAsync('outcome') as (
    input: z.infer<typeof Remove>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const proceed = owned(superpipe({})('neo.todo.continue') as PipelineAPI)
    .pipe(
      (todo: NeoTodo, input: z.infer<typeof Continue>) =>
        controls.proceed(todo.id, input.message).then(ran),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Continue>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const retry = owned(superpipe({})('neo.todo.retry') as PipelineAPI)
    .pipe((todo: NeoTodo) => controls.retry(todo.id).then(ran), 'outcome', 'outcome')
    .endAsync('outcome') as (
    input: z.infer<typeof Retry>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const close = owned(superpipe({})('neo.todo.close') as PipelineAPI)
    .pipe(planNeoTodoClose, ['outcome', 'input'], 'result:outcome')
    .pipe(completion, 'outcome', 'completion')
    .pipe(requireNeoTodoMayFinish, ['outcome', 'completion'], 'result:outcome')
    .pipe(stopAndWrite, 'outcome', 'outcome')
    .endAsync('outcome') as (
    input: z.infer<typeof Close>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  return [
    defineOperation({
      name: 'neo.todo.add',
      description:
        'Add a todo to an open ask you own: title, doneWhen (one sentence), and check {pack, kind, params} when a pack can read it. instruction is the task for a session and target says where it runs ({verb: start, adapter, place} or {verb: send, ref}); without them the daemon checks the todo itself. named records what the human named for it (engine, session, repository, folder). A session the human named is sent to only through the ref work.find {session} returns as an exact match. start:true starts it now; otherwise the daemon lists it, ticked, in the start question of the ask.',
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
        'Remove a todo from an open ask you own, with the reason; its session stops if it is running. replacedBy names the todo that replaces it. A removed todo stays listed, struck through.',
      inputSchema: Remove,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => remove(input, caller),
    }),
    defineOperation({
      name: 'neo.todo.continue',
      description:
        "Send a started todo's session its next step. The todo goes back to doing until the session reports again.",
      inputSchema: Continue,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => proceed(input, caller),
    }),
    defineOperation({
      name: 'neo.todo.retry',
      description:
        'Start a todo that failed before its session started again, on the same target. To use anything else, ask the human.',
      inputSchema: Retry,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => retry(input, caller),
    }),
    defineOperation({
      name: 'neo.todo.close',
      description:
        'Mark a todo done with the reason you judged it done; its session stops if it is running.',
      inputSchema: Close,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => close(input, caller),
    }),
  ];
}
