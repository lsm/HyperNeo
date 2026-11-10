import { WorkDeliveryInputRepository } from '../../../../storage/repositories/work-delivery-input-repository.ts';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { WorkRefSchema, WorkInputReceiptSchema } from '../../../drivers/types.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';

export const CodingReviewHandoff = z.object({
  state: z.enum(['pending', 'returned', 'cancelled']),
  ref: WorkRefSchema,
  receipt: WorkInputReceiptSchema.optional(),
});

class CodingReviewHoldQueries {
  constructor(private readonly db: Database) {}

  record(todoId: string, url: string, head: string, handoff: z.infer<typeof CodingReviewHandoff>) {
    const key = `review-handoff:${url}:${head}`;
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT key, value_json AS value FROM pack_facts WHERE todo_id=? AND pack='coding' AND key LIKE 'review-handoff:%'"
        )
        .all(todoId) as { key: string; value: string }[];
      const row = rows.find((fact) => fact.key === key);
      let recorded = handoff;
      if (row) {
        const previous = CodingReviewHandoff.parse(JSON.parse(row.value));
        if (!isDeepStrictEqual(previous.ref, handoff.ref)) return false;
        if (previous.state !== 'pending' || handoff.state === 'pending')
          return (
            previous.state === handoff.state &&
            (handoff.state !== 'pending' || isDeepStrictEqual(previous.receipt, handoff.receipt))
          );
        recorded = { ...handoff, receipt: previous.receipt };
      } else {
        if (handoff.state !== 'pending' || !handoff.receipt) return false;
        if (
          rows.some((fact) => {
            const previous = CodingReviewHandoff.parse(JSON.parse(fact.value));
            return (
              isDeepStrictEqual(previous.ref, handoff.ref) &&
              isDeepStrictEqual(previous.receipt, handoff.receipt)
            );
          })
        )
          return false;
        const accepted = new WorkDeliveryInputRepository(this.db)
          .list(handoff.ref)
          .some(
            (input) =>
              input.todoId === todoId &&
              input.target.verb === 'send' &&
              input.outcome &&
              'ref' in input.outcome &&
              isDeepStrictEqual(input.outcome.receipt, handoff.receipt) &&
              input.outcome.delivery?.delivered === true &&
              !input.outcome.delivery.unconfirmed
          );
        if (!accepted) return false;
      }
      return (
        this.db
          .prepare(`INSERT INTO pack_facts(todo_id,pack,key,value_json)
          SELECT ?1,'coding',?2,?3 WHERE ?4 <> 'pending' OR EXISTS
            (SELECT 1 FROM neo_todos t JOIN neo_asks a ON a.id=t.ask_id
             JOIN pack_coding_stage_heads h ON h.url=?5 AND h.head=?6
             WHERE t.id=?1 AND t.state IN ('doing','blocked') AND a.status='open')
          ON CONFLICT(todo_id,pack,key) DO UPDATE SET value_json=excluded.value_json`)
          .run(todoId, key, JSON.stringify(recorded), handoff.state, url, head).changes === 1
      );
    }, 'immediate')();
  }

  reviewHolds(url: string, head: string) {
    return this.db
      .prepare(`SELECT f.value_json AS assignment, t.state,
      t.blocked_by AS blockedBy,
      EXISTS(SELECT 1 FROM neo_questions q WHERE q.ask_id=t.ask_id AND q.state='open') AS questionOpen
      FROM pack_facts f JOIN neo_todos t ON t.id=f.todo_id
      JOIN neo_asks a ON a.id=t.ask_id
      JOIN pack_coding_stage_heads h ON h.url=?1 AND h.head=?2
      WHERE f.pack='coding' AND f.key=?3 AND a.status='open'`)
      .all(url, head, `review-handoff:${url}:${head}`) as {
      assignment: string;
      state: string;
      blockedBy: string | null;
      questionOpen: number;
    }[];
  }
}

export const codingAssignmentReads = defineRepositoryOp(
  'coding.assignmentReads',
  'read',
  CodingReviewHoldQueries,
  ['reviewHolds']
);

export const codingHandoffWrites = defineRepositoryOp(
  'coding.reviewHandoffWrites',
  'write',
  CodingReviewHoldQueries,
  ['record']
);
