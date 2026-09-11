import { DeadLetterImmediatelyError, type JobHandler } from '../../storage/job-queue-processor.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { activatePrompts, ensurePrompt, retryPrompt } from '../agent/message-delivery-outbox.ts';
import { planMailboxAdmission } from './admission-plan.ts';
import { parseMailboxEntry, type MailboxEntry } from './entry.ts';
import { type MailboxSettlement, settleMailboxEntry } from './settlement.ts';
import { mailboxEntryExpired } from './entry.ts';

export type MailboxDeliveryOutcome = MailboxSettlement | { kind: 'failed'; reason: string };

export interface MailboxDeliveryDeps {
  jobQueue: JobQueueRepository;
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  getSession(sessionId: string): Promise<object | null>;
  isSessionArchived(sessionId: string): boolean;
  captureAdmission?(entry: MailboxEntry): (() => 'admit' | 'settled' | 'blocked') | undefined;
  publishStatusChanged?(sessionId: string, dbId: string, status: 'enqueued'): void | Promise<void>;
  publishFailed?(sessionId: string, dbMessageId: string): Promise<void>;
  publishDeferredStatus?(sessionId: string, dbMessageId: string): Promise<void>;
  scheduleDeferredReplay?(sessionId: string): void | Promise<void>;
}

export function createMailboxDeadHandler(logError: (message: string) => void) {
  return (job: Job): void => {
    const entryId = typeof job.payload.id === 'string' ? job.payload.id : 'unknown';
    logError(`mailbox: entry ${entryId} dead-lettered: ${job.error ?? 'unknown error'}`);
  };
}

function readAdmissionRowid(db: BunDatabase, jobId: string): number | undefined {
  const row = db.prepare('SELECT rowid AS rid FROM job_queue WHERE id = ?').get(jobId) as
    | { rid: number }
    | undefined;
  return row?.rid;
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
    if (mailboxEntryExpired(entry, Date.now())) {
      throw new DeadLetterImmediatelyError('mailbox: entry expired (ttl)');
    }
    if (deps.isSessionArchived(target)) {
      throw new DeadLetterImmediatelyError('mailbox: target session archived');
    }
    const admission = deps.captureAdmission?.(entry);
    const canDeliver = () => {
      const status = admission?.();
      if (status === 'blocked') throw new Error('mailbox: direct owner unavailable');
      return status !== 'settled';
    };
    if (!canDeliver()) return { outcome: 'already_settled' };
    if ((await deps.getSession(target)) === null) {
      throw new Error(`mailbox: session ${target} not found`);
    }
    if (!deps.jobQueue.isClaimCurrent(job.id, job.claimToken)) {
      return { outcome: 'stale_attempt' };
    }
    if (deps.isSessionArchived(target)) {
      throw new DeadLetterImmediatelyError('mailbox: target session archived');
    }
    if (mailboxEntryExpired(entry, Date.now())) {
      throw new DeadLetterImmediatelyError('mailbox: entry expired (ttl)');
    }
    if (!canDeliver()) return { outcome: 'already_settled' };
    const admissionRowid = readAdmissionRowid(deps.db, job.id);
    const plan = planMailboxAdmission({ ...entry, to: entry.to }, admissionRowid);
    const messageUuid = plan.message.uuid;
    const existing = deps.sdkMessageRepo.getDeliveryContent(target, messageUuid);
    const publish = (dbId: string): void => {
      if (!deps.publishStatusChanged) return;
      try {
        void Promise.resolve(deps.publishStatusChanged(target, dbId, 'enqueued')).catch(() => {});
      } catch {
        return;
      }
    };
    const ensured = ensurePrompt({
      ...plan,
      db: deps.db,
      sdkMessageRepo: deps.sdkMessageRepo,
      jobQueue: deps.jobQueue,
    });
    if (ensured.created && entry.deliveryMode !== 'defer') {
      publish(ensured.dbMessageId);
    }
    if (existing?.sendStatus === 'failed' && entry.deliveryMode !== 'defer') {
      const retried = await retryPrompt({
        sessionId: target,
        messageUuid,
        ...plan.delivery,
        db: deps.db,
        sdkMessageRepo: deps.sdkMessageRepo,
        jobQueue: deps.jobQueue,
        claimValid: () => deps.jobQueue.isClaimCurrent(job.id, job.claimToken) && canDeliver(),
      });
      if (retried) publish(retried.dbId);
    } else if (existing?.sendStatus === 'deferred' && entry.deliveryMode !== 'defer') {
      const { activated } = await activatePrompts({
        db: deps.db,
        jobQueue: deps.jobQueue,
        sessionId: target,
        messageUuids: [messageUuid],
        origin: plan.delivery.origin,
        admittedAt: plan.delivery.admittedAt,
        ...(admissionRowid !== undefined ? { admissionRowid } : {}),
        claimValid: () => deps.jobQueue.isClaimCurrent(job.id, job.claimToken) && canDeliver(),
      });
      if (activated[0]) publish(activated[0].dbId);
    } else if (
      entry.deliveryMode === 'defer' &&
      existing?.sendStatus === 'failed' &&
      !deps.sdkMessageRepo.hasConsumptionEvidence(target, messageUuid) &&
      deps.sdkMessageRepo.getSettledDeliveryMessageId(target, messageUuid) === null
    ) {
      deps.sdkMessageRepo.reopenDeliveryByUuid(target, messageUuid);
      deps.sdkMessageRepo.markDeliveryDeferredByUuid(target, messageUuid);
    }
    if (entry.deliveryMode === 'defer' && deps.publishDeferredStatus) {
      const deferredDbId = deps.sdkMessageRepo.findMessageIdByUuid(target, messageUuid);
      if (deferredDbId !== null) {
        await deps.publishDeferredStatus(target, deferredDbId);
        if (!deps.jobQueue.isClaimCurrent(job.id, job.claimToken)) {
          return { outcome: 'stale_attempt' };
        }
      }
    }
    if (deps.isSessionArchived(target)) {
      const failedId = deps.sdkMessageRepo.markDeliveryFailedByUuid(target, messageUuid);
      if (failedId !== null) {
        await deps.publishFailed?.(target, failedId);
      }
      throw new DeadLetterImmediatelyError('mailbox: target session archived');
    }
    if (!canDeliver()) return { outcome: 'already_settled' };
    if (entry.deliveryMode === 'defer' && deps.scheduleDeferredReplay) {
      await deps.scheduleDeferredReplay(target);
    }
    return { ...settleMailboxEntry(entry, 'delivered', Date.now()) };
  };
}
