import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { TASK_SLOT_STATUSES, availableTaskSlots } from '../../../../src/lib/tasks/capacity';
import { announceActivation } from '../../../../src/lib/tasks/start-direct-task';

let db: Database;
let tasks: SpaceTaskRepository;
let spaceId: string;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  spaceId = new SpaceRepository(db).createSpace({ name: 'S', slug: 's', workspacePath: '/r' }).id;
  tasks = new SpaceTaskRepository(db);
});

describe('SpaceTaskRepository.updateTask completedAt', () => {
  test('an explicit completedAt wins over the status stamp, and the status stamps it otherwise', () => {
    const blocked = tasks.createTask({ spaceId, title: 'B', description: '' });
    expect(
      tasks.updateTask(blocked.id, { status: 'blocked', completedAt: null })?.completedAt
    ).toBeNull();
    const done = tasks.createTask({ spaceId, title: 'D', description: '' });
    expect(tasks.updateTask(done.id, { status: 'done' })?.completedAt).toEqual(expect.any(Number));
  });
});

describe('SpaceTaskRepository.countByStatuses', () => {
  test('counts only the slot-holding tasks of the Space', () => {
    for (const status of ['in_progress', 'approved', 'open', 'done'] as const)
      tasks.createTask({ spaceId, title: status, description: '', status });
    expect(tasks.countByStatuses(spaceId, TASK_SLOT_STATUSES)).toBe(2);
    expect(tasks.countByStatuses(spaceId, [])).toBe(0);
    const space = new SpaceRepository(db).getSpace(spaceId);
    expect(availableTaskSlots(space, tasks.countByStatuses(spaceId, TASK_SLOT_STATUSES))).toBe(
      Math.max(0, availableTaskSlots(space, 0) - 2)
    );
  });
});

describe('announceActivation', () => {
  test('reports an activated task once and stays quiet otherwise', () => {
    const hook = mock((_taskId: string) => {});
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    const activated = { activated: true as const, attempt: {} as never, task };
    expect(announceActivation(activated, hook)).toBe(activated);
    announceActivation({ activated: false, reason: 'unavailable' }, hook);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(task.id);
  });
});
