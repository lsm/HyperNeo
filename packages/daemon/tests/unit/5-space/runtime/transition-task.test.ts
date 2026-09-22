import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SpaceTaskStatus } from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { SpaceTaskManager, StaleTaskGuardError } from '../../../../src/lib/tasks/task-manager';
import {
  createSpaceTransitionTaskOperation,
  decide,
  type SpaceTransitionTaskDependencies,
  writeStatus,
} from '../../../../src/lib/tasks/transition-task';
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

type TaskManagerStub = Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus' | 'submitTaskForReview'>;

function managerStub(overrides: Partial<TaskManagerStub>): TaskManagerStub {
  return {
    getTask: async (id: string) => tasks.getTask(id),
    setTaskStatus: async () => {
      throw new Error('setTaskStatus is not stubbed for this test');
    },
    submitTaskForReview: async () => {
      throw new Error('submitTaskForReview is not stubbed for this test');
    },
    ...overrides,
  };
}

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

function readStandaloneStatus(taskId: string): string {
  return (
    db.prepare('SELECT status FROM space_tasks WHERE id = ?').get(taskId) as {
      status: string;
    }
  ).status;
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

test('a block reason accompanies a move to blocked and is persisted', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  await invoke({ taskId: task.id, status: 'in_progress' }, rpc);

  const result = await invoke(
    { taskId: task.id, status: 'blocked', blockReason: 'human_input_requested' },
    rpc
  );

  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id, status: 'blocked' } });
  expect(tasks.getTask(task.id)?.blockReason).toBe('human_input_requested');
});

test('a block reason on any other status is rejected and makes no write', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });

  const result = await invoke(
    { taskId: task.id, status: 'in_progress', blockReason: 'human_input_requested' },
    rpc
  );

  expect(result).toEqual({ kind: 'completed', value: 'block_reason_requires_blocked' });
  expect(tasks.getTask(task.id)?.status).toBe('open');
});

test('a workflow-backed stop carries the block reason into the runtime params', async () => {
  const run = createWorkflowRun();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { workflowRunId: run.id, status: 'in_progress' });
  const stopForStatus = mock(async () => tasks.getTask(task.id));

  await invoke({ taskId: task.id, status: 'blocked', blockReason: 'human_input_requested' }, rpc, {
    isWorkflowRunActive: () => true,
    stopForStatus,
  });

  expect(stopForStatus).toHaveBeenCalledWith(
    spaceId,
    task.id,
    expect.objectContaining({ status: 'blocked', blockReason: 'human_input_requested' }),
    { expectedStatus: 'in_progress', expectedWorkflowRunId: run.id }
  );
});

test('the workflow stop path receives the block reason in one status write', async () => {
  const run = createWorkflowRun();
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { workflowRunId: run.id, status: 'in_progress' });
  const stopForStatus = mock(async (_s: string, id: string, params: Record<string, unknown>) => {
    const manager = new SpaceTaskManager(db, spaceId);
    return manager.setTaskStatus(id, 'blocked', {
      blockReason: params.blockReason as 'human_input_requested',
    });
  });

  await invoke({ taskId: task.id, status: 'blocked', blockReason: 'human_input_requested' }, rpc, {
    isWorkflowRunActive: () => true,
    stopForStatus,
  });

  expect(tasks.getTask(task.id)?.blockReason).toBe('human_input_requested');
});

test.each([
  ['a block reason', { status: 'blocked', blockReason: 'human_input_requested' }],
  ['a review reason', { status: 'done', reviewReason: 'Ready' }],
] as const)('a standalone task rejects %s instead of dropping it', async (_name, fields) => {
  const task = createStandaloneTask(db, { title: 'Solo' }, undefined, () => {});

  const result = await invoke({ taskId: task.id, ...fields }, rpc);

  expect(result).toEqual({ kind: 'completed', value: 'unsupported_status' });
  expect(readStandaloneStatus(task.id)).toBe('open');
});

test('a runtime-owned block reason is rejected by the schema', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });

  const result = await invoke(
    { taskId: task.id, status: 'blocked', blockReason: 'agent_crashed' },
    rpc
  );

  expect(result).toMatchObject({ kind: 'failed', code: 'invalid_input' });
});

