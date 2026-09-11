import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import {
  transitionStandaloneTask,
  decidePersistedTaskTransition,
} from '../../../../src/storage/tasks/transition-task';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createTestDb } from '../../../helpers/database';

describe('standalone lifecycle persistence', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());
  function create() {
    return createStandaloneTask(
      db.getDatabase(),
      { title: 'Work', labels: ['one'] },
      'creator',
      () => {}
    );
  }

  test('commits completion before notifying and preserves metadata and ownership', () => {
    const task = create();
    const notify = mock(() => {
      db.getDatabase().exec('BEGIN');
      db.getDatabase().exec('ROLLBACK');
      expect(readTaskCore(db.getDatabase(), task.id)?.status).toBe('done');
    });
    const done = transitionStandaloneTask(
      db.getDatabase(),
      { taskId: task.id, status: 'done', result: 'Finished' },
      notify
    );
    expect(done).toEqual({
      ...task,
      status: 'done',
      result: 'Finished',
      completedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(done);
    expect(
      db
        .getDatabase()
        .prepare('SELECT space_id, task_number, created_by_session FROM space_tasks WHERE id = ?')
        .get(task.id)
    ).toEqual({ space_id: null, task_number: null, created_by_session: 'creator' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('persists restart and archive decisions without launching execution', () => {
    const task = create();
    const run = (status: 'done' | 'in_progress' | 'cancelled' | 'archived') =>
      transitionStandaloneTask(db.getDatabase(), { taskId: task.id, status }, () => {});
    run('done');
    expect(run('in_progress')).toMatchObject({
      startedAt: expect.any(Number),
      completedAt: null,
      result: null,
    });
    run('cancelled');
    expect(run('archived')).toMatchObject({
      archivedAt: expect.any(Number),
      completedAt: expect.any(Number),
    });
    expect(
      db
        .getDatabase()
        .prepare('SELECT task_agent_session_id, workflow_run_id FROM space_tasks WHERE id = ?')
        .get(task.id)
    ).toEqual({ task_agent_session_id: null, workflow_run_id: null });
  });

  test('returns null for missing or Space-owned tasks without notifying', () => {
    const space = new SpaceRepository(db.getDatabase()).createSpace({
      name: 'Test',
      slug: 'test',
      workspacePath: '/workspace/test',
    });
    const tasks = new SpaceTaskRepository(db.getDatabase());
    const owned = tasks.createTask({ spaceId: space.id, title: 'Owned', description: '' });
    const notify = mock(() => {});
    for (const taskId of ['absent', owned.id]) {
      expect(
        transitionStandaloneTask(db.getDatabase(), { taskId, status: 'done' }, notify)
      ).toBeNull();
    }
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(notify).not.toHaveBeenCalled();
  });

  test.each([
    ['open', undefined, 'invalid_transition'],
    ['blocked', 'Result', 'result_requires_done'],
  ] as const)('rejects %s without changing storage', (status, result, reason) => {
    const task = create();
    const notify = mock(() => {});
    expect(
      transitionStandaloneTask(db.getDatabase(), { taskId: task.id, status, result }, notify)
    ).toBe(reason);
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
    expect(notify).not.toHaveBeenCalled();
  });

  test('rolls back failed persistence and emits no notification', () => {
    const task = create();
    const notify = mock(() => {});
    db.getDatabase().exec(
      "CREATE TRIGGER reject_transition AFTER UPDATE ON space_tasks BEGIN SELECT RAISE(ABORT, 'rejected'); END"
    );
    expect(() =>
      transitionStandaloneTask(db.getDatabase(), { taskId: task.id, status: 'done' }, notify)
    ).toThrow('rejected');
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
    db.getDatabase().exec('BEGIN');
    db.getDatabase().exec('ROLLBACK');
    expect(notify).not.toHaveBeenCalled();
  });

  test('preserves caller transactions and does not notify before their commit', () => {
    const task = create();
    const notify = mock(() => {});
    db.getDatabase().transaction(() => {
      expect(() =>
        transitionStandaloneTask(db.getDatabase(), { taskId: task.id, status: 'done' }, notify)
      ).toThrow('own transaction');
      expect(() => db.getDatabase().exec('BEGIN')).toThrow();
      expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
    })();
    expect(notify).not.toHaveBeenCalled();
  });

  test.each([
    ['open', 'done', undefined],
    ['open', 'open', 'invalid_transition'],
    ['review', 'done', 'unsupported_status'],
  ] as const)('adapts planner decisions for %s to %s', (from, status, reason) => {
    const task = { ...create(), status: from };
    const decision = decidePersistedTaskTransition(task, { status }, 10);
    expect(decision).toEqual(
      reason
        ? { reason }
        : {
            value: {
              status: 'done',
              startedAt: null,
              completedAt: 10,
              archivedAt: null,
              result: null,
              updatedAt: 10,
            },
          }
    );
  });
});
