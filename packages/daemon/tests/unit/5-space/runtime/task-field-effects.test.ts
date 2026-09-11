import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  createSpaceTaskFieldUpdater,
  selectSpaceTaskFieldWrite,
  selectSpaceTaskFieldCompletion,
} from '../../../../src/lib/space/operations/task-field-effects';

let db: Database;
let spaceId: string;
let tasks: SpaceTaskRepository;
let manager: SpaceTaskManager;
let target: SpaceTask;
let dependency: SpaceTask;
let runId: string;
let replacementRunId: string;
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
  const runs = new SpaceWorkflowRunRepository(db);
  runId = runs.createRun({ spaceId, workflowId: workflow.id, title: 'Run' }).id;
  replacementRunId = runs.createRun({ spaceId, workflowId: workflow.id, title: 'Replacement' }).id;
  tasks = new SpaceTaskRepository(db);
  manager = new SpaceTaskManager(db, spaceId);
  target = tasks.createTask({ spaceId, title: 'Original', description: '' });
  dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  emit = mock(async (_space: string, _task: SpaceTask) => {});
  cleanup = mock(async (_space: string, taskId: string, fields: UpdateSpaceTaskParams) =>
    tasks.updateTask(taskId, fields)
  );
});
afterEach(() => db.close());
function updater(withRuntime = true, publish = emit) {
  return createSpaceTaskFieldUpdater({
    getTaskManager: () => manager,
    emitTaskUpdated: publish,
    ...(withRuntime ? { blockExecution: cleanup } : {}),
  });
}

test.each([false, true])(
  'pure pointer selection requires executor=%s and keeps field presence',
  (hasExecutor) => {
    const previous = { ...target, status: 'in_progress' as const, workflowRunId: runId };
    const fields = {
      title: '',
      dependsOn: [dependency.id],
      workflowRunId: undefined,
      taskAgentSessionId: null,
    };
    const selected = selectSpaceTaskFieldWrite(previous, fields, hasExecutor);
    expect(selected.fields).toEqual(
      hasExecutor ? { title: '', dependsOn: [dependency.id] } : fields
    );
    expect(selected.deferred).toEqual(
      hasExecutor ? { workflowRunId: undefined, taskAgentSessionId: null } : {}
    );
    expect(fields).toHaveProperty('workflowRunId');
    expect(
      selectSpaceTaskFieldWrite(previous, { ...fields, dependsOn: [] }, hasExecutor).deferred
    ).toEqual({});
  }
);

test.each(['unmet', 'met', 'no-runtime'] as const)(
  'mixed %s writes fields together and protects old execution pointers',
  async (mode) => {
    tasks.updateTask(target.id, { status: 'in_progress', workflowRunId: runId });
    if (mode === 'met') tasks.updateTask(dependency.id, { status: 'done' });
    const writes: UpdateSpaceTaskParams[] = [];
    const update = manager.updateTask.bind(manager);
    manager.updateTask = async (id, fields, options) => {
      writes.push(fields);
      return update(id, fields, options);
    };
    const outcome = await updater(mode !== 'no-runtime')(spaceId, target.id, {
      title: 'Edited',
      dependsOn: [dependency.id, dependency.id],
      workflowRunId: replacementRunId,
    });
    expect(outcome.task.title).toBe('Edited');
    expect(outcome.task.dependsOn).toEqual([dependency.id, dependency.id]);
    expect(outcome.handledByRuntime).toBe(mode === 'unmet');
    expect(writes[0]).toEqual({
      title: 'Edited',
      dependsOn: [dependency.id, dependency.id],
      workflowRunId: replacementRunId,
    });
    expect(writes).toHaveLength(mode === 'met' ? 2 : 1);
    expect(outcome.task.workflowRunId).toBe(mode === 'unmet' ? runId : replacementRunId);
    expect(emit).not.toHaveBeenCalled();
    if (mode === 'unmet')
      expect(cleanup.mock.calls[0][2]).toEqual({
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
      });
  }
);