test('a missing task resolves to null', async () => {
  expect(await invoke({ taskId: 'missing', status: 'open' }, rpc)).toEqual({
    kind: 'completed',
    value: null,
  });
});

test('an mcp session in another Space gets a typed denial and makes no write', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const caller = worker('outsider', 'other-space');
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, caller);
  expect(result).toEqual({
    kind: 'completed',
    value: { accepted: false, reason: 'task_transition_denied' },
  });
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

test('mcp cannot close an approved task and must go through task.complete', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { status: 'approved' });
  const caller = worker('member', spaceId);
  const result = await invoke({ taskId: task.id, status: 'done' }, caller);
  expect(result).toEqual({ kind: 'completed', value: 'approved_requires_complete' });
  expect(tasks.getTask(task.id)?.status).toBe('approved');
});

test('rpc closing an approved task records the human approval source', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { status: 'approved' });
  const result = await invoke({ taskId: task.id, status: 'done' }, rpc);
  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id, status: 'done' } });
  expect(tasks.getTask(task.id)?.approvalSource).toBe('human');
});

test.each(['approved', 'rate_limited'] as const)(
  'requesting %s directly is unsupported',
  async (status) => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    expect(await invoke({ taskId: task.id, status }, rpc)).toEqual({
      kind: 'completed',
      value: 'unsupported_status',
    });
  }
);

test('archiving a task with an active workflow run names the active run', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  tasks.updateTask(task.id, { workflowRunId: createWorkflowRun().id });
  isWorkflowRunActive.mockImplementation(() => true);
  expect(await invoke({ taskId: task.id, status: 'archived' }, rpc)).toEqual({
    kind: 'completed',
    value: 'archive_active_run',
  });
  expect(tasks.getTask(task.id)?.archivedAt).toBeNull();
});

test('an mcp session in the owning Space archives a task off the board', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const result = await invoke({ taskId: task.id, status: 'archived' }, worker('member', spaceId));
  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id, status: 'archived' } });
  expect(tasks.getTask(task.id)?.archivedAt).not.toBeNull();
});

test('an archive denial stays distinct from the active-run refusal', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const caller = worker('outsider', 'other-space');
  expect(await invoke({ taskId: task.id, status: 'archived' }, caller)).toEqual({
    kind: 'completed',
    value: { accepted: false, reason: 'task_transition_denied' },
  });
  expect(tasks.getTask(task.id)?.archivedAt).toBeNull();
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

test.each([
  ['done', { result: 'Finished' }, { result: 'Finished' }],
  ['blocked', { blockReason: 'human_input_requested' }, { blockReason: 'human_input_requested' }],
  ['cancelled', {}, undefined],
  ['stopped', {}, undefined],
] as const)(
  'a %s transition with a running direct attempt requests a durable outcome',
  async (status, fields, options) => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    attempts.select(task.id);
    attempts.claim(task.id, 'attempt', 'worker');
    attempts.activate('attempt', 'worker');
    tasks.updateTask(task.id, { status: 'in_progress', taskAgentSessionId: 'worker' });
    const requestDirectOutcome = mock(() => ({ accepted: true as const, jobId: 'job-1' }));

    const result = await invoke({ taskId: task.id, status, ...fields }, rpc, {
      requestDirectOutcome,
    });

    expect(result).toEqual({ kind: 'completed', value: { accepted: true, jobId: 'job-1' } });
    expect(requestDirectOutcome).toHaveBeenCalledWith({
      attemptId: 'attempt',
      sessionId: 'worker',
      generation: 1,
      status,
      ...(options === undefined ? {} : { options }),
    });
  }
);

test('a direct outcome refusal is returned without a fallback status write', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  attempts.select(task.id);
  attempts.claim(task.id, 'attempt', 'worker');
  attempts.activate('attempt', 'worker');
  tasks.updateTask(task.id, { status: 'in_progress', taskAgentSessionId: 'worker' });
  const requestDirectOutcome = mock(() => ({
    accepted: false as const,
    reason: 'direct_transition_unavailable',
  }));

  const result = await invoke({ taskId: task.id, status: 'done' }, rpc, {
    requestDirectOutcome,
  });

  expect(result).toEqual({
    kind: 'completed',
    value: { accepted: false, reason: 'direct_transition_unavailable' },
  });
  expect(tasks.getTask(task.id)?.status).toBe('in_progress');
});

