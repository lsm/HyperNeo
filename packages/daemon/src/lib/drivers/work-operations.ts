import { neoToolDescription } from '@hyperneo/prompts';
import type { WorkerInput } from '../../storage/repositories/worker-input-worker.ts';
import {
  compactBeforeReuse,
  planCleanWorker,
  type WorkerReuseReason,
} from './worker-compaction.ts';
import { withWorkerProvenance } from './worker-provenance.ts';
import type { DriverHealth } from '@hyperneo/shared/types/settings';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { RemoteNotSentError } from '../remote-daemons/registry.ts';
import { qualifyRemoteOrigin } from '../mailbox/address.ts';
import { selectMessageOrigin, selectSendOrigin } from '../messaging/message-send.ts';
import {
  replyMessageBodyLength,
  REPLY_ORIGIN_MAX,
  withReplyLine,
  withReplySender,
} from '../messaging/session-reply.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import type { NeoDeliveryTarget } from '../neo/driver-work.ts';
import type { RemoteDaemons } from './find-operation.ts';
import { stampWork } from './places.ts';
import { workStartConfiguration } from './start-configuration.ts';
import { workStartPreparation } from './start-preparation.ts';
import { DESKTOP_WORKER_TEMPLATE_KEY } from '../desktop/worker-profile.ts';
import {
  reuseWorkerDecision,
  matchingPreparation,
  type WorkerReuseCandidate,
  type WorkerReuseFacts,
} from './worker-reuse.ts';
import {
  COPILOT_ADAPTER_ID,
  COPILOT_DESKTOP_UNAVAILABLE,
  CopilotClientSchema,
  CopilotStartClientSchema,
  PlaceSchema,
  WorkDetailSchema,
  WorkDeliverySchema,
  WorkInputReceiptSchema,
  WorkRefSchema,
  WorkTurnFactSchema,
  WorkStartedSchema,
  workResultSchema,
  type Rejected,
  type Result,
  type WorkSummary,
  type WorkAdapter,
  type StartRequest,
  type WorkRef,
  type WorkRejection,
} from './types.ts';

type RoutedVerb =
  | 'start'
  | 'rename'
  | 'send'
  | 'steer'
  | 'queue'
  | 'withdraw'
  | 'status'
  | 'turns'
  | 'stop'
  | 'archive';
type Route<Verb extends RoutedVerb> =
  | { daemon: string; verifiedCopilotStart?: true }
  | {
      local: NonNullable<WorkAdapter[Verb]>;
      supportsStartEffort?: boolean;
      supportsStartPreparation?: boolean;
    };
type Gate<Value> = { value: Value } | { reason: Rejected };

export interface WorkSendUncertainty {
  id: string;
  ref: WorkRef;
  from: string;
  detail: string;
  lastCompletion?: number;
}

const WORKER_BUSY_DETAIL = {
  message:
    'This worker is busy with other work. The todo waits in the queue with its reason, and this message goes when the worker is free; do not send it again.',
  instruction:
    'This worker is busy with other work. The todo waits in the queue with its reason, and its existing instruction goes when the worker is free. Your message text was not kept.',
  none: 'This worker is busy with other work, and this todo is not waiting to start, so it cannot queue here. Nothing was queued or sent.',
};

export interface WorkVerbDeps {
  adapters(): readonly WorkAdapter[];
  health?: () => Record<string, DriverHealth> | Promise<Record<string, DriverHealth>>;
  remote: RemoteDaemons;
  daemonName: string;
  qualifyReplyOrigin?: (from: string) => string;
  freeWorkers?: (
    adapter: string,
    todoId?: string,
    sessionId?: string
  ) =>
    | ReadonlySet<string>
    | ReadonlyMap<string, WorkerReuseFacts>
    | Promise<ReadonlySet<string> | ReadonlyMap<string, WorkerReuseFacts>>;
  workerTemplate?: (ref: WorkRef) => string | undefined;
  reusePolicy?: (
    adapter: string,
    todoId: string | undefined,
    caller: OperationCaller
  ) => Promise<{ mode: 'long_lived' | 'per_ask' | 'per_todo'; sameAsk: string[] }>;
  roleContext?: (
    todoId: string,
    adapter: string,
    preparationPack?: string
  ) => Promise<{
    roles: {
      role: string;
      adapter: string;
      id: string;
      model: string | null;
      effort: string | null;
    }[];
    preparations: { id: string; preparation: string | null }[];
    shares: Record<string, { shareWith?: readonly string[] }>;
    perRoundFields: readonly string[];
  }>;
  markUnusable?: (ref: WorkRef, reason: string) => void | Promise<void>;
  warn?: (message: string, error: unknown) => void;
  claimWorker?: (
    ref: WorkRef,
    todoId?: string,
    role?: string,
    model?: string,
    effort?: string,
    shareWith?: readonly string[]
  ) => Promise<boolean>;
  unclaimWorker?: (todoId: string, ref: WorkRef, role?: string) => Promise<void>;
  recordWorkerReuse?: (
    todoId: string,
    value: { worker: WorkRef; result: 'compacted' | 'fresh'; reason?: WorkerReuseReason }
  ) => Promise<void>;
  isOpenTodo?: (todoId: string, sessionId: string) => boolean;
  acceptedTodo?: (todoId: string) => boolean;
  noticeReply?: (ref: WorkRef, sessionId: string) => boolean;
  todoWorker?: {
    on(todoId: string, ref: WorkRef): boolean;
    wait(todoId: string, ref: WorkRef, message: string): Promise<keyof typeof WORKER_BUSY_DETAIL>;
  };
  workInputs?: {
    accept(
      todoId: string | null,
      from: string,
      target: WorkTarget,
      message: string
    ): Promise<string>;
    recordOutcome(id: string, target: WorkTarget, outcome: StartResult | SendResult): Promise<void>;
    recordFailure(id: string, error: unknown): Promise<void>;
    retarget?(id: string, ref: WorkRef | null): Promise<void>;
  };
  queueInput?: (input: WorkerInput, from: string, caller: OperationCaller) => Promise<string>;
  recordStarted?: (
    ref: WorkRef,
    directory?: string,
    facts?: {
      startedBy: string;
      todoId?: string;
      machine: string;
      folder?: string;
      harness: string;
      provider?: string;
      model?: string;
      effort?: string;
      preparation?: unknown;
      role?: string;
    }
  ) => void | Promise<void>;
  reportUncertain?: (report: WorkSendUncertainty) => Promise<void>;
  preparePlanCheck?: (input: StartInput, caller: OperationCaller) => Promise<Gate<StartInput>>;
  startPlace?: (input: StartDraft, caller: OperationCaller) => Gate<StartInput>;
}

export const WORK_MESSAGE_MAX = 20_000;
const MessageSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((message, ctx) => {
    if (replyMessageBodyLength(message) > WORK_MESSAGE_MAX)
      ctx.addIssue({
        code: 'too_big',
        origin: 'string',
        maximum: WORK_MESSAGE_MAX,
        inclusive: true,
      });
  });
const REMOTE_START_TIMEOUT_MS = 360_000;
const REUSE_HOLD_MS = 60_000;
const reuseHolds = new Set<string>();
const REMOTE_SEND_TIMEOUT_MS = 180_000;
const ForwardedOriginSchema = z.string().min(1).max(REPLY_ORIGIN_MAX).optional();

export const WORK_START_EXCLUDE_REFS_MAX = 30;

