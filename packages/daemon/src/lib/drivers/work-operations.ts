import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { qualifyRemoteOrigin } from '../mailbox/address.ts';
import { selectMessageOrigin, selectSendOrigin } from '../messaging/message-send.ts';
import {
  replyMessageBodyLength,
  REPLY_ORIGIN_MAX,
  withReplyLine,
} from '../messaging/session-reply.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import type { RemoteDaemons } from './find-operation.ts';
import { stampWork } from './places.ts';
import { workStartConfiguration } from './start-configuration.ts';
import { workStartPreparation } from './start-preparation.ts';
import {
  PlaceSchema,
  WorkDetailSchema,
  WorkDeliverySchema,
  WorkInputReceiptSchema,
  WorkRefSchema,
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
  | 'stop'
  | 'archive';
type Route<Verb extends RoutedVerb> =
  | { daemon: string }
  | {
      local: NonNullable<WorkAdapter[Verb]>;
      supportsStartEffort?: boolean;
      supportsStartPreparation?: boolean;
    };
type Gate<Value> = { value: Value } | { reason: Rejected };

export interface WorkVerbDeps {
  adapters(): readonly WorkAdapter[];
  remote: RemoteDaemons;
  daemonName: string;
  isOpenTodo?: (todoId: string, sessionId: string) => boolean;
  recordStarted?: (ref: WorkRef) => void;
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
const REMOTE_SEND_TIMEOUT_MS = 180_000;
const ForwardedOriginSchema = z.string().min(1).max(REPLY_ORIGIN_MAX).optional();

export const StartWorkInputSchema = z.object({
  todoId: z.string().trim().min(1).optional().describe('Neo: todo belonging to an open ask.'),
  adapter: z.string().min(1),
  place: PlaceSchema.optional(),
  title: z.string().trim().min(1).max(200),
  message: MessageSchema,
  createFolder: z.boolean().optional(),
  preparation: workStartPreparation.schema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: workStartConfiguration.schema.shape.effort,
  from: ForwardedOriginSchema,
});
export const SendWorkInputSchema = z.object({
  todoId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Neo: todo belonging to an open ask, including follow-ups.'),
  ref: WorkRefSchema,
  message: MessageSchema,
  mode: z.enum(['auto', 'steer', 'queue']).optional(),
  from: ForwardedOriginSchema,
});
export const WorkRefInputSchema = z.object({ ref: WorkRefSchema });
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
  'stop',
  'archive',
]);

export const WorkAdaptersResultSchema = workResultSchema(
  z.array(
    z.object({
      id: z.string(),
      capabilities: z.array(RoutedCapabilitySchema),
      unsupportedCapabilities: z.partialRecord(RoutedCapabilitySchema, z.string()).optional(),
    })
  )
);

type StartDraft = z.infer<typeof StartWorkInputSchema>;
type StartInput = StartDraft & { place: z.infer<typeof PlaceSchema> } & Pick<
    StartRequest,
    'inPlace' | 'prepareFolder'
  >;
type SendInput = z.infer<typeof SendWorkInputSchema>;
type RefInput = z.infer<typeof WorkRefInputSchema>;
type StatusInput = z.infer<typeof WorkStatusInputSchema>;
type StartResult = z.infer<typeof StartWorkResultSchema>;
type SendResult = z.infer<typeof SendWorkResultSchema>;
type StatusResult = z.infer<typeof WorkStatusResultSchema>;
type StopResult = z.infer<typeof StopWorkResultSchema>;

function admitNeoTodo(
  input: StartDraft | QueuedInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
): Gate<true> {
  return !('message' in input) ||
    caller.role !== 'neo' ||
    caller.source === 'internal' ||
    (input.todoId && caller.sessionId && deps.isOpenTodo?.(input.todoId, caller.sessionId))
    ? { value: true }
    : {
        reason: reject(
          'todo_required',
          'Neo work needs todoId belonging to an open ask owned by this session. Start a todo with neo.todo.add {start:true}; use neo.todo.continue or reference that todoId for follow-ups.'
        ),
      };
}

function workReplyInput<T extends StartInput | SendInput | z.infer<typeof WithdrawWorkInputSchema>>(
  input: T,
  from: string,
  caller: OperationCaller,
  deps: WorkVerbDeps
): T {
  const adapter = 'adapter' in input ? input.adapter : input.ref.adapter;
  if (
    !('message' in input) ||
    caller.role !== 'neo' ||
    !['claude-code', 'claude-desktop', 'codex-desktop'].includes(adapter)
  )
    return input;
  const remote = 'place' in input ? input.place.daemon : input.ref.daemon;
  return {
    ...input,
    message: withReplyLine(
      input.message,
      remote ? qualifyRemoteOrigin(from, deps.daemonName) : from,
      'cli'
    ),
  };
}

