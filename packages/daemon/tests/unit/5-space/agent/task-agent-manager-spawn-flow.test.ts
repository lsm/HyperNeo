import { describe, expect, spyOn, test } from 'bun:test';
import type {
  NodeExecution,
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { SpawnSupersededError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import { PermanentSpawnError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const TASK_ID = 'task-1240';
const RUN_ID = 'run-1240';
const SPACE_ID = 'space-1240';
const NODE_ID = 'node-coder';
const AGENT_NAME = 'coder';
const AGENT_ID = 'agent-coder';
const SPAWNED_SESSION_ID = 'spawned-session-1';

function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'exec-1',
    workflowRunId: RUN_ID,
    workflowNodeId: NODE_ID,
    agentName: AGENT_NAME,
    agentId: AGENT_ID,
    agentSessionId: null,
    status: 'pending',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeTask(status: string): SpaceTask {
  return {
    id: TASK_ID,
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    title: 'Compose the spawn flow',
    description: 'Pin the staged spawn flow at the TaskAgentManager seam',
    taskNumber: 1240,
    status,
  } as unknown as SpaceTask;
}

function makeWorkflow(
  nodes: Array<{ id: string; agents: Array<{ agentId: string | null; name: string }> }> = [
    { id: NODE_ID, agents: [{ agentId: AGENT_ID, name: AGENT_NAME }] },
  ]
): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Coding',
    nodes,
    channels: [],
    startNodeId: nodes[0]?.id ?? NODE_ID,
    endNodeId: nodes[0]?.id ?? NODE_ID,
  } as unknown as SpaceWorkflow;
}

function fakeSession(id: string, processingStatus = 'idle'): AgentSession {
  return {
    session: { id },
    getProcessingState: () => ({ status: processingStatus }),
  } as unknown as AgentSession;
}

function fakeCustomAgent() {
  return {
    id: AGENT_ID,
    name: AGENT_NAME,
    customPrompt: 'do the composed work',
    model: 'm',
    tools: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface CasCall {
  id: string;
  expected: string[];
  next: string;
  payload?: {
    agentSessionId?: string | null;
    startedAt?: number | null;
    completedAt?: number | null;
  };
  guards?: { expectAgentSessionId?: string | null };
}

interface SpawnFlowHarnessOptions {
  taskStatus?: string;
  callerTask?: SpaceTask;
  taskMissing?: boolean;
  execution?: NodeExecution;
  workflow?: SpaceWorkflow | null;
  kickoff?: boolean;
  worktreeGate?: Promise<{ path: string }>;
  kickoffGate?: Promise<void>;
  failEnsure?: boolean;
  bindCasOutcome?: 'won' | 'superseded';
}

interface SpawnFlowHarness {
  tam: TaskAgentManager;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  casCalls: CasCall[];
  order: string[];
  cancels: string[];
  reservations: string[];
  reservationReleases: string[];
  spawningIds: () => Set<string>;
  setExecutionSessionId: (sessionId: string | null) => void;
  spawn: () => Promise<string>;
}

function makeSpawnFlowHarness(options: SpawnFlowHarnessOptions = {}): SpawnFlowHarness {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const casCalls: CasCall[] = [];
  const order: string[] = [];
  const cancels: string[] = [];
  const reservations: string[] = [];
  const reservationReleases: string[] = [];
  const row = options.execution ?? makeExecution();
  const dbRow: NodeExecution = { ...row };
  const taskStatus = options.taskStatus ?? 'in_progress';
  const heldReservations = new Set<string>();

  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
    sessionManager: { registerSession: () => {}, getSession: () => undefined },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: (id: string) =>
        options.taskMissing || id !== TASK_ID ? undefined : makeTask(taskStatus),
      reserveSpawnForTick: (taskId: string, allowed: readonly string[]): 'won' | 'superseded' => {
        reservations.push(taskId);
        if (heldReservations.has(taskId)) return 'superseded';
        if (!allowed.includes(taskStatus)) return 'superseded';
        heldReservations.add(taskId);
        return 'won';
      },
      releaseSpawnReservation: (taskId: string) => {
        reservationReleases.push(taskId);
        heldReservations.delete(taskId);
      },
    },
    nodeExecutionRepo: {
      getById: (id: string) => (id === row.id ? dbRow : undefined),
      listByWorkflowRun: () => [row],
      listByNode: (runId: string, nodeId: string) =>
        runId === RUN_ID && nodeId === row.workflowNodeId ? [row] : [],
      update: (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        if (id === row.id) Object.assign(dbRow, patch);
        return { ...dbRow };
      },
      casExecutionStatus: (
        id: string,
        expected: readonly string[] | string,
        next: string,
        payload?: CasCall['payload'],
        guards?: { expectAgentSessionId?: string | null }
      ): 'won' | 'superseded' => {
        const expectedList = Array.isArray(expected) ? [...expected] : [expected];
        casCalls.push({ id, expected: expectedList, next, payload, guards });
        if (options.bindCasOutcome && next === 'in_progress' && payload?.agentSessionId) {
          return options.bindCasOutcome;
        }
        if (
          guards?.expectAgentSessionId !== undefined &&
          dbRow.agentSessionId !== guards.expectAgentSessionId
        ) {
          return 'superseded';
        }
        if (id !== row.id || !expectedList.includes(dbRow.status)) return 'superseded';
        dbRow.status = next as NodeExecution['status'];
        if (payload?.agentSessionId !== undefined) dbRow.agentSessionId = payload.agentSessionId;
        if (payload?.startedAt !== undefined) dbRow.startedAt = payload.startedAt;
        if (payload?.completedAt !== undefined) dbRow.completedAt = payload.completedAt;
        if (next === 'in_progress' && payload?.agentSessionId === SPAWNED_SESSION_ID) {
          order.push('execution-bind');
        }
        return 'won';
      },
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    spaceAgentManager: {
      getById: (id: string) => (id !== AGENT_ID ? undefined : fakeCustomAgent()),
    },
    ...(options.worktreeGate
      ? {
          worktreeManager: {
            createTaskWorktree: () => options.worktreeGate,
            getTaskWorktreePathSync: () => null,
          },
        }
      : {}),
  } as unknown as TaskAgentManagerConfig);

  const internal = tam as unknown as {
    createSubSession: (...args: unknown[]) => Promise<string>;
    getSubSession: (id: string) => AgentSession | undefined;
    ensureNodeAgentAttached: (...args: unknown[]) => Promise<void>;
    registerCompletionCallback: (...args: unknown[]) => void;
    injectMessageIntoSession: (...args: unknown[]) => Promise<string>;
    cancelBySessionId: (id: string) => void;
    buildNodeAgentMcpServerForSession: (...args: unknown[]) => unknown;
    spawningExecutionIds: Set<string>;
  };
  internal.createSubSession = async () => {
    order.push('createSubSession');
    return SPAWNED_SESSION_ID;
  };
  internal.getSubSession = (id: string) =>
    id === SPAWNED_SESSION_ID ? fakeSession(id) : undefined;
  internal.ensureNodeAgentAttached = async () => {
    if (options.failEnsure) throw new Error('attach boom');
    order.push('ensureNodeAgentAttached');
  };
  internal.registerCompletionCallback = () => {
    order.push('registerCompletionCallback');
  };
  internal.injectMessageIntoSession = async () => {
    if (options.kickoffGate) await options.kickoffGate;
    order.push('kickoff-inject');
    return 'msg-id';
  };
  internal.cancelBySessionId = (id: string) => {
    cancels.push(id);
  };
  internal.buildNodeAgentMcpServerForSession = () => ({ __role: 'node-agent' });

  const task = options.callerTask ?? makeTask(taskStatus);
  const space = { id: SPACE_ID, workspacePath: '/tmp/ws' } as unknown as Space;
  const workflowRun = {
    id: RUN_ID,
    workflowId: 'wf-1',
    status: 'in_progress',
  } as unknown as SpaceWorkflowRun;

  return {
    tam,
    updates,
    casCalls,
    order,
    cancels,
    reservations,
    reservationReleases,
    spawningIds: () => internal.spawningExecutionIds,
    setExecutionSessionId: (sessionId) => {
      dbRow.agentSessionId = sessionId;
    },
    spawn: () =>
      tam.spawnWorkflowNodeAgentForExecution(
        task,
        space,
        (options.workflow === undefined ? makeWorkflow() : options.workflow) as SpaceWorkflow,
        workflowRun,
        row,
        options.kickoff === undefined ? {} : { kickoff: options.kickoff }
      ),
  };
}

function seedIndexedSession(
  tam: TaskAgentManager,
  sessionId: string,
  processingStatus = 'idle'
): void {
  (tam as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
    sessionId,
    fakeSession(sessionId, processingStatus)
  );
}

function fireLongTimersImmediately(): () => void {
  const originalSetTimeout = globalThis.setTimeout;
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number
  ) => {
    const effective = typeof delay === 'number' ? delay : 0;
    if (effective >= 30_000) {
      return originalSetTimeout(callback, 0);
    }
    return originalSetTimeout(callback, effective);
  }) as unknown as typeof setTimeout);
  return () => spy.mockRestore();
}

