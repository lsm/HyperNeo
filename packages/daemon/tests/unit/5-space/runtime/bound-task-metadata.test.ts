import { expect, mock, test } from 'bun:test';
import type { UpdateSpaceTaskParams } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  createBoundSpaceTaskMetadataEditor,
  isTaskMetadataOnlyUpdate,
} from '../../../../src/lib/space/operations/bound-task-metadata';

test.each([
  [{ title: '' }, true],
  [{ title: '  raw  ', labels: [] }, true],
  [{ description: undefined, priority: 'high' }, true],
  [{}, false],
  [{ title: 'raw', status: undefined }, false],
  [{ title: 'raw', dependsOn: [] }, false],
  [{ title: 'raw', workspacePath: '/repo' }, false],
  [{ title: 'raw', workflowRunId: null }, false],
] as [UpdateSpaceTaskParams, boolean][])(
  'classifies compatible metadata fields %j',
  (params, compatible) => {
    expect(isTaskMetadataOnlyUpdate(params)).toBe(compatible);
  }
);

test('bound editor preserves raw values, full task and manager owner enforcement', async () => {
  const db = new Database(':memory:');
  try {
    createSpaceTables(db);
    const spaces = new SpaceRepository(db);
    const space = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' });
    const other = spaces.createSpace({ name: 'Other', slug: 'other', workspacePath: '/other' });
    const tasks = new SpaceTaskRepository(db);
    const task = tasks.createTask({ spaceId: space.id, title: 'Original', description: 'Keep' });
    const foreign = tasks.createTask({ spaceId: other.id, title: 'Foreign', description: '' });
    const manager = new SpaceTaskManager(db, space.id);
    const cascade = mock(async () => {});
    const edit = createBoundSpaceTaskMetadataEditor(space.id, manager, {
      onCascadedTasks: cascade,
    });
    const edited = await edit({ taskId: task.id, title: '  raw  ', labels: [] }, { source: 'rpc' });
    expect(edited.title).toBe('  raw  ');
    expect(edited.description).toBe('Keep');
    expect(edited.spaceId).toBe(space.id);
    expect(edited.taskNumber).toBe(task.taskNumber);
    expect(edited.status).toBe(task.status);
    expect(cascade).not.toHaveBeenCalled();
    await expect(edit({ taskId: foreign.id, title: 'Wrong' }, { source: 'rpc' })).rejects.toThrow();
    expect(tasks.getTask(foreign.id)?.title).toBe('Foreign');
    await expect(edit({ taskId: 'missing', title: '' }, { source: 'rpc' })).rejects.toThrow();
  } finally {
    db.close();
  }
});
