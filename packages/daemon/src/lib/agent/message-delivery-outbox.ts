/**
 * Transactional outbox for durable message delivery (task #861 item 2).
 *
 * Closes the crash window between persisting a user message (`saveUserMessage`
 * on `sdk_messages`) and enqueuing its durable delivery job (`deliverMessage`
 * → `job_queue`). Before this, the two were separate transactions: a daemon
 * crash between them left a saved-but-not-enqueued row — a prompt the user
 * sees gone (pagination hides non-`consumed` rows) with no `job_queue` owner to
 * drive it. `persistAndEnqueueDelivery` runs the SDK-message insert AND the
 * role-arbitrated `job_queue` enqueue in ONE `db.transaction`, so the two
 * writes commit atomically: either both land, or neither does. The
 * saved-but-not-enqueued class is eliminated by construction.
 *
 * Delivery semantics stay **at-least-once** (NOT at-most-once): a crash after
 * commit but before the SDK consumes is still recovered by `reclaimStale` +
 * the handler's status-aware reload. The outbox only removes the
 * *persisted-but-never-enqueued* gap; it does not change redelivery semantics.
 *
 * Role arbitration is the same atomic `uq_message_delivery_active_turn` index
 * decision used by {@link deliverMessage}: insert `role:'turn'`; on a UNIQUE
 * violation (an active turn already owns the session) insert `role:'steer'`.
 * Because both inserts run inside the outer transaction, the ABORT-on-constraint
 * rolls back only the offending statement — the save and the eventual steer
 * insert still commit together.
 *
 * See docs/features/message-delivery-v2.md §7 + §16 (task #861 item 2).
 */

import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type {
  SDKMessageRepository,
  SendStatus,
} from '../../storage/repositories/sdk-message-repository';
import { extractSdkUuid } from '../../storage/repositories/sdk-message-repository';
import { MESSAGE_DELIVERY } from '../job-queue-constants';
import {
  isUniqueConstraintError,
  MESSAGE_DELIVERY_MAX_RETRIES,
  type MessageDeliveryOrigin,
  type MessageDeliveryRole,
} from './message-delivery';

export interface PersistAndEnqueueDeliveryArgs {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  sessionId: string;
  message: SDKMessage;
  sendStatus: SendStatus;
  origin?: MessageOrigin;
  delivery: { origin: MessageDeliveryOrigin; parentToolUseId?: string | null };
}

export interface PersistAndEnqueueDeliveryResult {
  dbMessageId: string;
  role: MessageDeliveryRole;
}

/** Delivery jobs share the same retry budget as {@link deliverMessage}. */
const DELIVERY_MAX_RETRIES = MESSAGE_DELIVERY_MAX_RETRIES;

/**
 * Persist a user message and enqueue its durable delivery job in ONE
 * transaction (the transactional outbox). Returns the persisted row id and the
 * role the job inserted as (`turn` or `steer`). Throws (rolling back BOTH
 * writes) if either fails — so a transient SQLite error can never leave a
 * saved-but-not-enqueued row.
 *
 * The caller MUST have already done any idempotency check it needs (e.g.
 * `getDeliveryContent` for injectors that retry with a stable id). This helper
 * assumes a fresh save+enqueue.
 */
export function persistAndEnqueueDelivery(
  args: PersistAndEnqueueDeliveryArgs
): PersistAndEnqueueDeliveryResult {
  const messageUuid = extractSdkUuid(args.message);
  if (!messageUuid) {
    throw new Error('persistAndEnqueueDelivery: message has no uuid; cannot enqueue delivery');
  }
  const { db, sdkMessageRepo, jobQueue, sessionId, message, sendStatus, origin } = args;
  const basePayload = {
    sessionId,
    messageUuid,
    role: 'turn' as const,
    origin: args.delivery.origin,
    parentToolUseId: args.delivery.parentToolUseId ?? null,
  };

  const result = db.transaction(() => {
    const core = sdkMessageRepo.saveUserMessageCore(sessionId, message, sendStatus, origin);
    // Atomic role arbitration by the uq_message_delivery_active_turn index:
    // insert turn; on UNIQUE (an active turn already owns the session) insert
    // steer. Both run inside this transaction; ABORT rolls back only the
    // offending statement, so the save + eventual steer still commit together.
    let role: MessageDeliveryRole;
    try {
      jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: basePayload,
        maxRetries: DELIVERY_MAX_RETRIES,
      });
      role = 'turn';
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { ...basePayload, role: 'steer' },
        maxRetries: DELIVERY_MAX_RETRIES,
      });
      role = 'steer';
    }
    return { core, role };
  })();

  // Post-commit side effects (live-query notify + FTS) — OUTSIDE the outbox tx
  // and best-effort: the outbox transaction has already committed both the user
  // row and the active delivery job, so a throw here (e.g. a fallible FTS
  // update) MUST NOT propagate. Propagating would reject the send request while
  // the durable job still runs, and a client retry with a fresh UUID would then
  // deliver the prompt twice. (Codex review.)
  try {
    sdkMessageRepo.runPostSaveSideEffects(
      sessionId,
      result.core.id,
      message,
      result.core.countsTowardsBadge
    );
  } catch {
    // best-effort — committed state is authoritative.
  }
  return { dbMessageId: result.core.id, role: result.role };
}
