import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createTestDb, createTestSession } from '../../../helpers/database';

describe('standalone task creation', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  test('persists core defaults and notifies only after the row is readable', () => {
    const notify = mock(() => {
      expect(db.getDatabase().prepare('SELECT id FROM space_tasks').all()).toHaveLength(1);
    });
    const task = createStandaloneTask(db.getDatabase(), { title: 'Work' }, undefined, notify);
    expect(task).toEqual({
      id: expect.any(String),
      title: 'Work',
      description: '',
      status: 'open',
      priority: 'normal',
      labels: [],
      dependsOn: [],
      result: null,
      createdAt: expect.any(Number),
      updatedAt: task.createdAt,
      startedAt: null,
      completedAt: null,
      archivedAt: null,
    });
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
    expect(
      db
        .getDatabase()
        .prepare(
          'SELECT space_id, task_number, workflow_run_id, task_agent_session_id FROM space_tasks WHERE id = ?'
        )
        .get(task.id)
    ).toEqual({
      space_id: null,
      task_number: null,
      workflow_run_id: null,
      task_agent_session_id: null,
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('preserves caller fields and provenance without binding lifetime to the creator', () => {
    db.createSession(createTestSession('creator'));
    const task = createStandaloneTask(
      db.getDatabase(),
      {
        title: "Work's title",
        description: 'Details',
        priority: 'high',
        labels: ['one', 'two'],
      },
      'creator',
      () => {}
    );
    expect(task).toMatchObject({
      title: "Work's title",
      description: 'Details',
      priority: 'high',
      labels: ['one', 'two'],
    });
    expect(
      db
        .getDatabase()
        .prepare('SELECT created_by_session FROM space_tasks WHERE id = ?')
        .get(task.id)
    ).toEqual({ created_by_session: 'creator' });
    db.deleteSession('creator');
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
  });

  test('uses unique IDs without consuming Space numbering or changing Space task APIs', () => {
    const space = new SpaceRepository(db.getDatabase()).createSpace({
      name: 'Test',
      slug: 'test',
      workspacePath: '/workspace/test',
    });
    const tasks = new SpaceTaskRepository(db.getDatabase());
    const first = tasks.createTask({ spaceId: space.id, title: 'First', description: '' });
    const a = createStandaloneTask(db.getDatabase(), { title: 'A' }, undefined, () => {});
    const b = createStandaloneTask(db.getDatabase(), { title: 'B' }, undefined, () => {});
    expect(a.id).not.toBe(b.id);
    expect(tasks.getTask(a.id)).toBeNull();
    expect(tasks.updateTask(a.id, { title: 'Space update' })).toBeNull();
    expect(tasks.deleteTask(a.id)).toBe(false);
    expect(readTaskCore(db.getDatabase(), a.id)).toEqual(a);
    const second = tasks.createTask({ spaceId: space.id, title: 'Second', description: '' });
    expect(second.taskNumber).toBe(first.taskNumber + 1);
  });

  test('does not notify when persistence fails', () => {
    const notify = mock(() => {});
    db.getDatabase().exec(
      "CREATE TRIGGER reject_create BEFORE INSERT ON space_tasks BEGIN SELECT RAISE(ABORT, 'rejected'); END"
    );
    expect(() =>
      createStandaloneTask(db.getDatabase(), { title: 'Rejected' }, undefined, notify)
    ).toThrow('rejected');
    expect(notify).not.toHaveBeenCalled();
    expect(db.getDatabase().prepare('SELECT id FROM space_tasks').all()).toEqual([]);
  });
});
