import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CallContext } from '@hyperneo/shared';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { createCompleteTaskOperation } from '../../../../src/lib/space/operations/complete-task';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let spaceId: string;
let taskId: string;
let emit: ReturnType<typeof mock>;
let operation: ReturnType<typeof createCompleteTaskOperation>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '', status: 'approved' }).id;
  emit = mock(async () => {});
  operation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: emit,
  });
});
afterEach(() => db.close());

function worker(sessionId: string, boundTaskId = taskId, boundSpaceId = spaceId): string {
  sessions.createSession(
    {
      ...createTestSession(sessionId),
      workspacePath: '/repo',
      type: 'worker',
      context: { taskId: boundTaskId, spaceId: boundSpaceId },
    },
    { enforceWorkspaceOwnership: false }
  );
  return sessionId;
}

test.each(['rpc', 'internal'] as const)(
  '%s caller completes an approved task and persists the result',
  async (source) => {
    const result = await operation.execute({ taskId, result: 'Shipped it.' }, { source });
    expect(result).toMatchObject({
      accepted: true,
      task: { id: taskId, status: 'done', result: 'Shipped it.' },
    });
    expect(tasks.getTask(taskId)?.status).toBe('done');
    expect(tasks.getTask(taskId)?.result).toBe('Shipped it.');
    expect(emit).toHaveBeenCalledWith(
      spaceId,
      expect.objectContaining({ id: taskId, status: 'done' })
    );
  }
);
test('a rejecting emitTaskUpdated does not fail an already-committed completion', async () => {
  const failingOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: mock(async () => {
      throw new Error('subscriber unavailable');
    }),
  });
  const result = await failingOperation.execute(
    { taskId, result: 'Shipped it.' },
    { source: 'rpc' }
  );
  expect(result).toMatchObject({ accepted: true, task: { id: taskId, status: 'done' } });
  expect(tasks.getTask(taskId)?.status).toBe('done');
});
test("the task's own worker MCP session can complete it", async () => {
  const sessionId = worker('owner-session');
  const result = await operation.execute({ taskId }, { source: 'mcp', sessionId });
  expect(result).toMatchObject({ accepted: true });
  expect(tasks.getTask(taskId)?.status).toBe('done');
});
test.each(['no-session', 'unbound', 'foreign-task', 'foreign-space', 'ended'] as const)(
  'a foreign MCP caller is denied (%s)',
  async (kind) => {
    const sessionId =
      kind === 'no-session'
        ? undefined
        : kind === 'unbound'
          ? 'unbound-session'
          : kind === 'foreign-task'
            ? worker('foreign', 'other-task', spaceId)
            : kind === 'foreign-space'
              ? worker('foreign', taskId, 'other-space')
              : worker('ended-owner');
    if (kind === 'ended')
      db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(sessionId);
    expect(await operation.execute({ taskId }, { source: 'mcp', sessionId })).toEqual({
      accepted: false,
      reason: 'task_completion_denied',
    });
    expect(tasks.getTask(taskId)?.status).toBe('approved');
  }
);
test.each(['missing', 'standalone'] as const)(
  'rejects task_completion_unavailable for a %s task',
  async (kind) => {
    const id = kind === 'missing' ? 'missing-task' : 'standalone-task';
    if (kind === 'standalone') {
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, depends_on, created_at, updated_at)
         VALUES (?, NULL, NULL, 'Standalone', '', 'approved', 'normal', '[]', '[]', ?, ?)`
      ).run(id, Date.now(), Date.now());
    }
    expect(await operation.execute({ taskId: id }, { source: 'rpc' })).toEqual({
      accepted: false,
      reason: 'task_completion_unavailable',
    });
  }
);
test.each([
  ['archived', () => tasks.updateTask(taskId, { archivedAt: Date.now() })],
  ['not approved', () => tasks.updateTask(taskId, { status: 'in_progress' })],
] as const)('rejects task_completion_unavailable when the task is %s', async (_label, mutate) => {
  mutate();
  expect(await operation.execute({ taskId }, { source: 'rpc' })).toEqual({
    accepted: false,
    reason: 'task_completion_unavailable',
  });
});

test('the routed post-approval session completes the task', async () => {
  const sessionId = worker('post-approval-owner');
  tasks.updateTask(taskId, { postApprovalSessionId: sessionId });
  const result = await operation.execute({ taskId }, { source: 'mcp', sessionId });
  expect(result).toMatchObject({ accepted: true });
  expect(tasks.getTask(taskId)?.status).toBe('done');
});
test('a different worker session bound to the task is denied once a post-approval session is routed', async () => {
  const routedSessionId = worker('post-approval-owner');
  const otherSessionId = worker('other-worker');
  tasks.updateTask(taskId, { postApprovalSessionId: routedSessionId });
  const result = await operation.execute({ taskId }, { source: 'mcp', sessionId: otherSessionId });
  expect(result).toEqual({ accepted: false, reason: 'task_completion_denied' });
  expect(tasks.getTask(taskId)?.status).toBe('approved');
});
test('an rpc caller is denied once a post-approval session is routed', async () => {
  const routedSessionId = worker('post-approval-owner');
  tasks.updateTask(taskId, { postApprovalSessionId: routedSessionId });
  const result = await operation.execute({ taskId }, { source: 'rpc' });
  expect(result).toEqual({ accepted: false, reason: 'task_completion_denied' });
  expect(tasks.getTask(taskId)?.status).toBe('approved');
});
test('rejects task_completion_unavailable when a post-approval owner is required but not yet routed', async () => {
  const requiresPostApprovalOwner = mock(async () => true);
  const gatedOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: emit,
    requiresPostApprovalOwner,
  });
  const result = await gatedOperation.execute({ taskId }, { source: 'rpc' });
  expect(result).toEqual({ accepted: false, reason: 'task_completion_unavailable' });
  expect(tasks.getTask(taskId)?.status).toBe('approved');
  expect(requiresPostApprovalOwner).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
    source: 'rpc',
  });
});
test('completes normally when requiresPostApprovalOwner returns false', async () => {
  const gatedOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: emit,
    requiresPostApprovalOwner: mock(async () => false),
  });
  const result = await gatedOperation.execute({ taskId, result: 'Shipped it.' }, { source: 'rpc' });
  expect(result).toMatchObject({ accepted: true, task: { id: taskId, status: 'done' } });
});
test('completes normally when requiresPostApprovalOwner is absent', async () => {
  const result = await operation.execute({ taskId, result: 'Shipped it.' }, { source: 'rpc' });
  expect(result).toMatchObject({ accepted: true, task: { id: taskId, status: 'done' } });
});
test('a completion gate returning ok:true admits the task', async () => {
  const completionGate = mock(async () => ({ ok: true as const }));
  const gatedOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: emit,
    completionGate,
  });
  const result = await gatedOperation.execute({ taskId, result: 'Shipped it.' }, { source: 'rpc' });
  expect(result).toMatchObject({ accepted: true, task: { id: taskId, status: 'done' } });
  expect(completionGate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
    source: 'rpc',
  });
});
test('a completion gate returning ok:false rejects with task_completion_unavailable and no write', async () => {
  const completionGate = mock(async () => ({ ok: false as const, error: 'PR not merged yet.' }));
  const gatedOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: emit,
    completionGate,
  });
  const result = await gatedOperation.execute({ taskId }, { source: 'rpc' });
  expect(result).toEqual({
    accepted: false,
    reason: 'task_completion_unavailable',
    detail: 'PR not merged yet.',
  });
  expect(tasks.getTask(taskId)?.status).toBe('approved');
  expect(emit).not.toHaveBeenCalled();
});
test('completes normally when completionGate is absent', async () => {
  const result = await operation.execute({ taskId, result: 'Shipped it.' }, { source: 'rpc' });
  expect(result).toMatchObject({ accepted: true, task: { id: taskId, status: 'done' } });
});
test('ownership rejections win before the completion gate runs', async () => {
  const completionGate = mock(async () => ({ ok: true as const }));
  const routedSessionId = worker('post-approval-owner');
  tasks.updateTask(taskId, { postApprovalSessionId: routedSessionId });
  const gatedOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: emit,
    completionGate,
  });
  const result = await gatedOperation.execute({ taskId }, { source: 'rpc' });
  expect(result).toEqual({ accepted: false, reason: 'task_completion_denied' });
  expect(completionGate).not.toHaveBeenCalled();
});
test('a post-approval owner reassigned between admission and the manager write is rejected', async () => {
  const routedSessionId = worker('post-approval-owner');
  const stolenBySessionId = worker('other-worker');
  tasks.updateTask(taskId, { postApprovalSessionId: routedSessionId });
  const racyOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => {
      const manager = new SpaceTaskManager(db, id);
      return {
        setTaskStatus: (taskIdArg, status, options) => {
          tasks.updateTask(taskId, { postApprovalSessionId: stolenBySessionId });
          return manager.setTaskStatus(taskIdArg, status, options);
        },
      };
    },
    emitTaskUpdated: emit,
  });
  await expect(
    racyOperation.execute({ taskId }, { source: 'mcp', sessionId: routedSessionId })
  ).rejects.toThrow();
  expect(tasks.getTask(taskId)?.status).toBe('approved');
  expect(tasks.getTask(taskId)?.postApprovalSessionId).toBe(stolenBySessionId);
});
test('a task reopened to in_progress between admission and the manager write is rejected', async () => {
  const racyOperation = createCompleteTaskOperation(() => db, {
    getTaskManager: (id) => {
      const manager = new SpaceTaskManager(db, id);
      return {
        setTaskStatus: (taskIdArg, status, options) => {
          tasks.updateTask(taskId, { status: 'in_progress' });
          return manager.setTaskStatus(taskIdArg, status, options);
        },
      };
    },
    emitTaskUpdated: emit,
  });
  await expect(racyOperation.execute({ taskId }, { source: 'rpc' })).rejects.toThrow();
  expect(tasks.getTask(taskId)?.status).toBe('in_progress');
});

test('catalog discovery reports task.complete when wired through the complete slot', async () => {
  const getDatabase = mock(() => db);
  const database = { getDatabase, notifyChange: () => {} } as unknown as AppDatabase;
  const registry = createDatabaseOperationCatalog(database, {} as JobQueueRepository, {
    complete: createCompleteTaskOperation(() => db, {
      getTaskManager: (id) => new SpaceTaskManager(db, id),
      emitTaskUpdated: emit,
    }),
  });
  const rpc = createOperationRpcHandler(registry, () => ({}));
  const describe = { name: 'operations.describe', input: { name: 'task.complete' } };
  expect(await rpc(describe, {} as CallContext)).toMatchObject({
    found: true,
    name: 'task.complete',
  });
});