test('manager graph rejection does not partially persist metadata', async () => {
  await expect(
    updater()(spaceId, target.id, { title: 'Must not persist', dependsOn: ['missing'] })
  ).rejects.toThrow('Dependency task not found in space');
  expect(tasks.getTask(target.id)?.title).toBe('Original');
  expect(emit).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

test('caller performs recovery first; shared field update does not repeat transition', async () => {
  await manager.setTaskStatus(target.id, 'in_progress');
  tasks.updateTask(target.id, { workflowRunId: runId });
  const setStatus = mock(manager.setTaskStatus.bind(manager));
  manager.setTaskStatus = setStatus;
  const outcome = await updater()(spaceId, target.id, {
    title: 'After recovery',
    dependsOn: [dependency.id],
  });
  expect(outcome.handledByRuntime).toBe(true);
  expect(setStatus).toHaveBeenCalledTimes(1);
  expect(setStatus.mock.calls[0][1]).toBe('blocked');
});

test.each(['clear', 'replace', 'reject'] as const)(
  'mixed cascade %s uses fresh state without replaying metadata',
  async (mode) => {
    tasks.updateTask(target.id, { status: 'in_progress', workflowRunId: runId });
    const dependent = tasks.createTask({
      spaceId,
      title: 'Dependent',
      description: '',
      dependsOn: [target.id],
      status: 'in_progress',
    });
    const publish = mock(async (_space: string, task: SpaceTask) => {
      if (task.id !== dependent.id) return;
      if (mode === 'reject') throw new Error('offline');
      await manager.updateTask(target.id, {
        title: 'Concurrent',
        ...(mode === 'clear' ? { dependsOn: [] } : {}),
      });
    });
    const outcome = await updater(true, publish)(spaceId, target.id, {
      title: 'Requested',
      dependsOn: [dependency.id],
    });
    expect(outcome.handledByRuntime).toBe(mode !== 'clear');
    expect(outcome.task.title).toBe(mode === 'reject' ? 'Requested' : 'Concurrent');
    expect(outcome.task.dependsOn).toEqual(mode === 'clear' ? [] : [dependency.id]);
    expect(publish).toHaveBeenCalledTimes(1);
  }
);

test('pure completion selection defers pointer write and reports caller event ownership', async () => {
  const deferred = { workflowRunId: replacementRunId };
  const update = mock(async () => ({ ...target, ...deferred }));
  const complete = selectSpaceTaskFieldCompletion(
    { previous: target, task: target, deferred },
    undefined,
    () => ({ getTask: manager.getTask.bind(manager), updateTask: update })
  );
  expect(update).not.toHaveBeenCalled();
  expect(await complete(spaceId)).toMatchObject({
    task: { workflowRunId: replacementRunId },
    handledByRuntime: false,
  });
  expect(update).toHaveBeenCalledWith(target.id, deferred);
});

test('task starting during validation preserves its actual run and session for cleanup', async () => {
  const get = manager.getTask.bind(manager);
  let started = false;
  manager.getTask = async (id) => {
    const task = await get(id);
    if (id === dependency.id && !started) {
      started = true;
      tasks.updateTask(target.id, {
        status: 'in_progress',
        workflowRunId: runId,
        taskAgentSessionId: 'newly-started',
      });
    }
    return task;
  };
  let atCleanup: SpaceTask | null = null;
  cleanup.mockImplementation(
    async (_space: string, taskId: string, fields: UpdateSpaceTaskParams) => {
      atCleanup = tasks.getTask(taskId);
      return tasks.updateTask(taskId, fields);
    }
  );
  const outcome = await updater()(spaceId, target.id, {
    title: 'Edited',
    dependsOn: [dependency.id],
    workflowRunId: replacementRunId,
    taskAgentSessionId: null,
  });
  expect(atCleanup).toMatchObject({
    workflowRunId: runId,
    taskAgentSessionId: 'newly-started',
    status: 'blocked',
  });
  expect(outcome.handledByRuntime).toBe(true);
  expect(cleanup).toHaveBeenCalledTimes(1);
});
