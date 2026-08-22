import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import {
  signalDeliveryConsumed,
  withSessionResetCoordination,
} from '../../../../src/lib/agent/message-delivery';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { AgentSession as AgentSessionType } from '../../../../src/lib/agent/agent-session.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { McpServerConfig } from '@hyperneo/shared';

const SPACE_ID = 'space-rehydrate-mcp';
const RUN_ID = 'run-rehydrate-mcp';
const TASK_ID = 'task-rehydrate-mcp';
const EXEC_ID = 'exec-rehydrate-mcp';
const SUB_SESSION_ID = `space:${SPACE_ID}:task:${TASK_ID}:exec:${EXEC_ID}`;

interface FakeSessionState {
  session: {
    id: string;
    config: { mcpServers?: Record<string, McpServerConfig> };
  };
  onMissingWorkflowMcpServers?: AgentSessionType['onMissingWorkflowMcpServers'];
  calls: string[];
  startSawCallback: boolean;
}

function makeFakeAgentSession(
  id: string,
  options: { failStart?: boolean; beforeStart?: () => Promise<void> } = {}
) {
  const state: FakeSessionState = {
    session: { id, config: {} },
    calls: [],
    startSawCallback: false,
  };
  const agentSession = {
    get session() {
      return state.session;
    },
    skillOverrides: undefined,
    toolGuards: undefined,
    set onMissingWorkflowMcpServers(value: AgentSessionType['onMissingWorkflowMcpServers']) {
      state.onMissingWorkflowMcpServers = value;
    },
    get onMissingWorkflowMcpServers() {
      return state.onMissingWorkflowMcpServers;
    },
    setRuntimeSystemPrompt: () => {
      state.calls.push('setRuntimeSystemPrompt');
    },
    mergeRuntimeMcpServers: (additional: Record<string, McpServerConfig>) => {
      state.calls.push('mergeRuntimeMcpServers');
      state.session.config = {
        ...state.session.config,
        mcpServers: { ...(state.session.config.mcpServers ?? {}), ...additional },
      };
    },
    restartQuery: async () => {
      state.calls.push('restartQuery');
    },
    handleInterrupt: async () => {
      state.calls.push('handleInterrupt');
    },
    startStreamingQuery: async () => {
      state.calls.push('startStreamingQuery');
      state.startSawCallback = typeof state.onMissingWorkflowMcpServers === 'function';
      if (options.beforeStart) await options.beforeStart();
      if (options.failStart) {
        throw new Error(
          `[MCP invariant] Workflow sub-session ${id} still missing required MCP servers after self-heal`
        );
      }
    },
    getSessionData: () => state.session,
    getProcessingState: () => ({ status: 'idle' }),
    getSDKMessageCount: () => 0,
    replayPendingMessagesForImmediateMode: async () => {
      state.calls.push('replayPendingMessagesForImmediateMode');
    },
  };
  return { agentSession: agentSession as unknown as AgentSessionType, state };
}

function makeExecution() {
  return {
    id: EXEC_ID,
    workflowRunId: RUN_ID,
    workflowNodeId: 'node-coder',
    agentName: 'coder',
    agentId: 'agent-coder',
    agentSessionId: SUB_SESSION_ID,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
  };
}

function makeManager(): {
  tam: TaskAgentManager;
  registered: Map<string, AgentSessionType>;
  unregistered: string[];
} {
  const registered = new Map<string, AgentSessionType>();
  const unregistered: string[] = [];
  const execution = makeExecution();
  const task = {
    id: TASK_ID,
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    status: 'in_progress',
    title: 'Rehydrate MCP task',
  };
  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    sessionManager: {
      registerSession: (session: AgentSessionType) => {
        registered.set(session.getSessionData().id, session);
      },
      unregisterSession: async (sessionId: string) => {
        unregistered.push(sessionId);
        registered.delete(sessionId);
      },
      getCachedSession: (sessionId: string) => registered.get(sessionId) ?? null,
    },
    taskRepo: {
      getTask: () => task,
      listByWorkflowRun: () => [task],
      listByWorkflowRunIncludingArchived: () => [task],
    },
    nodeExecutionRepo: {
      listByWorkflowRun: () => [execution],
      listByAgentSessionId: () => [execution],
      getById: () => execution,
      update: () => execution,
    },
    workflowRunRepo: { getRun: () => null },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
  } as unknown as TaskAgentManagerConfig);
  return { tam, registered, unregistered };
}

function rehydrateOf(tam: TaskAgentManager) {
  return (
    tam as unknown as { rehydrateSubSession: (id: string) => Promise<AgentSessionType | null> }
  ).rehydrateSubSession.bind(tam);
}

