import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createSpaceTables } from '../../helpers/space-test-db';
import {
  createDirectAttemptStopper,
  directSessionIsDown,
  requireDirectStopTarget,
  verifyDirectAttemptStop,
} from '../../../../src/lib/space/runtime/stop-direct-attempt';

let sql: Database;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let taskId: string;
let spaceId: string;
let cached: AgentSession | null;
let live: number[];
let loading: boolean;
let cleanup: ReturnType<typeof mock>;
let interrupt: ReturnType<typeof mock>;
let unregister: ReturnType<typeof mock>;
const input = { attemptId: 'attempt', sessionId: 'session', outcome: 'cancelled' };
function agent(owner = taskId): AgentSession {
  return {
    getSessionData: () => ({
      id: 'session',
      type: 'worker',
      status: 'active',
      context: { taskId: owner, spaceId },
    }),
    getProcessingState: () => ({ status: 'idle' }),
    isInterruptInProgress: () => false,
    getTrackedAgentRootPidsSplit: () => ({ live, exited: [] }),
    handleInterrupt: interrupt,
    cleanup,
  } as unknown as AgentSession;
}
function stopper(repository = attempts) {
  return createDirectAttemptStopper({
    attempts: repository,
    tasks,
    sessionManager: {
      getCachedSession: () => cached,
      isSessionLoading: () => loading,
      unregisterSession: unregister,
    },
  });
}
beforeEach(() => {
  sql = new Database(':memory:');
  createSpaceTables(sql);
  spaceId = new SpaceRepository(sql).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(sql);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  attempts = new DirectTaskExecutionRepository(sql);
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'session');
  cached = null;
  live = [];
  loading = false;
  cleanup = mock(async () => {});
  interrupt = mock(async () => {});
  unregister = mock(async (_id: string, expected: AgentSession) => {
    if (cached === expected) cached = null;
  });
});
afterEach(() => sql.close());

test('inert factory, exact target gates and reserved crash recovery retain history', async () => {
  const stop = stopper();
  expect(attempts.isStopRequested('attempt', 'session')).toBe(false);
  expect(requireDirectStopTarget(null, input)).toHaveProperty('reason');
  expect(await stop({ ...input, sessionId: 'foreign' })).toEqual({
    stopped: false,
    reason: 'unavailable',
  });
  expect(await stop(input)).toMatchObject({
    stopped: true,
    attempt: { phase: 'stopped', outcome: 'cancelled' },
  });
  expect(await stop({ ...input, outcome: 'different' })).toMatchObject({
    stopped: true,
    attempt: { outcome: 'cancelled' },
  });
  expect(attempts.claim(taskId, 'next', 'next-session')?.generation).toBe(2);
  expect(await stop(input)).toHaveProperty('stopped', true);
  expect(attempts.getActive(taskId)?.id).toBe('next');
  expect(interrupt).not.toHaveBeenCalled();
});

test('durable request blocks activation and replacement without releasing ownership', () => {
  expect(attempts.requestStop('attempt', 'session', 'cancelled')?.phase).toBe('reserved');
  expect(attempts.activate('attempt', 'session')).toBeNull();
  expect(attempts.claim(taskId, 'next', 'next-session')).toBeNull();
  attempts.requestStop('attempt', 'session', 'other');
  expect(attempts.finishRequestedStop('attempt', 'foreign', 1)).toBeNull();
  expect(attempts.finishRequestedStop('attempt', 'session', 1)?.outcome).toBe('cancelled');
});

test('activation between initial read and fence is treated as running, never absent-reserved', async () => {
  const requestStop = attempts.requestStop.bind(attempts);
  attempts.requestStop = (id, sessionId, outcome) => {
    expect(attempts.activate(id, sessionId)?.phase).toBe('running');
    return requestStop(id, sessionId, outcome);
  };
  expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(attempts.claim(taskId, 'next', 'next-session')).toBeNull();
});

