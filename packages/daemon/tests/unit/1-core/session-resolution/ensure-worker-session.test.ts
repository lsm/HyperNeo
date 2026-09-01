import { describe, expect, jest, test } from 'bun:test';
import {
  workerTaskPhaseOf,
  type SessionResolutionDeps,
  type WorkerExecutionSession,
} from '../../../../src/lib/session-resolution/deps';
import {
  activateStage,
  awaitRoutingStage,
  awaitSessionStage,
  crashHandler,
  ensureWorkerSession,
  findStage,
  findTerminalStage,
  newestWorkerSessionId,
  phaseStage,
  postApprovalDoneStage,
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

describe('workerTaskPhaseOf', () => {
  test('cancelled, archived, and stopped tasks are terminal', () => {
    expect(workerTaskPhaseOf('cancelled', null)).toBe('terminal');
    expect(workerTaskPhaseOf('cancelled', 'pa-1')).toBe('terminal');
    expect(workerTaskPhaseOf('archived', null)).toBe('terminal');
    expect(workerTaskPhaseOf('stopped', null)).toBe('terminal');
    expect(workerTaskPhaseOf('stopped', 'pa-1')).toBe('terminal');
  });

  test('approved tasks route or hold by their recorded worker', () => {
    expect(workerTaskPhaseOf('approved', null)).toBe('routing');
    expect(workerTaskPhaseOf('approved', 'pa-1')).toBe('post_approval');
  });

  test('an approved task with a recorded blocked reason is a failed dispatch, not routing', () => {
    expect(workerTaskPhaseOf('approved', null, false, 'spawn failed')).toBe('post_approval');
    expect(workerTaskPhaseOf('approved', null, false, null)).toBe('routing');
  });

  test('done tasks split by post-approval history', () => {
    expect(workerTaskPhaseOf('done', 'pa-1')).toBe('post_approval_done');
    expect(workerTaskPhaseOf('done', null)).toBe('done');
    expect(workerTaskPhaseOf('done', null, true)).toBe('post_approval_done');
  });

  test('run-phase statuses stay run_active regardless of pointer state', () => {
    for (const status of [
      'draft',
      'open',
      'in_progress',
      'review',
      'blocked',
      'rate_limited',
      'usage_limited',
    ] as const) {
      expect(workerTaskPhaseOf(status, null)).toBe('run_active');
      expect(workerTaskPhaseOf(status, 'pa-1')).toBe('run_active');
    }
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

  test('a done no-route task arms only the terminal-fallback find arm', () => {
    const deps = buildDeps({ readWorkerTaskPhase: () => 'done' });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('done');
    expect(result.outcome).toBeUndefined();
    expect(result.findArm).toBe(findTerminalStage);
    expect(result.postApprovalArm).toBeUndefined();
    expect(result.postApprovalDoneArm).toBeUndefined();
    expect(result.routingArm).toBeUndefined();
    expect(result.activateArm).toBeUndefined();
  });

  test('a task with completed post-approval work arms only postApprovalDoneStage', () => {
    const deps = buildDeps({ readWorkerTaskPhase: () => 'post_approval_done' });
    const result = phaseStage(workerTarget(), deps);
    expect(result.phase).toBe('post_approval_done');
    expect(result.outcome).toBeUndefined();
    expect(result.findArm).toBeUndefined();
    expect(result.postApprovalArm).toBeUndefined();
    expect(result.postApprovalDoneArm).toBe(postApprovalDoneStage);
    expect(result.routingArm).toBeUndefined();
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

  test('a task cancelled during rehydration does not resolve the session', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => [row('s-live', 'running')],
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      readWorkerTaskPhase: () => 'terminal',
    });
    expect(await findStage(workerTarget(), deps)).toEqual({
      foundSessionId: undefined,
      outcome: undefined,
    });
  });

  test('a task approved during rehydration does not resolve the pre-approval session', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => [row('s-live', 'running')],
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      readWorkerTaskPhase: () => 'post_approval',
    });
    expect(await findStage(workerTarget(), deps)).toEqual({
      foundSessionId: undefined,
      outcome: undefined,
    });
  });
});

