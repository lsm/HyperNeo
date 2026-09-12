import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  createSpaceTransitionTaskOperation,
  type SpaceTransitionTaskDependencies,
} from '../../../../src/lib/space/operations/transition-task';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { createTestSession } from '../../../helpers/database';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let spaces: SpaceRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let attempts: DirectTaskExecutionRepository;
let spaceId: string;
let emitTaskUpdated: ReturnType<typeof mock>;
let notifyStandalone: ReturnType<typeof mock>;
let isWorkflowRunActive: ReturnType<typeof mock>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaces = new SpaceRepository(db);
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  emitTaskUpdated = mock(async () => {});
  notifyStandalone = mock(() => {});
  isWorkflowRunActive = mock(() => false);
});
afterEach(() => db.close());

const rpc = { source: 'rpc' as const };

function createWorkflowRun() {
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Workflow' });
  return new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  });
}

function worker(id: string, memberSpaceId?: string) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      context: memberSpaceId ? { spaceId: memberSpaceId } : {},
    },
    { enforceWorkspaceOwnership: false }
  );
  return { source: 'mcp' as const, sessionId: id };
}

function deps(
  overrides: Partial<SpaceTransitionTaskDependencies> = {}
): SpaceTransitionTaskDependencies {
  return {
    db,
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    notifyStandalone,
    emitTaskUpdated,
    isWorkflowRunActive,
    ...overrides,
  };
}

function invoke(
  input: unknown,
  caller: { source: 'rpc' | 'mcp' | 'internal'; sessionId?: string },
  overrides?: Partial<SpaceTransitionTaskDependencies>
) {
  const registry = createOperationRegistry([createSpaceTransitionTaskOperation(deps(overrides))]);
  return invokeOperation(registry, 'task.transition', input, caller);
}

test('a standalone task passes through to the plain status writer', async () => {
  const task = createStandaloneTask(db, { title: 'Solo' }, undefined, () => {});
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc);
  expect(result).toMatchObject({
    kind: 'completed',
    value: { id: task.id, status: 'in_progress' },
  });
  expect(notifyStandalone).toHaveBeenCalledTimes(1);
});

test('a missing task resolves to null', async () => {
  expect(await invoke({ taskId: 'missing', status: 'open' }, rpc)).toEqual({
    kind: 'completed',
    value: null,
  });
});

test('an mcp session in another Space gets null and makes no write', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const caller = worker('outsider', 'other-space');
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, caller);
  expect(result).toEqual({ kind: 'completed', value: null });
  expect(tasks.getTask(task.id)?.status).toBe('open');
  expect(emitTaskUpdated).not.toHaveBeenCalled();
});

test('an mcp session in the owning Space writes open to in_progress', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const caller = worker('member', spaceId);
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, caller);
  expect(result).toMatchObject({
    kind: 'completed',
    value: { id: task.id, status: 'in_progress' },
  });
  expect(tasks.getTask(task.id)?.status).toBe('in_progress');
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
});

test('rpc can move review to done with human approval', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { status: 'review' });
  const result = await invoke({ taskId: task.id, status: 'done' }, rpc);
  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id, status: 'done' } });
  expect(tasks.getTask(task.id)?.approvalSource).toBe('human');
});

test('mcp cannot move review to done directly', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { status: 'review' });
  const caller = worker('member', spaceId);
  const result = await invoke({ taskId: task.id, status: 'done' }, caller);
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
  expect(tasks.getTask(task.id)?.status).toBe('review');
});

test.each(['review', 'approved', 'rate_limited'] as const)(
  'requesting %s directly is unsupported',
  async (status) => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    expect(await invoke({ taskId: task.id, status }, rpc)).toEqual({
      kind: 'completed',
      value: 'unsupported_status',
    });
  }
);

test('archiving a task with an active workflow run is unsupported', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { workflowRunId: createWorkflowRun().id });
  isWorkflowRunActive.mockImplementation(() => true);
  expect(await invoke({ taskId: task.id, status: 'archived' }, rpc)).toEqual({
    kind: 'completed',
    value: 'unsupported_status',
  });
});

test('archiving a task with an inactive workflow run writes', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { workflowRunId: createWorkflowRun().id });
  isWorkflowRunActive.mockImplementation(() => false);
  const result = await invoke({ taskId: task.id, status: 'archived' }, rpc);
  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id, status: 'archived' } });
});

test('a workflow task moving from in_progress to open needs the runtime stop executor', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { status: 'in_progress', workflowRunId: createWorkflowRun().id });
  const result = await invoke({ taskId: task.id, status: 'open' }, rpc);
  expect(result).toMatchObject({
    kind: 'failed',
    code: 'execution_failed',
    message: expect.stringContaining('stop_for_status'),
  });
});

test('a result is rejected unless the target status is done', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const result = await invoke({ taskId: task.id, status: 'in_progress', result: 'partial' }, rpc);
  expect(result).toEqual({ kind: 'completed', value: 'result_requires_done' });
});

test('a task with a reserved direct attempt is unsupported', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  attempts.select(task.id);
  attempts.claim(task.id, 'attempt', 'worker');
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc);
  expect(result).toEqual({ kind: 'completed', value: 'unsupported_status' });
});

test('a stale-status guard failure surfaces as invalid_transition', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const staleManager: Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'> = {
    getTask: async (id) => tasks.getTask(id),
    setTaskStatus: async () => {
      throw new Error(`Task ${task.id} is no longer 'open'`);
    },
  };
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc, {
    getTaskManager: () => staleManager,
  });
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
});

test('a workflow attached after the decision cannot be smuggled through the atomic write', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const run = createWorkflowRun();
  const racingManager: Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'> = {
    getTask: async (id) => {
      const snapshot = await tasks.getTask(id);
      tasks.updateTask(id, { workflowRunId: run.id });
      return snapshot;
    },
    setTaskStatus: (id, status, options) => new SpaceTaskManager(db, spaceId).setTaskStatus(id, status, options),
  };
  const result = await invoke({ taskId: task.id, status: 'archived' }, rpc, {
    getTaskManager: () => racingManager,
  });
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
  expect(tasks.getTask(task.id)?.status).toBe('open');
});

test('a rejecting emitTaskUpdated still returns the updated task', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  emitTaskUpdated.mockImplementation(async () => {
    throw new Error('delivery down');
  });
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc);
  expect(result).toMatchObject({
    kind: 'completed',
    value: { id: task.id, status: 'in_progress' },
  });
});
