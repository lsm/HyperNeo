import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository, type EnqueueParams } from './job-queue-repository.ts';
import type { Database } from '../sqlite-compat.ts';

export const DELIVERY_ENQUEUE_REJECTION = 'jobs.enqueueSessionDelivery rejected: ';

class SessionDeliveryEnqueueRepository {
  constructor(private readonly db: Database) {}

  enqueue(input: EnqueueParams) {
    try {
      return new JobQueueRepository(this.db).enqueue(input);
    } catch (error) {
      throw new Error(
        DELIVERY_ENQUEUE_REJECTION + (error instanceof Error ? error.message : String(error))
      );
    }
  }
}

export const enqueueSessionDelivery = defineRepositoryOp(
  'jobs.enqueueSessionDelivery',
  'write',
  SessionDeliveryEnqueueRepository,
  ['enqueue']
);
