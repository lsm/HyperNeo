import { describe, expect, jest, test } from 'bun:test';
import { buildPostApprovalSessionId } from '../../../../src/lib/session/sub-session-identity';
import type {
  SessionResolutionDeps,
  WorkerExecutionSession,
} from '../../../../src/lib/session-resolution/deps';
import {
  activateStage,
  awaitSessionStage,
  crashHandler,
  ensureWorkerSession,
  findStage,
  newestWorkerSessionId,
  phaseStage,
  postApprovalStage,
  WORKER_SESSION_POLL_INTERVAL_MS,
  WORKER_SESSION_WAIT_CAP_MS,
  workerSessionPhase,
} from '../../../../src/lib/session-resolution/ensure-worker-session';
import type {
  EnsureSessionOutcome,
  SessionTargetWorker,
} from '../../../../src/lib/session-resolution/target';

const SPACE_ID = 'space-1';
const TASK_ID = 'task-1';
const AGENT_NAME = 'coder';

const workerTarget = (overrides?: Partial<SessionTargetWorker>): SessionTargetWorker => ({
  kind: 'worker',
  taskId: TASK_ID,
  agentName: AGENT_NAME,
  ...overrides,
});

const postApprovalId = buildPostApprovalSessionId(SPACE_ID, TASK_ID, AGENT_NAME);

const buildDeps = (overrides: Partial<SessionResolutionDeps> = {}): SessionResolutionDeps => ({
  getSession: async () => null,
  rehydrateSubSession: async () => null,
  getCoordinator: async () => null,
  ensureLongTermAgent: async () => null,
  listWorkerExecutions: () => [],
  isTaskDone: () => false,
  getTaskSpaceId: async () => SPACE_ID,
  activateTaskAgent: async () => false,
  spawnPostApprovalWorker: async () => null,
  ...overrides,
});

