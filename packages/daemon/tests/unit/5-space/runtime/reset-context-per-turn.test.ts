import { describe, expect, it, mock } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { ClearConversationCancelledError } from '../../../../src/lib/agent/agent-session.ts';
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
      getSessionData: () => ({ id: SESSION_ID, workspacePath: null }),
      updateMetadata: () => {},
      handleQueryTrigger: replayMock,
      ensureQueryStarted: ensureStartedMock,
      clearConversationContext: clearMock,
      messageQueue: { enqueueWithId: enqueueMock, size: () => 0 },
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

describe('injectMessageIntoSession — v2 idempotent persist (Codex P1)', () => {
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
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
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
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
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
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
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
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
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
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
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
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
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
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
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

  it('a defer branch over an existing deferred row re-marks nothing and reuses the existing message id', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'deferred' } });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
    } as unknown as AgentSession;
    indexSession(manager, live);

    const dbId = await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer'
    );

    expect(session.markDeliveryDeferredByUuid).not.toHaveBeenCalled();
    expect(session.reopenDeliveryByUuid).not.toHaveBeenCalled();
    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.publishStatusChanged).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: SESSION_ID,
      messageIds: [dbId],
      status: 'deferred',
    });
  });

  it('a rejecting status publish is swallowed on the defer branch (fire-and-forget)', async () => {
    const { manager, session } = makeManager({});
    session.publishStatusChanged.mockRejectedValue(new Error('bus down'));
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
    } as unknown as AgentSession;
    indexSession(manager, live);

    const dbId = await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer'
    );

    expect(dbId).toBe('db-id');
    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage.mock.calls[0][2]).toBe('deferred');
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });
});
