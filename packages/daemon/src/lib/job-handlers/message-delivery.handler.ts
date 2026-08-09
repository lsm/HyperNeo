/**
 * message-delivery.handler — the job_queue handler for durable user-message
 * delivery (v2). Owns one job at a time and routes it by role:
 *
 *   turn  → drive a new SDK turn (ensureQueryStarted, feed transport, await the
 *           turn's terminal outcome). Blocked startup (sdk_resume_choice) parks
 *           the job back to pending (runAt) instead of failing it.
 *   steer → feed the active turn's live transport; completes on SDK consume
 *           (enqueueWithId resolves on `onSent`). If the turn ended between
 *           enqueue and claim, the steer is promoted to a turn IN PLACE.
 *
 * The handler does NOT hold the per-session lock across the long turn await —
 * that would serialize mid-turn steering (the headline feature). The lock lives
 * inside the AgentSession bridge (driveDeliveryTurn/feedDeliverySteer) and is
 * held only for the brief start/stop + state-check windows; the long awaits
 * (turn promise, enqueueWithId-onSent) run unlocked. See message-delivery-v2.md
 * §8 + Codex review (lock-across-await).
 *
 * Lease heartbeat: a live SDK turn can exceed the generic reclaimStale window
 * (default 5min). The handler refreshes `started_at` (touchStartedAt) throughout
 * the turn await so a long-but-live turn is not reclaimed + re-delivered; a
 * crashed handler stops heartbeating, so reclaimStale still recovers it.
 *
 * Status-aware delivery (Codex #2592/#2597): the handler loads the message's
 * `send_status` and only feeds messages still pending (`enqueued`). A `consumed`
 * kickoff was already handed to the SDK by a prior attempt — re-feeding would
 * duplicate the prompt, so the turn is re-driven without the feed (history
 * replay holds it). A `deferred`/`failed` message is skipped (user deferred it /
 * already terminal). Archived sessions are rejected outright (their worktree is
 * gone). See message-delivery-v2.md §8.
 *
 * The processor auto-completes a job on handler return and auto-fails on throw
 * (→ job_queue backoff → dead; the lane's `onDead` then marks the persisted
 * message `failed`). Park uses `repo.requeue` (pending + runAt, no retry bump);
 * promote uses `repo.requeueAs` (converts the job to role:'turn' in place — no
 * second job, no crash-window double-deliver). The processor's subsequent
 * auto-complete() is a no-op in both cases (row is no longer 'processing'). See
 * docs/features/message-delivery-v2.md §8–§10.
 */

import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { JobHandler } from '../../storage/job-queue-processor';
import {
  asMessageDeliveryPayload,
  isUniqueConstraintError,
  MESSAGE_DELIVERY_PARK_MS,
  type DeliveryLoadResult,
  type MessageDeliverySession,
} from '../agent/message-delivery';
import { Logger } from '../logger';

export interface MessageDeliveryHandlerDeps {
  jobQueue: JobQueueRepository;
  /** Resolve the live session, or null if it's gone (closed/evicted). */
  getSession(sessionId: string): MessageDeliverySession | null;
  /** Load the persisted message content + send_status by UUID (any send_status). */
  getMessageContent(sessionId: string, messageUuid: string): DeliveryLoadResult | null;
  /**
   * True if the session's persisted status is `archived` (worktree torn down).
   * The handler completes — does not drive — archived sessions so a pending job
   * claimed after archive can't run the prompt against a destroyed session. See
   * Codex (#3742616723).
   */
  isSessionArchived?(sessionId: string): boolean;
  /** Terminalize a still-enqueued prompt when lifecycle rejection completes its job. */
  markDeliveryFailed?(sessionId: string, messageUuid: string): void;
}

/**
 * How often to refresh a live turn job's `started_at` so the generic
 * reclaimStale sweep (5min) does not reclaim + re-deliver a long turn. Well
 * inside the stale window; cheap (one UPDATE).
 */
const LEASE_HEARTBEAT_MS = 60_000;

/**
 * Build the job_queue handler for the `message_delivery` lane. Registered in
 * app.ts next to the other `jobProcessor.register(...)` calls.
 */
