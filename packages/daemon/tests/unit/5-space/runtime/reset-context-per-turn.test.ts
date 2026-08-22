import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { ClearConversationCancelledError } from '../../../../src/lib/agent/agent-session.ts';
import {
  sessionResetCoordinationLocks,
  signalDeliveryConsumed,
} from '../../../../src/lib/agent/message-delivery';
import {
  QueryModeHandler,
  type QueryModeHandlerContext,
} from '../../../../src/lib/agent/query-mode-handler.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const SESSION_ID = 'reviewer-session-1';
const RUN_ID = 'run-1';
const WORKFLOW_ID = 'wf-1';
const NODE_ID = 'node-review';
const AGENT_NAME = 'reviewer';

interface MockSessionOptions {
  sdkSessionId?: string;
  status?: string;
}

function makeManager(opts: {
  slotResets?: boolean;
  nodeMissing?: boolean;
  nodeEmptyAgents?: boolean;
  hasActiveDeliveryJob?: boolean;
  deliveryContent?: { sendStatus: string };
  parentTaskStatus?: string;
  reopenDbId?: string;
  failedDbId?: string;
  enqueueThrows?: boolean;
  unconsumedCounts?: Record<string, number>;
}): {
  manager: TaskAgentManager;
  session: Record<string, ReturnType<typeof mock>>;
} {
  const clearMock = mock(async () => {});
  const ensureStartedMock = mock(async () => ({ started: false }));
  const enqueueMock = mock(async () => {});
  const replayMock = mock(async () => ({ success: true, messageCount: 0 }));
  const getProcessingState = mock(() => ({ status: 'idle' }));
  const saveUserMessage = mock(() => 'db-id');
  const jobQueueEnqueue = mock(
    (args: { payload?: { sessionId?: string; messageUuid?: string } }) => {
      if (opts.enqueueThrows) throw new Error('job queue unavailable');
      const uuid = args?.payload?.messageUuid;
      if (uuid) signalDeliveryConsumed(args!.payload!.sessionId!, uuid);
      return { id: 'job-1' };
    }
  );
  const reopenDeliveryByUuid = mock(() => opts.reopenDbId ?? null);
  const markDeliveryDeferredByUuid = mock(() => null);
  const markDeliveryFailedByUuid = mock(() => opts.failedDbId ?? null);
  const getUserMessageIdsByStatus = mock((_sessionId: string, status: string) =>
    Array.from({ length: opts.unconsumedCounts?.[status] ?? 0 }, (_, i) => ({
      dbId: `db-${status}-${i}`,
      uuid: `uuid-${status}-${i}`,
      timestamp: 0,
    }))
  );
  const publishStatusChanged = mock(async () => {});

  function makeSession(o: MockSessionOptions) {
    return {
      session: { id: SESSION_ID, sdkSessionId: o.sdkSessionId },
      getProcessingState,
      handleQueryTrigger: replayMock,
      ensureQueryStarted: ensureStartedMock,
      clearConversationContext: clearMock,
      messageQueue: { enqueueWithId: enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
  }

  const slot = {
    agentId: 'Reviewer',
    name: AGENT_NAME,
    ...(opts.slotResets ? { resetContextPerTurn: true } : {}),
  };
  const workflow = {
    nodes: opts.nodeMissing
      ? []
      : [{ id: NODE_ID, name: 'Review', agents: opts.nodeEmptyAgents ? [] : [slot] }],
  };

  const config = {
    db: {
      getDatabase: () => ({}),
      saveUserMessage,
      getUserMessageIdsByStatus,
      getSDKMessageRepo: () => ({
        getDeliveryContent: () => opts.deliveryContent ?? null,
        reopenDeliveryByUuid,
        markDeliveryFailedByUuid,
        markDeliveryDeferredByUuid,
      }),
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () =>
          new Set<string>(opts.hasActiveDeliveryJob ? ['pending-job'] : []),
        enqueue: jobQueueEnqueue,
        getActiveDeliveryRole: () => null,
      }),
    },
    internalEventBus: {
      subscribe: mock(() => () => {}),
      publish: publishStatusChanged,
    },
    nodeExecutionRepo: {
      getByAgentSessionId: mock(() => ({
        workflowRunId: RUN_ID,
        workflowNodeId: NODE_ID,
        agentName: AGENT_NAME,
        agentSessionId: SESSION_ID,
      })),
      listByAgentSessionId: mock(() => []),
    },
    workflowRunRepo: {
      getRun: mock(() => ({ workflowId: WORKFLOW_ID })),
    },
    taskRepo: {
      getTask: mock(() =>
        opts.parentTaskStatus
          ? { id: 'task-1', status: opts.parentTaskStatus, workflowRunId: RUN_ID }
          : null
      ),
      listByWorkflowRunIncludingArchived: mock(() => []),
    },
    spaceWorkflowManager: {
      getWorkflow: mock(() => workflow),
      getWorkflowForRun: mock(() => workflow),
    },
  } as unknown as TaskAgentManagerConfig;

  const manager = new TaskAgentManager(config);
  return {
    manager,
    session: {
      clearMock,
      ensureStartedMock,
      enqueueMock,
      replayMock,
      getProcessingState,
      saveUserMessage,
      jobQueueEnqueue,
      reopenDeliveryByUuid,
      markDeliveryDeferredByUuid,
      markDeliveryFailedByUuid,
      getUserMessageIdsByStatus,
      publishStatusChanged,
    },
  };
}

