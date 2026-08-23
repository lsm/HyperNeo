import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type {
  AgentSessionInit,
  AgentSession as AgentSessionType,
} from '../../../../src/lib/agent/agent-session.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const TASK_ID = 'task-850';
const RUN_ID = 'run-850';
const SPACE_ID = 'space-850';
const REVIEWER_NODE_ID = 'node-reviewer';
const REVIEWER_AGENT = 'reviewer';
const REVIEWER_SESSION_ID = 'reviewer-session-live';

function makeFakeSession(id: string = REVIEWER_SESSION_ID) {
  const calls: string[] = [];
  const configUpdates: Array<Record<string, unknown>> = [];
  const session = {
    session: { id },
    skillOverrides: undefined,
    toolGuards: undefined,
    onMissingWorkflowMcpServers: undefined,
    updateConfig: async (arg: Record<string, unknown>): Promise<void> => {
      calls.push('updateConfig');
      configUpdates.push(arg);
    },
    mergeRuntimeMcpServers: (): void => {
      calls.push('mergeRuntimeMcpServers');
    },
    startStreamingQuery: async (): Promise<void> => {
      calls.push('startStreamingQuery');
    },
  };
  return { session: session as unknown as AgentSessionType, calls, configUpdates };
}

function makeCapturingFakeSession(id: string): {
  session: AgentSessionType;
  mergedArgs: Record<string, unknown>[];
} {
  const mergedArgs: Record<string, unknown>[] = [];
  const session = {
    session: { id },
    skillOverrides: undefined,
    toolGuards: undefined,
    onMissingWorkflowMcpServers: undefined,
    onMissingMemberSpaceMcpServers: undefined as
      | ((sessionId: string, missing: string[]) => Promise<void>)
      | undefined,
    updateConfig: async (): Promise<void> => {},
    mergeRuntimeMcpServers: (arg: Record<string, unknown>): void => {
      mergedArgs.push(arg);
    },
    startStreamingQuery: async (): Promise<void> => {},
  };
  return { session: session as unknown as AgentSessionType, mergedArgs };
}

function reviewerExec(sessionId: string = REVIEWER_SESSION_ID) {
  return {
    id: 'reviewer-exec-1',
    workflowRunId: RUN_ID,
    workflowNodeId: REVIEWER_NODE_ID,
    agentName: REVIEWER_AGENT,
    agentId: 'agent-reviewer',
    agentSessionId: sessionId,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
  };
}

function recordingCas(
  updates: Array<{ id: string; payload: Record<string, unknown> }>,
  rows: Array<Record<string, unknown>>
): (
  id: string,
  expected: readonly string[],
  next: string,
  payload?: Record<string, unknown>
) => 'won' | 'superseded' {
  return (id, expected, next, payload) => {
    updates.push({
      id,
      payload: { status: next, ...payload, __cas: expected },
    });
    const row = rows.find((candidate) => candidate.id === id);
    if (!row || !expected.includes(String(row.status))) return 'superseded';
    row.status = next;
    return 'won';
  };
}

function makeManager(rows: unknown[] = [reviewerExec()]): TaskAgentManager {
  return new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager: { registerSession: () => {} },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'Task 850' }),
    },
    nodeExecutionRepo: {
      listByWorkflowRun: () => rows,
      listByNode: () => rows,
      update: () => rows[0],
      casExecutionStatus: recordingCas(
        [],
        rows.map((row) => row as Record<string, unknown>)
      ),
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
  } as unknown as TaskAgentManagerConfig);
}

function seedLiveSession(
  tam: TaskAgentManager,
  sessionId: string = REVIEWER_SESSION_ID
): ReturnType<typeof makeFakeSession> {
  const fake = makeFakeSession(sessionId);
  const subSessions = (
    tam as unknown as {
      subSessions: Map<string, Map<string, AgentSessionType>>;
    }
  ).subSessions;
  if (!subSessions.has(TASK_ID)) subSessions.set(TASK_ID, new Map());
  subSessions.get(TASK_ID)!.set(sessionId, fake.session);
  (tam as unknown as { agentSessionIndex: Map<string, AgentSessionType> }).agentSessionIndex.set(
    sessionId,
    fake.session
  );
  return fake;
}

