import { createLogger, type MessageContent } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { DeadLetterImmediatelyError } from '../../storage/job-queue-processor.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { MESSAGE_DELIVERY } from '../job-queue-constants.ts';
import { planDeliveryRoleArbitration } from './delivery-turn-routing.ts';

export async function drainDeliveryWaitersOnTerminalSDKMessage(
  stateManager: { setIdle(): Promise<void> },
  message: SDKMessage
): Promise<void> {
  const parentToolUseId = (message as SDKMessage & { parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  if (message.type === 'result' && (parentToolUseId === null || parentToolUseId === undefined)) {
    await stateManager.setIdle();
  }
}

export type MessageDeliveryRole = 'turn' | 'steer';

export type MessageDeliveryOrigin =
  | 'chat'
  | 'space_inject'
  | 'space_agent'
  | 'long_term_agent'
  | 'recovery';

export type MessageDeliveryPayload = {
  sessionId: string;
  messageUuid: string;
  role: MessageDeliveryRole;
  origin: MessageDeliveryOrigin;
  parentToolUseId?: string | null;
  batchUuids?: string[];
};

export const MESSAGE_DELIVERY_MAX_RETRIES = (() => {
  const raw = Number.parseInt(process.env.HYPERNEO_MESSAGE_DELIVERY_MAX_RETRIES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
})();

export function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint/i.test(err.message);
}

export class MessageDeliveryRecoverableTurnError extends Error {
  constructor(
    message: string,
    readonly category?: string
  ) {
    super(message);
    this.name = 'MessageDeliveryRecoverableTurnError';
  }
}

export class MessageDeliveryTerminalTurnError extends DeadLetterImmediatelyError {
  constructor(
    message: string,
    readonly category?: string
  ) {
    super(message);
    this.name = 'MessageDeliveryTerminalTurnError';
  }
}

const TERMINAL_TURN_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'authentication',
  'provider_auth_error',
]);

export function isTerminalTurnError(error: { recoverable: boolean; category?: string }): boolean {
  if (!error.recoverable) return true;
  return error.category !== undefined && TERMINAL_TURN_ERROR_CATEGORIES.has(error.category);
}

const RETRYABLE_ERROR_RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  'error_during_execution',
  'error_max_turns',
]);

export function isRetryableErrorResultSubtype(subtype: string | null): boolean {
  if (!subtype) return false;
  return RETRYABLE_ERROR_RESULT_SUBTYPES.has(subtype);
}

export interface DeliverMessageOptions {
  origin: MessageDeliveryOrigin;
  parentToolUseId?: string | null;
  role?: MessageDeliveryRole;
}

export function deliverMessage(
  jobQueue: JobQueueRepository,
  sessionId: string,
  messageUuid: string,
  options: DeliverMessageOptions
): MessageDeliveryRole {
  const basePayload: MessageDeliveryPayload = {
    sessionId,
    messageUuid,
    role: 'turn',
    origin: options.origin,
    parentToolUseId: options.parentToolUseId ?? null,
  };

  const arbitration = planDeliveryRoleArbitration({
    existingActiveRole: jobQueue.getActiveDeliveryRole(sessionId, messageUuid),
    requestedRole: options.role,
  });

  if (arbitration.action === 'reuse') return arbitration.role;

  try {
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { ...basePayload, role: arbitration.role },
      maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
    });
    return arbitration.role;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    if (arbitration.uniqueConstraintFallback === null) throw err;
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { ...basePayload, role: arbitration.uniqueConstraintFallback },
      maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
    });
    return arbitration.uniqueConstraintFallback;
  }
}

export { MESSAGE_DELIVERY };

