import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('core task reader', () => {
  let db: Database;
  let tasks: SpaceTaskRepository;
  let spaceId: string;
  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    tasks = new SpaceTaskRepository(db);
    spaceId = new SpaceRepository(db).createSpace({
      workspacePath: '/workspace/test',
      slug: 'test',
      name: 'Test',
    }).id;
  });
  afterEach(() => db.close());

  test('reads existing Space tasks by global ID without needing owner context', () => {
    const stored = tasks.createTask({
      spaceId,
      title: 'Work',
      description: 'Details',
      labels: ['a'],
    });
    const task = readTaskCore(db, stored.id);
    expect(task).toEqual({
      id: stored.id,
      title: stored.title,
      description: stored.description,
      status: stored.status,
      priority: stored.priority,
      labels: stored.labels,
      dependsOn: stored.dependsOn,
      result: stored.result,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
      archivedAt: stored.archivedAt,
    });
    expect(task).not.toHaveProperty('spaceId');
    expect(task).not.toHaveProperty('taskAgentSessionId');
    expect(tasks.getTask(stored.id)).toEqual(stored);
  });

  test('returns null for an absent task and treats IDs as bound values', () => {
    expect(readTaskCore(db, 'missing')).toBeNull();
    expect(readTaskCore(db, "' OR 1=1 --")).toBeNull();
  });

  test('reads archived records without changing them', () => {
    const stored = tasks.createTask({ spaceId, title: 'Archived', description: '' });
    const archived = tasks.archiveTask(stored.id);
    expect(readTaskCore(db, stored.id)).toMatchObject({
      status: 'archived',
      archivedAt: archived?.archivedAt,
    });
    expect(tasks.getTask(stored.id)).toEqual(archived);
  });
});
