import { describe, expect, it, mock, beforeAll, afterAll } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  QueryModeHandler,
  type QueryModeHandlerContext,
} from '../../../../src/lib/agent/query-mode-handler';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';
import type { Logger } from '../../../../src/lib/logger';

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
}): {
  manager: TaskAgentManager;
  session: Record<string, ReturnType<typeof mock>>;
} {
  const clearMock = mock(async () => {});
  const ensureStartedMock = mock(async () => ({ started: false }));
  const enqueueMock = mock(async () => {});
  const getProcessingState = mock(() => ({ status: 'idle' }));
  const saveUserMessage = mock(() => 'db-id');
  const jobQueueEnqueue = mock(
    (args: { payload?: { sessionId?: string; messageUuid?: string } }) => {
      const uuid = args?.payload?.messageUuid;
      if (uuid) signalDeliveryConsumed(args!.payload!.sessionId!, uuid);
      return { id: 'job-1' };
    }
  );
  const reopenDeliveryByUuid = mock(() => null);
  const markDeliveryDeferredByUuid = mock(() => null);
  const getMessagesByStatus = mock(() => []);
  const updateMessageStatus = mock(() => {});

  function makeSession(o: MockSessionOptions) {
    return {
      session: { id: SESSION_ID, sdkSessionId: o.sdkSessionId },
      getProcessingState,
      ensureQueryStarted: ensureStartedMock,
      clearConversationContext: clearMock,
      messageQueue: { enqueueWithId: enqueueMock },
      hasPendingContextResetClear: () => false,
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
      getMessagesByStatus,
      updateMessageStatus,
      getSDKMessageRepo: () => ({
        getDeliveryContent: () => opts.deliveryContent ?? null,
        reopenDeliveryByUuid,
        markDeliveryFailedByUuid: () => null,
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
      publish: mock(() => {}),
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
      getProcessingState,
      saveUserMessage,
      jobQueueEnqueue,
      reopenDeliveryByUuid,
      markDeliveryDeferredByUuid,
      getMessagesByStatus,
      updateMessageStatus,
    },
  };
}

function indexSession(manager: TaskAgentManager, session: AgentSession): void {
  (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
    SESSION_ID,
    session
  );
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('does NOT clear when a durable turn is already pending for the session', async () => {
    const { manager, session } = makeManager({ slotResets: true, hasActiveDeliveryJob: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear for synthetic non-handoff injects (external events / hook notices)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: mock(async () => {
        await clearGate;
      }),
      messageQueue: { enqueueWithId: session.enqueueMock },
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

  it('does NOT drop the handoff when the node has a corrupt/empty agents array (P2-7)', async () => {
    const { manager, session } = makeManager({ slotResets: true, nodeEmptyAgents: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'msg', true);

    const locks = (manager as unknown as { sessionInjectLocks: Map<string, unknown> })
      .sessionInjectLocks;
    expect(locks.size).toBe(0);
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
  }): AgentSession {
    return {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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

  it('a retry finding an existing CONSUMED row skips resetContextPerTurn (no /clear of the just-delivered handoff)', async () => {
    const { manager, session } = makeManager({
      slotResets: true,
      deliveryContent: { sendStatus: 'consumed' },
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.reopenDeliveryByUuid).toHaveBeenCalledTimes(1);
    expect(session.markDeliveryDeferredByUuid).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).not.toHaveBeenCalled();
  });

  it('a deferred human message to a busy live session persists as a deferred row (task #949)', async () => {
    const { manager, session } = makeManager({});
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
});

describe('recovery flush — confirmed clear at the front of a batch (task #1098)', () => {
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
  });

  interface FlushHarness {
    manager: TaskAgentManager;
    clearMock: ReturnType<typeof mock>;
    enqueueWithIdMock: ReturnType<typeof mock>;
    getMessagesByStatus: ReturnType<typeof mock>;
    sessionId: string;
    setDeferred(messages: Array<{ uuid: string; text: string }>): void;
    flush(): Promise<{ success: boolean; messageCount: number }>;
  }

  function makeFlushHarness(opts: { slotResets?: boolean; preArmed?: boolean }): FlushHarness {
    const { manager, session } = makeManager({ slotResets: opts.slotResets });
    let pendingClear = opts.preArmed === true;
    session.clearMock.mockImplementation(async () => {
      pendingClear = true;
    });
    const sessionId = SESSION_ID;
    const live = {
      session: { id: sessionId, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
      hasPendingContextResetClear: () => pendingClear,
    } as unknown as AgentSession;
    indexSession(manager, live);

    const db = {
      getMessagesByStatus: session.getMessagesByStatus,
      updateMessageStatus: session.updateMessageStatus,
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () => new Set<string>(),
      }),
    } as unknown as Record<string, ReturnType<typeof mock>>;

    const qmh = new QueryModeHandler({
      session: { id: sessionId, sdkSessionId: 'prior-sdk-session' },
      db,
      internalEventBus: {
        subscribe: mock(() => () => {}),
        publish: mock(async () => {}),
      },
      messageQueue: { enqueueWithId: session.enqueueMock },
      logger: { error: mock(), warn: mock() } as unknown as Logger,
      ensureQueryStarted: session.ensureStartedMock,
      prepareContextResetFlush: async (count: number) =>
        manager.prepareContextResetFlushForSession(sessionId, count),
    } as unknown as QueryModeHandlerContext);

    const setDeferred = (messages: Array<{ uuid: string; text: string }>): void => {
      session.getMessagesByStatus.mockImplementation((sid: string, status: string) => {
        if (status !== 'deferred') return [];
        return messages.map((m, i) => ({
          dbId: `db-${i}`,
          uuid: m.uuid,
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: m.text }] },
          timestamp: 0,
        }));
      });
    };
    const flush = () => qmh.handleQueryTrigger();
    return {
      manager,
      clearMock: session.clearMock,
      enqueueWithIdMock: session.enqueueMock,
      getMessagesByStatus: session.getMessagesByStatus,
      sessionId,
      setDeferred,
      flush,
    };
  }

  it('issues exactly one confirmed clear before the first deferred handoff of a batch', async () => {
    const harness = makeFlushHarness({ slotResets: true });
    const order: string[] = [];
    harness.clearMock.mockImplementation(async () => {
      order.push('clear');
    });
    harness.enqueueWithIdMock.mockImplementation(async (uuid: string) => {
      order.push(`enqueue:${uuid}`);
    });
    harness.setDeferred([
      { uuid: 'handoff-1', text: 'review round 3' },
      { uuid: 'handoff-2', text: 'review round 4' },
    ]);

    await harness.flush();

    expect(harness.clearMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['clear', 'enqueue:handoff-1', 'enqueue:handoff-2']);
  });

  it('does not issue a second clear across two flush calls in the same epoch', async () => {
    const harness = makeFlushHarness({ slotResets: true });
    harness.setDeferred([{ uuid: 'handoff-1', text: 'review round 3' }]);

    await harness.flush();
    await harness.flush();

    expect(harness.clearMock).toHaveBeenCalledTimes(1);
  });

  it('regression (live bug): the handoff is not enqueued until the confirmed clear has resolved', async () => {
    const harness = makeFlushHarness({ slotResets: true });
    harness.setDeferred([{ uuid: 'handoff-1', text: 'review round 3' }]);
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    harness.clearMock.mockImplementation(async () => {
      await clearGate;
    });

    const flushPromise = harness.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.enqueueWithIdMock).not.toHaveBeenCalled();

    releaseClear();
    const result = await flushPromise;
    expect(result.success).toBe(true);
    expect(harness.enqueueWithIdMock).toHaveBeenCalledTimes(1);
  });

  it('does not clear on the recovery flush when the slot does not reset context', async () => {
    const harness = makeFlushHarness({ slotResets: false });
    harness.setDeferred([{ uuid: 'handoff-1', text: 'review round 3' }]);

    await harness.flush();

    expect(harness.clearMock).not.toHaveBeenCalled();
    expect(harness.enqueueWithIdMock).toHaveBeenCalledTimes(1);
  });

  it('does not clear on the recovery flush when the session has no prior context', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    let pendingClear = false;
    const live = {
      session: { id: SESSION_ID, sdkSessionId: undefined },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
      hasPendingContextResetClear: () => pendingClear,
    } as unknown as AgentSession;
    indexSession(manager, live);
    session.getMessagesByStatus.mockImplementation((sid: string, status: string) =>
      status === 'deferred'
        ? [
            {
              dbId: 'db-0',
              uuid: 'handoff-1',
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: 'review round 3' }] },
              timestamp: 0,
            },
          ]
        : []
    );

    const qmh = new QueryModeHandler({
      session: { id: SESSION_ID, sdkSessionId: undefined },
      db: {
        getMessagesByStatus: session.getMessagesByStatus,
        updateMessageStatus: session.updateMessageStatus,
        getJobQueueRepo: () => ({ activeDeliveryMessageUuids: () => new Set<string>() }),
      } as unknown as Record<string, ReturnType<typeof mock>>,
      internalEventBus: { subscribe: mock(() => () => {}), publish: mock(async () => {}) },
      messageQueue: { enqueueWithId: session.enqueueMock },
      logger: { error: mock(), warn: mock() } as unknown as Logger,
      ensureQueryStarted: session.ensureStartedMock,
      prepareContextResetFlush: async (count: number) =>
        manager.prepareContextResetFlushForSession(SESSION_ID, count),
    } as unknown as QueryModeHandlerContext);

    await qmh.handleQueryTrigger();

    expect(session.clearMock).not.toHaveBeenCalled();
  });
});

