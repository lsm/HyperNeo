import { neoToolDescription } from '@hyperneo/prompts';
import { hasPendingTodoDecision } from './proposal.ts';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  NeoAskTodoRepository,
  NeoQuestionDraft,
  NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { ArtifactRefSchema, unregisteredArtifact } from '../artifacts/file-contracts.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import { type Place, type WorkRef } from '../drivers/types.ts';
import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { getDataDir } from '../data-dir.ts';
import { neoEvidencePathRefusal } from './core-todo-checks.ts';
import { planNeoHoldCard } from './daemon-cards.ts';
import { openHumanCard } from './human-card.ts';
import { NeoTodoAddTargetSchema, NeoTodoTargetSchema } from './driver-work.ts';
import { type NeoInputReads, noNeoInputReads, resolveNeoInputAsk } from './input-ask.ts';
import {
  neoTodoRepository,
  type NeoPack,
  type NeoTodoPolicyScope,
  type NeoTodoRepositoryDraft,
} from './pack-contract.ts';
import { wireNeoTodoAdd } from './todo-add-operation.ts';
import {
  readNeoTodoCompletion,
  requireNeoTodoMayFinish,
  sameNeoTodoCheck,
} from './todo-completion.ts';
import {
  NEO_TODO_PREREQUISITE_UNFINISHED,
  neoTodoAfterRefusal,
  neoTodoDependencyRefusal,
  neoTodoFinished,
  planNeoTodoDependencies,
} from './todo-dependencies.ts';
import { isNeoTodoStartable, neoTodoFailed } from './todo-runner.ts';
import { neoTodoCovered } from './todo-state.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type TodoReceipt = { ok: true; todo?: NeoTodo; records?: string[] };
type TodoPlan = { todo: NeoTodo; patch: NeoTodoPatch; records?: string[] };

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

const Text = z.string().trim().min(1);

export const TodoCheck = z.object({
  pack: Text,
  kind: Text,
  params: z.record(z.string(), z.unknown()).default({}),
});

type Ran = Promise<{ ok: true; todo: NeoTodo; records?: string[] } | Rejection>;

export interface NeoTodoControls {
  userFolder?: string;
  resolveTarget(
    ref: WorkRef
  ): Promise<
    Gate<WorkRef> & { place?: Pick<Place, 'folder' | 'remotes'>; workerRemotes?: readonly string[] }
  >;
  refreshIdentity?(todoId: string): Promise<void>;
  advance(): Promise<unknown>;
  recompute(todo: NeoTodo, patch: NeoTodoPatch): Promise<NeoTodo>;
  proceed(todoId: string, message: string): Ran;
  retry(todoId: string, message?: string): Ran;
  stop(todo: NeoTodo): Promise<string | null>;
}

export type NeoTodoWorkerRead = (
  ref: WorkRef,
  resolveTarget: NeoTodoControls['resolveTarget']
) => ReturnType<NeoTodoControls['resolveTarget']>;

const TodoPriority = z.enum(['low', 'normal', 'high', 'urgent']);

const TodoDraft = z.object({
  title: Text,
  check: TodoCheck,
  instruction: Text.nullable().default(null),
  target: NeoTodoAddTargetSchema.optional(),
  named: z
    .record(z.string(), z.unknown())
    .refine((named) => named.desktopControl === undefined || named.desktopControl === true, {
      message: 'Use desktopControl: true only for a todo that needs the computer.',
    })
    .refine((named) => !('requestFrom' in named), {
      message:
        'Only the daemon records worker requests, when a session messages Neo. Leave requestFrom out of named.',
    })
    .nullable()
    .default(null),
  priority: TodoPriority.default('normal'),
  producesFollowUp: z
    .boolean()
    .optional()
    .describe(
      "True when this todo's result is more work: a design, plan, research or inventory. Once it finishes, its ask cannot settle done until a later todo exists (unstarted is fine). Add each follow-up with after: [this todo's id]."
    ),
  after: z
    .array(z.union([Text, z.number().int().min(0)]))
    .max(20)
    .describe(
      'Required. The earlier steps of this ask this todo waits for: indexes of earlier todos in the same neo.ask.open call, or todo ids. [] means it waits for nothing. The daemon starts each step once everything it waits for is done.'
    ),
});

