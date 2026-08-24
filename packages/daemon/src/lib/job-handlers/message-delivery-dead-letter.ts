import type { MessageDeliveryPayload } from '../agent/message-delivery';

export interface MessageDeliveryDeadLetterSettlement {
  markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null;
  publishStatusChanged(sessionId: string, messageIds: string[]): Promise<unknown>;
  publishSessionError(sessionId: string, error: string): Promise<unknown>;
  settleSkippedDelivery(messageUuid: string): Promise<unknown>;
  resetStuckProcessingState?(sessionId: string, messageUuid: string): Promise<unknown> | void;
}

export const DEAD_LETTER_SESSION_ERROR =
  'Task-agent kickoff delivery exhausted its retries (dead-lettered).';

export async function settleMessageDeliveryDeadLetter(
  payload: MessageDeliveryPayload,
  settlement: MessageDeliveryDeadLetterSettlement
): Promise<void> {
  const uuids = [payload.messageUuid, ...(payload.batchUuids ?? [])];
  const flippedIds: string[] = [];
  for (const uuid of new Set(uuids)) {
    const flipped = settlement.markDeliveryFailedByUuid(payload.sessionId, uuid);
    if (flipped) flippedIds.push(flipped);
  }
  if (flippedIds.length > 0) {
    void settlement.publishStatusChanged(payload.sessionId, flippedIds).catch(() => {});
  }
  if (payload.origin === 'space_inject' && payload.role === 'turn') {
    try {
      await settlement.publishSessionError(payload.sessionId, DEAD_LETTER_SESSION_ERROR);
    } catch {}
  }
  if (settlement.resetStuckProcessingState) {
    try {
      await settlement.resetStuckProcessingState(payload.sessionId, payload.messageUuid);
    } catch {}
  }
  await settlement.settleSkippedDelivery(payload.messageUuid);
}