export function reject(reason: WorkRejection, detail: string): Rejected {
  return { ok: false, reason, detail };
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
        verb === 'rename'
          ? `The ${adapter.id} adapter has no supported rename API.`
          : (adapter.unsupportedCapabilities?.[verb] ??
              `The ${adapter.id} adapter cannot ${verb} work.`)
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
  return input.model !== undefined && 'daemon' in route
    ? {
        reason: reject(
          'unsupported_model',
          'This remote route cannot confirm the requested model. Choose a supported local adapter.'
        ),
      }
    : { value: route };
}

export function admitStartEffort(route: Route<'start'>, input: StartInput): Gate<Route<'start'>> {
  return input.effort === undefined || ('local' in route && route.supportsStartEffort === true)
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
    return reject('unreachable', error instanceof Error ? error.message : String(error));
  }
}

export function annotateUnreachable(rejected: Rejected, hint: string): Rejected {
  return rejected.reason === 'unreachable'
    ? { ...rejected, detail: `${rejected.detail} ${hint}` }
    : rejected;
}

export function routeStart(input: StartInput, deps: WorkVerbDeps): Gate<Route<'start'>> {
  return pickRoute(
    'start',
    { adapter: input.adapter, daemon: input.place.daemon },
    deps.adapters()
  );
}