export function createMessageDeliveryHandler(deps: MessageDeliveryHandlerDeps): JobHandler {
  const log = new Logger('message-delivery.handler');

  return async (job: Job): Promise<Record<string, unknown>> => {
    const payload = asMessageDeliveryPayload(job.payload);
    if (!payload) {
      // Malformed payload — dead-letter rather than spin.
      throw new Error(`message_delivery: invalid payload ${JSON.stringify(job.payload)}`);
    }

    // A reclaimed attempt replaces __claimToken on the row. Check immediately
    // before every provider-facing path so a predecessor awakened after sleep or
    // event-loop suspension cannot admit the same UUID again.
    const claimCurrent = () => deps.jobQueue.isClaimCurrent(job.id, job.claimToken);
    if (!claimCurrent()) return { outcome: 'stale_attempt' };

    // Archived session: worktree + SDK subprocess are torn down. Driving a turn
    // here would recreate resources or run in the fallback workspace, so refuse
    // — complete the job (not a delivery failure, so don't dead-letter). The
    // session.archive path also cancels pending jobs, but this guards the claim
    // race. See Codex (#3742616723).
    if (deps.isSessionArchived?.(payload.sessionId)) {
      // The job may already be claimed between archive's persisted barrier and
      // cancelForSessionWithMessages. Terminalize before returning/completing;
      // otherwise cancellation no longer sees this completed job and its hidden
      // enqueued SDK row survives forever.
      deps.markDeliveryFailed?.(payload.sessionId, payload.messageUuid);
      await deps.getSession(payload.sessionId)?.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'archived' };
    }

    // Resolve session + content. These are brief/side-effect-free — no lock
    // needed (the lock guards turn start/stop inside the bridge).
    const session = deps.getSession(payload.sessionId);
    if (!session) {
      throw new Error(`message_delivery: session ${payload.sessionId} not found`);
    }
    const loaded = deps.getMessageContent(payload.sessionId, payload.messageUuid);
    if (loaded === null) {
      // Content gone (rewound/deleted) — nothing to deliver.
      log.warn(`message_delivery: content for ${payload.messageUuid} not found; completing.`);
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'no_content' };
    }
    const { content, sendStatus } = loaded;

    // Only deliver messages still pending. `consumed`/`deferred`/`failed` are
    // NOT re-fed (see the module doc + §8). `deferred`/`failed` skip outright;
    // a `consumed` turn is re-driven without the feed (below).
    if (sendStatus === 'deferred' || sendStatus === 'failed') {
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'skipped', sendStatus };
    }
    const alreadyConsumed = sendStatus === 'consumed';

    if (payload.role === 'turn') {
      // The bridge holds the per-session lock only for ensureQueryStarted +
      // kickoff feed; the turn await runs unlocked (so steering proceeds). The
      // lease heartbeat keeps the job from being reclaimed as stale mid-turn.
      // When alreadyConsumed, the bridge skips the feed (no duplicate).
      if (!claimCurrent()) return { outcome: 'stale_attempt' };
      const turn = session.driveDeliveryTurn(
        payload.messageUuid,
        content,
        payload.parentToolUseId,
        alreadyConsumed
      );
      const heartbeat = setInterval(
        () => deps.jobQueue.touchStartedAt(job.id, job.claimToken),
        LEASE_HEARTBEAT_MS
      );
      if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
        (heartbeat as { unref: () => void }).unref();
      }
      try {
        const result = await turn;
        if (result.outcome === 'blocked') {
          // Park: return to pending with runAt, no retry bump. The processor's
          // auto-complete() is a no-op (row is no longer 'processing').
          deps.jobQueue.requeue(job.id, result.retryAt, job.claimToken);
          return { parked: 'sdk_resume_choice', retryAt: result.retryAt };
        }
        if (result.outcome === 'aborted') {
          // Bridge revalidation found the session archived or the message removed
          // between load and feed — complete without feeding. See #3742774841/#3696.
          await session.settleSkippedDelivery?.(payload.messageUuid);
          return { outcome: 'aborted' };
        }
        return { outcome: 'completed' };
      } finally {
        clearInterval(heartbeat);
      }
    }

    // role === 'steer'. A consumed steer was already fed by a prior attempt —
    // done, don't re-feed (would duplicate). See Codex (#2592/#3742616720).
    if (alreadyConsumed) {
      return { outcome: 'already_consumed' };
    }

    // The bridge checks state under the lock (brief) and feeds unlocked
    // (enqueueWithId resolves on onSent — concurrent-safe; durable so a
    // yielded-but-unresumed steer does not TTL-out into a duplicate re-feed).
    if (!claimCurrent()) return { outcome: 'stale_attempt' };
    const result = await session.feedDeliverySteer(
      payload.messageUuid,
      content,
      payload.parentToolUseId
    );
    if (result.outcome === 'aborted') {
      // Bridge revalidation found the session archived or the message removed
      // between load and feed — complete without feeding. See #3742774841/#3696.
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'aborted' };
    }
    if (result.outcome === 'park') {
      // The owning turn is blocked (sdk_resume_choice, session `queued`): the
      // steer can neither feed nor promote (the parked turn holds the active-turn
      // slot). Park it with the turn's delay so it is NOT reclaimed every poll
      // (unbounded hot loop); it re-evaluates (feed/promote) when reclaimed after
      // the delay. See Codex (#3742693683).
      const retryAt = Date.now() + MESSAGE_DELIVERY_PARK_MS;
      deps.jobQueue.requeue(job.id, retryAt, job.claimToken);
      return { parked: 'turn_blocked', retryAt };
    }
    if (result.outcome === 'promote') {
      // The turn ended between enqueue and claim — convert THIS job to a turn
      // in place (requeueAs) rather than completing it + enqueuing a second.
      // One job for the messageUuid → no crash-window double-deliver. If a new
      // turn became active in the race window, the active-turn index raises
      // UNIQUE on the UPDATE; fall back to requeuing as a steer PARKED with the
      // delay (not runAt=now) so it doesn't hot-loop — it re-evaluates later.
      try {
        deps.jobQueue.requeueAs(job.id, 'turn', Date.now());
        return { outcome: 'superseded', promoted: 'turn' };
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          const retryAt = Date.now() + MESSAGE_DELIVERY_PARK_MS;
          deps.jobQueue.requeueAs(job.id, 'steer', retryAt);
          return { outcome: 'superseded', promoted: 'steer' };
        }
        throw err;
      }
    }
    return { outcome: 'consumed' };
  };
}
