import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import {
  applyMessageStatusPlan,
  PENDING_ROW_FROM_STATUSES,
  type PendingStatusRow,
  planMessageStatusApplication,
} from '../../../../src/storage/repositories/sdk-message-status-plan';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

const NOW = '2026-01-01T00:00:00.000Z';
const OLD_TS = '2020-06-01T00:00:00.000Z';

function userMessage(uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: `text-${uuid}` }] },
  } as unknown as SDKMessage;
}

describe('status-application planning (chain B4)', () => {
  const renderableTaskRow: PendingStatusRow = {
    rowId: 'row-1',
    taskId: 'task-1',
    isRenderable: true,
  };

  test('a consumed renderable task row plans turn promotion followed by seq allocation', () => {
    const plan = planMessageStatusApplication([renderableTaskRow], 'consumed');

    expect(plan.targetStatus).toBe('consumed');
    expect(plan.plannedRowIds).toEqual(['row-1']);
    expect(plan.instructions).toEqual([
      { kind: 'promote-turn', rowId: 'row-1', taskId: 'task-1', sharedTurn: false },
      { kind: 'allocate-consumed-seq', rowId: 'row-1', providedSeq: null },
    ]);
  });

  test('the promote instruction carries no concrete turn value', () => {
    const [promote] = planMessageStatusApplication([renderableTaskRow], 'consumed').instructions;

    expect(Object.keys(promote).sort()).toEqual(['kind', 'rowId', 'sharedTurn', 'taskId']);
  });

  test('a non-renderable or taskless row plans only a timestamp touch', () => {
    const plan = planMessageStatusApplication(
      [
        { rowId: 'row-plain', taskId: 'task-1', isRenderable: false },
        { rowId: 'row-taskless', taskId: null, isRenderable: true },
      ],
      'failed'
    );

    expect(plan.instructions).toEqual([
      { kind: 'touch-timestamp', rowId: 'row-plain' },
      { kind: 'touch-timestamp', rowId: 'row-taskless' },
    ]);
  });

  test('a consumed target appends a seq allocation after every row instruction', () => {
    const plan = planMessageStatusApplication(
      [renderableTaskRow, { rowId: 'row-2', taskId: null, isRenderable: false }],
      'consumed'
    );

    expect(
      plan.instructions.map((instruction) => `${instruction.kind}:${instruction.rowId}`)
    ).toEqual([
      'promote-turn:row-1',
      'allocate-consumed-seq:row-1',
      'touch-timestamp:row-2',
      'allocate-consumed-seq:row-2',
    ]);
  });

  test('a failed target plans no seq allocations', () => {
    const plan = planMessageStatusApplication([renderableTaskRow], 'failed');

    expect(
      plan.instructions.every((instruction) => instruction.kind !== 'allocate-consumed-seq')
    ).toBe(true);
  });

  test('sharedTurn propagates to every promote instruction', () => {
    const plan = planMessageStatusApplication(
      [renderableTaskRow, { rowId: 'row-2', taskId: 'task-1', isRenderable: true }],
      'consumed',
      { sharedTurn: true }
    );

    expect(
      plan.instructions
        .filter((instruction) => instruction.kind === 'promote-turn')
        .every((instruction) => instruction.kind === 'promote-turn' && instruction.sharedTurn)
    ).toBe(true);
  });

  test('a caller-provided consumedSeq rides the plan; without it the instruction allocates', () => {
    const withSeq = planMessageStatusApplication([renderableTaskRow], 'consumed', {
      consumedSeq: 41,
    });
    const withoutSeq = planMessageStatusApplication([renderableTaskRow], 'consumed');

    expect(
      withSeq.instructions.every(
        (instruction) =>
          instruction.kind !== 'allocate-consumed-seq' || instruction.providedSeq === 41
      )
    ).toBe(true);
    expect(
      withoutSeq.instructions.every(
        (instruction) =>
          instruction.kind !== 'allocate-consumed-seq' || instruction.providedSeq === null
      )
    ).toBe(true);
  });

  test('the planned-from window is the pending delivery set', () => {
    const plan = planMessageStatusApplication([], 'consumed');

    expect(plan.fromStatuses).toBe(PENDING_ROW_FROM_STATUSES);
    expect(PENDING_ROW_FROM_STATUSES).toEqual(['deferred', 'enqueued', 'submitted']);
    expect(plan.instructions).toEqual([]);
    expect(plan.plannedRowIds).toEqual([]);
  });
});