export function flattenDeliveryText(content: DeliveryContent): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  const texts: string[] = [];
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') return null;
    texts.push(block.text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

export function buildBatchedDeliveryContent(texts: string[]): string {
  const total = texts.length;
  return texts.map((text, i) => `--- message ${i + 1} of ${total} ---\n${text}`).join('\n\n');
}

export const BATCH_DELIVERY_MAX_CHARS = 200_000;

export async function deliverBatchAndMarkQueued(args: {
  jobQueue: JobQueueRepository;
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };
  sessionId: string;
  messageUuids: string[];
  origin: MessageDeliveryOrigin;
}): Promise<boolean> {
  return await withSessionLock(args.sessionId, async () => {
    const usable = args.messageUuids;
    if (usable.length < 2) return false;
    const active = args.jobQueue.activeDeliveryMessageUuids(args.sessionId);
    if (usable.some((uuid) => active.has(uuid))) return false;

    try {
      args.jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: args.sessionId,
          messageUuid: usable[0],
          role: 'turn',
          origin: args.origin,
          parentToolUseId: null,
          batchUuids: usable,
        },
        maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      return false;
    }

    if (args.stateManager) {
      try {
        await args.stateManager.setQueuedIfIdle(usable[0]);
      } catch {}
    }
    return true;
  });
}

export type ReclaimTerminationDecision = 'terminated' | 'redrive' | 'live';

export function classifyReclaimTermination(args: {
  successResult: boolean;
  markerExists: boolean;
  terminalIdleInFlight: boolean;
}): ReclaimTerminationDecision {
  if (args.terminalIdleInFlight) return 'live';
  if (args.successResult) return 'terminated';
  if (args.markerExists) return 'redrive';
  return 'live';
}

export function asMessageDeliveryPayload(
  payload: Record<string, unknown>
): MessageDeliveryPayload | null {
  const sessionId = payload.sessionId;
  const messageUuid = payload.messageUuid;
  const role = payload.role;
  if (typeof sessionId !== 'string' || typeof messageUuid !== 'string') return null;
  if (role !== 'turn' && role !== 'steer') return null;
  const batchUuids = Array.isArray(payload.batchUuids)
    ? payload.batchUuids.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : undefined;
  return {
    sessionId,
    messageUuid,
    role,
    origin: typeof payload.origin === 'string' ? (payload.origin as MessageDeliveryOrigin) : 'chat',
    parentToolUseId: typeof payload.parentToolUseId === 'string' ? payload.parentToolUseId : null,
    ...(batchUuids && batchUuids.length > 0 ? { batchUuids } : {}),
  };
}

export type DeliveryContent = string | MessageContent[];

export type DeliveryLoadResult = { content: DeliveryContent; sendStatus: string };

export const MESSAGE_DELIVERY_PARK_MS = 5_000;

export const MANUAL_RECOVERY_PARK_MS = 5 * 60_000;

export const MAX_STEER_PARKS = 60;

export const STEER_ACK_TIMEOUT_MS = 30_000;

const MAX_TIMER_MS = 2_147_483_647;

export function steerAckTimeoutMs(): number {
  const parsed = Number(process.env.HYPERNEO_STEER_ACK_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS) return parsed;
  return STEER_ACK_TIMEOUT_MS;
}

export type DeliveryOutcome =
  | { outcome: 'completed' }
  | { outcome: 'aborted' }
  | {
      outcome: 'blocked';
      retryAt: number;
      reason?: 'sdk_resume_choice' | 'context_clear_boundary' | 'limit_recovery';
    };

export type DriveTurnOutcome = DeliveryOutcome;
export type FeedSteerOutcome = DeliveryOutcome;

export interface MessageDeliveryAttemptObserver {
  reportStage(
    stage: 'query_ready' | 'sdk_admitted' | 'first_sdk_response',
    details?: { generation?: number; responseType?: string }
  ): void;
}

export interface DeliveryClaimContext {
  claimGuard?: () => boolean;
  signal?: AbortSignal;
}

