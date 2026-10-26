import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const nativeFeedEnqueueWrites = defineRepositoryOp(
  'jobs.nativeFeedEnqueue',
  'write',
  JobQueueRepository,
  ['enqueueUniquePending']
);
