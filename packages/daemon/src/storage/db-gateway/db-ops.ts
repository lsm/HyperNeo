import { recordWouldRefuse } from '../repositories/device-pairing-repository.ts';
import { jobQueueReads, jobQueueWrites } from '../repositories/job-queue-repository.ts';
import type { DbOp } from './db-op.ts';

export const DB_OPS: ReadonlyMap<string, DbOp<never, unknown>> = new Map(
  [recordWouldRefuse, jobQueueWrites, jobQueueReads].map((op) => [op.name, op])
);
