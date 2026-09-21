import { longTermAgentSessionId } from '../space/long-term-agent-session.ts';

export type ReminderOccurrenceState = 'absent' | 'enqueued' | 'consumed';

export interface ReminderOccurrenceReader {
  getMessageByStatusAndUuid(
    sessionId: string,
    status: 'enqueued' | 'consumed',
    uuid: string
  ): unknown;
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
  spaceId: string,
  agentId: string,
  idempotencyKey: string
): ReminderOccurrenceState {
  if (!db) return 'absent';
  const sessionId = longTermAgentSessionId(spaceId, agentId);
  if (db.getMessageByStatusAndUuid(sessionId, 'consumed', idempotencyKey) != null) {
    return 'consumed';
  }
  if (db.getMessageByStatusAndUuid(sessionId, 'enqueued', idempotencyKey) != null) {
    return 'enqueued';
  }
  return 'absent';
}
