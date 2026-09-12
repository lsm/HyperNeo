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
import { createSpaceOperationRegistryProvider } from '../../../../src/lib/space/operations/registry';
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
test("the task's own worker MCP session can complete it", async () => {
  const sessionId = worker('owner-session');
  const result = await operation.execute({ taskId }, { source: 'mcp', sessionId });
  expect(result).toMatchObject({ accepted: true });
  expect(tasks.getTask(taskId)?.status).toBe('done');
});
test.each(['no-session', 'unbound', 'foreign-task', 'foreign-space'] as const)(
  'a foreign MCP caller is denied (%s)',
  async (kind) => {
    const sessionId =
      kind === 'no-session'
        ? undefined
        : kind === 'unbound'
          ? 'unbound-session'
          : kind === 'foreign-task'
            ? worker('foreign', 'other-task', spaceId)
            : worker('foreign', taskId, 'other-space');
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

test('registry discovery reports task.complete', async () => {
  const getDatabase = mock(() => db);
  const database = { getDatabase, notifyChange: () => {} } as unknown as AppDatabase;
  const provider = createSpaceOperationRegistryProvider(database, {} as JobQueueRepository, {
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    taskRepo: tasks,
    notifyStandalone: () => {},
    emitTaskUpdated: emit,
    blockExecution: async () => {
      throw new Error('unexpected workflow cleanup');
    },
  });
  const rpc = createOperationRpcHandler(provider, () => ({}));
  const describe = { name: 'operations.describe', input: { name: 'task.complete' } };
  expect(await rpc(describe, {} as CallContext)).toMatchObject({
    found: true,
    name: 'task.complete',
  });
});
