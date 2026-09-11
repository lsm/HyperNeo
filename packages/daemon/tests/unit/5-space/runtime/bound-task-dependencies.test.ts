import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  createBoundSpaceTaskDependencyEditor,
  isTaskDependenciesOnlyUpdate,
  selectSpaceDependencyCompletion,
} from '../../../../src/lib/space/operations/task-dependencies';

let db: Database;
let spaceId: string;
let tasks: SpaceTaskRepository;
let target: SpaceTask;
let dependency: SpaceTask;
let workflowRunId: string;
let emit: ReturnType<typeof mock>;
let cleanup: ReturnType<typeof mock>;
beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({
    spaceId,
    name: 'Workflow',
    nodes: [{ id: 'node', name: 'Node', agents: [] }],
  });
  workflowRunId = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
  tasks = new SpaceTaskRepository(db);
  target = tasks.createTask({ spaceId, title: 'Task', description: 'Full task' });
  dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  emit = mock(async (_space: string, _task: SpaceTask) => {});
  cleanup = mock(async () => tasks.getTask(target.id));
});
afterEach(() => db.close());
function editor(withRuntime = true, publish = emit) {
  return createBoundSpaceTaskDependencyEditor(spaceId, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: publish,
    ...(withRuntime ? { blockExecution: cleanup } : {}),
  });
}

test('selector admits only a defined dependency list, retaining empty replacements', () => {
  expect(isTaskDependenciesOnlyUpdate({ dependsOn: [] })).toBe(true);
  expect(isTaskDependenciesOnlyUpdate({ dependsOn: undefined })).toBe(false);
  expect(isTaskDependenciesOnlyUpdate({})).toBe(false);
  expect(isTaskDependenciesOnlyUpdate({ dependsOn: [], title: '' })).toBe(false);
  expect(isTaskDependenciesOnlyUpdate({ dependsOn: [], status: undefined })).toBe(false);
});

test('retains full task fields, duplicate lists and scoped manager errors', async () => {
  expect(
    await editor()({ taskId: target.id, dependsOn: [dependency.id, dependency.id] })
  ).toMatchObject({
    spaceId,
    description: 'Full task',
    dependsOn: [dependency.id, dependency.id],
  });
  await expect(editor()({ taskId: 'missing', dependsOn: [] })).rejects.toThrow(
    'Task not found: missing'
  );
  const other = new SpaceRepository(db).createSpace({
    name: 'Other',
    slug: 'other',
    workspacePath: '/other',
  });
  const foreign = tasks.createTask({ spaceId: other.id, title: 'Foreign', description: '' });
  await expect(editor()({ taskId: foreign.id, dependsOn: [] })).rejects.toThrow(
    `Task not found: ${foreign.id}`
  );
  await expect(editor()({ taskId: target.id, dependsOn: [foreign.id] })).rejects.toThrow(
    'Dependency task not found in space'
  );
});

test.each([false, true])(
  'optional runtime determines truthful primary event ownership: %s',
  async (withRuntime) => {
    tasks.updateTask(target.id, { status: 'in_progress', workflowRunId });
    const result = await editor(withRuntime)({ taskId: target.id, dependsOn: [dependency.id] });
    expect(result.status).toBe('blocked');
    expect(cleanup).toHaveBeenCalledTimes(withRuntime ? 1 : 0);
    expect(emit).toHaveBeenCalledTimes(withRuntime ? 0 : 1);
    if (withRuntime)
      expect(cleanup.mock.calls[0]).toEqual([
        spaceId,
        target.id,
        {
          status: 'blocked',
          blockReason: 'dependency_added',
          result: 'Dependency added while task was in progress',
          completedAt: null,
        },
      ]);
  }
);

test('completion selection has no effects until invoked and preserves synchronous publication', async () => {
  const publish = mock(() => {});
  const complete = selectSpaceDependencyCompletion(
    { previous: target, task: target },
    undefined,
    publish
  );
  expect(publish).not.toHaveBeenCalled();
  expect(await complete(spaceId, target)).toBe(target);
  expect(publish).toHaveBeenCalledTimes(1);
});

test.each(['reject', 'clear', 'replace'] as const)(
  'cascade %s preserves cleanup guards',
  async (mode) => {
    tasks.updateTask(target.id, { status: 'in_progress', workflowRunId });
    const dependent = tasks.createTask({
      spaceId,
      title: 'Dependent',
      description: '',
      dependsOn: [target.id],
      status: 'in_progress',
    });
    const replacement = tasks.createTask({ spaceId, title: 'Replacement', description: '' });
    const publish = mock(async (_space: string, task: SpaceTask) => {
      if (task.id !== dependent.id) return;
      if (mode === 'reject') throw new Error('offline');
      await new SpaceTaskManager(db, spaceId).updateTask(target.id, {
        dependsOn: mode === 'clear' ? [] : [replacement.id],
      });
    });
    const result = await editor(true, publish)({ taskId: target.id, dependsOn: [dependency.id] });
    expect(result.dependsOn).toEqual(
      mode === 'clear' ? [] : mode === 'replace' ? [replacement.id] : [dependency.id]
    );
    expect(cleanup).toHaveBeenCalledTimes(mode === 'clear' ? 0 : 1);
    expect(result.status).toBe(mode === 'clear' ? 'open' : 'blocked');
    expect(publish.mock.calls.map((call) => call[1].id)).toEqual(
      mode === 'clear' ? [dependent.id, target.id] : [dependent.id]
    );
  }
);

test('awaited publication keeps the operation pending until supplied effect completes', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let published!: () => void;
  const started = new Promise<void>((resolve) => {
    published = resolve;
  });
  const publish = mock(async () => {
    published();
    await pending;
  });
  let finished = false;
  const result = editor(
    false,
    publish
  )({ taskId: target.id, dependsOn: [] }).then(() => {
    finished = true;
  });
  await started;
  expect(finished).toBe(false);
  release();
  await result;
  expect(finished).toBe(true);
});
