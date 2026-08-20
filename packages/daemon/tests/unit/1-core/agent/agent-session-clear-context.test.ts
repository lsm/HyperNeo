import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../../../src/storage/database.ts';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';

interface TestEventBus {
  _emit(event: string, data: unknown): void;
}

function makeEventBus(): InternalEventBus<DaemonInternalEventMap> & TestEventBus {
  const handlers: Array<{ event: string; sessionId?: string; fn: (data: unknown) => void }> = [];
  return {
    publish: mock(async () => {}),
    publishAsync: mock(() => {}),
    subscribe: mock(
      (
        event: string,
        fn: (data: unknown) => void,
        options: { subscriberName: string; sessionId?: string }
      ) => {
        handlers.push({ event, sessionId: options.sessionId, fn });
        return () => {
          const index = handlers.findIndex((h) => h.fn === fn);
          if (index !== -1) handlers.splice(index, 1);
        };
      }
    ) as unknown as InternalEventBus<DaemonInternalEventMap>['subscribe'],
    _emit(event: string, data: unknown) {
      for (const h of handlers) {
        if (h.event !== event) continue;
        if (
          h.sessionId !== undefined &&
          h.sessionId !== (data as { sessionId?: string }).sessionId
        ) {
          continue;
        }
        void h.fn(data);
      }
    },
  } as unknown as InternalEventBus<DaemonInternalEventMap> & TestEventBus;
}

function emitResult(bus: TestEventBus, sessionId: string, userMessageUuid?: string): void {
  const message = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    parent_tool_use_id: null,
    session_id: sessionId,
    user_message_uuid: userMessageUuid,
  } as unknown as SDKMessage;
  bus._emit('sdk.message', { sessionId, message });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function createAgentSession(
  overrides: Partial<Session> = {},
  eventBus: InternalEventBus<DaemonInternalEventMap> = makeEventBus()
): AgentSession {
  const mockSession: Session = {
    id: `test-session-${Math.random()}`,
    title: 'Test Session',
    workspacePath: '/test/workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {},
    ...overrides,
  } as Session;

  const mockDb = {
    getSession: mock(() => mockSession),
    updateSession: mock(() => {}),
    getUserMessages: mock(() => []),
    getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
    deleteMessagesAfter: mock(() => 0),
    deleteMessagesAtAndAfter: mock(() => 0),
    getUserMessageByUuid: mock(() => undefined),
    countMessagesAfter: mock(() => 0),
    getMessagesByStatus: mock(() => []),
    updateMessage: mock(() => {}),
    getSDKMessageCount: mock(() => 0),
    getConsumedUserMessagesAfterLatestInit: mock(() => []),
  } as unknown as Database;

  return new AgentSession(
    mockSession,
    mockDb,
    {} as MessageHub,
    eventBus,
    mock(async () => 'test-api-key')
  );
}

function stubClearExternals(session: AgentSession): void {
  spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
  spyOn(session.messageQueue, 'enqueue').mockResolvedValue('clear-msg-id');
}

