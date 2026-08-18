import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import { JOB_QUEUE_CLEANUP } from '../job-queue-constants';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NEXT_RUN_DELAY_MS = 24 * 60 * 60 * 1000;

export function createCleanupHandler(jobQueue: JobQueueRepository) {
  return async (_job: Job): Promise<{ deletedJobs: number; nextRunAt: number }> => {
    const deletedJobs = jobQueue.cleanup(Date.now() - DEFAULT_MAX_AGE_MS);

    const nextRunAt = Date.now() + NEXT_RUN_DELAY_MS;

    const pending = jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending', limit: 1 });
    if (pending.length === 0) {
      jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: nextRunAt });
    }

    return { deletedJobs, nextRunAt };
  };
}
