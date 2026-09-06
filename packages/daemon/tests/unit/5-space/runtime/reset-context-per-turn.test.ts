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
  materializedRowIds?: string[];
  mailboxEntryStatus?: 'pending' | 'processing' | 'completed' | 'dead' | 'absent';
  normalizeThrows?: boolean;
  consumedAfterHandoff?: boolean;
  materializeOnEnqueue?: boolean;
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
  const mailboxEnqueue = mock(() => {
    if (opts.enqueueThrows) throw new Error('job queue unavailable');
    mailboxEntryEnqueued = true;
    if (opts.materializeOnEnqueue) materializedRowIds = ['db-id'];
    return { id: 'mailbox-job-1' };
  });
  let mailboxEntryEnqueued = false;
  let materializedRowIds = opts.materializedRowIds ?? ['db-id'];
  const cancelHeldJob = mock(() => false);
  const reopenDeliveryByUuid = mock(() => opts.reopenDbId ?? null);
  const normalizeDeliveryMailbox = mock(() => {
    if (opts.normalizeThrows) throw new Error('sqlite unavailable');
    return false;
  });
  const markDeliveryDeferredByUuid = mock(() => null);
  const markDeliveryFailedByUuid = mock(() => opts.failedDbId ?? null);
  const failDeliveryUnless = mock(() => opts.failedDbId ?? null);
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
        getDeliveryContent: () =>
          mailboxEntryEnqueued && opts.consumedAfterHandoff !== false
            ? { content: 'x', sendStatus: 'consumed' }
            : (opts.deliveryContent ?? null),
        getDeliveryMessageIdsByUuids: () => materializedRowIds,
        normalizeDeliveryMessageForMailbox: normalizeDeliveryMailbox,
        reopenDeliveryByUuid,
        markDeliveryFailedByUuid,
        failDeliveryUnlessProcessing: failDeliveryUnless,
        markDeliveryDeferredByUuid,
      }),
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () =>
          new Set<string>(opts.hasActiveDeliveryJob ? ['pending-job'] : []),
        activeMailboxMessageUuids: () => new Set<string>(),
        mailboxEntryJobStatus: () => opts.mailboxEntryStatus ?? 'completed',
        cancelPendingMailboxEntry: () => false,
        cancelHeldDeliveryJob: cancelHeldJob,
        enqueue: jobQueueEnqueue,
        enqueueUniquePending: mailboxEnqueue,
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
      mailboxEnqueue,
      cancelHeldJob,
      normalizeDeliveryMailbox,
      reopenDeliveryByUuid,
      markDeliveryDeferredByUuid,
      markDeliveryFailedByUuid,
      failDeliveryUnless,
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

  it('first inject hands the prompt to the mailbox lane and returns the materialized row id', async () => {
    const { manager, session } = makeManager({});
    indexSession(manager, liveSession(session));

    const returnedId = await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true
    );

    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.mailboxEnqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = session.mailboxEnqueue.mock.calls[0][0] as {
      queue?: string;
      payload?: {
        to?: { kind?: string; sessionId?: string };
        origin?: string;
        deliveryMode?: string;
        messageUuid?: string;
        message?: unknown;
      };
    };
    expect(returnedId).toBe('db-id');
    expect(enqueueArgs.queue).toBe('mailbox');
    expect(enqueueArgs.payload?.to).toEqual({ kind: 'session', sessionId: SESSION_ID });
    expect(enqueueArgs.payload?.origin).toBe('space_inject');
    expect(enqueueArgs.payload?.deliveryMode).toBe('immediate');
    expect(typeof enqueueArgs.payload?.messageUuid).toBe('string');
    expect(enqueueArgs.payload?.message).toEqual({
      type: 'user',
      message: { content: [{ type: 'text', text: '─── Message from coder ───' }] },
      parent_tool_use_id: null,
      inputKind: 'task',
    });
  });

  it('a human inject hands off with chat provenance and image content preserved', async () => {
    const { manager, session } = makeManager({});
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, 'look at this', false, [
      { media_type: 'image/png' as const, data: 'aW1hZ2U=' },
    ]);

    expect(session.mailboxEnqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = session.mailboxEnqueue.mock.calls[0][0] as {
      payload?: { origin?: string; message?: unknown };
    };
    expect(enqueueArgs.payload?.origin).toBe('chat');
    expect(enqueueArgs.payload?.message).toEqual({
      type: 'user',
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
          },
          { type: 'text', text: 'look at this' },
        ],
      },
      parent_tool_use_id: null,
      inputKind: 'human',
    });
  });

  it('a system nudge carries its inputKind so it cannot read as task input after delivery', async () => {
    const { manager, session } = makeManager({});
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'runtime recovery nudge',
      true,
      undefined,
      'immediate',
      'system'
    );

    expect(session.mailboxEnqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = session.mailboxEnqueue.mock.calls[0][0] as {
      payload?: { origin?: string; message?: { inputKind?: string } };
    };
    expect(enqueueArgs.payload?.origin).toBe('space_inject');
    expect(enqueueArgs.payload?.message?.inputKind).toBe('system');
  });

  it('a mailbox entry that dead-letters before materializing a row fails the injection', async () => {
    const { manager, session } = makeManager({
      mailboxEntryStatus: 'dead',
      materializedRowIds: [],
    });
    indexSession(manager, liveSession(session));

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('failed to materialize (dead)');

    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage.mock.calls[0][2]).toBe('failed');
    expect(session.publishStatusChanged).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: SESSION_ID,
      messageIds: ['db-id'],
      status: 'failed',
    });
  });

  it('a retry over an existing row waits for its own mailbox entry instead of the stale row', async () => {
    const { manager, session } = makeManager({
      deliveryContent: { sendStatus: 'failed' },
      mailboxEntryStatus: 'dead',
    });
    indexSession(manager, liveSession(session));

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('failed to materialize (dead)');

    expect(session.reopenDeliveryByUuid).toHaveBeenCalledTimes(1);
    expect(session.normalizeDeliveryMailbox).toHaveBeenCalledTimes(1);
    expect(session.failDeliveryUnless).toHaveBeenCalled();
    expect(session.saveUserMessage).not.toHaveBeenCalled();
  });

  it('an immediate retry over a deferred row activates it only after the entry materializes', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'deferred' } });
    indexSession(manager, liveSession(session));
    const activate = mock(async () => true);
    (
      manager as unknown as {
        activateDeferredDeliveryRow: (
          sessionId: string,
          messageId: string,
          origin: 'space_inject' | 'chat'
        ) => Promise<boolean>;
      }
    ).activateDeferredDeliveryRow = activate;

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][0]).toBe(SESSION_ID);
    expect(activate.mock.calls[0][2]).toBe('space_inject');
    expect(session.normalizeDeliveryMailbox).toHaveBeenCalledTimes(1);
    expect(session.mailboxEnqueue).toHaveBeenCalledTimes(1);
  });

  it('a deferred human retry activates its held job with chat origin', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'deferred' } });
    indexSession(manager, liveSession(session));
    const activate = mock(async () => true);
    (
      manager as unknown as {
        activateDeferredDeliveryRow: (
          sessionId: string,
          messageId: string,
          origin: 'space_inject' | 'chat'
        ) => Promise<boolean>;
      }
    ).activateDeferredDeliveryRow = activate;

    await manager.injectSubSessionMessage(SESSION_ID, 'a human follow-up', false);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][2]).toBe('chat');
  });

  it('skips failure publication when the atomic fence refuses the transition', async () => {
    const { manager, session } = makeManager({
      deliveryContent: { sendStatus: 'enqueued' },
      mailboxEntryStatus: 'dead',
    });
    indexSession(manager, liveSession(session));

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('failed to materialize (dead)');

    expect(session.failDeliveryUnless).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(
      session.publishStatusChanged.mock.calls.filter(
        ([event]) => event === 'messages.statusChanged'
      )
    ).toEqual([]);
  });

  it('fails the settlement when deferred activation activates nothing', async () => {
    const { manager, session } = makeManager({
      deliveryContent: { sendStatus: 'deferred' },
      consumedAfterHandoff: false,
    });
    indexSession(manager, liveSession(session));
    (
      manager as unknown as {
        activateDeferredDeliveryRow: (
          sessionId: string,
          messageId: string,
          origin: 'space_inject' | 'chat'
        ) => Promise<boolean>;
      }
    ).activateDeferredDeliveryRow = mock(async () => false);

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('activated nothing');
  });

  it('waits for delivery consumption before resolving the inject', async () => {
    const { manager, session } = makeManager({ consumedAfterHandoff: false });
    indexSession(manager, liveSession(session));

    const injectPromise = manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true
    );
    let resolved = false;
    void injectPromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);
    expect(session.mailboxEnqueue).toHaveBeenCalledTimes(1);

    const enqueueArgs = session.mailboxEnqueue.mock.calls[0][0] as {
      payload?: { to?: { sessionId?: string }; messageUuid?: string };
    };
    signalDeliveryConsumed(
      enqueueArgs!.payload!.to!.sessionId!,
      enqueueArgs!.payload!.messageUuid!
    );

    await expect(injectPromise).resolves.toBe('db-id');
  });

  it('terminalizes a fresh row and throws when delivery consumption times out', async () => {
    const previousTimeout = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '40';
    try {
      const { manager, session } = makeManager({
        materializedRowIds: [],
        materializeOnEnqueue: true,
        consumedAfterHandoff: false,
      });
      indexSession(manager, liveSession(session));

      await expect(
        manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
      ).rejects.toThrow('delivery not consumed within timeout');

      expect(session.failDeliveryUnless).toHaveBeenCalledTimes(1);
      expect(session.cancelHeldJob).toHaveBeenCalledTimes(1);
    } finally {
      if (previousTimeout === undefined)
        delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      else process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = previousTimeout;
    }
  });

  it('a normalization error over an existing row restores the failed status', async () => {
    const { manager, session } = makeManager({
      deliveryContent: { sendStatus: 'failed' },
      normalizeThrows: true,
    });
    indexSession(manager, liveSession(session));

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow();

    expect(session.failDeliveryUnless).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage).not.toHaveBeenCalled();
  });

  it('a deferred-row retry whose entry dead-letters never releases the deferred hold', async () => {
    const { manager, session } = makeManager({
      deliveryContent: { sendStatus: 'deferred' },
      mailboxEntryStatus: 'dead',
    });
    indexSession(manager, liveSession(session));
    const activate = mock(async () => true);
    (
      manager as unknown as {
        activateDeferredDeliveryRow: (
          sessionId: string,
          messageId: string,
          origin: 'space_inject' | 'chat'
        ) => Promise<boolean>;
      }
    ).activateDeferredDeliveryRow = activate;

    await expect(
      manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
    ).rejects.toThrow('failed to materialize (dead)');

    expect(activate).not.toHaveBeenCalled();
    expect(session.cancelHeldJob).toHaveBeenCalledTimes(1);
    expect(session.cancelHeldJob.mock.calls[0][0]).toBe(SESSION_ID);
    expect(session.failDeliveryUnless).toHaveBeenCalled();
    expect(session.saveUserMessage).not.toHaveBeenCalled();
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
    expect(session.mailboxEnqueue).toHaveBeenCalledTimes(1);
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

  it('a fresh injection defers row creation and status publication to the mailbox lane', async () => {
    const { manager, session } = makeManager({});
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.mailboxEnqueue).toHaveBeenCalledTimes(1);
    expect(
      session.publishStatusChanged.mock.calls.filter(
        ([event]) => event === 'messages.statusChanged'
      )
    ).toEqual([]);
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

  it('publishes a failed status and persists a retry-compatible failed row when the handoff is rejected', async () => {
    const { manager, session } = makeManager({ enqueueThrows: true, materializedRowIds: [] });
    indexSession(manager, liveSession(session));

    await manager
      .injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true)
      .catch(() => {});

    expect(session.markDeliveryFailedByUuid).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.saveUserMessage.mock.calls[0][2]).toBe('failed');
    expect(session.saveUserMessage.mock.calls[0][3]).toBe('system');
    const saved = session.saveUserMessage.mock.calls[0][1] as Record<string, unknown>;
    expect(saved).toMatchObject({
      type: 'user',
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      inputKind: 'task',
      isSynthetic: true,
    });
    expect(typeof saved.uuid).toBe('string');
    expect(saved.message).toEqual({
      content: [{ type: 'text', text: '─── Message from coder ───' }],
    });
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
