import { markReviewedWorkers } from './work-started-sessions-worker.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { WorkerOwnershipReader } from './worker-ownership-read-worker.ts';
import { reviewedWorkerOwnership, type WorkRef } from '../../lib/neo/worker-ownership-apply.ts';

class WorkerOwnershipWriter {
  constructor(private readonly db: Database) {}

  apply(reviewed: WorkRef[]) {
    return this.db.transaction(() => {
      const { rows, touches } = new WorkerOwnershipReader(this.db).readFacts();
      const { selected, skipped, invalid } = reviewedWorkerOwnership(rows, touches, reviewed);
      if (invalid.length)
        return {
          accepted: false as const,
          reason: 'Some refs are not current candidates.',
          invalid,
          skipped,
        };
      markReviewedWorkers(this.db, selected);
      return { accepted: true as const, applied: selected, skipped };
    })();
  }
}
export const workerOwnershipWrites = defineRepositoryOp(
  'neo.workerOwnershipWrites',
  'write',
  WorkerOwnershipWriter,
  ['apply']
);