export interface MessageDeliverySession {
  driveDeliveryTurn(
    messageUuid: string,
    content: DeliveryContent,
    parentToolUseId?: string | null,
    alreadyConsumed?: boolean,
    claimGuard?: () => boolean,
    batchUuids?: string[],
    signal?: AbortSignal,
    observer?: MessageDeliveryAttemptObserver,
    deliveryClaimToken?: string | null
  ): Promise<DriveTurnOutcome>;
  feedDeliverySteer(
    messageUuid: string,
    content: DeliveryContent,
    parentToolUseId?: string | null,
    claimGuard?: () => boolean,
    signal?: AbortSignal,
    observer?: MessageDeliveryAttemptObserver
  ): Promise<FeedSteerOutcome>;
  isWaitingForInput?(): boolean;
  stuckInitializingMs?(now?: number): number | null;
  settleSkippedDelivery?(messageUuid: string): Promise<void>;
}

const deliveryConsumptionWaiters = new Map<string, Set<() => void>>();

const consumptionKey = (sessionId: string, messageUuid: string) => `${sessionId}\0${messageUuid}`;

export function waitForDeliveryConsumption(
  sessionId: string,
  messageUuid: string
): {
  promise: Promise<void>;
  cancel: () => void;
} {
  const key = consumptionKey(sessionId, messageUuid);
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  let waiters = deliveryConsumptionWaiters.get(key);
  if (!waiters) {
    waiters = new Set();
    deliveryConsumptionWaiters.set(key, waiters);
  }
  waiters.add(resolve);
  return {
    promise,
    cancel: () => {
      const set = deliveryConsumptionWaiters.get(key);
      if (set) {
        set.delete(resolve);
        if (set.size === 0) deliveryConsumptionWaiters.delete(key);
      }
    },
  };
}

export function signalDeliveryConsumed(sessionId: string, messageUuid: string): void {
  const waiters = deliveryConsumptionWaiters.get(consumptionKey(sessionId, messageUuid));
  if (!waiters) return;
  deliveryConsumptionWaiters.delete(consumptionKey(sessionId, messageUuid));
  for (const resolve of waiters) resolve();
}

export const ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS = 12 * 60 * 1000;

export const MAX_ACP_STEER_PARKS =
  Math.ceil(ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS / MESSAGE_DELIVERY_PARK_MS) + MAX_STEER_PARKS;

export function deliveryConsumptionTimeoutMs(provider?: string): number | undefined {
  return provider === 'acp' ? ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS : undefined;
}

export function deliveryConsumptionTimeoutOrDefault(timeoutMs?: number): number {
  const explicit = timeoutMs ?? Number(process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return 30_000;
}

export async function awaitDeliveryConsumptionTolerant(args: {
  sessionId: string;
  messageUuid: string;
  deliver: () => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
  getSendStatus?: () => string | null | undefined;
}): Promise<{ consumed: boolean }> {
  const consumed = waitForDeliveryConsumption(args.sessionId, args.messageUuid);
  let consumptionTimeout: ReturnType<typeof setTimeout> | undefined;
  let statusPoll: ReturnType<typeof setInterval> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ consumed: boolean }>((resolve) => {
    if (!args.signal) return;
    if (args.signal.aborted) {
      resolve({ consumed: false });
      return;
    }
    onAbort = () => resolve({ consumed: false });
    args.signal.addEventListener('abort', onAbort, { once: true });
  });
  const terminal = new Promise<{ consumed: boolean }>((resolve) => {
    if (!args.getSendStatus) return;
    const check = () => {
      try {
        const status = args.getSendStatus!();
        if (status === 'consumed') {
          signalDeliveryConsumed(args.sessionId, args.messageUuid);
          if (statusPoll) clearInterval(statusPoll);
          resolve({ consumed: true });
        } else if (status === 'failed') {
          if (statusPoll) clearInterval(statusPoll);
          resolve({ consumed: false });
        }
      } catch {
        if (statusPoll) clearInterval(statusPoll);
        resolve({ consumed: false });
      }
    };
    statusPoll = setInterval(check, MESSAGE_DELIVERY_PARK_MS);
    check();
  });
  try {
    if (!args.signal?.aborted) {
      const deliverPromise = args.deliver().catch((err: unknown) => {
        if (args.signal?.aborted) return;
        throw err;
      });
      await Promise.race([
        deliverPromise,
        aborted.then(() => {
          throw new DOMException('Aborted', 'AbortError');
        }),
      ]).catch((err: unknown) => {
        if (args.signal?.aborted) return;
        throw err;
      });
    }
    if (args.signal?.aborted) return { consumed: false };
    const won = await Promise.race([
      consumed.promise.then(() => ({ consumed: true }) as const),
      new Promise<{ consumed: boolean }>((resolve) => {
        consumptionTimeout = setTimeout(
          () => resolve({ consumed: false }),
          deliveryConsumptionTimeoutOrDefault(args.timeoutMs)
        );
      }),
      aborted,
      terminal,
    ]);
    return won;
  } finally {
    if (consumptionTimeout) clearTimeout(consumptionTimeout);
    if (statusPoll) clearInterval(statusPoll);
    if (onAbort && args.signal) args.signal.removeEventListener('abort', onAbort);
    consumed.cancel();
  }
}

