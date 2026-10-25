import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository, type Job } from './job-queue-repository.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';
import { parseMailboxEntry } from '../../lib/mailbox/entry.ts';
import type { Result, WorkWithdrawal } from '../../lib/drivers/types.ts';

const WITHDRAWING = 'driver_input_withdrawing';
const WITHDRAWN = 'driver_input_withdrawn';
type Outcome = Result<WorkWithdrawal>;
type Gate<T> = { value: T } | { reason: Outcome };
type QueuedInput = { job: Job; sessionId: string; uuid: string };
export type WithdrawalInput = {
  jobId: string;
  sessionId: string;
  messageDbId: string | null;
  wasPending: boolean;
};

export function withdrawal(queuedSubmissionId: string, withdrawn: boolean): Outcome {
  return {
    ok: true,
    value: {
      queuedSubmissionId,
      withdrawn,
      ...(!withdrawn ? { reason: 'not_queued' as const } : {}),
    },
  };
}

export function requireOwnedQueuedInput(
  job: Job | null,
  sessionId: string,
  queuedSubmissionId: string,
  from: string
): Gate<QueuedInput> {
  const entry = job ? parseMailboxEntry(job.payload) : null;
  if (
    !job ||
    job.queue !== 'mailbox' ||
    !entry ||
    entry.id !== queuedSubmissionId ||
    entry.to.kind !== 'session' ||
    entry.to.sessionId !== sessionId ||
    entry.origin !== from ||
    entry.deliveryMode !== 'defer' ||
    !entry.messageUuid
  )
    return { reason: withdrawal(queuedSubmissionId, false) };
  if (job.status === 'dead' && job.error === WITHDRAWN)
    return { reason: withdrawal(queuedSubmissionId, true) };
  return job.status === 'pending' ||
    job.status === 'completed' ||
    (job.status === 'dead' && job.error === WITHDRAWING)
    ? { value: { job, sessionId, uuid: entry.messageUuid } }
    : { reason: withdrawal(queuedSubmissionId, false) };
}

class OwnedInputWithdrawalRepository {
  constructor(private readonly db: Database) {}

  claim(sessionId: string, queuedSubmissionId: string, from: string): Gate<WithdrawalInput> {
    const jobs = new JobQueueRepository(this.db);
    const admitted = requireOwnedQueuedInput(
      jobs.getLatestByPayload('mailbox', { id: queuedSubmissionId }),
      sessionId,
      queuedSubmissionId,
      from
    );
    if ('reason' in admitted) return admitted;
    const { job, uuid } = admitted.value;
    const messageDbId = new SDKMessageRepository(this.db).findMessageIdByUuid(sessionId, uuid);
    if (
      job.status === 'pending' &&
      !jobs.markDeadIfActive(job.id, messageDbId ? WITHDRAWING : WITHDRAWN, ['pending'])
    )
      return { reason: withdrawal(queuedSubmissionId, false) };
    return {
      value: { jobId: job.id, sessionId, messageDbId, wasPending: job.status === 'pending' },
    };
  }
}

export const claimOwnedInputWithdrawal = defineRepositoryOp(
  'mailbox.claimOwnedWithdrawal',
  'write',
  OwnedInputWithdrawalRepository,
  ['claim']
);
