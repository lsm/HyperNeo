import { ingestSessionEvent } from '../../lib/external-events/session-external-event-store.ts';
import {
  recordUnpaired,
  recordWouldRefuse,
  touchDevice,
} from '../repositories/device-pairing-repository.ts';
import {
  cleanupJobs,
  jobQueueReads,
  jobQueueWrites,
} from '../repositories/job-queue-repository.ts';
import { deleteWorkFeedBatch } from '../work-feed.ts';
import type { DbOp } from './db-op.ts';

export const DB_OPS: ReadonlyMap<string, DbOp<never, unknown>> = new Map(
  [
    recordWouldRefuse,
    touchDevice,
    recordUnpaired,
    jobQueueWrites,
    jobQueueReads,
    cleanupJobs,
    ingestSessionEvent,
    deleteWorkFeedBatch,
  ].map((op) => [op.name, op])
);
