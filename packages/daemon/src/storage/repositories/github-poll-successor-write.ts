import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const githubPollSuccessorWrites = defineRepositoryOp(
  'jobs.githubPollSuccessor',
  'write',
  JobQueueRepository,
  ['enqueueUniquePending']
);
