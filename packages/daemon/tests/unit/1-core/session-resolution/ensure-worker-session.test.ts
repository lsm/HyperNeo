import { describe, expect, jest, test } from 'bun:test';
import type {
  SessionResolutionDeps,
  WorkerExecutionSession,
} from '../../../../src/lib/session-resolution/deps';
import {
  activateStage,
  awaitRoutingStage,
  awaitSessionStage,
  crashHandler,
  ensureWorkerSession,
  findStage,
  newestWorkerSessionId,
  phaseStage,
  postApprovalStage,
  WORKER_SESSION_POLL_INTERVAL_MS,
  WORKER_SESSION_WAIT_CAP_MS,
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

const buildDeps = (overrides: Partial<SessionResolutionDeps> = {}): SessionResolutionDeps => ({
  getSession: async () => null,
  rehydrateSubSession: async () => null,
  getCoordinator: async () => null,
  ensureLongTermAgent: async () => null,
  listWorkerExecutions: () => [],
  readWorkerTaskPhase: () => 'run_active',
  getTaskSpaceId: async () => null,
  activateTaskAgent: async () => false,
  spawnPostApprovalWorker: async () => null,
  getPostApprovalWorkerSession: () => null,
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

describe('phaseStage', () => {
  test('a post-approval task arms only postApprovalStage, reading task state and never the row census', () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: (taskId) => {
        calls.push(`phase:${taskId}`);
        return 'post_approval';
      },
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-idle', 'idle')];
      },
    });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('post_approval');
    expect(result.outcome).toBeUndefined();
    expect(result.findArm).toBeUndefined();
    expect(result.postApprovalArm).toBe(postApprovalStage);
    expect(result.activateArm).toBeUndefined();
    expect(calls).toEqual([`phase:${TASK_ID}`]);
  });

  test('a routing task arms only awaitRoutingStage and leaves spawning disarmed', () => {
    const deps = buildDeps({ readWorkerTaskPhase: () => 'routing' });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('routing');
    expect(result.outcome).toBeUndefined();
    expect(result.findArm).toBeUndefined();
    expect(result.postApprovalArm).toBeUndefined();
    expect(result.routingArm).toBe(awaitRoutingStage);
    expect(result.activateArm).toBeUndefined();
  });

  test('a terminal task disarms every arm and writes the task_terminal outcome', () => {
    const deps = buildDeps({ readWorkerTaskPhase: () => 'terminal' });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('terminal');
    expect(result.outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(result.findArm).toBeUndefined();
    expect(result.postApprovalArm).toBeUndefined();
    expect(result.activateArm).toBeUndefined();
  });

  test('an active task arms findStage and activateStage and leaves postApprovalStage disarmed', () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return 'run_active';
      },
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-idle', 'idle')];
      },
    });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('run_active');
    expect(result.outcome).toBeUndefined();
    expect(result.findArm).toBe(findStage);
    expect(result.postApprovalArm).toBeUndefined();
    expect(result.activateArm).toBe(activateStage);
    expect(calls).toEqual(['phase']);
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

