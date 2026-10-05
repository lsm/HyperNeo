import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
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
}

const MessageSchema = z.string().trim().min(1).max(20_000);

export const StartWorkInputSchema = z.object({
  adapter: z.string().min(1),
  place: PlaceSchema,
  title: z.string().trim().min(1).max(200),
  message: MessageSchema,
});
export const SendWorkInputSchema = z.object({ ref: WorkRefSchema, message: MessageSchema });
export const WorkRefInputSchema = z.object({ ref: WorkRefSchema });

export const StartWorkResultSchema = workResultSchema(WorkSummarySchema);
export const SendWorkResultSchema = workResultSchema(z.object({ delivered: z.boolean() }));
export const WorkStatusResultSchema = workResultSchema(WorkDetailSchema);
export const StopWorkResultSchema = workResultSchema(z.object({ stopped: z.boolean() }));

type StartInput = z.infer<typeof StartWorkInputSchema>;
type SendInput = z.infer<typeof SendWorkInputSchema>;
type RefInput = z.infer<typeof WorkRefInputSchema>;
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
  remote: RemoteDaemons
): Promise<Result | Rejected> {
  try {
    const reply = schema.safeParse(await remote.invoke(daemon, name, input));
    return reply.success ? reply.data : reject('unreachable', `${daemon} sent an unusable reply.`);
  } catch (error) {
    return reject('unreachable', error instanceof Error ? error.message : String(error));
  }
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
  caller: OperationCaller,
  deps: WorkVerbDeps
): Promise<StartResult> {
  if ('local' in route) return route.local(input, { caller });
  const { daemon: _daemon, ...place } = input.place;
  const result = await forwardWork(
    route.daemon,
    'work.start',
    { ...input, place },
    StartWorkResultSchema,
    deps.remote
  );
  return result.ok ? { ok: true, value: stampWork(result.value, route.daemon) } : result;
}

export function routeSend(input: SendInput, deps: WorkVerbDeps): Gate<Route<'send'>> {
  return pickRoute('send', input.ref, deps.adapters());
}

export async function sendWork(
  route: Route<'send'>,
  input: SendInput,
  deps: WorkVerbDeps
): Promise<SendResult> {
  if ('local' in route) return route.local(input.ref, input.message);
  return forwardWork(
    route.daemon,
    'work.send',
    { ref: localRef(input.ref), message: input.message },
    SendWorkResultSchema,
    deps.remote
  );
}

export function routeStatus(input: RefInput, deps: WorkVerbDeps): Gate<Route<'status'>> {
  return pickRoute('status', input.ref, deps.adapters());
}

export async function readWorkStatus(
  route: Route<'status'>,
  input: RefInput,
  deps: WorkVerbDeps
): Promise<StatusResult> {
  if ('local' in route) return route.local(input.ref);
  const result = await forwardWork(
    route.daemon,
    'work.status',
    { ref: localRef(input.ref) },
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
  if ('local' in route) return route.local(input.ref, { caller });
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
  .pipe(startWork, ['outcome', 'input', 'caller', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: StartInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<StartResult>;

const runSendWork = (superpipe({})('send-work') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(routeSend, ['input', 'deps'], 'result:outcome')
  .pipe(admitRemoteCaller, ['outcome', 'caller'], 'result:outcome')
  .pipe(sendWork, ['outcome', 'input', 'deps'], 'outcome')
  .endAsync('outcome') as (
  input: SendInput,
  caller: OperationCaller,
  deps: WorkVerbDeps
) => Promise<SendResult>;

const runWorkStatus = (superpipe({})('work-status') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(routeStatus, ['input', 'deps'], 'result:outcome')
  .pipe(readWorkStatus, ['outcome', 'input', 'deps'], 'outcome')
  .endAsync('outcome') as (input: RefInput, deps: WorkVerbDeps) => Promise<StatusResult>;

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

export function createWorkVerbOperations(deps: WorkVerbDeps): OperationDefinition[] {
  return [
    defineOperation({
      name: 'work.start',
      description:
        'Start new work in a place returned by work.find: a session, thread or task titled title, opened with message. adapter picks the harness (one of the place group adapters, or another adapter that can work in that folder). A place with a daemon starts the work on that daemon. Only Neo or the user can change work on another daemon; other agents get unsupported. Returns the new work with its ref and link, or ok false with a reason such as invalid_place, unsupported or unreachable.',
      inputSchema: StartWorkInputSchema,
      resultSchema: StartWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runStartWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.send',
      description:
        'Send a message to existing work by the ref from work.find, work.start or work.status. delivered false means it was accepted and queued behind the current turn. ok false names why it was not accepted: not_found, not_open (archived or ended work), not_delivered, unsupported or unreachable. Only Neo or the user can change work on another daemon; other agents get unsupported.',
      inputSchema: SendWorkInputSchema,
      resultSchema: SendWorkResultSchema,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => runSendWork(input, caller, deps),
    }),
    defineOperation({
      name: 'work.status',
      description:
        'Read the current status of work by ref: queued, running, needs_you, done, failed or stopped, with its last reply and link. Use this to follow up on work instead of searching again.',
      inputSchema: WorkRefInputSchema,
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
