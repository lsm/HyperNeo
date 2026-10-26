import { WorkRefSchema, type WorkRef } from '../drivers/types.ts';
import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { NeoTodoTargetSchema } from './driver-work.ts';
import type { NeoPack } from './pack-contract.ts';
import { neoTodoHome, neoTodoRepo } from './todo-repo.ts';
import {
  readNeoTodoCompletion,
  requireNeoTodoMayFinish,
  sameNeoTodoCheck,
} from './todo-completion.ts';
import { planNeoTodoAwaitingStart } from './todo-runner.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import { ArtifactRefSchema, unregisteredArtifact } from '../artifacts/file-contracts.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';

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
  recompute(todo: NeoTodo, patch: NeoTodoPatch): Promise<NeoTodo>;
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
  if (input.target?.verb !== 'bind' && !input.instruction !== !input.target)
    context.addIssue({
      code: 'custom',
      message: 'A todo with an instruction needs a target, and a target needs an instruction.',
    });
  if (input.start && !input.target)
    context.addIssue({ code: 'custom', message: 'start needs a target.' });
}

export const NeoTodoDraftSchema = TodoDraft.superRefine(refineNeoTodoDraft);

const Add = TodoDraft.extend({ askId: Text }).superRefine(refineNeoTodoDraft);

export function planNeoTodoDraft<T extends Pick<NeoTodo, 'check' | 'instruction' | 'doneWhen'>>(
  draft: T,
  packs: readonly NeoPack[],
  peers: readonly NeoTodo[] = []
): Gate<T> {
  const pack = draft.check && packs.find((item) => item.id === draft.check?.pack)?.todos;
  const refused = pack?.refuse?.(draft, peers);
  if (refused) return fail(`check_refused: ${refused}`);
  const doneWhen = draft.check && pack?.doneWhen?.(draft.check);
  return { value: doneWhen ? { ...draft, doneWhen } : draft };
}

export function requireNeoDoneWhenEditable(
  todo: NeoTodo,
  input: { doneWhen?: string },
  packs: readonly NeoPack[]
): Gate<NeoTodo> {
  const pack = todo.check && packs.find((item) => item.id === todo.check?.pack)?.todos;
  return input.doneWhen && todo.check && pack?.doneWhen?.(todo.check) === todo.doneWhen
    ? fail(
        "done_when_from_check: this todo's done-when comes from its check; change the check instead."
      )
    : { value: todo };
}

export async function addNeoTodo(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  start: NeoTodoControls['start'],
  ask: NeoAsk,
  input: z.infer<typeof NeoTodoDraftSchema>,
  packs: readonly NeoPack[],
  split = false
): Promise<{ ok: true; todo: NeoTodo } | Rejection> {
  const planned = planNeoTodoDraft(input, packs);
  if ('reason' in planned) return planned.reason;
  const draft = planned.value;
  const repo = neoTodoRepo(draft, packs, ask);
  const home = neoTodoHome(todos, ask, repo, split || todos.listChildAsks(ask.id).length > 0);
  if (home.status !== 'open')
    return {
      ok: false,
      reason: `ask_settled: ${home.title} is settled; open a new ask for this todo.`,
    };
  const accepted = planNeoTodoDraft(draft, packs, todos.listTodos(home.id));
  if ('reason' in accepted) return accepted.reason;
  const added = todos.addTodo(crypto.randomUUID(), home.id, draft, Date.now(), repo);
  if (draft.target?.verb === 'bind') return bindNeoTodo(todos, sessions, added, draft.target.ref);
  if (draft.target) sessions.create(added.id, draft.target);
  if (draft.start) return start(added.id);
  if (added.instruction) joinNeoStartQuestion(todos, added);
  return { ok: true, todo: added };
}

function joinNeoStartQuestion(todos: NeoAskTodoRepository, todo: NeoTodo): void {
  const now = Date.now();
  todos.joinStartQuestion(todo, now);
  const blocked = planNeoTodoAwaitingStart(todo);
  if (blocked) todos.updateTodo(todo, blocked, now);
}

