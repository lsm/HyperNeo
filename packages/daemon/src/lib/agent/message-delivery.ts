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
 * Default-on (opt out with `HYPERNEO_MESSAGE_DELIVERY_V2=0`). Ordinary chat,
 * the Space / long-term-agent / task-agent injectors, and the manual-flush /
 * turn-end-replay / promote kickoff paths all route through `deliverMessage`;
 * `reclaimStale` + the session-level orphan reconciler cover crash recovery.
 * (Phase 3, task #861.)
 */

import type { MessageContent } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { DeadLetterImmediatelyError } from '../../storage/job-queue-processor';
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
  const parentToolUseId = (message as SDKMessage & { parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  if (message.type === 'result' && (parentToolUseId === null || parentToolUseId === undefined)) {
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
  /**
   * Batched queue flush (turn-end replay / manual trigger): when the flush
   * found MULTIPLE pending messages and no turn was active, they are coalesced
   * into ONE turn whose kickoff is `messageUuid` and whose prompt combines
   * every listed UUID's content with numbered delimiters (see
   * {@link buildBatchedDeliveryContent}) — the model sees the whole queue from
   * the first token instead of answering N steers one at a time. `messageUuid`
   * is always `batchUuids[0]`; the bridge flips every member to `consumed`
   * together with the kickoff. Members carry no jobs of their own — the
   * batch-aware lookups (`activeDeliveryMessageUuids`, cancel) must include
   * them. Omitted for ordinary single-message delivery.
   */
  batchUuids?: string[];
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
 * Retry budget for `message_delivery` jobs (shared by {@link deliverMessage} and
 * the transactional outbox). Generous by default: a delivery job can span a full
 * SDK turn (seconds→minutes), and a recoverable provider error (transient 5xx /
 * "unexpected error") should retry the turn rather than dead-lettering a user
 * message prematurely. This composes with the QueryRunner's own internal retry.
 *
 * Operator-tunable via `HYPERNEO_MESSAGE_DELIVERY_MAX_RETRIES` rather than
 * reduced: the per-delivery cool-down in the external-event layer now caps
 * re-injection storms at the source, so shrinking this mainly trades recovery
 * headroom for faster `failed` surfacing — an operator decision, not a default.
 * Read once at module load.
 */
export const MESSAGE_DELIVERY_MAX_RETRIES = (() => {
  const raw = Number.parseInt(process.env.HYPERNEO_MESSAGE_DELIVERY_MAX_RETRIES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
})();

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

/**
 * Thrown by `driveDeliveryTurn` when the SDK turn ended in a RECOVERABLE error
 * (e.g. a transient provider 5xx / "unexpected error", category SYSTEM). The
 * handler does NOT catch it, so it propagates to the processor's `processJob`
 * catch → `repo.fail` → exponential backoff → retry. Each retry re-claims the
 * (now `consumed`) message and re-drives via `ensureQueryStarted`, which
 * restarts the query — the same "send a new message and it works" recovery the
 * user observed, now automatic. The message stays `consumed` throughout retries
 * (the `deliveryRetry` LiveQuery signal surfaces "retrying" in the UI); on
 * exhaustion the dead-letter path flips it to `failed`. See
 * docs/features/message-delivery-v2.md.
 */
export class MessageDeliveryRecoverableTurnError extends Error {
  constructor(
    message: string,
    readonly category?: string
  ) {
    super(message);
    this.name = 'MessageDeliveryRecoverableTurnError';
  }
}

/**
 * Thrown by `driveDeliveryTurn` when the SDK turn ended in a NON-recoverable
 * error (auth/permission/quota). Extends {@link DeadLetterImmediatelyError} so
 * the processor force-dead-letters the job (no retry budget burned) and fires
 * `onDead`, which terminalizes the persisted message as `failed` with a Retry
 * affordance — retrying won't fix a credential/quota error, but the UI surfaces
 * it honestly instead of silently idling on a `consumed` row.
 */
export class MessageDeliveryTerminalTurnError extends DeadLetterImmediatelyError {
  constructor(
    message: string,
    readonly category?: string
  ) {
    super(message);
    this.name = 'MessageDeliveryTerminalTurnError';
  }
}

/**
 * Categories that are terminal for DELIVERY regardless of the error's
 * `recoverable` flag. `ErrorManager.isRecoverable` returns true for every
 * AUTHENTICATION code except `INVALID_API_KEY` and for all
 * `PROVIDER_AUTH_ERROR` — but a surfaced auth failure (401, expired token,
 * unavailable credentials) needs a human to fix the credentials; retrying just
 * re-invokes a provider that cannot authenticate for the full ~4min budget
 * before dead-lettering. The manual Retry affordance covers the rare transient
 * case (e.g. a token-refresh window), so auth is classified terminal here,
 * matching {@link MessageDeliveryTerminalTurnError}'s documented
 * "auth/permission/quota" intent. Scoped to the delivery bridge — the global
 * `isRecoverable` is unchanged for every other consumer. (Codex #2.)
 */
const TERMINAL_TURN_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'authentication',
  'provider_auth_error',
]);

/**
 * Whether a turn-end error should dead-letter the delivery job immediately
 * (no retry budget burned): either flagged non-recoverable, or an auth
 * category per {@link TERMINAL_TURN_ERROR_CATEGORIES}.
 */
export function isTerminalTurnError(error: { recoverable: boolean; category?: string }): boolean {
  if (!error.recoverable) return true;
  return error.category !== undefined && TERMINAL_TURN_ERROR_CATEGORIES.has(error.category);
}

/**
 * SDK terminal-result error subtypes where a retry can plausibly succeed —
 * mirrors the Space runtime's retryable-subtype taxonomy (space-runtime
 * terminal-error-continue): transient execution failures and turn-cap
 * exhaustion. Cost exhaustion (`error_max_budget_usd`) and structured-output
 * exhaustion are NOT retryable: re-driving repeats spend for a deterministic
 * limit. The SDK persists error results WITHOUT emitting `session.error`, so
 * the bridge consults the persisted subtype directly (see
 * `getErrorTerminalResultSubtypeAfter`). (Codex review.)
 */
const RETRYABLE_ERROR_RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  'error_during_execution',
  'error_max_turns',
]);

/** Whether a persisted terminal-result error subtype is worth retrying. */
export function isRetryableErrorResultSubtype(subtype: string | null): boolean {
  if (!subtype) return false;
  return RETRYABLE_ERROR_RESULT_SUBTYPES.has(subtype);
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
      maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
    });
    return options.role;
  }

  try {
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: basePayload,
      maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
    });
    return 'turn';
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // An active turn already exists for this session → this is a steer. The
    // index is the atomic arbiter; there is no check-then-insert race.
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { ...basePayload, role: 'steer' },
      maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
    });
    return 'steer';
  }
}

