import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const jobEnqueueWrites = defineRepositoryOp('jobs.enqueue', 'write', JobQueueRepository, [
  'enqueueUniquePending',
]);
