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
import {
  PermanentSpawnError,
  TransientSpawnError,
} from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const TASK_ID = 'task-1237';
const RUN_ID = 'run-1237';
const SPACE_ID = 'space-1237';
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
    title: 'Pin spawn admission',
    description: 'Characterize the TaskAgentManager spawn seam before extraction',
    taskNumber: 1237,
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
    customPrompt: 'do the pinned work',
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

interface SpawnHarnessOptions {
  taskStatus?: string;
  callerTask?: SpaceTask;
  taskMissing?: boolean;
  execution?: NodeExecution;
  workflow?: SpaceWorkflow | null;
  kickoff?: boolean;
  worktreeGate?: Promise<{ path: string }>;
  missingAgent?: boolean;
  failEnsure?: boolean;
  bindCasOutcome?: 'won' | 'superseded';
  rebindCasOutcome?: 'won' | 'superseded';
}

export interface SpawnAdmissionCasCall {
  id: string;
  expected: string[];
  next: string;
  payload?: {
    agentSessionId?: string | null;
    startedAt?: number | null;
    completedAt?: number | null;
  };
}

interface SpawnHarness {
  tam: TaskAgentManager;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  casCalls: SpawnAdmissionCasCall[];
  order: string[];
  cancels: string[];
  reservations: string[];
  reservationReleases: string[];
  spawn: () => Promise<string>;
}

