/**
 * Message Delivery v2 — durable delivery ownership on `job_queue`.
 *
 * Demotes the in-memory `MessageQueue` to pure transport and grounds delivery
 * ownership in one durable place: the codebase's existing `job_queue` (lane
 * `"message_delivery"`). Every user message — new-turn or steered — becomes one
 * job_queue row whose atomic claim, retry+backoff, crash-recovery
 * (`reclaimStale`), and dedup are the DB's, eliminating the "in-memory vs
 * durable store" disagreement bug class that the phase-1 ledger fought.
 *
 * See docs/features/message-delivery-v2.md for the full design.
 *
 * Default-on (opt out with `HYPERNEO_MESSAGE_DELIVERY_V2=0`). Ordinary chat and
 * the Space / long-term-agent injectors all route through `deliverMessage`; the
 * legacy deferred-replay and rate-limit-retry kickoffs remain on the inline path
 * (backstopped by `recoverOrphanedConsumedMessages`) pending a follow-up.
 */

import type { MessageContent } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../job-queue-constants';

/**
 * On an SDK-message handling error, publish the terminal idle (draining the
 * delivery waiters) ONLY when the throwing message ends the turn — the final
 * `result`. A non-terminal message (e.g. an assistant message whose
 * `sdk.message` subscriber rejected) leaves the live query still consuming;
 * draining mid-turn would complete the durable job and release the active-turn
 * slot while output is still being produced, letting a later prompt admit as
 * another turn against the same query. The query's own `finally` publishes the
 * terminal idle when the generator closes. Shared by the Claude and ACP runners'
 * handleSDKMessage catch blocks. (Codex P1.)
 */
export async function drainDeliveryWaitersOnTerminalSDKMessage(
  stateManager: { setIdle(): Promise<void> },
  message: SDKMessage
): Promise<void> {
  if (message.type === 'result') {
    await stateManager.setIdle();
  }
}

/** Which slot a delivery occupies relative to its session's active turn. */
export type MessageDeliveryRole = 'turn' | 'steer';

/** The call site that originated the delivery (diagnostics only). */
export type MessageDeliveryOrigin =
  | 'chat'
  | 'space_inject'
  | 'space_agent'
  | 'long_term_agent'
  | 'recovery';

/**
 * Thin job payload — content stays in `sdk_messages`; the handler loads it by
 * UUID when driving/feeding. Keeps `job_queue` from duplicating potentially
 * large (image) content. See §6.
 */
export type MessageDeliveryPayload = {
  sessionId: string;
  messageUuid: string;
  role: MessageDeliveryRole;
  origin: MessageDeliveryOrigin;
  parentToolUseId?: string | null;
};

/**
 * The env-var gate for the v2 path. Default ON — durable delivery owns dispatch
 * for ordinary chat and the Space/long-term-agent injectors. Set
 * `HYPERNEO_MESSAGE_DELIVERY_V2=0` (or `=false`) to roll back to the legacy
 * `message.persisted → startQueryAndEnqueue` inline flow.
 */
export function isMessageDeliveryV2Enabled(): boolean {
  const v = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  return v !== '0' && v !== 'false';
}

/**
 * Detect a SQLite UNIQUE-constraint failure. `deliverMessage` relies on the
 * `uq_message_delivery_active_turn` partial unique index as the atomic
 * turn-vs-steer arbiter: a `role:'turn'` insert either succeeds or hits this
 * constraint, in which case the message is inserted as `role:'steer'` instead.
 * bun:sqlite / better-sqlite3 surface this as a message containing
 * "UNIQUE constraint failed". The only UNIQUE index on `job_queue` is ours, so
 * any UNIQUE violation on a message_delivery turn insert is the active-turn
 * guard — safe to translate to a steer.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint/i.test(err.message);
}

export interface DeliverMessageOptions {
  origin: MessageDeliveryOrigin;
  parentToolUseId?: string | null;
  /**
   * Force a specific role, bypassing the turn/steer arbiter. Used by the
   * handler's steer→turn promotion (the turn ended between enqueue and claim, so
   * the steer is re-enqueued as a fresh turn candidate). When omitted, the role
   * is decided atomically by the unique index.
   */
  role?: MessageDeliveryRole;
}

