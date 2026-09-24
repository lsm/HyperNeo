import { describe, expect, mock, test } from 'bun:test';
import type { Session, SpaceTask } from '@hyperneo/shared';
import {
  createRetryTaskOperation,
  type RetryTaskDependencies,
} from '../../../../src/lib/tasks/retry-task.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { isOperationAdmitted } from '../../../../src/lib/operations/invoke.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-retry-test';
const OTHER_SPACE_ID = 'space-retry-other';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigrations(db, () => {});
  db.exec('PRAGMA foreign_keys = OFF');
  for (const id of [SPACE_ID, OTHER_SPACE_ID]) {
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(id, `/tmp/workspace/${id}`, id, id, Date.now(), Date.now());
  }
  return db;
}

function memberSession(): Session {
  return {
    id: 'space-chat-1',
    title: 'Space Chat',
    status: 'active',
    type: 'space_chat',
    context: { spaceId: SPACE_ID },
    metadata: { promptProvenance: { source: 'test', hash: 'h', agentId: 'agent-member' } },
  } as unknown as Session;
}

function memberCaller(overrides: Partial<OperationCaller> = {}): OperationCaller {
  return { source: 'mcp', sessionId: 'space-chat-1', role: 'long_term_agent', ...overrides };
}

interface Harness {
  db: BunDatabase;
  taskRepo: SpaceTaskRepository;
  retryTask: ReturnType<typeof mock>;
  recoverWorkflowTask: ReturnType<typeof mock>;
  operation: ReturnType<typeof createRetryTaskOperation>;
}

function makeHarness(session: Session | null = memberSession()): Harness {
  const db = makeDb();
  const agents = new SpaceLongHorizonAgentRepository(db);
  agents.create({
    id: 'agent-member',
    spaceId: SPACE_ID,
    handle: 'member',
    sessionId: 'space-chat-1',
  });
  const taskRepo = new SpaceTaskRepository(db);
  const retryTask = mock(async (taskId: string) => taskRepo.getTask(taskId) as SpaceTask);
  const recoverWorkflowTask = mock(async (_spaceId: string, taskId: string) => {
    return taskRepo.getTask(taskId) as SpaceTask;
  });
  const dependencies: RetryTaskDependencies = {
    getSession: () => session,
    getTaskManager: () => ({ retryTask }),
    recoverWorkflowTask,
    longHorizonAgentRepo: agents,
    taskRepo,
  };
  const operation = createRetryTaskOperation(() => db, dependencies);
  return { db, taskRepo, retryTask, recoverWorkflowTask, operation };
}