function stubReusePathHelpers(tam: TaskAgentManager): void {
  (
    tam as unknown as { reinjectNodeAgentMcpServer: (...a: unknown[]) => Promise<void> }
  ).reinjectNodeAgentMcpServer = async () => {};
  (
    tam as unknown as { ensureRequiredMcpServersAttached: (...a: unknown[]) => Promise<void> }
  ).ensureRequiredMcpServersAttached = async () => {};
  (
    tam as unknown as { registerCompletionCallback: (...a: unknown[]) => void }
  ).registerCompletionCallback = () => {};
}

function minimalInit(): AgentSessionInit {
  return { title: 'post-approval', model: 'm', mcpServers: {} } as unknown as AgentSessionInit;
}

describe('spawnPostApprovalSubSession — reuse-if-exists else create', () => {
  let fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;

  beforeEach(() => {
    fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation(
      (() => makeFakeSession('fresh-session').session) as unknown as typeof AgentSession.fromInit
    );
  });
  afterEach(() => {
    fromInitSpy.mockRestore();
  });

  test('reuses the target agent live session and injects the kickoff directly (no fresh session)', async () => {
    const tam = makeManager();
    seedLiveSession(tam);
    const injected: Array<{ sessionId: string; message: string }> = [];
    (
      tam as unknown as {
        injectMessageIntoSession: (s: { session: { id: string } }, m: string) => Promise<string>;
      }
    ).injectMessageIntoSession = async (s, m) => {
      injected.push({ sessionId: s.session.id, message: m });
      return 'msg-id';
    };

    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
      name: 'Coding',
      nodes: [
        {
          id: REVIEWER_NODE_ID,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: REVIEWER_AGENT }],
        },
      ],
      channels: [],
      startNodeId: REVIEWER_NODE_ID,
      endNodeId: REVIEWER_NODE_ID,
    } as unknown as SpaceWorkflow;
    const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID } as unknown as SpaceTask;

    const result = await tam.spawnPostApprovalSubSession({
      task,
      workflow,
      targetAgent: REVIEWER_AGENT,
      kickoffMessage: 'merge the PR',
    });

    expect(result.sessionId).toBe(REVIEWER_SESSION_ID);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toEqual({ sessionId: REVIEWER_SESSION_ID, message: 'merge the PR' });
    expect(fromInitSpy).not.toHaveBeenCalled();
  });

  test('createSubSession still reuses the prior session for a normal second activation (hard constraint)', async () => {
    const tam = makeManager();
    seedLiveSession(tam);
    stubReusePathHelpers(tam);

    const memberInfo = {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    };
    const proposedId = 'some-other-proposed-id';

    const actual = await tam.createSubSession(TASK_ID, proposedId, minimalInit(), memberInfo);

    expect(actual).toBe(REVIEWER_SESSION_ID);
    expect(actual).not.toBe(proposedId);
    expect(fromInitSpy).not.toHaveBeenCalled();
  });

  test('stale co-owner sweep preserves blocked status (only active owners become idle)', async () => {
    const NODE_2 = 'node-2';
    const staleCoOwner = {
      id: 'exec-blocked',
      workflowRunId: RUN_ID,
      workflowNodeId: REVIEWER_NODE_ID,
      agentName: REVIEWER_AGENT,
      agentId: 'agent-reviewer',
      agentSessionId: REVIEWER_SESSION_ID,
      status: 'blocked',
      result: 'dependency failed',
      data: null,
      createdAt: 0,
      startedAt: 0,
      completedAt: null,
      updatedAt: 0,
    };
    const targetExec = {
      id: 'exec-target',
      workflowRunId: RUN_ID,
      workflowNodeId: NODE_2,
      agentName: REVIEWER_AGENT,
      agentId: 'agent-reviewer',
      agentSessionId: null,
      status: 'pending',
      result: null,
      data: null,
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      updatedAt: 0,
    };
    const pendingCoOwner = {
      id: 'exec-pending',
      workflowRunId: RUN_ID,
      workflowNodeId: 'node-3',
      agentName: REVIEWER_AGENT,
      agentId: 'agent-reviewer',
      agentSessionId: REVIEWER_SESSION_ID,
      status: 'pending',
      result: null,
      data: null,
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      updatedAt: 0,
    };
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: {
        getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
      },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [staleCoOwner, pendingCoOwner, targetExec],
        listByNode: (_runId: string, nodeId: string) =>
          nodeId === NODE_2 ? [targetExec] : [staleCoOwner, pendingCoOwner],
        update: (id: string, payload: Record<string, unknown>) => {
          updates.push({ id, payload });
          return null;
        },
        casExecutionStatus: recordingCas(updates, [
          staleCoOwner,
          pendingCoOwner,
          targetExec,
        ] as Array<Record<string, unknown>>),
      },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    } as unknown as TaskAgentManagerConfig);
    seedLiveSession(tam);
    stubReusePathHelpers(tam);

    const actual = await tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: NODE_2,
    });

    expect(actual).toBe(REVIEWER_SESSION_ID);
    const coOwnerUpdate = updates.find((u) => u.id === 'exec-blocked');
    expect(coOwnerUpdate).toBeTruthy();
    expect(coOwnerUpdate!.payload.agentSessionId).toBeNull();
    expect(coOwnerUpdate!.payload.status).toBeUndefined();
    const pendingUpdate = updates.find((u) => u.id === 'exec-pending');
    expect(pendingUpdate).toBeTruthy();
    expect(pendingUpdate!.payload.agentSessionId).toBeNull();
    expect(pendingUpdate!.payload.status).toBeUndefined();
  });

  test('createSubSession creates a new session when no prior session exists', async () => {
    const tam = makeManager([]);

    const freshId = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:${REVIEWER_AGENT}`;
    const actual = await tam.createSubSession(TASK_ID, freshId, minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    expect(actual).toBe(freshId);
    expect(fromInitSpy).toHaveBeenCalledTimes(1);
  });

  test('CREATE branch attaches space-agent-tools before first turn + wires self-heal (#852)', async () => {
    const tam = makeManager([]);
    (tam.config as unknown as { db: Record<string, unknown> }).db.getSession = () => null;
    (tam.config as unknown as Record<string, unknown>).workflowRunRepo = { getRun: () => null };
    (tam.config as unknown as Record<string, unknown>).spaceAgentManager = {
      getById: () => ({
        id: 'agent-reviewer',
        name: REVIEWER_AGENT,
        customPrompt: 'merge the approved PR',
        model: 'm',
        tools: [],
      }),
    };

    const satMarker = { __role: 'space-agent-tools' };
    const buildCalls: Array<{ spaceId: string; sessionId: string }> = [];
    const reattachCalls: string[] = [];
    (tam.config as unknown as Record<string, unknown>).spaceRuntimeService = {
      buildMemberSpaceToolsMcpServer: (space: { id: string }, sid: string) => {
        buildCalls.push({ spaceId: space.id, sessionId: sid });
        return satMarker;
      },
      reattachMemberSpaceTools: async (sid: string) => {
        reattachCalls.push(sid);
      },
    };
    (
      tam as unknown as { buildNodeAgentMcpServerForSession: () => unknown }
    ).buildNodeAgentMcpServerForSession = () => ({ __role: 'node-agent' });
    (
      tam as unknown as { ensureNodeAgentAttached: (...a: unknown[]) => Promise<void> }
    ).ensureNodeAgentAttached = async () => {};
    (
      tam as unknown as { injectMessageIntoSession: (...a: unknown[]) => Promise<string> }
    ).injectMessageIntoSession = async () => 'msg-id';

    const fake = makeCapturingFakeSession('fresh-merger');
    fromInitSpy.mockImplementation((() => fake.session) as unknown as typeof AgentSession.fromInit);

    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
      name: 'Coding',
      nodes: [
        {
          id: REVIEWER_NODE_ID,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: REVIEWER_AGENT }],
        },
      ],
      channels: [],
      gates: [],
      startNodeId: REVIEWER_NODE_ID,
      endNodeId: REVIEWER_NODE_ID,
    } as unknown as SpaceWorkflow;
    const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID } as unknown as SpaceTask;

    const result = await tam.spawnPostApprovalSubSession({
      task,
      workflow,
      targetAgent: REVIEWER_AGENT,
      kickoffMessage: 'merge the approved PR',
    });

    const merged = fake.mergedArgs.at(-1)!;
    expect(merged['space-agent-tools']).toBe(satMarker);
    expect(merged['node-agent']).toEqual({ __role: 'node-agent' });
    expect(buildCalls).toEqual([{ spaceId: SPACE_ID, sessionId: result.sessionId }]);

    expect(typeof fake.session.onMissingMemberSpaceMcpServers).toBe('function');
    await fake.session.onMissingMemberSpaceMcpServers!(result.sessionId, ['space-agent-tools']);
    expect(reattachCalls).toEqual([result.sessionId]);
  });
});

function makeExecutionRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: 'reviewer-exec-1',
    workflowRunId: RUN_ID,
    workflowNodeId: REVIEWER_NODE_ID,
    agentName: REVIEWER_AGENT,
    agentId: 'agent-reviewer',
    agentSessionId: REVIEWER_SESSION_ID,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 0,
    startedAt: 1,
    completedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRecordingManager(
  rows: Array<Record<string, unknown>>,
  listByNode?: (nodeId: string) => Array<Record<string, unknown>>
): {
  tam: TaskAgentManager;
  updates: Array<{ id: string; payload: Record<string, unknown> }>;
} {
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager: { registerSession: () => {} },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
    },
    nodeExecutionRepo: {
      listByWorkflowRun: () => rows,
      listByNode: (_runId: string, nodeId: string) => (listByNode ? listByNode(nodeId) : rows),
      listByAgentSessionId: () => [],
      update: (id: string, payload: Record<string, unknown>) => {
        updates.push({ id, payload });
        return null;
      },
      casExecutionStatus: recordingCas(updates, rows),
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
  } as unknown as TaskAgentManagerConfig);
  return { tam, updates };
}

function stubMcpReinjection(tam: TaskAgentManager): {
  reinjectCtx: Array<Record<string, unknown>>;
  ensureCtx: Array<Record<string, unknown>>;
} {
  const reinjectCtx: Array<Record<string, unknown>> = [];
  const ensureCtx: Array<Record<string, unknown>> = [];
  (
    tam as unknown as {
      reinjectNodeAgentMcpServer: (session: unknown, ctx: Record<string, unknown>) => Promise<void>;
    }
  ).reinjectNodeAgentMcpServer = async (_session, ctx) => {
    reinjectCtx.push(ctx);
  };
  (
    tam as unknown as {
      ensureRequiredMcpServersAttached: (
        session: unknown,
        ctx: Record<string, unknown>
      ) => Promise<void>;
    }
  ).ensureRequiredMcpServersAttached = async (_session, ctx) => {
    ensureCtx.push(ctx);
  };
  return { reinjectCtx, ensureCtx };
}

describe('createSubSession — reuse hard-constraint binding details (spawn seam pins)', () => {
  let fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;

  beforeEach(() => {
    fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation(
      (() => makeFakeSession('fresh-session').session) as unknown as typeof AgentSession.fromInit
    );
  });
  afterEach(() => {
    fromInitSpy.mockRestore();
  });

  test('reuse path updates the config and re-injects required MCP servers on the existing session', async () => {
    const { tam } = makeRecordingManager([makeExecutionRow()]);
    const live = seedLiveSession(tam);
    const { reinjectCtx, ensureCtx } = stubMcpReinjection(tam);
    (tam as unknown as { registerCompletionCallback: () => void }).registerCompletionCallback =
      () => {};

    const actual = await tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    expect(actual).toBe(REVIEWER_SESSION_ID);
    expect(live.configUpdates).toHaveLength(1);
    expect(live.configUpdates[0]).toMatchObject({ model: 'm' });
    expect(reinjectCtx).toHaveLength(1);
    expect(reinjectCtx[0]).toMatchObject({
      taskId: TASK_ID,
      subSessionId: REVIEWER_SESSION_ID,
      agentName: REVIEWER_AGENT,
      workflowNodeId: REVIEWER_NODE_ID,
    });
    expect(ensureCtx).toHaveLength(1);
    expect(ensureCtx[0]).toMatchObject({ subSessionId: REVIEWER_SESSION_ID, phase: 'spawn' });
    expect(fromInitSpy).not.toHaveBeenCalled();
  });

  test('reuse path rebinds the node execution through a bindable-status CAS (AFTER picture, superpipe P5)', async () => {
    const { tam, updates } = makeRecordingManager([makeExecutionRow()]);
    seedLiveSession(tam);
    stubMcpReinjection(tam);
    (tam as unknown as { registerCompletionCallback: () => void }).registerCompletionCallback =
      () => {};

    const actual = await tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    expect(actual).toBe(REVIEWER_SESSION_ID);
    const rebind = updates.find((u) => u.id === 'reviewer-exec-1');
    expect(rebind).toEqual({
      id: 'reviewer-exec-1',
      payload: {
        status: 'in_progress',
        agentSessionId: REVIEWER_SESSION_ID,
        startedAt: 1,
        completedAt: null,
        __cas: ['in_progress'],
      },
    });
  });

  test('reuse path replaces any stale completion callback with a fresh registration for the existing session', async () => {
    const { tam } = makeRecordingManager([makeExecutionRow()]);
    seedLiveSession(tam);
    stubMcpReinjection(tam);
    const callbacks = (
      tam as unknown as { completionCallbacks: Map<string, Array<() => Promise<void>>> }
    ).completionCallbacks;
    const stale = async (): Promise<void> => {};
    callbacks.set(REVIEWER_SESSION_ID, [stale]);

    const actual = await tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    expect(actual).toBe(REVIEWER_SESSION_ID);
    const registered = callbacks.get(REVIEWER_SESSION_ID);
    expect(registered).toHaveLength(1);
    expect(registered![0]).not.toBe(stale);
  });

  test('stale co-owner sweep preserves cancelled and waiting_rebind, flips only active co-owners to idle', async () => {
    const NODE_2 = 'node-2';
    const targetExec = makeExecutionRow({
      id: 'exec-target',
      workflowNodeId: NODE_2,
      agentSessionId: null,
      status: 'pending',
      startedAt: null,
    });
    const cancelledCoOwner = makeExecutionRow({
      id: 'exec-cancelled',
      workflowNodeId: 'node-a',
      status: 'cancelled',
    });
    const waitingRebindCoOwner = makeExecutionRow({
      id: 'exec-waiting-rebind',
      workflowNodeId: 'node-b',
      status: 'waiting_rebind',
    });
    const activeCoOwner = makeExecutionRow({
      id: 'exec-active',
      workflowNodeId: 'node-c',
      status: 'in_progress',
    });
    const { tam, updates } = makeRecordingManager(
      [cancelledCoOwner, waitingRebindCoOwner, activeCoOwner, targetExec],
      (nodeId) => (nodeId === NODE_2 ? [targetExec] : [])
    );
    seedLiveSession(tam);
    stubMcpReinjection(tam);
    (tam as unknown as { registerCompletionCallback: () => void }).registerCompletionCallback =
      () => {};

    const actual = await tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: NODE_2,
    });

    expect(actual).toBe(REVIEWER_SESSION_ID);
    expect(updates.find((u) => u.id === 'exec-cancelled')).toEqual({
      id: 'exec-cancelled',
      payload: { agentSessionId: null },
    });
    expect(updates.find((u) => u.id === 'exec-waiting-rebind')).toEqual({
      id: 'exec-waiting-rebind',
      payload: { agentSessionId: null },
    });
    expect(updates.find((u) => u.id === 'exec-active')).toEqual({
      id: 'exec-active',
      payload: {
        status: 'idle',
        agentSessionId: null,
        completedAt: expect.any(Number),
        __cas: ['in_progress'],
      },
    });
  });

  test('a sessionless reuse target whose bind CAS loses aborts the reuse before any ownership transfer (PR #2770 review)', async () => {
    const sessionlessTarget = makeExecutionRow({
      id: 'exec-target-sessionless',
      agentSessionId: null,
      status: 'pending',
      startedAt: null,
    });
    const boundElsewhere = makeExecutionRow({
      id: 'exec-prior-owner',
      workflowNodeId: 'node-prior',
      status: 'in_progress',
    });
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: {
        getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
      },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [sessionlessTarget, boundElsewhere],
        listByNode: (_runId: string, nodeId: string) =>
          nodeId === REVIEWER_NODE_ID ? [sessionlessTarget] : [],
        listByAgentSessionId: () => [],
        update: (id: string, payload: Record<string, unknown>) => {
          updates.push({ id, payload });
          return null;
        },
        casExecutionStatus: () => 'superseded',
      },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    } as unknown as TaskAgentManagerConfig);
    seedLiveSession(tam);
    stubMcpReinjection(tam);

    const spawnPromise = tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    await expect(spawnPromise).rejects.toThrow('superseded at stage reuse-target-bind');
    expect(updates).toEqual([]);
  });

  test('a fresh create whose bind CAS loses aborts before streaming: session unregistered, nothing left bound (PR #2770 review)', async () => {
    const pendingExec = makeExecutionRow({
      id: 'exec-fresh-lost',
      agentSessionId: null,
      status: 'pending',
      startedAt: null,
    });
    const unregistered: string[] = [];
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: {
        registerSession: () => {},
        getCachedSession: () => undefined,
        unregisterSession: async (id: string) => {
          unregistered.push(id);
        },
      },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: {
        getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
      },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [pendingExec],
        listByNode: () => [pendingExec],
        listByAgentSessionId: () => [],
        update: () => null,
        casExecutionStatus: () => 'superseded',
      },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    } as unknown as TaskAgentManagerConfig);

    const spawnPromise = tam.createSubSession(TASK_ID, 'fresh-lost-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    await expect(spawnPromise).rejects.toThrow('superseded at stage fresh-create-bind');
    const internal = tam as unknown as {
      subSessions: Map<string, Map<string, AgentSessionType>>;
      agentSessionIndex: Map<string, AgentSessionType>;
    };
    expect(internal.subSessions.get(TASK_ID)?.size ?? 0).toBe(0);
    expect(internal.agentSessionIndex.size).toBe(0);
    expect(unregistered).toEqual(['fresh-lost-id']);
    expect(pendingExec.status).toBe('pending');
    expect(pendingExec.agentSessionId).toBeNull();
  });

  test('a cancelled fresh target observed by a direct caller supersedes into the abort — no resurrection (PR #2770 review)', async () => {
    const cancelledExec = makeExecutionRow({
      id: 'exec-cancelled-observed',
      agentSessionId: null,
      status: 'cancelled',
      startedAt: null,
    });
    const casCalls: Array<{ expected: string[]; next: string }> = [];
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: {
        registerSession: () => {},
        getCachedSession: () => undefined,
        unregisterSession: async () => {},
      },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: {
        getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
      },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [cancelledExec],
        listByNode: () => [cancelledExec],
        listByAgentSessionId: () => [],
        update: () => null,
        casExecutionStatus: (
          _id: string,
          expected: readonly string[],
          next: string
        ): 'won' | 'superseded' => {
          casCalls.push({ expected: [...expected], next });
          return expected.includes(cancelledExec.status) ? 'won' : 'superseded';
        },
      },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    } as unknown as TaskAgentManagerConfig);

    const spawnPromise = tam.createSubSession(TASK_ID, 'cancelled-target-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    await expect(spawnPromise).rejects.toThrow('superseded at stage fresh-create-bind');
    expect(casCalls).toEqual([{ expected: [], next: 'in_progress' }]);
    expect(cancelledExec.status).toBe('cancelled');
  });

  test('a cancelled reuse target observed by a direct caller supersedes into the abort before any transfer (PR #2770 review)', async () => {
    const cancelledTarget = makeExecutionRow({
      id: 'exec-cancelled-reuse',
      agentSessionId: null,
      status: 'cancelled',
      startedAt: null,
    });
    const boundPriorOwner = makeExecutionRow({
      id: 'exec-prior-owner-cancel',
      workflowNodeId: 'node-prior',
      status: 'in_progress',
    });
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const casCalls: Array<{ expected: string[]; next: string }> = [];
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: {
        registerSession: () => {},
        getCachedSession: () => undefined,
        unregisterSession: async () => {},
      },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: {
        getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
      },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [cancelledTarget, boundPriorOwner],
        listByNode: (_runId: string, nodeId: string) =>
          nodeId === REVIEWER_NODE_ID ? [cancelledTarget] : [],
        listByAgentSessionId: () => [boundPriorOwner],
        update: (id: string, payload: Record<string, unknown>) => {
          updates.push({ id, payload });
          return null;
        },
        casExecutionStatus: (
          _id: string,
          expected: readonly string[],
          next: string
        ): 'won' | 'superseded' => {
          casCalls.push({ expected: [...expected], next });
          return 'superseded';
        },
      },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    } as unknown as TaskAgentManagerConfig);
    seedLiveSession(tam);
    stubReusePathHelpers(tam);

    const spawnPromise = tam.createSubSession(TASK_ID, 'cancelled-reuse-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    await expect(spawnPromise).rejects.toThrow('superseded at stage reuse-target-bind');
    expect(casCalls).toEqual([{ expected: [], next: 'in_progress' }]);
    expect(updates).toEqual([]);
    expect(boundPriorOwner.status).toBe('in_progress');
  });

  test('a deferred reuse skips the inner flush — the flow flushes once after the outer bind (PR #2770 review)', async () => {
    const priorBound = makeExecutionRow({
      id: 'exec-prior-flush',
      workflowNodeId: 'node-prior',
      status: 'in_progress',
    });
    const flushed: Array<{ runId: string; agentName: string; sessionId: string }> = [];
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: { registerSession: () => {}, getCachedSession: () => undefined },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: {
        getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
      },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [priorBound],
        listByNode: () => [],
        listByAgentSessionId: () => [priorBound],
        update: () => null,
        casExecutionStatus: () => 'won',
      },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    } as unknown as TaskAgentManagerConfig);
    (
      tam as unknown as {
        flushPendingMessagesForTarget: (
          runId: string,
          agentName: string,
          sessionId: string
        ) => Promise<void>;
      }
    ).flushPendingMessagesForTarget = async (runId, agentName, sessionId) => {
      flushed.push({ runId, agentName, sessionId });
    };
    seedLiveSession(tam);
    stubReusePathHelpers(tam);

    const actual = await tam.createSubSession(TASK_ID, 'deferred-reuse-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: 'node-other',
      deferFreshExecutionBind: true,
    });

    expect(actual).toBe(REVIEWER_SESSION_ID);
    expect(flushed).toEqual([]);
  });

  test('deferFreshExecutionBind leaves the fresh target row to the guarded outer bind: no inner write, session still created (PR #2770 review)', async () => {
    const pendingExec = makeExecutionRow({
      id: 'exec-deferred',
      agentSessionId: null,
      status: 'pending',
      startedAt: null,
    });
    const { tam, updates } = makeRecordingManager([pendingExec]);

    const actual = await tam.createSubSession(TASK_ID, 'deferred-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
      deferFreshExecutionBind: true,
    });

    expect(actual).toBe('deferred-id');
    expect(fromInitSpy).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.id === 'exec-deferred')).toBeUndefined();
    expect(pendingExec.status).toBe('pending');
    expect(pendingExec.agentSessionId).toBeNull();
  });

  test('fresh create binds the new session to the matching pending execution through the bindable-status CAS', async () => {
    const pendingExec = makeExecutionRow({
      id: 'exec-pending',
      agentSessionId: null,
      status: 'pending',
      startedAt: null,
    });
    const { tam, updates } = makeRecordingManager([pendingExec]);

    const actual = await tam.createSubSession(TASK_ID, 'fresh-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    expect(actual).toBe('fresh-id');
    expect(fromInitSpy).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.id === 'exec-pending')).toEqual({
      id: 'exec-pending',
      payload: {
        status: 'in_progress',
        agentSessionId: 'fresh-id',
        startedAt: expect.any(Number),
        completedAt: null,
        __cas: ['pending'],
      },
    });
  });

  test('fresh create skips the execution bind when the matching execution is already bound elsewhere', async () => {
    const boundExec = makeExecutionRow({
      id: 'exec-bound-elsewhere',
      agentSessionId: 'other-session',
      status: 'pending',
    });
    const { tam, updates } = makeRecordingManager([boundExec]);

    const actual = await tam.createSubSession(TASK_ID, 'fresh-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    expect(actual).toBe('fresh-id');
    expect(fromInitSpy).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.id === 'exec-bound-elsewhere')).toBeUndefined();
  });
});
