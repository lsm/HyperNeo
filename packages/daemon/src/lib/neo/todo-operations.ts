import {
  neoTodoAfterRefusal,
  neoTodoDependencyRefusal,
  planNeoTodoDependencies,
} from './todo-dependencies.ts';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { ArtifactRefSchema, unregisteredArtifact } from '../artifacts/file-contracts.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import { type WorkRef, WorkRefSchema } from '../drivers/types.ts';
import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoTodoTargetSchema } from './driver-work.ts';
import { noNeoInputReads, resolveNeoInputAsk, type NeoInputReads } from './input-ask.ts';
import type { NeoPack } from './pack-contract.ts';
import {
  readNeoTodoCompletion,
  requireNeoTodoMayFinish,
  sameNeoTodoCheck,
} from './todo-completion.ts';
import { neoTodoHome, neoTodoRepo } from './todo-repo.ts';
import { isNeoTodoStartable, planNeoTodoAwaitingStart } from './todo-runner.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type TodoReceipt = { ok: true; todo?: NeoTodo; todos: NeoTodo[]; records?: string[] };
type TodoPlan = { todo: NeoTodo; patch: NeoTodoPatch; records?: string[] };

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

const Text = z.string().trim().min(1);

const TodoCheck = z.object({
  pack: Text,
  kind: Text,
  params: z.record(z.string(), z.unknown()).default({}),
});

type Ran = Promise<{ ok: true; todo: NeoTodo; records?: string[] } | Rejection>;

export interface NeoTodoControls {
  resolveTarget(ref: WorkRef): Promise<Gate<WorkRef>>;
  refreshIdentity?(todoId: string): Promise<void>;
  start(todoId: string): Ran;
  recompute(todo: NeoTodo, patch: NeoTodoPatch): Promise<NeoTodo>;
  proceed(todoId: string, message: string): Ran;
  retry(todoId: string): Ran;
  stop(todo: NeoTodo): Promise<string | null>;
}

const TodoPriority = z.enum(['low', 'normal', 'high', 'urgent']);

