import type { OwnedPendingCompletionDependencies } from '../../../../src/lib/space/operations/owned-pending-completion';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
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

function provider(extra = {}, pendingCompletion?: OwnedPendingCompletionDependencies) {
  return createSpaceOperationRegistryProvider(
    database,
    jobQueue,
    {
      getSession: (id) => sessions.getSession(id),
      getTaskManager: (id) => new SpaceTaskManager(db, id),
      taskRepo: tasks,
      notifyStandalone: () => database.notifyChange('space_tasks'),
      emitTaskUpdated: emit,
      blockExecution: async () => {
        throw new Error('Unexpected workflow cleanup');
      },
      ...extra,
    },
    pendingCompletion
  );
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

function replaceDependencies(id: string, dependsOn: string[]) {
  return { name: 'task.dependencies.set', input: { taskId: id, dependsOn } };
}

test('cached and future MCP handlers share dependency operations with RPC', async () => {
  const caller = member('dependency-member', spaceId);
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  let registry = createDatabaseOperationCatalog(database, jobQueue);
  const getRegistry = () => registry;
  const mcp = createOperationMcpHandler(getRegistry, () => caller);
  const request = replaceDependencies(taskId, [dependency.id, dependency.id]);
  expect(JSON.parse((await mcp(request)).content[0].text)).toBeNull();
  registry = provider()();
  const rpc = createOperationRpcHandler(getRegistry, () => ({}));
  const first = await mcp(request);
  expect(first.isError).not.toBe(true);
  expect(JSON.parse(first.content[0].text)).toMatchObject({
    id: taskId,
    dependsOn: [dependency.id, dependency.id],
  });
  expect(await rpc(replaceDependencies(taskId, []), context)).toMatchObject({ dependsOn: [] });
  const later = createOperationMcpHandler(getRegistry, () => caller);
  expect((await later(replaceDependencies(taskId, [dependency.id]))).isError).not.toBe(true);
  expect(tasks.getTask(taskId)?.dependsOn).toEqual([dependency.id]);
  expect(emit).toHaveBeenCalledTimes(3);
});

test.each([undefined, 'other-space'])(
  'dependency operations enforce persisted MCP scope %s',
  async (owner) => {
    const caller = member('dependency-caller', owner);
    const mcp = createOperationMcpHandler(provider(), () => caller);
    const denied = await mcp(replaceDependencies(taskId, []));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text)).toMatchObject({
      code: 'execution_failed',
      message: expect.stringContaining('owning Space'),
    });
    expect(tasks.getTask(taskId)?.dependsOn).toEqual([]);
    const a = createStandaloneTask(db, { title: 'Standalone' }, undefined, () => {});
    const b = createStandaloneTask(db, { title: 'Dependency' }, undefined, () => {});
    expect(JSON.parse((await mcp(replaceDependencies(a.id, [b.id, b.id]))).content[0].text)).toBe(
      'duplicate_dependency'
    );
    expect(JSON.parse((await mcp(replaceDependencies(a.id, [taskId]))).content[0].text)).toBe(
      'dependency_not_found'
    );
    expect((await mcp(replaceDependencies(a.id, [b.id]))).isError).not.toBe(true);
    expect(database.notifyChange).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  }
);

test('dependency discovery remains lazy and malformed requests never mutate', async () => {
  const rpc = createOperationRpcHandler(provider(), () => ({}));
  const description = await rpc(
    { name: 'operations.describe', input: { name: 'task.dependencies.set' } },
    context
  );
  expect(description).toMatchObject({
    found: true,
    description: expect.stringContaining('task-owner rules'),
  });
  expect(getDatabase).not.toHaveBeenCalled();
  await expect(
    rpc(
      { name: 'task.dependencies.set', input: { taskId, dependsOn: [], status: 'done' } },
      context
    )
  ).rejects.toThrow();
  expect(getDatabase).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});

test.each(['rpc', 'mcp'] as const)(
  'shared %s dependency calls await cleanup without duplicate events',
  async (source) => {
    const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Workflow' });
    const run = new SpaceWorkflowRunRepository(db).createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Run',
    });
    tasks.updateTask(taskId, { workflowRunId: run.id, status: 'in_progress' });
    const dep = tasks.createTask({ spaceId, title: 'Unmet', description: '' });
    const blockExecution = mock(
      async (
        owner: string,
        id: string,
        params: import('@hyperneo/shared').UpdateSpaceTaskParams
      ) => {
        const updated = tasks.updateTask(id, params)!;
        await emit(owner, updated);
        return updated;
      }
    );
    const getRegistry = provider({ blockExecution });
    const caller = member('active-member', spaceId);
    const request = replaceDependencies(taskId, [dep.id]);
    const result =
      source === 'rpc'
        ? await createOperationRpcHandler(getRegistry, () => ({}))(request, context)
        : JSON.parse(
            (await createOperationMcpHandler(getRegistry, () => caller)(request)).content[0].text
          );
    expect(result).toMatchObject({ id: taskId, status: 'blocked', dependsOn: [dep.id] });
    expect(blockExecution).toHaveBeenCalledTimes(1);
    expect(blockExecution).toHaveBeenCalledWith(spaceId, taskId, {
      status: 'blocked',
      blockReason: 'dependency_added',
      result: 'Dependency added while task was in progress',
      completedAt: null,
    });
    expect(emit).toHaveBeenCalledTimes(1);
  }
);

