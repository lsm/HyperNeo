import type {
  Job,
  JobCleanup,
  JobQueueRepository,
} from '../../storage/repositories/job-queue-repository.ts';
import { JOB_QUEUE_CLEANUP, LONG_HORIZON_AGENT_REMINDER_FIRE } from '../job-queue-constants.ts';

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * ONE_HOUR_MS;
const NEXT_RUN_DELAY_MS = ONE_HOUR_MS;

const QUEUE_COMPLETED_MAX_AGE_MS: Record<string, number> = {
  [LONG_HORIZON_AGENT_REMINDER_FIRE]: ONE_HOUR_MS,
};

export function createCleanupHandler(
  jobQueue: JobQueueRepository,
  cleanup?: (params: JobCleanup) => Promise<number>
) {
  return async (_job: Job): Promise<{ deletedJobs: number; nextRunAt: number }> => {
    const now = Date.now();
    const params = {
      beforeMs: now - DEFAULT_MAX_AGE_MS,
      completed: Object.entries(QUEUE_COMPLETED_MAX_AGE_MS).map(([queue, maxAgeMs]) => ({
        queue,
        beforeMs: now - maxAgeMs,
      })),
    };
    let deletedJobs: number;
    if (cleanup) deletedJobs = await cleanup(params);
    else {
      deletedJobs = jobQueue.cleanup(params.beforeMs);
      for (const { queue, beforeMs } of params.completed)
        deletedJobs += jobQueue.cleanupCompleted(queue, beforeMs);
    }

    const nextRunAt = now + NEXT_RUN_DELAY_MS;

    const pending = jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending', limit: 1 });
    if (pending.length === 0) {
      jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: nextRunAt });
    }

    return { deletedJobs, nextRunAt };
  };
}
