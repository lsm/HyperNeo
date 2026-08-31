import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { MailboxEntry } from './entry.ts';

export const MAILBOX_LANE = 'mailbox';

export type MailboxEnqueueOutcome =
  | { kind: 'enqueued'; id: string }
  | { kind: 'rejected'; reason: string };

export function enqueueMailboxEntry(
  jobQueue: JobQueueRepository,
  entry: MailboxEntry
): MailboxEnqueueOutcome {
  let serialized: string;
  try {
    serialized = JSON.stringify(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'rejected', reason: `entry failed serialization: ${message}` };
  }
  jobQueue.enqueueUniquePending({
    queue: MAILBOX_LANE,
    payload: JSON.parse(serialized) as Record<string, unknown>,
    priority: entry.policy.priority,
    matchPayload: { id: entry.id },
    activeStatuses: ['pending', 'processing'],
  });
  return { kind: 'enqueued', id: entry.id };
}