export async function awaitDeliveryConsumption(args: {
  sessionId: string;
  messageUuid: string;
  deliver: () => Promise<void>;
  terminalizeOnTimeout?: () => void;
  timeoutMs?: number;
  getSendStatus?: () => string | null | undefined;
}): Promise<void> {
  const consumed = waitForDeliveryConsumption(args.sessionId, args.messageUuid);
  let consumptionTimeout: ReturnType<typeof setTimeout> | undefined;
  let statusPoll: ReturnType<typeof setInterval> | undefined;
  const alreadyConsumed = new Promise<void>((resolve) => {
    if (!args.getSendStatus) return;
    const check = () => {
      try {
        if (args.getSendStatus!() !== 'consumed') return;
        if (statusPoll) clearInterval(statusPoll);
        resolve();
      } catch {
        if (statusPoll) clearInterval(statusPoll);
      }
    };
    statusPoll = setInterval(check, MESSAGE_DELIVERY_PARK_MS);
    check();
  });
  try {
    await args.deliver();
    const consumptionTimeoutMs = deliveryConsumptionTimeoutOrDefault(args.timeoutMs);
    await Promise.race([
      consumed.promise,
      alreadyConsumed,
      new Promise<void>((_, reject) => {
        consumptionTimeout = setTimeout(
          () => reject(new Error('delivery not consumed within timeout')),
          consumptionTimeoutMs
        );
      }),
    ]);
  } catch (err) {
    args.terminalizeOnTimeout?.();
    throw err;
  } finally {
    if (consumptionTimeout) clearTimeout(consumptionTimeout);
    if (statusPoll) clearInterval(statusPoll);
    consumed.cancel();
  }
}

const sessionLocks = new Map<string, Promise<unknown>>();

export function throwIfDeliveryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export function waitForDeliveryAbort(signal?: AbortSignal): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let rejectAbort!: (reason: unknown) => void;
  const promise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    promise,
    cancel: () => signal?.removeEventListener('abort', onAbort),
  };
}

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfDeliveryAborted(signal);
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionLocks.set(sessionId, next);
  const aborted = waitForDeliveryAbort(signal);
  let acquired = false;
  try {
    await Promise.race([prev, aborted.promise]);
    throwIfDeliveryAborted(signal);
    acquired = true;
    return await fn();
  } finally {
    aborted.cancel();
    const releaseLock = () => {
      release();
      if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
    };
    if (acquired) releaseLock();
    else void prev.finally(releaseLock);
  }
}

const COORDINATION_ACQUIRE_TIMEOUT_MS = 8_000;

export function getCoordinationAcquireTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : COORDINATION_ACQUIRE_TIMEOUT_MS;
}

export class SessionCoordinationStallError extends Error {
  constructor(sessionId: string, waitedMs: number, holderAgeMs: number) {
    super(
      `Session ${sessionId} is still completing a prior operation ` +
        `(waited ${Math.round(waitedMs / 1000)}s, prior holder age ` +
        `${Math.round(holderAgeMs / 1000)}s). Try again shortly.`
    );
    this.name = 'SessionCoordinationStallError';
  }
}

