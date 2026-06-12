/**
 * SDKMessageHandler Tests
 *
 * Tests for processing incoming SDK messages.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  SDKMessageHandler,
  type SDKMessageHandlerContext,
} from '../../../../src/lib/agent/sdk-message-handler';
import type { Session, MessageHub } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';
import { setModelsCache } from '../../../../src/lib/model-service';

describe('SDKMessageHandler', () => {
  let handler: SDKMessageHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockMessageHub: MessageHub;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockStateManager: ProcessingStateManager;
  let mockContextTracker: ContextTracker;
  let mockMessageQueue: MessageQueue;
  let mockErrorManager: ErrorManager;
  let mockLifecycleManager: QueryLifecycleManager;
  let mockContext: SDKMessageHandlerContext;

  // Spy functions
  let saveSDKMessageSpy: ReturnType<typeof mock>;
  let updateSessionSpy: ReturnType<typeof mock>;
  let getMessagesByStatusSpy: ReturnType<typeof mock>;
  let getMessageByStatusAndUuidSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let publishSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let detectPhaseFromMessageSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let setCompactingSpy: ReturnType<typeof mock>;
  let getContextInfoSpy: ReturnType<typeof mock>;
  let updateWithDetailedBreakdownSpy: ReturnType<typeof mock>;
  let enqueueMessageSpy: ReturnType<typeof mock>;
  let handleErrorSpy: ReturnType<typeof mock>;
  let lifecycleStopSpy: ReturnType<typeof mock>;
  let messageQueueClearSpy: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSession = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/path',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'default',
        maxTokens: 8192,
        temperature: 1.0,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    };

    // Database spies
    saveSDKMessageSpy = mock(() => true);
    updateSessionSpy = mock(() => {});
    getMessagesByStatusSpy = mock(() => []);
    getMessageByStatusAndUuidSpy = mock(() => null);
    updateMessageStatusSpy = mock(() => {});
    mockDb = {
      saveSDKMessage: saveSDKMessageSpy,
      updateSession: updateSessionSpy,
      getMessagesByStatus: getMessagesByStatusSpy,
      getMessageByStatusAndUuid: getMessageByStatusAndUuidSpy,
      updateMessageStatus: updateMessageStatusSpy,
      updateMessageTimestamp: mock(() => {}),
      beginTransaction: mock(() => {}),
      commitTransaction: mock(() => {}),
      abortTransaction: mock(() => {}),
    } as unknown as Database;

    // MessageHub spies
    publishSpy = mock(async () => {});
    mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    // DaemonHub spies
    emitSpy = mock(async () => {});
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    // StateManager spies
    detectPhaseFromMessageSpy = mock(async () => {});
    setIdleSpy = mock(async () => {});
    setCompactingSpy = mock(async () => {});
    getStateSpy = mock(() => ({ phase: 'idle' }));
    mockStateManager = {
      detectPhaseFromMessage: detectPhaseFromMessageSpy,
      setIdle: setIdleSpy,
      setCompacting: setCompactingSpy,
      getState: getStateSpy,
    } as unknown as ProcessingStateManager;

    // ContextTracker spies
    getContextInfoSpy = mock(() => ({ totalTokens: 1000, maxTokens: 128000 }));
    updateWithDetailedBreakdownSpy = mock(() => {});
    mockContextTracker = {
      getContextInfo: getContextInfoSpy,
      updateWithDetailedBreakdown: updateWithDetailedBreakdownSpy,
      shouldCompact: mock(() => false),
      markCompactionTriggered: mock(() => {}),
    } as unknown as ContextTracker;

    // MessageQueue spies
    enqueueMessageSpy = mock(async () => 'context-id');
    messageQueueClearSpy = mock(() => {});
    mockMessageQueue = {
      enqueue: enqueueMessageSpy,
      enqueueWithId: mock(async () => {}),
      clear: messageQueueClearSpy,
    } as unknown as MessageQueue;

    // ErrorManager spy
    handleErrorSpy = mock(async () => {});
    mockErrorManager = {
      handleError: handleErrorSpy,
    } as unknown as ErrorManager;

    // LifecycleManager spy
    lifecycleStopSpy = mock(async () => {});
    mockLifecycleManager = {
      stop: lifecycleStopSpy,
    } as unknown as QueryLifecycleManager;

    // Create context
    mockContext = {
      session: mockSession,
      db: mockDb,
      messageHub: mockMessageHub,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      stateManager: mockStateManager,
      contextTracker: mockContextTracker,
      messageQueue: mockMessageQueue,
      errorManager: mockErrorManager,
      lifecycleManager: mockLifecycleManager,
      queryObject: null,
      queryPromise: null,
      onInitSlashCommands: async () => {},
    };

    handler = new SDKMessageHandler(mockContext);
  });

  describe('constructor', () => {
    it('should create handler with dependencies', () => {
      expect(handler).toBeDefined();
    });
  });

  describe('resetCircuitBreaker', () => {
    it('should reset the circuit breaker', () => {
      handler.resetCircuitBreaker();
      // Should not throw
      expect(handler).toBeDefined();
    });
  });

  describe('markApiSuccess', () => {
    it('should mark API success', () => {
      handler.markApiSuccess();
      // Should not throw
      expect(handler).toBeDefined();
    });
  });

  describe('handleMessage', () => {
    it('should detect phase from message', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(detectPhaseFromMessageSpy).toHaveBeenCalledWith(message);
    });

    it('should save message to database', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(saveSDKMessageSpy).toHaveBeenCalledWith('test-session-id', message);
    });

    it('should normalize missing usage on messages with BetaMessage (bridge provider crash guard)', async () => {
      // Bridge providers (Codex, Copilot) may produce messages without a
      // usage field on the nested BetaMessage. The Claude Agent SDK's
      // internal functions access message.usage.input_tokens without
      // null-checking, so we must ensure all persisted messages with a
      // BetaMessage have a usage object.
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;

      // message.message.usage should be undefined before handling
      expect(
        (message as unknown as { message: { usage?: unknown } }).message.usage
      ).toBeUndefined();

      await handler.handleMessage(message);

      // After handling, usage should be normalized with zeroed fields
      expect(
        (message as unknown as { message: { usage: Record<string, number> } }).message.usage
      ).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // The normalized message should be saved to DB
      expect(saveSDKMessageSpy).toHaveBeenCalledWith('test-session-id', message);
    });

    it('should not overwrite existing usage on messages with BetaMessage', async () => {
      // When usage is already present (e.g. direct Anthropic provider),
      // it should be left untouched.
      const originalUsage = {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
      };
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: {
          role: 'assistant',
          content: [],
          usage: originalUsage,
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(
        (message as unknown as { message: { usage: Record<string, number> } }).message.usage
      ).toBe(originalUsage);
    });

    it('should publish message delta', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(publishSpy).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: [message],
          timestamp: expect.any(Number),
          version: expect.any(Number),
        }),
        { channel: 'session:test-session-id' }
      );
    });

    it('should skip broadcasting if DB save fails', async () => {
      saveSDKMessageSpy.mockReturnValue(false);

      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('should mark user messages as synthetic', async () => {
      const message: SDKMessage = {
        type: 'user',
        uuid: 'test-uuid',
        message: { role: 'user', content: 'Hello' },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect((message as unknown as { isSynthetic: boolean }).isSynthetic).toBe(true);
    });

    it('should acknowledge persisted enqueued user messages without duplicate save', async () => {
      getMessagesByStatusSpy.mockImplementation(() => {
        throw new Error('bulk status scan should not be used for direct SDK replay ack');
      });
      getMessageByStatusAndUuidSpy.mockImplementation(
        (_sessionId: string, status: string, uuid: string) =>
          status === 'enqueued' && uuid === 'test-uuid'
            ? { dbId: 'db-msg-1', uuid: 'test-uuid' }
            : null
      );

      const message: SDKMessage = {
        type: 'user',
        uuid: 'test-uuid',
        message: { role: 'user', content: 'Hello' },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-msg-1'], 'consumed');
      // Bug fix: timestamp must be updated so message appears at correct position
      // after page refresh (not at original queue time)
      expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith('db-msg-1');
      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-msg-1'],
        status: 'consumed',
      });
      expect(publishSpy).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: [message],
          timestamp: expect.any(Number),
          version: expect.any(Number),
        }),
        { channel: 'session:test-session-id' }
      );
      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect((message as unknown as { isSynthetic?: boolean }).isSynthetic).toBeUndefined();
    });

    it('should emit tool-use consumed events for acknowledged persisted tool results', async () => {
      getMessageByStatusAndUuidSpy.mockImplementation(
        (_sessionId: string, status: string, uuid: string) =>
          status === 'enqueued' && uuid === 'tool-result-uuid'
            ? { dbId: 'db-msg-1', uuid: 'tool-result-uuid' }
            : null
      );

      const message: SDKMessage = {
        type: 'user',
        uuid: 'tool-result-uuid',
        session_id: 'test-session-id',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(
        'sdk.toolUse.consumed',
        expect.objectContaining({
          sessionId: 'test-session-id',
          toolUseId: 'tool-1',
        })
      );
    });

    it('should acknowledge persisted deferred user messages and update timestamp', async () => {
      getMessageByStatusAndUuidSpy.mockImplementation(
        (_sessionId: string, status: string, uuid: string) =>
          status === 'deferred' && uuid === 'deferred-uuid'
            ? { dbId: 'db-deferred-1', uuid: 'deferred-uuid' }
            : null
      );

      const message: SDKMessage = {
        type: 'user',
        uuid: 'deferred-uuid',
        message: { role: 'user', content: 'Saved message' },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-deferred-1'], 'consumed');
      expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith('db-deferred-1');
      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-deferred-1'],
        status: 'consumed',
      });
      expect(publishSpy).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: [message],
          timestamp: expect.any(Number),
          version: expect.any(Number),
        }),
        { channel: 'session:test-session-id' }
      );
      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
    });

    it('should suppress duplicate SDK replay for already-consumed persisted user message', async () => {
      getMessageByStatusAndUuidSpy.mockImplementation(
        (_sessionId: string, status: string, uuid: string) =>
          status === 'consumed' && uuid === 'consumed-user-uuid'
            ? { dbId: 'db-msg-1', uuid: 'consumed-user-uuid' }
            : null
      );
      const message: SDKMessage = {
        type: 'user',
        uuid: 'consumed-user-uuid',
        message: { role: 'user', content: 'Already shown' },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
      expect((message as unknown as { isSynthetic?: boolean }).isSynthetic).toBeUndefined();
    });
  });

  describe('handleSystemMessage', () => {
    it('should capture SDK session ID and sdkOriginPath', async () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        uuid: 'test-uuid',
        session_id: 'sdk-session-123',
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.sdkSessionId).toBe('sdk-session-123');
      // sdkOriginPath should be set to the session's workspacePath (no worktree in this session)
      expect(mockSession.sdkOriginPath).toBe('/test/path');
      expect(updateSessionSpy).toHaveBeenCalledWith('test-session-id', {
        sdkSessionId: 'sdk-session-123',
        sdkOriginPath: '/test/path',
      });
      expect(emitSpy).toHaveBeenCalledWith('session.updated', {
        sessionId: 'test-session-id',
        source: 'sdk-session',
        session: { sdkSessionId: 'sdk-session-123', sdkOriginPath: '/test/path' },
      });
    });

    it('should not update if SDK session ID already set', async () => {
      mockSession.sdkSessionId = 'existing-session-id';

      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        uuid: 'test-uuid',
        session_id: 'new-session-123',
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.sdkSessionId).toBe('existing-session-id');
    });

    it('should not set sdkSessionId from api_retry message', async () => {
      // api_retry has session_id but should not overwrite sdkSessionId
      // — only system/init messages are the authoritative source
      const message: SDKMessage = {
        type: 'system',
        subtype: 'api_retry',
        uuid: 'retry-uuid',
        session_id: 'retry-session-id',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 1000,
        error_status: 429,
        error: 'rate_limit',
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.sdkSessionId).toBeUndefined();
      // api_retry is suppressed before DB/broadcast — should not appear in transcript
      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleResultMessage', () => {
    it('should update session metadata with token usage', async () => {
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'test-uuid',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.metadata?.inputTokens).toBe(100);
      expect(mockSession.metadata?.outputTokens).toBe(50);
      expect(mockSession.metadata?.totalTokens).toBe(150);
      expect(updateSessionSpy).toHaveBeenCalled();
    });

    it('should emit session.updated event', async () => {
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'test-uuid',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(emitSpy).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId: 'test-session-id',
          source: 'metadata',
        })
      );
    });

    it('should never inject a /context slash command into the queue', async () => {
      // We replaced the legacy slash-command-based approach with native
      // `query.getContextUsage()`, so the handler must not enqueue any
      // '/context' messages on turn end.
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'test-uuid',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockMessageQueue.enqueueWithId).not.toHaveBeenCalled();
      const enqueueCalls = (enqueueMessageSpy as ReturnType<typeof mock>).mock.calls;
      for (const call of enqueueCalls) {
        expect(call[0]).not.toBe('/context');
      }
    });

    it('should fallback-ack oldest enqueued user on turn end when replay is absent', async () => {
      getMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return [
            {
              dbId: 'db-msg-1',
              uuid: 'enqueued-user-uuid',
              type: 'user',
              timestamp: 1700000000000,
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'tool-fallback', content: 'ok' }],
              },
            },
          ];
        }
        return [];
      });

      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-msg-1'], 'consumed');
      // Fallback-ack preserves original timestamp (T1) instead of updating
      // to turn-end time — the message was already positioned at yield time
      // by handleMessageYielded, or if that didn't fire, T1 is a better
      // approximation than T_end.
      expect(mockDb.updateMessageTimestamp).not.toHaveBeenCalledWith('db-msg-1');
      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-msg-1'],
        status: 'consumed',
      });
      expect(publishSpy).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: expect.arrayContaining([
            expect.objectContaining({
              type: 'user',
              uuid: 'enqueued-user-uuid',
            }),
          ]),
          timestamp: expect.any(Number),
          version: expect.any(Number),
        }),
        { channel: 'session:test-session-id' }
      );
      expect(emitSpy).toHaveBeenCalledWith(
        'sdk.toolUse.consumed',
        expect.objectContaining({
          sessionId: 'test-session-id',
          toolUseId: 'tool-fallback',
        })
      );
    });

    it('should handle result message with missing usage (bridge provider edge case)', async () => {
      // SDK 0.2.84+ may produce result messages without usage when using bridge
      // providers like anthropic-copilot. The handler must not crash.
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'no-usage-uuid',
        // Deliberately omit `usage` to simulate the bridge provider edge case
        total_cost_usd: 0,
        modelUsage: {},
      } as unknown as SDKMessage;

      // Should not throw
      await handler.handleMessage(message);

      // Metadata should still be updated (with zero tokens)
      expect(updateSessionSpy).toHaveBeenCalled();
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should set state to idle', async () => {
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'test-uuid',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should emit session.errorClear event', async () => {
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'test-uuid',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(emitSpy).toHaveBeenCalledWith('session.errorClear', {
        sessionId: 'test-session-id',
      });
    });

    it('should detect SDK cost reset and update baseline', async () => {
      // First result - SDK reports 1.0
      mockSession.metadata = {
        ...mockSession.metadata,
        lastSdkCost: 1.0,
        costBaseline: 0,
        totalCost: 1.0,
      };

      // SDK reset - now reports 0.5 (less than last 1.0)
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'test-uuid',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.5, // Less than lastSdkCost (1.0)
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      // New baseline should be old baseline (0) + old lastSdkCost (1.0) = 1.0
      // Total cost should be new baseline (1.0) + current SDK cost (0.5) = 1.5
      expect(mockSession.metadata?.costBaseline).toBe(1.0);
      expect(mockSession.metadata?.totalCost).toBe(1.5);
      expect(mockSession.metadata?.lastSdkCost).toBe(0.5);
    });
  });

  describe('handleUserMessage', () => {
    it('should emit production tool-use consumed event for tool_result messages', async () => {
      const message: SDKMessage = {
        type: 'user',
        uuid: 'test-uuid',
        session_id: 'test-session-id',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(emitSpy).toHaveBeenCalledWith(
        'sdk.toolUse.consumed',
        expect.objectContaining({
          sessionId: 'test-session-id',
          toolUseId: 'tool-1',
        })
      );
    });
  });

  describe('handleAssistantMessage', () => {
    it('should update tool call count', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
            { type: 'tool_use', id: 'tool-2', name: 'Write', input: {} },
          ],
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.metadata?.toolCallCount).toBe(2);
    });

    it('should emit production tool-use event for runtime recovery guards', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(emitSpy).toHaveBeenCalledWith(
        'sdk.toolUse.created',
        expect.objectContaining({
          sessionId: 'test-session-id',
          toolUseId: 'tool-1',
          toolName: 'Read',
        })
      );
    });

    it('should emit session.updated event for tool calls', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(emitSpy).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId: 'test-session-id',
          source: 'metadata',
        })
      );
    });

    it('should not update if no tool calls', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      } as unknown as SDKMessage;

      const initialToolCount = mockSession.metadata?.toolCallCount || 0;

      await handler.handleMessage(message);

      expect(mockSession.metadata?.toolCallCount).toBe(initialToolCount);
    });
  });

  describe('handleStatusMessage', () => {
    it('should set compacting state when status is compacting', async () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'status',
        uuid: 'test-uuid',
        status: 'compacting',
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(setCompactingSpy).toHaveBeenCalledWith(true);
    });

    it('should not set compacting for other statuses', async () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'status',
        uuid: 'test-uuid',
        status: 'thinking',
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      // setCompacting should not be called for 'thinking' status
      expect(setCompactingSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleCompactBoundary', () => {
    it('should clear compacting state', async () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'test-uuid',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 50000,
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(setCompactingSpy).toHaveBeenCalledWith(false);
    });

    it('should refresh context usage via SDK after compact boundary', async () => {
      const getContextUsageSpy = mock(async () => ({
        categories: [],
        totalTokens: 50000,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 25,
        gridRows: [],
        model: 'claude-sonnet-4-6',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: false,
        apiUsage: null,
      }));
      mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;

      const freshHandler = new SDKMessageHandler(mockContext);

      const message: SDKMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'test-uuid',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 50000,
        },
      } as unknown as SDKMessage;

      await freshHandler.handleMessage(message);

      // Give the fire-and-forget refreshContextUsage a tick to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(setCompactingSpy).toHaveBeenCalledWith(false);
      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(updateWithDetailedBreakdownSpy).toHaveBeenCalled();
      // No /context slash command is injected anywhere
      expect(mockMessageQueue.enqueueWithId).not.toHaveBeenCalled();
    });
  });

  describe('circuit breaker integration', () => {
    it('should handle circuit breaker trip with active query', async () => {
      // Set up context with active query
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      // Create handler fresh with the context that has query
      const handlerWithQuery = new SDKMessageHandler(mockContext);

      // Send many error messages to trip the circuit breaker
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      // Trip the circuit breaker by sending multiple error messages
      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-${i}`,
        } as SDKMessage);
      }

      // Give async callback time to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify circuit breaker tripped and stopped the query
      expect(lifecycleStopSpy).toHaveBeenCalledWith({ catchQueryErrors: true });
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should handle circuit breaker trip without active query', async () => {
      // No query object or promise
      mockContext.queryObject = null;
      mockContext.queryPromise = null;

      // Create handler fresh
      const handlerNoQuery = new SDKMessageHandler(mockContext);

      // Trip the circuit breaker
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      for (let i = 0; i < 4; i++) {
        await handlerNoQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should NOT call stop if no query running
      expect(lifecycleStopSpy).not.toHaveBeenCalled();
      // But should still reset to idle
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should display error as assistant message when circuit breaker trips', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

      // Trip the circuit breaker
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify an assistant message was deferred
      const saveCalls = saveSDKMessageSpy.mock.calls;
      const assistantSaves = saveCalls.filter(
        (call: unknown[]) => (call[1] as SDKMessage).type === 'assistant'
      );
      expect(assistantSaves.length).toBeGreaterThan(0);
    });

    it('should report error to error manager on trip', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

      // Trip the circuit breaker
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify error manager was called
      expect(handleErrorSpy).toHaveBeenCalled();
    });

    it('should clear message queue when circuit breaker trips', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

      // Trip the circuit breaker
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify message queue was cleared
      expect(messageQueueClearSpy).toHaveBeenCalled();
    });

    it('should emit session.errorClear when circuit breaker trips', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

      // Trip the circuit breaker
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify session.errorClear was emitted
      expect(emitSpy).toHaveBeenCalledWith('session.errorClear', {
        sessionId: 'test-session-id',
      });
    });
  });

  describe('context refresh via SDK getContextUsage()', () => {
    // Shared helper: canned SDK response
    function makeSdkContextResponse() {
      return {
        categories: [
          { name: 'System prompt', tokens: 3600, color: 'gray' },
          { name: 'Messages', tokens: 2000, color: 'blue' },
        ],
        totalTokens: 5600,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 2.8,
        gridRows: [],
        model: 'claude-sonnet-4-6',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: false,
        apiUsage: null,
      };
    }

    it('refreshes context at turn end for any result message (success)', async () => {
      const getContextUsageSpy = mock(async () => makeSdkContextResponse());
      mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
      const h = new SDKMessageHandler(mockContext);

      const resultMessage: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await h.handleMessage(resultMessage);
      // fire-and-forget → wait one tick
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(updateWithDetailedBreakdownSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(
        'context.updated',
        expect.objectContaining({
          sessionId: 'test-session-id',
          contextInfo: expect.any(Object),
        })
      );
    });

    it('refreshes context at turn end for error result messages too', async () => {
      const getContextUsageSpy = mock(async () => makeSdkContextResponse());
      mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
      const h = new SDKMessageHandler(mockContext);

      // Error-subtype result — the turn is still over, context should refresh.
      const errorResult: SDKMessage = {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'err-result-uuid',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0,
        modelUsage: {},
        is_error: true,
      } as unknown as SDKMessage;

      await h.handleMessage(errorResult);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(updateWithDetailedBreakdownSpy).toHaveBeenCalled();
    });

    it('refreshes context every 5 stream events', async () => {
      const getContextUsageSpy = mock(async () => makeSdkContextResponse());
      mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
      const h = new SDKMessageHandler(mockContext);

      // Send 4 non-result assistant messages — should NOT refresh yet
      for (let i = 0; i < 4; i++) {
        const assistant: SDKMessage = {
          type: 'assistant',
          uuid: `a-${i}`,
          message: { role: 'assistant', content: [] },
        } as unknown as SDKMessage;
        await h.handleMessage(assistant);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getContextUsageSpy).not.toHaveBeenCalled();

      // 5th event triggers refresh
      const assistant5: SDKMessage = {
        type: 'assistant',
        uuid: 'a-5',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;
      await h.handleMessage(assistant5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);

      // Counter resets — another 4 events should NOT trigger
      for (let i = 0; i < 4; i++) {
        const a: SDKMessage = {
          type: 'assistant',
          uuid: `b-${i}`,
          message: { role: 'assistant', content: [] },
        } as unknown as SDKMessage;
        await h.handleMessage(a);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
    });

    it('refreshes context after compact_boundary', async () => {
      const getContextUsageSpy = mock(async () => makeSdkContextResponse());
      mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
      const h = new SDKMessageHandler(mockContext);

      const compactMessage: SDKMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-uuid',
        compact_metadata: { trigger: 'auto', pre_tokens: 150000 },
      } as unknown as SDKMessage;

      await h.handleMessage(compactMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(updateWithDetailedBreakdownSpy).toHaveBeenCalled();
    });

    it('does not fetch when queryObject is null', async () => {
      mockContext.queryObject = null;
      const h = new SDKMessageHandler(mockContext);

      const resultMessage: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await h.handleMessage(resultMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(updateWithDetailedBreakdownSpy).not.toHaveBeenCalled();
    });

    it('swallows SDK errors and does not crash message handling', async () => {
      const getContextUsageSpy = mock(async () => {
        throw new Error('SDK exploded');
      });
      mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
      const h = new SDKMessageHandler(mockContext);

      const resultMessage: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      // Must not throw
      await h.handleMessage(resultMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(updateWithDetailedBreakdownSpy).not.toHaveBeenCalled();
    });

    describe('NeoKai-level compaction trigger', () => {
      afterEach(() => {
        setModelsCache(new Map());
      });

      it('does not enqueue /compact when non-native provider exceeds 85% threshold', async () => {
        setModelsCache(
          new Map([
            [
              'global',
              [
                {
                  id: 'deepseek-v4',
                  name: 'DeepSeek V4',
                  provider: 'openrouter',
                  contextWindow: 1_000_000,
                  available: true,
                },
              ],
            ],
          ])
        );

        const getContextUsageSpy = mock(async () => ({
          categories: [{ name: 'Messages', tokens: 860_000 }],
          totalTokens: 860_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 86,
          gridRows: [],
          model: 'deepseek-v4',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        }));

        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
        mockContext.session.config.provider = 'openrouter';
        mockContext.session.config.model = 'deepseek-v4';
        mockContextTracker.shouldCompact = mock(() => true);

        const h = new SDKMessageHandler(mockContext);

        const resultMessage: SDKMessage = {
          type: 'result',
          subtype: 'success',
          uuid: 'result-uuid',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        } as unknown as SDKMessage;

        await h.handleMessage(resultMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(mockContextTracker.shouldCompact).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalledWith('/compact', true);
      });

      it('does not enqueue /compact for providers with native auto-compaction', async () => {
        setModelsCache(
          new Map([
            [
              'global',
              [
                {
                  id: 'sonnet',
                  name: 'Claude Sonnet',
                  provider: 'anthropic',
                  contextWindow: 200_000,
                  available: true,
                },
              ],
            ],
          ])
        );

        const getContextUsageSpy = mock(async () => ({
          categories: [{ name: 'Messages', tokens: 180_000 }],
          totalTokens: 180_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 90,
          gridRows: [],
          model: 'claude-sonnet-4-6',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        }));

        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
        mockContext.session.config.provider = 'kimi';
        mockContext.session.config.model = 'kimi-for-coding';

        const h = new SDKMessageHandler(mockContext);

        const resultMessage: SDKMessage = {
          type: 'result',
          subtype: 'success',
          uuid: 'result-uuid',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        } as unknown as SDKMessage;

        await h.handleMessage(resultMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('does not enqueue /compact when model info is missing', async () => {
        const getContextUsageSpy = mock(async () => ({
          categories: [{ name: 'Messages', tokens: 860_000 }],
          totalTokens: 860_000,
          maxTokens: Number.MAX_SAFE_INTEGER,
          rawMaxTokens: Number.MAX_SAFE_INTEGER,
          percentage: 0,
          gridRows: [],
          model: 'unknown',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: null,
        }));

        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
        mockContext.session.config.provider = 'openrouter';
        mockContext.session.config.model = 'unknown-model';

        const h = new SDKMessageHandler(mockContext);

        const resultMessage: SDKMessage = {
          type: 'result',
          subtype: 'success',
          uuid: 'result-uuid',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        } as unknown as SDKMessage;

        await h.handleMessage(resultMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });
    });

    it('never injects /context into the message queue', async () => {
      const getContextUsageSpy = mock(async () => makeSdkContextResponse());
      mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
      const h = new SDKMessageHandler(mockContext);

      // Run one complete turn: 5 events + result + compact
      for (let i = 0; i < 6; i++) {
        await h.handleMessage({
          type: 'assistant',
          uuid: `a-${i}`,
          message: { role: 'assistant', content: [] },
        } as unknown as SDKMessage);
      }
      await h.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);
      await h.handleMessage({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-uuid',
        compact_metadata: { trigger: 'auto', pre_tokens: 150000 },
      } as unknown as SDKMessage);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockMessageQueue.enqueueWithId).not.toHaveBeenCalled();
      const enqueueCalls = (enqueueMessageSpy as ReturnType<typeof mock>).mock.calls;
      for (const call of enqueueCalls) {
        expect(call[0]).not.toBe('/context');
      }
    });
  });

  describe('markApiSuccess', () => {
    it('should not throw when called', () => {
      expect(() => handler.markApiSuccess()).not.toThrow();
    });

    it('should reset circuit breaker error tracking', async () => {
      // First, trigger some errors but not enough to trip
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      // Send 2 errors (not enough to trip with threshold of 3)
      await handler.handleMessage(errorMessage);
      await handler.handleMessage({ ...errorMessage, uuid: 'error-uuid-2' } as SDKMessage);

      // Mark success to reset error tracking
      handler.markApiSuccess();

      // Send one more error - should NOT trip since errors were reset
      await handler.handleMessage({ ...errorMessage, uuid: 'error-uuid-3' } as SDKMessage);

      // Should NOT have tripped (no stop called)
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lifecycleStopSpy).not.toHaveBeenCalled();
    });
  });

  describe('resetCircuitBreaker', () => {
    it('should not throw when called', () => {
      expect(() => handler.resetCircuitBreaker()).not.toThrow();
    });

    it('should fully reset circuit breaker state', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

      // Trip the circuit breaker
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify it was tripped
      expect(lifecycleStopSpy).toHaveBeenCalled();

      // Reset all mocks
      lifecycleStopSpy.mockClear();

      // Reset the circuit breaker
      handlerWithQuery.resetCircuitBreaker();

      // Try to trip again - should work after reset
      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-new-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have tripped again
      expect(lifecycleStopSpy).toHaveBeenCalled();
    });
  });
});
