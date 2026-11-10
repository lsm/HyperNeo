import type { MessageDeliveryPayload } from '../agent/message-delivery.ts';

export interface MessageDeliveryDeadLetterSettlement {
  markDeliveryFailedByUuid(sessionId: string, uuid: string): Promise<string | null>;
  publishStatusChanged(sessionId: string, messageIds: string[]): Promise<unknown>;
  publishSessionError(sessionId: string, error: string): Promise<unknown>;
  settleSkippedDelivery(messageUuid: string): Promise<unknown>;
  resetStuckProcessingState?(sessionId: string, messageUuid: string): Promise<unknown> | void;
}

export const DEAD_LETTER_SESSION_ERROR = 'Message delivery failed and was dead-lettered.';

export const deadLetterSessionError = (error: string | null | undefined) =>
  error ? `Message delivery failed: ${error}` : DEAD_LETTER_SESSION_ERROR;

export async function settleMessageDeliveryDeadLetter(
  payload: MessageDeliveryPayload,
  settlement: MessageDeliveryDeadLetterSettlement,
  error?: string | null
): Promise<void> {
  const flipped = await settlement.markDeliveryFailedByUuid(payload.sessionId, payload.messageUuid);
  if (flipped) {
    void settlement.publishStatusChanged(payload.sessionId, [flipped]).catch(() => {});
  }
  if (payload.origin === 'space_inject' && payload.injectedMidTurn !== true) {
    try {
      await settlement.publishSessionError(payload.sessionId, deadLetterSessionError(error));
    } catch {}
  }
  if (settlement.resetStuckProcessingState) {
    try {
      await settlement.resetStuckProcessingState(payload.sessionId, payload.messageUuid);
    } catch {}
  }
  await settlement.settleSkippedDelivery(payload.messageUuid);
}
