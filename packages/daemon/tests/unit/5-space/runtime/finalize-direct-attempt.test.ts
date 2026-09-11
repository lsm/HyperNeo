import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  createDirectTaskFinalizer,
  type DirectFinalizationInput,
} from '../../../../src/lib/space/runtime/finalize-direct-attempt';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let tasks: SpaceTaskRepository;
let attempts: DirectTaskExecutionRepository;
let taskId: string;
let cached: AgentSession | null;
let interrupt: ReturnType<typeof mock>;
let cleanup: ReturnType<typeof mock>;
let terminal: ReturnType<typeof mock>;
let manager: Parameters<typeof createDirectTaskFinalizer>[0]['sessionManager'];
const input: DirectFinalizationInput = {
  attemptId: 'attempt',
  sessionId: 'worker',
  generation: 1,
  status: 'blocked',
  options: { result: 'Failed', blockReason: 'execution_failed' },
};
function finalize(extra: Partial<Parameters<typeof createDirectTaskFinalizer>[0]> = {}) {
  return createDirectTaskFinalizer({
    db,
    sessionManager: manager,
    onTerminalTransition: terminal,
    ...extra,
  });
}
beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  const spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  attempts = new DirectTaskExecutionRepository(db);
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'worker');
  expect(attempts.activate('attempt', 'worker')?.phase).toBe('running');
  tasks.updateTask(taskId, { status: 'in_progress', taskAgentSessionId: 'worker' });
  interrupt = mock(async () => {});
  cleanup = mock(async () => {});
  terminal = mock(() => {});
  cached = {
    getSessionData: () => ({
      id: 'worker',
      type: 'worker',
      status: 'active',
      context: { taskId, spaceId },
    }),
    getProcessingState: () => ({ status: 'idle' }),
    isInterruptInProgress: () => false,
    getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
    handleInterrupt: (...args: unknown[]) => interrupt(...args),
    cleanup: () => cleanup(),
  } as unknown as AgentSession;
  const owner = Object.assign(Object.create(SessionManager.prototype), {
    directStopVerificationJobs: new Map(),
  }) as SessionManager;
  manager = {
    coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
    getCachedSession: () => cached,
    isSessionLoading: () => false,
    unregisterSession: async (_id, expected) => {
      if (cached === expected) cached = null;
    },
  };
});
afterEach(() => db.close());

test('request is durable before shutdown and task/attempt commit together', async () => {
  interrupt.mockImplementation(async () => {
    const row = db
      .prepare('SELECT finalization_json AS payload FROM direct_task_stop_requests')
      .get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({
      status: 'blocked',
      fromStatus: 'in_progress',
      generation: 1,
    });
    expect(tasks.getTask(taskId)?.status).toBe('in_progress');
    expect(attempts.getActive(taskId)?.phase).toBe('running');
  });
  terminal.mockImplementation(() => {
    expect(tasks.getTask(taskId)?.status).toBe('blocked');
    expect(attempts.get('attempt')?.phase).toBe('stopped');
  });
  const result = await finalize()(input);
  expect(result).toMatchObject({
    finalized: true,
    task: { status: 'blocked', result: 'Failed', blockReason: 'execution_failed' },
    attempt: { phase: 'stopped', outcome: 'blocked' },
  });
  expect(terminal).toHaveBeenCalledWith(taskId, 'in_progress');
  expect(await finalize()(input)).toEqual(result);
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(terminal).toHaveBeenCalledTimes(1);
});

test('callback failure rolls back both writes and retry reuses verified shutdown', async () => {
  terminal.mockImplementation(() => {
    throw new Error('callback failed');
  });
  const abort = mock(() => {});
  const commit = mock(() => {});
  const reactiveDb = {
    beginTransaction: mock(() => {}),
    commitTransaction: commit,
    abortTransaction: abort,
    notifyChange: mock(() => {}),
  } as unknown as ReactiveDatabase;
  await expect(finalize({ reactiveDb })(input)).rejects.toThrow('callback failed');
  expect(tasks.getTask(taskId)?.status).toBe('in_progress');
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(attempts.hasStopVerification('attempt', 'worker', 1)).toBe(true);
  expect(cached).toBeNull();
  expect(abort).toHaveBeenCalledTimes(1);
  expect(commit).not.toHaveBeenCalled();
  terminal.mockImplementation(() => {});
  commit.mockImplementation(() => {
    expect(tasks.getTask(taskId)?.status).toBe('blocked');
    expect(attempts.getActive(taskId)).toBeNull();
  });
  expect(await finalize({ reactiveDb })(input)).toHaveProperty('finalized', true);
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledTimes(1);
});