type ContextClearBoundaryHold = {
  sessionId: string;
  prev: Promise<unknown> | null;
  tail: Promise<void>;
  token: object;
  release: () => void;
  abandon: () => void;
};

const sessionContextClearBoundaries = new Map<string, Promise<void>>();
const sessionContextClearBoundaryHolders = new Map<string, { token: object; armedAt: number }>();

function armContextClearBoundary(sessionId: string): ContextClearBoundaryHold {
  const prev = sessionContextClearBoundaries.get(sessionId) ?? null;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const tail = prev ? prev.then(() => held) : held;
  sessionContextClearBoundaries.set(sessionId, tail);
  const token = {};
  const release = () => {
    releaseHeld();
    if (sessionContextClearBoundaries.get(sessionId) === tail) {
      sessionContextClearBoundaries.delete(sessionId);
    }
    if (sessionContextClearBoundaryHolders.get(sessionId)?.token === token) {
      sessionContextClearBoundaryHolders.delete(sessionId);
    }
  };
  return {
    sessionId,
    prev,
    tail,
    token,
    release,
    abandon: () => {
      releaseHeld();
      void tail.then(() => {
        if (sessionContextClearBoundaries.get(sessionId) === tail) {
          sessionContextClearBoundaries.delete(sessionId);
        }
      });
      if (sessionContextClearBoundaryHolders.get(sessionId)?.token === token) {
        sessionContextClearBoundaryHolders.delete(sessionId);
      }
    },
  };
}

function markContextClearBoundaryHolder(hold: ContextClearBoundaryHold): void {
  sessionContextClearBoundaryHolders.set(hold.sessionId, {
    token: hold.token,
    armedAt: Date.now(),
  });
}

type ContextClearBoundaryAdmissionCtx = {
  sessionId: string;
  fn: () => Promise<unknown>;
  signal?: AbortSignal;
  hold: ContextClearBoundaryHold;
  timedOut: boolean;
  holderAgeMs: number;
  admissionStarted: boolean;
  result: unknown;
};

async function awaitContextClearBoundaryTurn(
  hold: ContextClearBoundaryHold,
  signal?: AbortSignal
): Promise<number | null> {
  if (!hold.prev) {
    markContextClearBoundaryHolder(hold);
    return null;
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    deadlineTimer = setTimeout(() => resolve('deadline'), getCoordinationAcquireTimeoutMs());
  });
  const aborted = waitForDeliveryAbort(signal);
  try {
    const winner = await Promise.race([
      hold.prev.then(() => 'acquired' as const),
      deadline,
      aborted.promise.then(() => 'aborted' as const),
    ]);
    if (winner === 'deadline') {
      const holder = sessionContextClearBoundaryHolders.get(hold.sessionId);
      return holder ? Date.now() - holder.armedAt : 0;
    }
    throwIfDeliveryAborted(signal);
  } finally {
    clearTimeout(deadlineTimer);
    aborted.cancel();
  }
  markContextClearBoundaryHolder(hold);
  return null;
}

async function awaitBoundaryTurnStage(
  ctx: ContextClearBoundaryAdmissionCtx
): Promise<ContextClearBoundaryAdmissionCtx> {
  const timeoutHolderAgeMs = await awaitContextClearBoundaryTurn(ctx.hold, ctx.signal);
  if (timeoutHolderAgeMs !== null) {
    ctx.timedOut = true;
    ctx.holderAgeMs = timeoutHolderAgeMs;
    return ctx;
  }
  return ctx;
}

export interface ContextClearBoundaryOwner {
  release: () => void;
}