const bindNeoTodo = (superpipe({})('neo.todo.bind-worker') as PipelineAPI)
  .input(['todos', 'sessions', 'todo', 'ref'])
  .pipe(
    (todo: NeoTodo): Gate<NeoTodo> =>
      ['done', 'removed'].includes(todo.state)
        ? fail(`todo_settled: cannot bind a ${todo.state} todo.`)
        : { value: todo },
    'todo',
    'result:bound'
  )
  .pipe(
    (
      todos: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      todo: NeoTodo,
      ref: WorkRef
    ) => {
      const now = Date.now();
      sessions.bind(todo.id, ref, now);
      return {
        ok: true as const,
        todo: todos.updateTodo(
          todo,
          {
            state: 'doing',
            startedAt: todo.startedAt ?? now,
            finishedAt: null,
            reason: null,
            report: null,
            evidence: null,
            blockedBy: null,
            blockedReason: null,
            nextAction: null,
          },
          now
        ),
      };
    },
    ['todos', 'sessions', 'bound', 'ref'],
    'bound'
  )
  .end('bound') as (
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  todo: NeoTodo,
  ref: WorkRef
) => { ok: true; todo: NeoTodo } | Rejection;

const Bind = z.object({ todoId: Text, ref: WorkRefSchema });

const Edit = z.object({
  todoId: Text,
  title: Text.optional(),
  addUrls: z.array(Text).min(1).optional(),
  doneWhen: Text.optional(),
  done: z.enum(['met', 'reported']).optional(),
  evidence: Text.optional(),
  artifacts: z.array(ArtifactRefSchema).min(1).max(16).optional(),
});

const Remove = z.object({
  todoId: Text,
  reason: Text,
  replacedBy: Text.optional(),
});

export const NeoTodoSchema = z.object({
  worker: WorkerIdentitySchema.nullable().optional(),
  id: z.string(),
  askId: z.string(),
  position: z.number(),
  title: z.string(),
  doneWhen: z.string(),
  check: TodoCheck.nullable(),
  instruction: z.string().nullable(),
  named: z.record(z.string(), z.unknown()).nullable(),
  repo: z.string().nullable(),
  state: z.enum(['todo', 'doing', 'blocked', 'done', 'closed_unverified', 'failed', 'removed']),
  reason: z.string().nullable(),
  blockedReason: z.string().nullable(),
  nextAction: z.string().nullable(),
  blockedBy: z.enum(['check', 'worker', 'failure', 'question', 'needs-human']).nullable(),
  replacedBy: z.string().nullable(),
  addedAfterStart: z.boolean(),
  report: z.string().nullable(),
  evidence: z.string().nullable(),
  artifacts: z.array(ArtifactRefSchema).readonly().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

const TodoResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), todo: NeoTodoSchema, todos: z.array(NeoTodoSchema) }),
]);

export function requireNeoOpenAsk(ask: NeoAsk | null): Gate<NeoAsk> {
  if (!ask) return fail('not_found: no such ask.');
  if (ask.status !== 'open') return fail(`ask_settled: this ask is ${ask.status}.`);
  return { value: ask };
}

export function requireNeoOpenTodo(todo: NeoTodo | null, ask: NeoAsk | null): Gate<NeoTodo> {
  if (!todo) return fail('not_found: no such todo.');
  const open = requireNeoOpenAsk(ask);
  return 'reason' in open ? open : { value: todo };
}

export function planNeoTodoEdit(
  todo: NeoTodo,
  input: z.infer<typeof Edit>,
  now = Date.now()
): Gate<{ todo: NeoTodo; patch: NeoTodoPatch }> {
  if (todo.state === 'removed') return fail('todo_removed: this todo was removed.');
  if (input.done && !input.evidence)
    return fail('evidence_missing: ticking a todo needs evidence.');
  if (input.artifacts && !input.done)
    return fail('evidence_missing: artifacts are evidence; pass them with done.');
  return {
    value: {
      todo,
      patch: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}),
        ...(input.done ? { state: 'done', finishedAt: now } : {}),
        ...(input.done === 'met' ? { evidence: input.evidence } : {}),
        ...(input.done === 'reported' ? { report: input.evidence } : {}),
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      },
    },
  };
}

export function requireNeoTodoArtifacts(
  plan: { todo: NeoTodo; patch: NeoTodoPatch },
  registered: readonly (ArtifactRef | null)[]
): Gate<{ todo: NeoTodo; patch: NeoTodoPatch }> {
  const unknown = unregisteredArtifact(plan.patch.artifacts ?? [], registered);
  return unknown
    ? fail(
        `invalid_artifact_reference: artifact "${unknown.artifactId}" is not one you can attach as given; pass the reference artifact.file.register or artifact.file.get returned.`
      )
    : { value: plan };
}