/** Re-export so callers can reference the lane without importing constants. */
export { MESSAGE_DELIVERY };

/**
 * Flatten a delivery content to plain text for batching. Returns null when the
 * content carries non-text blocks (e.g. images) — such messages must NOT be
 * folded into a combined prompt (the blocks would be dropped), so the flush
 * delivers them individually instead.
 */
export function flattenDeliveryText(content: DeliveryContent): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  const texts: string[] = [];
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') return null; // non-text block
    texts.push(block.text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * Combine the flushed queue's message texts into ONE delimited prompt so the
 * model reads the entire batch before acting (numbered, queue order). Pure —
 * the handler rebuilds this from `batchUuids` on every claim/reclaim so a
 * crashed batch turn recombines identically.
 */
export function buildBatchedDeliveryContent(texts: string[]): string {
  const total = texts.length;
  return texts.map((text, i) => `--- message ${i + 1} of ${total} ---\n${text}`).join('\n\n');
}

/**
 * Character budget for a batched flush prompt. An unbounded concatenation of
 * arbitrarily many queued messages can exceed the provider's request/context
 * limit, making the batch permanently undeliverable (every retry rebuilds the
 * same oversized prompt and the dead-letter then fails every member). The
 * handler admits members while the combined prompt fits; the remainder stays
 * `enqueued` and is delivered by the reconciler after the batch turn
 * completes. ~200k chars ≈ 50k tokens — generous against real queues, far
 * below any modern context window.
 */
export const BATCH_DELIVERY_MAX_CHARS = 200_000;

/**
 * Enqueue ONE batched turn job for a queue flush with multiple pending
 * messages (see {@link MessageDeliveryPayload.batchUuids}). `messageUuids[0]`
 * becomes the kickoff. Returns false — WITHOUT enqueueing anything — when a
 * batch is not applicable: fewer than two UUIDs, ANY requested UUID already
 * owning an active job (batching only the unowned tail would reorder the
 * queue behind an existing steer — fall back so per-message delivery
 * preserves ownership and order), or the atomic active-turn index rejected
 * the `role:'turn'` insert (a turn went active between flush and enqueue).
 * Callers fall back to per-message delivery ({@link deliverAndMarkQueued}) on
 * false.
 */
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
    // ANY active member disqualifies the batch (see the doc above) — same
    // idempotency guard as deliverMessage, but batch-aware via
    // activeDeliveryMessageUuids.
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
      // A turn went active mid-flush — not batchable. Fall back per-message.
      return false;
    }

    if (args.stateManager) {
      try {
        await args.stateManager.setQueuedIfIdle(usable[0]);
      } catch {
        // Non-fatal — the durable job is already enqueued; the handler will
        // drive the turn. Mirrors deliverAndMarkQueued.
      }
    }
    return true;
  });
}

