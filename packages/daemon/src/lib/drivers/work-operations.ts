import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { qualifyRemoteOrigin } from '../mailbox/address.ts';
import { selectMessageOrigin, selectSendOrigin } from '../messaging/message-send.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import type { RemoteDaemons } from './find-operation.ts';
import { stampWork } from './places.ts';
import {
  PlaceSchema,
  WorkDetailSchema,
  WorkRefSchema,
  WorkSummarySchema,
  workResultSchema,
  type Rejected,
  type WorkAdapter,
  type WorkRef,
  type WorkRejection,
} from './types.ts';

type RoutedVerb = 'start' | 'send' | 'status' | 'stop';
type Route<Verb extends RoutedVerb> =
  | { daemon: string }
  | { local: NonNullable<WorkAdapter[Verb]> };
type Gate<Value> = { value: Value } | { reason: Rejected };

export interface WorkVerbDeps {
  adapters(): readonly WorkAdapter[];
  remote: RemoteDaemons;
  daemonName: string;
}

const MessageSchema = z.string().trim().min(1).max(20_000);
const REMOTE_START_TIMEOUT_MS = 360_000;
const REMOTE_SEND_TIMEOUT_MS = 180_000;
const ForwardedOriginSchema = z.string().min(1).max(500).optional();

export const StartWorkInputSchema = z.object({
  adapter: z.string().min(1),
  place: PlaceSchema,
  title: z.string().trim().min(1).max(200),
  message: MessageSchema,
  createFolder: z.boolean().optional(),
  model: z.string().trim().min(1).max(200).optional(),
  from: ForwardedOriginSchema,
});
export const SendWorkInputSchema = z.object({
  ref: WorkRefSchema,
  message: MessageSchema,
  from: ForwardedOriginSchema,
});
export const WorkRefInputSchema = z.object({ ref: WorkRefSchema });
export const WorkStatusInputSchema = z.object({
  ref: WorkRefSchema,
  since: z.number().int().min(0).optional(),
});

export const StartWorkResultSchema = workResultSchema(WorkSummarySchema);
export const SendWorkResultSchema = workResultSchema(z.object({ delivered: z.boolean() }));
export const WorkStatusResultSchema = workResultSchema(WorkDetailSchema);
export const StopWorkResultSchema = workResultSchema(z.object({ stopped: z.boolean() }));
export const WorkAdaptersResultSchema = workResultSchema(
  z.array(
    z.object({
      id: z.string(),
      capabilities: z.array(z.enum(['find', 'start', 'send', 'status', 'stop'])),
    })
  )
);

type StartInput = z.infer<typeof StartWorkInputSchema>;
type SendInput = z.infer<typeof SendWorkInputSchema>;
type RefInput = z.infer<typeof WorkRefInputSchema>;
type StatusInput = z.infer<typeof WorkStatusInputSchema>;
type StartResult = z.infer<typeof StartWorkResultSchema>;
type SendResult = z.infer<typeof SendWorkResultSchema>;
type StatusResult = z.infer<typeof WorkStatusResultSchema>;
type StopResult = z.infer<typeof StopWorkResultSchema>;

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
    return { reason: reject('unknown_adapter', `No adapter named ${target.adapter} here.`) };
  }
  const local = adapter[verb];
  if (!local || !adapter.capabilities.includes(verb)) {
    return { reason: reject('unsupported', `The ${adapter.id} adapter cannot ${verb} work.`) };
  }
  return { value: { local } };
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
  if ('local' in route) return route.local(input, { from, caller });
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
  return pickRoute('send', input.ref, deps.adapters());
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
  if ('local' in route) return route.local(input.ref, input.since);
  const result = await forwardWork(
    route.daemon,
    'work.status',
    { ref: localRef(input.ref), ...(input.since !== undefined ? { since: input.since } : {}) },
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

const runStartWork = (superpipe({})('start-work') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(routeStart, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(startWork, ['outcome', 'input', 'from', 'caller', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: StartInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<StartResult>;

const runSendWork = (superpipe({})('send-work') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(routeSend, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(selectSendOrigin, ['input', 'caller'], 'from')
  .pipe(sendWork, ['outcome', 'input', 'from', 'caller', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: SendInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<SendResult>;

const runWorkStatus = (superpipe({})('work-status') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(routeStatus, ['input', 'deps'], 'result:outcome')
  .pipe(readWorkStatus, ['outcome', 'input', 'deps'], 'outcome')
  .endAsync('outcome') as (input: StatusInput, deps: WorkVerbDeps) => Promise<StatusResult>;

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
    value: deps.adapters().map(({ id, capabilities }) => ({ id, capabilities: [...capabilities] })),
  };
}

export function createWorkVerbOperations(deps: WorkVerbDeps): OperationDefinition[] {
  return [
    defineOperation({
      name: 'work.adapters',
      description:
        'List the work adapters on this daemon, or on the attached daemon named by daemon, with the verbs each can do: find, start, send, status, stop. Start new work only with an adapter that can start, and send only through one that can send.',
      inputSchema: z.object({ daemon: z.string().min(1).optional() }),
      resultSchema: WorkAdaptersResultSchema,
      policy: { safetyClass: 'read' },
      execute: ({ daemon }) => listWorkAdapters(daemon, deps),
    }),
    defineOperation({
      name: 'work.start',
      description:
        'Start new work in a place returned by work.find: a session, thread or task titled title, opened with message. adapter picks the harness: an adapter whose capabilities include start (see work.adapters); a place group lists adapters that only found work there. A place with a daemon starts the work on that daemon. Only Neo or the user can change work on another daemon; other agents get unsupported. For a new project, give the folder to create in place.folder and set createFolder true: it must be inside the home folder, outside hidden folders, Library and Applications, with an existing parent. model picks the model of a new HyperNeo session; other adapters run on the model their app uses. Without model, a HyperNeo session starts on the default model, or on the newest available one when the default cannot run. Returns the new work with its ref, link and, for HyperNeo, the model it runs on, or ok false with a reason such as invalid_place, claude_cli_login_expired, unsupported or unreachable.',
      inputSchema: StartWorkInputSchema,
      resultSchema: StartWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runStartWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.send',
      description:
        'Send a message to existing work by the ref from work.find, work.start or work.status. delivered false means it was accepted and queued behind the current turn. ok false names why it was not accepted: not_found, not_open (archived or ended work), not_delivered, claude_cli_login_expired (tell the user to run `claude auth login`; retrying will not help), unsupported or unreachable. Only Neo or the user can change work on another daemon; other agents get unsupported.',
      inputSchema: SendWorkInputSchema,
      resultSchema: SendWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runSendWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.status',
      description:
        'Read the current status of work by ref: queued, running, needs_you, done, failed or stopped, with its last reply and link. With since (epoch ms on that machine), Codex and Claude Code Desktop work also return exchange: the user and agent messages after that time, oldest first; exchangeCut true means earlier ones were not read. Use this to follow up on work instead of searching again.',
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