const row = (sessionId: string | null, status: string): WorkerExecutionSession => ({
  sessionId,
  status,
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

async function drainByPolling(
  run: Promise<EnsureSessionOutcome>,
  maxPolls: number
): Promise<EnsureSessionOutcome | undefined> {
  let settled: EnsureSessionOutcome | undefined;
  const recorded = run.then((outcome) => {
    settled = outcome;
  });
  let polls = 0;
  while (settled === undefined && polls < maxPolls) {
    jest.advanceTimersByTime(WORKER_SESSION_POLL_INTERVAL_MS);
    polls += 1;
    await flushMicrotasks();
  }
  await recorded;
  return settled;
}

describe('newestWorkerSessionId', () => {
  test('returns the last live sessionId, skipping cancelled and sessionless rows', () => {
    const rows = [
      row('s-1', 'done'),
      row(null, 'running'),
      row('s-2', 'cancelled'),
      row('s-3', 'running'),
    ];
    expect(newestWorkerSessionId(rows)).toBe('s-3');
  });

  test('skips pending rows even when they retain a stale sessionId', () => {
    expect(newestWorkerSessionId([row('s-stale', 'pending'), row('s-live', 'running')])).toBe(
      's-live'
    );
    expect(newestWorkerSessionId([row('s-stale', 'pending')])).toBeNull();
  });

  test('falls back to an earlier live row when the newest rows do not qualify', () => {
    const rows = [row('s-1', 'done'), row('s-2', 'cancelled'), row(null, 'pending')];
    expect(newestWorkerSessionId(rows)).toBe('s-1');
  });

  test('returns null when no row qualifies', () => {
    expect(newestWorkerSessionId([])).toBeNull();
    expect(newestWorkerSessionId([row(null, 'pending')])).toBeNull();
    expect(newestWorkerSessionId([row('s-1', 'cancelled')])).toBeNull();
  });
});

describe('workerSessionPhase', () => {
  test('done when the task itself is done', () => {
    expect(workerSessionPhase(true)).toBe('done');
  });

  test('run_active when the task is not done', () => {
    expect(workerSessionPhase(false)).toBe('run_active');
  });
});

describe('findStage', () => {
  test('resolves with the newest live sessionId and created:false, passing the target to deps', async () => {
    const seen: SessionTargetWorker[] = [];
    const deps = buildDeps({
      listWorkerExecutions: (target) => {
        seen.push(target);
        return [row('s-1', 'done'), row('s-2', 'running')];
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    const target = workerTarget();
    expect(await findStage(target, deps)).toEqual({
      foundSessionId: 's-2',
      outcome: { kind: 'resolved', sessionId: 's-2', created: false },
    });
    expect(seen).toEqual([target]);
  });

  test('verifies the binding through rehydrateSubSession before resolving', async () => {
    const rehydrated: string[] = [];
    const deps = buildDeps({
      listWorkerExecutions: () => [row('s-stale', 'in_progress')],
      rehydrateSubSession: async (sessionId) => {
        rehydrated.push(sessionId);
        return null;
      },
    });
    expect(await findStage(workerTarget(), deps)).toEqual({
      foundSessionId: undefined,
      outcome: undefined,
    });
    expect(rehydrated).toEqual(['s-stale']);
  });

  test('writes no outcome when no live session exists', async () => {
    const deps = buildDeps({ listWorkerExecutions: () => [row(null, 'pending')] });
    expect(await findStage(workerTarget(), deps)).toEqual({
      foundSessionId: undefined,
      outcome: undefined,
    });
  });
});

describe('phaseStage', () => {
  test('a done task arms only postApprovalStage, reading task state and never the row census', () => {
    const calls: string[] = [];
    const deps = buildDeps({
      isTaskDone: (taskId) => {
        calls.push(`done:${taskId}`);
        return true;
      },
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-idle', 'idle')];
      },
    });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('done');
    expect(result.findArm).toBeUndefined();
    expect(result.postApprovalArm).toBe(postApprovalStage);
    expect(result.activateArm).toBeUndefined();
    expect(calls).toEqual([`done:${TASK_ID}`]);
  });

  test('an active task arms findStage and activateStage and leaves postApprovalStage disarmed', () => {
    const calls: string[] = [];
    const deps = buildDeps({
      isTaskDone: () => {
        calls.push('done');
        return false;
      },
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-idle', 'idle')];
      },
    });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('run_active');
    expect(result.findArm).toBe(findStage);
    expect(result.postApprovalArm).toBeUndefined();
    expect(result.activateArm).toBe(activateStage);
    expect(calls).toEqual(['done']);
  });
});

describe('postApprovalStage', () => {
  test('resolves created:false with the deterministic post-approval id when found', async () => {
    const getSession = async (sessionId: string) =>
      sessionId === postApprovalId ? { id: sessionId } : null;
    const deps = buildDeps({ getSession });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: postApprovalId, created: false });
  });

  test('spawns on a probe miss and resolves created:true with the spawned id', async () => {
    const probed: string[] = [];
    const spawned: Array<[string, string, string | undefined]> = [];
    const deps = buildDeps({
      getSession: async (sessionId) => {
        probed.push(sessionId);
        return null;
      },
      spawnPostApprovalWorker: async (taskId, agentName, workflowNodeId) => {
        spawned.push([taskId, agentName, workflowNodeId]);
        return 'spawned-1';
      },
    });
    const target = workerTarget({ workflowNodeId: 'node-1' });
    const outcome = await postApprovalStage(target, deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'spawned-1', created: true });
    expect(probed).toEqual([postApprovalId]);
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, 'node-1']]);
  });

  test('unresolved spawn_failed when the spawn returns null', async () => {
    const deps = buildDeps({ spawnPostApprovalWorker: async () => null });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'spawn_failed' });
  });

  test('probes the sanitized agent name for uppercase and punctuated workers', async () => {
    const sanitizedId = buildPostApprovalSessionId(SPACE_ID, TASK_ID, 'devin-reviewer');
    const probed: string[] = [];
    const deps = buildDeps({
      getSession: async (sessionId) => {
        probed.push(sessionId);
        return sessionId === sanitizedId ? { id: sessionId } : null;
      },
    });
    const outcome = await postApprovalStage(workerTarget({ agentName: 'Devin Reviewer' }), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: sanitizedId, created: false });
    expect(probed).toEqual([sanitizedId]);
  });

  test('unresolved task_not_found without probing or spawning when the task has no space', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getTaskSpaceId: async () => {
        calls.push('space');
        return null;
      },
      getSession: async () => {
        calls.push('probe');
        return null;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'ignored';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_not_found' });
    expect(calls).toEqual(['space']);
  });
});

describe('activateStage', () => {
  test('activated true leaves the outcome unwritten', async () => {
    const deps = buildDeps({ activateTaskAgent: async () => true });
    const result = await activateStage(workerTarget(), deps);
    expect(result).toEqual({ activated: true, outcome: undefined });
  });

  test('activated false writes the activate_failed outcome', async () => {
    const deps = buildDeps({ activateTaskAgent: async () => false });
    const result = await activateStage(workerTarget(), deps);
    expect(result).toEqual({
      activated: false,
      outcome: { kind: 'unresolved', reason: 'activate_failed' },
    });
  });
});