test('a stale-status guard failure surfaces as invalid_transition', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const staleManager = managerStub({
    setTaskStatus: async () => {
      throw new StaleTaskGuardError(`Task ${task.id} is no longer 'open'`);
    },
  });
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc, {
    getTaskManager: () => staleManager,
  });
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
});

test('an unrelated failure that merely mentions "is no longer" is not misclassified', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const brokenManager = managerStub({
    setTaskStatus: async () => {
      throw new Error(`Session worker-1 is no longer alive`);
    },
  });
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc, {
    getTaskManager: () => brokenManager,
  });
  expect(result).toMatchObject({
    kind: 'failed',
    code: 'execution_failed',
    message: expect.stringContaining('is no longer alive'),
  });
});

test('writeStatus threads expectedWorkflowRunId from the loaded task into setTaskStatus', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const run = createWorkflowRun();
  tasks.updateTask(task.id, { workflowRunId: run.id });
  const setTaskStatus = mock(async () => {
    throw new StaleTaskGuardError(
      `Task ${task.id} is no longer attached to workflow run '${run.id}' (now 'null')`
    );
  });
  const staleManager = managerStub({ setTaskStatus });
  const result = await invoke({ taskId: task.id, status: 'archived' }, rpc, {
    getTaskManager: () => staleManager,
  });
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
  expect(setTaskStatus).toHaveBeenCalledWith(
    task.id,
    'archived',
    expect.objectContaining({ expectedStatus: 'open', expectedWorkflowRunId: run.id })
  );
});

test('a matching expectedStatus is threaded through and the write proceeds', async () => {
  const task = tasks.createTask({ spaceId, title: 'Draft', description: '' });
  tasks.updateTask(task.id, { status: 'draft' });
  const result = await invoke({ taskId: task.id, status: 'open', expectedStatus: 'draft' }, rpc);
  expect(result).toMatchObject({ kind: 'completed', value: { id: task.id, status: 'open' } });
  expect(tasks.getTask(task.id)?.status).toBe('open');
});

test('a stale expectedStatus rejects with invalid_transition and leaves the task alone', async () => {
  const task = tasks.createTask({ spaceId, title: 'Finished', description: '' });
  tasks.updateTask(task.id, { status: 'done' });
  const result = await invoke({ taskId: task.id, status: 'open', expectedStatus: 'draft' }, rpc);
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
  expect(tasks.getTask(task.id)?.status).toBe('done');
});

test('a stale expectedStatus rejects before a runtime executor can run', async () => {
  const task = tasks.createTask({ spaceId, title: 'Workflow', description: '' });
  const run = createWorkflowRun();
  tasks.updateTask(task.id, { workflowRunId: run.id, status: 'in_progress' });
  const stopForStatus = mock(async () => tasks.getTask(task.id));
  const result = await invoke(
    { taskId: task.id, status: 'cancelled', expectedStatus: 'open' },
    rpc,
    { stopForStatus }
  );
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
  expect(stopForStatus).not.toHaveBeenCalled();
  expect(tasks.getTask(task.id)?.status).toBe('in_progress');
});

test('a stale expectedStatus rejects a standalone transition inside its transaction', async () => {
  const task = createStandaloneTask(db, { title: 'Solo' }, undefined, () => {});
  const result = await invoke(
    { taskId: task.id, status: 'in_progress', expectedStatus: 'done' },
    rpc
  );
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
  expect(readStandaloneStatus(task.id)).toBe('open');
});

test('a matching expectedStatus lets a standalone transition through', async () => {
  const task = createStandaloneTask(db, { title: 'Solo' }, undefined, () => {});
  const result = await invoke(
    { taskId: task.id, status: 'in_progress', expectedStatus: 'open' },
    rpc
  );
  expect(result).toMatchObject({ kind: 'completed', value: { status: 'in_progress' } });
  expect(readStandaloneStatus(task.id)).toBe('in_progress');
});

