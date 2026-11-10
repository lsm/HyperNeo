import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';

class CodingReviewHoldQueries {
  constructor(private readonly db: Database) {}

  reviewHolds(url: string, head: string, assignmentKey: string) {
    return this.db
      .prepare(`SELECT f.value_json AS assignment, t.state,
      t.blocked_by AS blockedBy,
      EXISTS(SELECT 1 FROM neo_questions q WHERE q.ask_id=t.ask_id AND q.state='open') AS questionOpen,
      EXISTS(SELECT 1 FROM pack_coding_stage_facts s
        WHERE s.url=?1 AND s.head=?2 AND s.stage='review') AS finished
      FROM pack_facts f JOIN neo_todos t ON t.id=f.todo_id
      JOIN neo_asks a ON a.id=t.ask_id
      JOIN pack_coding_stage_heads h ON h.url=?1 AND h.head=?2
      WHERE f.pack='coding' AND f.key=?3 AND a.status='open'`)
      .all(url, head, assignmentKey) as {
      assignment: string;
      state: string;
      blockedBy: string | null;
      questionOpen: number;
      finished: number;
    }[];
  }
}

export const codingAssignmentReads = defineRepositoryOp(
  'coding.assignmentReads',
  'read',
  CodingReviewHoldQueries,
  ['reviewHolds']
);
