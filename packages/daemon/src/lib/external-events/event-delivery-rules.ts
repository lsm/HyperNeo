import { createHash } from 'node:crypto';

export const IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX = 'ev-';

export function buildImmediateEventMessageUuid(eventId: string, deliveryKey: string): string {
  const digest = createHash('sha256').update(`${eventId}\u0000${deliveryKey}`).digest('hex');
  return (
    `${IMMEDIATE_EVENT_MESSAGE_UUID_PREFIX}${digest.slice(0, 8)}-${digest.slice(8, 12)}` +
    `-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
  );
}

export const DEFAULT_EXTERNAL_EVENT_QUEUE_TTL_MS = 300_000;

export function isQueuedExternalEventExpired(
  createdAt: number,
  now = Date.now(),
  ttlMs = DEFAULT_EXTERNAL_EVENT_QUEUE_TTL_MS
): boolean {
  return now - createdAt > ttlMs;
}