function refineNeoTodoDraft(
  input: Pick<z.infer<typeof TodoDraft>, 'instruction' | 'target'>,
  context: z.RefinementCtx
): void {
  const message =
    input.target?.verb === 'bind'
      ? input.instruction &&
        'A bind target attaches work that is already running; leave instruction out.'
      : !input.instruction !== !input.target &&
        'A todo with an instruction needs a target, and a target needs an instruction.';
  if (message) context.addIssue({ code: 'custom', message });
}

export const NeoTodoDraftSchema = TodoDraft.superRefine(refineNeoTodoDraft);

const Add = TodoDraft.extend({
  askId: Text.optional().describe(
    'For a human request, pass input. When a plain human message (not a reply) continues an open ask you own, also pass that askId: the daemon records the message on that ask, and later calls with that input alone reach it. Without askId it opens a new ask. A session-request ask is for the reply only; open a separate proposal to do work.'
  ),
  input: Text.optional().describe(
    'The id on the `<human-message>` tag of the human message this todo serves. The daemon picks its ask: the question or Neo message it replied to, else the ask opened for it, else its recorded follow-up binding, else a new one.'
  ),
  after: z
    .array(Text)
    .max(20)
    .describe(
      'Required. Ids of the todos in this ask this one waits for. [] means it waits for nothing. The daemon starts it once everything it waits for is done.'
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

export type ResolvedNeoTodoDraft = z.infer<typeof NeoTodoDraftSchema> & {
  workerRemotes?: readonly string[];
  desktopControlApproved?: true;
};

export async function resolveNeoTodoDraft(
  input: z.infer<typeof NeoTodoDraftSchema>,
  resolveTarget: NeoTodoControls['resolveTarget']
): Promise<Gate<ResolvedNeoTodoDraft>> {
  if (!input.target || input.target.verb === 'start') return { value: input };
  const resolved = await resolveTarget(input.target.ref);
  return 'reason' in resolved
    ? resolved
    : {
        value: {
          ...input,
          target: { ...input.target, ref: resolved.value },
          workerRemotes: resolved.workerRemotes,
        },
      };
}

export function neoTodoPlaceRefusal(
  draft: NeoTodoRepositoryDraft & Pick<NeoTodo, 'instruction'>,
  packs: readonly NeoTodoPolicy[],
  scope: NeoTodoPolicyScope
): string | null {
  return (
    packs
      .filter((pack) => pack.todos?.repository)
      .map((pack) => pack.todos?.refuse?.(draft, [], scope))
      .find(Boolean) ?? null
  );
}

export const neoTodoBindRefusal = (
  target: ResolvedNeoTodoDraft['target'],
  family: readonly NeoTodo[],
  dependsOn: readonly string[]
) =>
  target?.verb === 'bind' &&
  !dependsOn.every((id) => neoTodoFinished(family.find((todo) => todo.id === id)))
    ? NEO_TODO_PREREQUISITE_UNFINISHED
    : null;

export function recordNeoTodoTarget(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  todo: NeoTodo,
  target: NonNullable<ResolvedNeoTodoDraft['target']>,
  now: number
): NeoTodo {
  if (target.verb !== 'bind') {
    sessions.create(todo.id, target);
    return todo;
  }
  sessions.bind(todo.id, target.ref, now);
  return todos.updateTodo(todo, { state: 'doing', startedAt: now }, now);
}

export async function addNeoTodo(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'advance' | 'resolveTarget' | 'userFolder'>,
  ask: NeoAsk,
  input: ResolvedNeoTodoDraft,
  packs: readonly NeoPack[]
): Promise<{ ok: true; todo?: NeoTodo; records?: string[] } | Rejection> {
  const resolved = await resolveNeoTodoDraft(input, controls.resolveTarget);
  if ('reason' in resolved) return resolved.reason;
  const current = todos.getAsk(ask.id);
  if (!current) return { ok: false, reason: 'not_found: no such ask.' };
  return recordNeoTodo(todos, sessions, controls, current, resolved.value, packs);
}

export async function recordNeoTodo(
  todos: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'advance' | 'userFolder'>,
  ask: NeoAsk,
  input: ResolvedNeoTodoDraft,
  packs: readonly NeoPack[]
): Promise<{ ok: true; todo?: NeoTodo; records?: string[] } | Rejection> {
  const id = crypto.randomUUID();
  const planned = planNeoTodoDraft(input, packs);
  if ('reason' in planned) return planned.reason;
  const draft = planned.value;
  const peers = todos.listTodos(ask.id);
  const scope = { ask, workerRemotes: input.workerRemotes };
  const repo = neoTodoRepository(draft, packs, scope);
  const placeless = neoTodoPlaceRefusal(draft, packs, scope);
  if (placeless) return { ok: false, reason: placeless };
  const misplaced = neoEvidencePathRefusal(input.check, null, getDataDir());
  if (misplaced) return { ok: false, reason: misplaced };
  if (ask.status !== 'open')
    return {
      ok: true,
      records: [`ask_settled: ${ask.title} is settled; nothing was added.`],
    };
  const accepted = planNeoTodoDraft(draft, packs, peers);
  if ('reason' in accepted) return accepted.reason;
  const records = accepted.value.records ? { records: accepted.value.records } : {};
  const refused = neoTodoAfterRefusal(todos.listFamilyTodos(ask.id), null, draft.after);
  if (refused) return { ok: false, reason: refused };
  const dependsOn = planNeoTodoDependencies(
    todos.listFamilyTodos(ask.id),
    id,
    draft.after.map(String)
  );
  if (typeof dependsOn === 'string')
    return { ok: false, reason: neoTodoDependencyRefusal(dependsOn) };
  const unfinished = neoTodoBindRefusal(draft.target, todos.listFamilyTodos(ask.id), dependsOn);
  if (unfinished) return { ok: false, reason: unfinished };
  const now = Date.now();
  const inserted = todos.addTodo(id, ask.id, { ...draft, dependsOn, approvedAt: now }, now, repo);
  const added = draft.target
    ? recordNeoTodoTarget(todos, sessions, inserted, draft.target, now)
    : inserted;
  if (added.instruction) await controls.advance();
  return { ok: true, todo: todos.getTodo(added.id) ?? added, ...records };
}

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
  reason: Text.nullable().describe('Why this step waits; null releases it.'),
  decision: z.boolean().optional().describe('Ask the human to start, resume or remove this step.'),
});

export const neoHoldNeedsDecision = (input: { reason: string | null; decision?: boolean }) =>
  input.reason !== null && input.decision === true;

const Remove = z.object({
  todoId: Text,
  reason: Text,
  replacedBy: Text.optional(),
  dependents: z
    .enum(['continue', 'remove'])
    .optional()
    .describe(
      'What the unstarted todos that wait for this one do: continue without it, or be removed too. Leave it out when the human has not said; they then wait, and deciding is your next step.'
    ),
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
  state: z.enum(['todo', 'doing', 'blocked', 'done', 'removed']),
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
  approvedAt: z.number().nullable(),
  approvalQuestionId: z.string().nullable(),
  producesFollowUp: z.literal(true).optional(),
  report: z.string().nullable(),
  evidence: z.string().nullable(),
  artifacts: z.array(ArtifactRefSchema).readonly().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

export const TodoResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    todo: NeoTodoSchema.optional(),
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

export function requireNeoHoldCardClear(
  todo: NeoTodo,
  input: { hold?: string | null },
  cards: readonly NeoQuestion[]
): Gate<NeoTodo> {
  return input.hold != null && neoTodoCovered(todo, cards)
    ? fail('already_waiting: this todo already waits on an open card; answer that one.')
    : { value: todo };
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
  if (input.hold && !isNeoTodoStartable(todo) && todo.state !== 'doing' && !held)
    return fail(
      `not_holdable: only a waiting or running todo can be held; this one is ${todo.state}.`
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
              nextAction: 'Release it when ready.',
            }
          : {}),
        ...(input.hold === null
          ? todo.startedAt === null
            ? { state: 'todo' }
            : {
                state: 'blocked',
                blockedBy: 'worker',
                blockedReason: 'The hold was released.',
                nextAction: 'Continue the worker.',
              }
          : {}),
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
        `invalid_artifact_reference: artifact "${unknown.artifactId}" is not one you can attach as given; pass the original reference artifact.file.get returned; working files use their absolute path.`
      )
    : { value: plan };
}

export function requireNeoTodoCardsAnswered<T extends TodoPlan>(
  plan: T,
  questions: readonly NeoQuestion[]
): Gate<T> {
  const card =
    (plan.patch.state === 'done' || plan.patch.blockedBy === 'check') &&
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
    (!todos.some(
      (other) => other.id === input.replacedBy && other.id !== todo.id && other.state !== 'removed'
    ) ||
      typeof planNeoTodoDependencies(todos, todo.id, [input.replacedBy]) === 'string');
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

const Continue = z.object({ todoId: Text, message: Text.optional() });

const Done = z.object({ todoId: Text, reason: Text.optional() });

export function planNeoTodoDone(
  todo: NeoTodo,
  input: z.infer<typeof Done>,
  now = Date.now()
): Gate<TodoPlan> {
  if (!['todo', 'doing', 'blocked'].includes(todo.state))
    return fail(`todo_not_live: this todo is ${todo.state}.`);
  return {
    value: {
      todo,
      patch: {
        state: 'done',
        finishedAt: now,
        ...(input.reason ? { evidence: input.reason } : {}),
      },
    },
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
    if (!result.ok || !result.todo) return result;
    const [todo] = await project([result.todo]);
    return { ...result, todo };
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
      const clear = requireNeoHoldCardClear(
        latest.value,
        input,
        input.hold != null ? todos.todoCards(latest.value) : []
      );
      if ('reason' in clear) return clear.reason;
      if (input.hold != null && checked.startedAt !== latest.value.startedAt)
        return { ok: false, reason: 'todo_changed: the worker changed; retry the hold.' };
      const edited = planNeoTodoEdit(latest.value, input);
      if ('reason' in edited) return edited.reason;
      const rebased = withCheck(edited.value, input);
      if ('reason' in rebased) return rebased.reason;
      plan = rebased.value;
    }
    if (plan.patch.state === 'done' || plan.patch.blockedBy === 'check') {
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
      ...(plan.records ? { records: plan.records } : {}),
    };
  };
  const stopAndWrite = async (plan: TodoPlan): Promise<TodoReceipt | Rejection> => {
    const failed = await controls.stop(plan.todo);
    return failed
      ? { ok: false, reason: `${failed}; the todo is unchanged, its session may still run.` }
      : write(plan);
  };
  const admit = (ask: NeoAsk | null, todo?: NeoTodo) =>
    ask && ask.status !== 'open'
      ? {
          reason: {
            ok: true as const,
            ...(todo ? { todo } : {}),
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
      (binding: Awaited<ReturnType<typeof resolveNeoInputAsk>>) =>
        'reason' in binding ? binding : admit(todos.getAsk(binding.value.askId)),
      'binding',
      'result:outcome'
    )
    .pipe(
      async (ask: NeoAsk, input: z.infer<typeof Add>): Promise<TodoReceipt | Rejection> =>
        addNeoTodo(todos, sessions, controls, ask, input, packs()),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Add>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const edit = owned(superpipe({})('neo.todo.edit') as PipelineAPI)
    .pipe(
      (todo: NeoTodo, input: EditPlan) =>
        requireNeoHoldCardClear(todo, input, input.hold != null ? todos.todoCards(todo) : []),
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
    .pipe(withCheck, ['outcome', 'input'], 'result:outcome')
    .pipe(completion, 'outcome', 'completion')
    .pipe(requireNeoTodoMayFinish, ['outcome', 'completion'], 'result:outcome')
    .pipe(
      async (plan: TodoPlan, input: EditPlan): Promise<Gate<TodoPlan>> => {
        const failed =
          input.hold && plan.todo.startedAt !== null ? await controls.stop(plan.todo) : null;
        return failed
          ? fail(`${failed}; the todo is unchanged, its session may still run.`)
          : { value: plan };
      },
      ['outcome', 'input'],
      'result:outcome'
    )
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
      (todo: NeoTodo): Gate<NeoTodo> =>
        hasPendingTodoDecision(todos.listQuestions(todo.askId), todo.id)
          ? fail('human_decision_required: the human must answer this work decision.')
          : { value: todo },
      'outcome',
      'result:outcome'
    )
    .pipe(
      (todo: NeoTodo, input: z.infer<typeof Continue>): Gate<NeoTodo> =>
        input.message || neoTodoFailed(todo)
          ? { value: todo }
          : fail('message_required: say what its session should do next.'),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      async (todo: NeoTodo): Promise<Gate<NeoTodo>> => {
        const ref = todo.startedAt === null ? null : sessions.readRef(todo.id);
        if (!ref) return { value: todo };
        const resolved = await controls.resolveTarget(ref);
        const reason = neoTodoPlaceRefusal(
          { ...todo, target: { verb: 'send', ref: 'value' in resolved ? resolved.value : ref } },
          packs(),
          {
            ask: todos.getAsk(todo.askId),
            todo,
            workerRemotes: 'value' in resolved ? resolved.workerRemotes : undefined,
          }
        );
        if (!reason) return { value: todo };
        return 'reason' in resolved ? resolved : fail(reason);
      },
      'outcome',
      'result:outcome'
    )
    .pipe(
      (todo: NeoTodo, input: z.infer<typeof Continue>) =>
        neoTodoFailed(todo)
          ? controls.retry(todo.id, input.message)
          : controls.proceed(todo.id, input.message!),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Continue>,
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const holdCard = owned(superpipe({})('neo.todo.hold') as PipelineAPI)
    .pipe(
      (
        todo: NeoTodo,
        input: { reason: string }
      ): Gate<{ todo: NeoTodo; draft: NeoQuestionDraft }> => {
        const plan = planNeoHoldCard(todo, todos.todoCards(todo), input.reason);
        return 'reason' in plan ? fail(plan.reason) : { value: { todo, draft: plan.value } };
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      async ({ todo, draft }: { todo: NeoTodo; draft: NeoQuestionDraft }) => {
        const failed = todo.startedAt === null ? null : await controls.stop(todo);
        if (failed)
          return {
            ok: false as const,
            reason: `${failed}; the todo is unchanged, its session may still run.`,
          };
        const card = openHumanCard(todos, crypto.randomUUID(), todo.askId, draft, Date.now());
        await controls.advance();
        return {
          ok: true as const,
          todo: todos.getTodo(todo.id) ?? todo,
          records: [`held: card ${card.id} holds it until the human answers.`],
        };
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: { todoId: string; reason: string },
    caller: OperationCaller
  ) => Promise<TodoReceipt | Rejection>;

  const definitions = [
    defineOperation({
      name: 'neo.todo.add',
      description: neoToolDescription('neo.todo.add'),
      inputSchema: Add,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await add(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.edit',
      description: neoToolDescription('neo.todo.edit'),
      inputSchema: Edit,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await edit(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.hold',
      description: neoToolDescription('neo.todo.hold'),
      inputSchema: Hold,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) =>
        present(
          neoHoldNeedsDecision(input)
            ? await holdCard({ todoId: input.todoId, reason: input.reason! }, caller)
            : await edit({ todoId: input.todoId, hold: input.reason }, caller)
        ),
    }),
    defineOperation({
      name: 'neo.todo.remove',
      description: neoToolDescription('neo.todo.remove'),
      inputSchema: Remove,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await remove(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.continue',
      description: neoToolDescription('neo.todo.continue'),
      inputSchema: Continue,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await proceed(input, caller)),
    }),
    defineOperation({
      name: 'neo.todo.done',
      description: neoToolDescription('neo.todo.done'),
      inputSchema: Done,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async () => {
        throw new Error('neo.todo.done runs through the todo writer');
      },
    }),
  ];
  return wireNeoTodoAdd(definitions, todos, sessions, controls, packs, project, inputs);
}