describe('findTerminalStage', () => {
  test('resolves a live execution session through the ordinary find path', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'done',
      listWorkerExecutions: () => [row('s-exec', 'idle')],
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    expect(await findTerminalStage(workerTarget(), deps)).toEqual({
      foundSessionId: 's-exec',
      outcome: { kind: 'resolved', sessionId: 's-exec', created: false },
    });
  });

  test('a missing or dead execution session resolves task_terminal', async () => {
    const missing = buildDeps({
      readWorkerTaskPhase: () => 'done',
      listWorkerExecutions: () => [],
    });
    expect(await findTerminalStage(workerTarget(), missing)).toEqual({
      foundSessionId: undefined,
      outcome: { kind: 'unresolved', reason: 'task_terminal' },
    });
    const dead = buildDeps({
      readWorkerTaskPhase: () => 'done',
      listWorkerExecutions: () => [row('s-dead', 'idle')],
      rehydrateSubSession: async () => null,
    });
    expect(await findTerminalStage(workerTarget(), dead)).toEqual({
      foundSessionId: undefined,
      outcome: { kind: 'unresolved', reason: 'task_terminal' },
    });
  });

  test('a task leaving the done phase mid-find re-enters phase selection', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-routed', agentName: AGENT_NAME }),
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      listWorkerExecutions: () => [],
    });
    expect(await findTerminalStage(workerTarget(), deps)).toEqual({
      foundSessionId: undefined,
      outcome: { kind: 'resolved', sessionId: 'pa-routed', created: false },
    });
  });
});

describe('postApprovalStage', () => {
  test('resolves the actual routed worker identity after verifying liveness, without probing or spawning', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
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
    expect(calls).toEqual(['worker', 'rehydrate:pa-retried-2', 'worker']);
  });

  test('a routed identity replaced during the restore re-dispatches to the new worker', async () => {
    let workerReads = 0;
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => {
        workerReads += 1;
        return workerReads <= 1
          ? { sessionId: 'pa-old', agentName: AGENT_NAME }
          : { sessionId: 'pa-new', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-new', created: false });
    expect(calls).toEqual([]);
  });

  test('a dead routed identity replaced during the restore re-dispatches instead of spawning', async () => {
    let workerReads = 0;
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => {
        workerReads += 1;
        return workerReads <= 1
          ? { sessionId: 'pa-dead', agentName: AGENT_NAME }
          : { sessionId: 'pa-replacement', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) =>
        sessionId === 'pa-dead' ? null : { id: sessionId },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-replacement', created: false });
    expect(calls).toEqual([]);
  });

  test('a router replacement recorded during the spawn re-dispatches to it', async () => {
    let workerReads = 0;
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => {
        workerReads += 1;
        return workerReads <= 2
          ? { sessionId: 'pa-dead', agentName: AGENT_NAME }
          : { sessionId: 'pa-router', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) =>
        sessionId === 'pa-dead' ? null : { id: sessionId },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned-duplicate';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-router', created: false });
    expect(calls).toEqual(['spawn']);
  });

  test('a stalled post-approval restore ends in restore_timeout', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-stuck', agentName: AGENT_NAME }),
      rehydrateSubSession: () => new Promise<unknown>(() => {}),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(postApprovalStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'restore_timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a task cancelled during a stalled restore re-enters instead of returning restore_timeout', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'terminal',
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-stuck', agentName: AGENT_NAME }),
      rehydrateSubSession: () => new Promise<unknown>(() => {}),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(postApprovalStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a routed identity whose session cannot be rehydrated spawns a fresh worker on the routed node', async () => {
    const calls: string[] = [];
    const spawned: Array<[string, string, string | undefined]> = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-dead', agentName: AGENT_NAME, nodeId: 'node-7' };
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return null;
      },
      spawnPostApprovalWorker: async (taskId, agentName, workflowNodeId) => {
        calls.push('spawn');
        spawned.push([taskId, agentName, workflowNodeId]);
        return 'spawned-fresh';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'spawned-fresh', created: true });
    expect(calls).toEqual(['worker', 'rehydrate:pa-dead', 'worker', 'spawn', 'worker']);
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, 'node-7']]);
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
      readWorkerTaskPhase: () => 'post_approval',
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
    expect(calls).toEqual(['worker', 'spawn', 'worker']);
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, undefined]]);
  });

  test('a node-scoped target with no identity spawns with its node', async () => {
    const spawned: Array<[string, string, string | undefined]> = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
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
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval',
      spawnPostApprovalWorker: async () => null,
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'spawn_failed' });
  });

  test('a task changing phase during a failed spawn re-enters phase selection', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return calls.length <= 1 ? 'post_approval' : 'terminal';
      },
      getPostApprovalWorkerSession: () => null,
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return null;
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(calls).toEqual(['phase', 'spawn', 'phase', 'phase']);
  });

  test('a task cancelled while the identity liveness check runs resolves task_terminal before spawning', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-dying', agentName: AGENT_NAME }),
      rehydrateSubSession: async () => null,
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return 'terminal';
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(calls).toEqual(['phase', 'phase']);
  });

  test('a task cancelled before an absent identity would spawn resolves task_terminal', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      getPostApprovalWorkerSession: () => null,
      readWorkerTaskPhase: () => 'terminal',
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(calls).toEqual([]);
  });

  test('a cancellation landing during the spawn never resolves the spawned worker', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return calls.length <= 1 ? 'post_approval' : 'terminal';
      },
      getPostApprovalWorkerSession: () => null,
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned-orphan';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(calls).toEqual(['phase', 'spawn', 'phase', 'phase']);
  });

  test('a retried approval moving the task back to routing re-enters the routing arm instead of spawning', async () => {
    let workerReads = 0;
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'routing',
      getPostApprovalWorkerSession: () => {
        workerReads += 1;
        return workerReads === 1 ? null : { sessionId: 'pa-new', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-new', created: false });
    expect(calls).toEqual([]);
  });
});

