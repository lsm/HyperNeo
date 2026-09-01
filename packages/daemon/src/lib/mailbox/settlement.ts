import type { MailboxEntry } from './entry.ts';

export type MailboxSettleOutcome =
  | { kind: 'consumed' }
  | { kind: 'requeued'; attempt: number }
  | { kind: 'dead'; reason: string };

export type MailboxTerminal = 'delivered' | 'dead';

export interface MailboxSettlement {
  entryId: string;
  sessionId: string | null;
  terminal: MailboxTerminal;
  reason: string | null;
  settledAt: number;
}

export function settleMailboxEntry(
  entry: MailboxEntry,
  terminal: MailboxTerminal,
  settledAt: number,
  reason?: string
): MailboxSettlement {
  return {
    entryId: entry.id,
    sessionId: entry.to.kind === 'session' ? entry.to.sessionId : null,
    terminal,
    reason: reason ?? null,
    settledAt,
  };
}

export function expireMailboxEntries(_nowMs?: number): number {
  throw new Error('mailbox: expireMailboxEntries not implemented');
}
