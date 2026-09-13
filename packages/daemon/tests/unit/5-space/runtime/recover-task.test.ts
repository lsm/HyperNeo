import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CallContext, SpaceTask } from '@hyperneo/shared';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { createSpaceOperationRegistryProvider } from '../../../../src/lib/space/operations/registry';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let database: AppDatabase;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let spaceId: string;
let taskId: string;
let recoverWorkflowTask: ReturnType<typeof mock>;
let emit: ReturnType<typeof mock>;
const jobQueue = {} as JobQueueRepository;
const context = {} as CallContext;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Retryable', description: '' }).id;
  tasks.updateTask(taskId, { status: 'cancelled' });
  sessions = new SessionRepository(db);
  database = { getDatabase: () => db, notifyChange: mock(() => {}) } as unknown as AppDatabase;
  recoverWorkflowTask = mock(async () => tasks.getTask(taskId) as SpaceTask);
  emit = mock(async () => {});
});
afterEach(() => db.close());

function provider() {
  return createSpaceOperationRegistryProvider(database, jobQueue, {
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    recoverWorkflowTask,
    taskRepo: tasks,
    notifyStandalone: () => database.notifyChange('space_tasks'),
    emitTaskUpdated: emit,
    emitTaskCreated: mock(async () => {}),
    getSpace: (id: string) => new SpaceRepository(db).getSpace(id),
    validateDefaultTaskWorkspace: async () => null,
    blockExecution: async () => {
      throw new Error('Unexpected workflow cleanup');
    },
    requiresPostApprovalOwner: () => false,
    completionGate: async () => ({ ok: true as const }),
  } as unknown as Parameters<typeof createSpaceOperationRegistryProvider>[2]);
}

function endedMember(id: string, owner: string) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      status: 'archived',
      context: { spaceId: owner },
    },
    { enforceWorkspaceOwnership: false }
  );
  return { sessionId: id };
}

function member(id: string, owner?: string) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      context: owner ? { spaceId: owner } : {},
    },
    { enforceWorkspaceOwnership: false }
  );
  return { sessionId: id };
}

function attachRun(status: 'blocked' | 'in_progress') {
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Workflow' });
  const runId = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
  tasks.updateTask(taskId, { workflowRunId: runId, status });
  return runId;
}

function recover(id: string, description?: string) {
  return {
    name: 'task.recover',
    input: description ? { taskId: id, description } : { taskId: id },
  };
}

test('a plain task is retried directly, without the workflow recovery path', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(recover(taskId), context)).toMatchObject({ id: taskId });
  expect(recoverWorkflowTask).not.toHaveBeenCalled();
});

test('a workflow-backed task is recovered through its run at the routed status', async () => {
  attachRun('blocked');
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  await rpc(recover(taskId, 'try again'), context);
  expect(recoverWorkflowTask).toHaveBeenCalledWith(spaceId, taskId, 'open', 'try again');
});

test('a workflow recovery that refuses reports recovery_failed', async () => {
  attachRun('blocked');
  recoverWorkflowTask = mock(async () => 'no workflow run to recover');
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(recover(taskId), context)).toBe('recovery_failed');
});

test.each([undefined, 'other-space'])(
  'recovery is denied for ordinary or cross-Space MCP owner %s',
  async (owner) => {
    const mcp = createOperationMcpHandler(provider(), () => member('outside', owner));
    expect(JSON.parse((await mcp(recover(taskId))).content[0].text)).toBe('recovery_denied');
  }
);

test('an MCP session inside the owning Space may recover', async () => {
  const mcp = createOperationMcpHandler(provider(), () => member('inside', spaceId));
  const result = await mcp(recover(taskId));
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({ id: taskId });
});

test('rejects an absent task, a standalone task and a non-retryable workflow status', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(recover('absent'), context)).toBe('task_not_found');
  const standalone = createStandaloneTask(db, { title: 'Loose' }, undefined, () => {});
  expect(await rpc(recover(standalone.id), context)).toBe('task_not_in_space');
  attachRun('in_progress');
  expect(await rpc(recover(taskId), context)).toBe('status_not_retryable');
});

test('an MCP session in the owning Space that is no longer active is denied', async () => {
  const mcp = createOperationMcpHandler(provider(), () => endedMember('stale', spaceId));
  expect(JSON.parse((await mcp(recover(taskId))).content[0].text)).toBe('recovery_denied');
});

test('plain recovery publishes space.task.updated so other clients refresh', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  await rpc(recover(taskId), context);
  expect(recoverWorkflowTask).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0]?.[0]).toBe(spaceId);
  expect(emit.mock.calls[0]?.[1]).toMatchObject({ id: taskId });
});

test('workflow recovery does not double-publish from this operation', async () => {
  attachRun('blocked');
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  await rpc(recover(taskId), context);
  expect(recoverWorkflowTask).toHaveBeenCalledTimes(1);
  expect(emit).not.toHaveBeenCalled();
});

test('a plain task in a non-retryable status rejects instead of throwing', async () => {
  tasks.updateTask(taskId, { status: 'in_progress' });
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(recover(taskId), context)).toBe('status_not_retryable');
  expect(emit).not.toHaveBeenCalled();
});

test('task.recover is discoverable through the door', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(
    await rpc({ name: 'operations.describe', input: { name: 'task.recover' } }, context)
  ).toMatchObject({ found: true, name: 'task.recover' });
});
