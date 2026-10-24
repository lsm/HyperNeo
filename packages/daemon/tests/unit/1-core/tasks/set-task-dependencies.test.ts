import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import {
  editStandaloneTaskWithDependencies,
  decideTaskDependencyReplacement,
} from '../../../../src/storage/tasks/set-task-dependencies';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { runDbOpOn, fixtureChanges } from '../../helpers/run-db-op';
import { createTestDb } from '../../../helpers/database';

describe('standalone dependency persistence', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());
  function create(title: string) {
    return createStandaloneTask.run(db.getDatabase(), { input: { title } }, fixtureChanges());
  }

  test('replaces and clears dependencies, preserves metadata and notifies after commit', async () => {
    const a = create('A');
    const b = create('B');
    const notify = mock(() => {
      db.getDatabase().exec('BEGIN');
      db.getDatabase().exec('ROLLBACK');
      expect(readTaskCore(db.getDatabase(), a.id)?.dependsOn).toEqual([b.id]);
    });
    const result = await runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, {
      taskId: a.id,
      dependsOn: [b.id],
    });
    expect(result).toEqual({ ...a, dependsOn: [b.id], updatedAt: expect.any(Number) });
    expect(readTaskCore(db.getDatabase(), b.id)).toEqual(b);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      await runDbOpOn(db.getDatabase())(editStandaloneTaskWithDependencies, {
        taskId: a.id,
        dependsOn: [],
      })
    ).toMatchObject({ dependsOn: [] });
  });

  test('rejects missing references, self-edges, duplicates and indirect cycles without writes', async () => {
    const a = create('A');
    const b = create('B');
    const c = create('C');
    await runDbOpOn(db.getDatabase())(editStandaloneTaskWithDependencies, {
      taskId: a.id,
      dependsOn: [b.id],
    });
    await runDbOpOn(db.getDatabase())(editStandaloneTaskWithDependencies, {
      taskId: b.id,
      dependsOn: [c.id],
    });
    const notify = mock(() => {});
    for (const [dependsOn, reason] of [
      [['absent'], 'dependency_not_found'],
      [[c.id], 'self_dependency'],
      [[a.id, a.id], 'duplicate_dependency'],
      [[a.id], 'dependency_cycle'],
    ] as const) {
      expect(
        await runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, {
          taskId: c.id,
          dependsOn: [...dependsOn],
        })
      ).toBe(reason);
      expect(readTaskCore(db.getDatabase(), c.id)).toEqual(c);
    }
    expect(notify).not.toHaveBeenCalled();
  });

  test('isolates Space tasks as both targets and referenced dependencies', async () => {
    const a = create('A');
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
          dependsOn: [],
        })
      ).toBeNull();
    }
    expect(
      await runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, {
        taskId: a.id,
        dependsOn: [owned.id],
      })
    ).toBe('dependency_not_found');
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(readTaskCore(db.getDatabase(), a.id)).toEqual(a);
    expect(notify).not.toHaveBeenCalled();
  });

  test('rolls back persistence failures', async () => {
    const a = create('A');
    const b = create('B');
    const input = { taskId: a.id, dependsOn: [b.id] };
    const notify = mock(() => {});
    db.getDatabase().exec(
      "CREATE TRIGGER reject_dependencies AFTER UPDATE ON space_tasks BEGIN SELECT RAISE(ABORT, 'rejected'); END"
    );
    await expect(
      runDbOpOn(db.getDatabase(), notify)(editStandaloneTaskWithDependencies, input)
    ).rejects.toThrow('rejected');
    expect(readTaskCore(db.getDatabase(), a.id)).toEqual(a);
    expect(notify).not.toHaveBeenCalled();
  });

  test.each([
    [[], { value: [] }],
    [['b'], { value: ['b'] }],
    [['a'], { reason: 'self_dependency' }],
    [['absent'], { reason: 'dependency_not_found' }],
  ])('adapts dependency planner decisions for %j', (dependsOn, expected) => {
    expect(
      decideTaskDependencyReplacement([{ id: 'a' }, { id: 'b' }], {
        taskId: 'a',
        dependsOn: dependsOn as string[],
      })
    ).toEqual(expected);
  });
});
