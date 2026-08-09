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
 * Flag-gated (HYPERNEO_MESSAGE_DELIVERY_V2); ordinary chat is routed first
 * (§12 step 1). Space injectors + diagnostics re-pointing + decommissioning of
 * the phase-1 reconciliation machinery follow in steps 2–4.
 */

import type { MessageContent } from '@hyperneo/shared';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../job-queue-constants';

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
 * The env-var gate for the v2 path. While off, ordinary chat keeps using the
 * `message.persisted → startQueryAndEnqueue` flow untouched. Steps 2–4 migrate
 * the remaining origins and then decommission the old path.
 */
export function isMessageDeliveryV2Enabled(): boolean {
  return (
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 === '1' ||
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 === 'true'
  );
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
    alreadyConsumed?: boolean
  ): Promise<DriveTurnOutcome>;
  feedDeliverySteer(
    messageUuid: string,
    content: DeliveryContent,
    parentToolUseId?: string | null
  ): Promise<FeedSteerOutcome>;
  /** Clear queued state only if this skipped message still owns it. */
  settleSkippedDelivery?(messageUuid: string): Promise<void>;
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