export async function acquireContextClearBoundary(
  sessionId: string,
  signal?: AbortSignal
): Promise<ContextClearBoundaryOwner> {
  throwIfDeliveryAborted(signal);
  const hold = armContextClearBoundary(sessionId);
  let timeoutHolderAgeMs: number | null;
  try {
    timeoutHolderAgeMs = await awaitContextClearBoundaryTurn(hold, signal);
  } catch (error) {
    hold.abandon();
    throw error;
  }
  if (timeoutHolderAgeMs !== null) {
    hold.abandon();
    throw new SessionCoordinationStallError(
      sessionId,
      getCoordinationAcquireTimeoutMs(),
      timeoutHolderAgeMs
    );
  }
  return hold;
}

async function runUnderBoundaryStage(
  ctx: ContextClearBoundaryAdmissionCtx
): Promise<ContextClearBoundaryAdmissionCtx> {
  ctx.admissionStarted = true;
  try {
    ctx.result = await ctx.fn();
  } finally {
    ctx.hold.release();
  }
  return ctx;
}

const runContextClearBoundaryAdmission = (
  superpipe({ timedOut: (ctx: ContextClearBoundaryAdmissionCtx) => ctx.timedOut })(
    'context-clear-boundary-admission'
  ) as PipelineAPI
)
  .input(['ctx'])
  .pipe(awaitBoundaryTurnStage, 'ctx', 'ctx')
  .pipe('!timedOut', 'ctx')
  .pipe(runUnderBoundaryStage, 'ctx', 'ctx')
  .endAsync('ctx') as (
  input: ContextClearBoundaryAdmissionCtx
) => Promise<ContextClearBoundaryAdmissionCtx>;

async function runContextClearBoundary<T>(
  sessionId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  armedHold?: ContextClearBoundaryHold
): Promise<{ kind: 'admitted'; result: T } | { kind: 'boundary_wait'; holderAgeMs: number }> {
  throwIfDeliveryAborted(signal);
  const ctx: ContextClearBoundaryAdmissionCtx = {
    sessionId,
    fn,
    signal,
    hold: armedHold ?? armContextClearBoundary(sessionId),
    timedOut: false,
    holderAgeMs: 0,
    admissionStarted: false,
    result: undefined,
  };
  try {
    const settled = await runContextClearBoundaryAdmission(ctx);
    if (settled.timedOut) {
      return { kind: 'boundary_wait', holderAgeMs: settled.holderAgeMs };
    }
    return { kind: 'admitted', result: settled.result as T };
  } finally {
    if (!ctx.admissionStarted) {
      ctx.hold.abandon();
    }
  }
}

export async function withContextClearBoundary<T>(
  sessionId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfDeliveryAborted(signal);
  const hold = armContextClearBoundary(sessionId);
  if (!hold.prev) {
    markContextClearBoundaryHolder(hold);
    try {
      return await fn();
    } finally {
      hold.release();
    }
  }
  const outcome = await runContextClearBoundary(sessionId, fn, signal, hold);
  if (outcome.kind === 'boundary_wait') {
    throw new SessionCoordinationStallError(
      sessionId,
      getCoordinationAcquireTimeoutMs(),
      outcome.holderAgeMs
    );
  }
  return outcome.result;
}

export type ContextClearBoundaryAdmission<T> =
  | { kind: 'admitted'; result: T }
  | { kind: 'boundary_wait' };

export async function admitAcrossContextClearBoundary<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  admit: () => Promise<T>
): Promise<ContextClearBoundaryAdmission<T>> {
  try {
    const result = await withContextClearBoundary(sessionId, admit, signal);
    return { kind: 'admitted', result };
  } catch (error) {
    if (error instanceof SessionCoordinationStallError) {
      return { kind: 'boundary_wait' };
    }
    throw error;
  }
}

export function clearContextClearBoundariesForTest(): void {
  sessionContextClearBoundaries.clear();
  sessionContextClearBoundaryHolders.clear();
}

export function hasContextClearBoundaryForTest(sessionId: string): boolean {
  return sessionContextClearBoundaries.has(sessionId);
}

export function sessionOperationLockArmedAtCountForTest(): number {
  return sessionOperationLockArmedAt.size;
}