export const StartWorkInputSchema = z.object({
  checkPlan: z.literal(true).optional(),
  todoId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Agents must provide an open todo on an accepted human request.'),
  role: z
    .enum(['do', 'review', 'verify', 'check'])
    .optional()
    .describe('Role on the todo: do, review, verify or check. Defaults to do.'),
  adapter: z.string().min(1),
  copilotClient: CopilotStartClientSchema.optional(),
  place: PlaceSchema.optional(),
  title: z.string().trim().min(1).max(200),
  sessionTitle: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'For a Codex start, set a generic sessionTitle, never the task title. When omitted, the driver assigns the next free generic project name.'
    ),
  message: z.string().trim().min(1).max(100_000),
  excludeRefs: z.array(WorkRefSchema).max(WORK_START_EXCLUDE_REFS_MAX).optional(),
  createFolder: z.boolean().optional(),
  provenance: z.boolean().optional(),
  preparation: workStartPreparation.schema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  provider: z.string().trim().min(1).max(200).optional(),
  effort: workStartConfiguration.schema.shape.effort,
  from: ForwardedOriginSchema,
});
export const SendWorkInputSchema = z.object({
  todoId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('The open todo on an accepted human request this send belongs to.'),
  notice: z
    .literal(true)
    .optional()
    .describe('A Neo reply to a session that sent it a message; omit todoId.'),
  ref: WorkRefSchema,
  message: MessageSchema,
  mode: z.enum(['auto', 'steer', 'queue']).optional(),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('A repeat with the same key does not reach a HyperNeo session twice.'),
  from: ForwardedOriginSchema,
});
export const WorkRefInputSchema = z.object({ ref: WorkRefSchema });
const TurnCursorSchema = z.object({
  seq: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
});
const isTurnCursor = (cursor: string) => {
  try {
    return TurnCursorSchema.safeParse(JSON.parse(cursor)).success;
  } catch {
    return false;
  }
};
const WorkTurnsInputSchema = z.object({
  ref: WorkRefSchema,
  cursor: z.string().min(1).max(200).refine(isTurnCursor).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
const WorkTurnsResultSchema = workResultSchema(z.object({ turns: z.array(WorkTurnFactSchema) }));
const WithdrawWorkInputSchema = z.object({
  ref: WorkRefSchema,
  queuedSubmissionId: z.string().min(1).max(500),
  from: ForwardedOriginSchema,
});
const WithdrawWorkResultSchema = workResultSchema(
  z.object({
    queuedSubmissionId: z.string().min(1),
    withdrawn: z.boolean(),
    reason: z.literal('not_queued').optional(),
  })
);
export const WorkStatusInputSchema = z.object({
  ref: WorkRefSchema,
  since: z.number().int().min(0).optional(),
  receipt: WorkInputReceiptSchema.optional(),
});

export const StartWorkResultSchema = workResultSchema(WorkStartedSchema);
export const SendWorkResultSchema = workResultSchema(WorkDeliverySchema);
export const WorkStatusResultSchema = workResultSchema(WorkDetailSchema);
export const StopWorkResultSchema = workResultSchema(z.object({ stopped: z.boolean() }));
const RenameWorkInputSchema = z.object({
  ref: WorkRefSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, 'Use a single-line plain text title.'),
});
const RenameWorkResultSchema = workResultSchema(
  z.object({ renamed: z.literal(true), title: z.string() })
);
type RenameInput = z.infer<typeof RenameWorkInputSchema>;

const RoutedCapabilitySchema = z.enum([
  'rename',
  'find',
  'start',
  'send',
  'steer',
  'queue',
  'withdraw',
  'status',
  'turns',
  'stop',
  'archive',
]);

export const WorkDriverHealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unavailable']),
  reason: z.string(),
  clientVersions: z.record(z.string(), z.string()),
  checkedAt: z.number(),
  unverifiedVersion: z.boolean(),
  verifiedVersions: z.record(z.string(), z.string()).optional(),
  verifiedAt: z.number().optional(),
  verifiedJourney: z.string().optional(),
});

export const WorkAdaptersResultSchema = workResultSchema(
  z.array(
    z.object({
      id: z.string(),
      displayName: z.string().optional(),
      copilotClients: z.array(CopilotClientSchema).optional(),
      capabilities: z.array(RoutedCapabilitySchema),
      steerBehavior: z.literal('best_effort').optional(),
      health: WorkDriverHealthSchema.optional(),
      unsupportedCapabilities: z.partialRecord(RoutedCapabilitySchema, z.string()).optional(),
    })
  )
);

type StartDraft = z.infer<typeof StartWorkInputSchema>;
type StartInput = StartDraft & { place: z.infer<typeof PlaceSchema> } & Pick<
    StartRequest,
    'inPlace' | 'prepareFolder'
  > & { planStepIds?: string[] };
type SendInput = z.infer<typeof SendWorkInputSchema>;
type WorkTarget = NeoDeliveryTarget;
type RefInput = z.infer<typeof WorkRefInputSchema>;
type StatusInput = z.infer<typeof WorkStatusInputSchema>;
type StartResult = z.infer<typeof StartWorkResultSchema>;
type SendResult = z.infer<typeof SendWorkResultSchema>;
type StatusResult = z.infer<typeof WorkStatusResultSchema>;
type StopResult = z.infer<typeof StopWorkResultSchema>;

function ownedTodoId(
  input: StartInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
): string | undefined {
  return input.todoId &&
    (caller.source === 'internal' ||
      (!!caller.sessionId && deps.isOpenTodo?.(input.todoId, caller.sessionId)))
    ? input.todoId
    : undefined;
}

function neoTodoRecords(
  input: StartDraft | QueuedInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
): string[] {
  return !('message' in input) ||
    caller.role !== 'neo' ||
    caller.source === 'internal' ||
    (input.todoId && caller.sessionId && deps.isOpenTodo?.(input.todoId, caller.sessionId))
    ? []
    : [
        'todo_required: this work has no todo belonging to an open ask owned by this session. Recorded without blocking delivery. Use neo.todo.add or reference an open todoId to track it.',
      ];
}

function requireSendPurpose<Value>(
  input: QueuedInput,
  caller: OperationCaller,
  route: Value,
  deps: WorkVerbDeps
): Gate<Value> {
  const named =
    'message' in input &&
    !!input.todoId &&
    (caller.source === 'internal' ||
      (!!caller.sessionId && deps.isOpenTodo?.(input.todoId, caller.sessionId)));
  return 'message' in input && caller.role === 'neo' && (input.notice ? !!input.todoId : !named)
    ? {
        reason: {
          ok: false,
          reason: 'todo_required',
          detail:
            'A Neo send must name an open todo of this session or set notice: true, not both.',
          notSent: true,
        },
      }
    : { value: route };
}

function workSourceFacts(
  input: StartDraft | QueuedInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) {
  const agent = caller.source === 'mcp' && caller.device?.kind !== 'daemon';
  if (!agent || !('message' in input)) return { required: false, todo: false, notice: false };
  return {
    required: true,
    todo:
      !!input.todoId &&
      !!deps.acceptedTodo?.(input.todoId) &&
      (caller.role !== 'neo' ||
        (!!caller.sessionId && !!deps.isOpenTodo?.(input.todoId, caller.sessionId))),
    notice: !!(
      'ref' in input &&
      input.notice &&
      !input.todoId &&
      caller.role === 'neo' &&
      caller.sessionId &&
      deps.noticeReply?.(input.ref, caller.sessionId)
    ),
  };
}

