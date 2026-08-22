import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import type { Database } from '../../../../src/storage/database.ts';

function makeEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return {
    publish: mock(async () => {}),
    publishAsync: mock(() => {}),
    subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

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
    getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
    getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
    saveSDKMessage: mock(() => true),
    deleteMessagesAfter: mock(() => 0),
    deleteMessagesAtAndAfter: mock(() => 0),
    getUserMessageByUuid: mock(() => undefined),
    countMessagesAfter: mock(() => 0),
    updateMessage: mock(() => {}),
    getSDKMessageCount: mock(() => 0),
    getConsumedUserMessagesAfterLatestInit: mock(() => []),
  } as unknown as Database;

  return new AgentSession(
    mockSession,
    mockDb,
    { event: mock(() => {}) } as MessageHub,
    eventBus,
    mock(async () => 'test-api-key')
  );
}

function stubClearExternals(session: AgentSession): void {
  spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
  spyOn(session.messageQueue, 'enqueueWithId').mockResolvedValue(undefined);
  spyOn(session.messageHandler, 'waitForSuppressedResult').mockResolvedValue('confirmed');
}

function makeClearResult(uuid: string, userMessageUuid?: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    is_error: false,
    ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0.001,
    modelUsage: {},
  } as unknown as SDKMessage;
}

function makeClearErrorResult(uuid: string, userMessageUuid?: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    uuid,
    is_error: true,
    ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
    errors: ['max turns exceeded'],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0.001,
    modelUsage: {},
  } as unknown as SDKMessage;
}

