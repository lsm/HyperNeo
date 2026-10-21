import type { NeoDriverTarget, readDriverOutcome } from '../../lib/neo/driver-work.ts';
import type { Database } from '../sqlite-compat.ts';

type Target = Extract<NeoDriverTarget, { verb: 'start' | 'send' }>;
type Outcome = ReturnType<typeof readDriverOutcome>;
type InputRow = {
  id: string;
  todoId: string;
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

export class WorkDeliveryInputRepository {
  constructor(private readonly db: Database) {}

  accept(
    todoId: string,
    originSessionId: string,
    target: Target,
    message: string,
    now: number
  ): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(`INSERT INTO work_delivery_inputs
      (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, todoId, originSessionId, JSON.stringify(target), message, now, now + 30_000);
    return id;
  }

  recordOutcome(id: string, outcome: Outcome, now: number): void {
    const updated = this.db
      .prepare(`UPDATE work_delivery_inputs SET outcome = ?, observed_at = ?
      WHERE id = ? AND outcome IS NULL`)
      .run(JSON.stringify(outcome), now, id);
    if (updated.changes !== 1)
      throw new Error('Delivery input is missing or already acknowledged.');
  }

  list(todoId: string) {
    return (
      this.db
        .prepare(`${SELECT} WHERE todo_id = ? ORDER BY accepted_at, rowid`)
        .all(todoId) as InputRow[]
    ).map(readInput);
  }

  due(now: number, limit = 100) {
    return (
      this.db
        .prepare(`${SELECT} WHERE deadline_at <= ? ORDER BY deadline_at, id LIMIT ?`)
        .all(now, limit) as InputRow[]
    ).map(readInput);
  }
}