function requireWorkSource<Value>(
  facts: ReturnType<typeof workSourceFacts>,
  value: Value
): Gate<Value> {
  return !facts.required || facts.todo || facts.notice
    ? { value }
    : {
        reason: reject(
          'todo_required',
          'Work needs a todo on an accepted human request; notices may only reply to a session that messaged Neo.',
          true
        ),
      };
}

export const isBusyWork = (status: string | undefined) =>
  status === 'running' || status === 'queued';

async function requireFreeWorker<Value>(
  input: QueuedInput,
  caller: OperationCaller,
  route: Value,
  deps: WorkVerbDeps
): Promise<{ value: Value } | { reason: SendResult }> {
  const todoId = 'message' in input && caller.role === 'neo' ? input.todoId : undefined;
  const queue = deps.todoWorker;
  if (!todoId || !queue || input.ref.adapter === 'space' || queue.on(todoId, input.ref))
    return { value: route };
  const status = routeStatus(input, deps);
  if ('reason' in status) return { value: route };
  const worker = await readWorkStatus(status.value, { ref: input.ref }, deps);
  if (!worker.ok || !isBusyWork(worker.value.status)) return { value: route };
  const queued = await queue.wait(todoId, input.ref, (input as SendInput).message);
  return { reason: reject('worker_busy', WORKER_BUSY_DETAIL[queued], true) };
}

const workTarget = (input: StartInput | SendInput): WorkTarget =>
  'ref' in input
    ? { verb: 'send', ref: input.ref }
    : {
        verb: 'start',
        ...(input.planStepIds ? { planStepIds: input.planStepIds } : {}),
        ...(input.place.daemon && !input.checkPlan && (input.role ?? 'do') === 'do'
          ? { role: 'do' as const }
          : {}),
        adapter: input.adapter,
        place: input.place,
        ...(input.createFolder === undefined ? {} : { createFolder: input.createFolder }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      };

const acceptWorkInput = (
  input: StartInput | QueuedInput,
  from: string,
  caller: OperationCaller,
  deps: WorkVerbDeps,
  records: string[] = []
) =>
  'message' in input && caller.role === 'neo'
    ? deps.workInputs?.accept(
        records.length ? null : (input.todoId ?? null),
        from,
        workTarget(input),
        input.message
      )
    : undefined;

async function recordThrownWork<T>(
  work: () => Promise<T>,
  inputId: string | undefined,
  deps: WorkVerbDeps
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (inputId) await deps.workInputs?.recordFailure(inputId, error);
    throw error;
  }
}

async function recordWorkOutcome<T extends StartResult | QueuedResult>(
  inputId: string | undefined,
  input: StartInput | QueuedInput,
  outcome: T,
  deps: WorkVerbDeps
): Promise<T> {
  if (inputId)
    await deps.workInputs?.recordOutcome(
      inputId,
      workTarget(input as StartInput | SendInput),
      outcome as StartResult | SendResult
    );
  return outcome;
}

function withTodoRecords<T>(outcome: Result<T>, records: string[]): Result<T> {
  return outcome.ok && records.length
    ? { ...outcome, records: [...(outcome.records ?? []), ...records] }
    : outcome;
}

function qualifyWorkOrigin(from: string, deps: WorkVerbDeps): string {
  return deps.qualifyReplyOrigin?.(from) ?? qualifyRemoteOrigin(from, deps.daemonName);
}

export function workReplyInput<
  T extends StartInput | SendInput | z.infer<typeof WithdrawWorkInputSchema>,
>(input: T, from: string, caller: OperationCaller, deps: WorkVerbDeps): T {
  const adapter = 'adapter' in input ? input.adapter : input.ref.adapter;
  if (!('message' in input) || caller.role !== 'neo' || ['hyperneo', 'space'].includes(adapter))
    return input;
  const remote = 'place' in input ? input.place.daemon : input.ref.daemon;
  return {
    ...input,
    message: withReplyLine(
      input.message,
      remote ? qualifyWorkOrigin(from, deps) : from,
      'cli',
      'ref' in input ? `${adapter}:${input.ref.id}` : undefined
    ),
  };
}

export function reject(reason: WorkRejection, detail: string, notSent?: true): Rejected {
  return { ok: false, reason, detail, ...(notSent ? { notSent } : {}) };
}

export function pickRoute<Verb extends RoutedVerb>(
  verb: Verb,
  target: { adapter: string; daemon?: string },
  adapters: readonly WorkAdapter[]
): Gate<Route<Verb>> {
  if (target.daemon) return { value: { daemon: target.daemon } };
  const adapter = adapters.find((candidate) => candidate.id === target.adapter);
  if (!adapter) {
    return {
      reason: reject(
        'unknown_adapter',
        `No adapter named ${target.adapter} here. Adapters here: ${adapters.map((candidate) => candidate.id).join(', ')}.`
      ),
    };
  }
  const local = adapter[verb];
  if (!local || !adapter.capabilities.includes(verb)) {
    return {
      reason: reject(
        verb === 'rename' ? 'not_supported' : 'unsupported',
        adapter.unsupportedCapabilities?.[verb] ??
          (verb === 'rename'
            ? `The ${adapter.id} adapter has no supported rename API.`
            : `The ${adapter.id} adapter cannot ${verb} work.`)
      ),
    };
  }
  return {
    value: {
      local,
      supportsStartEffort: adapter.supportsStartEffort,
      supportsStartPreparation: adapter.supportsStartPreparation,
    },
  };
}

function admitRemoteStartModel(route: Route<'start'>, input: StartInput): Gate<Route<'start'>> {
  return input.model !== undefined && 'daemon' in route && !route.verifiedCopilotStart
    ? {
        reason: reject(
          'unsupported_model',
          'This remote route cannot confirm the requested model. Choose a supported local adapter.'
        ),
      }
    : { value: route };
}

export function admitStartEffort(route: Route<'start'>, input: StartInput): Gate<Route<'start'>> {
  return input.effort === undefined ||
    ('local' in route ? route.supportsStartEffort === true : route.verifiedCopilotStart)
    ? { value: route }
    : {
        reason: reject(
          'unsupported_effort',
          'This route cannot confirm the requested effort. Choose a supported local adapter.'
        ),
      };
}

export function admitRemoteCaller<Verb extends RoutedVerb>(
  route: Route<Verb>,
  caller: OperationCaller
): Gate<Route<Verb>> {
  if (!('daemon' in route) || caller.source !== 'mcp' || caller.role === 'neo') {
    return { value: route };
  }
  return {
    reason: reject(
      'unsupported',
      `Only Neo or the user can change work on another daemon (${route.daemon}).`
    ),
  };
}

function localRef(ref: WorkRef): WorkRef {
  return { adapter: ref.adapter, id: ref.id };
}

export async function forwardWork<Result>(
  daemon: string,
  name: string,
  input: unknown,
  schema: z.ZodType<Result>,
  remote: RemoteDaemons,
  timeoutMs?: number
): Promise<Result | Rejected> {
  try {
    const reply = schema.safeParse(
      await remote.invoke(daemon, name, input, timeoutMs ? { timeoutMs } : undefined)
    );
    return reply.success ? reply.data : reject('unreachable', `${daemon} sent an unusable reply.`);
  } catch (error) {
    return reject(
      'unreachable',
      error instanceof Error ? error.message : String(error),
      error instanceof RemoteNotSentError ? true : undefined
    );
  }
}

export function annotateUnreachable(rejected: Rejected, hint: string): Rejected {
  return rejected.reason === 'unreachable' && !rejected.notSent
    ? { ...rejected, detail: `${rejected.detail} ${hint}` }
    : rejected;
}

