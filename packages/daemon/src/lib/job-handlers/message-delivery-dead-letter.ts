/**
 * message_delivery dead-letter settlement — extracted from app.ts's `onDead`
 * hook so the load-bearing ordering (session.error BEFORE queued-marker
 * settlement for a task-agent kickoff) is unit-testable without full app wiring.
 */

import type { MessageDeliveryPayload } from '../agent/message-delivery';

/** The narrow settlement operations a dead-letter performs. app.ts adapts its
 *  reactiveDb / internal event bus / session manager to this interface. */
export interface MessageDeliveryDeadLetterSettlement {
  /** Terminalize the persisted kickoff row as `failed`; returns its db id. */
  markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null;
  /** Broadcast the row's status flip so pagination/UI reflects the failure. */
  publishStatusChanged(sessionId: string, messageIds: string[]): Promise<unknown>;
  /** Publish a terminal `session.error` for the session. */
  publishSessionError(sessionId: string, error: string): Promise<unknown>;
  /** Release the pre-claim queued marker still owned by this terminal turn. */
  settleSkippedDelivery(messageUuid: string): Promise<unknown>;
}

export const DEAD_LETTER_SESSION_ERROR =
  'Task-agent kickoff delivery exhausted its retries (dead-lettered).';

/**
 * Settle a dead-lettered message_delivery job: terminalize the persisted row,
 * broadcast the status, and (for a task-agent `space_inject` kickoff) emit
 * `session.error` BEFORE settling the queued marker.
 *
 * The ordering matters: the settlement publishes an idle transition, and
 * `registerCompletionCallback` would otherwise treat that idle as successful
 * work (the failed kickoff row itself satisfies the SDK-message count). The
 * `session.error` fires the callback's error path → `handleSubSessionError`
 * marks the node execution `blocked` instead. (Codex P1.)
 */
export async function settleMessageDeliveryDeadLetter(
  payload: MessageDeliveryPayload,
  settlement: MessageDeliveryDeadLetterSettlement
): Promise<void> {
  // Batch-aware: a dead-lettered batched turn terminalizes every member row
  // (they own no job of their own — without this they'd linger `enqueued`,
  // hidden by pagination, with nothing left to deliver them).
  const uuids = [payload.messageUuid, ...(payload.batchUuids ?? [])];
  const flippedIds: string[] = [];
  for (const uuid of new Set(uuids)) {
    const flipped = settlement.markDeliveryFailedByUuid(payload.sessionId, uuid);
    if (flipped) flippedIds.push(flipped);
  }
  if (flippedIds.length > 0) {
    // Fire-and-forget BUT guarded: a rejecting messages.statusChanged subscriber
    // must not surface as an unhandled rejection in the dead-letter path. (Codex P1.)
    void settlement.publishStatusChanged(payload.sessionId, flippedIds).catch(() => {});
  }
  // Only a dead-lettered KICKOFF (the node's initial turn) should mark the
  // execution blocked. `space_inject` is also the origin for ordinary peer/human
  // handoffs delivered to an already-running node session, which are steers
  // (role !== 'turn') — a failed mid-turn handoff must NOT block a node whose
  // kickoff + current turn succeeded. (Codex P1.)
  if (payload.origin === 'space_inject' && payload.role === 'turn') {
    try {
      await settlement.publishSessionError(payload.sessionId, DEAD_LETTER_SESSION_ERROR);
    } catch {
      /* best-effort — settlement must still run */
    }
  }
  await settlement.settleSkippedDelivery(payload.messageUuid);
}