test('an omitted expectedStatus still guards on the loaded status', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const setTaskStatus = mock(async () => tasks.getTask(task.id)!);
  await invoke({ taskId: task.id, status: 'in_progress' }, rpc, {
    getTaskManager: () => managerStub({ setTaskStatus }),
  });
  expect(setTaskStatus).toHaveBeenCalledWith(
    task.id,
    'in_progress',
    expect.objectContaining({ expectedStatus: 'open' })
  );
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

test('a Space with no free slot rejects a start instead of reporting work began', async () => {
  const running = tasks.createTask({ spaceId, title: 'Running', description: '' });
  tasks.updateTask(running.id, { status: 'in_progress' });
  const queued = tasks.createTask({ spaceId, title: 'Queued', description: '' });

  const result = await invoke({ taskId: queued.id, status: 'in_progress' }, rpc);

  expect(result).toEqual({ kind: 'completed', value: 'space_at_task_capacity' });
  const unchanged = tasks.getTask(queued.id)!;
  expect(unchanged.status).toBe('open');
  expect(unchanged.startedAt).toBeNull();
});

test('a task that already holds a slot still moves to in_progress at the limit', async () => {
  const task = tasks.createTask({ spaceId, title: 'Approved', description: '' });
  tasks.updateTask(task.id, { status: 'approved' });

  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc);

  expect(result).toMatchObject({
    kind: 'completed',
    value: { id: task.id, status: 'in_progress' },
  });
});

test('a workflow-backed task is not gated by the Space concurrency limit', async () => {
  const running = tasks.createTask({ spaceId, title: 'Running', description: '' });
  tasks.updateTask(running.id, { status: 'in_progress' });
  const run = createWorkflowRun();
  const attached = tasks.createTask({ spaceId, title: 'Attached', description: '' });
  tasks.updateTask(attached.id, { workflowRunId: run.id });

  const result = await invoke({ taskId: attached.id, status: 'in_progress' }, rpc);

  expect(result).toMatchObject({
    kind: 'completed',
    value: { id: attached.id, status: 'in_progress' },
  });
});

function createOwned(status: SpaceTaskStatus, workflowRunId?: string) {
  const created = tasks.createTask({ spaceId, title: 'T', description: '' });
  if (status === 'open' && workflowRunId === undefined) return { spaceId, task: created };
  const updated = tasks.updateTask(created.id, { status, workflowRunId });
  return { spaceId, task: updated ?? created };
}