describe('awaitSessionStage', () => {
  test('resolves created:true without waiting when a live session already appeared', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => [row('sess-live', 'running')],
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    const outcome = await awaitSessionStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'sess-live', created: true });
  });

  test('resolves created:true once the session appears within the cap', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return listCalls >= 3 ? [row('sess-late', 'running')] : [row('stale-id', 'pending')];
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitSessionStage(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'sess-late', created: true });
      expect(listCalls).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('keeps polling while the polled candidate fails the liveness check', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return listCalls >= 4
          ? [row('sess-dead', 'running'), row('sess-live', 'running')]
          : [row('sess-dead', 'running')];
      },
      rehydrateSubSession: async (sessionId) =>
        sessionId === 'sess-dead' ? null : { id: sessionId },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitSessionStage(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'sess-live', created: true });
      expect(listCalls).toBe(4);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a stale binding that never goes live ends in activation_timeout', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => [row('sess-dead', 'running')],
      rehydrateSubSession: async () => null,
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitSessionStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a stalled liveness check cannot extend the wait past the cap', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => [row('sess-slow', 'running')],
      rehydrateSubSession: () => new Promise<unknown>(() => {}),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitSessionStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('unresolved activation_timeout at the cap with no list read past the deadline', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return [];
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitSessionStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(listCalls).toBe(WORKER_SESSION_WAIT_CAP_MS / WORKER_SESSION_POLL_INTERVAL_MS);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a session appearing only after the cap still resolves activation_timeout', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return listCalls > WORKER_SESSION_WAIT_CAP_MS / WORKER_SESSION_POLL_INTERVAL_MS
          ? [row('sess-too-late', 'running')]
          : [];
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitSessionStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(listCalls).toBe(WORKER_SESSION_WAIT_CAP_MS / WORKER_SESSION_POLL_INTERVAL_MS);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('crashHandler', () => {
  test('maps an Error to the internal reason channel', () => {
    expect(crashHandler(new Error('boom'))).toEqual({
      kind: 'unresolved',
      reason: 'internal: boom',
    });
  });

  test('maps a non-Error throw to its string form', () => {
    expect(crashHandler('nope')).toEqual({ kind: 'unresolved', reason: 'internal: nope' });
  });
});

describe('ensureWorkerSession', () => {
  test('find hit resolves created:false and later stages never run', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-live', 'running')];
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
      getTaskSpaceId: async () => {
        calls.push('space');
        return SPACE_ID;
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return true;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 's-live', created: false });
    expect(calls).toEqual(['list', 'rehydrate:s-live']);
  });

  test('a dead binding on a running row falls through to activation', async () => {
    let listCalls = 0;
    const calls: string[] = [];
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        calls.push('list');
        return listCalls >= 3 ? [row('sess-fresh', 'running')] : [row('sess-dead', 'in_progress')];
      },
      rehydrateSubSession: async (sessionId) =>
        sessionId === 'sess-dead' ? null : { id: sessionId },
      activateTaskAgent: async () => {
        calls.push('activate');
        return true;
      },
      getTaskSpaceId: async () => {
        calls.push('space');
        return SPACE_ID;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(ensureWorkerSession(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'sess-fresh', created: true });
      expect(calls).not.toContain('space');
      expect(calls).not.toContain('spawn');
    } finally {
      jest.useRealTimers();
    }
  });

  test('run_active with a failed activation resolves activate_failed and never awaits', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      listWorkerExecutions: () => {
        calls.push('list');
        return [row(null, 'pending')];
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return false;
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'activate_failed' });
    expect(calls).toEqual(['list', 'activate']);
  });

  test('an active task with zero rows activates and never spawns a post-approval worker', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      listWorkerExecutions: () => {
        calls.push('list');
        return [];
      },
      getTaskSpaceId: async () => {
        calls.push('space');
        return SPACE_ID;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return false;
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'activate_failed' });
    expect(calls).toEqual(['list', 'activate']);
  });

  test('run_active with activation succeeds once the session appears within the cap', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return listCalls >= 3
          ? [row(null, 'running'), row('sess-late', 'running')]
          : [row(null, 'running')];
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      activateTaskAgent: async () => true,
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(ensureWorkerSession(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'sess-late', created: true });
      expect(listCalls).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('run_active activation that never yields a session resolves activation_timeout', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return [row(null, 'running')];
      },
      activateTaskAgent: async () => true,
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(ensureWorkerSession(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(listCalls).toBe(1 + WORKER_SESSION_WAIT_CAP_MS / WORKER_SESSION_POLL_INTERVAL_MS);
    } finally {
      jest.useRealTimers();
    }
  });

  test('done task with idle rows resolves the live post-approval session, never the exec session', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      isTaskDone: () => true,
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-exec', 'idle')];
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
      getTaskSpaceId: async () => {
        calls.push('space');
        return SPACE_ID;
      },
      getSession: async (sessionId) => {
        calls.push(`probe:${sessionId}`);
        return sessionId === postApprovalId ? { id: sessionId } : null;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return true;
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: postApprovalId, created: false });
    expect(calls).toEqual(['space', `probe:${postApprovalId}`]);
  });

  test('done phase probes the sanitized post-approval id for a non-canonical agent name', async () => {
    const sanitizedId = buildPostApprovalSessionId(SPACE_ID, TASK_ID, 'devin');
    const calls: string[] = [];
    const deps = buildDeps({
      isTaskDone: () => true,
      listWorkerExecutions: () => [row(null, 'cancelled')],
      getTaskSpaceId: async () => SPACE_ID,
      getSession: async (sessionId) => {
        calls.push(`probe:${sessionId}`);
        return sessionId === sanitizedId ? { id: sessionId } : null;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget({ agentName: 'Devin' }), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: sanitizedId, created: false });
    expect(calls).toEqual([`probe:${sanitizedId}`]);
  });

  test('done task with idle rows and no post-approval worker spawns one and resolves created:true', async () => {
    const spawned: Array<[string, string, string | undefined]> = [];
    const deps = buildDeps({
      isTaskDone: () => true,
      listWorkerExecutions: () => [row('s-exec', 'idle')],
      spawnPostApprovalWorker: async (taskId, agentName, workflowNodeId) => {
        spawned.push([taskId, agentName, workflowNodeId]);
        return 'spawned-1';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'spawned-1', created: true });
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, undefined]]);
  });

  test('done phase with a null spawn resolves spawn_failed', async () => {
    const deps = buildDeps({
      isTaskDone: () => true,
      listWorkerExecutions: () => [],
      spawnPostApprovalWorker: async () => null,
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'spawn_failed' });
  });

  test('the non-taken phase never runs its stages', async () => {
    const doneCalls: string[] = [];
    const doneDeps = buildDeps({
      isTaskDone: () => true,
      listWorkerExecutions: () => {
        doneCalls.push('list');
        return [row(null, 'cancelled')];
      },
      getTaskSpaceId: async () => {
        doneCalls.push('space');
        return SPACE_ID;
      },
      activateTaskAgent: async () => {
        doneCalls.push('activate');
        return true;
      },
      spawnPostApprovalWorker: async () => {
        doneCalls.push('spawn');
        return 'spawned-done';
      },
    });
    const doneOutcome = await ensureWorkerSession(workerTarget(), doneDeps);
    expect(doneOutcome).toEqual({ kind: 'resolved', sessionId: 'spawned-done', created: true });
    expect(doneCalls).toEqual(['space', 'spawn']);
    expect(doneCalls).not.toContain('activate');

    const activeCalls: string[] = [];
    const activeDeps = buildDeps({
      listWorkerExecutions: () => {
        activeCalls.push('list');
        return [row(null, 'running')];
      },
      getTaskSpaceId: async () => {
        activeCalls.push('space');
        return SPACE_ID;
      },
      spawnPostApprovalWorker: async () => {
        activeCalls.push('spawn');
        return 'spawned-active';
      },
      activateTaskAgent: async () => {
        activeCalls.push('activate');
        return false;
      },
    });
    const activeOutcome = await ensureWorkerSession(workerTarget(), activeDeps);
    expect(activeOutcome).toEqual({ kind: 'unresolved', reason: 'activate_failed' });
    expect(activeCalls).toEqual(['list', 'activate']);
    expect(activeCalls).not.toContain('space');
    expect(activeCalls).not.toContain('spawn');
  });

  test('a stage crash resolves through the internal reason channel', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => {
        throw new Error('executions exploded');
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({
      kind: 'unresolved',
      reason: 'internal: executions exploded',
    });
  });
});