/**
 * The unified delivery chokepoint. Enqueue a durable job_queue row for a user
 * message whose content is ALREADY persisted in `sdk_messages` (the caller —
 * ordinary-chat RPC, Space injector — saves first, then calls this). The role
 * (turn vs steer) is decided atomically by the `uq_message_delivery_active_turn`
 * index: the `role:'turn'` insert succeeds if no active turn exists for the
 * session, else it hits the UNIQUE constraint and is re-inserted as
 * `role:'steer'`. No app-level "check session state then insert" race.
 *
 * A parked/blocked turn-job (pending/processing) still occupies the active-turn
 * slot, so a message arriving during `sdk_resume_choice` correctly becomes a
 * steer rather than a competing turn. See §7.
 */
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

  // Idempotency: if an active message_delivery job already exists for this UUID,
  // return its role without inserting a second. The reset path creates+subscribes
  // the replacement AgentSession before cleaning up the old one, so a message
  // persisted in that overlap invokes this chokepoint twice (serialized on the
  // per-session lock). Without this guard the second call inserts a steer for
  // the same UUID the first inserted as a turn → the prompt reaches the SDK
  // twice. See Codex (#3744886832).
  const existingRole = jobQueue.getActiveDeliveryRole(sessionId, messageUuid);
  if (existingRole) return existingRole;

  if (options.role) {
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { ...basePayload, role: options.role },
      // Delivery jobs can span a full SDK turn (seconds→minutes for steers
      // awaiting onSent). Give them ample retry budget so a transient failure
      // doesn't dead-letter a user message prematurely; `reclaimStale` covers
      // crashes. §15 measures actual pressure.
      maxRetries: 8,
    });
    return options.role;
  }

  try {
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: basePayload,
      maxRetries: 8,
    });
    return 'turn';
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // An active turn already exists for this session → this is a steer. The
    // index is the atomic arbiter; there is no check-then-insert race.
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { ...basePayload, role: 'steer' },
      maxRetries: 8,
    });
    return 'steer';
  }
}

/** Re-export so callers can reference the lane without importing constants. */
export { MESSAGE_DELIVERY };

/**
 * Narrow an unknown payload to a {@link MessageDeliveryPayload}. The handler
 * validates its own job's payload shape before acting.
 */
export function asMessageDeliveryPayload(
  payload: Record<string, unknown>
): MessageDeliveryPayload | null {
  const sessionId = payload.sessionId;
  const messageUuid = payload.messageUuid;
  const role = payload.role;
  if (typeof sessionId !== 'string' || typeof messageUuid !== 'string') return null;
  if (role !== 'turn' && role !== 'steer') return null;
  return {
    sessionId,
    messageUuid,
    role,
    origin: typeof payload.origin === 'string' ? (payload.origin as MessageDeliveryOrigin) : 'chat',
    parentToolUseId: typeof payload.parentToolUseId === 'string' ? payload.parentToolUseId : null,
  };
}

/** Load helpers used by tests/handler — content shape passthrough. */
export type DeliveryContent = string | MessageContent[];

/**
 * A loaded message's content paired with its persisted `send_status` — the
 * status-aware loader result consumed by the handler. `sendStatus` is a string
 * (`'enqueued' | 'consumed' | 'deferred' | 'failed'`) kept loose here to avoid
 * coupling this module to the repository layer's `SendStatus` enum; the handler
 * branches on the literal values. See {@link MessageDeliverySession}.
 */
export type DeliveryLoadResult = { content: DeliveryContent; sendStatus: string };

/**
 * How long to park a turn job whose query startup is blocked (sdk_resume_choice)
 * before re-claiming. Short enough to feel responsive once the user answers;
 * long enough to not hot-loop. The job stays `pending` (not `processing`) while
 * parked, so it does not count against stale-reclamation.
 */
export const MESSAGE_DELIVERY_PARK_MS = 5_000;

/**
 * Outcome of driving a turn.
 * - `completed` ⇒ the turn ran (or was already consumed and re-driven via history).
 * - `blocked` ⇒ query startup is blocked (sdk_resume_choice); park the job.
 * - `aborted` ⇒ revalidation immediately before feeding found the session archived
 *   or the message removed/re-classified (removePending TOCTOU) — do NOT feed.
 *   See Codex (#3742774841 archive barrier, #3696 removePending).
 */