/**
 * Minimal db view the orphan reconciler needs: the persisted nonterminal user
 * messages for a session. Kept as an interface so the reconciler is unit-testable
 * with a real SDKMessageRepository or a stub. See {@link reconcileStrandedDeliveries}.
 */
export interface StrandedDeliveryDb {
  getMessagesByStatus(sessionId: string, status: 'enqueued'): Array<{ uuid?: string }>;
}

/**
 * Orphan reconciler core (task #861 item 4) — recover the one case `job_queue`
 * cannot see by itself: a persisted user message stuck `enqueued` with NO active
 * `message_delivery` job (the confirmed #856 "stranded pending in an idle
 * session" shape). Re-enqueues the SAME canonical UUID via {@link deliverMessage}
 * — never inserts a second user message or a duplicate payload; the handler
 * reloads content from storage. Idempotent + safe under concurrent ticks/workers:
 * it only acts on messages with no active job, and `deliverMessage` dedups via
 * `getActiveDeliveryRole`. The whole pass runs under the per-session lock
 * ({@link withSessionLock}) so two concurrent reconciles (e.g. the idle callback
 * racing the 60s timer) serialize: the first enqueues, the second sees the
 * active job and skips — never a duplicate turn+steer pair for one message.
 * Returns the count re-enqueued.
 *
 * This is the pure cross-check; {@link AgentSession.reconcileStrandedDeliveries}
 * wraps it with a processing-state guard + logging + v2 flag check.
 */
export async function reconcileStrandedDeliveries(args: {
  sessionId: string;
  db: StrandedDeliveryDb;
  jobQueue: JobQueueRepository;
  /**
   * Optional state manager — when present, a re-enqueued TURN sets the queued
   * marker (setQueuedIfIdle) so the session reports busy until the processor
   * claims the recovered job; without it, a concurrent `deliveryMode:'defer'`
   * send would be mis-converted to immediate (a steer into the recovered turn).
   * Omit in unit tests that don't exercise the queued marker. (Codex review.)
   */
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
  };
}): Promise<number> {
  if (!isMessageDeliveryV2Enabled()) return 0;
  return withSessionLock(args.sessionId, async () => {
    const active = args.jobQueue.activeDeliveryMessageUuids(args.sessionId);
    const enqueued = args.db.getMessagesByStatus(args.sessionId, 'enqueued');
    const stranded: string[] = [];
    for (const msg of enqueued) {
      const uuid = msg.uuid;
      if (typeof uuid === 'string' && uuid.length > 0 && !active.has(uuid)) {
        stranded.push(uuid);
      }
    }
    for (const uuid of stranded) {
      const role = deliverMessage(args.jobQueue, args.sessionId, uuid, { origin: 'recovery' });
      // Set the queued marker inside this lock (no nested lock) when this
      // re-enqueue wins the turn role — same contract as deliverAndMarkQueued.
      if (role === 'turn' && args.stateManager) {
        try {
          await args.stateManager.setQueuedIfIdle(uuid);
        } catch {
          // Non-fatal — the durable job is enqueued; the handler will drive it.
        }
      }
    }
    return stranded.length;
  });
}

