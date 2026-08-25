import type { MessageContent } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { DeadLetterImmediatelyError } from '../../storage/job-queue-processor.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { MESSAGE_DELIVERY } from '../job-queue-constants.ts';
import { planDeliveryRoleArbitration } from './delivery-turn-routing.ts';
import { selectStrandedDeliveries } from './turn-outcome-classification.ts';

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

export function isMessageDeliveryV2Enabled(): boolean {
  const v = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  return v !== '0' && v !== 'false';
}

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

export interface StrandedDeliveryDb {
  getUserMessageIdsByStatus(sessionId: string, status: 'enqueued'): Array<{ uuid?: string }>;
}

export async function reconcileStrandedDeliveries(args: {
  sessionId: string;
  db: StrandedDeliveryDb;
  jobQueue: JobQueueRepository;
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
  };
  isInFlight?: (uuid: string) => boolean;
}): Promise<number> {
  if (!isMessageDeliveryV2Enabled()) return 0;
  return withSessionLock(args.sessionId, async () => {
    const stranded = selectStrandedDeliveries(
      args.db.getUserMessageIdsByStatus(args.sessionId, 'enqueued'),
      args.jobQueue.activeDeliveryMessageUuids(args.sessionId),
      args.isInFlight
    );
    for (const uuid of stranded) {
      const role = deliverMessage(args.jobQueue, args.sessionId, uuid, { origin: 'recovery' });
      if (role === 'turn' && args.stateManager) {
        try {
          await args.stateManager.setQueuedIfIdle(uuid);
        } catch {}
      }
    }
    return stranded.length;
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

export type DriveTurnOutcome =
  | { outcome: 'completed' }
  | { outcome: 'blocked'; retryAt: number }
  | { outcome: 'recovery_pending'; retryAt: number }
  | { outcome: 'aborted' }
  | { outcome: 'turn_terminated' };

export type FeedSteerOutcome =
  | { outcome: 'consumed' }
  | { outcome: 'awaiting_acceptance' }
  | { outcome: 'promote' }
  | { outcome: 'park' }
  | { outcome: 'aborted' };

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
    observer?: MessageDeliveryAttemptObserver
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

export async function awaitDeliveryConsumption(args: {
  sessionId: string;
  messageUuid: string;
  deliver: () => Promise<void>;
  terminalizeOnTimeout?: () => void;
  timeoutMs?: number;
}): Promise<void> {
  const consumed = waitForDeliveryConsumption(args.sessionId, args.messageUuid);
  let consumptionTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await args.deliver();
    const consumptionTimeoutMs =
      args.timeoutMs ?? (Number(process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS) || 30_000);
    await Promise.race([
      consumed.promise,
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
    consumed.cancel();
  }
}

const sessionLocks = new Map<string, Promise<unknown>>();

export const sessionResetCoordinationLocks = new Map<string, Promise<unknown>>();

export async function withSessionResetCoordination<T>(
  sessionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = sessionResetCoordinationLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => held);
  sessionResetCoordinationLocks.set(sessionId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sessionResetCoordinationLocks.get(sessionId) === tail) {
      sessionResetCoordinationLocks.delete(sessionId);
    }
  }
}

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
}): Promise<void> {
  await withSessionLock(args.sessionId, async () => {
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
  });
}