describe('decide', () => {
  test.each([
    ['open to in_progress writes without approval', 'open', 'in_progress', undefined],
    ['review to done via rpc stamps human approval', 'review', 'done', 'human'],
  ] as const)('%s', async (_name, currentStatus, requestedStatus, approvalSource) => {
    const owned = createOwned(currentStatus);
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: requestedStatus },
      rpc,
      deps()
    );
    expect(result).toEqual({
      value: { ...owned, approvalSource, allowActiveRun: false },
    });
  });

  test.each([
    ['requesting the current status is invalid', 'open', 'open', 'invalid_transition'],
  ] as const)('%s', async (_name, currentStatus, requestedStatus, rejection) => {
    const owned = createOwned(currentStatus);
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: requestedStatus },
      rpc,
      deps()
    );
    expect(result).toEqual({ reason: rejection });
  });

  test('an unbound runtime executor still throws with the executor name', async () => {
    const owned = createOwned('in_progress', createWorkflowRun().id);
    await expect(
      decide(owned, { taskId: owned.task.id, status: 'open' }, rpc, deps())
    ).rejects.toThrow('Space runtime executor unavailable: stop_for_status');
  });

  test('a stale runtime write becomes invalid_transition while infrastructure faults propagate', async () => {
    const owned = createOwned('in_progress', createWorkflowRun().id);
    const input = { taskId: owned.task.id, status: 'stopped' as const };
    const result = await decide(
      owned,
      input,
      rpc,
      deps({
        parkStopped: async () => {
          throw new StaleTaskGuardError('stale');
        },
      })
    );
    expect(result).toEqual({ reason: 'invalid_transition' });
    await expect(
      decide(
        owned,
        input,
        rpc,
        deps({
          parkStopped: async () => {
            throw new Error('database unavailable');
          },
        })
      )
    ).rejects.toThrow('database unavailable');
  });

  test('park_stopped calls the bound executor and completes the transition', async () => {
    const owned = createOwned('in_progress', createWorkflowRun().id);
    const parked = { ...owned.task, status: 'stopped' as const };
    const parkStopped = mock(async () => parked);
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'stopped' },
      rpc,
      deps({ parkStopped })
    );
    expect(parkStopped).toHaveBeenCalledWith(spaceId, owned.task.id, {
      expectedStatus: owned.task.status,
      expectedWorkflowRunId: owned.task.workflowRunId,
    });
    expect(result).toEqual({ reason: parked });
  });

  test('recover_transition calls the bound executor and completes the transition', async () => {
    const owned = createOwned('blocked', createWorkflowRun().id);
    const recovered = { ...owned.task, status: 'in_progress' as const };
    const recoverTransition = mock(async () => recovered);
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'in_progress' },
      rpc,
      deps({ recoverTransition })
    );
    expect(recoverTransition).toHaveBeenCalledWith(spaceId, owned.task.id, 'in_progress', {
      expectedStatus: owned.task.status,
      expectedWorkflowRunId: owned.task.workflowRunId,
    });
    expect(result).toEqual({ reason: recovered });
  });

  test('a lifecycle change after the snapshot refuses the runtime executor', async () => {
    const owned = createOwned('blocked', createWorkflowRun().id);
    const recoverTransition = mock(async () => owned.task);
    const movedOn = managerStub({
      getTask: async () => ({ ...owned.task, status: 'in_progress' }),
      setTaskStatus: async () => {
        throw new Error('should not write');
      },
    });
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'in_progress' },
      rpc,
      deps({ recoverTransition, getTaskManager: () => movedOn })
    );
    expect(result).toEqual({ reason: 'invalid_transition' });
    expect(recoverTransition).not.toHaveBeenCalled();
  });

  test('a workflow run swapped after the snapshot refuses the runtime executor', async () => {
    const owned = createOwned('in_progress', createWorkflowRun().id);
    const parkStopped = mock(async () => owned.task);
    const rebound = managerStub({
      getTask: async () => ({ ...owned.task, workflowRunId: createWorkflowRun().id }),
      setTaskStatus: async () => {
        throw new Error('should not write');
      },
    });
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'stopped' },
      rpc,
      deps({ parkStopped, getTaskManager: () => rebound })
    );
    expect(result).toEqual({ reason: 'invalid_transition' });
    expect(parkStopped).not.toHaveBeenCalled();
  });

  test('a string rejection from recover_transition becomes the operation rejection', async () => {
    const owned = createOwned('blocked', createWorkflowRun().id);
    const recoverTransition = mock(async () => 'invalid_recovery_status');
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'in_progress' },
      rpc,
      deps({ recoverTransition })
    );
    expect(result).toEqual({ reason: 'invalid_transition' });
  });

  test('stop_for_status forwards the completion result to the runtime', async () => {
    const owned = createOwned('in_progress', createWorkflowRun().id);
    const stopped = { ...owned.task, status: 'done' as const };
    const stopForStatus = mock(async () => stopped);
    await decide(
      owned,
      { taskId: owned.task.id, status: 'done', result: 'shipped it' },
      rpc,
      deps({ stopForStatus, isWorkflowRunActive: () => true })
    );
    expect(stopForStatus).toHaveBeenCalledWith(
      spaceId,
      owned.task.id,
      {
        status: 'done',
        result: 'shipped it',
      },
      { expectedStatus: owned.task.status, expectedWorkflowRunId: owned.task.workflowRunId }
    );
  });

  test('an rpc review to done with a live run stops the workflow and stamps approval', async () => {
    const owned = createOwned('review', createWorkflowRun().id);
    const stopped = { ...owned.task, status: 'done' as const };
    const stopForStatus = mock(async () => stopped);
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'done' },
      rpc,
      deps({ stopForStatus, isWorkflowRunActive: () => true })
    );
    expect(stopForStatus).toHaveBeenCalledWith(
      spaceId,
      owned.task.id,
      {
        status: 'done',
        approvalSource: 'human',
      },
      { expectedStatus: owned.task.status, expectedWorkflowRunId: owned.task.workflowRunId }
    );
    expect(result).toEqual({ reason: stopped });
  });

  test('a non-rpc review to done is still refused', async () => {
    const owned = createOwned('review', createWorkflowRun().id);
    const stopForStatus = mock(async () => owned.task);
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'done' },
      { source: 'mcp', sessionId: 'session-1' },
      deps({ stopForStatus, isWorkflowRunActive: () => true })
    );
    expect(result).toEqual({ reason: 'invalid_transition' });
    expect(stopForStatus).not.toHaveBeenCalled();
  });

  test('stop_for_status calls the bound executor and completes the transition', async () => {
    const owned = createOwned('in_progress', createWorkflowRun().id);
    const stopped = { ...owned.task, status: 'open' as const };
    const stopForStatus = mock(async () => stopped);
    const result = await decide(
      owned,
      { taskId: owned.task.id, status: 'open' },
      rpc,
      deps({ stopForStatus })
    );
    expect(stopForStatus).toHaveBeenCalledWith(
      spaceId,
      owned.task.id,
      { status: 'open' },
      { expectedStatus: owned.task.status, expectedWorkflowRunId: owned.task.workflowRunId }
    );
    expect(result).toEqual({ reason: stopped });
  });
});