describe('status-application interpretation (chain B4)', () => {
  let db: BunDatabase;
  let repo: SDKMessageRepository;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    repo = new SDKMessageRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function linkTaskSession(sessionId: string, taskId: string): void {
    db.prepare(
      `INSERT INTO sessions
         (id, title, created_at, last_active_at, status, config, metadata, type, session_context)
       VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'space_task_agent', ?)`
    ).run(sessionId, sessionId, NOW, NOW, JSON.stringify({ taskId }));
  }

  function enqueue(sessionId: string, uuid: string): string {
    return repo.saveUserMessageCore(sessionId, userMessage(uuid), 'enqueued').id;
  }

  function rowOf(id: string): {
    send_status: string;
    conversation_turn_index: number | null;
    consumed_seq: number | null;
    timestamp: string;
  } {
    return db
      .prepare(
        `SELECT send_status, conversation_turn_index, consumed_seq, timestamp
           FROM sdk_messages WHERE id = ?`
      )
      .get(id) as ReturnType<typeof rowOf>;
  }

  function ageTimestamp(id: string): void {
    db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE id = ?`).run(OLD_TS, id);
  }

  function snapshot(rows: Array<{ id: string; taskId: string | null }>): PendingStatusRow[] {
    return rows.map((row) => ({ rowId: row.id, taskId: row.taskId, isRenderable: true }));
  }

  function countingAllocator(): { allocate: () => number; calls: () => number } {
    let calls = 0;
    return { allocate: () => ++calls + 500, calls: () => calls };
  }

  test('a planned row that left the pending window fails its whole transition', () => {
    linkTaskSession('sess-1', 'task-1');
    const idA = enqueue('sess-1', 'u-live');
    const idB = enqueue('sess-1', 'u-stale');
    ageTimestamp(idA);
    ageTimestamp(idB);
    const plan = planMessageStatusApplication(
      snapshot([
        { id: idA, taskId: 'task-1' },
        { id: idB, taskId: 'task-1' },
      ]),
      'consumed'
    );
    db.prepare(`UPDATE sdk_messages SET send_status = 'failed' WHERE id = ?`).run(idB);
    const { allocate, calls } = countingAllocator();

    db.transaction(() => applyMessageStatusPlan(db, plan, [idA, idB], allocate))();

    const applied = rowOf(idA);
    expect(applied.send_status).toBe('consumed');
    expect(applied.conversation_turn_index).toBe(1);
    expect(applied.consumed_seq).toBe(501);
    expect(applied.timestamp).not.toBe(OLD_TS);
    expect(rowOf(idB)).toEqual({
      send_status: 'failed',
      conversation_turn_index: 0,
      consumed_seq: null,
      timestamp: OLD_TS,
    });
    expect(calls()).toBe(1);
  });

  test('an unplanned row flips unconditionally without turn, seq, or timestamp effects', () => {
    linkTaskSession('sess-1', 'task-1');
    const consumedBefore = repo.saveUserMessageCore('sess-1', userMessage('u-done'), 'consumed');
    const idPlanned = enqueue('sess-1', 'u-live');
    const unplannedBefore = rowOf(consumedBefore.id);
    const plan = planMessageStatusApplication(
      snapshot([{ id: idPlanned, taskId: 'task-1' }]),
      'failed'
    );
    const { allocate, calls } = countingAllocator();

    db.transaction(() =>
      applyMessageStatusPlan(db, plan, [idPlanned, consumedBefore.id], allocate)
    )();

    const applied = rowOf(idPlanned);
    expect(applied.send_status).toBe('failed');
    expect(applied.conversation_turn_index).toBe(2);
    expect(applied.consumed_seq).toBeNull();
    const unplannedAfter = rowOf(consumedBefore.id);
    expect(unplannedAfter.send_status).toBe('failed');
    expect(unplannedAfter.conversation_turn_index).toBe(unplannedBefore.conversation_turn_index);
    expect(unplannedAfter.consumed_seq).toBe(unplannedBefore.consumed_seq);
    expect(unplannedAfter.timestamp).toBe(unplannedBefore.timestamp);
    expect(calls()).toBe(0);
  });

  test('unshared promotion reads the live task max per row, assigning sequential turns', () => {
    linkTaskSession('sess-1', 'task-1');
    repo.saveUserMessageCore('sess-1', userMessage('u-anchor'), 'consumed');
    const idA = enqueue('sess-1', 'u-a');
    const idB = enqueue('sess-1', 'u-b');
    const plan = planMessageStatusApplication(
      snapshot([
        { id: idA, taskId: 'task-1' },
        { id: idB, taskId: 'task-1' },
      ]),
      'consumed'
    );

    db.transaction(() => applyMessageStatusPlan(db, plan, [idA, idB], () => null))();

    expect(rowOf(idA).conversation_turn_index).toBe(2);
    expect(rowOf(idB).conversation_turn_index).toBe(3);
    expect(rowOf(idA).consumed_seq).toBeNull();
    expect(rowOf(idB).consumed_seq).toBeNull();
  });

  test('shared promotion freezes one base per task inside the transaction', () => {
    linkTaskSession('sess-1', 'task-1');
    linkTaskSession('sess-2', 'task-2');
    repo.saveUserMessageCore('sess-1', userMessage('u-anchor-1'), 'consumed');
    const idA = enqueue('sess-1', 'u-a');
    const idB = enqueue('sess-1', 'u-b');
    const idOtherTask = enqueue('sess-2', 'u-other');
    const plan = planMessageStatusApplication(
      snapshot([
        { id: idA, taskId: 'task-1' },
        { id: idB, taskId: 'task-1' },
        { id: idOtherTask, taskId: 'task-2' },
      ]),
      'consumed',
      { sharedTurn: true }
    );

    db.transaction(() => applyMessageStatusPlan(db, plan, [idA, idB, idOtherTask], () => null))();

    expect(rowOf(idA).conversation_turn_index).toBe(2);
    expect(rowOf(idB).conversation_turn_index).toBe(2);
    expect(rowOf(idOtherTask).conversation_turn_index).toBe(1);
  });

  test('a provided seq is reused for every row without invoking the allocator', () => {
    linkTaskSession('sess-1', 'task-1');
    const idA = enqueue('sess-1', 'u-a');
    const idB = enqueue('sess-1', 'u-b');
    const plan = planMessageStatusApplication(
      snapshot([
        { id: idA, taskId: 'task-1' },
        { id: idB, taskId: 'task-1' },
      ]),
      'consumed',
      { consumedSeq: 77 }
    );
    const { allocate, calls } = countingAllocator();

    db.transaction(() => applyMessageStatusPlan(db, plan, [idA, idB], allocate))();

    expect(rowOf(idA).consumed_seq).toBe(77);
    expect(rowOf(idB).consumed_seq).toBe(77);
    expect(calls()).toBe(0);
  });
});