describe('TaskAgentManager — ghost rehydration MCP invariant', () => {
  let restoreSpy: ReturnType<typeof spyOn<typeof AgentSession, 'restore'>>;

  afterEach(() => {
    restoreSpy?.mockRestore();
  });

  test('rehydrated sub-session starts with node-agent merged and the self-heal callback wired', async () => {
    const { tam, registered } = makeManager();
    const fake = makeFakeAgentSession(SUB_SESSION_ID);
    restoreSpy = spyOn(AgentSession, 'restore').mockImplementation(
      (() => fake.agentSession) as unknown as typeof AgentSession.restore
    );

    const rehydrated = await rehydrateOf(tam)(SUB_SESSION_ID);

    expect(rehydrated).toBe(fake.agentSession);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy.mock.calls[0]?.[0]).toBe(SUB_SESSION_ID);
    expect(fake.state.session.config.mcpServers?.['node-agent']).toBeDefined();
    expect(typeof fake.state.onMissingWorkflowMcpServers).toBe('function');
    expect(fake.state.calls).toEqual([
      'mergeRuntimeMcpServers',
      'startStreamingQuery',
      'replayPendingMessagesForImmediateMode',
    ]);
    expect(fake.state.startSawCallback).toBe(true);
    const index = (tam as unknown as { agentSessionIndex: Map<string, AgentSessionType> })
      .agentSessionIndex;
    expect(index.get(SUB_SESSION_ID)).toBe(fake.agentSession);
    expect(registered.get(SUB_SESSION_ID)).toBe(fake.agentSession);
  });

  test('concurrent rehydrates of the same sub-session share one restored instance', async () => {
    const { tam } = makeManager();
    let releaseStart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const fakeWithGate = makeFakeAgentSession(SUB_SESSION_ID, { beforeStart: () => gate });
    restoreSpy = spyOn(AgentSession, 'restore').mockImplementation(
      (() => fakeWithGate.agentSession) as unknown as typeof AgentSession.restore
    );

    const rehydrate = rehydrateOf(tam);
    const first = rehydrate(SUB_SESSION_ID);
    const second = rehydrate(SUB_SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseStart?.();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(fakeWithGate.agentSession);
    expect(b).toBe(fakeWithGate.agentSession);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(fakeWithGate.state.calls.filter((call) => call === 'startStreamingQuery')).toHaveLength(
      1
    );
  });

  test('rehydrate adopts the SessionManager cached instance instead of restoring a duplicate', async () => {
    const { tam, registered } = makeManager();
    const cachedFake = makeFakeAgentSession(SUB_SESSION_ID);
    (
      tam as unknown as {
        config: { sessionManager: { getCachedSession: (id: string) => unknown } };
      }
    ).config.sessionManager.getCachedSession = (id: string) =>
      id === SUB_SESSION_ID ? cachedFake.agentSession : null;
    restoreSpy = spyOn(AgentSession, 'restore').mockImplementation(
      (() => makeFakeAgentSession('never').agentSession) as unknown as typeof AgentSession.restore
    );

    const rehydrated = await rehydrateOf(tam)(SUB_SESSION_ID);

    expect(rehydrated).toBe(cachedFake.agentSession);
    expect(restoreSpy).toHaveBeenCalledTimes(0);
    expect(cachedFake.state.session.config.mcpServers?.['node-agent']).toBeDefined();
    expect(typeof cachedFake.state.onMissingWorkflowMcpServers).toBe('function');
    expect(cachedFake.state.calls).toContain('startStreamingQuery');
    expect(registered.get(SUB_SESSION_ID)).toBe(cachedFake.agentSession);
  });

  test('a failed start unwinds registration so the next rehydrate starts fresh', async () => {
    const { tam, unregistered } = makeManager();
    const failing = makeFakeAgentSession(SUB_SESSION_ID, { failStart: true });
    const healthy = makeFakeAgentSession(SUB_SESSION_ID);
    restoreSpy = spyOn(AgentSession, 'restore').mockImplementation(
      (() => failing.agentSession) as unknown as typeof AgentSession.restore
    );

    const rehydrate = rehydrateOf(tam);
    await expect(rehydrate(SUB_SESSION_ID)).rejects.toThrow(/MCP invariant/);
    const index = (tam as unknown as { agentSessionIndex: Map<string, AgentSessionType> })
      .agentSessionIndex;
    expect(index.has(SUB_SESSION_ID)).toBe(false);
    expect(unregistered).toEqual([SUB_SESSION_ID]);
    const bookkeeping = (tam as unknown as { completionCallbacks: Map<string, unknown[]> })
      .completionCallbacks;
    expect(bookkeeping.has(SUB_SESSION_ID)).toBe(false);

    restoreSpy.mockImplementation(
      (() => healthy.agentSession) as unknown as typeof AgentSession.restore
    );
    const retried = await rehydrate(SUB_SESSION_ID);
    expect(retried).toBe(healthy.agentSession);
    expect(healthy.state.calls).toContain('startStreamingQuery');
    expect(index.get(SUB_SESSION_ID)).toBe(healthy.agentSession);
    expect(bookkeeping.get(SUB_SESSION_ID)).toHaveLength(1);
  });

  test('mcpSelfHeal provisions and adopts the instance the runner actually started', async () => {
    const { tam, registered } = makeManager();
    const stale = makeFakeAgentSession(SUB_SESSION_ID);
    const started = makeFakeAgentSession(SUB_SESSION_ID);
    const index = (tam as unknown as { agentSessionIndex: Map<string, AgentSessionType> })
      .agentSessionIndex;
    index.set(SUB_SESSION_ID, stale.agentSession);

    await tam.mcpSelfHeal(started.agentSession, ['node-agent']);

    expect(started.state.session.config.mcpServers?.['node-agent']).toBeDefined();
    expect(index.get(SUB_SESSION_ID)).toBe(started.agentSession);
    expect(registered.get(SUB_SESSION_ID)).toBe(started.agentSession);
    expect(started.state.calls).toContain('restartQuery');
    expect(stale.state.calls).toContain('handleInterrupt');
    const completionCallbacks = (tam as unknown as { completionCallbacks: Map<string, unknown[]> })
      .completionCallbacks;
    expect(completionCallbacks.get(SUB_SESSION_ID)).toHaveLength(1);
  });

  test('the wired self-heal callback restores node-agent on the session it was invoked with', async () => {
    const { tam } = makeManager();
    const fake = makeFakeAgentSession(SUB_SESSION_ID);
    restoreSpy = spyOn(AgentSession, 'restore').mockImplementation(
      (() => fake.agentSession) as unknown as typeof AgentSession.restore
    );
    await rehydrateOf(tam)(SUB_SESSION_ID);
    const callback = fake.state.onMissingWorkflowMcpServers;
    expect(callback).toBeTypeOf('function');

    fake.state.session.config.mcpServers = {};
    await callback!(fake.agentSession, ['node-agent']);

    expect(fake.state.session.config.mcpServers?.['node-agent']).toBeDefined();
  });

  test('injecting into an uncached sub-session never deadlocks against the reset-coordination lock', async () => {
    const { tam } = makeManager();
    const fake = makeFakeAgentSession(SUB_SESSION_ID);
    const config = (
      tam as unknown as {
        config: {
          db: Record<string, unknown>;
          nodeExecutionRepo: Record<string, unknown>;
        };
      }
    ).config;
    config.nodeExecutionRepo.getByAgentSessionId = () => makeExecution();
    config.db.getSDKMessageRepo = () => ({
      getDeliveryContent: () => null,
      reopenDeliveryByUuid: () => null,
      markDeliveryFailedByUuid: () => null,
      markDeliveryDeferredByUuid: () => null,
    });
    config.db.getJobQueueRepo = () => ({
      activeDeliveryMessageUuids: () => new Set<string>(),
      hasActiveTurnDeliveryJob: () => false,
      getActiveDeliveryRole: () => null,
      enqueue: (args: { payload?: { sessionId?: string; messageUuid?: string } }) => {
        const uuid = args?.payload?.messageUuid;
        if (uuid) signalDeliveryConsumed(args!.payload!.sessionId!, uuid);
        return { id: 'job-1' };
      },
    });
    config.db.saveUserMessage = () => 'db-id';
    config.db.getUserMessageIdsByStatus = () => [];
    const session = fake.agentSession as unknown as Record<string, unknown>;
    session.replayPendingMessagesForImmediateMode = async () => {
      await withSessionResetCoordination(SUB_SESSION_ID, async () => {});
    };
    session.handleQueryTrigger = async () => ({ success: true, messageCount: 0 });
    session.ensureQueryStarted = async () => {};
    session.messageQueue = { enqueueWithId: async () => {}, isRunning: () => false };
    restoreSpy = spyOn(AgentSession, 'restore').mockImplementation(
      (() => fake.agentSession) as unknown as typeof AgentSession.restore
    );

    const dbId = await tam.injectSubSessionMessage(
      SUB_SESSION_ID,
      '─── Message from coder ───',
      true
    );

    expect(dbId).toBe('db-id');
  });
});
