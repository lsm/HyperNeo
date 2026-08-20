import type { GlobalSettings } from '@hyperneo/shared';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository';
import { SDK_MESSAGE_RETENTION } from '../job-queue-constants';

const RETENTION_BATCH_LIMIT = 50_000;
const NEXT_RUN_DELAY_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

export function createSdkMessageRetentionHandler(options: {
  getSettings: () => GlobalSettings;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}) {
  return async (_job: Job): Promise<{ deleted: number; nextRunAt: number; hasMore: boolean }> => {
    const retentionDays = options.getSettings().sdkMessageRetentionDays;
    const enabled =
      typeof retentionDays === 'number' && Number.isFinite(retentionDays) && retentionDays > 0;

    const nextRunAt = Date.now() + NEXT_RUN_DELAY_MS;
    if (!enabled) {
      enqueueSdkMessageRetentionIfMissing(options.jobQueue, nextRunAt);
      return { deleted: 0, nextRunAt, hasMore: false };
    }

    const olderThanIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const { deleted, hasMore } = options.sdkMessageRepo.deleteExpiredArchivedSessionMessages({
      olderThanIso,
      batchLimit: RETENTION_BATCH_LIMIT,
    });

    const scheduledRunAt = hasMore ? Date.now() + RETRY_DELAY_MS : nextRunAt;
    enqueueSdkMessageRetentionIfMissing(options.jobQueue, scheduledRunAt);

    return { deleted, nextRunAt: scheduledRunAt, hasMore };
  };
}

export function enqueueSdkMessageRetentionIfMissing(
  jobQueue: JobQueueRepository,
  runAt = Date.now()
): void {
  const pending = jobQueue.listJobs({ queue: SDK_MESSAGE_RETENTION, status: 'pending', limit: 1 });
  if (pending.length === 0) {
    jobQueue.enqueue({ queue: SDK_MESSAGE_RETENTION, payload: {}, runAt });
  }
}
