import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import { SessionCoordinationStallError } from '../../../../src/lib/agent/message-delivery';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import {
  MAX_IMAGE_BASE64_SIZE,
  MessagePersistence,
  validateImageSizes,
} from '../../../../src/lib/session/message-persistence';
import type { SessionCache } from '../../../../src/lib/session/session-cache';
import type { Database } from '../../../../src/storage/database';

describe('MessagePersistence', () => {
  let mockSessionCache: SessionCache;
  let mockDb: Database;
  let mockMessageHub: MessageHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let persistence: MessagePersistence;
  let mockSession: Session;
  let mockAgentSession: {
    getSessionData: ReturnType<typeof mock>;
    getProcessingState: ReturnType<typeof mock>;
    startQueryAndEnqueue: ReturnType<typeof mock>;
    stateManager: { setQueuedIfIdle: ReturnType<typeof mock> };
  };

  let saveUserMessageSpy: ReturnType<typeof mock>;
  let messageHubEventSpy: ReturnType<typeof mock>;
  let internalEventBusPublishSpy: ReturnType<typeof mock>;
  let processingStateSpy: ReturnType<typeof mock>;
  let dbGetSessionSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSession = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 1.0,
        queryMode: 'immediate',
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        titleGenerated: true,
      },
    };

    processingStateSpy = mock(() => ({ status: 'idle' }));
    mockAgentSession = {
      getSessionData: mock(() => mockSession),
      getProcessingState: processingStateSpy,
      startQueryAndEnqueue: mock(async () => {}),
      stateManager: { setQueuedIfIdle: mock(async () => true) },
    };

    mockSessionCache = {
      getAsync: mock(async () => mockAgentSession),
    } as unknown as SessionCache;

    saveUserMessageSpy = mock(() => 'db-msg-1');
    dbGetSessionSpy = mock(() => ({
      id: 'test-session-id',
      status: 'active',
      metadata: {},
    }));
    mockDb = {
      saveUserMessage: saveUserMessageSpy,
      getSession: dbGetSessionSpy,
    } as unknown as Database;

    messageHubEventSpy = mock(async () => {});
    mockMessageHub = {
      event: messageHubEventSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    internalEventBusPublishSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: internalEventBusPublishSpy,
      publishAsync: mock(() => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockMessageHub,
      mockInternalEventBus
    );
  });

  const setStoredDraftState = (metadata: Record<string, unknown>): void => {
    dbGetSessionSpy.mockReturnValue({
      id: 'test-session-id',
      status: 'active',
      metadata,
    });
  };

  it('persists idle immediate as enqueued and defers dispatch to the durable handler', async () => {
    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'hello idle',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({ uuid: 'msg-1', type: 'user' }),
      'enqueued',
      undefined
    );
    expect(messageHubEventSpy).not.toHaveBeenCalled();
    expect(mockAgentSession.startQueryAndEnqueue).not.toHaveBeenCalled();
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: 'test-session-id',
      messageIds: ['db-msg-1'],
      status: 'enqueued',
    });
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({
        sessionId: 'test-session-id',
        messageId: 'msg-1',
        sendStatus: 'enqueued',
        deliveryMode: 'immediate',
        skipQueryStart: false,
      })
    );
  });

  it('flags hasDraftToClear when the sent text matches the draft directly', async () => {
    setStoredDraftState({ inputDraft: 'hello idle' });
    mockAgentSession.getSessionData.mockReturnValue({
      ...mockSession,
      metadata: { ...mockSession.metadata, inputDraft: 'hello idle' },
    });
    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'hello idle',
    });
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({ hasDraftToClear: true })
    );
  });

  it('flags hasDraftToClear when the sent text matches the voice composition', async () => {
    setStoredDraftState({ inputDraft: 'hello idle', inputDraftVoicePending: 'plus voice' });
    mockAgentSession.getSessionData.mockReturnValue({
      ...mockSession,
      metadata: {
        ...mockSession.metadata,
        inputDraft: 'hello idle',
        inputDraftVoicePending: 'plus voice',
      },
    });
    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'hello idle plus voice',
    });
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({ hasDraftToClear: true, voicePendingSent: 'plus voice' })
    );
  });

  it('does not flag hasDraftToClear when neither the draft nor the composition matches', async () => {
    setStoredDraftState({ inputDraft: 'different draft', inputDraftVoicePending: 'voice' });
    mockAgentSession.getSessionData.mockReturnValue({
      ...mockSession,
      metadata: {
        ...mockSession.metadata,
        inputDraft: 'different draft',
        inputDraftVoicePending: 'voice',
      },
    });
    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'hello idle',
    });
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({ hasDraftToClear: false })
    );
  });

  it("computes the gate from the pre-send snapshot, immune to the sender's optimistic clear", async () => {
    setStoredDraftState({ inputDraft: 'typing', inputDraftVoicePending: 'voice' });
    mockAgentSession.getSessionData.mockReturnValue({
      ...mockSession,
      metadata: {
        ...mockSession.metadata,
        inputDraft: null,
        inputDraftVoicePending: 'voice',
      },
    });
    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'typing voice',
    });
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({ hasDraftToClear: true, voicePendingSent: 'voice' })
    );
  });

  it('flags a voice-only composition send (empty draft, pending alone)', async () => {
    setStoredDraftState({ inputDraft: null, inputDraftVoicePending: 'voice' });
    mockAgentSession.getSessionData.mockReturnValue({
      ...mockSession,
      metadata: {
        ...mockSession.metadata,
        inputDraft: null,
        inputDraftVoicePending: 'voice',
      },
    });
    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'voice',
    });
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({ hasDraftToClear: true, voicePendingSent: 'voice' })
    );
  });

  it('carries the staging when the sent text extends the pre-send composition', async () => {
    setStoredDraftState({ inputDraft: 'typing', inputDraftVoicePending: 'voice' });
    mockAgentSession.getSessionData.mockReturnValue({
      ...mockSession,
      metadata: {
        ...mockSession.metadata,
        inputDraft: 'typing',
        inputDraftVoicePending: 'voice',
      },
    });
    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'typing voice now',
    });
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({ hasDraftToClear: true, voicePendingSent: 'voice' })
    );
  });

  it('persists busy immediate as enqueued and defers dispatch', async () => {
    processingStateSpy.mockReturnValue({ status: 'processing' });

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-2',
      content: 'hello busy',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({ uuid: 'msg-2', type: 'user' }),
      'enqueued',
      undefined
    );
    expect(mockAgentSession.startQueryAndEnqueue).not.toHaveBeenCalled();
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({
        messageId: 'msg-2',
        sendStatus: 'enqueued',
        deliveryMode: 'immediate',
        skipQueryStart: false,
      })
    );
  });

  it('persists busy defer as deferred and does not dispatch', async () => {
    processingStateSpy.mockReturnValue({ status: 'processing' });

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-3',
      content: 'next turn please',
      deliveryMode: 'defer',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({ uuid: 'msg-3', type: 'user' }),
      'deferred',
      undefined
    );
    expect(internalEventBusPublishSpy).not.toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({ messageId: 'msg-3' })
    );
    expect(mockAgentSession.startQueryAndEnqueue).not.toHaveBeenCalled();
  });

  it('falls back idle defer to enqueued immediate and defers dispatch', async () => {
    processingStateSpy.mockReturnValue({ status: 'idle' });

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-4',
      content: 'next turn while idle',
      deliveryMode: 'defer',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({ uuid: 'msg-4', type: 'user' }),
      'enqueued',
      undefined
    );
    expect(mockAgentSession.startQueryAndEnqueue).not.toHaveBeenCalled();
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({
        messageId: 'msg-4',
        sendStatus: 'enqueued',
        deliveryMode: 'immediate',
        skipQueryStart: false,
      })
    );
  });

  it('rejects archived sessions before saving a user message', async () => {
    mockDb.getSession = mock(() => ({ ...mockSession, status: 'archived' })) as never;

    await expect(
      persistence.persist({
        sessionId: 'test-session-id',
        messageId: 'msg-archived',
        content: 'must not persist',
      })
    ).rejects.toThrow('Session test-session-id is archived');

    expect(mockSessionCache.getAsync).not.toHaveBeenCalled();
    expect(saveUserMessageSpy).not.toHaveBeenCalled();
    expect(mockAgentSession.startQueryAndEnqueue).not.toHaveBeenCalled();
  });

  it('opt-out (HYPERNEO_MESSAGE_DELIVERY_V2=0) dispatches inline via startQueryAndEnqueue', async () => {
    const previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';

    try {
      await persistence.persist({
        sessionId: 'test-session-id',
        messageId: 'msg-legacy',
        content: 'inline dispatch',
      });
    } finally {
      if (previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previous;
    }

    expect(mockAgentSession.startQueryAndEnqueue).toHaveBeenCalledWith(
      'msg-legacy',
      'inline dispatch'
    );
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'message.persisted',
      expect.objectContaining({
        messageId: 'msg-legacy',
        sendStatus: 'enqueued',
        deliveryMode: 'immediate',
        skipQueryStart: true,
      })
    );
  });

  it('opt-out legacy dispatch rolls the enqueued row back to failed on coordination stall', async () => {
    const previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    const transitionSpy = mock(() => true);
    mockDb.getSDKMessageRepo = mock(() => ({
      transitionMessageSendStatus: transitionSpy,
    }));
    mockAgentSession.startQueryAndEnqueue = mock(
      () =>
        new Promise((_resolve, reject) => {
          reject(new SessionCoordinationStallError('test-session-id', 8_000, 9_000));
        })
    );

    try {
      await expect(
        persistence.persist({
          sessionId: 'test-session-id',
          messageId: 'msg-legacy-stall',
          content: 'stalled dispatch',
        })
      ).rejects.toBeInstanceOf(SessionCoordinationStallError);
    } finally {
      if (previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previous;
    }

    expect(transitionSpy).toHaveBeenCalledWith('db-msg-1', 'enqueued', 'failed');
    expect(internalEventBusPublishSpy).toHaveBeenCalledWith(
      'messages.statusChanged',
      expect.objectContaining({
        sessionId: 'test-session-id',
        messageIds: ['db-msg-1'],
        status: 'failed',
      })
    );
  });

  it('does not downgrade a busy session from processing to queued', async () => {
    processingStateSpy.mockReturnValue({ status: 'processing' });

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-busy',
      content: 'durable steer',
    });

    expect(mockAgentSession.stateManager.setQueuedIfIdle).not.toHaveBeenCalled();
    expect(mockAgentSession.startQueryAndEnqueue).not.toHaveBeenCalled();
  });
});

