import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const sessionTitleEnqueueWrites = defineRepositoryOp(
  'jobs.enqueueSessionTitle',
  'write',
  JobQueueRepository,
  ['enqueue']
);