function makeSpawnHarness(options: SpawnHarnessOptions = {}): SpawnHarness {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const casCalls: SpawnAdmissionCasCall[] = [];
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
        if (patch.status === 'in_progress' && patch.agentSessionId === SPAWNED_SESSION_ID) {
          order.push('execution-bind');
        }
        if (id === row.id) Object.assign(dbRow, patch);
        return { ...dbRow };
      },
      casExecutionStatus: (
        id: string,
        expected: readonly string[] | string,
        next: string,
        payload?: SpawnAdmissionCasCall['payload']
      ): 'won' | 'superseded' => {
        const expectedList = Array.isArray(expected) ? [...expected] : [expected];
        casCalls.push({ id, expected: expectedList, next, payload });
        if (next === 'in_progress' && payload?.agentSessionId === 'live-session') {
          return options.rebindCasOutcome ?? 'won';
        }
        if (options.bindCasOutcome && next === 'in_progress' && payload?.agentSessionId) {
          return options.bindCasOutcome;
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
      getById: (id: string) =>
        options.missingAgent || id !== AGENT_ID ? undefined : fakeCustomAgent(),
    },
    ...(options.worktreeGate
      ? { worktreeManager: { createTaskWorktree: () => options.worktreeGate } }
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

describe('spawnWorkflowNodeAgentForExecution — admission table', () => {
  test('indexed live session is reused: rebinds the execution to in_progress via CAS and returns the id', async () => {
    const h = makeSpawnHarness({
      execution: makeExecution({
        agentSessionId: 'live-session',
        status: 'idle',
        startedAt: 1234,
        completedAt: 5678,
      }),
    });
    seedIndexedSession(h.tam, 'live-session');

    const result = await h.spawn();

    expect(result).toBe('live-session');
    expect(h.updates).toEqual([]);
    expect(h.casCalls).toHaveLength(1);
    expect(h.casCalls[0]).toEqual({
      id: 'exec-1',
      expected: ['pending', 'in_progress', 'idle', 'waiting_rebind'],
      next: 'in_progress',
      payload: {
        agentSessionId: 'live-session',
        startedAt: 1234,
        completedAt: null,
      },
    });
    expect(h.order).toEqual([]);
  });

  test('live-session reuse precedes task validation: an archived task still rebinds', async () => {
    const h = makeSpawnHarness({
      taskStatus: 'archived',
      execution: makeExecution({
        agentSessionId: 'live-session',
        status: 'idle',
        startedAt: 1234,
      }),
    });
    seedIndexedSession(h.tam, 'live-session');

    const result = await h.spawn();

    expect(result).toBe('live-session');
    expect(h.casCalls).toHaveLength(1);
    expect(h.casCalls[0]?.payload).toEqual({
      agentSessionId: 'live-session',
      startedAt: 1234,
      completedAt: null,
    });
    expect(h.order).toEqual([]);
  });

  test('rebind fills startedAt from the clock when the snapshot has none', async () => {
    const h = makeSpawnHarness({
      execution: makeExecution({ agentSessionId: 'live-session', status: 'idle', startedAt: null }),
    });
    seedIndexedSession(h.tam, 'live-session');

    await h.spawn();

    expect(typeof h.casCalls[0]?.payload?.startedAt).toBe('number');
  });

  test('indexed but dead session: evicted from the index and spawned fresh', async () => {
    const h = makeSpawnHarness({
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

  test('agentSessionId present but not indexed: spawns fresh without touching the index', async () => {
    const h = makeSpawnHarness({
      execution: makeExecution({ agentSessionId: 'ghost-session', status: 'idle' }),
      kickoff: false,
    });
    const index = h.tam as unknown as { agentSessionIndex: Map<string, AgentSession> };

    const result = await h.spawn();

    expect(result).toBe(SPAWNED_SESSION_ID);
    expect(index.agentSessionIndex.has('ghost-session')).toBe(false);
    expect(h.order).toContain('createSubSession');
  });

  test('fresh-task re-read is authoritative: repo archived beats an open caller snapshot', async () => {
    const h = makeSpawnHarness({ taskStatus: 'archived', callerTask: makeTask('in_progress') });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow('Task task-1237 is archived');
    expect(h.order).toEqual([]);
  });

  test('fresh-task re-read is authoritative: repo open beats an archived caller snapshot', async () => {
    const h = makeSpawnHarness({
      taskStatus: 'in_progress',
      callerTask: makeTask('archived'),
      kickoff: false,
    });

    const result = await h.spawn();

    expect(result).toBe(SPAWNED_SESSION_ID);
    expect(h.order).toContain('createSubSession');
  });

  test('missing repo task falls back to the caller snapshot', async () => {
    const h = makeSpawnHarness({ taskMissing: true, kickoff: false });

    const result = await h.spawn();

    expect(result).toBe(SPAWNED_SESSION_ID);
    expect(h.order).toContain('createSubSession');
  });

  test('archived task is a permanent spawn rejection', async () => {
    const h = makeSpawnHarness({ taskStatus: 'archived' });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow('workflow node execution cannot be spawned');
    expect(h.order).toEqual([]);
  });

  test('cancelled task is a permanent spawn rejection', async () => {
    const h = makeSpawnHarness({ taskStatus: 'cancelled' });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    expect(h.order).toEqual([]);
  });

  test('rate_limited task is a transient spawn rejection', async () => {
    const h = makeSpawnHarness({ taskStatus: 'rate_limited' });

    await expect(h.spawn()).rejects.toBeInstanceOf(TransientSpawnError);
    await expect(h.spawn()).rejects.toThrow('deferring spawn until the cap resets');
    expect(h.order).toEqual([]);
  });

  test('usage_limited task is a transient spawn rejection', async () => {
    const h = makeSpawnHarness({ taskStatus: 'usage_limited' });

    await expect(h.spawn()).rejects.toBeInstanceOf(TransientSpawnError);
    expect(h.order).toEqual([]);
  });

  test('PARKED stopped task fails the spawn reservation: no spawn, no execution write (AFTER picture, superpipe P5)', async () => {
    const h = makeSpawnHarness({ taskStatus: 'stopped', kickoff: false });

    await expect(h.spawn()).rejects.toThrow('superseded at stage reserve-task-spawn');

    expect(h.order).toEqual([]);
    expect(h.casCalls).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.cancels).toEqual([]);
    expect(h.reservationReleases).toEqual([]);
  });

  test('null workflow (definition vanished) is a permanent rejection', async () => {
    const h = makeSpawnHarness({ workflow: null });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow(`Workflow for execution exec-1 no longer exists`);
    expect(h.order).toEqual([]);
  });

  test('workflow no longer containing the node is a permanent rejection', async () => {
    const h = makeSpawnHarness({
      workflow: makeWorkflow([
        { id: 'node-gone', agents: [{ agentId: AGENT_ID, name: AGENT_NAME }] },
      ]),
    });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow('no longer exists in workflow definition');
    expect(h.order).toEqual([]);
  });

  test('slot-resolution failure (agent name absent from a multi-agent node) is a permanent rejection', async () => {
    const h = makeSpawnHarness({
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
  });

  test('slot re-pointed at a different agent id is a permanent rejection', async () => {
    const h = makeSpawnHarness({
      workflow: makeWorkflow([
        { id: NODE_ID, agents: [{ agentId: 'agent-other', name: AGENT_NAME }] },
      ]),
    });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow('now references agent agent-other instead of');
    expect(h.order).toEqual([]);
  });

  test('single-agent node with a renamed sole slot is a permanent rejection even though slot lookup resolves the sole slot', async () => {
    const h = makeSpawnHarness({
      workflow: makeWorkflow([
        { id: NODE_ID, agents: [{ agentId: AGENT_ID, name: 'renamed-slot' }] },
      ]),
    });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    await expect(h.spawn()).rejects.toThrow(
      `Agent slot ${AGENT_NAME} no longer exists on workflow node ${NODE_ID}`
    );
    expect(h.order).toEqual([]);
  });

  test('task-status validation precedes workflow validation', async () => {
    const h = makeSpawnHarness({
      taskStatus: 'cancelled',
      workflow: makeWorkflow([]),
    });

    await expect(h.spawn()).rejects.toThrow('Task task-1237 is cancelled');
    expect(h.order).toEqual([]);
  });
});

describe('spawnWorkflowNodeAgentForExecution — concurrent-spawn waiter', () => {
  test('a second call waits on the in-flight peer instead of spawning independently', async () => {
    const gate = deferred<{ path: string }>();
    const h = makeSpawnHarness({ kickoff: false, worktreeGate: gate.promise });

    const first = h.spawn();
    const second = h.spawn();
    gate.resolve({ path: '/tmp/wt-1237' });

    expect(await second).toBe(SPAWNED_SESSION_ID);
    expect(await first).toBe(SPAWNED_SESSION_ID);
    expect(h.order.filter((step) => step === 'createSubSession')).toHaveLength(1);
    expect(h.casCalls.some((c) => c.payload?.agentSessionId === SPAWNED_SESSION_ID)).toBe(true);
  });

  test('rejects when the in-flight peer fails before creating a session', async () => {
    const gate = deferred<{ path: string }>();
    const h = makeSpawnHarness({ kickoff: true, worktreeGate: gate.promise, missingAgent: true });

    const first = h.spawn();
    const second = h.spawn();
    const secondMessage = second.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
    gate.resolve({ path: '/tmp/wt-1237' });

    await expect(first).rejects.toThrow('Agent not found: agent-coder (task: task-1237)');
    expect(await secondMessage).toBe(
      'Concurrent spawn for execution exec-1 failed before session was created'
    );
    expect(h.cancels).toEqual([]);
    expect(h.order.filter((step) => step === 'createSubSession')).toHaveLength(0);
  });

  test('rejects with the concurrent-spawn timeout when the peer never produces a session', async () => {
    const gate = deferred<{ path: string }>();
    const h = makeSpawnHarness({ kickoff: false, worktreeGate: gate.promise });

    const first = h.spawn();
    const restoreTimers = fireActivationTimeoutImmediately();
    try {
      const second = h.spawn();
      await expect(second).rejects.toThrow('timed out after 30000ms');
    } finally {
      restoreTimers();
      gate.resolve({ path: '/tmp/wt-1237' });
    }
    await expect(first).resolves.toBe(SPAWNED_SESSION_ID);
    expect(h.order.filter((step) => step === 'createSubSession')).toHaveLength(1);
  });
});

describe('spawnWorkflowNodeAgentForExecution — post-create execution binding', () => {
  test('ordering: createSubSession, CAS execution bind, ensureNodeAgentAttached, completion callback, kickoff inject', async () => {
    const h = makeSpawnHarness();

    await h.spawn();

    expect(h.order).toEqual([
      'createSubSession',
      'execution-bind',
      'ensureNodeAgentAttached',
      'registerCompletionCallback',
      'kickoff-inject',
    ]);
  });

  test('kickoff inject runs only when options.kickoff allows it', async () => {
    const h = makeSpawnHarness({ kickoff: false });

    await h.spawn();

    expect(h.order).toContain('registerCompletionCallback');
    expect(h.order).not.toContain('kickoff-inject');
  });

  test('the bind carries the bindable-status precondition and the full bind payload (AFTER picture)', async () => {
    const h = makeSpawnHarness({ kickoff: false });

    await h.spawn();

    const bind = h.casCalls.find(
      (c) => c.payload?.agentSessionId === SPAWNED_SESSION_ID && c.next === 'in_progress'
    );
    expect(bind).toEqual({
      id: 'exec-1',
      expected: ['pending', 'in_progress', 'idle', 'waiting_rebind'],
      next: 'in_progress',
      payload: {
        agentSessionId: SPAWNED_SESSION_ID,
        startedAt: expect.any(Number),
        completedAt: null,
      },
    });
  });

  test('a concurrent execution write that fails the bind CAS skips for this call: the spawned session is cancelled and the execution is not resurrected (AFTER picture)', async () => {
    const h = makeSpawnHarness({ kickoff: false, bindCasOutcome: 'superseded' });
    const spawnPromise = h.spawn();

    await expect(spawnPromise).rejects.toThrow('superseded at stage bind-execution-session');

    expect(h.updates).toEqual([]);
    expect(h.order).not.toContain('ensureNodeAgentAttached');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.reservationReleases).toEqual([TASK_ID]);
  });

  test('a failure after session creation cancels the spawned session and rethrows', async () => {
    const h = makeSpawnHarness({ kickoff: false, failEnsure: true });

    await expect(h.spawn()).rejects.toThrow('attach boom');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
  });

  test('an admission failure before session creation cancels nothing', async () => {
    const h = makeSpawnHarness({ taskStatus: 'archived' });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    expect(h.cancels).toEqual([]);
  });
});

describe('spawnWorkflowNodeAgentForExecution — CAS-guarded spawn writes (AFTER picture, ADR 0004 Phase 0)', () => {
  test('live-session rebind a CAS loses to a concurrent cancel: the cancelled row is not clobbered and the call skips', async () => {
    const h = makeSpawnHarness({
      execution: makeExecution({
        agentSessionId: 'live-session',
        status: 'in_progress',
        startedAt: 42,
      }),
      rebindCasOutcome: 'superseded',
    });
    seedIndexedSession(h.tam, 'live-session');

    const spawnPromise = h.spawn();

    await expect(spawnPromise).rejects.toThrow('superseded at stage rebind-live-session');
    expect(h.casCalls[0]?.expected).toEqual(['pending', 'in_progress', 'idle', 'waiting_rebind']);
    expect(h.casCalls[0]?.payload).toEqual({
      agentSessionId: 'live-session',
      startedAt: 42,
      completedAt: null,
    });
    expect(h.updates).toEqual([]);
    expect(h.reservations).toEqual([]);
  });

  test('post-create bind carries the bindable-status precondition: exactly the in_progress bind payload', async () => {
    const h = makeSpawnHarness({ kickoff: false });

    await h.spawn();

    const bind = h.casCalls.find(
      (c) => c.payload?.agentSessionId === SPAWNED_SESSION_ID && c.next === 'in_progress'
    );
    expect(bind).toEqual({
      id: 'exec-1',
      expected: ['pending', 'in_progress', 'idle', 'waiting_rebind'],
      next: 'in_progress',
      payload: {
        agentSessionId: SPAWNED_SESSION_ID,
        startedAt: expect.any(Number),
        completedAt: null,
      },
    });
  });
});

interface ActivateHarness {
  tam: TaskAgentManager;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  casCalls: SpawnAdmissionCasCall[];
  order: string[];
  activate: (options?: {
    workflowNodeId?: string;
  }) => Promise<Array<{ agentName: string; sessionId: string }>>;
}

function makeActivateHarness(
  options: {
    executions?: NodeExecution[];
    indexSession?: { id: string; processingStatus: string };
    workflow?: SpaceWorkflow;
    spawn?: () => Promise<string>;
    resetCasOutcome?: 'won' | 'superseded';
  } = {}
): ActivateHarness {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const casCalls: SpawnAdmissionCasCall[] = [];
  const order: string[] = [];
  const rows = options.executions ?? [makeExecution()];
  const rowStatuses = new Map(rows.map((row) => [row.id, row.status]));

  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager: { registerSession: () => {}, getSession: () => undefined },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: (id: string) =>
        id === TASK_ID
          ? { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, status: 'in_progress' }
          : undefined,
    },
    workflowRunRepo: {
      getRun: (id: string) =>
        id === RUN_ID ? { id: RUN_ID, workflowId: 'wf-1', status: 'in_progress' } : undefined,
    },
    spaceWorkflowManager: {
      getWorkflowForRun: () => options.workflow ?? makeWorkflow(),
    },
    nodeExecutionRepo: {
      listByWorkflowRun: () => rows,
      update: (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return { ...makeExecution(), ...patch };
      },
      casExecutionStatus: (
        id: string,
        expected: readonly string[] | string,
        next: string,
        payload?: SpawnAdmissionCasCall['payload']
      ): 'won' | 'superseded' => {
        const expectedList = Array.isArray(expected) ? [...expected] : [expected];
        casCalls.push({ id, expected: expectedList, next, payload });
        if (next === 'pending' && options.resetCasOutcome) {
          return options.resetCasOutcome;
        }
        if (!expectedList.includes(rowStatuses.get(id) ?? 'pending')) return 'superseded';
        rowStatuses.set(id, next as NodeExecution['status']);
        return 'won';
      },
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
  } as unknown as TaskAgentManagerConfig);

  if (options.indexSession) {
    seedIndexedSession(tam, options.indexSession.id, options.indexSession.processingStatus);
  }

  const internal = tam as unknown as {
    ensureWorkflowNodeActivationForAgent: (...args: unknown[]) => Promise<boolean>;
    spawnWorkflowNodeAgentForExecution: (...args: unknown[]) => Promise<string>;
  };
  internal.ensureWorkflowNodeActivationForAgent = async () => {
    order.push('activation');
    return true;
  };
  internal.spawnWorkflowNodeAgentForExecution =
    options.spawn ??
    (() => {
      order.push('spawn');
      return Promise.resolve('new-session');
    });

  return {
    tam,
    updates,
    casCalls,
    order,
    activate: (activateOptions) =>
      tam.activateTargetSessionsForMessage(TASK_ID, RUN_ID, AGENT_NAME, activateOptions),
  };
}

function fireActivationTimeoutImmediately(onLongTimer?: (delay: number) => void): () => void {
  const originalSetTimeout = globalThis.setTimeout;
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number
  ) => {
    const effective = typeof delay === 'number' ? delay : 0;
    if (effective >= 30_000) {
      onLongTimer?.(effective);
      return originalSetTimeout(callback, 0);
    }
    return originalSetTimeout(callback, effective);
  }) as unknown as typeof setTimeout);
  return () => spy.mockRestore();
}

describe('activateTargetSessionsForMessage — admission', () => {
  test('an alive in_progress execution is reused without update or spawn', async () => {
    const h = makeActivateHarness({
      executions: [makeExecution({ status: 'in_progress', agentSessionId: 'live-session' })],
      indexSession: { id: 'live-session', processingStatus: 'processing' },
    });

    const result = await h.activate();

    expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: 'live-session' }]);
    expect(h.updates).toEqual([]);
    expect(h.order).toEqual([]);
  });

  test('an alive blocked execution is reused without update or spawn', async () => {
    const h = makeActivateHarness({
      executions: [makeExecution({ status: 'blocked', agentSessionId: 'live-session' })],
      indexSession: { id: 'live-session', processingStatus: 'idle' },
    });

    const result = await h.activate();

    expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: 'live-session' }]);
    expect(h.updates).toEqual([]);
  });

  test('a dead session resets the execution to pending via CAS and spawns fresh', async () => {
    const h = makeActivateHarness({
      executions: [makeExecution({ status: 'in_progress', agentSessionId: 'dead-session' })],
      indexSession: { id: 'dead-session', processingStatus: 'completed' },
    });
    const restoreTimers = fireActivationTimeoutImmediately();
    const index = h.tam as unknown as { agentSessionIndex: Map<string, AgentSession> };

    try {
      const result = await h.activate();

      expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: 'new-session' }]);
      expect(h.updates).toEqual([]);
      expect(h.casCalls).toEqual([{ id: 'exec-1', expected: ['in_progress'], next: 'pending' }]);
      expect(index.agentSessionIndex.has('dead-session')).toBe(false);
      expect(h.order).toEqual(['activation', 'spawn']);
    } finally {
      restoreTimers();
    }
  });

  test('dead-session reset is CAS-guarded from the just-read status: a concurrent move skips activation for this call (AFTER picture, ADR 0004 Phase 0)', async () => {
    const h = makeActivateHarness({
      executions: [makeExecution({ status: 'in_progress', agentSessionId: 'dead-session' })],
      resetCasOutcome: 'superseded',
    });
    const restoreTimers = fireActivationTimeoutImmediately();

    try {
      const result = await h.activate();

      expect(result).toEqual([]);
      expect(h.casCalls).toEqual([{ id: 'exec-1', expected: ['in_progress'], next: 'pending' }]);
      expect(h.order).toEqual([]);
    } finally {
      restoreTimers();
    }
  });

  test('a declared workflowNodeId with an undeclared agent name rejects with [] before activation', async () => {
    const h = makeActivateHarness({
      executions: [makeExecution()],
      workflow: makeWorkflow([
        { id: NODE_ID, agents: [{ agentId: 'agent-other', name: 'other' }] },
      ]),
    });

    const result = await h.activate({ workflowNodeId: NODE_ID });

    expect(result).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.order).toEqual([]);
  });

  test('a declared workflowNodeId proceeds through activation to spawn', async () => {
    const h = makeActivateHarness({ executions: [makeExecution()] });
    const restoreTimers = fireActivationTimeoutImmediately();

    try {
      const result = await h.activate({ workflowNodeId: NODE_ID });

      expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: 'new-session' }]);
      expect(h.order).toEqual(['activation', 'spawn']);
    } finally {
      restoreTimers();
    }
  });

  test('no matching execution after activation returns [] without spawning', async () => {
    const h = makeActivateHarness({ executions: [makeExecution({ agentName: 'other-agent' })] });

    const result = await h.activate();

    expect(result).toEqual([]);
    expect(h.order).toEqual(['activation']);
  });

  test('spawn timeout returns [] while the background spawn continues', async () => {
    const spawnOutcome = deferred<string>();
    const h = makeActivateHarness({ executions: [makeExecution()] });
    (
      h.tam as unknown as {
        spawnWorkflowNodeAgentForExecution: (...args: unknown[]) => Promise<string>;
      }
    ).spawnWorkflowNodeAgentForExecution = async () => {
      h.order.push('spawn');
      const sessionId = await spawnOutcome.promise;
      h.updates.push({
        id: 'exec-1',
        patch: { agentSessionId: sessionId, lateSpawnBound: true },
      });
      return sessionId;
    };
    let observedDelay: number | undefined;
    const restoreTimers = fireActivationTimeoutImmediately((delay) => {
      observedDelay = delay;
    });

    try {
      expect(observedDelay).toBeUndefined();
      const result = await h.activate();
      expect(result).toEqual([]);
      expect(observedDelay).toBe(30_000);
      expect(h.order).toEqual(['activation', 'spawn']);

      expect(h.updates.some((u) => u.patch.lateSpawnBound)).toBe(false);
      spawnOutcome.resolve('late-session');
      await spawnOutcome.promise;
      expect(h.updates.some((u) => u.patch.lateSpawnBound)).toBe(true);
      expect(h.updates.every((u) => u.patch.lateSpawnBound || u.patch.status === 'pending')).toBe(
        true
      );
    } finally {
      restoreTimers();
    }
  });
});