export function routeStart(input: StartInput, deps: WorkVerbDeps): Gate<Route<'start'>> {
  if (input.copilotClient !== undefined && input.adapter !== COPILOT_ADAPTER_ID)
    return {
      reason: reject('unsupported', 'Client selection is only available for Copilot.', true),
    };
  const route = pickRoute(
    'start',
    { adapter: input.adapter, daemon: input.place.daemon },
    deps.adapters()
  );
  if ('reason' in route && input.copilotClient === 'desktop')
    return { reason: reject('unreachable', COPILOT_DESKTOP_UNAVAILABLE, true) };
  return route;
}

async function admitRemoteCopilotStart(
  route: Route<'start'>,
  input: StartInput,
  deps: WorkVerbDeps
): Promise<Gate<Route<'start'>>> {
  if (!('daemon' in route) || !input.copilotClient || input.copilotClient === 'auto')
    return { value: route };
  const catalog = await listWorkAdapters(route.daemon, deps);
  if (!catalog.ok) return { reason: { ...catalog, notSent: true } };
  const choices = catalog.value.find(({ id }) => id === COPILOT_ADAPTER_ID)?.copilotClients;
  if (!choices)
    return {
      reason: reject(
        'unsupported',
        'The selected HyperNeo server cannot verify Copilot client selection.',
        true
      ),
    };
  if (!choices.includes(input.copilotClient))
    return {
      reason: reject(
        'unreachable',
        input.copilotClient === 'desktop'
          ? COPILOT_DESKTOP_UNAVAILABLE
          : 'Copilot CLI is unavailable on the selected machine.',
        true
      ),
    };
  return { value: { ...route, verifiedCopilotStart: true } };
}

export async function startWork(
  route: Route<'start'>,
  input: StartInput,
  from: string,
  caller: OperationCaller,
  deps: WorkVerbDeps
): Promise<StartResult> {
  if ('local' in route) {
    const request =
      input.provenance && !['hyperneo', 'codex-desktop', 'claude-desktop'].includes(input.adapter)
        ? {
            ...input,
            message: withWorkerProvenance(input.message, {
              model: null,
              effort: null,
              harness: input.adapter,
            }),
            provenance: false,
          }
        : input;
    const result = await route.local(request, { from, caller });
    if (result.ok)
      await deps.recordStarted?.(result.value.ref, result.value.execution?.directory, {
        startedBy: from,
        todoId: input.todoId,
        machine: result.value.execution?.machine ?? result.value.place.machine,
        folder: result.value.execution?.directory ?? result.value.place.folder,
        harness: result.value.ref.adapter,
        provider: result.value.provider,
        model: result.value.model,
        effort: result.value.effort,
        preparation: input.preparation,
        ...(ownedTodoId(input, caller, deps)
          ? { role: input.checkPlan ? 'check' : (input.role ?? 'do') }
          : {}),
      });
    return result;
  }
  const { daemon: _daemon, ...place } = input.place;
  const { checkPlan: _checkPlan, planStepIds: _planStepIds, ...forwarded } = input;
  const result = await forwardWork(
    route.daemon,
    'work.start',
    {
      ...forwarded,
      place,
      ...(input.excludeRefs
        ? {
            excludeRefs: input.excludeRefs
              .filter((ref) => ref.daemon === route.daemon)
              .map(({ daemon: _daemon, ...ref }) => ref),
          }
        : {}),
      from: qualifyWorkOrigin(from, deps),
    },
    StartWorkResultSchema,
    deps.remote,
    REMOTE_START_TIMEOUT_MS
  );
  if (result.ok) return { ...result, value: stampWork(result.value, route.daemon) };
  return annotateUnreachable(
    result,
    'The work may still have started there; check work.find before starting it again.'
  );
}

function matchesRequested(
  requested: z.infer<typeof workStartConfiguration.schema> & { provider?: string },
  identity: { provider?: string; model?: string; effort?: string } | null
): boolean {
  return (
    !!identity &&
    (requested.provider === undefined || requested.provider === identity.provider) &&
    workStartConfiguration.confirm(requested, {
      ...(identity.model ? { model: identity.model } : {}),
      ...(identity.effort ? { effort: identity.effort } : {}),
    }).ok
  );
}

