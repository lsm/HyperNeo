import { MAILBOX_LANE } from '../mailbox/enqueue.ts';

export type ReminderOccurrenceState = 'absent' | 'enqueued' | 'consumed';

type ReminderSendStatus = 'deferred' | 'enqueued' | 'submitted' | 'consumed';

const CLAIMED_SEND_STATUSES: readonly ReminderSendStatus[] = [
  'deferred',
  'enqueued',
  'submitted',
  'consumed',
];

export interface ReminderOccurrenceReader {
  getMessageByStatusAndUuid(sessionId: string, status: ReminderSendStatus, uuid: string): unknown;
}

export interface ReminderClaimReader extends ReminderOccurrenceReader {
  getJobQueueRepo(): {
    listActiveByPayload(queue: string, matchPayload: Record<string, unknown>): unknown[];
  };
  getSDKMessageRepo(): { hasConsumptionEvidence(sessionId: string, messageId: string): boolean };
}

const reminderDeliveriesInFlight = new Map<string, Promise<unknown>>();

export function isReminderDeliveryInFlight(reminderId: string): boolean {
  return reminderDeliveriesInFlight.has(reminderId);
}

export function claimReminderDelivery(reminderId: string, delivery: Promise<unknown>): void {
  reminderDeliveriesInFlight.set(reminderId, delivery);
  const release = () => {
    if (reminderDeliveriesInFlight.get(reminderId) === delivery) {
      reminderDeliveriesInFlight.delete(reminderId);
    }
  };
  delivery.then(release, release);
}

export function reminderOccurrenceKey(reminderId: string, nextRunAt: number | null): string {
  return `reminder:${reminderId}:${nextRunAt}`;
}

export function readReminderOccurrenceState(
  db: ReminderOccurrenceReader | null | undefined,
  sessionId: string,
  idempotencyKey: string
): ReminderOccurrenceState {
  if (!db) return 'absent';
  if (db.getMessageByStatusAndUuid(sessionId, 'consumed', idempotencyKey) != null) {
    return 'consumed';
  }
  if (db.getMessageByStatusAndUuid(sessionId, 'enqueued', idempotencyKey) != null) {
    return 'enqueued';
  }
  return 'absent';
}

export function reminderOccurrenceIsClaimed(
  db: ReminderClaimReader | null | undefined,
  sessionId: string,
  idempotencyKey: string
): boolean {
  if (!db) return false;
  const queued = db.getJobQueueRepo().listActiveByPayload(MAILBOX_LANE, {
    'to.sessionId': sessionId,
    messageUuid: idempotencyKey,
  });
  if (queued.length > 0) return true;
  if (db.getSDKMessageRepo().hasConsumptionEvidence(sessionId, idempotencyKey)) return true;
  return CLAIMED_SEND_STATUSES.some(
    (status) => db.getMessageByStatusAndUuid(sessionId, status, idempotencyKey) != null
  );
}
