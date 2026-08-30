import type { MessageDeliveryPayload } from '../agent/message-delivery.ts';

export interface MessageDeliveryDeadLetterSettlement {
  markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null;
  publishStatusChanged(sessionId: string, messageIds: string[]): Promise<unknown>;
  publishSessionError(sessionId: string, error: string): Promise<unknown>;
  isSessionMidTurn?(sessionId: string): boolean;
  settleSkippedDelivery(messageUuid: string): Promise<unknown>;
  resetStuckProcessingState?(sessionId: string, messageUuid: string): Promise<unknown> | void;
}

export const DEAD_LETTER_SESSION_ERROR =
  'Task-agent kickoff delivery exhausted its retries (dead-lettered).';

export async function settleMessageDeliveryDeadLetter(
  payload: MessageDeliveryPayload,
  settlement: MessageDeliveryDeadLetterSettlement
): Promise<void> {
  const flipped = settlement.markDeliveryFailedByUuid(payload.sessionId, payload.messageUuid);
  if (flipped) {
    void settlement.publishStatusChanged(payload.sessionId, [flipped]).catch(() => {});
  }
  if (
    payload.origin === 'space_inject' &&
    settlement.isSessionMidTurn?.(payload.sessionId) !== true
  ) {
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
