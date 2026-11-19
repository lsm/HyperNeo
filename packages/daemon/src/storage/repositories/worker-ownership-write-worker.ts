import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { WorkerOwnershipReader } from './worker-ownership-read-worker.ts';
import { reviewedWorkerOwnership, type WorkRef } from '../../lib/neo/worker-ownership-apply.ts';

class WorkerOwnershipWriter {
  constructor(private readonly db: Database) {}

  apply(reviewed: WorkRef[]) {
    return this.db.transaction(() => {
      const { rows, touches } = new WorkerOwnershipReader(this.db).readFacts();
      const selected = reviewedWorkerOwnership(rows, touches, reviewed);
      const update = this.db.prepare(
        "UPDATE work_started_sessions SET role = 'worker' WHERE adapter = ? AND id = ? AND (role IS NULL OR role = '') AND released_at IS NULL AND claimed_by IS NULL"
      );
      let applied = 0;
      for (const ref of selected) applied += update.run(ref.adapter, ref.id).changes;
      return { accepted: true as const, applied, reviewed: reviewed.length };
    })();
  }
}
export const workerOwnershipWrites = defineRepositoryOp(
  'neo.workerOwnershipWrites',
  'write',
  WorkerOwnershipWriter,
  ['apply']
);