describe('writeStatus', () => {
  test('writes the status and emits once', async () => {
    const owned = createOwned('open');
    const decided = { ...owned, approvalSource: undefined, allowActiveRun: false };
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'in_progress' },
      deps()
    );
    expect(result).toMatchObject({ id: owned.task.id, status: 'in_progress' });
    expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
  });

  test('a direct attempt claimed after admission still blocks the write', async () => {
    const owned = createOwned('open');
    const decided = { ...owned, approvalSource: undefined, allowActiveRun: false };
    attempts.select(owned.task.id);
    attempts.claim(owned.task.id, 'attempt', 'worker');
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'in_progress' },
      deps()
    );
    expect(result).toBe('invalid_transition');
    expect(tasks.getTask(owned.task.id)?.status).toBe('open');
  });

  test('a workflow run activated after admission still blocks the write', async () => {
    const run = createWorkflowRun();
    const owned = createOwned('open', run.id);
    const decided = { ...owned, approvalSource: undefined, allowActiveRun: false };
    isWorkflowRunActive.mockImplementation(() => true);
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'in_progress' },
      deps()
    );
    expect(result).toBe('invalid_transition');
    expect(tasks.getTask(owned.task.id)?.status).toBe('open');
  });

  test('a reopen out of review writes beside the live run', async () => {
    const run = createWorkflowRun();
    const owned = createOwned('review', run.id);
    const decided = { ...owned, approvalSource: undefined, allowActiveRun: true };
    isWorkflowRunActive.mockImplementation(() => true);
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'in_progress' },
      deps()
    );
    expect(result).toMatchObject({ id: owned.task.id, status: 'in_progress' });
  });

  test('an rpc cancellation with a live run is still blocked', async () => {
    const run = createWorkflowRun();
    const owned = createOwned('review', run.id);
    const decided = { ...owned, approvalSource: undefined, allowActiveRun: false };
    isWorkflowRunActive.mockImplementation(() => true);
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'cancelled' },
      deps()
    );
    expect(result).toBe('invalid_transition');
    expect(tasks.getTask(owned.task.id)?.status).toBe('review');
  });

  test('a stale-guard error maps to invalid_transition', async () => {
    const owned = createOwned('open');
    const decided = { ...owned, approvalSource: undefined, allowActiveRun: false };
    const staleManager = managerStub({
      setTaskStatus: async () => {
        throw new StaleTaskGuardError('stale');
      },
    });
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'in_progress' },
      deps({ getTaskManager: () => staleManager })
    );
    expect(result).toBe('invalid_transition');
  });

  test('an unrelated error rethrows', async () => {
    const owned = createOwned('open');
    const decided = { ...owned, approvalSource: undefined, allowActiveRun: false };
    const brokenManager = managerStub({
      setTaskStatus: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      writeStatus(
        decided,
        { taskId: owned.task.id, status: 'in_progress' },
        deps({ getTaskManager: () => brokenManager })
      )
    ).rejects.toThrow('boom');
  });
});

