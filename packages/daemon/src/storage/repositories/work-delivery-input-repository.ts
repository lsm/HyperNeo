import type { WorkRef } from '../../lib/drivers/types.ts';
import type { NeoDriverTarget, readDriverOutcome } from '../../lib/neo/driver-work.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

type Target =
  | Extract<NeoDriverTarget, { verb: 'start' | 'send' }>
  | { verb: 'todo'; todoId: string };
type Outcome = ReturnType<typeof readDriverOutcome>;
type InputRow = {
  id: string;
  todoId: string | null;
  originSessionId: string;
  target: string;
  message: string;
  acceptedAt: number;
  deadlineAt: number;
  outcome: string | null;
  observedAt: number | null;
};

const SELECT = `SELECT id, todo_id AS todoId, origin_session_id AS originSessionId,
  target, message, accepted_at AS acceptedAt, deadline_at AS deadlineAt,
  outcome, observed_at AS observedAt FROM work_delivery_inputs`;

function readInput(row: InputRow) {
  return {
    ...row,
    target: JSON.parse(row.target) as Target,
    outcome: row.outcome ? (JSON.parse(row.outcome) as Outcome) : null,
  };
}

export const acceptWorkDeliveryInput = defineDbOp({
  name: 'work.deliveryInput.accept',
  mode: 'write',
  run: (
    db: Database,
    input: {
      id: string;
      todoId: string | null;
      originSessionId: string;
      target: Target;
      message: string;
      now: number;
    }
  ): void => {
    db.prepare(`INSERT INTO work_delivery_inputs
      (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      input.id,
      input.todoId,
      input.originSessionId,
      JSON.stringify(input.target),
      input.message,
      input.now,
      input.now + 30_000
    );
  },
});

export const recordWorkDeliveryOutcome = defineDbOp({
  name: 'work.deliveryInput.recordOutcome',
  mode: 'write',
  run: (db: Database, { id, outcome, now }: { id: string; outcome: Outcome; now: number }) => {
    const updated = db
      .prepare(`UPDATE work_delivery_inputs SET outcome = ?, observed_at = ?
      WHERE id = ? AND outcome IS NULL`)
      .run(JSON.stringify(outcome), now, id);
    if (updated.changes !== 1)
      throw new Error('Delivery input is missing or already acknowledged.');
  },
});

export class WorkDeliveryInputRepository {
  constructor(private readonly db: Database) {}

  async accept(
    todoId: string | null,
    originSessionId: string,
    target: Target,
    message: string,
    now: number
  ): Promise<string> {
    const id = crypto.randomUUID();
    await gatewayFor(this.db).run(acceptWorkDeliveryInput, {
      id,
      todoId,
      originSessionId,
      target,
      message,
      now,
    });
    return id;
  }

  recordOutcome(id: string, outcome: Outcome, now: number): Promise<void> {
    return gatewayFor(this.db).run(recordWorkDeliveryOutcome, { id, outcome, now });
  }

  list(scope: string | { adapter: string; id: string; daemon?: string }) {
    const where =
      typeof scope === 'string'
        ? 'todo_id = ?'
        : `json_extract(outcome, '$.ref.adapter') = ? AND json_extract(outcome, '$.ref.id') = ?
        AND json_extract(outcome, '$.ref.daemon') IS ?`;
    const params =
      typeof scope === 'string' ? [scope] : [scope.adapter, scope.id, scope.daemon ?? null];
    return (
      this.db
        .prepare(`${SELECT} WHERE ${where} ORDER BY accepted_at, rowid`)
        .all(...params) as InputRow[]
    ).map(readInput);
  }

  openWorkerRefs(): { ref: WorkRef; lastActivityAt: number | null }[] {
    const rows = this.db
      .prepare(`WITH workers(ref) AS (
          SELECT json_extract(d.outcome, '$.ref')
            FROM neo_asks a JOIN neo_todos t ON t.ask_id = a.id
            JOIN work_delivery_inputs d ON d.todo_id = t.id
            WHERE a.status = 'open'
              AND t.state NOT IN ('done', 'closed_unverified', 'failed', 'removed')
          UNION
          SELECT s.ref
            FROM neo_asks a JOIN neo_todos t ON t.ask_id = a.id
            JOIN neo_todo_sessions s ON s.todo_id = t.id
            WHERE a.status = 'open'
              AND t.state NOT IN ('done', 'closed_unverified', 'failed', 'removed')
              AND json_extract(s.target, '$.verb') = 'adopt'
        )
        SELECT workers.ref AS ref, w.last_activity_at AS lastActivityAt FROM workers
        LEFT JOIN work_sessions w ON w.adapter = json_extract(workers.ref, '$.adapter')
          AND w.id = json_extract(workers.ref, '$.id')
        WHERE workers.ref IS NOT NULL ORDER BY workers.ref`)
      .all() as { ref: string; lastActivityAt: number | null }[];
    return rows.map((row) => ({ ...row, ref: JSON.parse(row.ref) as WorkRef }));
  }

  due(now: number, limit = 100) {
    return (
      this.db
        .prepare(`${SELECT} WHERE deadline_at <= ? ORDER BY deadline_at, id LIMIT ?`)
        .all(now, limit) as InputRow[]
    ).map(readInput);
  }
}