describe('AgentSession.clearConversationContext', () => {
  it('issues /clear as an internal control message after ensuring the query is pulling', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    const order: string[] = [];
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockImplementation(async () => {
      order.push('ensureQueryStarted');
    });
    spyOn(session.messageQueue, 'enqueueWithId').mockImplementation(
      async (messageId: string, content: string | unknown[]) => {
        expect(messageId).toBeTruthy();
        expect(content).toBe('/clear');
        order.push('enqueue');
      }
    );
    spyOn(session.messageHandler, 'waitForSuppressedResult').mockResolvedValue('confirmed');

    await session.clearConversationContext();

    expect(order).toEqual(['ensureQueryStarted', 'enqueue']);
    expect(session.messageQueue.enqueueWithId).toHaveBeenCalledWith(
      expect.any(String),
      '/clear',
      true
    );
  });

  it('arms idle suppression before /clear so its result cannot fire the completion callback early', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);
    const suppressSpy = spyOn(session.messageHandler, 'suppressIdleForNextResult');

    await session.clearConversationContext();

    expect(suppressSpy).toHaveBeenCalledTimes(1);
    expect(session.messageQueue.enqueueWithId).toHaveBeenCalledWith(
      expect.any(String),
      '/clear',
      true
    );
  });

  it('releases the idle suppression and rethrows if /clear enqueue fails', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    spyOn(session.messageQueue, 'enqueueWithId').mockRejectedValue(new Error('queue closed'));
    const releaseSpy = spyOn(session.messageHandler, 'clearIdleSuppression');
    const resetSpy = spyOn(session, 'resetQuery').mockResolvedValue({ success: true });

    await expect(session.clearConversationContext()).rejects.toThrow('queue closed');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('tears the query down before rethrowing when the yielded /clear times out in the queue', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    const timeoutError = new Error('Message queue timeout: SDK did not consume the clear');
    timeoutError.name = 'MessageQueueTimeoutError';
    spyOn(session.messageQueue, 'enqueueWithId').mockRejectedValue(timeoutError);
    const warnSpy = spyOn(session.logger, 'warn').mockImplementation(() => {});
    const resetSpy = spyOn(session, 'resetQuery').mockResolvedValue({ success: true });
    const stopSpy = spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);

    await expect(session.clearConversationContext()).rejects.toThrow('Message queue timeout');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('resetting the query before rethrowing');
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('clear resolves on the SDK result of the /clear turn, not on sent (confirmed clear)', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    const suppressSpy = spyOn(session.messageHandler, 'suppressIdleForNextResult');
    const warnSpy = spyOn(session.logger, 'warn').mockImplementation(() => {});
    session.messageQueue.start();
    const messages = session.messageQueue.messageGenerator(session.session.id);

    let deliveredAfterClear: string | null = null;
    const caller = (async () => {
      await session.clearConversationContext();
      deliveredAfterClear = 'delivered';
    })();
    const yielded = await messages.next();

    expect(suppressSpy).toHaveBeenCalledTimes(1);
    expect(yielded.done).toBe(false);
    expect(yielded.value?.message.internal).toBe(true);
    expect(yielded.value?.message.message.content).toEqual([{ type: 'text', text: '/clear' }]);

    yielded.value?.onSent();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deliveredAfterClear).toBe(null);

    const clearMessageUuid = String(yielded.value?.message.uuid);
    await session.messageHandler.handleMessage(makeClearResult('compact-result', 'compact-msg-id'));
    expect(deliveredAfterClear).toBe(null);

    await session.messageHandler.handleMessage(makeClearResult('clear-result', clearMessageUuid));
    await caller;

    expect(deliveredAfterClear).toBe('delivered');
    expect(warnSpy).not.toHaveBeenCalled();
    session.messageQueue.stop();
    await messages.return(undefined);
  });

  it('an error result for the /clear turn resolves unconfirmed, warns, and releases idle suppression', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    const warnSpy = spyOn(session.logger, 'warn').mockImplementation(() => {});
    const resetSpy = spyOn(session, 'resetQuery').mockResolvedValue({ success: true });
    const setIdleSpy = spyOn(session.stateManager, 'setIdle').mockResolvedValue(undefined);
    session.messageQueue.start();
    const messages = session.messageQueue.messageGenerator(session.session.id);

    let resolved = false;
    const clear = session.clearConversationContext().then(() => {
      resolved = true;
    });
    const yielded = await messages.next();
    yielded.value?.onSent();

    await session.messageHandler.handleMessage(makeClearErrorResult('clear-error'));
    await clear;

    expect(resolved).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('proceeding without confirmed clear');
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(setIdleSpy).not.toHaveBeenCalled();

    await session.messageHandler.handleMessage(makeClearResult('next-turn-result'));
    expect(setIdleSpy.mock.calls.length).toBeGreaterThan(1);

    session.messageQueue.stop();
    await messages.return(undefined);
  });

  it('timeout fallback: warns, resets the query, and resolves without the clear when no result arrives', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    session.overrideClearConfirmTimeoutMsForTest(15);
    const warnSpy = spyOn(session.logger, 'warn').mockImplementation(() => {});
    const resetSpy = spyOn(session, 'resetQuery').mockResolvedValue({ success: true });
    const stopSpy = spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    const setIdleSpy = spyOn(session.stateManager, 'setIdle').mockResolvedValue(undefined);
    session.messageQueue.start();
    const messages = session.messageQueue.messageGenerator(session.session.id);

    let resolved = false;
    const clear = session.clearConversationContext().then(() => {
      resolved = true;
    });
    const yielded = await messages.next();
    yielded.value?.onSent();

    await clear;

    expect(resolved).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('proceeding without confirmed clear');
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();

    await session.messageHandler.handleMessage(makeClearResult('late-result'));
    expect(setIdleSpy).toHaveBeenCalled();

    session.messageQueue.stop();
    await messages.return(undefined);
  });

  it('timeout fallback forces query teardown when the recovery reset itself fails', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    session.overrideClearConfirmTimeoutMsForTest(15);
    const warnSpy = spyOn(session.logger, 'warn').mockImplementation(() => {});
    spyOn(session, 'resetQuery').mockResolvedValue({
      success: false,
      error: 'event subscriber rejected',
    });
    const stopSpy = spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    session.messageQueue.start();
    const messages = session.messageQueue.messageGenerator(session.session.id);

    let resolved = false;
    const clear = session.clearConversationContext().then(() => {
      resolved = true;
    });
    const yielded = await messages.next();
    yielded.value?.onSent();

    await clear;

    expect(resolved).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1][0]).toContain('forcing query teardown');
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith({ catchQueryErrors: true });

    session.messageQueue.stop();
    await messages.return(undefined);
  });

  it('an interrupt cancels the pending clear wait without timeout recovery', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session['lifecycleManager'], 'ensureQueryStarted').mockResolvedValue(undefined);
    const warnSpy = spyOn(session.logger, 'warn').mockImplementation(() => {});
    const resetSpy = spyOn(session, 'resetQuery').mockResolvedValue({ success: true });
    const stopSpy = spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    session.messageQueue.start();
    const messages = session.messageQueue.messageGenerator(session.session.id);

    let resolved = false;
    const clear = session.clearConversationContext().then(() => {
      resolved = true;
    });
    const yielded = await messages.next();
    yielded.value?.onSent();

    await session.handleInterrupt();
    await clear;

    expect(resolved).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('cancelled by query teardown');
    expect(resetSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();

    session.messageQueue.stop();
    await messages.return(undefined);
  });

  it('does not stop or restart the query (the SDK rotates the session in-stream)', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    const stopSpy = spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    const startSpy = spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
    stubClearExternals(session);

    await session.clearConversationContext();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not bump the query generation (no stale-query suppression needed)', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);
    const genBefore = session.getQueryGeneration();

    await session.clearConversationContext();

    expect(session.getQueryGeneration()).toBe(genBefore);
  });

  it('does not wipe sdkSessionId in memory — the SDK rotates it; handleSystemInit captures the new id', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext();

    expect(session.session.sdkSessionId).toBe('sdk-1');
  });

  it('records the current sdkSessionId into the pastSdkSessionIds audit trace', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      metadata: { pastSdkSessionIds: ['sdk-old'] },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext();

    expect(session.session.metadata?.pastSdkSessionIds).toEqual(['sdk-old', 'sdk-1']);
  });

  it('does not duplicate the current id when it is already the most recent trace entry', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      metadata: { pastSdkSessionIds: ['sdk-0', 'sdk-1'] },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext();

    expect(session.session.metadata?.pastSdkSessionIds).toEqual(['sdk-0', 'sdk-1']);
  });

  it('caps pastSdkSessionIds at 50 entries (drops the oldest)', async () => {
    const existing = Array.from({ length: 50 }, (_, i) => `sdk-${i}`);
    const session = createAgentSession({
      sdkSessionId: 'sdk-new',
      metadata: { pastSdkSessionIds: existing },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext();

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

    await session.clearConversationContext();

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

    await session.clearConversationContext();

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

    await session.clearConversationContext();

    expect(db.updateSession).not.toHaveBeenCalled();
    expect(session.messageQueue.enqueueWithId).toHaveBeenCalledWith(
      expect.any(String),
      '/clear',
      true
    );
  });

  it('keeps the NeoKai session id stable and preserves message history', async () => {
    const originalId = 'stable-neokai-session';
    const session = createAgentSession({
      id: originalId,
      sdkSessionId: 'sdk-1',
    } as Partial<Session>);
    stubClearExternals(session);
    const db = session.db as unknown as Record<string, ReturnType<typeof mock>>;

    await session.clearConversationContext();

    expect(session.session.id).toBe(originalId);
    expect(db.deleteMessagesAfter).not.toHaveBeenCalled();
    expect(db.deleteMessagesAtAndAfter).not.toHaveBeenCalled();
  });
});
