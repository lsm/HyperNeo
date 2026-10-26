import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const enqueueSessionDelivery = defineRepositoryOp(
  'jobs.enqueueSessionDelivery',
  'write',
  JobQueueRepository,
  ['enqueue']
);
