import type { Database as BunDatabase } from 'bun:sqlite';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import { JOB_QUEUE_CLEANUP } from '../job-queue-constants';
import { Logger } from '../logger';
import {
  loadRetentionConfig,
  type RetentionConfig,
  type RetentionStats,
  runRetention,
} from './retention';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEXT_RUN_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

const logger = new Logger('Cleanup');

/**
 * Build the daily cleanup job handler.
 *
 * Two responsibilities, both self-perpetuating on a 24h cadence:
 *  1. Reap terminal job_queue rows older than 7 days (pre-existing).
 *  2. Run retention sweeps (events / audit / goal events) + reclaim freed pages
 *     via incremental_vacuum. Retention deletion is OFF by default; see
 *     `loadRetentionConfig`. `retentionConfig` is optional and mainly for tests —
 *     production reads env vars per run so operators can tune TTLs live.
 */
export function createCleanupHandler(
  jobQueue: JobQueueRepository,
  db: BunDatabase,
  retentionConfig?: RetentionConfig
) {
  return async (
    _job: Job
  ): Promise<{ deletedJobs: number; retention: RetentionStats; nextRunAt: number }> => {
    const deletedJobs = jobQueue.cleanup(Date.now() - DEFAULT_MAX_AGE_MS);

    const retention = runRetention(db, retentionConfig ?? loadRetentionConfig());
    logger.info(
      `retention sweep: external=${retention.externalEvents} deliveries=${retention.deliveries} github=${retention.githubEvents} mcpAudit=${retention.mcpAudit} goalEvents=${retention.goalEvents} vacuumedPages=${retention.vacuumedPages}`
    );

    const nextRunAt = Date.now() + NEXT_RUN_DELAY_MS;

    // Self-schedule: only enqueue next cleanup if none is already pending
    const pending = jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending', limit: 1 });
    if (pending.length === 0) {
      jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: nextRunAt });
    }

    return { deletedJobs, retention, nextRunAt };
  };
}