describe('injectMessageIntoSession — no clear over unconsumed pending work (task #1098)', () => {
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
  });

  function liveSession(session: {
    clearMock: ReturnType<typeof mock>;
    ensureStartedMock: ReturnType<typeof mock>;
    enqueueMock: ReturnType<typeof mock>;
  }): AgentSession {
    return {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
      hasPendingContextResetClear: () => false,
    } as unknown as AgentSession;
  }

  it('does NOT clear when unconsumed enqueued rows exist (not just active jobs)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    session.getMessagesByStatus.mockImplementation((sid: string, status: string) =>
      status === 'enqueued'
        ? [
            {
              dbId: 'db-0',
              uuid: 'prior-handoff',
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: 'prior' }] },
              timestamp: 0,
            },
          ]
        : []
    );
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalled();
  });

  it('does NOT clear when unconsumed deferred rows exist', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    session.getMessagesByStatus.mockImplementation((sid: string, status: string) =>
      status === 'deferred'
        ? [
            {
              dbId: 'db-0',
              uuid: 'prior-handoff',
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: 'prior' }] },
              timestamp: 0,
            },
          ]
        : []
    );
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalled();
  });

  it('does NOT clear when a clear is already pending for the epoch (exactly-once guard)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    let pendingClear = true;
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
      hasPendingContextResetClear: () => pendingClear,
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });
});