const TodoDraft = z.object({
  title: Text,
  check: TodoCheck,
  instruction: Text.nullable().default(null),
  target: NeoTodoTargetSchema.optional(),
  named: z.record(z.string(), z.unknown()).nullable().default(null),
  start: z.boolean().default(false),
  priority: TodoPriority.default('normal'),
  after: z
    .array(z.union([Text, z.number().int().min(0)]))
    .max(20)
    .optional()
    .describe(
      'Earlier steps of this ask this todo waits for: indexes of earlier todos in the same neo.ask.open call, or todo ids. [] lets it run alongside the others; omit it to wait for the step before it. The daemon starts each step once everything it waits for is done.'
    ),
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

const Add = TodoDraft.extend({
  askId: Text.optional().describe(
    'Only for follow-up work with no human input (worker reports, checks). For a human request pass input instead.'
  ),
  input: Text.optional().describe(
    'The [message id] of the human message this todo serves. The daemon picks its ask: the question or Neo message it replied to, else the ask opened for it, else a new one.'
  ),
  after: z
    .array(Text)
    .max(20)
    .optional()
    .describe(
      'Ids of todos in this ask this one waits for. [] lets it run alongside the others; omit it to wait for the step before it. The daemon starts it once everything it waits for is done.'
    ),
}).superRefine((input, context) => {
  refineNeoTodoDraft(input, context);
  if (!input.askId && !input.input)
    context.addIssue({
      code: 'custom',
      message: 'Pass input for a human request, or askId for follow-up work.',
    });
});

export type NeoTodoPolicy = {
  id: string;
  todos?: Pick<
    NonNullable<NeoPack['todos']>,
    'doneWhen' | 'addUrls' | 'refuse' | 'record' | 'repository'
  >;
};

export function planNeoTodoDraft<T extends Pick<NeoTodo, 'check' | 'instruction'>>(
  draft: T,
  packs: readonly NeoTodoPolicy[],
  peers: readonly NeoTodo[] = []
): Gate<T & { doneWhen: string; records?: string[] }> {
  const pack = draft.check && packs.find((item) => item.id === draft.check?.pack)?.todos;
  if (!draft.check || !pack)
    return fail('check_required: use a completion check from an installed pack.');
  const refused = pack?.refuse?.(draft, peers);
  if (refused) return fail(`check_refused: ${refused}`);
  const recorded = pack?.record?.(draft, peers);
  const doneWhen = pack.doneWhen?.(draft.check);
  if (!doneWhen) return fail(`check_unsupported: ${draft.check.pack}.${draft.check.kind}.`);
  return {
    value: {
      ...draft,
      doneWhen,
      ...(recorded ? { records: [recorded] } : {}),
    },
  };
}

export async function resolveNeoTodoDraft(
  input: z.infer<typeof NeoTodoDraftSchema>,
  resolveTarget: NeoTodoControls['resolveTarget']
): Promise<Gate<z.infer<typeof NeoTodoDraftSchema>>> {
  if (!input.target || input.target.verb === 'start') return { value: input };
  const resolved = await resolveTarget(input.target.ref);
  return 'reason' in resolved
    ? resolved
    : { value: { ...input, target: { ...input.target, ref: resolved.value } } };
}

export function neoTodoPlaceRefusal(
  target: z.infer<typeof NeoTodoTargetSchema> | undefined,
  repo: string | null | undefined
): string | null {
  return target?.verb === 'start' && !target.place && repo
    ? `place_required: coding work for ${repo} starts in its repository; pass target.place from work.find.`
    : null;
}

export async function addNeoTodo(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'start' | 'resolveTarget'>,
  ask: NeoAsk,
  input: z.infer<typeof NeoTodoDraftSchema>,
  packs: readonly NeoPack[],
  split = false
): Promise<{ ok: true; todo?: NeoTodo; records?: string[] } | Rejection> {
  const resolved = await resolveNeoTodoDraft(input, controls.resolveTarget);
  if ('reason' in resolved) return resolved.reason;
  const current = todos.getAsk(ask.id);
  if (!current) return { ok: false, reason: 'not_found: no such ask.' };
  return recordNeoTodo(todos, sessions, controls, current, resolved.value, packs, split);
}

export async function recordNeoTodo(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'start'>,
  ask: NeoAsk,
  input: z.infer<typeof NeoTodoDraftSchema>,
  packs: readonly NeoPack[],
  split = false
): Promise<{ ok: true; todo?: NeoTodo; records?: string[] } | Rejection> {
  const planned = planNeoTodoDraft(input, packs);
  if ('reason' in planned) return planned.reason;
  const draft = planned.value;
  const repo = neoTodoRepo(draft, packs, ask);
  const placeless = neoTodoPlaceRefusal(draft.target, repo);
  if (placeless) return { ok: false, reason: placeless };
  const home = neoTodoHome(todos, ask, repo, split || todos.listChildAsks(ask.id).length > 0);
  if (home.status !== 'open')
    return {
      ok: true,
      records: [`ask_settled: ${home.title} is settled; nothing was added.`],
    };
  const accepted = planNeoTodoDraft(draft, packs, todos.listTodos(home.id));
  if ('reason' in accepted) return accepted.reason;
  const records = accepted.value.records ? { records: accepted.value.records } : {};
  const refused = neoTodoAfterRefusal(
    todos.listFamilyTodos(home.id),
    null,
    draft.after,
    draft.start
  );
  if (refused) return { ok: false, reason: refused };
  const id = crypto.randomUUID();
  const dependsOn = draft.after
    ? planNeoTodoDependencies(todos.listFamilyTodos(home.id), id, draft.after.map(String))
    : null;
  if (typeof dependsOn === 'string')
    return { ok: false, reason: neoTodoDependencyRefusal(dependsOn) };
  const added = todos.addTodo(id, home.id, { ...draft, dependsOn }, Date.now(), repo);

  if (draft.target) sessions.create(added.id, draft.target);
  if (draft.start) return { ...(await controls.start(added.id)), ...records };
  if (added.instruction) joinNeoStartQuestion(todos, added);
  return { ok: true, todo: added, ...records };
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
        : todo.blockedBy === 'held'
          ? fail('todo_held: the human is holding this todo; release it first.')
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
  check: TodoCheck.optional(),
  doneWhen: Text.optional(),
  done: z.enum(['met', 'reported']).optional(),
  evidence: Text.optional(),
  artifacts: z.array(ArtifactRefSchema).min(1).max(16).optional(),
  priority: TodoPriority.optional(),
  instruction: Text.optional(),
  target: NeoTodoTargetSchema.optional(),
  hold: z
    .never({
      error: 'hold is its own operation: use neo.todo.hold {todoId, reason}; reason null releases.',
    })
    .optional(),
  after: z
    .array(Text)
    .max(20)
    .optional()
    .describe('Replace the todo ids this todo waits for; [] lets it run alongside the others.'),
});
type EditPlan = Omit<z.infer<typeof Edit>, 'hold'> & { hold?: string | null };

const Hold = z.object({
  todoId: Text,
  reason: Text.nullable().describe('Why it must wait; null releases it.'),
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
  blockedBy: z
    .enum([
      'check',
      'worker',
      'failure',
      'question',
      'needs-human',
      'environment',
      'stalled',
      'held',
    ])
    .nullable(),
  priority: TodoPriority,
  dependsOn: z.array(z.string()).nullable(),
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
  z.object({
    ok: z.literal(true),
    todo: NeoTodoSchema.optional(),
    todos: z.array(NeoTodoSchema),
    records: z.array(z.string()).optional(),
  }),
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

export function planNeoTodoEdit(todo: NeoTodo, input: EditPlan, now = Date.now()): Gate<TodoPlan> {
  if (todo.state === 'removed') return fail('todo_removed: this todo was removed.');
  if (input.done && !input.evidence)
    return fail('evidence_missing: ticking a todo needs evidence.');
  if (input.artifacts && !input.done)
    return fail('evidence_missing: artifacts are evidence; pass them with done.');
  if (input.after && todo.startedAt !== null)
    return fail(
      'already_started: what a started todo waits for cannot change; its worker is already running.'
    );
  const held = todo.state === 'blocked' && todo.blockedBy === 'held';
  if (!input.instruction !== !input.target)
    return fail('work_incomplete: give a todo work with instruction and target together.');
  if (
    input.instruction &&
    (todo.startedAt !== null || todo.instruction || !(isNeoTodoStartable(todo) || held))
  )
    return fail(
      'has_work: only a todo that has not started and has no instruction yet can be given work.'
    );
  if (input.hold !== undefined && (input.done || input.artifacts))
    return fail('hold_with_done: hold or release a todo separately from ticking it done.');
  if (input.hold && !isNeoTodoStartable(todo) && !held)
    return fail(
      `not_holdable: only a todo that has not started can be held; this one is ${todo.state}.`
    );
  if (input.hold === null && !held) return fail('not_held: this todo is not held.');
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
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.instruction ? { instruction: input.instruction } : {}),
        ...(input.hold
          ? {
              state: 'blocked',
              blockedBy: 'held',
              blockedReason: input.hold,
              nextAction: 'The human releases it.',
            }
          : {}),
        ...(input.hold === null ? { state: 'todo' } : {}),
        ...(input.after ? { dependsOn: input.after } : {}),
      },
    },
  };
}