describe('AgentSession.clearConversationContext', () => {
  it('issues /clear as an internal control message after ensuring the query is pulling', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    const order: string[] = [];
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockImplementation(async () => {
      order.push('ensureQueryStarted');
    });
    spyOn(session.messageQueue, 'enqueue').mockImplementation(async () => {
      order.push('enqueue');
      return 'clear-msg-id';
    });

    await session.clearConversationContext({ confirm: false });

    expect(order).toEqual(['ensureQueryStarted', 'enqueue']);
    expect(session.messageQueue.enqueue).toHaveBeenCalledWith('/clear', true);
  });

  it('arms idle suppression before /clear so its result cannot fire the completion callback early', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);
    const suppressSpy = spyOn(session.messageHandler, 'suppressIdleForNextResult');

    await session.clearConversationContext({ confirm: false });

    expect(suppressSpy).toHaveBeenCalledTimes(1);
    expect(session.messageQueue.enqueue).toHaveBeenCalledWith('/clear', true);
  });

  it('releases the idle suppression and rethrows if /clear enqueue fails', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    spyOn(session.messageQueue, 'enqueue').mockRejectedValue(new Error('queue closed'));
    const releaseSpy = spyOn(session.messageHandler, 'clearIdleSuppression');

    await expect(session.clearConversationContext()).rejects.toThrow('queue closed');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('does not stop or restart the query (the SDK rotates the session in-stream)', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    const stopSpy = spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    const startSpy = spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
    stubClearExternals(session);

    await session.clearConversationContext({ confirm: false });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not bump the query generation (no stale-query suppression needed)', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);
    const genBefore = session.getQueryGeneration();

    await session.clearConversationContext({ confirm: false });

    expect(session.getQueryGeneration()).toBe(genBefore);
  });

  it('does not wipe sdkSessionId in memory — the SDK rotates it; handleSystemInit captures the new id', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext({ confirm: false });

    expect(session.session.sdkSessionId).toBe('sdk-1');
  });

  it('records the current sdkSessionId into the pastSdkSessionIds audit trace', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      metadata: { pastSdkSessionIds: ['sdk-old'] },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext({ confirm: false });

    expect(session.session.metadata?.pastSdkSessionIds).toEqual(['sdk-old', 'sdk-1']);
  });

  it('does not duplicate the current id when it is already the most recent trace entry', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      metadata: { pastSdkSessionIds: ['sdk-0', 'sdk-1'] },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext({ confirm: false });

    expect(session.session.metadata?.pastSdkSessionIds).toEqual(['sdk-0', 'sdk-1']);
  });

  it('caps pastSdkSessionIds at 50 entries (drops the oldest)', async () => {
    const existing = Array.from({ length: 50 }, (_, i) => `sdk-${i}`);
    const session = createAgentSession({
      sdkSessionId: 'sdk-new',
      metadata: { pastSdkSessionIds: existing },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext({ confirm: false });

    const trace = session.session.metadata?.pastSdkSessionIds ?? [];
    expect(trace).toHaveLength(50);
    expect(trace[0]).toBe('sdk-1');
    expect(trace[49]).toBe('sdk-new');
  });

  it('rolls the prior turn cost into costBaseline and zeroes lastSdkCost', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      metadata: { lastSdkCost: 0.42, costBaseline: 1.0 },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext({ confirm: false });

    expect(session.session.metadata?.costBaseline).toBeCloseTo(1.42, 5);
    expect(session.session.metadata?.lastSdkCost).toBe(0);
  });

  it('persists the cost rollup + audit trace in a single metadata write before /clear', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      metadata: { lastSdkCost: 0.42, costBaseline: 1.0 },
    } as Partial<Session>);
    stubClearExternals(session);
    const db = session.db as unknown as { updateSession: ReturnType<typeof mock> };

    await session.clearConversationContext({ confirm: false });

    expect(db.updateSession).toHaveBeenCalledTimes(1);
    const [id, payload] = db.updateSession.mock.calls[0];
    expect(id).toBe(session.session.id);
    const meta = (payload as { metadata: Record<string, unknown> }).metadata;
    expect(meta.costBaseline).toBeCloseTo(1.42, 5);
    expect(meta.lastSdkCost).toBe(0);
    expect(meta.pastSdkSessionIds).toEqual(['sdk-1']);
  });

  it('skips the metadata write when there is no cost and no sdkSessionId to record', async () => {
    const session = createAgentSession({ sdkSessionId: undefined } as Partial<Session>);
    stubClearExternals(session);
    const db = session.db as unknown as { updateSession: ReturnType<typeof mock> };

    await session.clearConversationContext({ confirm: false });

    expect(db.updateSession).not.toHaveBeenCalled();
    expect(session.messageQueue.enqueue).toHaveBeenCalledWith('/clear', true);
  });

  it('keeps the NeoKai session id stable and preserves message history', async () => {
    const originalId = 'stable-neokai-session';
    const session = createAgentSession({
      id: originalId,
      sdkSessionId: 'sdk-1',
    } as Partial<Session>);
    stubClearExternals(session);
    const db = session.db as unknown as Record<string, ReturnType<typeof mock>>;

    await session.clearConversationContext({ confirm: false });

    expect(session.session.id).toBe(originalId);
    expect(db.deleteMessagesAfter).not.toHaveBeenCalled();
    expect(db.deleteMessagesAtAndAfter).not.toHaveBeenCalled();
  });
});

describe('AgentSession.clearConversationContext — confirmed /clear', () => {
  it('does not resolve until the matching /clear result event arrives', async () => {
    const bus = makeEventBus();
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>, bus);
    stubClearExternals(session);

    let resolved = false;
    const pending = session.clearConversationContext().then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);

    emitResult(bus, session.session.id, 'clear-msg-id');
    await pending;
    expect(resolved).toBe(true);
  });

  it('ignores a result for a different user message (keeps waiting for the /clear result)', async () => {
    const bus = makeEventBus();
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>, bus);
    stubClearExternals(session);

    let resolved = false;
    const pending = session.clearConversationContext().then(() => {
      resolved = true;
    });
    await settle();

    emitResult(bus, session.session.id, 'some-other-msg-id');
    await settle();
    expect(resolved).toBe(false);

    emitResult(bus, session.session.id, 'clear-msg-id');
    await pending;
    expect(resolved).toBe(true);
  });

  it('confirms on an error result for the /clear turn (no user_message_uuid)', async () => {
    const bus = makeEventBus();
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>, bus);
    stubClearExternals(session);

    let resolved = false;
    const pending = session.clearConversationContext().then(() => {
      resolved = true;
    });
    await settle();

    const message = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      parent_tool_use_id: null,
      session_id: session.session.id,
    } as unknown as SDKMessage;
    bus._emit('sdk.message', { sessionId: session.session.id, message });
    await pending;
    expect(resolved).toBe(true);
  });

  it('times out and proceeds without clear confirmation (logs a warning)', async () => {
    const bus = makeEventBus();
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>, bus);
    stubClearExternals(session);
    const warnSpy = spyOn(session.logger, 'warn');

    await session.clearConversationContext({ timeoutMs: 10 });
    expect(warnSpy).toHaveBeenCalled();
    const [warning] = warnSpy.mock.calls[0];
    expect(String(warning)).toContain('proceeding without clear confirmation');
  });

  it('arms the pending-clear guard until a delivery result arrives', async () => {
    const bus = makeEventBus();
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>, bus);
    stubClearExternals(session);

    const pending = session.clearConversationContext();
    await settle();
    expect(session.hasPendingContextResetClear()).toBe(true);

    emitResult(bus, session.session.id, 'clear-msg-id');
    await pending;
    expect(session.hasPendingContextResetClear()).toBe(true);

    emitResult(bus, session.session.id, 'handoff-msg-id');
    await settle();
    expect(session.hasPendingContextResetClear()).toBe(false);
  });

  it('does not arm the pending-clear guard in non-confirmed mode', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext({ confirm: false });
    expect(session.hasPendingContextResetClear()).toBe(false);
  });
});