describe('postApprovalStage', () => {
  test('resolves the actual routed worker identity after verifying liveness, without probing or spawning', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-retried-2', agentName: AGENT_NAME, nodeId: 'node-1' };
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
      getSession: async () => {
        calls.push('probe');
        return null;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget({ workflowNodeId: 'node-1' }), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-retried-2', created: false });
    expect(calls).toEqual(['worker', 'rehydrate:pa-retried-2']);
  });

  test('a routed identity whose session cannot be rehydrated spawns a fresh worker', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-dead', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return null;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned-fresh';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'spawned-fresh', created: true });
    expect(calls).toEqual(['worker', 'rehydrate:pa-dead', 'spawn']);
  });

  test('an identity for another agent name resolves nothing and spawns nothing', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-other', agentName: 'reviewer' };
      },
      getSession: async () => {
        calls.push('probe');
        return null;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'post_approval_target_mismatch' });
    expect(calls).toEqual(['worker']);
  });

  test('an identity bound to another workflow node resolves nothing and spawns nothing', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-node-9', agentName: AGENT_NAME, nodeId: 'node-9' };
      },
      getSession: async () => {
        calls.push('probe');
        return { id: 'probe-hit' };
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget({ workflowNodeId: 'node-1' }), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'post_approval_target_mismatch' });
    expect(calls).toEqual(['worker']);
  });

  test('an absent identity spawns without probing any deterministic id', async () => {
    const calls: string[] = [];
    const spawned: Array<[string, string, string | undefined]> = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return null;
      },
      getSession: async () => {
        calls.push('probe');
        return { id: 'stale-base' };
      },
      spawnPostApprovalWorker: async (taskId, agentName, workflowNodeId) => {
        calls.push('spawn');
        spawned.push([taskId, agentName, workflowNodeId]);
        return 'spawned-1';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'spawned-1', created: true });
    expect(calls).toEqual(['worker', 'spawn']);
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, undefined]]);
  });

  test('a node-scoped target with no identity spawns with its node', async () => {
    const spawned: Array<[string, string, string | undefined]> = [];
    const deps = buildDeps({
      spawnPostApprovalWorker: async (taskId, agentName, workflowNodeId) => {
        spawned.push([taskId, agentName, workflowNodeId]);
        return 'spawned-node-1';
      },
    });
    const outcome = await postApprovalStage(workerTarget({ workflowNodeId: 'node-1' }), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'spawned-node-1', created: true });
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, 'node-1']]);
  });

  test('unresolved spawn_failed when the spawn returns null', async () => {
    const deps = buildDeps({ spawnPostApprovalWorker: async () => null });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'spawn_failed' });
  });
});

