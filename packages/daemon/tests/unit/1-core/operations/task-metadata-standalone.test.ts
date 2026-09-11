import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createStandaloneTaskMetadataEditor } from '../../../../src/lib/operations/task-metadata-standalone';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
});
afterEach(() => db.close());

test.each(['rpc', 'mcp', 'internal'] as const)(
  'keeps standalone metadata editing available to %s',
  async (source) => {
    const original = createStandaloneTask(db, { title: 'Original' }, undefined, () => {});
    const notify = mock(() => {});
    const edit = createStandaloneTaskMetadataEditor(db, notify);
    const updated = await edit(
      { taskId: original.id, title: ' Updated ', labels: ['label'] },
      { source, sessionId: 'session-1' }
    );
    expect(updated).toEqual({
      ...original,
      title: ' Updated ',
      labels: ['label'],
      updatedAt: expect.any(Number),
    });
    expect(readTaskCore(db, original.id)).toEqual(updated);
    expect(notify).toHaveBeenCalledTimes(1);
  }
);

test('missing and Space-owned tasks stay inaccessible without notification', async () => {
  const space = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  });
  const tasks = new SpaceTaskRepository(db);
  const owned = tasks.createTask({ spaceId: space.id, title: 'Owned', description: '' });
  const notify = mock(() => {});
  const edit = createStandaloneTaskMetadataEditor(db, notify);
  for (const taskId of ['missing', owned.id]) {
    expect(
      await edit({ taskId, title: 'Changed' }, { source: 'mcp', sessionId: 'session-1' })
    ).toBeNull();
  }
  expect(tasks.getTask(owned.id)).toEqual(owned);
  expect(notify).not.toHaveBeenCalled();
});

test('preserves storage failures without notification', async () => {
  const original = createStandaloneTask(db, { title: 'Original' }, undefined, () => {});
  const notify = mock(() => {});
  const edit = createStandaloneTaskMetadataEditor(db, notify);
  await expect(edit({ taskId: original.id }, { source: 'rpc' })).rejects.toThrow(
    'Task edit requires at least one field'
  );
  expect(readTaskCore(db, original.id)).toEqual(original);
  expect(notify).not.toHaveBeenCalled();
});