/**
 * Reclaim decision for an already-consumed delivery turn whose turn may have
 * already ended — a restart reclaim (the job was `processing` when the daemon
 * exited) or a live reclaim after a stale lease. Pure so the crash-consistency
 * logic is unit-testable independent of the AgentSession/provider wiring.
 *
 * Inputs (all durable / observable at reclaim time):
 *  - `successResult`: a SUCCESS terminal `result` row exists after the message's
 *    consumption (`SDKMessageRepository.hasTerminalResultAfter`, subtype
 *    `'success'` only — an error result is NOT success).
 *  - `markerExists`: a durable `delivery_turn_end` marker exists for the message
 *    (recorded by the idle waiter when a driven turn ends while its job is still
 *    `processing`). The marker proves the turn ENDED, not that it SUCCEEDED.
 *  - `terminalIdleInFlight`: a terminal-idle drain is still running (the result
 *    row precedes `finishTurn`'s awaited `setIdle`).
 *
 * Decision:
 *  - `'live'` — the turn has not settled (or a terminal idle is still draining);
 *    reclaim it as a normal drive. During the drain, durable turn ownership is
 *    kept so a newly promoted message cannot feed the old query.
 *  - `'terminated'` — the turn ended AND succeeded; the reclaim has nothing to
 *    resume and nothing to retry, so the handler completes the job
 *    (`turn_terminated`), freeing the active-turn slot.
 *  - `'redrive'` — the turn ended but NOT via success: the ONLY signal is a bare
 *    `delivery_turn_end` marker (no success result). On a restart reclaim this is
 *    the tell-tale of the crash window — the daemon exited AFTER the idle waiter
 *    recorded the marker but BEFORE the producedResult/retry decision ran (and
 *    cleared it). Completing here would silently drop a recoverable failure
 *    (never retried) and bury a non-recoverable one (never surfaced as `failed`).
 *    The caller clears the stale marker and re-drives so the producedResult /
 *    stall-retry path decides instead of silently completing.
 *
 * This is the "settled decision keys off the success-subtype result" fix
 * (task #946, PR #2471 review r3772035811): a bare `delivery_turn_end` marker
 * alone can never cause a silent complete.
 */
export type ReclaimTerminationDecision = 'terminated' | 'redrive' | 'live';

export function classifyReclaimTermination(args: {
  successResult: boolean;
  markerExists: boolean;
  terminalIdleInFlight: boolean;
}): ReclaimTerminationDecision {
  // Keep durable turn ownership while the terminal idle is still draining, or a
  // newly promoted message could feed the old query and be released by the old
  // turn's drain. (Mirrors the original hasSettledTurnTermination guard.)
  if (args.terminalIdleInFlight) return 'live';
  // Only a SUCCESS result is safe to complete silently.
  if (args.successResult) return 'terminated';
  // A bare marker (turn ended via a result-less path) is NOT proof of success —
  // clear it and re-drive so the retry/dead-letter path decides.
  if (args.markerExists) return 'redrive';
  // The turn has not ended; reclaim drives it normally.
  return 'live';
}

