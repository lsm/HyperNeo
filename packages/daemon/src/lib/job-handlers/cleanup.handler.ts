import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import { JOB_QUEUE_CLEANUP, LONG_HORIZON_AGENT_REMINDER_FIRE } from '../job-queue-constants';

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * ONE_HOUR_MS;
const NEXT_RUN_DELAY_MS = ONE_HOUR_MS;

const QUEUE_COMPLETED_MAX_AGE_MS: Record<string, number> = {
  [LONG_HORIZON_AGENT_REMINDER_FIRE]: ONE_HOUR_MS,
};

export function createCleanupHandler(jobQueue: JobQueueRepository) {
  return async (_job: Job): Promise<{ deletedJobs: number; nextRunAt: number }> => {
    const now = Date.now();
    let deletedJobs = jobQueue.cleanup(now - DEFAULT_MAX_AGE_MS);
    for (const [queue, maxAgeMs] of Object.entries(QUEUE_COMPLETED_MAX_AGE_MS)) {
      deletedJobs += jobQueue.cleanupCompleted(queue, now - maxAgeMs);
    }

    const nextRunAt = now + NEXT_RUN_DELAY_MS;

    const pending = jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending', limit: 1 });
    if (pending.length === 0) {
      jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: nextRunAt });
    }

    return { deletedJobs, nextRunAt };
  };
}