export type DriveTurnOutcome =
  | { outcome: 'completed' }
  | { outcome: 'blocked'; retryAt: number }
  | { outcome: 'aborted' };

/**
 * Outcome of feeding a steer.
 * - `consumed` ⇒ the SDK consumed it (steered into the live turn).
 * - `promote` ⇒ no live turn; re-enqueue as a turn.
 * - `park` ⇒ the owning turn is BLOCKED (sdk_resume_choice, session `queued`),
 *   not actively processing — the steer can neither feed (no live generator) nor
 *   promote (the parked turn still holds the active-turn slot). Park it with the
 *   turn's delay so it is NOT reclaimed every poll (hot loop); it re-evaluates
 *   when the turn unblocks. See Codex (#3742693683).
 */
export type FeedSteerOutcome =
  | { outcome: 'consumed' }
  | { outcome: 'promote' }
  | { outcome: 'park' }
  | { outcome: 'aborted' };

/**
 * The live transport owner for a session (AgentSession implements this). Kept as
 * an interface so the job handler + tests depend on the shape, not the class.
 */
export interface MessageDeliverySession {
  /**
   * Drive a delivery turn. When `alreadyConsumed` is true, the kickoff was
   * already fed by a prior attempt (reclaim after a crash) — the handler must
   * NOT re-feed it (would duplicate the prompt; the SDK resume holds it), only
   * ensure the query is running so history drives the turn. See Codex (#2592).
   */
  driveDeliveryTurn(
    messageUuid: string,
    content: DeliveryContent,
    parentToolUseId?: string | null,
    alreadyConsumed?: boolean,
    claimGuard?: () => boolean
  ): Promise<DriveTurnOutcome>;
  feedDeliverySteer(
    messageUuid: string,
    content: DeliveryContent,
    parentToolUseId?: string | null,
    claimGuard?: () => boolean
  ): Promise<FeedSteerOutcome>;
  /** Clear queued state only if this skipped message still owns it. */
  settleSkippedDelivery?(messageUuid: string): Promise<void>;
}

/**
 * Per-(session, messageUuid) consumption waiters. The long-horizon injector
 * awaits its durable job's SDK consumption (onSent) before confirming the
 * source record — restoring the legacy "delivered = consumed" semantic that the
 * v2 fire-and-forget enqueue regressed. The bridge signals here from
 * {@link MessageDeliverySession.driveDeliveryTurn}/{@link feedDeliverySteer}
 * when the SDK admits the message. Keyed by BOTH session + UUID so a multi-
 * target delivery (the same MessageRecord/id to several agents) can't let one
 * session's consumption signal resolve another session's waiter. (Codex P1.)
 */
const deliveryConsumptionWaiters = new Map<string, Set<() => void>>();

const consumptionKey = (sessionId: string, messageUuid: string) => `${sessionId}\0${messageUuid}`;

/**
 * Register a wait for the durable job's SDK consumption. The `promise` resolves
 * when {@link signalDeliveryConsumed} fires for this session + UUID (or never,
 * if the job never reaches the SDK — bound the wait with a timeout and call
 * `cancel()` to avoid leaking the entry).
 */
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

/**
 * Signal that the durable job for `messageUuid` was consumed by the SDK (onSent)
 * in `sessionId`. Resolves all waiters for that (session, UUID) and clears the
 * entry. No-op if none are waiting (e.g. consumption before any caller
 * registered, or a delivery with no long-horizon source awaiting). Session-
 * scoped so a multi-target delivery can't cross-resolve. (Codex P1.)
 */
export function signalDeliveryConsumed(sessionId: string, messageUuid: string): void {
  const waiters = deliveryConsumptionWaiters.get(consumptionKey(sessionId, messageUuid));
  if (!waiters) return;
  deliveryConsumptionWaiters.delete(consumptionKey(sessionId, messageUuid));
  for (const resolve of waiters) resolve();
}