/**
 * Whether a COMPLETED message_delivery job's persisted `result` represents a
 * turn the delivery layer actually drove to completion. The handler also
 * completes jobs with non-success outcomes (`skipped` — e.g. an ACP reclaim of
 * a still-`submitted` prompt, `aborted`, `no_content`, `archived`,
 * `stale_attempt`); those must NOT emit the terminal success signal
 * (`session.delivery_settled`), or a consumer like TaskAgentManager would
 * complete a workflow node whose prompt was never processed. Parks never reach
 * this check (a requeued row makes the processor's auto-complete a no-op, so
 * `onComplete` does not fire). `{ outcome: 'completed', skipped:
 * 'turn_terminated' }` qualifies: the turn genuinely ended on a prior attempt
 * (durable marker), this claim just observed it. (Task #944 review.)
 */
export function isCompletedTurnResult(result: Record<string, unknown> | null): boolean {
  return result?.outcome === 'completed';
}

/**
 * Whether a COMPLETED STEER job's persisted `result` represents a handoff the
 * delivery layer actually delivered (`consumed` on feed, `already_consumed` on
 * a reclaimed accepted steer). Like {@link isCompletedTurnResult}, this
 * excludes the non-delivery outcomes (`skipped`/`aborted`/`stale_attempt`/
 * `archived`/`no_content`). A steer settles at mid-turn consumption, so the
 * event alone is not a node-completion signal — but when the steer was the
 * LAST active job (the owning turn already settled while the ACP steer waited
 * on acceptance), its settlement must be published so consumers can repay the
 * suppressed terminal idle. (Task #944 review.)
 */
export function isSettledSteerResult(result: Record<string, unknown> | null): boolean {
  return result?.outcome === 'consumed' || result?.outcome === 'already_consumed';
}

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
 * Maximum times a STEER may park (owning turn blocked on `sdk_resume_choice`)
 * before it dead-letters. Parking uses `requeue` (no retry_count bump), so
 * without this bound a steer whose owning turn never unblocks re-parks every
 * {@link MESSAGE_DELIVERY_PARK_MS} indefinitely. ~5 min at the 5s park cadence;
 * the user can re-send if the owning turn was abandoned.
 */
export const MAX_STEER_PARKS = 60;

/**
 * Outcome of driving a turn.
 * - `completed` ⇒ the turn ran (or was already consumed and re-driven via history).
 * - `blocked` ⇒ query startup is blocked (sdk_resume_choice); park the job.
 * - `aborted` ⇒ revalidation immediately before feeding found the session archived
 *   or the message removed/re-classified (removePending TOCTOU) — do NOT feed.
 *   See Codex (#3742774841 archive barrier, #3696 removePending).
 * - `turn_terminated` ⇒ a re-claimed `consumed` turn whose turn already produced a
 *   terminal result after its consumption: nothing to resume, so the handler
 *   completes the job (frees the active-turn slot) instead of re-driving. Checked
 *   inside the bridge's locked section, immediately before arming the turn-end
 *   waiter, so a turn that ends in the check→arm window cannot be missed. See
 *   Codex (PR #2463, P2).
 */
export type DriveTurnOutcome =
  | { outcome: 'completed' }
  | { outcome: 'blocked'; retryAt: number }
  | { outcome: 'aborted' }
  | { outcome: 'turn_terminated' };

/**
 * Outcome of feeding a steer.
 * - `consumed` ⇒ the SDK consumed it (steered into the live turn).
 * - `awaiting_acceptance` ⇒ (ACP only) the prompt reached the subprocess (onSent
 *   ≡ onSubmitted), but the consume boundary is acceptance, which fires async
 *   from the ACP runner. The handler parks the job (bounded) so it stays alive
 *   rather than auto-completing at submission — if acceptance never comes the
 *   job dead-letters → `failed` (surfaces) instead of stranding the row with no
 *   job to retry it. On re-run the row is `submitted`/`consumed` (settled by the
 *   handler's skip/alreadyConsumed paths) or still `enqueued` with the message
 *   already admitted (the bridge suppresses the re-admit), so this never
 *   re-feeds.
 * - `promote` ⇒ no live turn; re-enqueue as a turn.
 * - `park` ⇒ the owning turn is BLOCKED (sdk_resume_choice, session `queued`),
 *   not actively processing — the steer can neither feed (no live generator) nor
 *   promote (the parked turn still holds the active-turn slot). Park it with the
 *   turn's delay so it is NOT reclaimed every poll (hot loop); it re-evaluates
 *   when the turn unblocks. See Codex (#3742693683).
 */