export function requireNeoTodoArtifacts(
  plan: TodoPlan,
  registered: readonly (ArtifactRef | null)[]
): Gate<TodoPlan> {
  const unknown = unregisteredArtifact(plan.patch.artifacts ?? [], registered);
  return unknown
    ? fail(
        `invalid_artifact_reference: artifact "${unknown.artifactId}" is not one you can attach as given; pass the reference artifact.file.register or artifact.file.get returned.`
      )
    : { value: plan };
}

export function requireNeoTodoCardsAnswered<T extends TodoPlan>(
  plan: T,
  questions: readonly NeoQuestion[]
): Gate<T> {
  const card =
    (['done', 'closed_unverified'].includes(plan.patch.state ?? '') ||
      plan.patch.blockedBy === 'check') &&
    questions.find((question) => question.state === 'open' && question.todoId === plan.todo.id);
  return card
    ? fail(`card_unanswered: card ${card.id} is still waiting for the human.`)
    : { value: plan };
}

export function planNeoTodoRemove(
  todo: NeoTodo,
  todos: NeoTodo[],
  input: z.infer<typeof Remove>
): Gate<TodoPlan> {
  if (todo.state === 'removed') return fail('todo_removed: this todo was already removed.');
  const invalid =
    input.replacedBy &&
    !todos.some((other) => other.id === input.replacedBy && other.id !== todo.id);
  return {
    value: {
      todo,
      patch: {
        state: 'removed',
        reason: input.reason,
        replacedBy: invalid ? null : (input.replacedBy ?? null),
      },
      ...(invalid
        ? {
            records: [
              `replacement_missing: ${input.replacedBy} is not another todo on this ask; removal recorded without a replacement link.`,
            ],
          }
        : {}),
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
): Gate<TodoPlan> {
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
  project: <T extends NeoTodo>(todos: readonly T[]) => Promise<T[]> = async (todos) => [...todos],
  inputs: NeoInputReads = noNeoInputReads
) {
  const present = async (result: TodoReceipt | Rejection) => {
    if (!result.ok) return result;
    if (!result.todo) return { ...result, todos: await project(result.todos) };
    const [todo, ...todos] = await project([result.todo, ...result.todos]);
    return { ...result, todo, todos };
  };
  const completion = (plan: TodoPlan) =>
    plan.patch.state === 'done' ? readNeoTodoCompletion(packs(), plan.todo) : null;
  const cards = (plan: { todo: NeoTodo }) => todos.listQuestions(plan.todo.askId);
  const withCheck = (plan: TodoPlan, input: EditPlan): Gate<TodoPlan> => {
    if (!input.addUrls && !input.check) return { value: plan };
    const requested = { ...plan.todo, check: input.check ?? plan.todo.check };
    const pack = packs().find((pack) => pack.id === requested.check?.pack)?.todos;
    const appended = input.addUrls ? pack?.addUrls?.(requested, input.addUrls) : null;
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
      packs(),
      todos.listTodos(plan.todo.askId)
    );
    if ('reason' in accepted) return accepted;
    const records = [
      ...(accepted.value.records ?? []),
      ...(input.addUrls && !appended
        ? [
            `check_urls_unsupported: URLs recorded without changing the check: ${input.addUrls.join(', ')}`,
          ]
        : []),
      ...(input.doneWhen
        ? [
            `done_when_regenerated: doneWhen supplied with a check edit was replaced by the check's wording.`,
          ]
        : []),
    ];
    return {
      value: {
        todo: accepted.value,
        patch: { ...plan.patch, check, doneWhen: accepted.value.doneWhen },
        ...(records.length ? { records } : {}),
      },
    };
  };
  const write = async (plan: TodoPlan, input?: EditPlan): Promise<TodoReceipt | Rejection> => {
    const checked = plan.todo;
    if (input?.addUrls || input?.check || input?.hold !== undefined) {
      const latest = requireNeoOpenTodo(todos.getTodo(plan.todo.id), todos.getAsk(plan.todo.askId));
      if ('reason' in latest) return latest.reason;
      const edited = planNeoTodoEdit(latest.value, input);
      if ('reason' in edited) return edited.reason;
      const rebased = withCheck(edited.value, input);
      if ('reason' in rebased) return rebased.reason;
      plan = rebased.value;
    }
    if (
      ['done', 'closed_unverified'].includes(plan.patch.state ?? '') ||
      plan.patch.blockedBy === 'check'
    ) {
      const latest = requireNeoOpenTodo(todos.getTodo(plan.todo.id), todos.getAsk(plan.todo.askId));
      if ('reason' in latest) return latest.reason;
      if (!sameNeoTodoCheck(checked, input?.addUrls || input?.check ? plan.todo : latest.value))
        return {
          ok: false,
          reason: 'todo_changed: completion check changed; retry with the current check.',
        };
      const answered = requireNeoTodoCardsAnswered(plan, cards(plan));
      if ('reason' in answered) return answered.reason;
    }
    if (plan.patch.check) {
      const accepted = planNeoTodoDraft(plan.todo, packs(), todos.listTodos(plan.todo.askId));
      if ('reason' in accepted) return accepted.reason;
    }
    const todo = await controls.recompute(plan.todo, plan.patch);
    return {
      ok: true,
      todo,
      todos: todos.listTodos(todo.askId),
      ...(plan.records ? { records: plan.records } : {}),
    };
  };
  const stopAndWrite = async (plan: TodoPlan): Promise<TodoReceipt | Rejection> => {
    const failed = await controls.stop(plan.todo);
    return failed
      ? { ok: false, reason: `${failed}; the todo is unchanged, its session may still run.` }
      : write(plan);
  };
  const ran = async (
    result: Awaited<ReturnType<typeof addNeoTodo>>
  ): Promise<TodoReceipt | Rejection> =>
    result.ok
      ? { ...result, todos: result.todo ? todos.listTodos(result.todo.askId) : [] }
      : result;
  const admit = (ask: NeoAsk | null, todo?: NeoTodo) =>
    ask && ask.status !== 'open'
      ? {
          reason: {
            ok: true as const,
            ...(todo ? { todo } : {}),
            todos: todos.listTodos(ask.id),
            records: [`ask_settled: this ask is ${ask.status}; no change was made.`],
          },
        }
      : todo
        ? requireNeoOpenTodo(todo, ask)
        : requireNeoOpenAsk(ask);
  const owned = (pipeline: PipelineAPI) =>
    pipeline
      .input(['input', 'caller'])
      .pipe((input: { todoId: string }) => todos.getTodo(input.todoId), 'input', 'todo')
      .pipe((todo: NeoTodo | null) => (todo ? todos.getAsk(todo.askId) : null), 'todo', 'ask')
      .pipe(
        (todo: NeoTodo | null, ask: NeoAsk | null) =>
          todo ? admit(ask, todo) : requireNeoOpenTodo(todo, ask),
        ['todo', 'ask'],
        'result:outcome'
      );

  const add = (superpipe({})('neo.todo.add') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Add>, caller: OperationCaller) =>
        resolveNeoInputAsk(todos, inputs, caller, input, input.title),
      ['input', 'caller'],
      'binding'
    )
    .pipe(
      (binding: ReturnType<typeof resolveNeoInputAsk>) =>
        'reason' in binding ? binding : admit(todos.getAsk(binding.value.askId)),
      'binding',
      'result:outcome'
    )
    .pipe(
      async (
        ask: NeoAsk,
        input: z.infer<typeof Add>,
        binding: { value: { records: string[] } }
      ): Promise<TodoReceipt | Rejection> => {
        const result = await ran(await addNeoTodo(todos, sessions, controls, ask, input, packs()));
        const records = [...binding.value.records, ...((result.ok && result.records) || [])];
        return result.ok && records.length ? { ...result, records } : result;
      },
      ['outcome', 'input', 'binding'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Add>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const bind = owned(superpipe({})('neo.todo.bind') as PipelineAPI)
    .pipe(
      async (todo: NeoTodo, input: z.infer<typeof Bind>) => {
        const resolved = await controls.resolveTarget(input.ref);
        if ('reason' in resolved) return resolved.reason;
        const latest = todos.getTodo(todo.id);
        const current = requireNeoOpenTodo(latest, latest ? todos.getAsk(latest.askId) : null);
        if ('reason' in current) return current.reason;
        const previous = sessions.readRef(todo.id);
        const result = bindNeoTodo(todos, sessions, current.value, resolved.value);
        const ref = resolved.value;
        if (
          result.ok &&
          (previous?.id !== ref.id ||
            previous.adapter !== ref.adapter ||
            previous.daemon !== ref.daemon)
        )
          await controls.refreshIdentity?.(todo.id);
        return ran(result);
      },
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Bind>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const edit = owned(superpipe({})('neo.todo.edit') as PipelineAPI)
    .pipe(planNeoTodoEdit, ['outcome', 'input'], 'result:outcome')
    .pipe(
      (plan: { patch: NeoTodoPatch }, caller: OperationCaller) =>
        (plan.patch.artifacts ?? []).map((ref) => artifact(ref.artifactId, caller)),
      ['outcome', 'caller'],
      'registered'
    )
    .pipe(requireNeoTodoArtifacts, ['outcome', 'registered'], 'result:outcome')
    .pipe(withCheck, ['outcome', 'input'], 'result:outcome')
    .pipe(completion, 'outcome', 'completion')
    .pipe(requireNeoTodoMayFinish, ['outcome', 'completion'], 'result:outcome')
    .pipe(write, ['outcome', 'input'], 'outcome')
    .endAsync('outcome') as (
    input: EditPlan,
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
        'Add a todo to an open ask you own. For a human request, pass input (its [message id]) and the daemon picks the ask; never pick an ask yourself. askId alone is only for follow-up work with no human input; if both differ, the ask of the input wins and an ask_rebound record says so. A coding PR already tracked by another live todo on that ask is recorded without blocking; prefer continuing the original todo. neo.todo.edit addUrls only pins URLs to an existing PR-merge check. Pass title and a required check {pack, kind, params}; doneWhen is generated, never supplied. Use a completion check the installed pack supports; core.human_confirmed {questionId}, core.evidence {artifact: registered artifact ID} or {path: absolute file path}, or core.deployed {repo: lsm/HyperNeo, sha: full commit}. A pack may reject malformed checks or record bookkeeping conditions. Workers are long-lived sessions: name them for the matter, never a task title; use work.rename after starting if the session inherits this todo title. instruction is the task for a session and target says where it runs ({verb: start, adapter, place?} or {verb: send, ref}). Spell out the task: every step that needs work done gets its instruction and target when you add it; leave both out only for a step that just waits on its check, such as a merge or a deploy, since nothing runs a step without them. non-coding todos share one visible user folder across projects when place is omitted: ~/HyperNeo by default, or exactly the instance workspace path. A different place needs an exact path the user named in chat, even inside the workspace; never invent folders under home. Coding keeps its repository place. To give a running worker this task use target {verb: send, ref}; to attach work that is already doing it, add the todo without instruction or target and call neo.todo.bind {todoId, ref}; without them the daemon checks the todo itself. named records what the human named for it (engine, session, repository, folder). A session the human named is sent to only through the ref work.find {session} returns as an exact match. start:true starts it now; otherwise the daemon lists it, ticked, in the start question of the ask. priority (urgent, high, normal, low; default normal) orders waiting work, urgent first: set it from how urgent the human made it; it can change later with neo.todo.edit. Steps the human approved start themselves in order as worker slots free; do not start them yourself. A step added after the ask started still waits for its own start answer.',
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
        'Change a todo on an open ask you own: title or check {pack, kind, params}; the completion sentence is generated from the check, or reword it directly with doneWhen. addUrls appends PR URLs to its PR-merge check. Duplicate claims and URLs unsupported by the check are recorded without blocking the edit. Prefer editing to adding a duplicate PR todo. Or record completion evidence (done met for what you read, reported for a claim you cannot read); without a passed outcome check it stays open, blocked by its check, and finishes by itself once the check passes; attach a document or evidence file as the reference artifact.file.register returned in artifacts, with one sentence of evidence, not the pasted document. A todo with an unanswered card is refused until the human answers it. Worker final-line blockers are recorded automatically: needs_human opens a human reply card, so leave its worker waiting for the human; handle environment blockers by retrying or escalating their cause. To hold or release a todo use neo.todo.hold. priority changes where waiting work starts in the queue. instruction with target gives a todo that has not started and has no instruction its work; the queue then starts it like any approved step. A start target for a coding todo needs target.place from work.find.',
      inputSchema: Edit,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await edit(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.hold',
      description:
        'Hold a todo that has not started so nothing starts it: reason says why. reason null releases a held todo. Hold only what the human said must wait.',
      inputSchema: Hold,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) =>
        present(await edit({ todoId: input.todoId, hold: input.reason }, caller)),
    }),
    defineOperation({
      name: 'neo.todo.remove',
      description:
        'Remove a todo from an open ask you own, with the reason; its session stops if it is running, unless the todo only follows a session the human tracked. An invalid replacedBy is recorded while removal proceeds without a replacement link. replacedBy names the todo that replaces it. A removed todo stays listed, struck through.',
      inputSchema: Remove,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await remove(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.continue',
      description:
        "Send a started todo's session its next step. The todo goes back to doing until the session reports again. An unstarted todo or settled ask returns a record without dispatching or approving a start.",
      inputSchema: Continue,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await proceed(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.retry',
      description:
        'Retry a failed todo in place with a new attempt, keeping its todoId. A nonretryable todo or settled ask returns a record without dispatching. If it has a worker, send the original instruction to that worker; otherwise start its recorded target again. Do not remove and replace it. Choose the delivery channel or adapter for reaching the same worker session yourself; never ask the human to choose it. Ask the human before changing which worker or target does the work.',
      inputSchema: Retry,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await retry(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.close',
      description:
        'Close a todo with your reason. It is done only when its outcome check passes; otherwise it stays open, blocked by its check with the unmet reason, and finishes by itself once the check passes; if the check is wrong, fix it with neo.todo.edit check. Its session stops if it is running, unless the todo only follows a session the human tracked. A todo with an unanswered card is refused until the human answers it.',
      inputSchema: Close,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await close(input, caller)),
    }),
  ];
}
