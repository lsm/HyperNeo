import { externalEventSweeps } from '../../lib/external-events/external-event-store.ts';
import {
  recordUnpaired,
  recordWouldRefuse,
  touchDevice,
} from '../repositories/device-pairing-repository.ts';
import { jobQueueReads, jobQueueWrites } from '../repositories/job-queue-repository.ts';
import type { DbOp } from './db-op.ts';

export const DB_OPS: ReadonlyMap<string, DbOp<never, unknown>> = new Map(
  [
    recordWouldRefuse,
    touchDevice,
    recordUnpaired,
    jobQueueWrites,
    jobQueueReads,
    externalEventSweeps,
  ].map((op) => [op.name, op])
);
