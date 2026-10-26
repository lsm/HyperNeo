import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const jobStaleReclaimWrites = defineRepositoryOp(
  'jobs.reclaimStale',
  'write',
  JobQueueRepository,
  ['reclaimStale', 'reschedulePending']
);