function indexSession(manager: TaskAgentManager, session: AgentSession): void {
  (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
    SESSION_ID,
    session
  );
}

function attachSessionToTask(manager: TaskAgentManager, session: AgentSession): void {
  const subSessions = (
    manager as unknown as { subSessions: Map<string, Map<string, AgentSession>> }
  ).subSessions;
  subSessions.set('task-1', new Map([[SESSION_ID, session]]));
}

describe('resetContextPerTurn — TaskAgentManager injection gating', () => {
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
  });
  it('clears SDK context before a task handoff to a resetContextPerTurn slot with prior context', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('delivers the handoff after resetContextPerTurn clear fails', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    session.clearMock.mockRejectedValue(new Error('clear failed'));
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage.mock.calls[0][2]).toBe('enqueued');
    expect(session.enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear when a durable turn is already pending for the session', async () => {
    const { manager, session } = makeManager({ slotResets: true, hasActiveDeliveryJob: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('does NOT clear for human input (isSyntheticMessage=false)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'a human follow-up', false);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear on the first turn (no prior sdkSessionId)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: undefined },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear for a system recovery nag (injectRuntimeRecoveryMessage)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectRuntimeRecoveryMessage(SESSION_ID, '/compact');

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear when the slot does not have the flag set', async () => {
    const { manager, session } = makeManager({ slotResets: false });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear while the session is mid-turn (busy)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('busy resetContextPerTurn task handoff defers until turn end', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'defer'
    );

    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage.mock.calls[0][2]).toBe('deferred');
    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });

  it('busy immediate delivery remains enqueued instead of taking the defer branch', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'deliver now', true);

    expect(session.saveUserMessage.mock.calls[0][2]).toBe('enqueued');
    expect(session.enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear for synthetic non-handoff injects (external events / hook notices)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'external event digest',
      true,
      undefined,
      'immediate',
      'system'
    );

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalled();
  });

  it('serializes concurrent injects per session so the clear cannot interleave', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: mock(async () => {
        await clearGate;
      }),
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    const settle = () => new Promise((r) => setTimeout(r, 0));

    const p1 = manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);
    await settle();
    const p2 = manager.injectSubSessionMessage(SESSION_ID, 'a human follow-up', false);
    await settle();

    expect(session.saveUserMessage).toHaveBeenCalledTimes(0);

    releaseClear();
    await Promise.all([p1, p2]);
    expect(session.saveUserMessage).toHaveBeenCalledTimes(2);
  });

  it('aborts the injection when the clear is cancelled by teardown', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: mock(async () => {
        throw new ClearConversationCancelledError();
      }),
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('cancelled by query teardown');
    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });

  it('serializes the spawnPostApprovalSubSession reuse inject with ordinary injects', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const cfg = manager as unknown as { config: Record<string, unknown> };
    cfg.config.spaceManager = { getSpace: mock(async () => ({ workspacePath: '/w' })) };
    const nodeExecutionRepo = cfg.config.nodeExecutionRepo as Record<
      string,
      ReturnType<typeof mock>
    >;
    nodeExecutionRepo.listByWorkflowRun = mock(() => [
      { agentName: AGENT_NAME, agentSessionId: SESSION_ID },
    ]);

    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: mock(async () => {
        await clearGate;
      }),
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);
    attachSessionToTask(manager, live);

    const settle = () => new Promise((r) => setTimeout(r, 0));

    const spawnArgs = {
      task: { id: 'task-1', spaceId: 'space-1', workflowRunId: RUN_ID },
      workflow: {
        nodes: [
          {
            id: NODE_ID,
            name: 'Review',
            agents: [{ agentId: 'Reviewer', name: AGENT_NAME, resetContextPerTurn: true }],
          },
        ],
      },
      targetAgent: AGENT_NAME,
      kickoffMessage: 'post-approval kickoff',
    } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0];

    const p1 = manager.spawnPostApprovalSubSession(spawnArgs);
    await settle();
    await settle();
    const p2 = manager.injectSubSessionMessage(
      SESSION_ID,
      'external event digest',
      true,
      undefined,
      'immediate',
      'system'
    );
    await settle();
    await settle();

    expect(session.saveUserMessage).toHaveBeenCalledTimes(0);

    releaseClear();
    await Promise.all([p1, p2]);
    expect(session.saveUserMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('revalidates task state inside the injection lock before the reuse inject', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const cfg = manager as unknown as { config: Record<string, unknown> };
    cfg.config.spaceManager = { getSpace: mock(async () => ({ workspacePath: '/w' })) };
    const nodeExecutionRepo = cfg.config.nodeExecutionRepo as Record<
      string,
      ReturnType<typeof mock>
    >;
    nodeExecutionRepo.listByWorkflowRun = mock(() => [
      { agentName: AGENT_NAME, agentSessionId: SESSION_ID },
    ]);
    const taskRepo = cfg.config.taskRepo as Record<string, ReturnType<typeof mock>>;
    let cancelled = false;
    taskRepo.listByWorkflowRunIncludingArchived = mock(() =>
      cancelled ? [{ id: 'task-1', status: 'cancelled', workflowRunId: RUN_ID }] : []
    );

    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: mock(async () => {
        await clearGate;
      }),
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);
    attachSessionToTask(manager, live);

    const settle = () => new Promise((r) => setTimeout(r, 0));

    const spawnArgs = {
      task: { id: 'task-1', spaceId: 'space-1', workflowRunId: RUN_ID },
      workflow: {
        nodes: [
          {
            id: NODE_ID,
            name: 'Review',
            agents: [{ agentId: 'Reviewer', name: AGENT_NAME, resetContextPerTurn: true }],
          },
        ],
      },
      targetAgent: AGENT_NAME,
      kickoffMessage: 'post-approval kickoff',
    } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0];

    const p0 = manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);
    await settle();
    await settle();
    const p1 = manager.spawnPostApprovalSubSession(spawnArgs);
    await settle();
    await settle();

    cancelled = true;
    releaseClear();
    const [, spawned] = await Promise.all([p0, p1]);

    expect(spawned.sessionId).toBe(SESSION_ID);
    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT drop the handoff when the node has a corrupt/empty agents array (P2-7)', async () => {
    const { manager, session } = makeManager({ slotResets: true, nodeEmptyAgents: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('releases the per-session inject-lock entry after completion (no unbounded growth)', async () => {
    const { manager, session } = makeManager({ slotResets: false });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'msg', true);

    expect(sessionResetCoordinationLocks.size).toBe(0);
  });

  it('turn-end flush clears before the deferred handoff and a later inject never clears over it (#1085)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    let status = 'processing';
    const context: string[] = [];
    const order: string[] = [];
    session.enqueueMock.mockImplementation(async (_uuid: string, content: string) => {
      order.push(content);
      context.push(content);
    });
    session.clearMock.mockImplementation(async () => {
      order.push('/clear');
      context.length = 0;
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'handoff', true, undefined, 'defer');
    const deferred = session.saveUserMessage.mock.calls[0][1] as SDKMessage;
    const flush = new QueryModeHandler({
      session: live.session,
      db: {
        getUserMessagesByStatus: mock(() => ({
          messages: [{ ...deferred, dbId: 'db-handoff', timestamp: 1 }],
          total: 1,
        })),
        updateMessageStatus: mock(() => {}),
        getJobQueueRepo: mock(() => ({
          activeDeliveryMessageUuids: () => new Set<string>(),
          hasActiveTurnDeliveryJob: () => false,
        })),
      },
      internalEventBus: { publish: mock(async () => {}) },
      messageQueue: live.messageQueue,
      logger: { error: mock(() => {}) },
      ensureQueryStarted: session.ensureStartedMock,
      slotResetsContext: () => true,
      clearConversationContext: session.clearMock,
    } as unknown as QueryModeHandlerContext);

    await flush.handleQueryTrigger();

    expect(session.clearMock).toHaveBeenCalledTimes(1);
    expect(context).toEqual(['handoff']);

    status = 'idle';
    session.getUserMessageIdsByStatus.mockImplementation(
      (_sessionId: string, sendStatus: string) =>
        sendStatus === 'enqueued'
          ? [{ dbId: 'db-handoff', uuid: 'uuid-handoff', timestamp: 1 }]
          : []
    );
    await manager.injectSubSessionMessage(SESSION_ID, 'later task', true);

    expect(order).toEqual(['/clear', 'handoff', 'later task']);
    expect(context).toEqual(['handoff', 'later task']);
    expect(session.clearMock).toHaveBeenCalledTimes(1);
  });

  it('serializes the flush clear against concurrent injections so the clear never wipes a delivered task (#1085)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    let status = 'processing';
    const context: string[] = [];
    const order: string[] = [];
    let clearReleased = false;
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    session.enqueueMock.mockImplementation(async (_uuid: string, content: string) => {
      order.push(content);
      context.push(content);
    });
    session.clearMock.mockImplementation(async () => {
      order.push('/clear');
      context.length = 0;
      if (!clearReleased) await clearGate;
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'handoff', true, undefined, 'defer');
    const deferred = session.saveUserMessage.mock.calls[0][1] as SDKMessage;
    const flush = new QueryModeHandler({
      session: live.session,
      db: {
        getUserMessagesByStatus: mock(() => ({
          messages: [{ ...deferred, dbId: 'db-handoff', timestamp: 1 }],
          total: 1,
        })),
        updateMessageStatus: mock(() => {}),
        getJobQueueRepo: mock(() => ({
          activeDeliveryMessageUuids: () => new Set<string>(),
          hasActiveTurnDeliveryJob: () => false,
        })),
      },
      internalEventBus: { publish: mock(async () => {}) },
      messageQueue: live.messageQueue,
      logger: { error: mock(() => {}) },
      ensureQueryStarted: session.ensureStartedMock,
      slotResetsContext: () => true,
      clearConversationContext: session.clearMock,
    } as unknown as QueryModeHandlerContext);

    status = 'idle';
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const flushPromise = flush.handleQueryTrigger();
    await settle();
    await settle();

    const injectPromise = manager.injectSubSessionMessage(SESSION_ID, 'urgent task', true);
    await settle();
    await settle();

    expect(order).toEqual(['/clear']);
    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);

    clearReleased = true;
    releaseClear();
    await Promise.all([flushPromise, injectPromise]);

    expect(order).toEqual(['/clear', 'handoff', '/clear', 'urgent task']);
    expect(context).toEqual(['urgent task']);
  });

  it('does NOT clear when replaying a stranded system recovery row on a reset slot', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    let status = 'processing';
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '/compact',
      true,
      undefined,
      'defer',
      'system'
    );
    const stranded = session.saveUserMessage.mock.calls[0][1] as SDKMessage;
    status = 'idle';
    const flush = new QueryModeHandler({
      session: live.session,
      db: {
        getUserMessagesByStatus: mock(() => ({
          messages: [{ ...stranded, dbId: 'db-compact', timestamp: 1 }],
          total: 1,
        })),
        updateMessageStatus: mock(() => {}),
        getJobQueueRepo: mock(() => ({
          activeDeliveryMessageUuids: () => new Set<string>(),
          hasActiveTurnDeliveryJob: () => false,
        })),
      },
      internalEventBus: { publish: mock(async () => {}) },
      messageQueue: live.messageQueue,
      logger: { error: mock(() => {}) },
      ensureQueryStarted: session.ensureStartedMock,
      slotResetsContext: () => true,
      clearConversationContext: session.clearMock,
    } as unknown as QueryModeHandlerContext);

    await flush.handleQueryTrigger();

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalledWith(expect.any(String), '/compact');
  });

  it('aborts the injection when the backlog replay clear is cancelled by teardown (#1085)', async () => {
    const { manager, session } = makeManager({
      slotResets: true,
      unconsumedCounts: { enqueued: 1 },
    });
    session.replayMock.mockRejectedValue(new ClearConversationCancelledError());
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('cancelled by query teardown');

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalledTimes(0);
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });

  it('clears at the front when an injected task follows a human-only backlog (#1085)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    let status = 'processing';
    const order: string[] = [];
    session.enqueueMock.mockImplementation(async (_uuid: string, content: string) => {
      order.push(content);
    });
    session.clearMock.mockImplementation(async () => {
      order.push('/clear');
    });
    const humanDeferredRow = {
      dbId: 'db-human',
      uuid: 'uuid-human',
      timestamp: 1,
      type: 'user',
      isSynthetic: false,
      inputKind: 'human',
      message: { role: 'user', content: 'a human follow-up' },
    };
    const backlogFlush = new QueryModeHandler({
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      db: {
        getUserMessagesByStatus: mock(() => ({
          messages: [humanDeferredRow],
          total: 1,
        })),
        updateMessageStatus: mock(() => {}),
        getJobQueueRepo: mock(() => ({
          activeDeliveryMessageUuids: () => new Set<string>(),
          hasActiveTurnDeliveryJob: () => false,
        })),
      },
      internalEventBus: { publish: mock(async () => {}) },
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
      logger: { error: mock(() => {}) },
      ensureQueryStarted: session.ensureStartedMock,
      slotResetsContext: () => true,
      clearConversationContext: session.clearMock,
    } as unknown as QueryModeHandlerContext);
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: (opts?: Parameters<QueryModeHandler['handleQueryTrigger']>[0]) =>
        backlogFlush.handleQueryTrigger(opts),
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'a human follow-up',
      false,
      undefined,
      'defer'
    );
    session.getUserMessageIdsByStatus.mockImplementation(
      (_sessionId: string, sendStatus: string) =>
        sendStatus === 'deferred' ? [{ dbId: 'db-human', uuid: 'uuid-human', timestamp: 1 }] : []
    );

    status = 'idle';
    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(order).toEqual(['a human follow-up', '/clear', '─── Message from coder ───']);
    expect(session.clearMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear on inject while unconsumed delivered work is pending (#1085)', async () => {
    const { manager, session } = makeManager({
      slotResets: true,
      unconsumedCounts: { enqueued: 2 },
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('replays the deferred backlog as individual messages when injecting into an idle session', async () => {
    const { manager, session } = makeManager({ slotResets: false });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'newest event', true);

    expect(session.replayMock).toHaveBeenCalledTimes(1);
    expect(session.replayMock).toHaveBeenCalledWith({
      deliverIndividually: true,
      excludeMessageUuid: expect.any(String),
      skipResetCoordination: true,
      pendingTaskInput: false,
    });
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('does not replay the deferred backlog when the session is busy', async () => {
    const { manager, session } = makeManager({ slotResets: false });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'queued event', true, undefined, 'defer');

    expect(session.replayMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    const [sid, _sdkMsg, status] = session.saveUserMessage.mock.calls[0];
    expect(sid).toBe(SESSION_ID);
    expect(status).toBe('deferred');
  });

  it('keeps delivering the current message when the backlog replay fails', async () => {
    const { manager, session } = makeManager({ slotResets: false });
    session.replayMock.mockImplementation(async () => ({
      success: false,
      messageCount: 0,
      error: 'database unavailable',
    }));
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'newest event', true);

    expect(session.replayMock).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.enqueueMock).toHaveBeenCalled();
  });
});

describe('injectMessageIntoSession — v2 idempotent persist (Codex P1)', () => {
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  });
  afterAll(() => {
    if (previousFlag !== undefined) process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
    else delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  });

  function liveSession(session: {
    ensureStartedMock: ReturnType<typeof mock>;
    clearMock: ReturnType<typeof mock>;
    enqueueMock: ReturnType<typeof mock>;
    replayMock: ReturnType<typeof mock>;
  }): AgentSession {
    return {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
  }

  it('first inject persists the row and enqueues a durable job', async () => {
    const { manager, session } = makeManager({});
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.jobQueueEnqueue).toHaveBeenCalled();
  });

  it('a retry finding an existing CONSUMED row does not re-persist or re-enqueue (no re-drive)', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'consumed' } });
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.jobQueueEnqueue).not.toHaveBeenCalled();
  });

  it('a retry finding an existing FAILED row reopens it and re-enqueues without a duplicate row', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'failed' } });
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.reopenDeliveryByUuid).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.jobQueueEnqueue).toHaveBeenCalled();
  });

  it('a cancelled clear during a FAILED-row retry aborts before reopening the row', async () => {
    const { manager, session } = makeManager({
      slotResets: true,
      deliveryContent: { sendStatus: 'failed' },
    });
    session.clearMock.mockRejectedValue(new ClearConversationCancelledError());
    indexSession(manager, liveSession(session));

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('cancelled by query teardown');

    expect(session.reopenDeliveryByUuid).not.toHaveBeenCalled();
    expect(session.publishStatusChanged).not.toHaveBeenCalled();
    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });

  it('a retry finding an existing CONSUMED row skips resetContextPerTurn (no /clear of the just-delivered handoff)', async () => {
    const { manager, session } = makeManager({
      slotResets: true,
      deliveryContent: { sendStatus: 'consumed' },
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).not.toHaveBeenCalled();
  });

  it('a failed-row retry that hits the deferred branch marks the row deferred (replay-selectable)', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'failed' } });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'rate_limit_cooldown' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.reopenDeliveryByUuid).toHaveBeenCalledTimes(1);
    expect(session.markDeliveryDeferredByUuid).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).not.toHaveBeenCalled();
  });

  it('defers injection while the parent task is rate limited', async () => {
    const { manager, session } = makeManager({ parentTaskStatus: 'rate_limited' });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);
    attachSessionToTask(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'wait for parent task', true);

    expect(session.saveUserMessage.mock.calls[0][2]).toBe('deferred');
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });

  it('a deferred human message to a busy live session persists as a deferred row (task #949)', async () => {
    const { manager, session } = makeManager({});
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer'
    );

    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    const [sid, _sdkMsg, status, origin] = session.saveUserMessage.mock.calls[0];
    expect(sid).toBe(SESSION_ID);
    expect(status).toBe('deferred');
    expect(origin).toBeUndefined();
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });

  it('a deferred injection into a busy session publishes messages.statusChanged', async () => {
    const { manager, session } = makeManager({});
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer'
    );

    expect(session.publishStatusChanged).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: SESSION_ID,
      messageIds: ['db-id'],
      status: 'deferred',
    });
  });

  it('a fresh enqueued injection publishes messages.statusChanged', async () => {
    const { manager, session } = makeManager({});
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.publishStatusChanged).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: SESSION_ID,
      messageIds: ['db-id'],
      status: 'enqueued',
    });
  });

  it('a failed-row retry publishes reopen and deferred status changes', async () => {
    const { manager, session } = makeManager({
      deliveryContent: { sendStatus: 'failed' },
      reopenDbId: 'db-id',
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'rate_limit_cooldown' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, isRunning: () => false },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    const statuses = session.publishStatusChanged.mock.calls
      .filter(([event]) => event === 'messages.statusChanged')
      .map(([, payload]) => (payload as { status: string }).status);
    expect(statuses).toContain('enqueued');
    expect(statuses).toContain('deferred');
  });

  it('publishes a failed status when the delivery job cannot be enqueued', async () => {
    const { manager, session } = makeManager({ enqueueThrows: true, failedDbId: 'db-id' });
    indexSession(manager, liveSession(session));

    await manager
      .injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
      .catch(() => {});

    expect(session.markDeliveryFailedByUuid).toHaveBeenCalled();
    expect(session.publishStatusChanged).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: SESSION_ID,
      messageIds: ['db-id'],
      status: 'failed',
    });
  });
});