export function requireNeoTodoCardsAnswered<T extends { todo: NeoTodo; patch: NeoTodoPatch }>(
  plan: T,
  questions: readonly NeoQuestion[]
): Gate<T> {
  const card =
    ['done', 'closed_unverified'].includes(plan.patch.state ?? '') &&
    questions.find((question) => question.state === 'open' && question.todoId === plan.todo.id);
  return card
    ? fail(`card_unanswered: card ${card.id} is still waiting for the human.`)
    : { value: plan };
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
  packs: () => readonly NeoPack[],
  artifact: ArtifactRefReader,
  project: <T extends NeoTodo>(todos: readonly T[]) => Promise<T[]> = async (todos) => [...todos]
) {
  const present = async (result: TodoReceipt | Rejection) => {
    if (!result.ok) return result;
    const [todo, ...todos] = await project([result.todo, ...result.todos]);
    return { ...result, todo, todos };
  };
  const completion = (plan: { todo: NeoTodo; patch: NeoTodoPatch }) =>
    plan.patch.state === 'done' ? readNeoTodoCompletion(packs(), plan.todo) : null;
  const cards = (plan: { todo: NeoTodo }) => todos.listQuestions(plan.todo.askId);
  const withUrls = (
    plan: { todo: NeoTodo; patch: NeoTodoPatch },
    input: z.infer<typeof Edit>
  ): Gate<{ todo: NeoTodo; patch: NeoTodoPatch }> => {
    if (!input.addUrls) return { value: plan };
    const pack = packs().find((pack) => pack.id === plan.todo.check?.pack)?.todos;
    const check = pack?.addUrls?.(plan.todo, input.addUrls);
    if (!check)
      return fail('check_urls_unsupported: this todo needs a check that accepts PR urls.');
    const accepted = planNeoTodoDraft(
      { ...plan.todo, check },
      packs(),
      todos.listTodos(plan.todo.askId)
    );
    if ('reason' in accepted) return accepted;
    return {
      value: {
        todo: accepted.value,
        patch: { ...plan.patch, check, doneWhen: accepted.value.doneWhen },
      },
    };
  };
  const write = async (
    plan: { todo: NeoTodo; patch: NeoTodoPatch },
    input?: z.infer<typeof Edit>
  ): Promise<TodoReceipt | Rejection> => {
    const checked = plan.todo;
    if (input?.addUrls) {
      const latest = requireNeoOpenTodo(todos.getTodo(plan.todo.id), todos.getAsk(plan.todo.askId));
      if ('reason' in latest) return latest.reason;
      const edited = planNeoTodoEdit(latest.value, input);
      if ('reason' in edited) return edited.reason;
      const rebased = withUrls(edited.value, input);
      if ('reason' in rebased) return rebased.reason;
      plan = rebased.value;
    }
    if (['done', 'closed_unverified'].includes(plan.patch.state ?? '')) {
      const latest = requireNeoOpenTodo(todos.getTodo(plan.todo.id), todos.getAsk(plan.todo.askId));
      if ('reason' in latest) return latest.reason;
      if (!sameNeoTodoCheck(checked, input?.addUrls ? plan.todo : latest.value))
        return {
          ok: false,
          reason: 'todo_changed: PR URLs changed during completion; retry with the current check.',
        };
      const answered = requireNeoTodoCardsAnswered(plan, cards(plan));
      if ('reason' in answered) return answered.reason;
    }
    if (plan.patch.check) {
      const accepted = planNeoTodoDraft(plan.todo, packs(), todos.listTodos(plan.todo.askId));
      if ('reason' in accepted) return accepted.reason;
    }
    const todo = await controls.recompute(plan.todo, plan.patch);
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
      .pipe(requireNeoOpenTodo, ['todo', 'ask'], 'result:outcome');

  const add = (superpipe({})('neo.todo.add') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Add>) => requireNeoOpenAsk(todos.getAsk(input.askId)),
      'input',
      'result:outcome'
    )
    .pipe(
      async (ask: NeoAsk, input: z.infer<typeof Add>): Promise<TodoReceipt | Rejection> =>
        ran(await addNeoTodo(todos, sessions, controls.start, ask, input, packs())),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Add>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const bind = owned(superpipe({})('neo.todo.bind') as PipelineAPI)
    .pipe(
      (todo: NeoTodo, input: z.infer<typeof Bind>) =>
        ran(bindNeoTodo(todos, sessions, todo, input.ref)),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Bind>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const edit = owned(superpipe({})('neo.todo.edit') as PipelineAPI)
    .pipe(
      (todo: NeoTodo, input: z.infer<typeof Edit>) =>
        requireNeoDoneWhenEditable(todo, input, packs()),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(planNeoTodoEdit, ['outcome', 'input'], 'result:outcome')
    .pipe(
      (plan: { patch: NeoTodoPatch }, caller: OperationCaller) =>
        (plan.patch.artifacts ?? []).map((ref) => artifact(ref.artifactId, caller)),
      ['outcome', 'caller'],
      'registered'
    )
    .pipe(requireNeoTodoArtifacts, ['outcome', 'registered'], 'result:outcome')
    .pipe(withUrls, ['outcome', 'input'], 'result:outcome')
    .pipe(completion, 'outcome', 'completion')
    .pipe(requireNeoTodoMayFinish, ['outcome', 'completion'], 'result:outcome')
    .pipe(write, ['outcome', 'input'], 'outcome')
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
    .pipe(cards, 'outcome', 'questions')
    .pipe(requireNeoTodoCardsAnswered, ['outcome', 'questions'], 'result:outcome')
    .pipe(stopAndWrite, 'outcome', 'outcome')
    .endAsync('outcome') as (
    input: z.infer<typeof Close>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  return [
    defineOperation({
      name: 'neo.todo.add',
      description:
        'Add a todo to an open ask you own. A coding PR already tracked by another live todo on that ask is refused; pin URLs with neo.todo.edit addUrls on the original instead. Pass title, doneWhen (one sentence), and check {pack, kind, params} when a pack can read it; a pack may refuse a check, or write doneWhen from it. instruction is the task for a session and target says where it runs ({verb: start, adapter, place?} or {verb: send, ref}); non-coding todos share one visible user folder across projects when place is omitted: ~/HyperNeo by default, or exactly the instance workspace path. A different place needs an exact path the user named in chat, even inside the workspace; never invent folders under home. Coding keeps its repository place; use target {verb: bind, ref} to bind already running work immediately without dispatch, with no instruction or start flag needed; without them the daemon checks the todo itself. named records what the human named for it (engine, session, repository, folder). A session the human named is sent to only through the ref work.find {session} returns as an exact match. start:true starts it now; otherwise the daemon lists it, ticked, in the start question of the ask.',
      inputSchema: Add,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await add(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.bind',
      description:
        'Bind an unfinished todo on an open ask to an existing running worker, without sending or starting anything. Use this to repair a failed backfill instead of retrying its instruction. Records worker and doing, clears failure and old delivery evidence; does not stop the existing worker.',
      inputSchema: Bind,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await bind(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.edit',
      description:
        'Change a todo on an open ask you own: title or doneWhen; addUrls appends PR URLs to its existing PR-merge check and updates doneWhen, refusing URLs another live todo on this ask tracks. Prefer editing to adding a duplicate PR todo. Or tick it done with evidence (done met for what you read, reported for a claim you cannot read); attach a document or evidence file as the reference artifact.file.register returned in artifacts, with one sentence of evidence, not the pasted document. A todo with an unanswered card is refused until the human answers it.',
      inputSchema: Edit,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await edit(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.remove',
      description:
        'Remove a todo from an open ask you own, with the reason; its session stops if it is running, unless the todo only follows a session the human tracked. replacedBy names the todo that replaces it. A removed todo stays listed, struck through.',
      inputSchema: Remove,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await remove(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.continue',
      description:
        "Send a started todo's session its next step. The todo goes back to doing until the session reports again.",
      inputSchema: Continue,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await proceed(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.retry',
      description:
        'Retry a failed todo in place with a new attempt, keeping its todoId. If it has a worker, send the original instruction to that worker; otherwise start its recorded target again. Do not remove and replace it. Choose the delivery channel or adapter for reaching the same worker session yourself; never ask the human to choose it. Ask the human before changing which worker or target does the work.',
      inputSchema: Retry,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await retry(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.close',
      description:
        'Close a todo with your reason. It is done only when its outcome check passes; otherwise it is visibly closed unverified, with the unmet check recorded. Its session stops if it is running, unless the todo only follows a session the human tracked. A todo with an unanswered card is refused until the human answers it.',
      inputSchema: Close,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await close(input, caller)),
    }),
  ];
}