export async function startWork(
  route: Route<'start'>,
  input: StartInput,
  from: string,
  caller: OperationCaller,
  deps: WorkVerbDeps
): Promise<StartResult> {
  if ('local' in route) {
    const result = await route.local(input, { from, caller });
    if (result.ok) deps.recordStarted?.(result.value.ref);
    return result;
  }
  const { daemon: _daemon, ...place } = input.place;
  const result = await forwardWork(
    route.daemon,
    'work.start',
    { ...input, place, from: qualifyRemoteOrigin(from, deps.daemonName) },
    StartWorkResultSchema,
    deps.remote,
    REMOTE_START_TIMEOUT_MS
  );
  if (result.ok) return { ok: true, value: stampWork(result.value, route.daemon) };
  return annotateUnreachable(
    result,
    'The work may still have started there; check work.find before starting it again.'
  );
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
  if ('local' in route) return route.local(input.ref, input.message, { from, caller });
  const result = await forwardWork(
    route.daemon,
    'work.send',
    {
      ref: localRef(input.ref),
      message: input.message,
      ...(input.mode ? { mode: input.mode } : {}),
      from: qualifyRemoteOrigin(from, deps.daemonName),
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

const runStartWork = (superpipe({})('start-work') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(admitNeoTodo, ['input', 'caller', 'deps'], 'result:outcome')
  .pipe(resolveStartPlace, ['input', 'caller', 'deps'], 'result:outcome')
  .pipe((resolved: StartInput) => resolved, 'outcome', 'input')
  .pipe(routeStart, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
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
  .pipe(workReplyInput, ['input', 'from', 'caller', 'deps'], 'deliveryInput')
  .pipe(startWork, ['outcome', 'deliveryInput', 'from', 'caller', 'deps'], 'outcome')
  .pipe(presentWorkIdentity, 'outcome', 'outcome')
  .endAsync('outcome') as (
  input: StartDraft,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<StartResult>;

const runSendWork = (superpipe({})('send-work') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(admitNeoTodo, ['input', 'caller', 'deps'], 'result:outcome')
  .pipe(routeSend, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(workReplyInput, ['input', 'from', 'caller', 'deps'], 'deliveryInput')
  .pipe(sendWork, ['outcome', 'deliveryInput', 'from', 'caller', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: SendInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<SendResult>;

const runWorkStatus = (superpipe({})('work-status') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(routeStatus, ['input', 'deps'], 'result:outcome')
  .pipe(readWorkStatus, ['outcome', 'input', 'deps'], 'outcome')
  .pipe(presentWorkIdentity, 'outcome', 'outcome')
  .endAsync('outcome') as (input: StatusInput, deps: WorkVerbDeps) => Promise<StatusResult>;

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
    });
  const forwarded = {
    ...input,
    ref: localRef(input.ref),
    from: qualifyRemoteOrigin(from, deps.daemonName),
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
const runQueuedInput = (superpipe({})('change-queued-work-input') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(admitNeoTodo, ['input', 'caller', 'deps'], 'result:outcome')
  .pipe(routeQueuedInput, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(workReplyInput, ['input', 'from', 'caller', 'deps'], 'deliveryInput')
  .pipe(changeQueuedInput, ['outcome', 'deliveryInput', 'from', 'caller', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: QueuedInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<QueuedResult>;

const runRenameWork = (superpipe({})('rename-work') as PipelineAPI)
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

const runStopWork = (superpipe({})('stop-work') as PipelineAPI)
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
  return {
    ok: true,
    value: deps.adapters().map((adapter) => ({
      id: adapter.id,
      ...(adapter.unsupportedCapabilities
        ? { unsupportedCapabilities: adapter.unsupportedCapabilities }
        : {}),
      capabilities: adapter.capabilities.flatMap((capability) => {
        const routed = RoutedCapabilitySchema.safeParse(capability);
        return routed.success && (routed.data === 'find' || adapter[routed.data])
          ? [routed.data]
          : [];
      }),
    })),
  };
}

export function createWorkVerbOperations(deps: WorkVerbDeps): OperationDefinition[] {
  return [
    defineOperation({
      name: 'work.rename',
      description:
        'Rename existing work using a supported harness API. Workers are long-lived sessions. Use a short title with the project and a number, such as neo-ios dev 1, neo-ios dev 2 or HyperNeo dev 3, never a task title. title is single-line plain text, trimmed, 1–200 characters. Codex uses thread/name/set so connected Desktop clients receive the name update without a restart; HyperNeo uses its session lifecycle API; Space uses task.update or agent.update. No other app private files or databases are written. Unsupported adapters return not_supported; API failures return not_delivered or unreachable with a reason. Only Neo or the user can rename work on another daemon.',
      inputSchema: RenameWorkInputSchema,
      resultSchema: RenameWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runRenameWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.adapters',
      description:
        'List work adapters on this daemon, or the attached daemon named by daemon, with their available capabilities: find, start, rename, send, steer, queue, withdraw, status, stop, archive. steer means work.send accepts mode steer on that adapter; it is listed only when declared and implemented. Optional unsupportedCapabilities maps unavailable capabilities to their limitation; explicit unsupported requests return that explanation. Archive uses neo.session.archive and requires a human request in a live turn. Use only capabilities listed for the chosen adapter.',
      inputSchema: z.object({ daemon: z.string().min(1).optional() }),
      resultSchema: WorkAdaptersResultSchema,
      policy: { safetyClass: 'read' },
      execute: ({ daemon }) => listWorkAdapters(daemon, deps),
    }),
    defineOperation({
      name: 'work.start',
      description:
        'Start new work in a place returned by work.find: a session, thread or task titled title, opened with message. Workers are long-lived sessions: title is the project and a number, such as neo-ios dev 1 or HyperNeo dev 3, never a task title. Put the task in message. adapter picks the harness: an adapter whose capabilities include start (see work.adapters); a place group lists adapters that only found work there. A place with a daemon starts the work on that daemon. Remote routes reject explicit model with unsupported_model until configuration support can be verified; use a local adapter to request a model. Only Neo or the user can change work on another daemon; other agents get unsupported. For non-coding work, omit place and pass todoId to use the one visible user folder across projects: ~/HyperNeo by default, or exactly the instance workspace path. A different place needs an exact path the user named in chat, even inside the workspace; never invent folders under home. Other new human-named folders keep the existing home-only, non-hidden and existing-parent creation rules. Coding keeps the repository place returned by work.find. model picks the model of a new HyperNeo session or Codex thread; settings.model.get lists HyperNeo id, name and provider. HyperNeo resolves a unique case-insensitive display name, with exact IDs taking precedence; ambiguous names reject with matching IDs. A shared exact ID keeps catalog precedence; use a unique display name to choose a particular provider offer. Codex resolves catalog aliases and refuses unsupported models. Claude desktop refuses explicit model overrides with unsupported_model; omit model to use its app configuration. Optional effort is supported by local HyperNeo (off/low/medium/high/extra high/max/ultra or thinking-level IDs) and Codex: it resolves against the selected model catalog and confirms the applied effort before sending the first turn. Unsupported local adapters and unverified remote routes return unsupported_effort before starting work. Without model, a HyperNeo session starts on the default model, or on the newest available one when the default cannot run. Returns the new work with its ref, link and, for HyperNeo or Codex, the model it runs on plus confirmed effort when available, or ok false with a reason such as invalid_place, claude_cli_login_expired, unsupported or unreachable.',
      inputSchema: StartWorkInputSchema,
      resultSchema: StartWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runStartWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.send',
      description:
        'Send a message to existing work by the ref from work.find, work.start or work.status. For Codex, choose mode steer for instant feedback or a change of direction; it returns not_delivered with a reason if steering is unavailable, never queues. Choose mode queue for the next task after the current turn. Copilot strict steer is unsupported: immediate input can fall back to a later turn. Copilot auto and queue enqueue input; delivered false plus receipt/queuedSubmissionId means accepted and waiting for consumption. Use receipt-bound work.status for its reply. Default mode auto preserves each adapter’s normal send behavior; on Codex it steers a running turn or starts an idle turn. Explicit steer and queue require those capabilities on the target adapter; otherwise they return unsupported without sending. HyperNeo sessions and Space agents support auto, not explicit steer; use auto for those targets. Other adapters retain their own steer and queue delivery semantics. For Codex auto and steer modes, running Desktop first opens unloaded work and waits for its owner, then steers through that owner; steeredIntoTurnId confirms that turn. If Desktop is running but cannot take ownership, delivery refuses without starting a background writer. In these modes, app-server is used only when Desktop is not running. After a turn started through app-server completes, that connection unsubscribes, with up to 30 minutes of idle grace before unload. Explicit Codex queue still uses the shared app-server queue API even when Desktop is running; it does not use this ownership handoff. In Codex auto mode, an idle thread starts a turn and returns startedTurnId with delivered true; if resume reports that this thread already has an active writer, it queues for that writer and returns queuedSubmissionId instead. Other unavailable or unconfirmed starts return not_delivered without queueing. Use work.queue to explicitly wait for the next turn. An uncertain steer is not retried or also queued. delivered false normally means accepted and queued behind the current turn; with unconfirmed true, only the transport write succeeded and peer acceptance is unknown. Claude Desktop desktopUI is ui-unconfirmed when no supported live render/read acknowledgment exists; delivered, confirmedAt, links and Remote Control never confirm Desktop rendering or reading. Optional receipt contains opaque executionId and inputId for that submission, scoped to the requested work ref and its daemon; it is not proof of completion or result attribution. ok false names why it was not accepted: not_found, not_open (archived or ended work), not_delivered, claude_cli_login_expired (tell the user to run `claude auth login`; retrying will not help), unsupported or unreachable. Only Neo or the user can change work on another daemon; other agents get unsupported.',
      inputSchema: SendWorkInputSchema,
      resultSchema: SendWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runSendWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.queue',
      description:
        'Queue next-turn peer input by ref. Returns an opaque queuedSubmissionId when supported; delivered false/unconfirmed does not prove execution. Only Neo or the user can change work on another daemon. Unsupported adapters return a factual rejection with no fallback.',
      inputSchema: SendWorkInputSchema,
      resultSchema: SendWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runQueuedInput(input, caller, deps) as Promise<SendResult>,
    }),
    defineOperation({
      name: 'work.withdraw',
      description:
        'Withdraw your queued input using its owning ref and queuedSubmissionId. withdrawn true confirms cancellation only while it remains withdrawable; false/not_queued means too late or no longer pending. Native Desktop queue IDs and another sender’s inputs are unsupported. Only Neo or the user can change work on another daemon.',
      inputSchema: WithdrawWorkInputSchema,
      resultSchema: WithdrawWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) =>
        runQueuedInput(input, caller, deps) as Promise<z.infer<typeof WithdrawWorkResultSchema>>,
    }),
    defineOperation({
      name: 'work.status',
      description:
        'Read the current status of work by ref: queued, running, needs_you, done, failed or stopped, with its last reply and link. With since (epoch ms on that machine), HyperNeo sessions, Space agents, Codex and Claude Code Desktop work also return exchange: the user and agent messages after that time, oldest first; exchangeCut true means earlier ones were not read; openedPrs lists pull requests the session created. Desktop execution, when present, identifies the actual working directory and its machine; place.folder may instead be a grouped project. Optional receipt queries inputEvidence for that exact execution/input on the owning ref and daemon: unavailable means ownership/history cannot be verified; pending means a completed reply has not yet been verified; observed means the driver verified that input and returns its bounded ordered exchange (up to 40 entries, exchangeCut marks truncation). Local HyperNeo receipts additionally include replyAvailability and a complete replyReport/replyAt for the verified consumed turn, read from authoritative SDK pages; mid-turn inputs stay in that turn, while a later terminal turn is excluded. Incomplete or unavailable history is explicit and never proves no written reply. Claude transcriptState distinguishes accepted input from a completed transcript turn; a later input alone is not completion. Claude Desktop desktopUI remains ui-unconfirmed independently, including after restart. Match the echoed receipt before using evidence. Missing inputEvidence means unsupported or unknown. This evidence is separate from lastReply and does not prove task completion or aggregate-result origin. Use this to follow up on work instead of searching again.',
      inputSchema: WorkStatusInputSchema,
      resultSchema: WorkStatusResultSchema,
      policy: { safetyClass: 'read' },
      execute: (input) => runWorkStatus(input, deps),
    }),
    defineOperation({
      name: 'work.stop',
      description:
        'Stop the current turn of work by ref. stopped false means nothing was running. Some adapters cannot stop work (unsupported); tell the user instead of retrying. Only Neo or the user can change work on another daemon; other agents get unsupported.',
      inputSchema: WorkRefInputSchema,
      resultSchema: StopWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runStopWork(input, caller, deps),
    }),
  ];
}
