import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import { createSpaceTaskDependencyEditor } from '../../../../src/lib/space/operations/task-dependencies';

let db: Database;
let spaceId: string;
let tasks: SpaceTaskRepository;
let emit: ReturnType<typeof mock>;
let notify: ReturnType<typeof mock>;
let cleanup: ReturnType<typeof mock>;
let target: SpaceTask;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  target = tasks.createTask({ spaceId, title: 'Task', description: '' });
  emit = mock(async (_spaceId: string, _task: SpaceTask) => {});
  notify = mock(() => {});
  cleanup = mock(async () => null);
});
afterEach(() => db.close());
function editor(extra = {}) {
  return createSpaceTaskDependencyEditor({
    db,
    getSession: () => null,
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    taskRepo: tasks,
    emitTaskUpdated: emit,
    notifyStandalone: notify,
    blockExecution: cleanup,
    ...extra,
  });
}
function dependency(status: SpaceTask['status'] = 'open') {
  return tasks.createTask({ spaceId, title: 'Dependency', description: '', status });
}
const rpc = { source: 'rpc' } as const;

test('Space duplicates remain accepted while standalone duplicates retain rejection codes', async () => {
  const dep = dependency();
  expect(await editor()({ taskId: target.id, dependsOn: [dep.id, dep.id] }, rpc)).toMatchObject({
    dependsOn: [dep.id, dep.id],
  });
  expect(emit).toHaveBeenCalledTimes(1);
  const own = createStandaloneTask(db, { title: 'Standalone' }, undefined, () => {});
  const other = createStandaloneTask(db, { title: 'Standalone dependency' }, undefined, () => {});
  const replace = editor();
  expect(await replace({ taskId: own.id, dependsOn: [other.id, other.id] }, rpc)).toBe(
    'duplicate_dependency'
  );
  expect(notify).not.toHaveBeenCalled();
  expect(await replace({ taskId: own.id, dependsOn: [other.id] }, rpc)).toMatchObject({
    dependsOn: [other.id],
  });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledTimes(1);
});