describe('postApprovalDoneStage', () => {
  test('resolves the completed routed worker when its session is still live, without spawning', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval_done',
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-done', agentName: AGENT_NAME };
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
    const outcome = await postApprovalDoneStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'pa-done', created: false });
    expect(calls).toEqual(['worker', 'rehydrate:pa-done', 'worker']);
  });

  test('a completed routed worker whose session is gone never respawns', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval_done',
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-gone', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return null;
      },
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await postApprovalDoneStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(calls).toEqual(['worker', 'rehydrate:pa-gone']);
  });

  test('an identity for another agent resolves as a target mismatch', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval_done',
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-other', agentName: 'reviewer' }),
    });
    const outcome = await postApprovalDoneStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'post_approval_target_mismatch' });
  });

  test('a stalled completed-worker restore ends in restore_timeout', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval_done',
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-stuck', agentName: AGENT_NAME }),
      rehydrateSubSession: () => new Promise<unknown>(() => {}),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(postApprovalDoneStage(workerTarget(), deps), 40);
      expect(settled).toEqual({ kind: 'unresolved', reason: 'restore_timeout' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('awaitRoutingStage', () => {
  test('resolves the routed worker without waiting when the identity is already live', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'routing',
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

  test('a task cancelled while the routed worker rehydrates resolves task_terminal', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'terminal',
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-live', agentName: AGENT_NAME }),
      rehydrateSubSession: async () => ({ id: 'pa-live' }),
      spawnPostApprovalWorker: async () => 'spawned',
    });
    const outcome = await awaitRoutingStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
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
      expect(calls).toEqual(['phase', 'phase', 'phase', 'list', 'rehydrate:s-exec', 'phase']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an identity for another agent stops the wait as a target mismatch', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'routing',
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

  test('a recorded identity whose session is dead restarts resolution once routing completes', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return calls.length <= 1 ? 'routing' : 'post_approval';
      },
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-dead', agentName: AGENT_NAME }),
      rehydrateSubSession: async () => null,
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned-fresh';
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitRoutingStage(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'spawned-fresh', created: true });
      expect(calls).toEqual(['phase', 'phase', 'phase', 'phase', 'spawn', 'phase']);
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

  test('a failed activation after a phase change re-enters phase selection', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return calls.length <= 1 ? 'run_active' : 'terminal';
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return false;
      },
    });
    const result = await activateStage(workerTarget(), deps);
    expect(result).toEqual({
      activated: false,
      outcome: { kind: 'unresolved', reason: 'task_terminal' },
    });
    expect(calls).toEqual(['phase', 'activate', 'phase', 'phase']);
  });

  test('a task that leaves run_active before activation re-enters phase selection', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return 'terminal';
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return true;
      },
    });
    const result = await activateStage(workerTarget(), deps);
    expect(result).toEqual({
      activated: false,
      outcome: { kind: 'unresolved', reason: 'task_terminal' },
    });
    expect(calls).toEqual(['phase', 'phase']);
  });

  test('a task that leaves run_active during activation re-enters phase selection', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return calls.length <= 1 ? 'run_active' : 'post_approval';
      },
      activateTaskAgent: async () => {
        calls.push('activate');
        return true;
      },
      getPostApprovalWorkerSession: () => ({ sessionId: 'pa-routed', agentName: AGENT_NAME }),
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    const result = await activateStage(workerTarget(), deps);
    expect(result).toEqual({
      activated: true,
      outcome: { kind: 'resolved', sessionId: 'pa-routed', created: false },
    });
    expect(calls).toEqual(['phase', 'activate', 'phase', 'phase', 'phase']);
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

  test('a task cancelled while the activated session appears resolves task_terminal', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => [row('sess-live', 'running')],
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
      readWorkerTaskPhase: () => 'terminal',
    });
    const outcome = await awaitSessionStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
  });

  test('a task approved while awaiting the activated session re-enters phase selection', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return calls.length <= 1 ? 'run_active' : 'post_approval';
      },
      listWorkerExecutions: () => {
        calls.push('list');
        return [];
      },
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-routed', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async (sessionId) => {
        calls.push(`rehydrate:${sessionId}`);
        return { id: sessionId };
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(awaitSessionStage(workerTarget(), deps), 20);
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'pa-routed', created: false });
      expect(calls).toEqual([
        'phase',
        'list',
        'phase',
        'phase',
        'worker',
        'rehydrate:pa-routed',
        'phase',
        'worker',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a cancelled task with no appearing session resolves task_terminal without burning the cap', async () => {
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'terminal',
      listWorkerExecutions: () => [],
    });
    const outcome = await awaitSessionStage(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
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

  test('waitCapMs 0 still resolves an already-live session without waiting', async () => {
    const deps = buildDeps({
      listWorkerExecutions: () => [row('sess-live', 'running')],
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    const outcome = await awaitSessionStage(workerTarget({ waitCapMs: 0 }), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 'sess-live', created: true });
  });

  test('waitCapMs 0 stops after a single check when nothing is live', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return [];
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(
        awaitSessionStage(workerTarget({ waitCapMs: 0 }), deps),
        5
      );
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(listCalls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('waitCapMs 0 still resolves when the liveness probe completes after the zero deadline', async () => {
    let probes = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => [row('sess-slow', 'running')],
      rehydrateSubSession: (sessionId) =>
        new Promise<unknown>((resolve) => {
          probes += 1;
          setTimeout(() => resolve({ id: sessionId }), 200);
        }),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(
        awaitSessionStage(workerTarget({ waitCapMs: 0 }), deps),
        5
      );
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'sess-slow', created: true });
      expect(probes).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('waitCapMs 0 times out after a single un-raced probe when the candidate is dead', async () => {
    let probes = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => [row('sess-dead', 'running')],
      rehydrateSubSession: () =>
        new Promise<unknown>((resolve) => {
          probes += 1;
          setTimeout(() => resolve(null), 200);
        }),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(
        awaitSessionStage(workerTarget({ waitCapMs: 0 }), deps),
        5
      );
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(probes).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a shorter waitCapMs shortens the poll window', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return [];
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(
        awaitSessionStage(workerTarget({ waitCapMs: 5_000 }), deps),
        40
      );
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(listCalls).toBe(5_000 / WORKER_SESSION_POLL_INTERVAL_MS);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a waitCapMs above the global cap is clamped to the global cap', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return [];
      },
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(
        awaitSessionStage(workerTarget({ waitCapMs: 120_000 }), deps),
        40
      );
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(listCalls).toBe(WORKER_SESSION_WAIT_CAP_MS / WORKER_SESSION_POLL_INTERVAL_MS);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a session appearing within a shorter waitCapMs still resolves', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return listCalls >= 2 ? [row('sess-late', 'running')] : [];
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(
        awaitSessionStage(workerTarget({ waitCapMs: 5_000 }), deps),
        20
      );
      expect(settled).toEqual({ kind: 'resolved', sessionId: 'sess-late', created: true });
      expect(listCalls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a session appearing only after a shorter waitCapMs still resolves activation_timeout', async () => {
    let listCalls = 0;
    const deps = buildDeps({
      listWorkerExecutions: () => {
        listCalls += 1;
        return listCalls > 2_000 / WORKER_SESSION_POLL_INTERVAL_MS
          ? [row('sess-too-late', 'running')]
          : [];
      },
      rehydrateSubSession: async (sessionId) => ({ id: sessionId }),
    });
    jest.useFakeTimers();
    try {
      const settled = await drainByPolling(
        awaitSessionStage(workerTarget({ waitCapMs: 2_000 }), deps),
        20
      );
      expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
      expect(listCalls).toBe(2_000 / WORKER_SESSION_POLL_INTERVAL_MS);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a NaN or positive-infinity waitCapMs falls back to the global cap instead of an immediate timer', async () => {
    for (const waitCapMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let listCalls = 0;
      const deps = buildDeps({
        listWorkerExecutions: () => {
          listCalls += 1;
          return [];
        },
      });
      jest.useFakeTimers();
      try {
        const settled = await drainByPolling(
          awaitSessionStage(workerTarget({ waitCapMs }), deps),
          40
        );
        expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
        expect(listCalls).toBe(WORKER_SESSION_WAIT_CAP_MS / WORKER_SESSION_POLL_INTERVAL_MS);
      } finally {
        jest.useRealTimers();
      }
    }
  });

  test('a negative or negative-infinity waitCapMs is clamped to a single check', async () => {
    for (const waitCapMs of [-1_000, Number.NEGATIVE_INFINITY]) {
      let listCalls = 0;
      const deps = buildDeps({
        listWorkerExecutions: () => {
          listCalls += 1;
          return [];
        },
      });
      jest.useFakeTimers();
      try {
        const settled = await drainByPolling(
          awaitSessionStage(workerTarget({ waitCapMs }), deps),
          5
        );
        expect(settled).toEqual({ kind: 'unresolved', reason: 'activation_timeout' });
        expect(listCalls).toBe(1);
      } finally {
        jest.useRealTimers();
      }
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
    expect(calls).toEqual(['worker', 'rehydrate:pa-live', 'worker']);
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
    expect(calls).toEqual(['worker', 'worker']);
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
      expect(calls).toEqual(['phase', 'phase', 'phase', 'phase']);
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
    expect(calls).toEqual(['worker', 'rehydrate:pa-retried-2', 'worker']);
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
    expect(calls).toEqual(['worker', 'spawn', 'worker']);
    expect(spawned).toEqual([[TASK_ID, AGENT_NAME, undefined]]);
  });

  test('a done no-route task resolves its execution session through the find-only arm', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'done',
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
      activateTaskAgent: async () => {
        calls.push('activate');
        return true;
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'resolved', sessionId: 's-exec', created: false });
    expect(calls).toEqual(['list', 'rehydrate:s-exec']);
  });

  test('a done no-route task whose session is gone resolves task_terminal without activating or spawning', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => {
        calls.push('phase');
        return 'done';
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
    expect(calls).toEqual(['phase', 'list', 'phase']);
  });

  test('a completed post-approval worker is never respawned', async () => {
    const calls: string[] = [];
    const deps = buildDeps({
      readWorkerTaskPhase: () => 'post_approval_done',
      getPostApprovalWorkerSession: () => {
        calls.push('worker');
        return { sessionId: 'pa-gone', agentName: AGENT_NAME };
      },
      rehydrateSubSession: async () => null,
      spawnPostApprovalWorker: async () => {
        calls.push('spawn');
        return 'spawned';
      },
    });
    const outcome = await ensureWorkerSession(workerTarget(), deps);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'task_terminal' });
    expect(calls).toEqual(['worker']);
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
