import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';
import type { MailboxEntry } from './entry.ts';

export function mapPendingAgentRowToMailboxEntry(_row: PendingAgentMessageRecord): MailboxEntry {
  throw new Error('mailbox: mapPendingAgentRowToMailboxEntry not implemented');
}
