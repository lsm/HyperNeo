import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type {
  WorkerOwnershipRow as Row,
  WorkerOwnershipTouch as Touch,
} from '../../lib/neo/worker-ownership-backfill.ts';

export class WorkerOwnershipReader {
  constructor(private readonly db: Database) {}

  readFacts() {
    const raw = this.db;
    const rows = raw
      .prepare(
        `SELECT adapter, id, started_at AS startedAt, claimed_by AS claimedBy, released_at AS releasedAt, role FROM work_started_sessions ORDER BY adapter, id`
      )
      .all() as Row[];
    const bindings = raw
      .prepare(
        `SELECT s.ref, s.target, t.named FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id`
      )
      .all() as { ref: string | null; target: string; named: string | null }[];
    const touches: Touch[] = [];
    for (const binding of bindings) {
      const target = JSON.parse(binding.target) as {
        verb: string;
        ref?: { adapter: string; id: string; daemon?: string };
      };
      const named = binding.named ? (JSON.parse(binding.named) as { session?: unknown }) : null;
      const refs = [
        binding.ref
          ? (JSON.parse(binding.ref) as { adapter: string; id: string; daemon?: string })
          : null,
        target.verb === 'start' ? undefined : target.ref,
      ];
      for (const ref of refs)
        if (ref && !ref.daemon)
          touches.push({
            adapter: ref.adapter,
            id: ref.id,
            verb: target.verb,
            humanNamed: named?.session != null,
          });
    }
    return { rows, touches };
  }
}

export const workerOwnershipFacts = defineRepositoryOp(
  'neo.workerOwnershipFacts',
  'read',
  WorkerOwnershipReader,
  ['readFacts']
);
