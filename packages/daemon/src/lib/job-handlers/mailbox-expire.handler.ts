import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { MAILBOX_EXPIRE_FIRE } from '../job-queue-constants.ts';
import { expireMailboxEntries } from '../mailbox/expire.ts';

const NEXT_RUN_DELAY_MS = 60 * 1000;

export function createMailboxExpireHandler(jobQueue: JobQueueRepository) {
  return async (_job: Job): Promise<{ expired: number; nextRunAt: number }> => {
    const expired = await expireMailboxEntries({ jobQueue });
    const nextRunAt = Date.now() + NEXT_RUN_DELAY_MS;
    enqueueMailboxExpireIfMissing(jobQueue, nextRunAt);
    return { expired, nextRunAt };
  };
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
