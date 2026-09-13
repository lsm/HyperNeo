import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CallContext } from '@hyperneo/shared';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
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
let emit: ReturnType<typeof mock>;
let activeRuns: Set<string>;
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
  taskId = tasks.createTask({ spaceId, title: 'Archivable', description: '' }).id;
  sessions = new SessionRepository(db);
  database = { getDatabase: () => db, notifyChange: mock(() => {}) } as unknown as AppDatabase;
  emit = mock(async () => {});
  activeRuns = new Set<string>();
});
afterEach(() => db.close());

function provider() {
  return createSpaceOperationRegistryProvider(database, jobQueue, {
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    isWorkflowRunActive: (runId: string) => activeRuns.has(runId),
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

function archive(id: string) {
  return { name: 'task.archive', input: { taskId: id } };
}

test('rpc archives a Space task and emits the update once', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(archive(taskId), context)).toMatchObject({ id: taskId });
  expect(tasks.getTask(taskId)?.archivedAt).not.toBeNull();
  expect(emit).toHaveBeenCalledTimes(1);
});

test('an MCP session inside the owning Space may archive', async () => {
  const mcp = createOperationMcpHandler(provider(), () => member('inside', spaceId));
  const result = await mcp(archive(taskId));
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({ id: taskId });
});

test.each([undefined, 'other-space'])(
  'archive is denied for ordinary or cross-Space MCP owner %s',
  async (owner) => {
    const mcp = createOperationMcpHandler(provider(), () => member('outside', owner));
    expect(JSON.parse((await mcp(archive(taskId))).content[0].text)).toBe('archive_denied');
    expect(tasks.getTask(taskId)?.archivedAt).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  }
);

test('rejects an absent task and a standalone task', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(archive('absent'), context)).toBe('task_not_found');
  const standalone = createStandaloneTask(db, { title: 'Loose' }, undefined, () => {});
  expect(await rpc(archive(standalone.id), context)).toBe('task_not_in_space');
  expect(emit).not.toHaveBeenCalled();
});

test('refuses a task whose workflow run is still active, and allows it once the run is not', async () => {
  const runId = 'run-1';
  tasks.updateTask(taskId, { workflowRunId: runId });
  activeRuns.add(runId);
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(archive(taskId), context)).toBe('archive_active_run');
  expect(tasks.getTask(taskId)?.archivedAt).toBeNull();
  activeRuns.delete(runId);
  expect(await rpc(archive(taskId), context)).toMatchObject({ id: taskId });
  expect(tasks.getTask(taskId)?.archivedAt).not.toBeNull();
});

test('task.archive is discoverable through the door', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(
    await rpc({ name: 'operations.describe', input: { name: 'task.archive' } }, context)
  ).toMatchObject({ found: true, name: 'task.archive' });
});
