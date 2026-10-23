import {
  recordUnpaired,
  recordWouldRefuse,
  touchDevice,
} from '../repositories/device-pairing-repository.ts';
import { jobQueueReads, jobQueueWrites } from '../repositories/job-queue-repository.ts';
import { messageSearchIndexWrites } from '../repositories/sdk-message-repository.ts';
import type { DbOp } from './db-op.ts';

export const DB_OPS: ReadonlyMap<string, DbOp<never, unknown>> = new Map(
  [
    recordWouldRefuse,
    touchDevice,
    recordUnpaired,
    jobQueueWrites,
    jobQueueReads,
    messageSearchIndexWrites,
  ].map((op) => [op.name, op])
);