test('missing owner has no writes or events', async () => {
  expect(await editor()({ taskId: 'missing', dependsOn: [] }, rpc)).toBeNull();
  expect(emit).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

test.each([null, 'other', 'matching'])('uses persisted session scope %s', async (scope) => {
  const session =
    scope === null
      ? null
      : {
          ...createTestSession('caller'),
          type: 'space_chat' as const,
          context: { spaceId: scope === 'matching' ? spaceId : 'other' },
        };
  const replace = editor({ getSession: () => session });
  const result = replace(
    { taskId: target.id, dependsOn: [] },
    { source: 'mcp', sessionId: 'caller' }
  );
  if (scope === 'matching') {
    expect(await result).toMatchObject({ id: target.id });
    expect(emit).toHaveBeenCalledTimes(1);
  } else {
    await expect(result).rejects.toThrow(
      'Task dependency updates require a session in the owning Space'
    );
    expect(emit).not.toHaveBeenCalled();
  }
});

test('Space validation rejects missing, self, cyclic and cross-owner edges without updates', async () => {
  const dep = dependency();
  tasks.updateTask(dep.id, { dependsOn: [target.id] });
  const foreign = createStandaloneTask(db, { title: 'Foreign' }, undefined, () => {});
  for (const [id, message] of [
    ['missing', 'not found in space'],
    [target.id, 'cannot depend on itself'],
    [dep.id, 'circular dependency'],
    [foreign.id, 'not found in space'],
  ]) {
    await expect(editor()({ taskId: target.id, dependsOn: [id] }, rpc)).rejects.toThrow(message);
  }
  expect(tasks.getTask(target.id)?.dependsOn).toEqual([]);
  expect(emit).not.toHaveBeenCalled();
});

test('clearing dependencies reopens a dependency-blocked task without execution cleanup', async () => {
  const dep = dependency();
  tasks.updateTask(target.id, {
    status: 'blocked',
    blockReason: 'dependency_added',
    dependsOn: [dep.id],
  });
  expect(await editor()({ taskId: target.id, dependsOn: [] }, rpc)).toMatchObject({
    status: 'open',
    dependsOn: [],
  });
  expect(cleanup).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledTimes(1);
});

test.each([
  { met: false, cascade: 'normal' },
  { met: true, cascade: 'normal' },
  { met: false, cascade: 'reject' },
  { met: false, cascade: 'replace' },
  { met: false, cascade: 'clear' },
])(
  'real workflow cleanup honors completion=$met and cascade=$cascade',
  async ({ met, cascade }) => {
    const workflows = new SpaceWorkflowRepository(db);
    const workflow = workflows.createWorkflow({
      spaceId,
      name: 'Workflow',
      nodes: [{ id: 'node', name: 'Node', agents: [] }],
    });
    const runs = new SpaceWorkflowRunRepository(db);
    const run = runs.createRun({ spaceId, workflowId: workflow.id, title: 'Run' });
    runs.updateStatusUnchecked(run.id, 'in_progress');
    const nodes = new NodeExecutionRepository(db);
    const node = nodes.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'node',
      agentName: 'agent',
      status: 'in_progress',
      agentSessionId: 'live',
    });
    tasks.updateTask(target.id, { status: 'in_progress', workflowRunId: run.id });
    const dependent = dependency('in_progress');
    tasks.updateTask(dependent.id, { dependsOn: [target.id] });
    const dep = dependency(met ? 'done' : 'open');
    const newer = dependency();
    emit.mockImplementation(async (_spaceId: string, task: SpaceTask) => {
      if (task.id !== dependent.id) return;
      if (cascade === 'reject') throw new Error('subscriber failed');
      if (cascade === 'replace' || cascade === 'clear') {
        await new SpaceTaskManager(db, spaceId).updateTask(target.id, {
          dependsOn: cascade === 'clear' ? [] : [newer.id],
        });
      }
    });
    const cancel = mock(() => {});
    const runtime = new SpaceRuntime({
      db,
      spaceManager: new SpaceManager(db),
      spaceWorkflowManager: new SpaceWorkflowManager(workflows),
      taskRepo: tasks,
      workflowRunRepo: runs,
      nodeExecutionRepo: nodes,
      taskAgentManager: { cancelBySessionId: cancel } as unknown as TaskAgentManager,
      onTaskUpdated: ({ spaceId, task }) => emit(spaceId, task),
    });
    const blockExecution = mock(runtime.blockWorkflowBackedTask.bind(runtime));
    const result = await editor({ blockExecution })(
      { taskId: target.id, dependsOn: [dep.id] },
      rpc
    );
    const blocked = !met && cascade !== 'clear';
    const expectedDependencies =
      cascade === 'clear' ? [] : [cascade === 'replace' ? newer.id : dep.id];
    expect(result).toMatchObject({
      status: cascade === 'clear' ? 'open' : met ? 'in_progress' : 'blocked',
      dependsOn: expectedDependencies,
    });
    expect(tasks.getTask(target.id)?.dependsOn).toEqual(expectedDependencies);
    expect(runs.getRun(run.id)?.status).toBe(blocked ? 'blocked' : 'in_progress');
    expect(nodes.getById(node.id)).toMatchObject({
      status: blocked ? 'cancelled' : 'in_progress',
      agentSessionId: blocked ? null : 'live',
    });
    expect(tasks.getTask(dependent.id)?.status).toBe(met ? 'in_progress' : 'blocked');
    expect(emit.mock.calls.map((args) => args[1].id)).toEqual(
      met ? [target.id] : [dependent.id, target.id]
    );
    expect(cancel).toHaveBeenCalledTimes(blocked ? 1 : 0);
    expect(blockExecution).toHaveBeenCalledTimes(blocked ? 1 : 0);
    if (blocked) expect(blockExecution.mock.calls[0][2]).not.toHaveProperty('dependsOn');
    if (!met) expect(tasks.getTask(target.id)?.completedAt).toBeNull();
  }
);
