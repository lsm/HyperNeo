import type { MailboxEntry } from './entry.ts';
import type { MailboxDeliveryOutcome } from './delivery.ts';

export type MailboxSettleOutcome =
  | { kind: 'consumed' }
  | { kind: 'requeued'; attempt: number }
  | { kind: 'dead'; reason: string };

export function settleMailboxEntry(
  _entry: MailboxEntry,
  _outcome: MailboxDeliveryOutcome
): MailboxSettleOutcome {
  throw new Error('mailbox: settleMailboxEntry not implemented');
}

export function expireMailboxEntries(_nowMs?: number): number {
  throw new Error('mailbox: expireMailboxEntries not implemented');
}