describe('the review edge', () => {
  test('a running direct attempt submits through the durable outcome queue', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    attempts.select(task.id);
    attempts.claim(task.id, 'attempt', 'worker');
    attempts.activate('attempt', 'worker');
    tasks.updateTask(task.id, { status: 'in_progress', taskAgentSessionId: 'worker' });
    const requestDirectOutcome = mock(() => ({ accepted: true as const, jobId: 'job-1' }));

    const result = await invoke({ taskId: task.id, status: 'review', reviewReason: 'Ready' }, rpc, {
      requestDirectOutcome,
    });

    expect(result).toEqual({ kind: 'completed', value: { accepted: true, jobId: 'job-1' } });
    expect(requestDirectOutcome).toHaveBeenCalledWith({
      attemptId: 'attempt',
      sessionId: 'worker',
      generation: 1,
      status: 'review',
      reviewReason: 'Ready',
    });
    expect(tasks.getTask(task.id)?.status).toBe('in_progress');
  });

  test('a Space-owned task stamps the pending-completion checkpoint synchronously', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    tasks.updateTask(task.id, { status: 'in_progress', workflowRunId: createWorkflowRun().id });

    const result = await invoke({ taskId: task.id, status: 'review', reviewReason: 'Ready' }, rpc);

    expect(result).toEqual({ kind: 'completed', value: { accepted: true, jobId: null } });
    expect(tasks.getTask(task.id)).toMatchObject({
      status: 'review',
      pendingCheckpointType: 'task_completion',
      pendingCompletionReason: 'Ready',
    });
    expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
  });

  test('a task already in review refreshes its task_completion checkpoint', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    tasks.updateTask(task.id, { status: 'in_progress', workflowRunId: createWorkflowRun().id });
    await invoke({ taskId: task.id, status: 'review', reviewReason: 'First' }, rpc);

    const result = await invoke({ taskId: task.id, status: 'review', reviewReason: 'Second' }, rpc);

    expect(result).toEqual({ kind: 'completed', value: { accepted: true, jobId: null } });
    expect(tasks.getTask(task.id)).toMatchObject({
      status: 'review',
      pendingCompletionReason: 'Second',
    });
  });

  test('a queued direct start on a plain task is not submittable', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    attempts.select(task.id);
    attempts.claim(task.id, 'attempt', 'worker');

    const result = await invoke({ taskId: task.id, status: 'review' }, rpc);

    expect(result).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'review_submission_unavailable' },
    });
    expect(tasks.getTask(task.id)?.status).toBe('open');
  });

  test('a done task cannot be walked back into review', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    tasks.updateTask(task.id, { status: 'done' });

    expect(await invoke({ taskId: task.id, status: 'review' }, rpc)).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'review_submission_invalid_transition' },
    });
    expect(tasks.getTask(task.id)?.status).toBe('done');
  });

  test('an archived task cannot be submitted for review', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    tasks.updateTask(task.id, { archivedAt: Date.now() });

    expect(await invoke({ taskId: task.id, status: 'review' }, rpc)).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'review_submission_unavailable' },
    });
  });

  test('an MCP caller outside the owning Space is denied', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    tasks.updateTask(task.id, { status: 'in_progress', workflowRunId: createWorkflowRun().id });
    const outsider = worker('outsider', 'another-space');

    expect(await invoke({ taskId: task.id, status: 'review' }, outsider)).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'task_transition_denied' },
    });
    expect(tasks.getTask(task.id)?.status).toBe('in_progress');
  });

  test('a reviewReason is rejected unless the target status is review', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });

    expect(
      await invoke({ taskId: task.id, status: 'in_progress', reviewReason: 'Ready' }, rpc)
    ).toEqual({ kind: 'completed', value: 'review_reason_requires_review' });
  });
});
