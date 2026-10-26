import { ChangeRecorder, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';
import { sdkMessageChanges } from './sdk-message-writes.ts';

class RateLimitCancellationRepository {
  constructor(
    private readonly db: Database,
    private readonly changes?: ReactiveDatabase
  ) {}

  cancel(sessionId: string, episodeMessageUuid?: string): string | null {
    const jobs = new JobQueueRepository(this.db);
    const owningMessageUuid = episodeMessageUuid ?? jobs.getActiveDeliveryMessageUuid(sessionId);
    if (!owningMessageUuid) return null;
    jobs.cancelDelivery(sessionId, owningMessageUuid);
    const messages = new ChangeRecorder();
    const settledId = new SDKMessageRepository(
      this.db,
      sdkMessageChanges(this.db, messages, false)
    ).markDeliveryFailedByUuid(sessionId, owningMessageUuid);
    jobs.rescheduleSessionDeliveries(sessionId, Date.now());
    for (const change of messages.changes) this.changes?.notifyChange(change.table, change.scope);
    return settledId;
  }
}

export const cancelRateLimitDelivery = defineRepositoryOp(
  'jobs.cancelRateLimitDelivery',
  'write',
  RateLimitCancellationRepository,
  ['cancel']
);
