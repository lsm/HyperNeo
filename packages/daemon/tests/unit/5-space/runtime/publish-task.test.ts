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
let draftId: string;
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
  draftId = tasks.createTask({ spaceId, title: 'Draft', description: '', status: 'draft' }).id;
  sessions = new SessionRepository(db);
  database = { getDatabase: () => db, notifyChange: mock(() => {}) } as unknown as AppDatabase;
  emit = mock(async () => {});
});
afterEach(() => db.close());

function provider() {
  return createSpaceOperationRegistryProvider(database, jobQueue, {
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
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

function publish(taskId: string) {
  return { name: 'task.publish', input: { taskId } };
}

test('rpc publishes a draft Space task and emits the update once', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(publish(draftId), context)).toMatchObject({ id: draftId, status: 'open' });
  expect(tasks.getTask(draftId)?.status).toBe('open');
  expect(emit).toHaveBeenCalledTimes(1);
});

test('an MCP session inside the owning Space may publish', async () => {
  const mcp = createOperationMcpHandler(provider(), () => member('inside', spaceId));
  const result = await mcp(publish(draftId));
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({ id: draftId, status: 'open' });
});

test.each([undefined, 'other-space'])(
  'publish is denied for ordinary or cross-Space MCP owner %s',
  async (owner) => {
    const mcp = createOperationMcpHandler(provider(), () => member('outside', owner));
    expect(JSON.parse((await mcp(publish(draftId))).content[0].text)).toBe('publish_denied');
    expect(tasks.getTask(draftId)?.status).toBe('draft');
    expect(emit).not.toHaveBeenCalled();
  }
);

test('rejects an absent task, a standalone task and a non-draft task', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(await rpc(publish('absent'), context)).toBe('task_not_found');
  const standalone = createStandaloneTask(db, { title: 'Loose' }, undefined, () => {});
  expect(await rpc(publish(standalone.id), context)).toBe('task_not_in_space');
  const open = tasks.createTask({ spaceId, title: 'Open', description: '' });
  expect(await rpc(publish(open.id), context)).toBe('not_draft');
  expect(emit).not.toHaveBeenCalled();
});

test('losing a concurrent publish reports not_draft, not execution_failed', async () => {
  const rpc = createOperationRpcHandler(
    createSpaceOperationRegistryProvider(database, jobQueue, {
      getSession: (id: string) => sessions.getSession(id),
      getTaskManager: () => ({
        publishTask: async () => {
          throw new Error('Only draft tasks can be published');
        },
      }),
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
    } as unknown as Parameters<typeof createSpaceOperationRegistryProvider>[2]),
    () => ({})
  );
  expect(await rpc(publish(draftId), context)).toBe('not_draft');
  expect(emit).not.toHaveBeenCalled();
});

test('an MCP session in the owning Space that is no longer active is denied', async () => {
  const mcp = createOperationMcpHandler(provider(), () => endedMember('stale', spaceId));
  expect(JSON.parse((await mcp(publish(draftId))).content[0].text)).toBe('publish_denied');
  expect(tasks.getTask(draftId)?.status).toBe('draft');
  expect(emit).not.toHaveBeenCalled();
});

test('task.publish is discoverable through the door', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  expect(
    await rpc({ name: 'operations.describe', input: { name: 'task.publish' } }, context)
  ).toMatchObject({ found: true, name: 'task.publish' });
});
