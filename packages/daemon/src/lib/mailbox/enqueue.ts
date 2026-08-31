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
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(entry));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        kind: 'rejected',
        reason: 'entry failed serialization: serialized entry is not a JSON object',
      };
    }
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'rejected', reason: `entry failed serialization: ${message}` };
  }
  jobQueue.enqueueUniquePending({
    queue: MAILBOX_LANE,
    payload,
    priority: entry.policy.priority,
    matchPayload: { id: entry.id },
    activeStatuses: ['pending', 'processing'],
  });
  return { kind: 'enqueued', id: entry.id };
}
