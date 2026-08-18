import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { AgentSession as AgentSessionType } from '../../../../src/lib/agent/agent-session.ts';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

const TASK_ID = 'task-850';
const RUN_ID = 'run-850';
const SPACE_ID = 'space-850';
const REVIEWER_NODE_ID = 'node-reviewer';
const REVIEWER_AGENT = 'reviewer';
const REVIEWER_SESSION_ID = 'reviewer-session-live';

function makeFakeSession(id: string = REVIEWER_SESSION_ID) {
  const calls: string[] = [];
  const session = {
    session: { id },
    skillOverrides: undefined,
    toolGuards: undefined,
    onMissingWorkflowMcpServers: undefined,
    updateConfig: async (): Promise<void> => {
      calls.push('updateConfig');
    },
    mergeRuntimeMcpServers: (): void => {
      calls.push('mergeRuntimeMcpServers');
    },
    startStreamingQuery: async (): Promise<void> => {
      calls.push('startStreamingQuery');
    },
  };
  return { session: session as unknown as AgentSessionType, calls };
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
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
  } as unknown as TaskAgentManagerConfig);
}

function seedLiveSession(
  tam: TaskAgentManager,
  sessionId: string = REVIEWER_SESSION_ID
): AgentSessionType {
  const { session } = makeFakeSession(sessionId);
  const subSessions = (
    tam as unknown as {
      subSessions: Map<string, Map<string, AgentSessionType>>;
    }
  ).subSessions;
  if (!subSessions.has(TASK_ID)) subSessions.set(TASK_ID, new Map());
  subSessions.get(TASK_ID)!.set(sessionId, session);
  (tam as unknown as { agentSessionIndex: Map<string, AgentSessionType> }).agentSessionIndex.set(
    sessionId,
    session
  );
  return session;
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