test('failed shutdown retains ownership and rejects a changed frozen request', async () => {
  cleanup.mockImplementation(async () => {
    throw new Error('still active');
  });
  expect(await finalize()(input)).toEqual({ finalized: false, reason: 'unverified' });
  expect(attempts.getActive(taskId)?.id).toBe('attempt');
  expect(await finalize()({ ...input, status: 'cancelled' })).toEqual({
    finalized: false,
    reason: 'unavailable',
  });
  cleanup.mockImplementation(async () => {});
  expect(await finalize()(input)).toHaveProperty('finalized', true);
});

for (const change of ['status', 'pointer', 'token'] as const) {
  test(`rejects changed ${change} between shutdown and finalization`, async () => {
    const unregister = manager.unregisterSession;
    manager.unregisterSession = async (...args) => {
      await unregister(...args);
      if (change === 'status') tasks.updateTask(taskId, { status: 'review' });
      if (change === 'pointer') tasks.updateTask(taskId, { taskAgentSessionId: 'other' });
      if (change === 'token') attempts.beginStopVerification('attempt', 'worker', 1, 'new-owner');
    };
    expect(await finalize()(input)).toEqual({
      finalized: false,
      reason: change === 'token' ? 'unavailable' : 'superseded',
    });
    expect(attempts.get('attempt')?.phase).toBe(change === 'token' ? 'running' : 'stopped');
    expect(tasks.getTask(taskId)?.status).toBe(change === 'status' ? 'review' : 'in_progress');
    expect(terminal).not.toHaveBeenCalled();
  });
}

test('wrong generation and existing unrelated stop request cannot initiate task finalization', async () => {
  expect(await finalize()({ ...input, generation: 2 })).toEqual({
    finalized: false,
    reason: 'unavailable',
  });
  expect(attempts.isStopRequested('attempt', 'worker')).toBe(false);
  attempts.requestStop('attempt', 'worker', 'cancelled');
  expect(await finalize()(input)).toEqual({ finalized: false, reason: 'unavailable' });
  expect(interrupt).not.toHaveBeenCalled();
});

test('review releases execution without treating SDK idle or review as completion', async () => {
  expect(tasks.getTask(taskId)?.status).toBe('in_progress');
  expect(
    await finalize()({
      ...input,
      status: 'review',
      reviewReason: 'Ready',
      options: { reportedSummary: 'Finished work' },
    })
  ).toMatchObject({
    finalized: true,
    task: {
      status: 'review',
      pendingCheckpointType: 'task_completion',
      pendingCompletionGeneration: 1,
      pendingCompletionSubmittedByNodeId: null,
      postApprovalSourceNodeId: null,
      pendingCompletionReason: 'Ready',
      reportedSummary: 'Finished work',
    },
  });
  expect(tasks.getTask(taskId)?.pendingCompletionSubmittedAt).toBeGreaterThan(0);
  expect(terminal).not.toHaveBeenCalled();
});

