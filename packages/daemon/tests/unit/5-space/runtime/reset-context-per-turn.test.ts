import { describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { ClearConversationCancelledError } from '../../../../src/lib/agent/agent-session.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { Database } from '../../../../src/storage/database';
import { createTestDb, createTestSession } from '../../../helpers/database';

const SESSION_ID = 'reviewer-session-1';
const RUN_ID = 'run-1';
const WORKFLOW_ID = 'wf-1';
const NODE_ID = 'node-review';
const AGENT_NAME = 'reviewer';

async function makeManager(opts: {
  slotResets?: boolean;
  parentTaskStatus?: string;
  noSession?: boolean;
}): Promise<{
  manager: TaskAgentManager;
  session: Record<string, ReturnType<typeof mock>>;
  db: Database;
}> {
  const clearMock = mock(async () => {});
  const ensureStartedMock = mock(async () => ({ started: false }));
  const enqueueMock = mock(async () => {});
  const replayMock = mock(async () => ({ success: true, messageCount: 0 }));
  const getProcessingState = mock(() => ({ status: 'idle' }));
  const publishStatusChanged = mock(async () => {});
  const db = await createTestDb();
  if (!opts.noSession) db.createSession(createTestSession(SESSION_ID));

  const slot = {
    agentId: 'Reviewer',
    name: AGENT_NAME,
    ...(opts.slotResets ? { resetContextPerTurn: true } : {}),
  };
  const workflow = { nodes: [{ id: NODE_ID, name: 'Review', agents: [slot] }] };

  const manager = new TaskAgentManager({
    db,
    internalEventBus: { subscribe: mock(() => () => {}), publish: publishStatusChanged },
    nodeExecutionRepo: {
      getByAgentSessionId: mock(() => ({
        workflowRunId: RUN_ID,
        workflowNodeId: NODE_ID,
        agentName: AGENT_NAME,
        agentSessionId: SESSION_ID,
      })),
      listByAgentSessionId: mock(() => []),
    },
    workflowRunRepo: { getRun: mock(() => ({ workflowId: WORKFLOW_ID })) },
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
  } as unknown as TaskAgentManagerConfig);

  return {
    manager,
    session: {
      clearMock,
      ensureStartedMock,
      enqueueMock,
      replayMock,
      getProcessingState,
      publishStatusChanged,
    },
    db,
  };
}

function seedDeliveryRow(
  db: Database,
  messageId: string,
  text: string,
  status: string,
  inputKind: 'task' | 'human' = 'task'
): void {
  db.saveUserMessage(
    SESSION_ID,
    {
      type: 'user',
      uuid: messageId,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      isSynthetic: inputKind === 'task',
      inputKind,
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
    'enqueued'
  );
  if (status === 'deferred') {
    db.getSDKMessageRepo().markDeliveryDeferredByUuid(SESSION_ID, messageId);
  }
  if (status === 'consumed') {
    db.getSDKMessageRepo().markDeliveryConsumedByUuid(SESSION_ID, messageId);
  }
  if (status === 'failed') {
    db.getSDKMessageRepo().markDeliveryFailedByUuid(SESSION_ID, messageId);
  }
}

function deliveryJobExists(db: Database, messageId: string): boolean {
  return (
    db
      .getDatabase()
      .prepare(
        `SELECT id FROM job_queue WHERE queue = 'message_delivery'
           AND json_extract(payload, '$.messageUuid') = ?`
      )
      .get(messageId) != null
  );
}

function deliveryRowCount(db: Database, messageId: string): number {
  const row = db
    .getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM sdk_messages WHERE sdk_uuid = ?`)
    .get(messageId) as { count: number };
  return row.count;
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

  function busySession(
    session: {
      ensureStartedMock: ReturnType<typeof mock>;
      clearMock: ReturnType<typeof mock>;
      enqueueMock: ReturnType<typeof mock>;
      replayMock: ReturnType<typeof mock>;
    },
    status: 'processing' | 'rate_limit_cooldown'
  ): AgentSession {
    return {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status }),
      ensureQueryStarted: session.ensureStartedMock,
      handleQueryTrigger: session.replayMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock, size: () => 0 },
    } as unknown as AgentSession;
  }

  it('first inject persists the row and enqueues a durable job', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'enqueued'
    );
    expect(deliveryJobExists(db, 'msg-1')).toBe(true);
    db.close();
  });

  it('a retry finding an existing CONSUMED row does not re-persist or re-enqueue (no re-drive)', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, liveSession(session));
    seedDeliveryRow(db, 'msg-1', '─── Message from coder ───', 'consumed');

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'consumed'
    );
    expect(deliveryJobExists(db, 'msg-1')).toBe(false);
    db.close();
  });

  it('a retry finding an existing FAILED row reopens it and re-enqueues without a duplicate row', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, liveSession(session));
    seedDeliveryRow(db, 'msg-1', '─── Message from coder ───', 'failed');

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'enqueued'
    );
    expect(deliveryJobExists(db, 'msg-1')).toBe(true);
    expect(deliveryRowCount(db, 'msg-1')).toBe(1);
    db.close();
  });

  it('a cancelled clear during a FAILED-row retry aborts before reopening the row', async () => {
    const { manager, session, db } = await makeManager({ slotResets: true });
    session.clearMock.mockRejectedValue(new ClearConversationCancelledError());
    indexSession(manager, liveSession(session));
    seedDeliveryRow(db, 'msg-1', '─── Message from coder ───', 'failed');

    await expect(
      manager.injectSubSessionMessage(
        SESSION_ID,
        '─── Message from coder ───',
        true,
        undefined,
        'immediate',
        undefined,
        'msg-1'
      )
    ).rejects.toThrow('cancelled by query teardown');

    expect(session.publishStatusChanged).not.toHaveBeenCalled();
    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'failed'
    );
    expect(deliveryJobExists(db, 'msg-1')).toBe(false);
    db.close();
  });

  it('a retry finding an existing CONSUMED row skips resetContextPerTurn (no /clear of the just-delivered handoff)', async () => {
    const { manager, session, db } = await makeManager({ slotResets: true });
    indexSession(manager, liveSession(session));
    seedDeliveryRow(db, 'msg-1', '─── Message from coder ───', 'consumed');

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'consumed'
    );
    db.close();
  });

  it('a failed-row retry that hits the deferred branch marks the row deferred (replay-selectable)', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, busySession(session, 'rate_limit_cooldown'));
    seedDeliveryRow(db, 'msg-1', '─── Message from coder ───', 'failed');

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'deferred'
    );
    expect(deliveryRowCount(db, 'msg-1')).toBe(1);
    db.close();
  });

  it('defers injection while the parent task is rate limited', async () => {
    const { manager, session, db } = await makeManager({ parentTaskStatus: 'rate_limited' });
    const live = liveSession(session);
    indexSession(manager, live);
    attachSessionToTask(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'wait for parent task',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'deferred'
    );
    expect(deliveryJobExists(db, 'msg-1')).toBe(false);
    db.close();
  });

  it('a deferred human message to a busy live session persists as a deferred row (task #949)', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, busySession(session, 'processing'));

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer',
      undefined,
      'msg-1'
    );

    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'deferred'
    );
    const originRow = db
      .getDatabase()
      .prepare(`SELECT origin FROM sdk_messages WHERE sdk_uuid = 'msg-1'`)
      .get() as { origin: string | null };
    expect(originRow.origin).toBeNull();
    expect(deliveryJobExists(db, 'msg-1')).toBe(false);
    db.close();
  });

  it('a deferred injection into a busy session publishes messages.statusChanged', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, busySession(session, 'processing'));

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer',
      undefined,
      'msg-1'
    );

    const call = session.publishStatusChanged.mock.calls.find(
      ([event]) => event === 'messages.statusChanged'
    );
    expect(call?.[1]).toMatchObject({ sessionId: SESSION_ID, status: 'deferred' });
    expect(typeof (call?.[1] as { messageIds: string[] }).messageIds[0]).toBe('string');
    db.close();
  });

  it('a fresh enqueued injection publishes messages.statusChanged', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    const call = session.publishStatusChanged.mock.calls.find(
      ([event]) => event === 'messages.statusChanged'
    );
    expect(call?.[1]).toMatchObject({ sessionId: SESSION_ID, status: 'enqueued' });
    expect(typeof (call?.[1] as { messageIds: string[] }).messageIds[0]).toBe('string');
    db.close();
  });

  it('a failed-row retry publishes reopen and deferred status changes', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, busySession(session, 'rate_limit_cooldown'));
    seedDeliveryRow(db, 'msg-1', '─── Message from coder ───', 'failed');

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'immediate',
      undefined,
      'msg-1'
    );

    const statuses = session.publishStatusChanged.mock.calls
      .filter(([event]) => event === 'messages.statusChanged')
      .map(([, payload]) => (payload as { status: string }).status);
    expect(statuses).toContain('enqueued');
    expect(statuses).toContain('deferred');
    db.close();
  });

  it('rolls back the fresh row when the outbox handoff fails', async () => {
    const { manager, session, db } = await makeManager({ noSession: true });
    indexSession(manager, liveSession(session));

    await manager
      .injectSubSessionMessage(
        SESSION_ID,
        '─── Message from coder ───',
        true,
        undefined,
        'immediate',
        undefined,
        'msg-1'
      )
      .catch(() => {});

    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')).toBeNull();
    const failedCalls = session.publishStatusChanged.mock.calls.filter(
      ([, payload]) => (payload as { status: string }).status === 'failed'
    );
    expect(failedCalls).toHaveLength(0);
    db.close();
  });

  it('a defer branch over an existing deferred row re-marks nothing and reuses the existing message id', async () => {
    const { manager, session, db } = await makeManager({});
    indexSession(manager, busySession(session, 'processing'));
    seedDeliveryRow(db, 'msg-1', 'queue for next turn', 'deferred', 'human');

    const dbId = await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer',
      undefined,
      'msg-1'
    );

    expect(dbId).toBe('msg-1');
    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'deferred'
    );
    expect(deliveryRowCount(db, 'msg-1')).toBe(1);
    expect(session.publishStatusChanged).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: SESSION_ID,
      messageIds: ['msg-1'],
      status: 'deferred',
    });
    db.close();
  });

  it('a rejecting status publish is swallowed on the defer branch (fire-and-forget)', async () => {
    const { manager, session, db } = await makeManager({});
    session.publishStatusChanged.mockRejectedValue(new Error('bus down'));
    indexSession(manager, busySession(session, 'processing'));

    const dbId = await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer',
      undefined,
      'msg-1'
    );

    expect(dbId).toBeTypeOf('string');
    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-1')?.sendStatus).toBe(
      'deferred'
    );
    expect(deliveryJobExists(db, 'msg-1')).toBe(false);
    db.close();
  });
});
