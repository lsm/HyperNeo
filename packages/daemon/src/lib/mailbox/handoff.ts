import type { MailboxEntryPolicy, MailboxMessage } from './entry.ts';

export type MailboxHandoffOutcome =
  | { kind: 'enqueued'; id: string }
  | { kind: 'rejected'; reason: string };

export function handoffPromptToMailbox(_args: {
  to: string;
  message: MailboxMessage;
  origin: string;
  policy?: Partial<MailboxEntryPolicy>;
}): MailboxHandoffOutcome {
  throw new Error('mailbox: handoffPromptToMailbox not implemented');
}
