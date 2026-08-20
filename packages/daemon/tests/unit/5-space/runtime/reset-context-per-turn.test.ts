import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';
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

  function makeSession(o: MockSessionOptions) {
    return {
      session: { id: SESSION_ID, sdkSessionId: o.sdkSessionId },
      getProcessingState,
      ensureQueryStarted: ensureStartedMock,
      clearConversationContext: clearMock,
      messageQueue: { enqueueWithId: enqueueMock },
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
      getProcessingState,
      saveUserMessage,
      jobQueueEnqueue,
      reopenDeliveryByUuid,
      markDeliveryDeferredByUuid,
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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

  it('busy resetContextPerTurn task handoff defers until turn end', async () => {
    const { manager, session } = makeManager({ slotResets: true });
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
      messageQueue: { enqueueWithId: session.enqueueMock },
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

  it('KNOWN-BUG turn-end delivers handoff then later idle clear wipes that handoff', async () => {
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
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'handoff', true, undefined, 'defer');
    const deferred = session.saveUserMessage.mock.calls[0][1] as SDKMessage;
    const flush = new QueryModeHandler({
      session: live.session,
      db: {
        getMessagesByStatus: mock(() => [{ ...deferred, dbId: 'db-handoff', timestamp: 1 }]),
        updateMessageStatus: mock(() => {}),
        getJobQueueRepo: mock(() => ({ activeDeliveryMessageUuids: () => new Set<string>() })),
      },
      internalEventBus: { publish: mock(async () => {}) },
      messageQueue: live.messageQueue,
      logger: { error: mock(() => {}) },
      ensureQueryStarted: session.ensureStartedMock,
    } as unknown as QueryModeHandlerContext);

    await flush.handleQueryTrigger();

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(context).toEqual(['handoff']);

    status = 'idle';
    await manager.injectSubSessionMessage(SESSION_ID, 'later task', true);

    expect(order).toEqual(['handoff', '/clear', 'later task']);
    expect(context).toEqual(['later task']);
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

  it('defers injection while the parent task is rate limited', async () => {
    const { manager, session } = makeManager({ parentTaskStatus: 'rate_limited' });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
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
