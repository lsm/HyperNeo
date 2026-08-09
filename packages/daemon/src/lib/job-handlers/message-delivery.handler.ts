/**
 * message-delivery.handler — the job_queue handler for durable user-message
 * delivery (v2). Owns one job at a time and routes it by role:
 *
 *   turn  → drive a new SDK turn (ensureQueryStarted, feed transport, await the
 *           turn's terminal outcome). Blocked startup (sdk_resume_choice) parks
 *           the job back to pending (runAt) instead of failing it.
 *   steer → feed the active turn's live transport; completes on SDK consume
 *           (enqueueWithId resolves on `onSent`). If the turn ended between
 *           enqueue and claim, the steer is promoted to a fresh turn candidate.
 *
 * Per-session serialization is enforced by an in-process session lock: two
 * processor slots could otherwise claim a turn + its steer concurrently and
 * race the brief turn start/stop windows. The lock guards lifecycle
 * transitions; the feed itself is concurrent-safe.
 *
 * The processor auto-completes a job on handler return and auto-fails on throw
 * (→ job_queue backoff → dead). Park uses `repo.requeue` (pending + runAt, no
 * retry bump); the processor's subsequent `complete()` is then a no-op because
 * the row is no longer `processing`.
 *
 * See docs/features/message-delivery-v2.md §8–§10.
 */

import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { JobHandler } from '../../storage/job-queue-processor';
import {
  asMessageDeliveryPayload,
  deliverMessage,
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

/** In-process per-session mutex. Guards turn start/stop transitions. */
const sessionLocks = new Map<string, Promise<unknown>>();

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  // The synchronous read-then-set below has no await, so concurrent callers
  // chain deterministically (single event loop).
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

    return withSessionLock(payload.sessionId, async () => {
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
        const result = await session.driveDeliveryTurn(
          payload.messageUuid,
          content,
          payload.parentToolUseId
        );
        if (result.outcome === 'blocked') {
          // Park: return to pending with runAt, no retry bump. The processor's
          // auto-complete() is a no-op (row is no longer 'processing').
          deps.jobQueue.requeue(job.id, result.retryAt);
          return { parked: 'sdk_resume_choice', retryAt: result.retryAt };
        }
        return { outcome: 'completed' };
      }

      // role === 'steer'
      const result = await session.feedDeliverySteer(
        payload.messageUuid,
        content,
        payload.parentToolUseId
      );
      if (result.outcome === 'promote') {
        // The turn ended between enqueue and claim — re-enter through the
        // chokepoint and let the index arbiter decide: if no turn is active this
        // becomes a fresh turn, else (a new turn started meanwhile) a steer for
        // it. Either is correct; forcing role:'turn' could trip the UNIQUE guard.
        deliverMessage(deps.jobQueue, payload.sessionId, payload.messageUuid, {
          origin: payload.origin,
          parentToolUseId: payload.parentToolUseId,
        });
        return { outcome: 'superseded', promoted: true };
      }
      return { outcome: 'consumed' };
    });
  };
}

export { withSessionLock };
