import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const skillValidationEnqueueWrites = defineRepositoryOp(
  'jobs.enqueueSkillValidation',
  'write',
  JobQueueRepository,
  ['enqueue']
);
