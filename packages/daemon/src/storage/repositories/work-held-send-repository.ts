import type { HeldWorkSend } from '../../lib/drivers/work-operations.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

type HeldSendId = Pick<HeldWorkSend, 'key' | 'ref'>;
type WorkerRef = HeldWorkSend['ref'];

const storedRef = ({ adapter, daemon, id }: WorkerRef) =>
  JSON.stringify({ adapter, id, ...(daemon ? { daemon } : {}) });

export const holdWorkSend = defineDbOp({
  name: 'work.heldSend.hold',
  mode: 'write',
  run: (db: Database, { send, now }: { send: HeldWorkSend; now: number }): void => {
    db.prepare(`INSERT OR IGNORE INTO work_held_sends (key, todo_id, ref, message, held_at)
      VALUES (?, ?, ?, ?, ?)`).run(send.key, send.todoId, storedRef(send.ref), send.message, now);
  },
});

export const removeWorkSend = defineDbOp({
  name: 'work.heldSend.remove',
  mode: 'write',
  run: (db: Database, { key, ref }: HeldSendId): void => {
    db.prepare('DELETE FROM work_held_sends WHERE key = ? AND ref = ?').run(key, storedRef(ref));
  },
});

export const setWorkSendSending = defineDbOp({
  name: 'work.heldSend.sending',
  mode: 'write',
  run: (db: Database, { key, ref, at }: HeldSendId & { at: number | null }): void => {
    db.prepare('UPDATE work_held_sends SET sending_at = ? WHERE key = ? AND ref = ?').run(
      at,
      key,
      storedRef(ref)
    );
  },
});

type WorkerFence = { since: number; submission?: string };

export const fenceWorkWorker = defineDbOp({
  name: 'work.heldSend.fence',
  mode: 'write',
  run: (db: Database, { ref, fence }: { ref: WorkerRef; fence: WorkerFence | null }): void => {
    if (!fence) {
      db.prepare('DELETE FROM work_send_fences WHERE ref = ?').run(storedRef(ref));
      return;
    }
    db.prepare(
      'INSERT OR REPLACE INTO work_send_fences (ref, since, submission) VALUES (?, ?, ?)'
    ).run(storedRef(ref), fence.since, fence.submission ?? null);
  },
});

export type PendingWorkSend = HeldWorkSend & { sending: boolean };

export class WorkHeldSendRepository {
  constructor(private readonly db: Database) {}

  hold(send: HeldWorkSend, now: number): Promise<void> {
    return gatewayFor(this.db).run(holdWorkSend, { send, now });
  }

  remove({ key, ref }: HeldSendId): Promise<void> {
    return gatewayFor(this.db).run(removeWorkSend, { key, ref });
  }

  setSending({ key, ref }: HeldSendId, at: number | null): Promise<void> {
    return gatewayFor(this.db).run(setWorkSendSending, { key, ref, at });
  }

  fence(ref: WorkerRef, fence: WorkerFence | null): Promise<void> {
    return gatewayFor(this.db).run(fenceWorkWorker, { ref, fence });
  }

  fenceOf(ref: WorkerRef): WorkerFence | null {
    const row = this.db
      .prepare('SELECT since, submission FROM work_send_fences WHERE ref = ?')
      .get(storedRef(ref)) as { since: number; submission: string | null } | null;
    return row && { since: row.since, ...(row.submission ? { submission: row.submission } : {}) };
  }

  nextPerWorker(): PendingWorkSend[] {
    const rows = this.db
      .prepare(`SELECT key, todo_id AS todoId, ref, message, sending_at AS sendingAt
        FROM work_held_sends ORDER BY held_at, rowid`)
      .all() as (Omit<HeldWorkSend, 'ref'> & { ref: string; sendingAt: number | null })[];
    const next = new Map(rows.toReversed().map((row) => [row.ref, row]));
    return [...next.values()].reverse().map(({ sendingAt, ...row }) => ({
      ...row,
      ref: JSON.parse(row.ref),
      sending: sendingAt !== null,
    }));
  }
}
