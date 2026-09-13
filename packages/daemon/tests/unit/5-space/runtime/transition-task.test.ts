import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SpaceTaskStatus } from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import {
  SpaceTaskManager,
  StaleTaskGuardError,
} from '../../../../src/lib/space/managers/space-task-manager';
import {
  createSpaceTransitionTaskOperation,
  decide,
  type SpaceTransitionTaskDependencies,
  writeStatus,
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
      throw new StaleTaskGuardError(`Task ${task.id} is no longer 'open'`);
    },
  };
  const result = await invoke({ taskId: task.id, status: 'in_progress' }, rpc, {
    getTaskManager: () => staleManager,
  });
  expect(result).toEqual({ kind: 'completed', value: 'invalid_transition' });
});

test('an unrelated failure that merely mentions "is no longer" is not misclassified', async () => {
  const task = tasks.createTask({ spaceId, title: 'T', description: '' });
  const brokenManager: Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'> = {
    getTask: async (id) => tasks.getTask(id),
    setTaskStatus: async () => {
      throw new Error(`Session worker-1 is no longer alive`);
    },
  };
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
  const staleManager: Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'> = {
    getTask: async (id) => tasks.getTask(id),
    setTaskStatus,
  };
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
    expect(result).toEqual({ value: { ...owned, approvalSource } });
  });

  test.each([
    ['requesting review directly is unsupported', 'open', 'review', 'unsupported_status'],
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
    expect(parkStopped).toHaveBeenCalledWith(spaceId, owned.task.id);
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
    expect(recoverTransition).toHaveBeenCalledWith(spaceId, owned.task.id, 'in_progress');
    expect(result).toEqual({ reason: recovered });
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
    expect(stopForStatus).toHaveBeenCalledWith(spaceId, owned.task.id, { status: 'open' });
    expect(result).toEqual({ reason: stopped });
  });
});

describe('writeStatus', () => {
  test('writes the status and emits once', async () => {
    const owned = createOwned('open');
    const decided = { ...owned, approvalSource: undefined };
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
    const decided = { ...owned, approvalSource: undefined };
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
    const decided = { ...owned, approvalSource: undefined };
    isWorkflowRunActive.mockImplementation(() => true);
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'in_progress' },
      deps()
    );
    expect(result).toBe('invalid_transition');
    expect(tasks.getTask(owned.task.id)?.status).toBe('open');
  });

  test('a stale-guard error maps to invalid_transition', async () => {
    const owned = createOwned('open');
    const decided = { ...owned, approvalSource: undefined };
    const staleManager: Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'> = {
      getTask: async (id) => tasks.getTask(id),
      setTaskStatus: async () => {
        throw new StaleTaskGuardError('stale');
      },
    };
    const result = await writeStatus(
      decided,
      { taskId: owned.task.id, status: 'in_progress' },
      deps({ getTaskManager: () => staleManager })
    );
    expect(result).toBe('invalid_transition');
  });

  test('an unrelated error rethrows', async () => {
    const owned = createOwned('open');
    const decided = { ...owned, approvalSource: undefined };
    const brokenManager: Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'> = {
      getTask: async (id) => tasks.getTask(id),
      setTaskStatus: async () => {
        throw new Error('boom');
      },
    };
    await expect(
      writeStatus(
        decided,
        { taskId: owned.task.id, status: 'in_progress' },
        deps({ getTaskManager: () => brokenManager })
      )
    ).rejects.toThrow('boom');
  });
});
