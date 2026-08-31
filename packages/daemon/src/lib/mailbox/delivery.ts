import type { MailboxEntry } from './entry.ts';

export type MailboxDeliveryOutcome =
  | { kind: 'delivered'; sessionId: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'failed'; reason: string };

export function deliverMailboxEntry(_entry: MailboxEntry): Promise<MailboxDeliveryOutcome> {
  throw new Error('mailbox: deliverMailboxEntry not implemented');
}