describe('validateImageSizes', () => {
  const tinyData = 'AAAA';

  it('returns without error for an empty list', () => {
    expect(() => validateImageSizes([])).not.toThrow();
  });

  it('accepts images under the 5MB base64 cap', () => {
    expect(() => validateImageSizes([{ media_type: 'image/png', data: tinyData }])).not.toThrow();
  });

  it('throws a user-facing error when an image exceeds the cap', () => {
    const oversized = 'a'.repeat(MAX_IMAGE_BASE64_SIZE + 1);
    expect(() => validateImageSizes([{ media_type: 'image/png', data: oversized }])).toThrow(
      /exceeds API limit.*Please resize the image/i
    );
  });

  it('throws when any image in a batch exceeds the cap', () => {
    const oversized = 'a'.repeat(MAX_IMAGE_BASE64_SIZE + 1);
    expect(() =>
      validateImageSizes([
        { media_type: 'image/png', data: tinyData },
        { media_type: 'image/png', data: oversized },
      ])
    ).toThrow(/exceeds API limit/);
  });

  it('also handles ImageContent shaped inputs (source.data)', () => {
    const oversized = 'a'.repeat(MAX_IMAGE_BASE64_SIZE + 1);
    expect(() =>
      validateImageSizes([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: oversized },
        },
      ])
    ).toThrow(/exceeds API limit/);
  });
});
