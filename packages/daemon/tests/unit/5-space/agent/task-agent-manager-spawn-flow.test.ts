import { describe, expect, test } from 'bun:test';
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

interface SpawnFlowHarnessOptions {
  taskStatus?: string;
  callerTask?: SpaceTask;
  taskMissing?: boolean;
  execution?: NodeExecution;
  workflow?: SpaceWorkflow | null;
  kickoff?: boolean;
  worktreeGate?: Promise<{ path: string }>;
  failEnsure?: boolean;
}

interface SpawnFlowHarness {
  tam: TaskAgentManager;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  order: string[];
  cancels: string[];
  setReadback: (row: NodeExecution | null) => void;
  spawningIds: () => Set<string>;
  spawn: () => Promise<string>;
}

function makeSpawnFlowHarness(options: SpawnFlowHarnessOptions = {}): SpawnFlowHarness {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const order: string[] = [];
  const cancels: string[] = [];
  const row = options.execution ?? makeExecution();
  const dbRow: NodeExecution = { ...row };
  const taskStatus = options.taskStatus ?? 'in_progress';
  let readback: NodeExecution | null | undefined;

  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
    sessionManager: { registerSession: () => {}, getSession: () => undefined },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: (id: string) =>
        options.taskMissing || id !== TASK_ID ? undefined : makeTask(taskStatus),
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
        if (readback !== undefined) return readback;
        return { ...dbRow };
      },
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    spaceAgentManager: {
      getById: (id: string) => (id !== AGENT_ID ? undefined : fakeCustomAgent()),
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
    order,
    cancels,
    setReadback: (value) => {
      readback = value;
    },
    spawningIds: () => internal.spawningExecutionIds,
    spawn: () =>
      tam.spawnWorkflowNodeAgentForExecutionViaFlow(
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

describe('spawnWorkflowNodeAgentForExecutionViaFlow — staged composition parity', () => {
  test('ordering: createSubSession, execution bind, ensureNodeAgentAttached, completion callback, kickoff inject', async () => {
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
  });

  test('kickoff inject runs only when options.kickoff allows it', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false });

    await h.spawn();

    expect(h.order).toContain('registerCompletionCallback');
    expect(h.order).not.toContain('kickoff-inject');
    expect(h.spawningIds().has('exec-1')).toBe(false);
  });

  test('indexed live session is reused: rebinds the execution and returns the id without spawning', async () => {
    const h = makeSpawnFlowHarness({
      execution: makeExecution({ agentSessionId: 'live-session', status: 'idle' }),
    });
    seedIndexedSession(h.tam, 'live-session');

    const result = await h.spawn();

    expect(result).toBe('live-session');
    expect(h.updates[0]).toEqual({
      id: 'exec-1',
      patch: {
        status: 'in_progress',
        agentSessionId: 'live-session',
        startedAt: expect.any(Number),
        completedAt: null,
      },
    });
    expect(h.order).toEqual([]);
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

  test('readback returning null blocks the execution, cancels the session, and throws corruption', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false });
    h.setReadback(null);

    await expect(h.spawn()).rejects.toThrow('Execution state corruption after spawn for exec-1');

    expect(h.updates[1]).toEqual({
      id: 'exec-1',
      patch: {
        status: 'blocked',
        result: 'Execution state corruption after spawn',
        completedAt: expect.any(Number),
      },
    });
    expect(h.order).not.toContain('ensureNodeAgentAttached');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
  });

  test('a failure after session creation cancels the spawned session, releases the reservation, and rethrows', async () => {
    const h = makeSpawnFlowHarness({ kickoff: false, failEnsure: true });

    await expect(h.spawn()).rejects.toThrow('attach boom');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
  });

  test('an admission failure before session creation cancels nothing', async () => {
    const h = makeSpawnFlowHarness({ taskStatus: 'archived' });

    await expect(h.spawn()).rejects.toBeInstanceOf(PermanentSpawnError);
    expect(h.cancels).toEqual([]);
    expect(h.spawningIds().has('exec-1')).toBe(false);
  });

  test('a second call waits on the in-flight peer through the shell wait loop', async () => {
    const gate = deferred<{ path: string }>();
    const h = makeSpawnFlowHarness({ kickoff: false, worktreeGate: gate.promise });

    const first = h.spawn();
    const second = h.spawn();
    gate.resolve({ path: '/tmp/wt-1240' });

    expect(await second).toBe(SPAWNED_SESSION_ID);
    expect(await first).toBe(SPAWNED_SESSION_ID);
    expect(h.order.filter((step) => step === 'createSubSession')).toHaveLength(1);
    expect(h.updates.some((u) => u.patch.agentSessionId === SPAWNED_SESSION_ID)).toBe(true);
  });
});
