import type { MailboxEntry } from './entry.ts';

export const MAILBOX_LANE = 'mailbox';

export type MailboxEnqueueOutcome =
  | { kind: 'enqueued'; id: string }
  | { kind: 'rejected'; reason: string };

export function enqueueMailboxEntry(_entry: MailboxEntry): MailboxEnqueueOutcome {
  throw new Error('mailbox: enqueueMailboxEntry not implemented');
}