function completionDependencies(): OwnedPendingCompletionDependencies {
  return {
    getSession: (id) => sessions.getSession(id),
    getTask: (id) => tasks.getTask(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    coordinatorLookup: { getCoordinator: () => null },
    dispatchApproval: mock(async (owner, id, source, reason, guard) => {
      await new SpaceTaskManager(db, owner).setTaskStatus(id, 'approved', {
        ...guard,
        approvalSource: source,
        approvalReason: reason,
      });
      throw new Error('Dispatcher unavailable');
    }),
    emitTaskUpdated: emit,
    warn: mock(() => {}),
    audit: mock(() => {}),
  };
}
const completionName = 'task.resolvePendingCompletion';
function reviewTask() {
  return tasks.updateTask(taskId, { status: 'review', pendingCheckpointType: 'task_completion' })!;
}

test('pending completion discovery is configured only and remains lazy', async () => {
  expect(createDatabaseOperationCatalog(database, jobQueue).get(completionName)).toBeUndefined();
  expect(provider()().get(completionName)).toBeUndefined();
  const deps = completionDependencies();
  deps.getTask = mock(deps.getTask);
  deps.getSession = mock(deps.getSession);
  const getRegistry = provider({}, deps);
  const rpc = createOperationRpcHandler(getRegistry, () => ({}));
  const description = await rpc(
    { name: 'operations.describe', input: { name: completionName } },
    context
  );
  expect(description).toMatchObject({
    found: true,
    resultSchema: {
      properties: {
        postApprovalBlockedReason: expect.anything(),
        approvalSource: expect.anything(),
      },
    },
  });
  const mcp = createOperationMcpHandler(getRegistry, () => ({ sessionId: 'unbound' }));
  const list = JSON.parse((await mcp({ name: 'operations.list', input: {} })).content[0].text);
  expect(list).toContainEqual(expect.objectContaining({ name: completionName }));
  expect(getRegistry()).toBe(getRegistry());
  expect(getDatabase).not.toHaveBeenCalled();
  expect(deps.getTask).not.toHaveBeenCalled();
  expect(deps.getSession).not.toHaveBeenCalled();
});

test('cached and future MCP use the same pending completion operation as RPC', async () => {
  sessions.createSession(
    {
      ...createTestSession('reviewer'),
      workspacePath: '/repo',
      type: 'space_task_agent',
      context: { spaceId },
    },
    { enforceWorkspaceOwnership: false }
  );
  let registry = createDatabaseOperationCatalog(database, jobQueue);
  const getRegistry = () => registry;
  const mcp = createOperationMcpHandler(getRegistry, () => ({ sessionId: 'reviewer' }));
  const request = {
    name: completionName,
    input: { taskId, approved: true, reason: '  accepted  ' },
  };
  expect((await mcp(request)).isError).toBe(true);
  const deps = completionDependencies();
  registry = provider({}, deps)();
  const later = createOperationMcpHandler(getRegistry, () => ({ sessionId: 'reviewer' }));
  const rpc = createOperationRpcHandler(getRegistry, () => ({}));
  for (const invoke of [
    () => rpc(request, context),
    async () => JSON.parse((await mcp(request)).content[0].text),
    async () => JSON.parse((await later(request)).content[0].text),
  ]) {
    const previous = reviewTask();
    expect(await invoke()).toMatchObject({
      id: taskId,
      status: 'approved',
      approvalSource: 'human',
      approvalReason: '  accepted  ',
      postApprovalBlockedReason: expect.stringContaining('Dispatcher unavailable'),
    });
    expect(deps.dispatchApproval).toHaveBeenLastCalledWith(
      spaceId,
      taskId,
      'human',
      '  accepted  ',
      { expectedPendingCompletionGeneration: previous.pendingCompletionGeneration }
    );
  }
  expect(emit).toHaveBeenCalledTimes(3);
  expect(deps.warn).toHaveBeenCalledTimes(3);
  expect(deps.audit).toHaveBeenCalledTimes(2);
});

test('discovered pending completion rejects an ordinary Space member before effects', async () => {
  const caller = member('ordinary-member', spaceId);
  const previous = reviewTask();
  const deps = completionDependencies();
  const mcp = createOperationMcpHandler(provider({}, deps), () => caller);
  const result = await mcp({ name: completionName, input: { taskId, approved: false } });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({
    code: 'execution_failed',
    message: expect.stringContaining('coordinator or task-agent'),
  });
  expect(tasks.getTask(taskId)).toEqual(previous);
  expect(deps.dispatchApproval).not.toHaveBeenCalled();
  expect(deps.audit).not.toHaveBeenCalled();
  expect(deps.warn).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});