/**
 * Await a durable delivery job's SDK consumption (onSent) after enqueueing it,
 * restoring the legacy "delivered = consumed" semantic. `deliver` performs the
 * enqueue (e.g. {@link deliverAndMarkQueued}); the await races the consumption
 * signal against a timeout (HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS, default
 * 30s, matching the legacy MessageQueue timeout) and rejects on timeout so a
 * caller doesn't acknowledge a delivery that may yet dead-letter.
 *
 * `terminalizeOnTimeout` is invoked on timeout (or if `deliver` throws) ONLY for
 * paths that created a FRESH job this call (no prior row). It terminalizes the
 * persisted row so the durable job isn't later consumed alongside a retry that
 * mints a fresh UUID (direct send_message paths carry no stable id) — preventing
 * a duplicate. OMIT it for existing-row paths (stable id, e.g. the inbox flush)
 * so the job can self-heal via a retry that re-registers the wait. (Codex P1.)
 */
export async function awaitDeliveryConsumption(args: {
  sessionId: string;
  messageUuid: string;
  deliver: () => Promise<void>;
  terminalizeOnTimeout?: () => void;
}): Promise<void> {
  const consumed = waitForDeliveryConsumption(args.sessionId, args.messageUuid);
  let consumptionTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await args.deliver();
    const consumptionTimeoutMs =
      Number(process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS) || 30_000;
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

/**
 * In-process per-session mutex. Guards ONLY the brief turn start/stop + steer
 * state-check windows — NOT the long turn await. The feed itself is
 * concurrent-safe (§8). Holding this lock across a full SDK turn would block
 * mid-turn steering (the headline feature), so callers MUST release before any
 * long await (turn promise / enqueueWithId-onSent). The synchronous
 * read-then-set below has no await, so concurrent callers chain deterministically.
 */
const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionLocks.set(sessionId, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  }
}

/**
 * Enqueue a durable delivery job and, when it inserts as a turn, mark the
 * session queued — as ONE per-session critical section (under
 * {@link withSessionLock}). Role arbitration and queued ownership must be atomic
 * so a concurrently-injected steer can never win the queued marker that belongs
 * to the turn. Used by the migrated Space (`spaceAgentInjector`,
 * `injectMessageIntoSession`) and long-term-agent injectors; the caller persists
 * the user message BEFORE calling this (the handler reloads content by UUID).
 * (`AgentSession.deliverChatMessage` inlines the same deliver + mark-queued
 * sequence rather than calling this — it needs the role for its cooldown
 * supersession, so it doesn't fit the shared shape.)
 *
 * `stateManager` is optional: when absent (e.g. a long-term-agent session view
 * that doesn't expose it) the queued marker is skipped instead of crashing; on a
 * real AgentSession it is present and the marker is set. `onEnqueueFailure`
 * (if provided) terminalizes the persisted row when `deliverMessage` throws.
 */
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
      // Legacy-owned turn guard: while v2 is default-on, QueryModeHandler still
      // replays deferred/enqueued rows directly through MessageQueue, so a
      // session can be `processing` a live SDK turn with NO active v2 turn row.
      // The index would classify this injection as a fresh turn (it sees no v2
      // turn), racing the legacy turn + letting its idle prematurely resolve the
      // new waiter. Force a `steer` so the new message parks behind the legacy
      // turn and promotes only once that turn ends. The deferred legacy-replay
      // migration removes the need for this guard. (Codex P1.)
      const legacyOwnedTurn =
        !!args.stateManager &&
        args.stateManager.getState().status === 'processing' &&
        !args.jobQueue.hasActiveTurnDelivery(args.sessionId);
      role = deliverMessage(args.jobQueue, args.sessionId, args.messageUuid, {
        origin: args.origin,
        parentToolUseId: null,
        ...(legacyOwnedTurn ? { role: 'steer' as const } : {}),
      });
    } catch (err) {
      args.onEnqueueFailure?.();
      throw err;
    }
    if (role === 'turn' && args.stateManager) {
      try {
        await args.stateManager.setQueuedIfIdle(args.messageUuid);
      } catch {
        // Non-fatal — the durable job is already enqueued; the handler will
        // drive the turn. Mirrors deliverChatMessage's warn-and-continue.
      }
    }
  });
}
