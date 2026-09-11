import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { editStandaloneTask } from '../../../../src/storage/tasks/edit-task';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createTestDb } from '../../../helpers/database';

describe('standalone task metadata editing', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  function create() {
    return createStandaloneTask(
      db.getDatabase(),
      {
        title: 'Work',
        description: 'Details',
        priority: 'high',
        labels: ['one'],
      },
      'creator',
      () => {}
    );
  }

  test('persists a partial edit before notifying and preserves other task fields', () => {
    const task = create();
    db.getDatabase().prepare('UPDATE space_tasks SET updated_at = 1 WHERE id = ?').run(task.id);
    const notify = mock(() => {
      expect(readTaskCore(db.getDatabase(), task.id)?.title).toBe("Work's new title");
    });
    const edited = editStandaloneTask(
      db.getDatabase(),
      { taskId: task.id, title: "Work's new title" },
      notify
    );
    expect(edited).toEqual({ ...task, title: "Work's new title", updatedAt: expect.any(Number) });
    expect(edited!.updatedAt).toBeGreaterThan(1);
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(edited);
    expect(
      db
        .getDatabase()
        .prepare('SELECT space_id, task_number, created_by_session FROM space_tasks WHERE id = ?')
        .get(task.id)
    ).toEqual({ space_id: null, task_number: null, created_by_session: 'creator' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('supports clearing metadata and leaves separately edited fields intact', () => {
    const task = create();
    editStandaloneTask(db.getDatabase(), { taskId: task.id, title: 'Renamed' }, () => {});
    const edited = editStandaloneTask(
      db.getDatabase(),
      {
        taskId: task.id,
        title: undefined,
        description: '',
        labels: [],
        priority: 'low',
      },
      () => {}
    );
    expect(edited).toMatchObject({
      title: 'Renamed',
      description: '',
      labels: [],
      priority: 'low',
    });
  });

  test('does not modify or notify for Space-owned or absent tasks', () => {
    const space = new SpaceRepository(db.getDatabase()).createSpace({
      name: 'Test',
      slug: 'test',
      workspacePath: '/workspace/test',
    });
    const tasks = new SpaceTaskRepository(db.getDatabase());
    const owned = tasks.createTask({ spaceId: space.id, title: 'Owned', description: '' });
    const notify = mock(() => {});
    for (const taskId of [owned.id, 'absent']) {
      expect(editStandaloneTask(db.getDatabase(), { taskId, title: 'Changed' }, notify)).toBeNull();
    }
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(notify).not.toHaveBeenCalled();
  });

  test('rejects empty patches and keeps persistence failures atomic without notifying', () => {
    const task = create();
    const notify = mock(() => {});
    expect(() => editStandaloneTask(db.getDatabase(), { taskId: task.id }, notify)).toThrow(
      'at least one field'
    );
    db.getDatabase().exec(
      "CREATE TRIGGER reject_edit BEFORE UPDATE ON space_tasks BEGIN SELECT RAISE(ABORT, 'rejected'); END"
    );
    expect(() =>
      editStandaloneTask(
        db.getDatabase(),
        { taskId: task.id, title: 'Changed', labels: [] },
        notify
      )
    ).toThrow('rejected');
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
    expect(notify).not.toHaveBeenCalled();
  });
});