test('running ownership survives deferred cleanup and releases only after verified unregister', async () => {
  attempts.activate('attempt', 'session');
  cached = agent();
  const expected = cached;
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  cleanup.mockImplementation(async () => {
    enter();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const stopping = stopper()(input);
  await entered;
  expect(attempts.isStopRequested('attempt', 'session')).toBe(true);
  expect(attempts.claim(taskId, 'next', 'next-session')).toBeNull();
  expect(unregister).not.toHaveBeenCalled();
  release();
  expect(await stopping).toHaveProperty('stopped', true);
  expect(interrupt).toHaveBeenCalledWith({ skipDeferredReplay: true });
  expect(unregister).toHaveBeenCalledWith('session', expected);
  expect(attempts.claim(taskId, 'next', 'next-session')).not.toBeNull();
});

test('live processes and failed cleanup retain ownership for a safe retry', async () => {
  attempts.activate('attempt', 'session');
  cached = agent();
  live = [123];
  expect(directSessionIsDown(cached)).toBe(false);
  expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
  expect(unregister).not.toHaveBeenCalled();
  live = [];
  loading = false;
  cleanup.mockRejectedValueOnce(new Error('cleanup failed'));
  expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
  expect(attempts.getActive(taskId)?.id).toBe('attempt');
  expect(await stopper()(input)).toHaveProperty('stopped', true);
});

test('foreign session and replacement during unregister are not released as verified', async () => {
  attempts.activate('attempt', 'session');
  cached = agent('foreign');
  expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
  expect(interrupt).not.toHaveBeenCalled();
  cached = agent();
  const replacement = agent();
  unregister.mockImplementation(async () => {
    cached = replacement;
  });
  expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
  expect(cached).toBe(replacement);
  expect(attempts.getActive(taskId)?.id).toBe('attempt');
});

test('reserved load retains claim until its late object is cleaned and verified', async () => {
  loading = true;
  expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
  expect(attempts.claim(taskId, 'next', 'next-session')).toBeNull();
  cached = agent();
  loading = false;
  expect(await stopper()(input)).toHaveProperty('stopped', true);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(attempts.claim(taskId, 'next', 'next-session')).not.toBeNull();
});

test.each(['inactive', 'workflow', 'pointer'] as const)(
  'trusted identity rejects %s ownership before interruption',
  async (state) => {
    cached = agent();
    if (state === 'inactive') {
      const row = cached.getSessionData();
      cached.getSessionData = () => ({ ...row, status: 'archived' });
    } else {
      const task = tasks.getTask(taskId)!;
      const getTask = tasks.getTask.bind(tasks);
      tasks.getTask = (id) =>
        id === taskId
          ? {
              ...task,
              ...(state === 'workflow'
                ? { workflowRunId: 'run' }
                : { taskAgentSessionId: 'other' }),
            }
          : getTask(id);
    }
    expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(attempts.getActive(taskId)?.id).toBe('attempt');
  }
);

test('verification requires a durable fence and retains ownership after exact session cleanup', async () => {
  attempts.activate('attempt', 'session');
  cached = agent();
  const expected = cached;
  const manager = {
    getCachedSession: () => cached,
    isSessionLoading: () => loading,
    unregisterSession: unregister,
  };
  const attempt = attempts.get('attempt')!;
  expect(await verifyDirectAttemptStop(attempts, tasks, manager, attempt)).toHaveProperty('reason');
  expect(interrupt).not.toHaveBeenCalled();
  expect(attempts.recordStopVerification('attempt', 'session', attempt.generation)).toBe(false);
  attempts.requestStop('attempt', 'session', 'cancelled');
  const verified = await verifyDirectAttemptStop(attempts, tasks, manager, attempt);
  expect(verified).toEqual({ value: { attempt: attempts.get('attempt'), session: expected } });
  expect(cached).toBeNull();
  expect(attempts.getActive(taskId)?.id).toBe('attempt');
  expect(attempts.claim(taskId, 'next', 'next-session')).toBeNull();
});

test('verification rechecks persisted phase rather than trusting a stale reserved snapshot', async () => {
  const reserved = attempts.get('attempt')!;
  attempts.activate('attempt', 'session');
  attempts.requestStop('attempt', 'session', 'cancelled');
  const manager = {
    getCachedSession: () => cached,
    isSessionLoading: () => loading,
    unregisterSession: unregister,
  };
  expect(await verifyDirectAttemptStop(attempts, tasks, manager, reserved)).toEqual({
    reason: { stopped: false, reason: 'unverified' },
  });
  expect(attempts.getActive(taskId)?.phase).toBe('running');
});

test('release rechecks cache after verification yields to the next pipeline stage', async () => {
  attempts.activate('attempt', 'session');
  cached = agent();
  const replacement = agent();
  let reads = 0;
  const stop = createDirectAttemptStopper({
    attempts,
    tasks,
    sessionManager: {
      getCachedSession: () => {
        if (++reads === 2)
          queueMicrotask(() => {
            cached = replacement;
          });
        return cached;
      },
      isSessionLoading: () => loading,
      unregisterSession: unregister,
    },
  });
  expect(await stop(input)).toEqual({ stopped: false, reason: 'unverified' });
  expect(cached).toBe(replacement);
  expect(attempts.getActive(taskId)?.id).toBe('attempt');
});

test('a finalization failure retries from durable exact verification without a cached session', async () => {
  attempts.activate('attempt', 'session');
  cached = agent();
  const finish = attempts.finishRequestedStop.bind(attempts);
  attempts.finishRequestedStop = () => {
    throw new Error('finalization failed');
  };
  await expect(stopper()(input)).rejects.toThrow('finalization failed');
  expect(cached).toBeNull();
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(attempts.hasStopVerification('attempt', 'session', 1)).toBe(true);
  expect(attempts.hasStopVerification('attempt', 'session', 2)).toBe(false);
  attempts.finishRequestedStop = finish;
  expect(await stopper()(input)).toHaveProperty('stopped', true);
});

test('a reloaded live session invalidates prior proof before failed verification', async () => {
  attempts.activate('attempt', 'session');
  attempts.requestStop('attempt', 'session', 'cancelled');
  cached = agent();
  const manager = {
    getCachedSession: () => cached,
    isSessionLoading: () => loading,
    unregisterSession: unregister,
  };
  expect(
    await verifyDirectAttemptStop(attempts, tasks, manager, attempts.get('attempt')!)
  ).toHaveProperty('value');
  cached = agent();
  live = [999];
  expect(
    await verifyDirectAttemptStop(attempts, tasks, manager, attempts.get('attempt')!)
  ).toHaveProperty('reason');
  expect(attempts.hasStopVerification('attempt', 'session', 1)).toBe(false);
  cached = null;
  expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
});

test('successful verification survives database reopen without trusting arbitrary missing sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'verified-stop-'));
  const path = join(directory, 'test.db');
  let disk = new Database(path);
  try {
    createSpaceTables(disk);
    const owner = new SpaceRepository(disk).createSpace({
      name: 'Owner',
      slug: 'owner',
      workspacePath: '/repo',
    });
    let diskTasks = new SpaceTaskRepository(disk);
    const task = diskTasks.createTask({ spaceId: owner.id, title: 'Task', description: '' });
    let diskAttempts = new DirectTaskExecutionRepository(disk);
    diskAttempts.select(task.id);
    diskAttempts.claim(task.id, 'disk-attempt', 'disk-session');
    diskAttempts.activate('disk-attempt', 'disk-session');
    diskAttempts.requestStop('disk-attempt', 'disk-session', 'cancelled');
    const session = agent();
    session.getSessionData = () =>
      ({
        id: 'disk-session',
        type: 'worker',
        status: 'active',
        context: { taskId: task.id, spaceId: owner.id },
      }) as ReturnType<AgentSession['getSessionData']>;
    let loaded: AgentSession | null = session;
    const manager = {
      getCachedSession: () => loaded,
      isSessionLoading: () => false,
      unregisterSession: async () => {
        loaded = null;
      },
    };
    expect(
      await verifyDirectAttemptStop(
        diskAttempts,
        diskTasks,
        manager,
        diskAttempts.get('disk-attempt')!
      )
    ).toHaveProperty('value');
    disk.close();
    disk = new Database(path);
    diskAttempts = new DirectTaskExecutionRepository(disk);
    diskTasks = new SpaceTaskRepository(disk);
    expect(
      await verifyDirectAttemptStop(
        diskAttempts,
        diskTasks,
        manager,
        diskAttempts.get('disk-attempt')!
      )
    ).toHaveProperty('value');
    expect(
      await createDirectAttemptStopper({
        attempts: diskAttempts,
        tasks: diskTasks,
        sessionManager: manager,
      })({ attemptId: 'disk-attempt', sessionId: 'disk-session', outcome: 'cancelled' })
    ).toHaveProperty('stopped', true);
  } finally {
    disk.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['replacement', 'loading', 'live', 'throw', 'probe-throw'] as const)(
  'failed post-unregister verification %s invalidates durable proof before a missing-cache retry',
  async (failure) => {
    attempts.activate('attempt', 'session');
    attempts.requestStop('attempt', 'session', 'cancelled');
    cached = agent();
    const stoppedSession = cached;
    unregister.mockImplementation(async () => {
      await Promise.resolve();
      if (failure === 'replacement') cached = agent();
      else cached = null;
      if (failure === 'loading') loading = true;
      if (failure === 'live') live = [999];
      if (failure === 'throw') throw new Error('unregister failed');
      if (failure === 'probe-throw')
        stoppedSession.getProcessingState = () => {
          throw new Error('probe failed');
        };
    });
    const manager = {
      getCachedSession: () => cached,
      isSessionLoading: () => loading,
      unregisterSession: unregister,
    };
    expect(
      await verifyDirectAttemptStop(attempts, tasks, manager, attempts.get('attempt')!)
    ).toHaveProperty('reason');
    expect(attempts.hasStopVerification('attempt', 'session', 1)).toBe(false);
    cached = null;
    loading = false;
    live = [];
    expect(await stopper()(input)).toEqual({ stopped: false, reason: 'unverified' });
    expect(attempts.getActive(taskId)?.id).toBe('attempt');
  }
);

test('SQL release requires exact generation proof for running attempts', () => {
  attempts.activate('attempt', 'session');
  attempts.requestStop('attempt', 'session', 'cancelled');
  expect(attempts.finishRequestedStop('attempt', 'session', 1)).toBeNull();
  expect(attempts.recordStopVerification('attempt', 'session', 1)).toBe(true);
  expect(attempts.finishRequestedStop('attempt', 'session', 2)).toBeNull();
  attempts.clearStopVerification('attempt', 'session');
  expect(attempts.finishRequestedStop('attempt', 'session', 1)).toBeNull();
  expect(attempts.getActive(taskId)?.phase).toBe('running');
});

test('proof invalidated between verification and release prevents empty-cache finalization', async () => {
  attempts.activate('attempt', 'session');
  cached = agent();
  let reads = 0;
  const stop = createDirectAttemptStopper({
    attempts,
    tasks,
    sessionManager: {
      getCachedSession: () => {
        if (++reads === 2)
          queueMicrotask(() => attempts.clearStopVerification('attempt', 'session'));
        return cached;
      },
      isSessionLoading: () => loading,
      unregisterSession: unregister,
    },
  });
  expect(await stop(input)).toEqual({ stopped: false, reason: 'unavailable' });
  expect(cached).toBeNull();
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(attempts.claim(taskId, 'next', 'next-session')).toBeNull();
});
