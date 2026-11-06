import { describe, expect, test } from 'bun:test';
import { catchUpWorkerTurns } from '../../../../src/lib/neo/turn-recording.ts';
import { WorkDeliveryInputRepository } from '../../../../src/storage/repositories/work-delivery-input-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const ref = { adapter: 'hyperneo', id: 'worker' };
const fact = (id: string) => ({
  id,
  startedAt: 1,
  endedAt: 2,
  ended: 'success',
  inputs: [],
  urls: [],
  finalUrls: [],
  complete: true,
  cursor: id,
});

function reader(pages: number) {
  let cursor: string | null = null;
  const reads: (string | null)[] = [];
  return {
    reads,
    deps: {
      turns: {
        cursor: () => cursor,
        record: async (_ref: unknown, turns: { cursor: string }[]) => {
          cursor = turns.at(-1)!.cursor;
        },
      },
      read: async (_ref: unknown, from: string | null) => {
        reads.push(from);
        const next = reads.length;
        return {
          kind: 'completed' as const,
          value: { ok: true, value: { turns: next <= pages ? [fact(`t${next}`)] : [] } },
        };
      },
    },
  };
}

describe('catchUpWorkerTurns', () => {
  test('reads on until a worker has no more turns', async () => {
    const { deps, reads } = reader(3);
    await catchUpWorkerTurns(ref, deps as never);
    expect(reads).toEqual([null, 't1', 't2', 't3']);
  });

  test('stops at the read cap and continues from the cursor next time', async () => {
    const { deps, reads } = reader(500);
    await catchUpWorkerTurns(ref, deps as never);
    expect(reads).toHaveLength(50);
  });
});

describe('openWorkerRefs', () => {
  test('lists each worker of an unfinished todo on an open ask, once', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
      VALUES ('open', 's', 't', 'r', 'open', 1, 1), ('shut', 's', 't', 'r', 'done', 1, 1)`);
    const todo = (id: string, ask: string, state: string) =>
      db
        .prepare(
          `INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at)
           VALUES (?, ?, 0, 't', 'd', ?, 1, 1)`
        )
        .run(id, ask, state);
    todo('a', 'open', 'doing');
    todo('b', 'open', 'done');
    todo('c', 'shut', 'doing');
    const send = (id: string, todoId: string, outcome: object | null) =>
      db
        .prepare(
          `INSERT INTO work_delivery_inputs
            (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at, outcome)
           VALUES (?, ?, 'neo', '{}', 'work', 1, 2, ?)`
        )
        .run(id, todoId, outcome && JSON.stringify(outcome));
    send('d1', 'a', { ref });
    send('d2', 'a', { ref });
    send('d3', 'a', null);
    send('d4', 'b', { ref: { adapter: 'hyperneo', id: 'done' } });
    send('d5', 'c', { ref: { adapter: 'hyperneo', id: 'shut' } });
    expect(new WorkDeliveryInputRepository(db).openWorkerRefs()).toEqual([ref]);
    db.close();
  });
});