describe('task.retry operation', () => {
  test('retries a blocked Space task for an RPC caller through the task manager', async () => {
    const harness = makeHarness();
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Blocked work',
        description: '',
        status: 'blocked',
      });
      const result = await harness.operation.execute(
        { taskId: task.id, description: 'try again' },
        { source: 'rpc' }
      );
      expect((result as SpaceTask).id).toBe(task.id);
      expect(harness.retryTask).toHaveBeenCalledWith(task.id, { description: 'try again' });
      expect(harness.recoverWorkflowTask).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  test('admits an agent session that is active in the owning space', async () => {
    const harness = makeHarness();
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Cancelled work',
        description: '',
        status: 'cancelled',
      });
      const result = await harness.operation.execute({ taskId: task.id }, memberCaller());
      expect((result as SpaceTask).id).toBe(task.id);
      expect(harness.retryTask).toHaveBeenCalledTimes(1);
    } finally {
      harness.db.close();
    }
  });

  test('denies an MCP caller whose session is archived in the owning space', async () => {
    const harness = makeHarness({ ...memberSession(), status: 'archived' } as Session);
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Blocked work',
        description: '',
        status: 'blocked',
      });
      const result = await harness.operation.execute({ taskId: task.id }, memberCaller());
      expect(result).toBe('retry_denied');
      expect(harness.retryTask).not.toHaveBeenCalled();
      expect(harness.taskRepo.getTask(task.id)?.status).toBe('blocked');
    } finally {
      harness.db.close();
    }
  });

  test('admits a workflow_worker role with an active session in the space', async () => {
    const harness = makeHarness();
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Blocked work',
        description: '',
        status: 'blocked',
      });
      const result = await harness.operation.execute(
        { taskId: task.id },
        memberCaller({ role: 'workflow_worker' })
      );
      expect((result as SpaceTask).id).toBe(task.id);
      expect(harness.retryTask).toHaveBeenCalledTimes(1);
    } finally {
      harness.db.close();
    }
  });

  test('denies an MCP caller whose session belongs to another space', async () => {
    const harness = makeHarness({
      ...memberSession(),
      context: { spaceId: OTHER_SPACE_ID },
    } as unknown as Session);
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Blocked work',
        description: '',
        status: 'blocked',
      });
      const result = await harness.operation.execute({ taskId: task.id }, memberCaller());
      expect(result).toBe('retry_denied');
      expect(harness.retryTask).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  test('declares a mutate policy, but the generic door no longer enforces roles', async () => {
    const harness = makeHarness();
    try {
      expect(harness.operation.policy).toEqual({
        safetyClass: 'mutate',
        roles: ['long_term_agent'],
      });
      expect(isOperationAdmitted(harness.operation, memberCaller())).toBe(true);
      expect(
        isOperationAdmitted(harness.operation, memberCaller({ role: 'workflow_worker' }))
      ).toBe(true);
      expect(isOperationAdmitted(harness.operation, memberCaller({ role: 'universal_read' }))).toBe(
        true
      );
      expect(isOperationAdmitted(harness.operation, { source: 'rpc' })).toBe(true);
    } finally {
      harness.db.close();
    }
  });

  test('rejects a task that is not in a retryable status', async () => {
    const harness = makeHarness();
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Open work',
        description: '',
        status: 'open',
      });
      const result = await harness.operation.execute({ taskId: task.id }, { source: 'rpc' });
      expect(result).toBe('status_not_retryable');
      expect(harness.retryTask).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  test('rejects an unknown task id', async () => {
    const harness = makeHarness();
    try {
      const result = await harness.operation.execute({ taskId: 'missing' }, { source: 'rpc' });
      expect(result).toBe('task_not_found');
      expect(harness.retryTask).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  test('hands a workflow-backed blocked task to the workflow runtime as open', async () => {
    const harness = makeHarness();
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Workflow work',
        description: '',
        status: 'blocked',
      });
      harness.db
        .prepare('UPDATE space_tasks SET workflow_run_id = ? WHERE id = ?')
        .run('run-1', task.id);
      const result = await harness.operation.execute(
        { taskId: task.id, description: 'new brief' },
        { source: 'rpc' }
      );
      expect((result as SpaceTask).id).toBe(task.id);
      expect(harness.recoverWorkflowTask).toHaveBeenCalledWith(SPACE_ID, task.id, 'open', {
        description: 'new brief',
      });
      expect(harness.retryTask).not.toHaveBeenCalled();
    } finally {
      harness.db.close();
    }
  });

  test('reports retry_unavailable when the workflow runtime cannot recover the task', async () => {
    const harness = makeHarness();
    try {
      const task = harness.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Workflow work',
        description: '',
        status: 'done',
      });
      harness.db
        .prepare('UPDATE space_tasks SET workflow_run_id = ? WHERE id = ?')
        .run('run-1', task.id);
      harness.recoverWorkflowTask.mockImplementation(async () => 'execution_unavailable');
      const result = await harness.operation.execute({ taskId: task.id }, { source: 'rpc' });
      expect(result).toBe('retry_unavailable');
      expect(harness.recoverWorkflowTask).toHaveBeenCalledWith(SPACE_ID, task.id, 'in_progress', {
        description: undefined,
      });
    } finally {
      harness.db.close();
    }
  });
});
