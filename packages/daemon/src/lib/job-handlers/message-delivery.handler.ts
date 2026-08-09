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
 * The processor auto-completes a job on handler return and auto-fails on throw
 * (→ job_queue backoff → dead). Park uses `repo.requeue` (pending + runAt, no
 * retry bump); promote uses `repo.requeueAs` (converts the job to role:'turn'
 * in place — no second job, no crash-window double-deliver). The processor's
 * subsequent auto-complete() is a no-op in both cases (row is no longer
 * 'processing'). See docs/features/message-delivery-v2.md §8–§10.
 */

import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { JobHandler } from '../../storage/job-queue-processor';
import {
  asMessageDeliveryPayload,
  type DeliveryContent,
  type MessageDeliverySession,
} from '../agent/message-delivery';
import { Logger } from '../logger';

export interface MessageDeliveryHandlerDeps {
  jobQueue: JobQueueRepository;
  /** Resolve the live session, or null if it's gone (closed/evicted). */
  getSession(sessionId: string): MessageDeliverySession | null;
  /** Load the persisted message content by UUID (any send_status). */
  getMessageContent(sessionId: string, messageUuid: string): DeliveryContent | null;
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

    // Resolve session + content. These are brief/side-effect-free — no lock
    // needed (the lock guards turn start/stop inside the bridge).
    const session = deps.getSession(payload.sessionId);
    if (!session) {
      throw new Error(`message_delivery: session ${payload.sessionId} not found`);
    }
    const content = deps.getMessageContent(payload.sessionId, payload.messageUuid);
    if (content === null) {
      // Content gone (rewound/deleted) — nothing to deliver.
      log.warn(`message_delivery: content for ${payload.messageUuid} not found; completing.`);
      return { outcome: 'no_content' };
    }

    if (payload.role === 'turn') {
      // The bridge holds the per-session lock only for ensureQueryStarted +
      // kickoff feed; the turn await runs unlocked (so steering proceeds). The
      // lease heartbeat keeps the job from being reclaimed as stale mid-turn.
      const turn = session.driveDeliveryTurn(payload.messageUuid, content, payload.parentToolUseId);
      const heartbeat = setInterval(() => deps.jobQueue.touchStartedAt(job.id), LEASE_HEARTBEAT_MS);
      if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
        (heartbeat as { unref: () => void }).unref();
      }
      try {
        const result = await turn;
        if (result.outcome === 'blocked') {
          // Park: return to pending with runAt, no retry bump. The processor's
          // auto-complete() is a no-op (row is no longer 'processing').
          deps.jobQueue.requeue(job.id, result.retryAt);
          return { parked: 'sdk_resume_choice', retryAt: result.retryAt };
        }
        return { outcome: 'completed' };
      } finally {
        clearInterval(heartbeat);
      }
    }

    // role === 'steer'. The bridge checks state under the lock (brief) and feeds
    // unlocked (enqueueWithId resolves on onSent — concurrent-safe).
    const result = await session.feedDeliverySteer(
      payload.messageUuid,
      content,
      payload.parentToolUseId
    );
    if (result.outcome === 'promote') {
      // The turn ended between enqueue and claim — convert THIS job to a turn
      // in place (requeueAs) rather than completing it + enqueuing a second.
      // One job for the messageUuid → no crash-window double-deliver. If a new
      // turn became active in the race window, the active-turn index raises
      // UNIQUE on the UPDATE; fall back to requeuing as a steer (it'll feed the
      // new turn). Either way the message is delivered exactly once.
      try {
        deps.jobQueue.requeueAs(job.id, 'turn', Date.now());
        return { outcome: 'superseded', promoted: 'turn' };
      } catch (err) {
        if (/UNIQUE constraint/i.test(err instanceof Error ? err.message : String(err))) {
          deps.jobQueue.requeueAs(job.id, 'steer', Date.now());
          return { outcome: 'superseded', promoted: 'steer' };
        }
        throw err;
      }
    }
    return { outcome: 'consumed' };
  };
}
