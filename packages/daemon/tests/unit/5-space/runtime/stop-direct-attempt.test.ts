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
} from '../../../../src/lib/space/runtime/stop-direct-attempt';

let sql: Database;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let taskId: string;
let spaceId: string;
let cached: AgentSession | null;
let live: number[];
let cleanup: ReturnType<typeof mock>;
let interrupt: ReturnType<typeof mock>;
let unregister: ReturnType<typeof mock>;
const input = { attemptId: 'attempt', sessionId: 'session', outcome: 'cancelled' };
function agent(owner = taskId): AgentSession {
  return {
    getSessionData: () => ({ id: 'session', type: 'worker', context: { taskId: owner, spaceId } }),
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
    sessionManager: { getCachedSession: () => cached, unregisterSession: unregister },
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
  expect(attempts.finishRequestedStop('attempt', 'foreign')).toBeNull();
  expect(attempts.finishRequestedStop('attempt', 'session')?.outcome).toBe('cancelled');
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