export type FeedSteerOutcome =
  | { outcome: 'consumed' }
  | { outcome: 'awaiting_acceptance' }
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
    claimGuard?: () => boolean,
    /**
     * Batched queue flush: UUIDs whose content was folded into `content`;
     * the bridge flips them to `consumed` together with the kickoff.
     */
    batchUuids?: string[]
  ): Promise<DriveTurnOutcome>;
  feedDeliverySteer(
    messageUuid: string,
    content: DeliveryContent,
    parentToolUseId?: string | null,
    claimGuard?: () => boolean
  ): Promise<FeedSteerOutcome>;
  /**
   * True while the session's human gate is open (an unanswered
   * `sdk_resume_choice` / `waiting_for_input`). Used by the handler to keep a
   * parked steer parked (without burning its park budget) as long as the owning
   * turn is legitimately blocked on a live choice — abandonment is based on the
   * gate resolving, not elapsed parks. (Codex #11.)
   */
  isWaitingForInput?(): boolean;
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
 * ACP's consume boundary is *acceptance* (markMessageAccepted), which can lag
 * submission by minutes while the ACP process runs. The default 30s
 * queue-admission consume-wait would terminalize a fresh ACP delivery as failed
 * mid-run (→ a direct caller retries with a new UUID → the work runs twice), so
 * ACP-targeted awaitDeliveryConsumption callers pass this acceptance-sized
 * timeout. (Codex review, P1.)
 */
export const ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS = 12 * 60 * 1000;

/**
 * Park budget for an ACP steer awaiting subprocess acceptance. Valid ACP
 * acceptance can lag submission by up to {@link ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS}
 * (12min) while the subprocess executes, so the shared {@link MAX_STEER_PARKS}
 * (~5min at the 5s park cadence) would dead-letter a still-executing request →
 * `failed`, and a later markMessageAccepted cannot consume a failed row — the
 * injector then times out and re-runs work the subprocess already accepted
 * (duplicate execution). Sized to cover the full acceptance window at the park
 * cadence PLUS a MAX_STEER_PARKS headroom for parks burned earlier in the
 * job's lifetime (e.g. parked behind a blocked turn before submission).
 * (Codex review.)
 */
export const MAX_ACP_STEER_PARKS =
  Math.ceil(ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS / MESSAGE_DELIVERY_PARK_MS) + MAX_STEER_PARKS;

/** Acceptance-sized consume timeout for ACP sessions; undefined → default. */
export function deliveryConsumptionTimeoutMs(provider?: string): number | undefined {
  return provider === 'acp' ? ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS : undefined;
}

/**
 * Await a durable delivery job's SDK consumption (onSent) after enqueueing it,
 * restoring the legacy "delivered = consumed" semantic. `deliver` performs the
 * enqueue (e.g. {@link deliverAndMarkQueued}); the await races the consumption
 * signal against a timeout (HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS, default
 * 30s, matching the legacy MessageQueue timeout) and rejects on timeout so a
 * caller doesn't acknowledge a delivery that may yet dead-letter.
 *
 * `timeoutMs` overrides the default — needed for ACP targets, whose consume
 * boundary is *acceptance* (signalDeliveryConsumed fires from
 * `markMessageAccepted`, not onSent), and an ACP request can run for minutes
 * before accepting. The 30s queue-admission default would fire while the ACP
 * process is still executing → a fresh row is terminalized failed → a direct
 * caller retries with a new UUID and the work runs twice. Callers that may
 * target an ACP session pass an acceptance-sized timeout. (Codex review, P1.)
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
  /** Override the default 30s consume-wait timeout (e.g. ACP acceptance). */
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
      } catch {
        // Non-fatal — the durable job is already enqueued; the handler will
        // drive the turn. Mirrors deliverChatMessage's warn-and-continue.
      }
    }
  });
}
