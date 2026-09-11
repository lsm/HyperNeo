import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import {
  setStandaloneTaskDependencies,
  decideTaskDependencyReplacement,
} from '../../../../src/storage/tasks/set-task-dependencies';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createTestDb } from '../../../helpers/database';

describe('standalone dependency persistence', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());
  function create(title: string) {
    return createStandaloneTask(db.getDatabase(), { title }, undefined, () => {});
  }

  test('replaces and clears dependencies, preserves metadata and notifies after commit', () => {
    const a = create('A');
    const b = create('B');
    const notify = mock(() => {
      db.getDatabase().exec('BEGIN');
      db.getDatabase().exec('ROLLBACK');
      expect(readTaskCore(db.getDatabase(), a.id)?.dependsOn).toEqual([b.id]);
    });
    const result = setStandaloneTaskDependencies(
      db.getDatabase(),
      { taskId: a.id, dependsOn: [b.id] },
      notify
    );
    expect(result).toEqual({ ...a, dependsOn: [b.id], updatedAt: expect.any(Number) });
    expect(readTaskCore(db.getDatabase(), b.id)).toEqual(b);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      setStandaloneTaskDependencies(db.getDatabase(), { taskId: a.id, dependsOn: [] }, () => {})
    ).toMatchObject({ dependsOn: [] });
  });

  test('rejects missing references, self-edges, duplicates and indirect cycles without writes', () => {
    const a = create('A');
    const b = create('B');
    const c = create('C');
    setStandaloneTaskDependencies(db.getDatabase(), { taskId: a.id, dependsOn: [b.id] }, () => {});
    setStandaloneTaskDependencies(db.getDatabase(), { taskId: b.id, dependsOn: [c.id] }, () => {});
    const notify = mock(() => {});
    for (const [dependsOn, reason] of [
      [['absent'], 'dependency_not_found'],
      [[c.id], 'self_dependency'],
      [[a.id, a.id], 'duplicate_dependency'],
      [[a.id], 'dependency_cycle'],
    ] as const) {
      expect(
        setStandaloneTaskDependencies(
          db.getDatabase(),
          { taskId: c.id, dependsOn: [...dependsOn] },
          notify
        )
      ).toBe(reason);
      expect(readTaskCore(db.getDatabase(), c.id)).toEqual(c);
    }
    expect(notify).not.toHaveBeenCalled();
  });

  test('isolates Space tasks as both targets and referenced dependencies', () => {
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
        setStandaloneTaskDependencies(db.getDatabase(), { taskId, dependsOn: [] }, notify)
      ).toBeNull();
    }
    expect(
      setStandaloneTaskDependencies(
        db.getDatabase(),
        { taskId: a.id, dependsOn: [owned.id] },
        notify
      )
    ).toBe('dependency_not_found');
    expect(tasks.getTask(owned.id)).toEqual(owned);
    expect(readTaskCore(db.getDatabase(), a.id)).toEqual(a);
    expect(notify).not.toHaveBeenCalled();
  });

  test('rolls back persistence failures and preserves caller transactions', () => {
    const a = create('A');
    const b = create('B');
    const input = { taskId: a.id, dependsOn: [b.id] };
    const notify = mock(() => {});
    db.getDatabase().transaction(() => {
      expect(() => setStandaloneTaskDependencies(db.getDatabase(), input, notify)).toThrow(
        'own transaction'
      );
      expect(() => db.getDatabase().exec('BEGIN')).toThrow();
    })();
    db.getDatabase().exec(
      "CREATE TRIGGER reject_dependencies AFTER UPDATE ON space_tasks BEGIN SELECT RAISE(ABORT, 'rejected'); END"
    );
    expect(() => setStandaloneTaskDependencies(db.getDatabase(), input, notify)).toThrow(
      'rejected'
    );
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
