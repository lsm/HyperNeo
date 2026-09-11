import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CallContext } from '@hyperneo/shared';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { createSpaceOperationRegistryProvider } from '../../../../src/lib/space/operations/registry';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';

let db: Database;
let database: AppDatabase;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let spaceId: string;
let taskId: string;
const jobQueue = {} as JobQueueRepository;
const context = {} as CallContext;
let emit: ReturnType<typeof mock>;
let getDatabase: ReturnType<typeof mock>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Original', description: '' }).id;
  sessions = new SessionRepository(db);
  getDatabase = mock(() => db);
  database = { getDatabase, notifyChange: mock(() => {}) } as unknown as AppDatabase;
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
  });
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
function update(title: string, id = taskId) {
  return { name: 'task.update', input: { taskId: id, title } };
}

test('provider construction and discovery stay lazy and cache one registry', async () => {
  const getRegistry = provider();
  expect(getDatabase).not.toHaveBeenCalled();
  const registry = getRegistry();
  expect(getRegistry()).toBe(registry);
  const rpc = createOperationRpcHandler(getRegistry, () => ({}));
  expect(
    await rpc({ name: 'operations.describe', input: { name: 'task.update' } }, context)
  ).toMatchObject({ found: true, name: 'task.update' });
  expect(getDatabase).not.toHaveBeenCalled();
});

test('cached and new MCP handlers adopt the same Space catalog as RPC', async () => {
  const caller = member('member', spaceId);
  let registry = createDatabaseOperationCatalog(database, jobQueue);
  const getRegistry = () => registry;
  const mcp = createOperationMcpHandler(getRegistry, () => caller);
  expect(JSON.parse((await mcp(update('Before'))).content[0].text)).toBeNull();
  registry = provider()();
  const rpc = createOperationRpcHandler(getRegistry, () => ({}));
  const updated = await mcp(update('Agent'));
  expect(updated.isError).not.toBe(true);
  expect(JSON.parse(updated.content[0].text)).toMatchObject({ id: taskId, title: 'Agent' });
  expect(emit).toHaveBeenCalledTimes(1);
  expect(await rpc(update('Human'), context)).toMatchObject({ id: taskId, title: 'Human' });
  expect(emit).toHaveBeenCalledTimes(2);
  const laterMcp = createOperationMcpHandler(getRegistry, () => caller);
  expect((await laterMcp(update('Later'))).isError).not.toBe(true);
  expect(tasks.getTask(taskId)?.title).toBe('Later');
  expect(emit).toHaveBeenCalledTimes(3);
});

test.each([undefined, 'other-space'])(
  'rejects ordinary or cross-Space MCP owner %s',
  async (owner) => {
    const caller = member('caller', owner);
    const mcp = createOperationMcpHandler(provider(), () => caller);
    const denied = await mcp(update('Denied'));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text)).toMatchObject({
      code: 'execution_failed',
      message: expect.stringContaining('owning Space'),
    });
    expect(tasks.getTask(taskId)?.title).toBe('Original');
    expect(emit).not.toHaveBeenCalled();
    const task = createStandaloneTask(db, { title: 'Standalone' }, undefined, () => {});
    const edited = await mcp(update('Allowed', task.id));
    expect(edited.isError).not.toBe(true);
    expect(JSON.parse(edited.content[0].text)).toMatchObject({ id: task.id, title: 'Allowed' });
    expect(database.notifyChange).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  }
);
