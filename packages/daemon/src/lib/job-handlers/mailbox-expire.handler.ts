import superpipe, { type PipelineAPI } from 'superpipe';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { MAILBOX_EXPIRE_FIRE } from '../job-queue-constants.ts';
import { expireMailboxEntries } from '../mailbox/expire.ts';

const NEXT_RUN_DELAY_MS = 60 * 1000;

export function mailboxExpireNextRunStage(): number {
  return Date.now() + NEXT_RUN_DELAY_MS;
}

export function mailboxExpireScheduleStage(jobQueue: JobQueueRepository, nextRunAt: number): void {
  enqueueMailboxExpireIfMissing(jobQueue, nextRunAt);
}

export function mailboxExpireSweepStage(jobQueue: JobQueueRepository): Promise<number> {
  return expireMailboxEntries({ jobQueue });
}

export function mailboxExpireResultStage(
  expired: number,
  nextRunAt: number
): { expired: number; nextRunAt: number } {
  return { expired, nextRunAt };
}

const runMailboxExpire = (superpipe()('mailbox-expire') as PipelineAPI)
  .input(['jobQueue'])
  .pipe(mailboxExpireNextRunStage, [], 'nextRunAt')
  .pipe(mailboxExpireScheduleStage, ['jobQueue', 'nextRunAt'])
  .pipe(mailboxExpireSweepStage, 'jobQueue', 'expired')
  .pipe(mailboxExpireResultStage, ['expired', 'nextRunAt'], 'result')
  .endAsync('result') as (
  jobQueue: JobQueueRepository
) => Promise<{ expired: number; nextRunAt: number }>;

export function createMailboxExpireHandler(jobQueue: JobQueueRepository) {
  return (_job: Job) => runMailboxExpire(jobQueue);
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
