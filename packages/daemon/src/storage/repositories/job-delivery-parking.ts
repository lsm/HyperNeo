import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

class DeliveryParkingRepository {
  constructor(private readonly db: Database) {}

  park(jobId: string, runAt: number, claimToken: string | null): boolean {
    if (!claimToken) return false;
    return new JobQueueRepository(this.db).requeueParked(jobId, runAt, claimToken) !== null;
  }
}

export const parkDeliveryJob = defineRepositoryOp(
  'jobs.parkDelivery',
  'write',
  DeliveryParkingRepository,
  ['park']
);
