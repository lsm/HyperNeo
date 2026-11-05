import type { HeldWorkSend } from '../../lib/drivers/work-operations.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

export const holdWorkSend = defineDbOp({
  name: 'work.heldSend.hold',
  mode: 'write',
  run: (db: Database, { send, now }: { send: HeldWorkSend; now: number }): void => {
    db.prepare(`INSERT OR IGNORE INTO work_held_sends (key, todo_id, ref, message, held_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      send.key,
      send.todoId,
      JSON.stringify(send.ref),
      send.message,
      now
    );
  },
});

export const removeWorkSend = defineDbOp({
  name: 'work.heldSend.remove',
  mode: 'write',
  run: (db: Database, key: string): void => {
    db.prepare('DELETE FROM work_held_sends WHERE key = ?').run(key);
  },
});

export class WorkHeldSendRepository {
  constructor(private readonly db: Database) {}

  hold(send: HeldWorkSend, now: number): Promise<void> {
    return gatewayFor(this.db).run(holdWorkSend, { send, now });
  }

  remove(key: string): Promise<void> {
    return gatewayFor(this.db).run(removeWorkSend, key);
  }

  nextPerWorker(): HeldWorkSend[] {
    const rows = this.db
      .prepare(`SELECT key, todo_id AS todoId, ref, message FROM work_held_sends
        ORDER BY held_at, rowid`)
      .all() as (Omit<HeldWorkSend, 'ref'> & { ref: string })[];
    const next = new Map(rows.toReversed().map((row) => [row.ref, row]));
    return [...next.values()].reverse().map((row) => ({ ...row, ref: JSON.parse(row.ref) }));
  }
}
