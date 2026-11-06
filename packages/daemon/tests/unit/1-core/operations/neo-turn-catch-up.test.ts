import { describe, expect, test } from 'bun:test';
import { catchUpWorkerTurns, planTurnCatchUp } from '../../../../src/lib/neo/turn-recording.ts';
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

function reader(turns: number) {
  const reads: unknown[][] = [];
  const recorded: unknown[] = [];
  return {
    reads,
    recorded,
    deps: {
      turns: {
        cursor: () => 'from-here',
        record: async (_ref: unknown, found: unknown[]) => {
          recorded.push(...found);
        },
      },
      read: async (_ref: unknown, cursor: string | null, limit?: number) => {
        reads.push([cursor, limit]);
        return {
          kind: 'completed' as const,
          value: {
            ok: true,
            value: { turns: Array.from({ length: turns }, (_, index) => fact(`t${index}`)) },
          },
        };
      },
    },
  };
}

describe('catchUpWorkerTurns', () => {
  test('one read per worker, from its cursor, up to the cap', async () => {
    const { deps, reads, recorded } = reader(3);
    expect(await catchUpWorkerTurns(ref, deps as never)).toBe(true);
    expect(reads).toEqual([['from-here', 500]]);
    expect(recorded).toHaveLength(3);
  });

  test('a full read is not caught up', async () => {
    const { deps } = reader(500);
    expect(await catchUpWorkerTurns(ref, deps as never)).toBe(false);
  });
});

describe('planTurnCatchUp', () => {
  const worker = { ref, lastActivityAt: 7 };

  test('reads a worker it has not seen', () => {
    expect(planTurnCatchUp([worker], new Map())).toEqual([worker]);
  });

  test('a worker with nothing new costs no read', () => {
    expect(planTurnCatchUp([worker], new Map([[JSON.stringify(ref), 7]]))).toEqual([]);
  });

  test('new activity reads it again', () => {
    expect(
      planTurnCatchUp([{ ref, lastActivityAt: 8 }], new Map([[JSON.stringify(ref), 7]]))
    ).toEqual([{ ref, lastActivityAt: 8 }]);
  });

  test('a worker with no synced activity is always read', () => {
    const unsynced = { ref, lastActivityAt: null };
    expect(planTurnCatchUp([unsynced], new Map([[JSON.stringify(ref), 7]]))).toEqual([unsynced]);
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
    db.exec(`INSERT INTO work_sessions (adapter, id, name, status, last_activity_at, updated_at)
      VALUES ('hyperneo', 'worker', 'w', 'idle', 9, 1)`);
    send('d1', 'a', { ref });
    send('d2', 'a', { ref });
    send('d3', 'a', null);
    send('d4', 'b', { ref: { adapter: 'hyperneo', id: 'done' } });
    send('d5', 'c', { ref: { adapter: 'hyperneo', id: 'shut' } });
    expect(new WorkDeliveryInputRepository(db).openWorkerRefs()).toEqual([
      { ref, lastActivityAt: 9 },
    ]);
    db.close();
  });
});
