import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  canonicalJson,
  normalizePromptForComparison,
  PromptContentConflictError,
} from '../agent/prompt-comparison.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { toMailboxMessage, type MailboxEntry, type MailboxMessage } from './entry.ts';

export const MAILBOX_LANE = 'mailbox';

export type MailboxEnqueueOutcome =
  | { kind: 'enqueued'; id: string }
  | { kind: 'rejected'; reason: string };

export function assertNoPendingMailboxContentConflict(
  jobQueue: JobQueueRepository,
  sessionId: string,
  messageUuid: string,
  message: MailboxMessage
): void {
  const projected = toMailboxMessage(message);
  if ('reason' in projected) return;
  const incoming = canonicalJson(
    normalizePromptForComparison(projected.message as unknown as SDKMessage)
  );
  for (const job of jobQueue.listActiveByPayload(MAILBOX_LANE, {
    'to.sessionId': sessionId,
    messageUuid,
  })) {
    const pending = (job.payload as Record<string, unknown>).message as MailboxMessage | undefined;
    if (pending === undefined) continue;
    const pendingProjected = toMailboxMessage(pending);
    if ('reason' in pendingProjected) continue;
    if (
      canonicalJson(
        normalizePromptForComparison(pendingProjected.message as unknown as SDKMessage)
      ) !== incoming
    ) {
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