test('separate concurrent finalizers share shutdown and publish terminal transition once', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  cleanup.mockImplementation(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const first = finalize()(input);
  await started;
  const second = finalize()({
    ...input,
    options: { blockReason: 'execution_failed', result: 'Failed' },
  });
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toHaveProperty('finalized', true);
  expect(b).toEqual(a);
  expect(terminal).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test('review checkpoint generation rolls back with attempt release and increments only on retry commit', async () => {
  const reactiveDb = {
    beginTransaction: () => {},
    commitTransaction: () => {},
    abortTransaction: () => {},
    notifyChange: () => {
      throw new Error('notification staging failed');
    },
  } as unknown as ReactiveDatabase;
  const review: DirectFinalizationInput = { ...input, status: 'review' };
  await expect(finalize({ reactiveDb })(review)).rejects.toThrow('notification staging failed');
  expect(tasks.getTask(taskId)).toMatchObject({
    status: 'in_progress',
    pendingCompletionGeneration: 0,
  });
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(await finalize()(review)).toMatchObject({
    finalized: true,
    task: { pendingCompletionGeneration: 1 },
  });
  expect(await finalize()(review)).toMatchObject({
    finalized: true,
    task: { pendingCompletionGeneration: 1 },
  });
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test('blocked to review runs reopened bookkeeping inside the atomic finalization', async () => {
  tasks.updateTask(taskId, { status: 'blocked' });
  const onTaskReopened = mock(() => {
    expect(tasks.getTask(taskId)?.status).toBe('review');
    expect(attempts.get('attempt')?.phase).toBe('stopped');
    throw new Error('reopened bookkeeping failed');
  });
  const review: DirectFinalizationInput = { ...input, status: 'review' };
  await expect(finalize({ onTaskReopened })(review)).rejects.toThrow('reopened bookkeeping failed');
  expect(tasks.getTask(taskId)?.status).toBe('blocked');
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  onTaskReopened.mockImplementation(() => {});
  expect(await finalize({ onTaskReopened })(review)).toHaveProperty('finalized', true);
  expect(onTaskReopened).toHaveBeenLastCalledWith(taskId);
});

for (const cycle of ['status', 'session'] as const) {
  test(`rejects same-clock ${cycle} ABA before finalization and on retry`, async () => {
    const unregister = manager.unregisterSession;
    manager.unregisterSession = async (...args) => {
      await unregister(...args);
      const timestamp = tasks.getTask(taskId)!.updatedAt;
      if (cycle === 'status') {
        db.prepare("UPDATE space_tasks SET status = 'open' WHERE id = ?").run(taskId);
        db.prepare("UPDATE space_tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
      } else {
        tasks.updateTask(taskId, { taskAgentSessionId: 'replacement' });
        tasks.updateTask(taskId, { taskAgentSessionId: 'worker' });
      }
      db.prepare('UPDATE space_tasks SET updated_at = ? WHERE id = ?').run(timestamp, taskId);
    };
    expect(await finalize()(input)).toEqual({ finalized: false, reason: 'superseded' });
    expect(await finalize()(input)).toEqual({ finalized: false, reason: 'superseded' });
    expect(tasks.getTask(taskId)?.status).toBe('in_progress');
    expect(attempts.getActive(taskId)).toBeNull();
    expect(terminal).not.toHaveBeenCalled();
  });
}

test('completed idempotence rejects a later lifecycle cycle back to the same status', async () => {
  expect(await finalize()(input)).toHaveProperty('finalized', true);
  tasks.updateTask(taskId, { status: 'open' });
  tasks.updateTask(taskId, { status: 'blocked' });
  expect(await finalize()(input)).toEqual({ finalized: false, reason: 'unavailable' });
  expect(terminal).toHaveBeenCalledTimes(1);
});

test('another stopper plus matching task status cannot impersonate atomic finalization', async () => {
  const unregister = manager.unregisterSession;
  manager.unregisterSession = async (...args) => {
    await unregister(...args);
    const proof = attempts.getStopVerification('attempt', 'worker')!;
    attempts.finishRequestedStop('attempt', 'worker', 1, proof.token!);
    tasks.updateTask(taskId, { status: 'blocked', result: 'Independent result' });
  };
  expect(await finalize()(input)).toEqual({ finalized: false, reason: 'unavailable' });
  expect(await finalize()(input)).toEqual({ finalized: false, reason: 'unavailable' });
  expect(tasks.getTask(taskId)?.result).toBe('Independent result');
  expect(terminal).not.toHaveBeenCalled();
});

test('superseded release retries after transaction failure without touching replacement ownership', async () => {
  db.exec(`CREATE TRIGGER reject_superseded BEFORE UPDATE OF finalization_state ON direct_task_stop_requests
    WHEN NEW.finalization_state = 'superseded' BEGIN SELECT RAISE(ABORT, 'retry finalization'); END;`);
  const unregister = manager.unregisterSession;
  manager.unregisterSession = async (...args) => {
    await unregister(...args);
    tasks.updateTask(taskId, { status: 'open', taskAgentSessionId: 'replacement' });
  };
  await expect(finalize()(input)).rejects.toThrow('retry finalization');
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(attempts.hasStopVerification('attempt', 'worker', 1)).toBe(true);
  expect(cached).toBeNull();
  db.exec('DROP TRIGGER reject_superseded');
  expect(await finalize()(input)).toEqual({ finalized: false, reason: 'superseded' });
  expect(tasks.getTask(taskId)).toMatchObject({
    status: 'open',
    taskAgentSessionId: 'replacement',
  });
  expect(attempts.claim(taskId, 'next', 'replacement')?.generation).toBe(2);
  expect(await finalize()(input)).toEqual({ finalized: false, reason: 'superseded' });
  expect(attempts.getActive(taskId)?.id).toBe('next');
  expect(cleanup).toHaveBeenCalledTimes(1);
});