/** @public */
export async function reuseIdleWorker(
  route: Route<'start'>,
  input: StartInput,
  from: string,
  caller: OperationCaller,
  deps: WorkVerbDeps,
  inputId?: string
): Promise<StartResult | null> {
  const folder = input.place.folder;
  const requestedAdapter = deps.adapters().find((candidate) => candidate.id === input.adapter);
  if (
    !('local' in route) ||
    caller.role !== 'neo' ||
    !folder ||
    !requestedAdapter?.send ||
    ((input.model || input.effort) && !requestedAdapter.resolveStartConfiguration) ||
    input.createFolder ||
    (input.copilotClient !== undefined && input.copilotClient !== 'auto')
  )
    return null;
  const todoId = ownedTodoId(input, caller, deps);
  const role = input.role ?? 'do';
  let adapter = requestedAdapter;
  let context = todoId
    ? await deps.roleContext?.(todoId, adapter.id, input.preparation?.pack)
    : undefined;
  if (input.preparation && !context) return null;
  const assigned = context?.roles.find((row) => row.role === role);
  const workerTemplate = caller.source === 'internal' ? caller.workerTemplate : undefined;
  const desktop = workerTemplate === DESKTOP_WORKER_TEMPLATE_KEY;
  if (desktop && (input.model || input.provider)) return null;
  if (!workerTemplate && todoId && assigned && assigned.adapter !== adapter.id) {
    const priorAdapter = deps.adapters().find((candidate) => candidate.id === assigned.adapter);
    const priorContext = await deps.roleContext?.(
      todoId,
      assigned.adapter,
      input.preparation?.pack
    );
    const preparation = priorContext?.preparations.find((entry) => entry.id === assigned.id);
    if (
      priorAdapter?.send &&
      priorContext &&
      preparation &&
      matchingPreparation(preparation.preparation, input.preparation, priorContext.perRoundFields)
    ) {
      const status = await priorAdapter.status?.({ adapter: assigned.adapter, id: assigned.id });
      if (status && !status.ok && status.reason !== 'not_found' && status.reason !== 'not_open')
        return status;
      if (status?.ok) {
        adapter = priorAdapter;
        context = priorContext;
      }
    }
  }
  const matches = (id: string) => {
    const entry = context?.preparations.find((item) => item.id === id);
    return (
      deps.workerTemplate?.({ adapter: adapter.id, id }) === workerTemplate &&
      (!context ||
        (!!entry &&
          matchingPreparation(entry.preparation, input.preparation, context.perRoundFields)))
    );
  };
  const previous = context?.roles.find((row) => row.role === role && row.adapter === adapter.id);
  const prior = previous && matches(previous.id) ? previous : undefined;
  const canShare = (id: string) =>
    context?.roles.some(
      (row) =>
        row.adapter === adapter.id &&
        row.id === id &&
        context.shares[role]?.shareWith?.includes(row.role)
    ) ?? false;
  const policy = await deps.reusePolicy?.(adapter.id, input.todoId, caller);
  if (policy?.mode === 'per_todo' && !prior && !context?.roles.some((row) => canShare(row.id)))
    return null;
  const free = await deps.freeWorkers?.(adapter.id, input.todoId, caller.sessionId);
  if (
    !free?.size &&
    !prior &&
    !context?.roles.some((row) => canShare(row.id)) &&
    !(policy?.mode === 'per_ask' && policy.sameAsk.length)
  )
    return null;
  const sameAsk = (id: string) => !!policy?.sameAsk.includes(id);
  const configured =
    input.model || input.effort ? await adapter.resolveStartConfiguration!(input) : null;
  if ((input.model || input.effort) && !configured) return null;
  if (configured && !configured.ok) return configured;
  const requested = configured?.ok
    ? desktop
      ? { ...configured.value, model: undefined, provider: undefined }
      : configured.value
    : null;
  const groups = await adapter.find({ folder, includeClosed: false, limit: 50 });
  const discovered = groups.flatMap((group) => group.work);
  if (prior && !discovered.some((work) => work.ref.id === prior.id) && adapter.status) {
    const priorStatus = await adapter
      .status({ adapter: adapter.id, id: prior.id })
      .catch(() => null);
    if (priorStatus?.ok) discovered.push(priorStatus.value);
  }
  const candidates = discovered.map((work) => ({
    work,
    free:
      matches(work.ref.id) &&
      (prior
        ? work.ref.id === prior.id
        : (!!free?.has(work.ref.id) || canShare(work.ref.id)) &&
          (canShare(work.ref.id) || !policy || sameAsk(work.ref.id)) &&
          !context?.roles.some(
            (row) =>
              row.adapter === work.ref.adapter &&
              row.id === work.ref.id &&
              row.role !== role &&
              !context.shares[role]?.shareWith?.includes(row.role)
          )),
    sameAskAt: free && 'get' in free ? (free.get(work.ref.id)?.sameAskAt ?? null) : null,
    settledAt: free && 'get' in free ? (free.get(work.ref.id)?.settledAt ?? null) : null,
  }));
  const sameAskCandidates = candidates.filter(
    ({ work }) =>
      matches(work.ref.id) &&
      !context?.roles.some(
        (row) =>
          row.adapter === work.ref.adapter &&
          row.id === work.ref.id &&
          row.role !== role &&
          !context.shares[role]?.shareWith?.includes(row.role)
      )
  );
  const existing = prior && candidates.find(({ work }) => work.ref.id === prior.id);
  let busyRole: WorkerReuseCandidate | null = null;
  if (existing && todoId) {
    const key = `${existing.work.ref.adapter}\u0000${existing.work.ref.id}`;
    const live = await adapter.status?.(existing.work.ref).catch(() => null);
    if (
      reuseHolds.has(key) ||
      (live?.ok ? isBusyWork(live.value.status) : isBusyWork(existing.work.status))
    ) {
      busyRole = existing;
    }
  }
  const request = {
    adapter: adapter.id,
    folder,
    refreshStatus: !!adapter.status,
    roleWorker: prior?.id ?? context?.roles.find((row) => canShare(row.id))?.id,
    excludeRefs: input.excludeRefs,
  };
  let busy: WorkerReuseCandidate | undefined;
  for (;;) {
    const decision = reuseWorkerDecision(
      candidates,
      sameAskCandidates,
      request,
      policy?.mode === 'per_ask' && input.todoId && deps.todoWorker ? policy.sameAsk : [],
      busyRole
    );
    if (decision.action === 'start') break;
    if (decision.action === 'wait') {
      if (decision.role && todoId) {
        const queued =
          (await deps.todoWorker?.wait(todoId, decision.candidate.work.ref, input.message)) ??
          'none';
        return reject('worker_busy', WORKER_BUSY_DETAIL[queued], true);
      }
      if (todoId && (!decision.candidate.free || !adapter.compact)) {
        await deps.recordWorkerReuse?.(todoId, {
          worker: decision.candidate.work.ref,
          result: 'fresh',
          reason: !decision.candidate.free ? 'other_todo' : 'cannot_compact',
        });
        break;
      }
      busy = decision.candidate;
      break;
    }
    const chosen = decision.candidate;
    candidates.splice(candidates.indexOf(chosen), 1);
    const work = chosen.work;
    const key = `${work.ref.adapter}\u0000${work.ref.id}`;
    if (reuseHolds.has(key)) {
      if (prior?.id === work.ref.id && todoId) {
        const queued = (await deps.todoWorker?.wait(todoId, work.ref, input.message)) ?? 'none';
        return reject('worker_busy', WORKER_BUSY_DETAIL[queued], true);
      }
      continue;
    }
    reuseHolds.add(key);
    let status;
    try {
      status = await adapter.status?.(work.ref).catch(() => null);
    } catch (error) {
      reuseHolds.delete(key);
      throw error;
    }
    let identity = status?.ok ? status.value : null;
    if (adapter.status && identity?.status !== 'done') {
      reuseHolds.delete(key);
      if (prior?.id === work.ref.id && identity && todoId) {
        const queued = (await deps.todoWorker?.wait(todoId, work.ref, input.message)) ?? 'none';
        return reject('worker_busy', WORKER_BUSY_DETAIL[queued], true);
      }
      continue;
    }
    if (requested && !matchesRequested(requested, identity)) {
      const switched =
        identity && adapter.reconfigure
          ? await adapter.reconfigure(work.ref, requested).catch(() => false)
          : false;
      const after = switched ? await adapter.status?.(work.ref).catch(() => null) : null;
      identity = after?.ok ? after.value : null;
      if (identity?.status !== 'done' || !matchesRequested(requested, identity)) {
        reuseHolds.delete(key);
        continue;
      }
    }
    const addressed = withReplySender(input.message, from, `${adapter.id}:${work.ref.id}`);
    const message = input.provenance
      ? withWorkerProvenance(addressed, {
          model: identity?.model ?? null,
          effort: identity?.effort ?? null,
          harness: adapter.id,
        })
      : addressed;
    const claimed = deps.claimWorker
      ? await deps
          .claimWorker(
            work.ref,
            todoId,
            role,
            identity?.model,
            identity?.effort,
            context?.shares[role]?.shareWith
          )
          .catch((error: unknown) => {
            reuseHolds.delete(key);
            throw error;
          })
      : true;
    if (!claimed) {
      reuseHolds.delete(key);
      if (prior?.id === work.ref.id && todoId) {
        const queued = (await deps.todoWorker?.wait(todoId, work.ref, input.message)) ?? 'none';
        return reject('worker_busy', WORKER_BUSY_DETAIL[queued], true);
      }
      continue;
    }
    let clean = planCleanWorker({
      sameTodo: !todoId || prior?.id === work.ref.id || canShare(work.ref.id),
      named: false,
      started: true,
      remote: false,
      sameAsk: sameAsk(work.ref.id),
      released: false,
      otherTodo: false,
      canCompact: !!adapter.compact,
    });
    if (clean.action === 'compact') {
      const confirmed = await compactBeforeReuse(
        { ref: work.ref, sameAsk: true, compact: adapter.compact },
        caller,
        deps.warn ?? (() => {})
      );
      if (!confirmed) clean = { action: 'fresh', reason: 'not_confirmed' };
      else if (todoId)
        await deps.recordWorkerReuse?.(todoId, { worker: work.ref, result: 'compacted' });
    }
    if (clean.action === 'fresh') {
      if (todoId) {
        await deps.unclaimWorker?.(todoId, work.ref, input.role);
        await deps.recordWorkerReuse?.(todoId, {
          worker: work.ref,
          result: 'fresh',
          reason: clean.reason,
        });
      }
      reuseHolds.delete(key);
      const index = sameAskCandidates.indexOf(chosen);
      if (index >= 0) sameAskCandidates.splice(index, 1);
      continue;
    }
    if (todoId && caller.sessionId && deps.isOpenTodo?.(todoId, caller.sessionId) === false) {
      reuseHolds.delete(key);
      await deps.unclaimWorker?.(todoId, work.ref, input.role);
      return reject('todo_required', 'This todo closed before its worker was messaged.', true);
    }
    const sent = await (async () => {
      if (inputId) await deps.workInputs?.retarget?.(inputId, work.ref);
      return adapter.send!(work.ref, message, { from, caller });
    })().catch((error: unknown) => {
      reuseHolds.delete(key);
      throw error;
    });
    if (sent.ok) {
      setTimeout(() => reuseHolds.delete(key), REUSE_HOLD_MS).unref?.();
      return {
        ok: true,
        value: {
          ...work,
          ...(input.provenance || requested
            ? { model: identity?.model, effort: identity?.effort }
            : {}),
          ...(sent.value.receipt ? { receipt: sent.value.receipt } : {}),
          delivery: sent.value,
          reused: true,
        },
      };
    }
    reuseHolds.delete(key);
    const passed = sent.notSent || sent.reason === 'not_open' || sent.reason === 'not_found';
    if (passed && inputId) await deps.workInputs?.retarget?.(inputId, null);
    if (sent.notSent && todoId) await deps.unclaimWorker?.(todoId, work.ref, input.role);
    await deps.markUnusable?.(work.ref, sent.reason);
    if (passed) continue;
    const reported = await reportUncertainWorkSend(sent, { ref: work.ref, message }, from, deps);
    return reported.ok ? sent : reported;
  }
  if (busy && input.todoId && deps.todoWorker) {
    const status = await adapter.status?.(busy.work.ref).catch(() => null);
    if (
      status?.ok &&
      (isBusyWork(status.value.status) || (!busy.free && status.value.status === 'done')) &&
      (!requested ||
        ((requested.provider === undefined || requested.provider === status.value.provider) &&
          workStartConfiguration.confirm(requested, {
            ...(status.value.model ? { model: status.value.model } : {}),
            ...(status.value.effort ? { effort: status.value.effort } : {}),
          }).ok))
    ) {
      const queued = await deps.todoWorker.wait(input.todoId, busy.work.ref, input.message);
      if (queued === 'none') return null;
      return reject('worker_busy', WORKER_BUSY_DETAIL[queued], true);
    }
  }
  return null;
}