describe('spawnWorkflowNodeAgentForExecution — staged spawn interpreter', () => {
  test('ordering: createSubSession, CAS bind, ensureNodeAgentAttached, completion callback, kickoff inject, reservation released', async () => {
    const h = makeSpawnFlowHarness();

    const result = await h.spawn();

    expect(result).toBe(SPAWNED_SESSION_ID);
    expect(h.order).toEqual([
      'createSubSession',
      'execution-bind',
      'ensureNodeAgentAttached',
      'registerCompletionCallback',
      'kickoff-inject',
    ]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
    expect(h.reservations).toEqual([TASK_ID]);
    expect(h.reservationReleases).toEqual([TASK_ID]);
  });

  test('kickoff inject runs only when options.kickoff allows it', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false });

    await h.spawn();

    expect(h.order).toContain('registerCompletionCallback');
    expect(h.order).not.toContain('kickoff-inject');
    expect(h.spawningIds().has('exec-1')).toBe(false);
  });

  test('indexed live session is reused: rebinds the execution via CAS and returns the id without spawning or reserving', async () => {
    const h = makeSpawnFlowHarness({
      execution: makeExecution({ agentSessionId: 'live-session', status: 'idle' }),
    });
    seedIndexedSession(h.tam, 'live-session');

    const result = await h.spawn();

    expect(result).toBe('live-session');
    expect(h.casCalls[0]).toEqual({
      id: 'exec-1',
      expected: ['idle'],
      next: 'in_progress',
      payload: {
        agentSessionId: 'live-session',
        startedAt: expect.any(Number),
        completedAt: null,
      },
    });
    expect(h.order).toEqual([]);
    expect(h.reservations).toEqual([]);
  });

  test('reuse_live clears no reservation: a concurrent peer keeps its in-flight spawn guard', async () => {
    const h = makeSpawnFlowHarness({
      execution: makeExecution({ agentSessionId: 'live-session', status: 'idle' }),
    });
    seedIndexedSession(h.tam, 'live-session');
    h.spawningIds().add('exec-1');

    const result = await h.spawn();

    expect(result).toBe('live-session');
    expect(h.spawningIds().has('exec-1')).toBe(true);
  });

  test('indexed but dead session: evicted from the index and spawned fresh', async () => {
    const h = makeSpawnFlowHarness({
      execution: makeExecution({ agentSessionId: 'zombie-session', status: 'idle' }),
      kickoff: false,
    });
    seedIndexedSession(h.tam, 'zombie-session', 'completed');
    const index = h.tam as unknown as { agentSessionIndex: Map<string, AgentSession> };

    const result = await h.spawn();

    expect(result).toBe(SPAWNED_SESSION_ID);
    expect(index.agentSessionIndex.has('zombie-session')).toBe(false);
    expect(h.order).toContain('createSubSession');
  });

  test('fresh-task re-read is authoritative: repo archived beats an open caller snapshot', async () => {
    const h = makeSpawnFlowHarness({ taskStatus: 'archived', callerTask: makeTask('in_progress') });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow('Task task-1240 is archived');
    expect(h.order).toEqual([]);
  });

  test('missing repo task falls back to the caller snapshot', async () => {
    const h = makeSpawnFlowHarness({ taskMissing: true, kickoff: false });

    const result = await h.spawn();

    expect(result).toBe(SPAWNED_SESSION_ID);
    expect(h.order).toContain('createSubSession');
  });

  test('slot-resolution failure is a permanent rejection routed through the rejection halt', async () => {
    const h = makeSpawnFlowHarness({
      workflow: makeWorkflow([
        {
          id: NODE_ID,
          agents: [
            { agentId: 'agent-a', name: 'alice' },
            { agentId: 'agent-b', name: 'bob' },
          ],
        },
      ]),
    });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow(
      `Agent slot ${AGENT_NAME} no longer exists on workflow node ${NODE_ID}`
    );
    expect(h.order).toEqual([]);
    expect(h.cancels).toEqual([]);
  });

  test('a bind the CAS loses (concurrent writer) skips for this call: no blocked write, spawned session compensated, no resurrection (AFTER picture)', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false, bindCasOutcome: 'superseded' });
    const spawnPromise = h.spawn();

    await expect(spawnPromise).rejects.toBeInstanceOf(SpawnSupersededError);
    await expect(spawnPromise).rejects.toThrow('superseded at stage bind-execution-session');

    expect(h.updates).toEqual([]);
    expect(h.order).not.toContain('ensureNodeAgentAttached');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
    expect(h.reservationReleases).toEqual([TASK_ID]);
  });

  test('a foreign session binding landing mid-spawn fails the bind identity guard: no overwrite, session compensated, foreign binding survives (PR #2770 review)', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false });
    const internal = h.tam as unknown as {
      createSubSession: (...args: unknown[]) => Promise<string>;
    };
    const originalCreate = internal.createSubSession.bind(internal);
    internal.createSubSession = async (...args: unknown[]) => {
      const sessionId = await originalCreate(...args);
      h.setExecutionSessionId('foreign-direct-session');
      return sessionId;
    };

    const spawnPromise = h.spawn();

    await expect(spawnPromise).rejects.toThrow('superseded at stage bind-execution-session');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.order).not.toContain('ensureNodeAgentAttached');
    expect(h.casCalls.some((c) => c.payload?.agentSessionId === 'foreign-direct-session')).toBe(
      false
    );
  });

  test('a failure after session creation cancels the spawned session, releases the reservation, and rethrows', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false, failEnsure: true });

    await expect(h.spawn()).rejects.toThrow('attach boom');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
    expect(h.reservationReleases).toEqual([TASK_ID]);
  });

  test('the staged flow never transfers a reused session — it always spawns fresh (PR #2770 final-round descope)', async () => {
    const seenMemberInfo: Array<Record<string, unknown>> = [];
    const h = makeSpawnFlowHarness({ kickoff: false });
    const tam = h.tam as unknown as {
      createSubSession: (...args: unknown[]) => Promise<string>;
    };
    const original = tam.createSubSession.bind(tam);
    tam.createSubSession = async (...args: unknown[]) => {
      seenMemberInfo.push(args[3] as Record<string, unknown>);
      return original(...args);
    };

    await h.spawn();

    expect(seenMemberInfo).toHaveLength(1);
    expect(seenMemberInfo[0]?.freshSessionOnly).toBe(true);
    expect(seenMemberInfo[0]?.deferFreshExecutionBind).toBe(true);
  });

  test('a task-reservation loser does not fail the winning spawn waiters (PR #2770 review)', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false, taskStatus: 'stopped' });
    h.spawningIds().add('exec-1');
    const waitPromise = (
      h.tam as unknown as {
        waitForConcurrentSpawnSession: (execution: NodeExecution) => Promise<string>;
      }
    ).waitForConcurrentSpawnSession(makeExecution());
    const settled = waitPromise.then(
      () => 'settled',
      (err: unknown) => `rejected:${err instanceof Error ? err.message : String(err)}`
    );
    h.spawningIds().delete('exec-1');

    const loser = h.spawn();

    await expect(loser).rejects.toThrow('superseded at stage reserve-task-spawn');
    expect(
      (h.tam as unknown as { concurrentSpawnWaiters: Map<string, unknown[]> })
        .concurrentSpawnWaiters.size
    ).toBe(1);
    expect(
      await Promise.race([settled, new Promise((r) => setTimeout(() => r('pending'), 50))])
    ).toBe('pending');
  });

  test('an admission failure before session creation cancels nothing and reserves nothing', async () => {
    const h = makeSpawnFlowHarness({ taskStatus: 'archived' });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    expect(h.cancels).toEqual([]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
    expect(h.reservations).toEqual([]);
  });

  test('a parked (stopped) task fails the spawn reservation into superseded instead of spawning (AFTER picture)', async () => {
    const h = makeSpawnFlowHarness({ taskStatus: 'stopped', kickoff: false });

    await expect(h.spawn()).rejects.toBeInstanceOf(SpawnSupersededError);
    await expect(h.spawn()).rejects.toThrow('superseded at stage reserve-task-spawn');
    expect(h.order).toEqual([]);
    expect(h.casCalls).toEqual([]);
    expect(h.cancels).toEqual([]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
    expect(h.reservationReleases).toEqual([]);
  });

  test('a second call waits on the in-flight peer through the promise handoff', async () => {
    const gate = deferred<{ path: string }>();
    const h = makeSpawnFlowHarness({ kickoff: false, worktreeGate: gate.promise });

    const first = h.spawn();
    const second = h.spawn();
    gate.resolve({ path: '/tmp/wt-1240' });

    expect(await second).toBe(SPAWNED_SESSION_ID);
    expect(await first).toBe(SPAWNED_SESSION_ID);
    expect(h.order.filter((step) => step === 'createSubSession')).toHaveLength(1);
    expect(h.casCalls.some((c) => c.payload?.agentSessionId === SPAWNED_SESSION_ID)).toBe(true);
  });

  test('waiters settle at the winning bind, not after kickoff: a slow attach/kickoff cannot time out a waiting peer (PR #2770 review)', async () => {
    const gate = deferred<{ path: string }>();
    const kickoffGate = deferred<void>();
    const h = makeSpawnFlowHarness({
      worktreeGate: gate.promise,
      kickoffGate: kickoffGate.promise,
    });

    const first = h.spawn();
    const second = h.spawn();
    gate.resolve({ path: '/tmp/wt-1240' });

    expect(await second).toBe(SPAWNED_SESSION_ID);
    expect(h.order).toContain('execution-bind');
    expect(h.order).not.toContain('kickoff-inject');
    expect(
      (h.tam as unknown as { concurrentSpawnWaiters: Map<string, unknown[]> })
        .concurrentSpawnWaiters.size
    ).toBe(0);

    kickoffGate.resolve();
    expect(await first).toBe(SPAWNED_SESSION_ID);
    expect(h.order).toContain('kickoff-inject');
  });

  test('a timed-out waiter removes itself from the waiter map (PR #2770 review)', async () => {
    const restoreTimers = fireLongTimersImmediately();
    const h = makeSpawnFlowHarness({ kickoff: false });
    h.spawningIds().add('exec-1');
    const waiters = (h.tam as unknown as { concurrentSpawnWaiters: Map<string, unknown[]> })
      .concurrentSpawnWaiters;

    const waitPromise = (
      h.tam as unknown as {
        waitForConcurrentSpawnSession: (execution: NodeExecution) => Promise<string>;
      }
    ).waitForConcurrentSpawnSession(makeExecution());
    const message = waitPromise.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );

    expect(await message).toBe('Concurrent spawn for execution exec-1 timed out after 30000ms');
    expect(waiters.size).toBe(0);
    restoreTimers();
  });

  test('cleanupAll settles pending waiters as failed (PR #2770 review)', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false });
    h.spawningIds().add('exec-1');

    const waitPromise = (
      h.tam as unknown as {
        waitForConcurrentSpawnSession: (execution: NodeExecution) => Promise<string>;
      }
    ).waitForConcurrentSpawnSession(makeExecution());
    const message = waitPromise.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );

    await h.tam.cleanupAll();

    expect(await message).toBe(
      'Concurrent spawn for execution exec-1 failed before session was created'
    );
  });
});
