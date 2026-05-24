/**
 * GoalRepository LiveQuery Integration Tests
 *
 * Unit test: LiveQueryEngine subscriptions on `goals` fire after every
 * write through GoalRepository (create, update, delete, link, unlink).
 *
 * Design: GoalRepository calls reactiveDb.notifyChange('goals') after each
 * mutating operation. LiveQueryEngine listens on the reactive change event and
 * re-evaluates registered queries in a microtask, then calls subscribers with
 * a diff. All assertions await a microtask flush before checking diffs.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import { GoalRepository } from '../../../../src/storage/repositories/goal-repository';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { QueryDiff } from '../../../../src/storage/live-query';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GOALS_SQL = `SELECT id, title, status FROM goals ORDER BY created_at ASC`;

interface GoalRow {
  id: string;
  title: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('GoalRepository → LiveQueryEngine subscription on goals', () => {
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;
  let repo: GoalRepository;
  let roomId: string;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    createTables(bunDb);

    // Insert a minimal room row so FK constraints are satisfied
    roomId = 'room-lq-test';
    bunDb.exec(
      `INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${Date.now()}, ${Date.now()})`
    );

    // Wire up reactive layer
    // Note: createReactiveDatabase wraps a Database facade; here we pass the
    // BunDatabase directly for a lightweight setup.  notifyChange() is called
    // manually by GoalRepository, so the proxy is not needed.
    // We build a minimal reactiveDb backed directly by the BunDatabase.
    reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
    engine = new LiveQueryEngine(bunDb, reactiveDb);
    repo = new GoalRepository(bunDb, reactiveDb);
  });

  afterEach(() => {
    engine.dispose();
    bunDb.close();
  });

  // ---------------------------------------------------------------------------
  // createGoal
  // ---------------------------------------------------------------------------

  test('createGoal fires a LiveQuery delta', async () => {
    const diffs: QueryDiff<GoalRow>[] = [];
    engine.subscribe(GOALS_SQL, [], (diff) => diffs.push(diff));

    // snapshot fires synchronously
    expect(diffs.length).toBe(1);
    expect(diffs[0].type).toBe('snapshot');
    expect(diffs[0].rows).toHaveLength(0);

    repo.createGoal({ roomId, title: 'First Goal' });

    await Promise.resolve();
    await Promise.resolve();

    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].added).toHaveLength(1);
    expect(diffs[1].added?.[0].title).toBe('First Goal');
  });

  // ---------------------------------------------------------------------------
  // updateGoal
  // ---------------------------------------------------------------------------

  test('updateGoal fires a LiveQuery delta', async () => {
    const goal = repo.createGoal({ roomId, title: 'To Update' });

    const diffs: QueryDiff<GoalRow>[] = [];
    engine.subscribe(GOALS_SQL, [], (diff) => diffs.push(diff));
    expect(diffs[0].rows).toHaveLength(1);

    repo.updateGoal(goal.id, { status: 'completed' });

    await Promise.resolve();
    await Promise.resolve();

    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].updated?.[0].status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // deleteGoal
  // ---------------------------------------------------------------------------

  test('deleteGoal fires a LiveQuery delta', async () => {
    const goal = repo.createGoal({ roomId, title: 'To Delete' });

    const diffs: QueryDiff<GoalRow>[] = [];
    engine.subscribe(GOALS_SQL, [], (diff) => diffs.push(diff));
    expect(diffs[0].rows).toHaveLength(1);

    repo.deleteGoal(goal.id);

    await Promise.resolve();
    await Promise.resolve();

    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].removed).toHaveLength(1);
    expect(diffs[1].removed?.[0].id).toBe(goal.id);
  });

  // ---------------------------------------------------------------------------
  // linkTaskToGoal (calls updateGoal internally)
  // ---------------------------------------------------------------------------

  test('linkTaskToGoal fires a LiveQuery delta', async () => {
    const goal = repo.createGoal({ roomId, title: 'Link Test' });

    // Insert a minimal task so we have a valid task ID to link
    const taskId = 'task-lq-link';
    bunDb.exec(
      `INSERT OR IGNORE INTO tasks
			 (id, room_id, title, description, status, priority, created_at)
			 VALUES ('${taskId}', '${roomId}', 'Task', '', 'pending', 'normal', ${Date.now()})`
    );

    // Subscribe to linked_task_ids column
    const LINKED_SQL = `SELECT id, linked_task_ids FROM goals WHERE id = ?`;
    const diffs: QueryDiff<{ id: string; linked_task_ids: string }>[] = [];
    engine.subscribe(LINKED_SQL, [goal.id], (diff) => diffs.push(diff));
    expect(JSON.parse(diffs[0].rows[0].linked_task_ids)).toHaveLength(0);

    repo.linkTaskToGoal(goal.id, taskId);

    await Promise.resolve();
    await Promise.resolve();

    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
    const linkedIds = JSON.parse(diffs[1].updated?.[0].linked_task_ids ?? '[]');
    expect(linkedIds).toContain(taskId);
  });

  // ---------------------------------------------------------------------------
  // unlinkTaskFromGoal (calls updateGoal internally)
  // ---------------------------------------------------------------------------

  test('unlinkTaskFromGoal fires a LiveQuery delta', async () => {
    const taskId = 'task-lq-unlink';
    bunDb.exec(
      `INSERT OR IGNORE INTO tasks
			 (id, room_id, title, description, status, priority, created_at)
			 VALUES ('${taskId}', '${roomId}', 'Task', '', 'pending', 'normal', ${Date.now()})`
    );

    const goal = repo.createGoal({ roomId, title: 'Unlink Test' });
    repo.linkTaskToGoal(goal.id, taskId);

    const LINKED_SQL = `SELECT id, linked_task_ids FROM goals WHERE id = ?`;
    const diffs: QueryDiff<{ id: string; linked_task_ids: string }>[] = [];
    engine.subscribe(LINKED_SQL, [goal.id], (diff) => diffs.push(diff));

    const initialIds = JSON.parse(diffs[0].rows[0].linked_task_ids);
    expect(initialIds).toContain(taskId);

    repo.unlinkTaskFromGoal(goal.id, taskId);

    await Promise.resolve();
    await Promise.resolve();

    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
    const afterIds = JSON.parse(diffs[1].updated?.[0].linked_task_ids ?? '[]');
    expect(afterIds).not.toContain(taskId);
  });

  // ---------------------------------------------------------------------------
  // Multiple writes coalesce
  // ---------------------------------------------------------------------------

  test('multiple rapid createGoal calls coalesce into one delta', async () => {
    const diffs: QueryDiff<GoalRow>[] = [];
    engine.subscribe(GOALS_SQL, [], (diff) => diffs.push(diff));
    expect(diffs[0].rows).toHaveLength(0);

    // Three back-to-back writes without yielding
    repo.createGoal({ roomId, title: 'Goal A' });
    repo.createGoal({ roomId, title: 'Goal B' });
    repo.createGoal({ roomId, title: 'Goal C' });

    await Promise.resolve();
    await Promise.resolve();

    // Should coalesce into one delta (snapshot + 1 delta)
    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].added).toHaveLength(3);
  });
});
