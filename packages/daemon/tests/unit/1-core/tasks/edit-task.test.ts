import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { editStandaloneTaskWithDependencies } from '../../../../src/storage/tasks/set-task-dependencies';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { runDbOpOn, fixtureChanges } from '../../helpers/run-db-op';
import { createTestDb } from '../../../helpers/database';

describe('standalone task metadata editing', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  function create() {
    return createStandaloneTask.run(
      db.getDatabase(),
      {
        input: {
          title: 'Work',
          description: 'Details',
          priority: 'high',
          labels: ['one'],
        },
        creatorSessionId: 'creator',
      },
      fixtureChanges()
    );
  }

  test('persists a partial edit before notifying and preserves other task fields', async () => {
    const task = create();
    db.getDatabase().prepare('UPDATE space_tasks SET updated_at = 1 WHERE id = ?').run(task.id);
    const notify = mock(() => {
      expect(readTaskCore(db.getDatabase(), task.id)?.title).toBe("Work's new title");
    });
    const edited = await runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, {
      taskId: task.id,
      title: "Work's new title",
    });
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

  test('supports clearing metadata and leaves separately edited fields intact', async () => {
    const task = create();
    await runDbOpOn(db.getDatabase())(editStandaloneTaskWithDependencies, {
      taskId: task.id,
      title: 'Renamed',
    });
    const edited = await runDbOpOn(db.getDatabase())(editStandaloneTaskWithDependencies, {
      taskId: task.id,
      title: undefined,
      description: '',
      labels: [],
      priority: 'low',
    });
    expect(edited).toMatchObject({
      title: 'Renamed',
      description: '',
      labels: [],
      priority: 'low',
    });
  });

  test('does not modify or notify for Space-owned or absent tasks', async () => {
    const space = new SpaceRepository(db.getDatabase()).createSpace({
      name: 'Test',
      slug: 'test',
      workspacePath: '/workspace/test',
    });
    const tasks = new SpaceTaskRepository(db.getDatabase());
    const owned = tasks.createTask({ spaceId: space.id, title: 'Owned', description: '' });
    const notify = mock(() => {});
    for (const taskId of [owned.id, 'absent']) {
      expect(
        await runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, {
          taskId,
          title: 'Changed',
        })
      ).toBeNull();
    }
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(notify).not.toHaveBeenCalled();
  });

  test('rejects empty patches and keeps persistence failures atomic without notifying', async () => {
    const task = create();
    const notify = mock(() => {});
    await expect(
      runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, { taskId: task.id })
    ).rejects.toThrow('at least one field');
    db.getDatabase().exec(
      "CREATE TRIGGER reject_edit BEFORE UPDATE ON space_tasks BEGIN SELECT RAISE(ABORT, 'rejected'); END"
    );
    await expect(
      runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, {
        taskId: task.id,
        title: 'Changed',
        labels: [],
      })
    ).rejects.toThrow('rejected');
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
    expect(notify).not.toHaveBeenCalled();
  });
});
