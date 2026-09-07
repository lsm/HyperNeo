import { PromptContentConflictError } from '../agent/message-delivery-outbox.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { MailboxEntry } from './entry.ts';

export const MAILBOX_LANE = 'mailbox';

export type MailboxEnqueueOutcome =
  | { kind: 'enqueued'; id: string }
  | { kind: 'rejected'; reason: string };

export function assertNoPendingMailboxContentConflict(
  jobQueue: JobQueueRepository,
  sessionId: string,
  messageUuid: string,
  content: unknown
): void {
  for (const job of jobQueue.listActiveByPayload(MAILBOX_LANE, {
    'to.sessionId': sessionId,
    messageUuid,
  })) {
    const pending = (
      (job.payload as Record<string, unknown>).message as
        | { message?: { content?: unknown } }
        | undefined
    )?.message?.content;
    if (JSON.stringify(pending) !== JSON.stringify(content)) {
      throw new PromptContentConflictError(
        `prompt handoff: message ${messageUuid} in session ${sessionId} ` +
          'already exists with different content'
      );
    }
  }
}

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
    maxRetries: Math.max(0, entry.policy.maxAttempts - 1),
    matchPayload: { id: entry.id },
    activeStatuses: ['pending', 'processing'],
  });
  return { kind: 'enqueued', id: entry.id };
}