export function routeSend(input: SendInput, deps: WorkVerbDeps): Gate<Route<'send'>> {
  return pickRoute(
    input.mode && input.mode !== 'auto' ? input.mode : 'send',
    input.ref,
    deps.adapters()
  );
}

export async function sendWork(
  route: Route<'send'>,
  input: SendInput,
  from: string,
  caller: OperationCaller,
  deps: WorkVerbDeps
): Promise<SendResult> {
  const idempotency = input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {};
  if ('local' in route)
    return route.local(input.ref, input.message, { from, caller, ...idempotency });
  const result = await forwardWork(
    route.daemon,
    'work.send',
    {
      ref: localRef(input.ref),
      message: input.message,
      ...(input.mode ? { mode: input.mode } : {}),
      ...idempotency,
      from: qualifyWorkOrigin(from, deps),
    },
    SendWorkResultSchema,
    deps.remote,
    REMOTE_SEND_TIMEOUT_MS
  );
  if (result.ok) return result;
  return annotateUnreachable(
    result,
    'The message may still have been delivered; check work.status before sending it again.'
  );
}

async function reportUncertainWorkSend(
  result: SendResult,
  input: SendInput,
  from: string,
  deps: WorkVerbDeps
): Promise<SendResult> {
  if (
    input.ref.adapter !== 'codex-desktop' ||
    input.ref.daemon ||
    result.ok ||
    result.reason !== 'not_delivered' ||
    !result.uncertainDesktopInputId ||
    result.notSent ||
    !deps.reportUncertain
  )
    return result;
  const status = await deps
    .adapters()
    .find((adapter) => adapter.id === input.ref.adapter)
    ?.status?.(input.ref)
    .catch(() => null);
  const lastCompletion = status?.ok ? status.value.turnEnds?.at(-1)?.at : undefined;
  try {
    await deps.reportUncertain({
      id: result.uncertainDesktopInputId,
      ref: input.ref,
      from,
      detail: result.detail,
      lastCompletion,
    });
    return result;
  } catch (error) {
    return {
      ...result,
      detail: `${result.detail} Uncertainty report could not be persisted: ${String(error)}`,
    };
  }
}

export function routeStatus(input: RefInput, deps: WorkVerbDeps): Gate<Route<'status'>> {
  return pickRoute('status', input.ref, deps.adapters());
}

export async function readWorkStatus(
  route: Route<'status'>,
  input: StatusInput,
  deps: WorkVerbDeps
): Promise<StatusResult> {
  if ('local' in route)
    return input.receipt
      ? route.local(input.ref, input.since, input.receipt)
      : route.local(input.ref, input.since);
  const result = await forwardWork(
    route.daemon,
    'work.status',
    {
      ref: localRef(input.ref),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.receipt ? { receipt: input.receipt } : {}),
    },
    WorkStatusResultSchema,
    deps.remote
  );
  return result.ok ? { ok: true, value: stampWork(result.value, route.daemon) } : result;
}

export function routeStop(input: RefInput, deps: WorkVerbDeps): Gate<Route<'stop'>> {
  return pickRoute('stop', input.ref, deps.adapters());
}

export async function stopWork(
  route: Route<'stop'>,
  input: RefInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
): Promise<StopResult> {
  if ('local' in route)
    return route.local(input.ref, { from: selectMessageOrigin(caller), caller });
  return forwardWork(
    route.daemon,
    'work.stop',
    { ref: localRef(input.ref) },
    StopWorkResultSchema,
    deps.remote
  );
}

function presentWorkIdentity<T extends WorkSummary>(result: Result<T>): Result<T> {
  return result.ok
    ? {
        ...result,
        value: { ...result.value, worker: workerIdentity(result.value.ref, result.value.title) },
      }
    : result;
}

function resolveStartPlace(
  input: StartDraft,
  caller: OperationCaller,
  deps: WorkVerbDeps
): Gate<StartInput> {
  return (
    deps.startPlace?.(input, caller) ??
    (input.place
      ? { value: { ...input, place: input.place } }
      : {
          reason: reject(
            'invalid_place',
            'Choose a place or a non-coding todo for the shared home.'
          ),
        })
  );
}

