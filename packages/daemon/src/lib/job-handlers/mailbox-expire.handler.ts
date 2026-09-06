import superpipe, { type PipelineAPI } from 'superpipe';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { MAILBOX_EXPIRE_FIRE } from '../job-queue-constants.ts';
import { expireMailboxEntries } from '../mailbox/expire.ts';

const NEXT_RUN_DELAY_MS = 60 * 1000;

export function mailboxExpireNextRunStage(_jobQueue: JobQueueRepository): number {
  return Date.now() + NEXT_RUN_DELAY_MS;
}

export function mailboxExpireScheduleStage(jobQueue: JobQueueRepository, nextRunAt: number): void {
  enqueueMailboxExpireIfMissing(jobQueue, nextRunAt);
}

export function mailboxExpireSweepStage(
  jobQueue: JobQueueRepository,
  onExpired?: (job: Job) => void
): Promise<number> {
  return expireMailboxEntries({ jobQueue, onExpired });
}

export function mailboxExpireResultStage(
  expired: number,
  nextRunAt: number
): { expired: number; nextRunAt: number } {
  return { expired, nextRunAt };
}

const runMailboxExpire = (superpipe()('mailbox-expire') as PipelineAPI)
  .input(['jobQueue', 'onExpired'])
  .pipe(mailboxExpireNextRunStage, 'jobQueue', 'nextRunAt')
  .pipe(mailboxExpireScheduleStage, ['jobQueue', 'nextRunAt'])
  .pipe(mailboxExpireSweepStage, ['jobQueue', 'onExpired'], 'expired')
  .pipe(mailboxExpireResultStage, ['expired', 'nextRunAt'], 'result')
  .endAsync('result') as (
  jobQueue: JobQueueRepository,
  onExpired?: (job: Job) => void
) => Promise<{ expired: number; nextRunAt: number }>;

export function createMailboxExpireHandler(
  jobQueue: JobQueueRepository,
  onExpired?: (job: Job) => void
) {
  return (_job: Job) => runMailboxExpire(jobQueue, onExpired);
}

export function enqueueMailboxExpireIfMissing(
  jobQueue: JobQueueRepository,
  runAt = Date.now()
): void {
  const pending = jobQueue.listJobs({ queue: MAILBOX_EXPIRE_FIRE, status: 'pending', limit: 1 });
  if (pending.length === 0) {
    jobQueue.enqueue({ queue: MAILBOX_EXPIRE_FIRE, payload: {}, runAt });
  }
}