describe('awaitRoutingStage', () => {
  test('resolves the routed worker without waiting when the identity is already live', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-routed', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await awaitRoutingStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-routed', created: false });
    expect(calls).toEqual(['worker', 'rehydrate:pa-routed']);
  });

  test('waits for the router to record the identity and never spawns', async () => {
    let polls = 0;
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'routing',
      getPostApprovalWorkerSession: () => {
        polls += 1;
        return polls >= 3 ? { sessionId: 'pa-late', agentName: AGENT_NAME } : null;
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitRoutingStage(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'pa-late', created: false });
      expect(polls).toBe(3);
      expect(calls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('routing that finishes without a worker restarts resolution on the new phase', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return calls.length <= 1 ? 'routing' : 'run_active';
      },
      getPostApprovalWorkerSession: () => null,
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-exec', 'idle')];
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitRoutingStage(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 's-exec', created: false });
      expect(calls).toEqual(['phase', 'phase', 'phase', 'list', 'rehydrate:s-exec']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an identity for another agent stops the wait as a target mismatch', async () => {
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-other', agentName: 'reviewer' }),
      spawnPostApprovalWorker: async () => 'spawned',
    });
    const outcome = await awaitRoutingStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'post_approval_target_mismatch' });
  });

  test('an identity that never appears ends in post_approval_pending without spawning', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'routing',
      getPostApprovalWorkerSession: () => null,
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitRoutingStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'post_approval_pending' });
      expect(calls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a recorded identity whose session stays dead ends in post_approval_pending', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'routing',
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-dead', agentName: AGENT_NAME }),
      rehydrateSubSession: async () => null,
      spawnPostApprovalWorker: async () => 'spawned',
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitRoutingStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'post_approval_pending' });
    } finally {
      jest.useRealTimers();
    }
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

  test('a post-approval task with idle rows resolves the live routed worker, never the exec session', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-exec', 'idle')];
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-live', agentName: AGENT_NAME };
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
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-live', created: false });
    expect(calls).toEqual(['worker', 'rehydrate:pa-live']);
  });

  test('an approved task with zero rows routes through the post-approval arm, never activation', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      listWorkerExecutions: () => {
        calls.push('list');
        return [];
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-routed', agentName: AGENT_NAME };
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
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-routed', created: false });
    expect(calls).toEqual(['worker']);
  });

  test('resolution during the approval dispatch window waits for the routed worker instead of spawning', async () => {
    let polls = 0;
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return 'routing';
      },
      getPostApprovalWorkerSession: () => {
        polls += 1;
        return polls >= 2 ? { sessionId: 'pa-recorded', agentName: AGENT_NAME } : null;
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return true;
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(ensureWorkerSession(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'pa-recorded', created: false });
      expect(calls).toEqual(['phase', 'phase']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a retried post-approval run resolves the latest routed session and never probes a deterministic id', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      listWorkerExecutions: () => [row('s-exec', 'idle')],
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-retried-2', agentName: AGENT_NAME };
      },
      getSession: async () => {
        calls.push('probe');
        return { id: 'stale-base' };
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-retried-2', created: false });
    expect(calls).toEqual(['worker', 'rehydrate:pa-retried-2']);
  });

  test('a routed worker for another agent resolves as a target mismatch without spawning', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-other', agentName: 'reviewer' };
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'post_approval_target_mismatch' });
    expect(calls).toEqual(['worker']);
  });

  test('an absent routed identity spawns a post-approval worker without probing any id', async () => {
    const calls: string[] = [];
    const spawned: Array<[string, string, string | undefined]> = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      listWorkerExecutions: () => [row('s-exec', 'idle')],
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return null;
      },
      getSession: async () => {
        calls.push('probe');
        return { id: 'stale-base' };
      },
      spawnPostApprovalWorker: async (taskId, agentName, workflowNodeId) => {
        calls.push('spawn');
        spawned.push([taskId, agentName, workflowNodeId]);
        return 'spawned-1';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'spawned-1', created: true });
    expect(calls).toEqual(['worker', 'spawn']);
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, undefined]]);
  });

  test('a done task without post-approval work stays on the ordinary worker arm', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'run_active',
      listWorkerExecutions: () => {
        calls.push('list');
        return [row('s-exec', 'idle')];
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-stale', agentName: AGENT_NAME };
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 's-exec', created: false });
    expect(calls).toEqual(['list', 'rehydrate:s-exec']);
  });

  test('a cancelled task resolves task_terminal without reopening or spawning anything', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return 'terminal';
      },
      listWorkerExecutions: () => {
        calls.push('list');
        return [];
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
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(calls).toEqual(['phase']);
  });

  test('post-approval phase with a null spawn resolves spawn_failed', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      spawnPostApprovalWorker: async () => null,
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'spawn_failed' });
  });

  test('the non-taken phase never runs its stages', async () => {
    const paCalls: string[] = [];
    const paDeps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      listWorkerExecutions: () => {
        paCalls.push('list');
        return [row(null, 'cancelled')];
      },
      activateTaskAgent: async () => {
        paCalls.push('activate');
        return true;
      },
      spawnPostApprovalWorker: async () => {
        paCalls.push('spawn');
        return 'spawned-pa';
      },
    });
    const paOutcome = await ensureWorkerSession(workerTarget(), paDeps);
    expect(paOutcome).toEqual({ kind: 'resolved', sessionId: 'spawned-pa', created: true });
    expect(paCalls).toEqual(['spawn']);
    expect(paCalls).not.toContain('activate');

    const activeCalls: string[] = [];
    const activeDeps = buildDeps({
      listWorkerExecutions: () => {
        activeCalls.push('list');
        return [row(null, 'running')];
      },
      getPostApprovalWorkerSession: () => {
        activeCalls.push('worker');
        return { sessionId: 'pa-ignored', agentName: AGENT_NAME };
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
    expect(activeCalls).not.toContain('worker');
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