const runStartWork = (superpipe({})('work.start') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(neoTodoRecords, ['input', 'caller', 'deps'], 'records')
  .pipe(workSourceFacts, ['input', 'caller', 'deps'], 'sourceFacts')
  .pipe(requireWorkSource, ['sourceFacts', 'input'], 'result:outcome')
  .pipe(resolveStartPlace, ['input', 'caller', 'deps'], 'result:outcome')
  .pipe(
    (input: StartInput, caller: OperationCaller, deps: WorkVerbDeps) =>
      input.checkPlan
        ? (deps.preparePlanCheck?.(input, caller) ?? {
            reason: reject('unsupported', 'Plan checks are unavailable.', true),
          })
        : { value: input },
    ['outcome', 'caller', 'deps'],
    'result:outcome'
  )
  .pipe((resolved: StartInput) => resolved, 'outcome', 'input')
  .pipe(routeStart, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(admitRemoteCopilotStart, ['outcome', 'input', 'deps'], 'result:outcome')
  .pipe(admitRemoteStartModel, ['outcome', 'input'], 'result:outcome')
  .pipe(admitStartEffort, ['outcome', 'input'], 'result:outcome')
  .pipe(
    (route: Route<'start'>, input: StartInput): Gate<Route<'start'>> => {
      const admitted = workStartPreparation.admit(
        input.preparation,
        'local' in route && route.supportsStartPreparation === true
      );
      return 'reason' in admitted ? admitted : { value: route };
    },
    ['outcome', 'input'],
    'result:outcome'
  )
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(acceptWorkInput, ['input', 'from', 'caller', 'deps', 'records'], 'inputId')
  .pipe(workReplyInput, ['input', 'from', 'caller', 'deps'], 'deliveryInput')
  .pipe(
    (
      route: Route<'start'>,
      input: StartInput,
      from: string,
      caller: OperationCaller,
      deps: WorkVerbDeps,
      inputId: string | undefined
    ) =>
      recordThrownWork(
        async () =>
          (input.checkPlan
            ? null
            : await reuseIdleWorker(route, input, from, caller, deps, inputId)) ??
          startWork(route, input, from, caller, deps),
        inputId,
        deps
      ),
    ['outcome', 'deliveryInput', 'from', 'caller', 'deps', 'inputId'],
    'outcome'
  )
  .pipe(recordWorkOutcome, ['inputId', 'input', 'outcome', 'deps'], 'outcome')
  .pipe(presentWorkIdentity, 'outcome', 'outcome')
  .pipe(withTodoRecords, ['outcome', 'records'], 'outcome')
  .endAsync('outcome') as (
  input: StartDraft,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<StartResult>;

function isOrdinaryLocalInput(
  input: QueuedInput,
  caller: OperationCaller,
  enabled: boolean
): input is SendInput {
  return (
    'message' in input &&
    caller.role === 'neo' &&
    !input.ref.daemon &&
    input.ref.adapter !== 'space' &&
    input.mode !== 'steer' &&
    enabled
  );
}

async function queueOrdinaryInput<Value>(
  input: QueuedInput,
  caller: OperationCaller,
  route: Value,
  deps: WorkVerbDeps
): Promise<{ value: Value } | { reason: SendResult }> {
  if (!isOrdinaryLocalInput(input, caller, !!deps.queueInput)) return { value: route };
  const inputId = await deps.queueInput!(input, selectSendOrigin(input, caller), caller);
  return { reason: { ok: true, value: { delivered: false, inputId } } };
}

const runSendWork = (superpipe({})('work.send') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(routeSend, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(requireSendPurpose, ['input', 'caller', 'outcome', 'deps'], 'result:outcome')
  .pipe(workSourceFacts, ['input', 'caller', 'deps'], 'sourceFacts')
  .pipe(requireWorkSource, ['sourceFacts', 'outcome'], 'result:outcome')
  .pipe(queueOrdinaryInput, ['input', 'caller', 'outcome', 'deps'], 'result:outcome')
  .pipe(requireFreeWorker, ['input', 'caller', 'outcome', 'deps'], 'result:outcome')
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(acceptWorkInput, ['input', 'from', 'caller', 'deps'], 'inputId')
  .pipe(workReplyInput, ['input', 'from', 'caller', 'deps'], 'deliveryInput')
  .pipe(
    (
      route: Route<'send'>,
      input: SendInput,
      from: string,
      caller: OperationCaller,
      deps: WorkVerbDeps,
      inputId: string | undefined
    ) => recordThrownWork(() => sendWork(route, input, from, caller, deps), inputId, deps),
    ['outcome', 'deliveryInput', 'from', 'caller', 'deps', 'inputId'],
    'outcome'
  )
  .pipe(recordWorkOutcome, ['inputId', 'input', 'outcome', 'deps'], 'outcome')
  .pipe(reportUncertainWorkSend, ['outcome', 'input', 'from', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: SendInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<SendResult>;

const runWorkStatus = (superpipe({})('work.status') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(routeStatus, ['input', 'deps'], 'result:outcome')
  .pipe(readWorkStatus, ['outcome', 'input', 'deps'], 'outcome')
  .pipe(presentWorkIdentity, 'outcome', 'outcome')
  .endAsync('outcome') as (input: StatusInput, deps: WorkVerbDeps) => Promise<StatusResult>;

type TurnsInput = z.infer<typeof WorkTurnsInputSchema>;
type TurnsResult = z.infer<typeof WorkTurnsResultSchema>;

const runWorkTurns = (superpipe({})('work.turns') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(
    (input: TurnsInput, deps: WorkVerbDeps) => pickRoute('turns', input.ref, deps.adapters()),
    ['input', 'deps'],
    'result:outcome'
  )
  .pipe(
    async (route: Route<'turns'>, input: TurnsInput, deps: WorkVerbDeps): Promise<TurnsResult> =>
      'local' in route
        ? route.local(input.ref, input.cursor, input.limit)
        : forwardWork(
            route.daemon,
            'work.turns',
            { ...input, ref: localRef(input.ref) },
            WorkTurnsResultSchema,
            deps.remote
          ),
    ['outcome', 'input', 'deps'],
    'outcome'
  )
  .endAsync('outcome') as (input: TurnsInput, deps: WorkVerbDeps) => Promise<TurnsResult>;

type QueuedInput = SendInput | z.infer<typeof WithdrawWorkInputSchema>;
type QueuedResult = SendResult | z.infer<typeof WithdrawWorkResultSchema>;
function routeQueuedInput(input: QueuedInput, deps: WorkVerbDeps) {
  return pickRoute('message' in input ? 'queue' : 'withdraw', input.ref, deps.adapters());
}
async function changeQueuedInput(
  route: Route<'queue' | 'withdraw'>,
  input: QueuedInput,
  from: string,
  caller: OperationCaller,
  deps: WorkVerbDeps
): Promise<QueuedResult> {
  if ('local' in route)
    return route.local(input.ref, 'message' in input ? input.message : input.queuedSubmissionId, {
      from,
      caller,
      ...('idempotencyKey' in input && input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    });
  const forwarded = {
    ...input,
    ref: localRef(input.ref),
    from: qualifyWorkOrigin(from, deps),
  };
  const result =
    'message' in input
      ? await forwardWork(
          route.daemon,
          'work.queue',
          forwarded,
          SendWorkResultSchema,
          deps.remote,
          REMOTE_SEND_TIMEOUT_MS
        )
      : await forwardWork(
          route.daemon,
          'work.withdraw',
          forwarded,
          WithdrawWorkResultSchema,
          deps.remote,
          REMOTE_SEND_TIMEOUT_MS
        );
  return result.ok
    ? result
    : annotateUnreachable(
        result,
        'The input may already have been queued or withdrawn; inspect its owning daemon before retrying.'
      );
}
const runQueueWork = (superpipe({})('work.queue') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(routeQueuedInput, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(requireSendPurpose, ['input', 'caller', 'outcome', 'deps'], 'result:outcome')
  .pipe(workSourceFacts, ['input', 'caller', 'deps'], 'sourceFacts')
  .pipe(requireWorkSource, ['sourceFacts', 'outcome'], 'result:outcome')
  .pipe(
    (
      input: QueuedInput,
      caller: OperationCaller,
      route: Route<'queue' | 'withdraw'>,
      deps: WorkVerbDeps
    ) =>
      queueOrdinaryInput(
        'message' in input ? { ...input, mode: 'queue' } : input,
        caller,
        route,
        deps
      ),
    ['input', 'caller', 'outcome', 'deps'],
    'result:outcome'
  )
  .pipe(requireFreeWorker, ['input', 'caller', 'outcome', 'deps'], 'result:outcome')
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(acceptWorkInput, ['input', 'from', 'caller', 'deps'], 'inputId')
  .pipe(workReplyInput, ['input', 'from', 'caller', 'deps'], 'deliveryInput')
  .pipe(
    (
      route: Route<'queue' | 'withdraw'>,
      input: QueuedInput,
      from: string,
      caller: OperationCaller,
      deps: WorkVerbDeps,
      inputId: string | undefined
    ) => recordThrownWork(() => changeQueuedInput(route, input, from, caller, deps), inputId, deps),
    ['outcome', 'deliveryInput', 'from', 'caller', 'deps', 'inputId'],
    'outcome'
  )
  .pipe(recordWorkOutcome, ['inputId', 'input', 'outcome', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: QueuedInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<QueuedResult>;

const runWithdrawWork = (superpipe({})('work.withdraw') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(routeQueuedInput, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(requireSendPurpose, ['input', 'caller', 'outcome', 'deps'], 'result:outcome')
  .pipe(workSourceFacts, ['input', 'caller', 'deps'], 'sourceFacts')
  .pipe(requireWorkSource, ['sourceFacts', 'outcome'], 'result:outcome')
  .pipe(
    (
      input: QueuedInput,
      caller: OperationCaller,
      route: Route<'queue' | 'withdraw'>,
      deps: WorkVerbDeps
    ) =>
      queueOrdinaryInput(
        'message' in input ? { ...input, mode: 'queue' } : input,
        caller,
        route,
        deps
      ),
    ['input', 'caller', 'outcome', 'deps'],
    'result:outcome'
  )
  .pipe(requireFreeWorker, ['input', 'caller', 'outcome', 'deps'], 'result:outcome')
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(acceptWorkInput, ['input', 'from', 'caller', 'deps'], 'inputId')
  .pipe(workReplyInput, ['input', 'from', 'caller', 'deps'], 'deliveryInput')
  .pipe(
    (
      route: Route<'queue' | 'withdraw'>,
      input: QueuedInput,
      from: string,
      caller: OperationCaller,
      deps: WorkVerbDeps,
      inputId: string | undefined
    ) => recordThrownWork(() => changeQueuedInput(route, input, from, caller, deps), inputId, deps),
    ['outcome', 'deliveryInput', 'from', 'caller', 'deps', 'inputId'],
    'outcome'
  )
  .pipe(recordWorkOutcome, ['inputId', 'input', 'outcome', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: QueuedInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<QueuedResult>;

const runRenameWork = (superpipe({})('work.rename') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(
    (input: RenameInput, deps: WorkVerbDeps) => pickRoute('rename', input.ref, deps.adapters()),
    ['input', 'deps'],
    'result:outcome'
  )
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(
    async (
      route: Route<'rename'>,
      input: RenameInput,
      caller: OperationCaller,
      deps: WorkVerbDeps
    ) =>
      'local' in route
        ? route.local(input.ref, input.title, { from: selectMessageOrigin(caller), caller })
        : forwardWork(
            route.daemon,
            'work.rename',
            { ...input, ref: localRef(input.ref) },
            RenameWorkResultSchema,
            deps.remote
          ),
    ['outcome', 'input', 'caller', 'deps'],
    'outcome'
  )
  .endAsync('outcome') as (
  input: RenameInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<z.infer<typeof RenameWorkResultSchema>>;

const runStopWork = (superpipe({})('work.stop') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(routeStop, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(stopWork, ['outcome', 'input', 'caller', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: RefInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<StopResult>;

async function listWorkAdapters(
  daemon: string | undefined,
  deps: WorkVerbDeps
): Promise<z.infer<typeof WorkAdaptersResultSchema>> {
  if (daemon && daemon !== deps.daemonName)
    return forwardWork(daemon, 'work.adapters', {}, WorkAdaptersResultSchema, deps.remote);
  const health = await deps.health?.();
  const adapters = deps.adapters();
  const ids = new Set([...adapters.map((adapter) => adapter.id), ...Object.keys(health ?? {})]);
  return {
    ok: true,
    value: [...ids].map((id) => {
      const adapter = adapters.find((entry) => entry.id === id);
      const capabilities =
        adapter?.capabilities.flatMap((capability) => {
          const routed = RoutedCapabilitySchema.safeParse(capability);
          return routed.success && (routed.data === 'find' || adapter[routed.data])
            ? [routed.data]
            : [];
        }) ?? [];
      return {
        id,
        capabilities,
        ...(id === COPILOT_ADAPTER_ID
          ? { displayName: 'Copilot', copilotClients: [...(adapter?.copilotClients ?? [])] }
          : {}),
        ...(adapter?.steerBehavior && capabilities.includes('steer')
          ? { steerBehavior: adapter.steerBehavior }
          : {}),
        ...(health?.[id] ? { health: health[id] } : {}),
        ...(adapter?.unsupportedCapabilities
          ? { unsupportedCapabilities: adapter.unsupportedCapabilities }
          : {}),
      };
    }),
  };
}

const runWorkAdapters = (superpipe({})('work.adapters') as PipelineAPI)
  .input(['daemon', 'deps'])
  .pipe(listWorkAdapters, ['daemon', 'deps'], 'outcome')
  .endAsync('outcome') as typeof listWorkAdapters;

export function createWorkVerbOperations(deps: WorkVerbDeps): OperationDefinition[] {
  return [
    defineOperation({
      name: 'work.rename',
      description: neoToolDescription('work.rename'),
      inputSchema: RenameWorkInputSchema,
      resultSchema: RenameWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runRenameWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.adapters',
      description: neoToolDescription('work.adapters'),
      inputSchema: z.object({ daemon: z.string().min(1).optional() }),
      resultSchema: WorkAdaptersResultSchema,
      policy: { safetyClass: 'read' },
      execute: ({ daemon }) => runWorkAdapters(daemon, deps),
    }),
    defineOperation({
      name: 'work.start',
      description: neoToolDescription('work.start'),
      inputSchema: StartWorkInputSchema,
      resultSchema: StartWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runStartWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.send',
      description: neoToolDescription('work.send'),
      inputSchema: SendWorkInputSchema,
      resultSchema: SendWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runSendWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.queue',
      description: neoToolDescription('work.queue'),
      inputSchema: SendWorkInputSchema,
      resultSchema: SendWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runQueueWork(input, caller, deps) as Promise<SendResult>,
    }),
    defineOperation({
      name: 'work.withdraw',
      description: neoToolDescription('work.withdraw'),
      inputSchema: WithdrawWorkInputSchema,
      resultSchema: WithdrawWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) =>
        runWithdrawWork(input, caller, deps) as Promise<z.infer<typeof WithdrawWorkResultSchema>>,
    }),
    defineOperation({
      name: 'work.status',
      description: neoToolDescription('work.status'),
      inputSchema: WorkStatusInputSchema,
      resultSchema: WorkStatusResultSchema,
      policy: { safetyClass: 'read' },
      execute: (input) => runWorkStatus(input, deps),
    }),
    defineOperation({
      name: 'work.turns',
      description: neoToolDescription('work.turns'),
      inputSchema: WorkTurnsInputSchema,
      resultSchema: WorkTurnsResultSchema,
      policy: { safetyClass: 'read' },
      execute: (input) => runWorkTurns(input, deps),
    }),
    defineOperation({
      name: 'work.stop',
      description: neoToolDescription('work.stop'),
      inputSchema: WorkRefInputSchema,
      resultSchema: StopWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runStopWork(input, caller, deps),
    }),
  ];
}