const sessionOperationLocks = new Map<string, Promise<unknown>>();

const sessionOperationLockArmedAt = new Map<string, number>();

const operationLockLog = createLogger('hyperneo:daemon:message-delivery.operation-lock');

const OPERATION_LOCK_ACQUIRE_TIMEOUT_MS = 8_000;
const OPERATION_LOCK_LEAK_CEILING_MS = 900_000;
const OPERATION_LOCK_HOLD_WARN_MS = 30_000;

function getSessionOperationLockAcquireTimeoutMs(): number {
  const raw = Number.parseInt(process.env.HYPERNEO_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : OPERATION_LOCK_ACQUIRE_TIMEOUT_MS;
}

function getSessionOperationLockLeakCeilingMs(): number {
  const raw = Number.parseInt(process.env.HYPERNEO_OPERATION_LOCK_LEAK_CEILING_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : OPERATION_LOCK_LEAK_CEILING_MS;
}

type OperationLockCtx = {
  sessionId: string;
  fn: () => Promise<unknown>;
  signal?: AbortSignal;
  prev: Promise<unknown>;
  registeredTail: Promise<unknown>;
  release: () => void;
  armedAt: number;
  observedArmedAt: number | null;
  acquired: boolean;
  timedOut: boolean;
  holderAgeMs: number;
  result: unknown;
};

function armOperationLock(sessionId: string): {
  prev: Promise<unknown>;
  tail: Promise<unknown>;
  release: () => void;
} {
  const prev = sessionOperationLocks.get(sessionId) ?? Promise.resolve();
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const tail = prev.then(
    () => held,
    () => held
  );
  sessionOperationLocks.set(sessionId, tail);
  return {
    prev,
    tail,
    release: () => {
      releaseHeld();
      if (sessionOperationLocks.get(sessionId) === tail) {
        sessionOperationLocks.delete(sessionId);
      }
    },
  };
}

function currentOperationLockHolderArmedAt(sessionId: string): number | null {
  return sessionOperationLockArmedAt.get(sessionId) ?? null;
}

async function awaitOperationLockSlotStage(ctx: OperationLockCtx): Promise<OperationLockCtx> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve('deadline'),
      getSessionOperationLockAcquireTimeoutMs()
    );
  });
  const aborted = waitForDeliveryAbort(ctx.signal);
  try {
    const winner = await Promise.race([
      ctx.prev.then(() => 'acquired' as const),
      deadline,
      aborted.promise.then(() => 'aborted' as const),
    ]);
    if (winner === 'deadline') {
      ctx.timedOut = true;
      const armedAt = currentOperationLockHolderArmedAt(ctx.sessionId);
      ctx.observedArmedAt = armedAt;
      ctx.holderAgeMs =
        armedAt === null ? getSessionOperationLockLeakCeilingMs() : Date.now() - armedAt;
      return ctx;
    }
    throwIfDeliveryAborted(ctx.signal);
    ctx.acquired = true;
    ctx.armedAt = Date.now();
    sessionOperationLockArmedAt.set(ctx.sessionId, ctx.armedAt);
    return ctx;
  } finally {
    clearTimeout(deadlineTimer);
    aborted.cancel();
  }
}

async function reclaimLeakedOperationLockStage(ctx: OperationLockCtx): Promise<OperationLockCtx> {
  if (!ctx.timedOut || ctx.holderAgeMs < getSessionOperationLockLeakCeilingMs()) return ctx;
  if (sessionOperationLocks.get(ctx.sessionId) !== ctx.registeredTail) return ctx;
  if (currentOperationLockHolderArmedAt(ctx.sessionId) !== ctx.observedArmedAt) return ctx;
  operationLockLog.error(
    `message-delivery operation-lock: holder for session ${ctx.sessionId} exceeded ` +
      `${getSessionOperationLockLeakCeilingMs()}ms (age ${ctx.holderAgeMs}ms); reclaiming the slot`
  );
  sessionOperationLocks.delete(ctx.sessionId);
  sessionOperationLockArmedAt.delete(ctx.sessionId);
  const armed = armOperationLock(ctx.sessionId);
  ctx.prev = armed.prev;
  ctx.registeredTail = armed.tail;
  ctx.release = () => {
    armed.release();
    if (sessionOperationLockArmedAt.get(ctx.sessionId) === ctx.armedAt) {
      sessionOperationLockArmedAt.delete(ctx.sessionId);
    }
  };
  ctx.acquired = true;
  ctx.timedOut = false;
  ctx.armedAt = Date.now();
  sessionOperationLockArmedAt.set(ctx.sessionId, ctx.armedAt);
  return ctx;
}

