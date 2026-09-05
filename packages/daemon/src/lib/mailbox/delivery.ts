import { createHash } from 'node:crypto';
import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { DeadLetterImmediatelyError, type JobHandler } from '../../storage/job-queue-processor.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { MessageDeliveryOrigin } from '../agent/message-delivery.ts';
import { ensurePrompt, type PromptHold } from '../agent/message-delivery-outbox.ts';
import { parseMailboxEntry } from './entry.ts';
import { type MailboxSettlement, settleMailboxEntry } from './settlement.ts';

export type MailboxDeliveryOutcome = MailboxSettlement | { kind: 'failed'; reason: string };

export interface MailboxDeliveryDeps {
  jobQueue: JobQueueRepository;
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  getSession(sessionId: string): Promise<object | null>;
  isSessionArchived(sessionId: string): boolean;
}

export function createMailboxDeadHandler(logError: (message: string) => void) {
  return (job: Job): void => {
    const entryId = typeof job.payload.id === 'string' ? job.payload.id : 'unknown';
    logError(`mailbox: entry ${entryId} dead-lettered: ${job.error ?? 'unknown error'}`);
  };
}

const MAILBOX_MESSAGE_UUID_PREFIX = 'mbox-';

function deterministicUuid(entryId: string): NonNullable<SDKUserMessage['uuid']> {
  const digest = createHash('sha256').update(entryId).digest('hex');
  return `${MAILBOX_MESSAGE_UUID_PREFIX}${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}` as NonNullable<
    SDKUserMessage['uuid']
  >;
}

function isMailboxDeliveryOrigin(origin: string): origin is MessageDeliveryOrigin {
  return (
    origin === 'chat' ||
    origin === 'space_inject' ||
    origin === 'space_agent' ||
    origin === 'long_term_agent' ||
    origin === 'recovery'
  );
}

function mapOrigin(origin: string): MessageDeliveryOrigin {
  return isMailboxDeliveryOrigin(origin) ? origin : 'space_inject';
}

export function createMailboxDeliveryHandler(deps: MailboxDeliveryDeps): JobHandler {
  return async (job) => {
    const entry = parseMailboxEntry(job.payload);
    if (entry === null) {
      throw new DeadLetterImmediatelyError('mailbox: corrupt entry payload');
    }
    if (entry.to.kind !== 'session') {
      throw new DeadLetterImmediatelyError(
        'mailbox: agent address reached delivery — resolution belongs upstream'
      );
    }
    const target = entry.to.sessionId;
    if (deps.isSessionArchived(target)) {
      throw new DeadLetterImmediatelyError('mailbox: target session archived');
    }
    if ((await deps.getSession(target)) === null) {
      throw new Error(`mailbox: session ${target} not found`);
    }
    if (!deps.jobQueue.isClaimCurrent(job.id, job.claimToken)) {
      return { outcome: 'stale_attempt' };
    }
    if (deps.isSessionArchived(target)) {
      throw new DeadLetterImmediatelyError('mailbox: target session archived');
    }
    const synthetic = entry.origin !== 'chat';
    const message: SDKUserMessage = {
      ...entry.message,
      uuid: deterministicUuid(entry.id),
      session_id: target,
      ...(synthetic ? { isSynthetic: true } : {}),
    };
    ensurePrompt({
      sessionId: target,
      message,
      ...(synthetic ? { origin: 'system' as MessageOrigin } : {}),
      ...(entry.deliveryMode === 'defer' ? { hold: 'manual' as PromptHold } : {}),
      delivery: { origin: mapOrigin(entry.origin), parentToolUseId: null },
      db: deps.db,
      sdkMessageRepo: deps.sdkMessageRepo,
      jobQueue: deps.jobQueue,
    });
    return { ...settleMailboxEntry(entry, 'delivered', Date.now()) };
  };
}