async function runExclusiveOperationLockStage(ctx: OperationLockCtx): Promise<OperationLockCtx> {
  const warnTimer = setTimeout(() => {
    operationLockLog.warn(
      `message-delivery operation-lock: session ${ctx.sessionId} has held the slot for ` +
        `${OPERATION_LOCK_HOLD_WARN_MS}ms (notice-only)`
    );
  }, OPERATION_LOCK_HOLD_WARN_MS);
  try {
    ctx.result = await ctx.fn();
    return ctx;
  } finally {
    clearTimeout(warnTimer);
  }
}

const isOperationLockTimedOut = (ctx: OperationLockCtx) => ctx.timedOut;

const runOperationLockPipeline = (
  superpipe({ isOperationLockTimedOut })('message-delivery-operation-lock') as PipelineAPI
)
  .input(['ctx'])
  .pipe(awaitOperationLockSlotStage, 'ctx', 'ctx')
  .pipe(reclaimLeakedOperationLockStage, 'ctx', 'ctx')
  .pipe('!isOperationLockTimedOut', 'ctx')
  .pipe(runExclusiveOperationLockStage, 'ctx', 'ctx')
  .endAsync('ctx') as (input: OperationLockCtx) => Promise<OperationLockCtx>;

export async function withSessionOperationLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfDeliveryAborted(signal);
  const armed = armOperationLock(sessionId);
  const ctx: OperationLockCtx = {
    sessionId,
    fn,
    signal,
    prev: armed.prev,
    registeredTail: armed.tail,
    release: () => {
      armed.release();
      if (sessionOperationLockArmedAt.get(sessionId) === ctx.armedAt) {
        sessionOperationLockArmedAt.delete(sessionId);
      }
    },
    armedAt: 0,
    observedArmedAt: null,
    acquired: false,
    timedOut: false,
    holderAgeMs: 0,
    result: undefined,
  };
  try {
    const settled = await runOperationLockPipeline(ctx);
    if (settled.timedOut) {
      throw new DOMException(
        `Session ${sessionId} is still completing a prior operation ` +
          `(waited ${Math.round(getSessionOperationLockAcquireTimeoutMs() / 1000)}s, ` +
          `prior holder age ${Math.round(settled.holderAgeMs / 1000)}s). Try again shortly.`,
        'TimeoutError'
      );
    }
    return settled.result as T;
  } finally {
    if (ctx.acquired) {
      ctx.release();
    } else {
      void ctx.prev.finally(ctx.release);
    }
  }
}

export async function deliverAndMarkQueued(args: {
  jobQueue: JobQueueRepository;
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };
  sessionId: string;
  messageUuid: string;
  origin: MessageDeliveryOrigin;
  onEnqueueFailure?: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  await withSessionLock(
    args.sessionId,
    async () => {
      let role: MessageDeliveryRole;
      try {
        role = deliverMessage(args.jobQueue, args.sessionId, args.messageUuid, {
          origin: args.origin,
          parentToolUseId: null,
        });
      } catch (err) {
        args.onEnqueueFailure?.();
        throw err;
      }
      if (role === 'turn' && args.stateManager) {
        try {
          await args.stateManager.setQueuedIfIdle(args.messageUuid);
        } catch {}
      }
    },
    args.signal
  );
}
