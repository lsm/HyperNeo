import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, ModelInfo, Session } from '@hyperneo/shared';
import type { Provider, ProviderSdkConfig } from '@hyperneo/shared/provider';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import { waitForDeliveryConsumption } from '../../../../src/lib/agent/message-delivery';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';
import { markBuiltFallbackIdentity } from '../../../../src/lib/agent/query-options-builder';
import {
  SDKMessageHandler,
  type SDKMessageHandlerContext,
} from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import { getProviderCatalogEpoch, setModelsCache } from '../../../../src/lib/model-service';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { Database } from '../../../../src/storage/database';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';

class TranslatingMockProvider implements Provider {
  readonly id = 'anthropic-codex';
  readonly displayName = 'Anthropic Codex';
  readonly capabilities = {
    streaming: true,
    extendedThinking: false,
    maxContextWindow: 100000,
    functionCalling: true,
    vision: false,
  };

  isAvailable(): boolean {
    return true;
  }

  async getModels(): Promise<ModelInfo[]> {
    return [];
  }

  ownsModel(modelId: string): boolean {
    return modelId.startsWith('gpt-') || modelId.startsWith('claude-');
  }

  getModelForTier(tier: string): string {
    return `gpt-${tier}`;
  }

  buildSdkConfig(): ProviderSdkConfig {
    return { envVars: {}, isAnthropicCompatible: true };
  }

  translateModelIdForSdk(modelId: string): string {
    return modelId === 'gpt-5.4-mini' ? 'claude-sonnet-4-20250514' : modelId;
  }
}

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

  let saveSDKMessageSpy: ReturnType<typeof mock>;
  let updateSessionSpy: ReturnType<typeof mock>;
  let getUserMessagesByStatusSpy: ReturnType<typeof mock>;
  let getMessageByStatusAndUuidSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let publishSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let detectPhaseFromMessageSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let beginTerminalIdleSpy: ReturnType<typeof mock>;
  let cancelTerminalIdleArmSpy: ReturnType<typeof mock>;
  let setCompactingSpy: ReturnType<typeof mock>;
  let getIsCompactingSpy: ReturnType<typeof mock>;
  let getContextInfoSpy: ReturnType<typeof mock>;
  let updateWithDetailedBreakdownSpy: ReturnType<typeof mock>;
  let isCoolingDownSpy: ReturnType<typeof mock>;
  let markCompactionTriggeredSpy: ReturnType<typeof mock>;
  let clearCompactionCooldownSpy: ReturnType<typeof mock>;
  let enqueueMessageSpy: ReturnType<typeof mock>;
  let handleErrorSpy: ReturnType<typeof mock>;
  let lifecycleStopSpy: ReturnType<typeof mock>;
  let messageQueueClearSpy: ReturnType<typeof mock>;
  let hasPendingOrClaimedSpy: ReturnType<typeof mock>;
  let hasYieldedSpy: ReturnType<typeof mock>;
  let acknowledgeYieldedSpy: ReturnType<typeof mock>;
  let setDeliveryGateSpy: ReturnType<typeof mock>;
  let hasQueuedMessagesSpy: ReturnType<typeof mock>;
  let hasOutstandingInternalCompactionSpy: ReturnType<typeof mock>;
  let hasCompactionsAwaitingBoundarySpy: ReturnType<typeof mock>;
  let pruneSentPromptsSpy: ReturnType<typeof mock>;
  let acknowledgeCompactionsAwaitingBoundarySpy: ReturnType<typeof mock>;
  let clearNonCompactionSentSinceBoundarySpy: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof mock>;
  let bumpDeliveryTurnActivitySpy: ReturnType<typeof mock>;

  beforeEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
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

    saveSDKMessageSpy = mock(() => true);
    updateSessionSpy = mock(() => {});
    getUserMessagesByStatusSpy = mock(() => ({ messages: [], total: 0 }));
    getMessageByStatusAndUuidSpy = mock(() => null);
    updateMessageStatusSpy = mock(() => {});
    mockDb = {
      saveSDKMessage: saveSDKMessageSpy,
      updateSession: updateSessionSpy,
      getUserMessagesByStatus: getUserMessagesByStatusSpy,
      getMessageByStatusAndUuid: getMessageByStatusAndUuidSpy,
      updateMessageStatus: updateMessageStatusSpy,
      updateMessageTimestamp: mock(() => {}),
      beginTransaction: mock(() => {}),
      commitTransaction: mock(() => {}),
      abortTransaction: mock(() => {}),
    } as unknown as Database;

    publishSpy = mock(async () => {});
    mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    emitSpy = mock(async () => {});
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    detectPhaseFromMessageSpy = mock(async () => {});
    setIdleSpy = mock(async () => {});
    beginTerminalIdleSpy = mock(() => {});
    setCompactingSpy = mock(async () => {});
    getIsCompactingSpy = mock(() => false);
    getStateSpy = mock(() => ({ phase: 'idle' }));
    cancelTerminalIdleArmSpy = mock(() => {});
    mockStateManager = {
      detectPhaseFromMessage: detectPhaseFromMessageSpy,
      setIdle: setIdleSpy,
      beginTerminalIdle: beginTerminalIdleSpy,
      cancelTerminalIdleArm: cancelTerminalIdleArmSpy,
      idleOwnerForQuery: mock((queryGeneration: number) => ({ queryGeneration, turnToken: 0 })),
      setCompacting: setCompactingSpy,
      getIsCompacting: getIsCompactingSpy,
      getState: getStateSpy,
    } as unknown as ProcessingStateManager;

    getContextInfoSpy = mock(() => ({ totalTokens: 1000, maxTokens: 128000 }));
    updateWithDetailedBreakdownSpy = mock(() => {});
    isCoolingDownSpy = mock(() => false);
    markCompactionTriggeredSpy = mock(() => {});
    clearCompactionCooldownSpy = mock(() => {});
    mockContextTracker = {
      getContextInfo: getContextInfoSpy,
      updateWithDetailedBreakdown: updateWithDetailedBreakdownSpy,
      shouldCompact: mock(() => false),
      shouldCompactAt: mock(() => false),
      isCoolingDown: isCoolingDownSpy,
      markCompactionTriggered: markCompactionTriggeredSpy,
      clearCompactionCooldown: clearCompactionCooldownSpy,
    } as unknown as ContextTracker;

    enqueueMessageSpy = mock(async () => 'context-id');
    messageQueueClearSpy = mock(() => {});
    hasPendingOrClaimedSpy = mock(() => false);
    hasYieldedSpy = mock(() => false);
    acknowledgeYieldedSpy = mock(() => false);
    setDeliveryGateSpy = mock(() => {});
    hasQueuedMessagesSpy = mock(() => false);
    hasOutstandingInternalCompactionSpy = mock(() => false);
    hasCompactionsAwaitingBoundarySpy = mock(() => false);
    pruneSentPromptsSpy = mock(() => {});
    acknowledgeCompactionsAwaitingBoundarySpy = mock(() => {});
    clearNonCompactionSentSinceBoundarySpy = mock(() => {});
    mockMessageQueue = {
      enqueue: enqueueMessageSpy,
      enqueueWithId: mock(async () => {}),
      clear: messageQueueClearSpy,
      hasPendingOrClaimed: hasPendingOrClaimedSpy,
      hasYielded: hasYieldedSpy,
      acknowledgeYielded: acknowledgeYieldedSpy,
      setDeliveryGate: setDeliveryGateSpy,
      hasQueuedMessages: hasQueuedMessagesSpy,
      hasOutstandingInternalCompaction: hasOutstandingInternalCompactionSpy,
      hasQueuedInternalCompaction: mock(() => false),
      hasInFlightInternalCompaction: mock(() => false),
      hasCompactionsAwaitingBoundary: hasCompactionsAwaitingBoundarySpy,
      hasOutstandingNonCompactionMessages: mock(() => false),
      isRunning: mock(() => true),
      pruneSentPrompts: pruneSentPromptsSpy,
      acknowledgeCompactionsAwaitingBoundary: acknowledgeCompactionsAwaitingBoundarySpy,
      clearNonCompactionSentSinceBoundary: clearNonCompactionSentSinceBoundarySpy,
      forgetSentPrompt: mock(() => {}),
      getSentPromptContent: mock(() => undefined),
    } as unknown as MessageQueue;

    handleErrorSpy = mock(async () => {});
    mockErrorManager = {
      handleError: handleErrorSpy,
    } as unknown as ErrorManager;

    lifecycleStopSpy = mock(async () => {});
    mockLifecycleManager = {
      stop: lifecycleStopSpy,
    } as unknown as QueryLifecycleManager;

    bumpDeliveryTurnActivitySpy = mock(() => {});

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
      onInitSlashCommands: mock(async () => {}),
      onCommandsChanged: mock(async () => {}),
      bumpDeliveryTurnActivity: bumpDeliveryTurnActivitySpy,
      onDeliveryTurnAccepted: mock(() => {}),
    };

    handler = new SDKMessageHandler(mockContext);
  });

  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
  });

  describe('constructor', () => {
    it('should create handler with dependencies', () => {
      expect(handler).toBeDefined();
    });
  });

  describe('resetCircuitBreaker', () => {
    it('should reset the circuit breaker', () => {
      handler.resetCircuitBreaker();
      expect(handler).toBeDefined();
    });
  });

  describe('markApiSuccess', () => {
    it('should mark API success', () => {
      handler.markApiSuccess();
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

    describe('stream_event liveness heartbeat', () => {
      const makeStreamEvent = (): SDKMessage =>
        ({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tok' } },
          parent_tool_use_id: null,
          uuid: 'stream-uuid',
          session_id: 'test-session-id',
        }) as unknown as SDKMessage;

      it('bumps the delivery-turn stall watchdog (liveness) on every token delta', async () => {
        bumpDeliveryTurnActivitySpy.mockClear();
        const delta = makeStreamEvent();

        await handler.handleMessage(delta);

        expect(bumpDeliveryTurnActivitySpy).toHaveBeenCalledTimes(1);
      });

      it('never persists or broadcasts partial tokens (avoids DB bloat)', async () => {
        const delta = makeStreamEvent();

        await handler.handleMessage(delta);

        expect(saveSDKMessageSpy).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
      });

      it('still updates the streaming phase for a partial token', async () => {
        const delta = makeStreamEvent();

        await handler.handleMessage(delta);

        expect(detectPhaseFromMessageSpy).toHaveBeenCalledWith(delta);
      });

      it('a stream_event heartbeating past the no-activity window keeps the watchdog alive', async () => {
        bumpDeliveryTurnActivitySpy.mockClear();
        for (let i = 0; i < 5; i++) {
          await handler.handleMessage(makeStreamEvent());
        }
        expect(bumpDeliveryTurnActivitySpy).toHaveBeenCalledTimes(5);
        expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      });
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

    it('never persists or broadcasts internal CLI lifecycle/state messages', async () => {
      const internalMessages: SDKMessage[] = [
        {
          type: 'command_lifecycle',
          command_uuid: 'cmd-1',
          state: 'queued',
          uuid: 'm-1',
          session_id: 'test-session-id',
        },
        {
          type: 'conversation_reset',
          new_conversation_id: 'conv-2',
          uuid: 'm-2',
          session_id: 'test-session-id',
        },
        {
          type: 'active_goal',
          value: null,
          uuid: 'm-3',
          session_id: 'test-session-id',
        },
        {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [],
          uuid: 'm-4',
          session_id: 'test-session-id',
        },
        {
          type: 'system',
          subtype: 'control_request_progress',
          request_id: 'req-1',
          status: 'started',
          uuid: 'm-5',
          session_id: 'test-session-id',
        },
      ] as unknown as SDKMessage[];

      for (const message of internalMessages) {
        await handler.handleMessage(message);
      }

      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('should normalize missing usage on messages with BetaMessage (bridge provider crash guard)', async () => {
      const message: SDKMessage = {
        type: 'assistant',
        uuid: 'test-uuid',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;

      expect(
        (message as unknown as { message: { usage?: unknown } }).message.usage
      ).toBeUndefined();

      await handler.handleMessage(message);

      expect(
        (message as unknown as { message: { usage: Record<string, number> } }).message.usage
      ).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      expect(saveSDKMessageSpy).toHaveBeenCalledWith('test-session-id', message);
    });

    it('should not overwrite existing usage on messages with BetaMessage', async () => {
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
      getUserMessagesByStatusSpy.mockImplementation(() => {
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
        session_id: 'sdk-conversation-id',
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

    it('rotates sdkSessionId when an init reports a different id (e.g. after /clear)', async () => {
      mockSession.sdkSessionId = 'existing-session-id';

      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        uuid: 'test-uuid',
        session_id: 'new-session-123',
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.sdkSessionId).toBe('new-session-123');
      expect(updateSessionSpy).toHaveBeenCalledWith('test-session-id', {
        sdkSessionId: 'new-session-123',
        sdkOriginPath: '/test/path',
      });
    });

    it('does not re-update when an init reports the same id (idempotent)', async () => {
      mockSession.sdkSessionId = 'same-session-id';

      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        uuid: 'test-uuid',
        session_id: 'same-session-id',
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.sdkSessionId).toBe('same-session-id');
      expect(updateSessionSpy).not.toHaveBeenCalledWith('test-session-id', expect.anything());
    });

    it('strips terminal-bound commands from the init slash command list', async () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        uuid: 'test-uuid',
        session_id: 'sdk-session-123',
        slash_commands: ['help', 'exit', 'compact', 'statusline'],
        terminal_slash_commands: ['exit', 'statusline'],
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockContext.onInitSlashCommands).toHaveBeenCalledWith(['help', 'compact']);
    });

    it('passes the full command list through when no terminal commands are tagged', async () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        uuid: 'test-uuid',
        session_id: 'sdk-session-123',
        slash_commands: ['help', 'compact'],
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockContext.onInitSlashCommands).toHaveBeenCalledWith(['help', 'compact']);
    });

    it('suppresses setIdle for the result of an in-stream /clear (resetContextPerTurn)', async () => {
      const result = (uuid: string): SDKMessage =>
        ({
          type: 'result',
          subtype: 'success',
          uuid,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        }) as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      setIdleSpy.mockClear();

      await handler.handleMessage(result('clear-result'));
      expect(setIdleSpy).not.toHaveBeenCalled();

      await handler.handleMessage(result('handoff-result'));
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('waitForSuppressedResult resolves on the first top-level result after arming', async () => {
      const result = (uuid: string, parentToolUseId?: string): SDKMessage =>
        ({
          type: 'result',
          subtype: 'success',
          uuid,
          parent_tool_use_id: parentToolUseId ?? null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        }) as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      let settled: string | null = null;
      void wait.then((confirmed) => {
        settled = confirmed;
      });

      await handler.handleMessage({
        type: 'status',
        uuid: 'status-uuid',
        session_id: 'sdk-session-123',
      } as unknown as SDKMessage);
      await handler.handleMessage(result('nested-result', 'toolu-1'));
      expect(settled).toBe(null);

      await handler.handleMessage(result('clear-result'));
      expect(await wait).toBe('confirmed');
      expect(settled).toBe('confirmed');
    });

    it('waitForSuppressedResult resolves false on timeout', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(15);

      expect(await wait).toBe('reset');
    });

    it('on session_state_changed SDKs the clear wait settles on the trailing idle, not the result', async () => {
      const sessionState = (state: 'busy' | 'idle'): SDKMessage =>
        ({
          type: 'system',
          subtype: 'session_state_changed',
          state,
          uuid: `state-${state}`,
          session_id: 'sdk-session-123',
        }) as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      let settled: string | null = null;
      void wait.then((confirmed) => {
        settled = confirmed;
      });

      await handler.handleMessage(sessionState('busy'));
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        user_message_uuid: 'clear-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);
      expect(settled).toBe(null);
      expect(setIdleSpy).not.toHaveBeenCalled();

      await handler.handleMessage(sessionState('idle'));

      expect(await wait).toBe('confirmed');
      expect(settled).toBe('confirmed');
      expect(setIdleSpy).toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
        suppressIdlePublish: true,
        suppressIdleCallback: true,
      });
      expect(emitSpy.mock.calls.filter((call) => call[0] === 'query.trigger')).toHaveLength(0);

      setIdleSpy.mockClear();
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'next-turn-result',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('a result for another turn (e.g. /compact) does not confirm the correlated clear wait', async () => {
      const result = (uuid: string, userMessageUuid?: string): SDKMessage =>
        ({
          type: 'result',
          subtype: 'success',
          uuid,
          user_message_uuid: userMessageUuid,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        }) as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      let settled: string | null = null;
      void wait.then((confirmed) => {
        settled = confirmed;
      });

      await handler.handleMessage(result('compact-result', 'compact-msg-id'));
      expect(settled).toBe(null);

      await handler.handleMessage(result('clear-result', 'clear-msg-id'));
      expect(await wait).toBe('confirmed');
    });

    it('a result omitting user_message_uuid never confirms the correlated clear wait', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(20, 'clear-msg-id');

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'uuidless-result',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(await wait).toBe('reset');
    });

    it('an error result resolves the wait unconfirmed and releases idle suppression', async () => {
      const errorResult: SDKMessage = {
        type: 'result',
        subtype: 'error_max_turns',
        uuid: 'clear-error',
        is_error: true,
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

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      setIdleSpy.mockClear();

      await handler.handleMessage(errorResult);

      expect(await wait).toBe('reset');
      expect(setIdleSpy).not.toHaveBeenCalled();
    });

    it('clearIdleSuppression settles a pending wait as unconfirmed', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);

      handler.clearIdleSuppression();

      expect(await wait).toBe('reset');
    });

    it('a uuid-less error result releases a correlated clear wait promptly', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      setIdleSpy.mockClear();

      await handler.handleMessage({
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'clear-error',
        is_error: true,
        errors: ['boom'],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(await wait).toBe('reset');
      expect(setIdleSpy).not.toHaveBeenCalled();
    });

    it('a pre-send error from an earlier turn does not attribute to the queued clear', async () => {
      const errorMessage = {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'compact-error',
        is_error: true,
        errors: ['compact boom'],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      let settled: string | null = null;
      void handler.waitForSuppressedResult(5_000, 'clear-msg-id').then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(errorMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(null);

      handler.markClearMessageSent();
      await handler.handleMessage({ ...errorMessage, uuid: 'clear-error' } as SDKMessage);

      expect(settled).toBe('reset');

      const successResult = {
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        user_message_uuid: 'clear-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;
      handler.suppressIdleForNextResult();
      const confirmedWait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      await handler.handleMessage(successResult);
      expect(await confirmedWait).toBe('confirmed');

      await confirmedWait;

      handler.markClearMessageSent();

      handler.suppressIdleForNextResult();
      let settled2: string | null = null;
      void handler.waitForSuppressedResult(5_000, 'clear-msg-id-2').then((outcome) => {
        settled2 = outcome;
      });

      await handler.handleMessage({ ...errorMessage, uuid: 'compact-error-2' } as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled2).toBe(null);

      handler.clearIdleSuppression();
    });

    it('an error result releases the clear wait only after its bookkeeping completes', async () => {
      let releaseBookkeeping!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseBookkeeping = resolve;
      });
      emitSpy.mockImplementationOnce(async () => {
        await gate;
      });

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      const handled = handler.handleMessage({
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'clear-error',
        is_error: true,
        errors: ['boom'],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(settled).toBe(null);

      releaseBookkeeping();
      await handled;

      expect(await wait).toBe('reset');
      expect(settled).toBe('reset');
    });

    it('cancelSuppressedResultWait settles a pending wait as cancelled', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');

      handler.cancelSuppressedResultWait();

      expect(await wait).toBe('cancelled');
    });

    it('a bookkeeping failure settles the clear wait as reset instead of dangling', async () => {
      let publishes = 0;
      emitSpy.mockImplementation(async () => {
        publishes += 1;
        if (publishes === 2) {
          throw new Error('session.updated subscriber failed');
        }
      });

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');

      await expect(
        handler.handleMessage({
          type: 'result',
          subtype: 'success',
          uuid: 'clear-result',
          user_message_uuid: 'clear-msg-id',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        } as unknown as SDKMessage)
      ).rejects.toThrow('session.updated subscriber failed');

      expect(await wait).toBe('reset');
    });

    it('an sdk.message subscriber failure settles the clear wait before the deadline is cancelled', async () => {
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');

      await expect(
        handler.handleMessage({
          type: 'result',
          subtype: 'success',
          uuid: 'clear-result',
          user_message_uuid: 'clear-msg-id',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        } as unknown as SDKMessage)
      ).rejects.toThrow('sdk.message subscriber failed');

      expect(await wait).toBe('reset');
    });

    it('the confirmation timeout stops once the correlated result enters processing', async () => {
      let releaseBookkeeping!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseBookkeeping = resolve;
      });
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          await gate;
        }
      });

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(30, 'clear-msg-id');

      const handled = handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        user_message_uuid: 'clear-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 60));

      releaseBookkeeping();
      await handled;

      expect(await wait).toBe('confirmed');
    });

    it('the trailing-idle deadline starts only after result bookkeeping finishes', async () => {
      let releasePublication!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      let sdkPublishes = 0;
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          sdkPublishes += 1;
          if (sdkPublishes === 2) {
            await gate;
          }
        }
      });
      const sessionState = (state: 'busy' | 'idle'): SDKMessage =>
        ({
          type: 'system',
          subtype: 'session_state_changed',
          state,
          uuid: `state-${state}`,
          session_id: 'sdk-session-123',
        }) as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(30, 'clear-msg-id');
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(sessionState('busy'));
      const handled = handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        user_message_uuid: 'clear-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(settled).toBe(null);

      releasePublication();
      await handled;
      await handler.handleMessage(sessionState('idle'));

      expect(await wait).toBe('confirmed');
    });

    it('a pre-clear control idle resets turn flags so a state-less clear confirms directly', async () => {
      const sessionState = (state: 'busy' | 'idle'): SDKMessage =>
        ({
          type: 'system',
          subtype: 'session_state_changed',
          state,
          uuid: `state-${state}`,
          session_id: 'sdk-session-123',
        }) as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();

      await handler.handleMessage(sessionState('busy'));
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'compact-result',
        user_message_uuid: 'compact-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);
      await handler.handleMessage(sessionState('idle'));

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        user_message_uuid: 'clear-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(await wait).toBe('confirmed');
    });

    it('the result deadline stays disarmed until startSuppressedResultTimer runs', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.armSuppressedResultWait('clear-msg-id');
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(null);

      handler.startSuppressedResultTimer(10);
      expect(await wait).toBe('reset');
    });

    it('results during a clear-arming window skip the turn-end fallback acknowledgement', async () => {
      const reopenedRow = {
        type: 'user',
        uuid: 'handoff-uuid',
        dbId: 'db-1',
        timestamp: 1,
        message: { role: 'user', content: [] },
      };
      (mockDb as unknown as { getJobQueueRepo: () => unknown }).getJobQueueRepo = () => ({
        activeDeliveryMessageUuids: () => new Set<string>(),
      });
      const markConsumedSpy = mock(() => ({ ids: ['db-1'], uuids: ['handoff-uuid'] }));
      (mockDb as unknown as { getSDKMessageRepo: () => unknown }).getSDKMessageRepo = () => ({
        markDeliveriesConsumedAtTurnEnd: markConsumedSpy,
      });
      const clearResult: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        user_message_uuid: 'clear-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      getUserMessagesByStatusSpy.mockReturnValue({
        messages: [reopenedRow],
        total: 1,
      });
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      await handler.handleMessage(clearResult);
      await wait;
      expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();

      handler.suppressIdleForNextResult();
      getUserMessagesByStatusSpy.mockClear();
      const plainWait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      const plainResult = { ...clearResult, user_message_uuid: 'other-turn' } as SDKMessage;
      await handler.handleMessage(plainResult);
      handler.clearIdleSuppression();
      await plainWait;

      expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
      expect(markConsumedSpy).not.toHaveBeenCalled();

      getUserMessagesByStatusSpy.mockClear();
      markConsumedSpy.mockClear();
      await handler.handleMessage({ ...plainResult, uuid: 'post-window-result' } as SDKMessage);

      expect(getUserMessagesByStatusSpy).toHaveBeenCalled();
      expect(markConsumedSpy).toHaveBeenCalledWith(
        'test-session-id',
        ['handoff-uuid'],
        'post-window-result'
      );
    });

    it('clear recovery resets session-state turn flags so result-based idle still works', async () => {
      handler.suppressIdleForNextResult();
      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'busy',
        uuid: 'state-busy',
        session_id: 'sdk-session-123',
      } as unknown as SDKMessage);
      handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      setIdleSpy.mockClear();

      handler.clearIdleSuppression();

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'next-turn-result',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('settles the correlated clear wait only after the result bookkeeping', async () => {
      const order: string[] = [];
      updateSessionSpy.mockImplementation(() => {
        order.push('metadata-write');
      });

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id').then((confirmed) => {
        order.push(`settled:${confirmed}`);
        return confirmed;
      });

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        user_message_uuid: 'clear-msg-id',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(order).toEqual(['metadata-write', 'settled:confirmed']);
      expect(await wait).toBe('confirmed');
    });

    it('a result that fails to persist resolves the wait unconfirmed and releases suppression', async () => {
      const result: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'clear-result',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      saveSDKMessageSpy.mockReturnValueOnce(false);
      setIdleSpy.mockClear();

      await handler.handleMessage(result);

      expect(await wait).toBe('reset');

      saveSDKMessageSpy.mockReturnValueOnce(true);
      await handler.handleMessage({ ...result, uuid: 'next-turn-result' });
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should persist and broadcast api_retry message', async () => {
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
      expect(saveSDKMessageSpy).toHaveBeenCalled();
      expect(publishSpy).toHaveBeenCalled();
      const firstEmitCall = emitSpy.mock.calls[0];
      expect(firstEmitCall).toBeTruthy();
      expect(firstEmitCall[0]).toBe('session.retryAttempt');
      expect(firstEmitCall[1]).toMatchObject({
        sessionId: 'test-session-id',
        attempt: 1,
        max_retries: 3,
      });
    });

    it('should reset thinking token tracking on system init (new query start)', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-1',
        session_id: 'test-session-id',
        estimated_tokens: 500,
        estimated_tokens_delta: 500,
      } as unknown as SDKMessage);

      const assistantA: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-a',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Interrupted turn chunk' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantA);

      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        uuid: 'init-uuid',
        session_id: 'new-sdk-session-id',
        slash_commands: [],
      } as unknown as SDKMessage);

      const assistantB: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-b',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'New query chunk' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantB);

      const savedB = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-b'
      )?.[1] as SDKMessage;
      expect(savedB).not.toHaveProperty('estimated_thinking_tokens');
    });

    it('should not persist thinking_tokens but stash estimate', async () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-uuid',
        session_id: 'test-session-id',
        estimated_tokens: 1500,
        estimated_tokens_delta: 500,
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(handler['currentThinkingTokensEstimate']).toBe(1500);
    });

    it('should stamp thinking estimate on assistant message with thinking block', async () => {
      const thinkingMessage: SDKMessage = {
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-uuid',
        session_id: 'test-session-id',
        estimated_tokens: 2000,
        estimated_tokens_delta: 1000,
      } as unknown as SDKMessage;

      await handler.handleMessage(thinkingMessage);

      const assistantMessage: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-uuid',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Some thinking content' },
            { type: 'text', text: 'Response text' },
          ],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;

      await handler.handleMessage(assistantMessage);

      expect(saveSDKMessageSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          type: 'assistant',
          estimated_thinking_tokens: 2000,
        })
      );

      const secondAssistantMessage: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-uuid-2',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Another response' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;

      await handler.handleMessage(secondAssistantMessage);

      const lastCall = saveSDKMessageSpy.mock.calls[saveSDKMessageSpy.mock.calls.length - 1];
      expect(lastCall).toBeTruthy();
      const savedMessage = lastCall[1] as SDKMessage;
      expect(savedMessage.type).toBe('assistant');
      expect(savedMessage).not.toHaveProperty('estimated_thinking_tokens');
    });

    it('should persist per-block deltas from a cumulative turn-level estimate', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-1',
        session_id: 'test-session-id',
        estimated_tokens: 500,
        estimated_tokens_delta: 500,
      } as unknown as SDKMessage);

      const assistantA: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-a',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'First chunk' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantA);

      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-2',
        session_id: 'test-session-id',
        estimated_tokens: 1200,
        estimated_tokens_delta: 700,
      } as unknown as SDKMessage);

      const assistantB: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-b',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Second chunk' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantB);

      const savedA = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-a'
      )?.[1] as SDKMessage;
      const savedB = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-b'
      )?.[1] as SDKMessage;

      expect(savedA).toMatchObject({ estimated_thinking_tokens: 500 });
      expect(savedB).toMatchObject({ estimated_thinking_tokens: 700 });
    });

    it('should not repeat the same cumulative count on later thinking blocks', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-1',
        session_id: 'test-session-id',
        estimated_tokens: 814,
        estimated_tokens_delta: 814,
      } as unknown as SDKMessage);

      const assistantA: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-a',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'First chunk' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantA);

      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-2',
        session_id: 'test-session-id',
        estimated_tokens: 814,
        estimated_tokens_delta: 0,
      } as unknown as SDKMessage);

      const assistantB: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-b',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Second chunk' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantB);

      const savedA = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-a'
      )?.[1] as SDKMessage;
      const savedB = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-b'
      )?.[1] as SDKMessage;

      expect(savedA).toMatchObject({ estimated_thinking_tokens: 814 });
      expect(savedB).not.toHaveProperty('estimated_thinking_tokens');
    });

    it('should reset thinking token tracking at turn end', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-1',
        session_id: 'test-session-id',
        estimated_tokens: 500,
        estimated_tokens_delta: 500,
      } as unknown as SDKMessage);

      const assistantA: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-a',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Turn 1 chunk' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantA);

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'result-1',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      const assistantB: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-b',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Turn 2 chunk without new thinking_tokens' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantB);

      const savedB = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-b'
      )?.[1] as SDKMessage;
      expect(savedB).not.toHaveProperty('estimated_thinking_tokens');
    });

    it('should omit zero and repeated identical deltas', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-1',
        session_id: 'test-session-id',
        estimated_tokens: 300,
        estimated_tokens_delta: 300,
      } as unknown as SDKMessage);

      const assistantA: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-a',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Chunk A' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantA);

      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-2',
        session_id: 'test-session-id',
        estimated_tokens: 300,
        estimated_tokens_delta: 0,
      } as unknown as SDKMessage);

      const assistantB: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-b',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Chunk B' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantB);

      const savedA = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-a'
      )?.[1] as SDKMessage;
      const savedB = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-b'
      )?.[1] as SDKMessage;

      expect(savedA).toMatchObject({ estimated_thinking_tokens: 300 });
      expect(savedB).not.toHaveProperty('estimated_thinking_tokens');
    });

    it('should treat a decreased cumulative estimate as a new thinking block', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-1',
        session_id: 'test-session-id',
        estimated_tokens: 300,
        estimated_tokens_delta: 300,
      } as unknown as SDKMessage);

      const assistantA: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-a',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Chunk A' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantA);

      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-2',
        session_id: 'test-session-id',
        estimated_tokens: 200,
        estimated_tokens_delta: -100,
      } as unknown as SDKMessage);

      const assistantB: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-b',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Chunk B' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantB);

      await handler.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'thinking-3',
        session_id: 'test-session-id',
        estimated_tokens: 200,
        estimated_tokens_delta: 0,
      } as unknown as SDKMessage);

      const assistantC: SDKMessage = {
        type: 'assistant',
        uuid: 'assistant-c',
        session_id: 'test-session-id',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Chunk C' }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      await handler.handleMessage(assistantC);

      const savedA = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-a'
      )?.[1] as SDKMessage;
      const savedB = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-b'
      )?.[1] as SDKMessage;
      const savedC = saveSDKMessageSpy.mock.calls.find(
        (call) => (call[1] as SDKMessage).uuid === 'assistant-c'
      )?.[1] as SDKMessage;

      expect(savedA).toMatchObject({ estimated_thinking_tokens: 300 });
      expect(savedB).toMatchObject({ estimated_thinking_tokens: 200 });
      expect(savedC).not.toHaveProperty('estimated_thinking_tokens');
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
      getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return {
            messages: [
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
            ],
            total: 1,
          };
        }
        return { messages: [], total: 0 };
      });
      const markDeliveriesConsumedAtTurnEndSpy = mock(() => ({
        ids: ['db-msg-1'],
        uuids: ['enqueued-user-uuid'],
      }));
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveriesConsumedAtTurnEnd: markDeliveriesConsumedAtTurnEndSpy,
      })) as never;

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

      expect(markDeliveriesConsumedAtTurnEndSpy).toHaveBeenCalledWith(
        'test-session-id',
        ['enqueued-user-uuid'],
        'result-uuid'
      );
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

    it('leaves a message owned by the message queue enqueued at turn end', async () => {
      getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return {
            messages: [
              {
                dbId: 'db-queued',
                uuid: 'queued-user-uuid',
                type: 'user',
                timestamp: 1700000000000,
                message: { role: 'user', content: [{ type: 'text', text: 'queued' }] },
              },
            ],
            total: 1,
          };
        }
        return { messages: [], total: 0 };
      });
      hasPendingOrClaimedSpy.mockImplementation((uuid: string) => uuid === 'queued-user-uuid');

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(updateMessageStatusSpy).not.toHaveBeenCalledWith(['db-queued'], 'consumed');
    });

    it('acknowledges a yielded durable message at turn end when replay is absent', async () => {
      getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return {
            messages: [
              {
                dbId: 'db-yielded',
                uuid: 'yielded-user-uuid',
                type: 'user',
                timestamp: 1700000000000,
                message: { role: 'user', content: [{ type: 'text', text: 'yielded' }] },
              },
            ],
            total: 1,
          };
        }
        return { messages: [], total: 0 };
      });
      const markDeliveriesConsumedAtTurnEndSpy = mock(() => ({
        ids: ['db-yielded', 'db-batch-member'],
        uuids: ['yielded-user-uuid', 'batch-member-uuid'],
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: () => new Set(['yielded-user-uuid']),
        getActiveDeliveryBatchUuids: () => ['yielded-user-uuid', 'batch-member-uuid'],
      })) as never;
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveriesConsumedAtTurnEnd: markDeliveriesConsumedAtTurnEndSpy,
      })) as never;
      const kickoffWaiter = waitForDeliveryConsumption(mockSession.id, 'yielded-user-uuid');
      const memberWaiter = waitForDeliveryConsumption(mockSession.id, 'batch-member-uuid');
      getStateSpy.mockReturnValue({
        status: 'processing',
        messageId: 'yielded-user-uuid',
        phase: 'streaming',
      });
      setIdleSpy.mockImplementation(async () => {
        getStateSpy.mockReturnValue({ status: 'idle' });
      });
      hasPendingOrClaimedSpy.mockReturnValue(false);
      hasYieldedSpy.mockImplementation((uuid: string) => uuid === 'yielded-user-uuid');
      acknowledgeYieldedSpy.mockImplementation((uuid: string) => uuid === 'yielded-user-uuid');

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(setIdleSpy).toHaveBeenCalled();
      expect(getStateSpy).toHaveBeenCalledTimes(2);
      expect(markDeliveriesConsumedAtTurnEndSpy).toHaveBeenCalledWith(
        'test-session-id',
        ['yielded-user-uuid', 'batch-member-uuid'],
        'result-uuid'
      );
      expect(acknowledgeYieldedSpy).toHaveBeenCalledWith('yielded-user-uuid');
      expect(
        await Promise.all([
          kickoffWaiter.promise.then(() => 'consumed'),
          memberWaiter.promise.then(() => 'consumed'),
        ])
      ).toEqual(['consumed', 'consumed']);
      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-yielded', 'db-batch-member'],
        status: 'consumed',
      });
    });

    it('signals only batch members actually consumed at turn end', async () => {
      getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return {
            messages: [
              {
                dbId: 'db-yielded',
                uuid: 'yielded-user-uuid',
                type: 'user',
                timestamp: 1700000000000,
                message: { role: 'user', content: [{ type: 'text', text: 'yielded' }] },
              },
            ],
            total: 1,
          };
        }
        return { messages: [], total: 0 };
      });
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: () => new Set(['yielded-user-uuid']),
        getActiveDeliveryBatchUuids: () => ['yielded-user-uuid', 'held-member-uuid'],
      })) as never;
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveriesConsumedAtTurnEnd: mock(() => ({
          ids: ['db-yielded'],
          uuids: ['yielded-user-uuid'],
        })),
      })) as never;
      const kickoffWaiter = waitForDeliveryConsumption(mockSession.id, 'yielded-user-uuid');
      const memberWaiter = waitForDeliveryConsumption(mockSession.id, 'held-member-uuid');
      getStateSpy.mockReturnValue({
        status: 'processing',
        messageId: 'yielded-user-uuid',
        phase: 'streaming',
      });
      hasPendingOrClaimedSpy.mockReturnValue(false);
      hasYieldedSpy.mockImplementation((uuid: string) => uuid === 'yielded-user-uuid');
      acknowledgeYieldedSpy.mockImplementation((uuid: string) => uuid === 'yielded-user-uuid');

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        modelUsage: {},
      } as unknown as SDKMessage);

      await expect(kickoffWaiter.promise).resolves.toBeUndefined();
      let memberSettled = false;
      void memberWaiter.promise.then(() => {
        memberSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(memberSettled).toBe(false);
      kickoffWaiter.cancel();
      memberWaiter.cancel();
    });

    it('settles yielded delivery before timestamp maintenance', async () => {
      getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return {
            messages: [
              {
                dbId: 'db-yielded',
                uuid: 'yielded-user-uuid',
                type: 'user',
                timestamp: 1700000000000,
                message: { role: 'user', content: [{ type: 'text', text: 'yielded' }] },
              },
            ],
            total: 1,
          };
        }
        return { messages: [], total: 0 };
      });
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: () => new Set(['yielded-user-uuid']),
      })) as never;
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveriesConsumedAtTurnEnd: mock(() => ({
          ids: ['db-yielded'],
          uuids: ['yielded-user-uuid'],
        })),
      })) as never;
      mockDb.updateMessageTimestamp = mock(() => {
        throw new Error('search maintenance failed');
      });
      const kickoffWaiter = waitForDeliveryConsumption(mockSession.id, 'yielded-user-uuid');
      getStateSpy.mockReturnValue({
        status: 'processing',
        messageId: 'yielded-user-uuid',
        phase: 'streaming',
      });
      hasPendingOrClaimedSpy.mockReturnValue(false);
      hasYieldedSpy.mockImplementation((uuid: string) => uuid === 'yielded-user-uuid');
      acknowledgeYieldedSpy.mockImplementation((uuid: string) => uuid === 'yielded-user-uuid');

      await expect(
        handler.handleMessage({
          type: 'result',
          subtype: 'success',
          uuid: 'result-uuid',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          modelUsage: {},
        } as unknown as SDKMessage)
      ).rejects.toThrow('search maintenance failed');

      expect(acknowledgeYieldedSpy).toHaveBeenCalledWith('yielded-user-uuid');
      await expect(kickoffWaiter.promise).resolves.toBeUndefined();
      kickoffWaiter.cancel();
    });

    it('leaves an active durable steer enqueued and claimable at turn end (#3744401261)', async () => {
      getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return {
            messages: [
              {
                dbId: 'db-steer',
                uuid: 'durable-steer-uuid',
                type: 'user',
                timestamp: 1700000000000,
                message: { role: 'user', content: [{ type: 'text', text: 'steer' }] },
              },
            ],
            total: 1,
          };
        }
        return { messages: [], total: 0 };
      });
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: () => new Set(['durable-steer-uuid']),
      })) as never;

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(updateMessageStatusSpy).not.toHaveBeenCalledWith(['db-steer'], 'consumed');
    });

    it('leaves a yielded durable steer enqueued when another message owns the turn', async () => {
      getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
        if (status === 'enqueued') {
          return {
            messages: [
              {
                dbId: 'db-steer',
                uuid: 'durable-steer-uuid',
                type: 'user',
                timestamp: 1700000000000,
                message: { role: 'user', content: [{ type: 'text', text: 'steer' }] },
              },
            ],
            total: 1,
          };
        }
        return { messages: [], total: 0 };
      });
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: () => new Set(['durable-steer-uuid']),
      })) as never;
      getStateSpy.mockReturnValue({
        status: 'processing',
        messageId: 'current-turn-uuid',
        phase: 'streaming',
      });
      hasPendingOrClaimedSpy.mockReturnValue(false);
      hasYieldedSpy.mockReturnValue(true);

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(updateMessageStatusSpy).not.toHaveBeenCalledWith(['db-steer'], 'consumed');
      expect(acknowledgeYieldedSpy).not.toHaveBeenCalled();
    });

    it('should handle result message with missing usage (bridge provider edge case)', async () => {
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'no-usage-uuid',
        total_cost_usd: 0,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

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

    it('should reset session-state turn mode after idle so later result can finish turn', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'busy',
        uuid: 'state-busy',
      } as unknown as SDKMessage);
      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'state-idle',
      } as unknown as SDKMessage);
      setIdleSpy.mockClear();

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'later-result',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should wait for idle before replaying queued turns after a success result', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'busy',
        uuid: 'state-busy-before-success',
      } as unknown as SDKMessage);
      emitSpy.mockClear();
      setIdleSpy.mockClear();

      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        uuid: 'success-before-idle',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage);

      expect(emitSpy).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'test-session-id' });

      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'state-idle-after-success',
      } as unknown as SDKMessage);

      expect(setIdleSpy).toHaveBeenCalled();
      expect(
        emitSpy.mock.calls.filter(
          ([event, payload]) =>
            event === 'query.trigger' && payload?.sessionId === 'test-session-id'
        )
      ).toHaveLength(1);
    });

    it('should not replay queued turns after an error result followed by idle state', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'error-result',
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
      } as unknown as SDKMessage);
      emitSpy.mockClear();
      setIdleSpy.mockClear();

      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'state-idle-after-error',
      } as unknown as SDKMessage);

      expect(setIdleSpy).toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'test-session-id' });
    });

    it('should include normalized slash-command aliases from commands_changed messages', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'commands_changed',
        commands: [{ name: '/status', aliases: ['/cost', 'stats'] }],
      } as unknown as SDKMessage);

      expect(mockContext.onCommandsChanged).toHaveBeenCalledWith(['status', 'cost', 'stats']);
    });

    it('should persist provider-native fallback model after SDK fallback translation', async () => {
      getProviderRegistry().register(new TranslatingMockProvider());
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4-mini');
      expect(updateSessionSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          config: expect.objectContaining({ model: 'gpt-5.4-mini' }),
        })
      );
    });

    it('skips scoped catalog discovery when no curation is configured', async () => {
      const provider = new TranslatingMockProvider();
      let scopedFetchCount = 0;
      (
        provider as unknown as {
          getModelsForSessionConfig: (config: unknown) => Promise<ModelInfo[]>;
        }
      ).getModelsForSessionConfig = async () => {
        scopedFetchCount += 1;
        return [];
      };
      getProviderRegistry().register(provider);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
        providerConfig: { baseUrl: 'http://scoped.example' },
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
        scopedBaseUrl: 'http://scoped.example',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(scopedFetchCount).toBe(0);
      expect(mockSession.config.model).toBe('gpt-5.4-mini');
      expect(updateSessionSpy).toHaveBeenCalled();
    });

    it('treats fallback resolution failure as a stale retry instead of throwing', async () => {
      mockSession.config = {
        ...mockSession.config,
        provider: 'missing-provider',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'missing-provider',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('should skip fallback persistence when the provider epoch changed after build', async () => {
      getProviderRegistry().register(new TranslatingMockProvider());
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
        providerEpoch: getProviderCatalogEpoch('anthropic-codex') + 5,
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist a retry event for a fallback replaced after build', async () => {
      const provider = new TranslatingMockProvider();
      provider.translateModelIdForSdk = () => 'default';
      provider.getModels = async () => [];
      getProviderRegistry().register(provider);
      getProviderRegistry().setCuratedModels('anthropic-codex', [
        { id: 'gpt-5.4-mini' },
        { id: 'gpt-5.4-turbo' },
      ]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-turbo',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'default',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist a curated-out fallback model', async () => {
      getProviderRegistry().register(new TranslatingMockProvider());
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist the fallback when the session config changes during the curation check', async () => {
      const provider = new TranslatingMockProvider();
      provider.getModels = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [
          {
            id: 'gpt-5.4-mini',
            name: 'GPT 5.4 Mini',
            alias: 'gpt54mini',
            family: 'gpt',
            provider: 'anthropic-codex',
            contextWindow: 100000,
            description: 'GPT 5.4 Mini',
            releaseDate: '',
            available: true,
          },
        ];
      };
      getProviderRegistry().register(provider);
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4-mini' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      const pending = handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockSession.config = { ...mockSession.config, fallbackModel: undefined };

      await pending;

      expect(mockSession.config.fallbackModel).toBeUndefined();
      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist the fallback when it changes during fallback resolution', async () => {
      const provider = new TranslatingMockProvider();
      (provider as unknown as { ensureBridgeStarted: () => Promise<void> }).ensureBridgeStarted =
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 8));
        };
      getProviderRegistry().register(provider);
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4-mini' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      const pending = handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockSession.config = { ...mockSession.config, fallbackModel: 'opus' };

      await pending;

      expect(mockSession.config.fallbackModel).toBe('opus');
      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist the fallback when the primary model changes during the curation check', async () => {
      const provider = new TranslatingMockProvider();
      provider.getModels = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [
          {
            id: 'gpt-5.4-mini',
            name: 'GPT 5.4 Mini',
            alias: 'gpt54mini',
            family: 'gpt',
            provider: 'anthropic-codex',
            contextWindow: 100000,
            description: 'GPT 5.4 Mini',
            releaseDate: '',
            available: true,
          },
        ];
      };
      getProviderRegistry().register(provider);
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4-mini' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      const pending = handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockSession.config = { ...mockSession.config, model: 'gpt-5.4-turbo' };

      await pending;

      expect(mockSession.config.model).toBe('gpt-5.4-turbo');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist the fallback when session-scoped provider settings change during the curation check', async () => {
      const provider = new TranslatingMockProvider();
      provider.getModels = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [
          {
            id: 'gpt-5.4-mini',
            name: 'GPT 5.4 Mini',
            alias: 'gpt54mini',
            family: 'gpt',
            provider: 'anthropic-codex',
            contextWindow: 100000,
            description: 'GPT 5.4 Mini',
            releaseDate: '',
            available: true,
          },
        ];
      };
      getProviderRegistry().register(provider);
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4-mini' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      const pending = handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockSession.config = { ...mockSession.config, providerConfig: { apiKey: 'sk-new-endpoint' } };

      await pending;

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist the fallback when the session region changes during the curation check', async () => {
      const provider = new TranslatingMockProvider();
      provider.getModels = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [
          {
            id: 'gpt-5.4-mini',
            name: 'GPT 5.4 Mini',
            alias: 'gpt54mini',
            family: 'gpt',
            provider: 'anthropic-codex',
            contextWindow: 100000,
            description: 'GPT 5.4 Mini',
            releaseDate: '',
            available: true,
          },
        ];
      };
      getProviderRegistry().register(provider);
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4-mini' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      const pending = handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockSession.config = { ...mockSession.config, providerConfig: { region: 'global' } };

      await pending;

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist an SDK fallback that no longer maps to the configured fallback', async () => {
      getProviderRegistry().register(new TranslatingMockProvider());
      getProviderRegistry().setCuratedModels('anthropic-codex', [
        { id: 'gpt-5.4' },
        { id: 'gpt-5.4-mini' },
      ]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'gpt-5.4',
        fallback_model: 'claude-opus-4-7',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist a retry event after the primary model changed since build', async () => {
      getProviderRegistry().register(new TranslatingMockProvider());
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4-mini' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4-turbo',
        fallbackModel: 'gpt-5.4-mini',
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4-turbo');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist a retry event after session-scoped settings changed since build', async () => {
      getProviderRegistry().register(new TranslatingMockProvider());
      getProviderRegistry().setCuratedModels('anthropic-codex', [{ id: 'gpt-5.4-mini' }]);
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
        providerConfig: { apiKey: 'sk-new-endpoint' },
      };
      markBuiltFallbackIdentity(mockSession, {
        providerId: 'anthropic-codex',
        primaryModel: 'gpt-5.4',
        fallbackModel: 'gpt-5.4-mini',
      });

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'claude-opus-4-7',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('does not persist an SDK fallback when no fallback is configured', async () => {
      getProviderRegistry().register(new TranslatingMockProvider());
      mockSession.config = {
        ...mockSession.config,
        provider: 'anthropic-codex',
        model: 'gpt-5.4',
        fallbackModel: undefined,
      };

      await handler.handleMessage({
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        original_model: 'gpt-5.4',
        fallback_model: 'claude-sonnet-4-20250514',
        content: 'Retrying with fallback model',
      } as unknown as SDKMessage);

      expect(mockSession.config.model).toBe('gpt-5.4');
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    describe('refusal rewind target plumbing (refused_user_message_uuid)', () => {
      it('records the refused user message uuid on session metadata', async () => {
        await handler.handleMessage({
          type: 'system',
          subtype: 'model_refusal_fallback',
          direction: 'retry',
          original_model: 'claude-opus-4-7',
          fallback_model: 'claude-sonnet-4-20250514',
          refused_user_message_uuid: 'refused-user-uuid',
          content: 'Retrying with fallback model',
        } as unknown as SDKMessage);

        expect(mockSession.metadata?.refusalRewindTargetUuid).toBe('refused-user-uuid');
        expect(updateSessionSpy).toHaveBeenCalledWith(
          'test-session-id',
          expect.objectContaining({
            metadata: expect.objectContaining({ refusalRewindTargetUuid: 'refused-user-uuid' }),
          })
        );
        expect(emitSpy).toHaveBeenCalledWith(
          'session.updated',
          expect.objectContaining({
            sessionId: 'test-session-id',
            session: expect.objectContaining({
              metadata: expect.objectContaining({ refusalRewindTargetUuid: 'refused-user-uuid' }),
            }),
          })
        );
      });

      it('records the target for non-retry directions too', async () => {
        await handler.handleMessage({
          type: 'system',
          subtype: 'model_refusal_fallback',
          direction: 'revert',
          original_model: 'claude-opus-4-7',
          fallback_model: 'claude-sonnet-4-20250514',
          refused_user_message_uuid: 'refused-user-uuid',
          content: 'Reverting after refusal',
        } as unknown as SDKMessage);

        expect(mockSession.metadata?.refusalRewindTargetUuid).toBe('refused-user-uuid');
      });

      it('records the target for model_refusal_no_fallback messages', async () => {
        await handler.handleMessage({
          type: 'system',
          subtype: 'model_refusal_no_fallback',
          original_model: 'claude-opus-4-7',
          request_id: null,
          refused_user_message_uuid: 'refused-user-uuid',
          content: 'No fallback model available',
        } as unknown as SDKMessage);

        expect(mockSession.metadata?.refusalRewindTargetUuid).toBe('refused-user-uuid');
        expect(updateSessionSpy).toHaveBeenCalledWith(
          'test-session-id',
          expect.objectContaining({
            metadata: expect.objectContaining({ refusalRewindTargetUuid: 'refused-user-uuid' }),
          })
        );
      });

      it('does not republish when the target is unchanged', async () => {
        mockSession.metadata = {
          ...mockSession.metadata,
          refusalRewindTargetUuid: 'refused-user-uuid',
        };
        updateSessionSpy.mockClear();
        emitSpy.mockClear();

        await handler.handleMessage({
          type: 'system',
          subtype: 'model_refusal_fallback',
          direction: 'retry',
          original_model: 'claude-opus-4-7',
          fallback_model: 'default',
          refused_user_message_uuid: 'refused-user-uuid',
          content: 'Retrying with fallback model',
        } as unknown as SDKMessage);

        expect(updateSessionSpy).not.toHaveBeenCalled();
        expect(emitSpy).not.toHaveBeenCalledWith('session.updated', expect.anything());
      });

      it('leaves metadata untouched when the refusal carries no uuid', async () => {
        await handler.handleMessage({
          type: 'system',
          subtype: 'model_refusal_fallback',
          direction: 'retry',
          original_model: 'claude-opus-4-7',
          fallback_model: 'default',
          refused_user_message_uuid: null,
          content: 'Retrying with fallback model',
        } as unknown as SDKMessage);

        expect(mockSession.metadata?.refusalRewindTargetUuid).toBeUndefined();
        expect(emitSpy).not.toHaveBeenCalledWith('session.updated', expect.anything());
      });

      it('clears the target on the next successful result, including the persisted row', async () => {
        mockSession.metadata = {
          ...mockSession.metadata,
          refusalRewindTargetUuid: 'refused-user-uuid',
        };

        await handler.handleMessage({
          type: 'result',
          subtype: 'success',
          uuid: 'success-result',
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0,
          modelUsage: {},
        } as unknown as SDKMessage);

        expect(mockSession.metadata?.refusalRewindTargetUuid).toBeUndefined();
        expect(updateSessionSpy).toHaveBeenCalledWith(
          'test-session-id',
          expect.objectContaining({
            metadata: expect.objectContaining({ refusalRewindTargetUuid: null }),
          })
        );
        expect(emitSpy).toHaveBeenCalledWith(
          'session.updated',
          expect.objectContaining({
            session: expect.objectContaining({
              metadata: expect.not.objectContaining({ refusalRewindTargetUuid: expect.anything() }),
            }),
          })
        );
      });
    });

    describe('SDK capability capture', () => {
      it('exposes capabilities advertised on system/init', async () => {
        await handler.handleMessage({
          type: 'system',
          subtype: 'init',
          capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
        } as unknown as SDKMessage);

        expect(handler.getSdkCapabilities().has('interrupt_cancel_queued_v1')).toBe(true);
        expect(handler.getSdkCapabilities().has('interrupt_receipt_v1')).toBe(true);
        expect(handler.getSdkCapabilities().has('unknown_capability')).toBe(false);
      });

      it('starts empty and resets when a fresh init advertises nothing', async () => {
        await handler.handleMessage({
          type: 'system',
          subtype: 'init',
          capabilities: ['interrupt_cancel_queued_v1'],
        } as unknown as SDKMessage);
        await handler.handleMessage({
          type: 'system',
          subtype: 'init',
        } as unknown as SDKMessage);

        expect(handler.getSdkCapabilities().size).toBe(0);
      });
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
      mockSession.metadata = {
        ...mockSession.metadata,
        lastSdkCost: 1.0,
        costBaseline: 0,
        totalCost: 1.0,
      };

      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'test-uuid',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.5,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(mockSession.metadata?.costBaseline).toBe(1.0);
      expect(mockSession.metadata?.totalCost).toBe(1.5);
      expect(mockSession.metadata?.lastSdkCost).toBe(0.5);
    });

    describe('C1c: cost-reset table and legacy-fragility characterization', () => {
      function makeResultMessage(
        totalCostUsd: number,
        overrides: Partial<SDKMessage> = {}
      ): SDKMessage {
        return {
          type: 'result',
          subtype: 'success',
          uuid: 'test-uuid',
          parent_tool_use_id: null,
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: totalCostUsd,
          modelUsage: {},
          ...overrides,
        } as unknown as SDKMessage;
      }

      function makeErrorResult(overrides: Partial<SDKMessage> = {}): SDKMessage {
        return {
          type: 'result',
          subtype: 'error_during_execution',
          uuid: 'error-uuid',
          parent_tool_use_id: null,
          is_error: true,
          errors: ['boom'],
          total_cost_usd: 0,
          ...overrides,
        } as unknown as SDKMessage;
      }

      describe('cost-reset table', () => {
        const rows = [
          [0, 0, 0.3, 0, 0.3],
          [0.5, 0.2, 0.5, 0.2, 0.7],
          [0.5, 0.2, 0.3, 0.7, 1.0],
          [1.0, 0, 0.5, 1.0, 1.5],
          [1.0, 0.5, 0, 1.5, 1.5],
        ] as const;

        for (const [lastSdkCost, costBaseline, sdkCost, expectedBaseline, expectedTotal] of rows) {
          it(`lastSdkCost=${lastSdkCost} costBaseline=${costBaseline} sdkCost=${sdkCost}`, async () => {
            mockSession.metadata = {
              ...mockSession.metadata,
              lastSdkCost,
              costBaseline,
            };

            await handler.handleMessage(makeResultMessage(sdkCost));

            expect(mockSession.metadata?.lastSdkCost).toBe(sdkCost);
            expect(mockSession.metadata?.costBaseline).toBeCloseTo(expectedBaseline, 10);
            expect(mockSession.metadata?.totalCost).toBeCloseTo(expectedTotal, 10);
          });
        }
      });

      describe('legacy-fragility characterization', () => {
        it('legacy success path fires beginTerminalIdle then two setIdle calls', async () => {
          const order: string[] = [];
          beginTerminalIdleSpy.mockImplementation(() => {
            order.push('beginTerminalIdle');
          });
          setIdleSpy.mockImplementation(async () => {
            order.push('setIdle');
          });

          await handler.handleMessage(makeResultMessage(0.001));

          expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
          expect(setIdleSpy).toHaveBeenCalledTimes(2);
          expect(order).toEqual(['beginTerminalIdle', 'setIdle', 'setIdle']);
        });

        it('cost accounting runs between the two setIdle calls', async () => {
          let setIdleCount = 0;
          let baselineAtFirstSetIdle: number | undefined;
          let baselineAtSecondSetIdle: number | undefined;

          setIdleSpy.mockImplementation(async () => {
            setIdleCount++;
            if (setIdleCount === 1) {
              baselineAtFirstSetIdle = mockSession.metadata?.costBaseline;
            } else if (setIdleCount === 2) {
              baselineAtSecondSetIdle = mockSession.metadata?.costBaseline;
            }
          });

          mockSession.metadata = {
            ...mockSession.metadata,
            lastSdkCost: 1.0,
            costBaseline: 0,
          };

          await handler.handleMessage(makeResultMessage(0.5));

          expect(baselineAtFirstSetIdle).toBe(0);
          expect(baselineAtSecondSetIdle).toBe(1.0);
          expect(setIdleSpy.mock.calls).toEqual([[], []]);
        });

        it('lastResultWasSuccess stays set after a result until an idle event resets it', async () => {
          const privateHandler = handler as unknown as { lastResultWasSuccess: boolean | null };

          await handler.handleMessage(makeResultMessage(0.001));

          expect(privateHandler.lastResultWasSuccess).toBe(true);

          emitSpy.mockClear();
          setIdleSpy.mockClear();

          await handler.handleMessage({
            type: 'system',
            subtype: 'session_state_changed',
            state: 'idle',
            uuid: 'idle-uuid',
          } as unknown as SDKMessage);

          expect(privateHandler.lastResultWasSuccess).toBeNull();
          expect(emitSpy).toHaveBeenCalledWith('query.trigger', { sessionId: 'test-session-id' });
        });

        it('a stale lastResultWasSuccess=false suppresses replay for a later idle', async () => {
          const privateHandler = handler as unknown as { lastResultWasSuccess: boolean | null };

          await handler.handleMessage(makeErrorResult());

          expect(privateHandler.lastResultWasSuccess).toBe(false);

          emitSpy.mockClear();

          await handler.handleMessage({
            type: 'system',
            subtype: 'session_state_changed',
            state: 'idle',
            uuid: 'idle-uuid',
          } as unknown as SDKMessage);

          expect(privateHandler.lastResultWasSuccess).toBeNull();
          expect(emitSpy).not.toHaveBeenCalledWith('query.trigger', {
            sessionId: 'test-session-id',
          });
        });

        it('a later result overwrites the stale lastResultWasSuccess window', async () => {
          const privateHandler = handler as unknown as { lastResultWasSuccess: boolean | null };

          await handler.handleMessage(makeErrorResult());

          expect(privateHandler.lastResultWasSuccess).toBe(false);

          await handler.handleMessage(makeResultMessage(0.001, { uuid: 'success-uuid' }));

          expect(privateHandler.lastResultWasSuccess).toBe(true);

          emitSpy.mockClear();

          await handler.handleMessage({
            type: 'system',
            subtype: 'session_state_changed',
            state: 'idle',
            uuid: 'idle-uuid',
          } as unknown as SDKMessage);

          expect(emitSpy).toHaveBeenCalledWith('query.trigger', { sessionId: 'test-session-id' });
        });
      });
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

      expect(setCompactingSpy).not.toHaveBeenCalled();
    });

    it('clears stale compacting state when a result arrives without a boundary', async () => {
      getIsCompactingSpy.mockImplementation(() => true);
      mockContext.queryObject = null;
      const message: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'stale-compact-uuid',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
        modelUsage: {},
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(setCompactingSpy).toHaveBeenCalledWith(false);
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

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(setCompactingSpy).toHaveBeenCalledWith(false);
      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(updateWithDetailedBreakdownSpy).toHaveBeenCalled();
      expect(mockMessageQueue.enqueueWithId).not.toHaveBeenCalled();
    });

    it('keys the boundary cooldown to the tracked active budget when known', async () => {
      getContextInfoSpy.mockImplementation(() => ({
        totalUsed: 10_000,
        totalCapacity: 262_144,
        percentUsed: 3,
        breakdown: {},
      }));
      mockContext.queryObject = null;
      const message: SDKMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'test-uuid',
        compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
      } as unknown as SDKMessage;

      await handler.handleMessage(message);

      expect(markCompactionTriggeredSpy).toHaveBeenCalledWith(235_929);
    });

    it('ignores compact boundaries from a replaced query generation', async () => {
      (mockContext as { getQueryGeneration?: () => number }).getQueryGeneration = mock(() => 7);
      mockContext.queryObject = null;
      const message: SDKMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'test-uuid',
        compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
      } as unknown as SDKMessage;

      await handler.handleMessage(message, 3);

      expect(acknowledgeCompactionsAwaitingBoundarySpy).not.toHaveBeenCalled();
      expect(setCompactingSpy).not.toHaveBeenCalled();
    });

    it('acknowledges the compact boundary before the compacting-state publication settles', async () => {
      let releaseSetCompacting!: () => void;
      setCompactingSpy.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseSetCompacting = resolve;
          })
      );
      mockContext.queryObject = null;
      const message: SDKMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'test-uuid',
        compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
      } as unknown as SDKMessage;

      const handled = handler.handleMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(acknowledgeCompactionsAwaitingBoundarySpy).toHaveBeenCalledTimes(1);

      releaseSetCompacting();
      await handled;
    });
  });

  describe('circuit breaker integration', () => {
    it('should handle circuit breaker trip with active query', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

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

      expect(lifecycleStopSpy).toHaveBeenCalledWith({ catchQueryErrors: true });
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should handle circuit breaker trip without active query', async () => {
      mockContext.queryObject = null;
      mockContext.queryPromise = null;

      const handlerNoQuery = new SDKMessageHandler(mockContext);

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

      expect(lifecycleStopSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should display error as assistant message when circuit breaker trips', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

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

      expect(handleErrorSpy).toHaveBeenCalled();
    });

    it('should clear message queue when circuit breaker trips', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

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

      expect(messageQueueClearSpy).toHaveBeenCalled();
    });

    it('should emit session.errorClear when circuit breaker trips', async () => {
      mockContext.queryObject = {} as unknown as SDKMessageHandlerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      const handlerWithQuery = new SDKMessageHandler(mockContext);

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

      expect(emitSpy).toHaveBeenCalledWith('session.errorClear', {
        sessionId: 'test-session-id',
      });
    });
  });

  describe('context refresh via SDK getContextUsage()', () => {
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

    it('starts the terminal fence before publishing a persisted result', async () => {
      let resolvePublish!: () => void;
      emitSpy.mockImplementation(
        (_event: string) =>
          new Promise<void>((resolve) => {
            resolvePublish = resolve;
          })
      );
      const resultMessage: SDKMessage = {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'result-fence-uuid',
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

      const handling = handler.handleMessage(resultMessage);
      for (
        let attempt = 0;
        attempt < 20 && beginTerminalIdleSpy.mock.calls.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();

      resolvePublish();
      await handling;
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('does not finish the outer turn for nested subagent results', async () => {
      const finishTurnSpy = mock(async () => {});
      (handler as unknown as { finishTurn: () => Promise<void> }).finishTurn = finishTurnSpy;
      const nestedResult: SDKMessage = {
        type: 'result',
        subtype: 'success',
        uuid: 'nested-result-uuid',
        parent_tool_use_id: 'outer-agent-tool-use',
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

      await handler.handleMessage(nestedResult);

      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(finishTurnSpy).not.toHaveBeenCalled();
    });

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

      const assistant5: SDKMessage = {
        type: 'assistant',
        uuid: 'a-5',
        message: { role: 'assistant', content: [] },
      } as unknown as SDKMessage;
      await h.handleMessage(assistant5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);

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

      await h.handleMessage(resultMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(updateWithDetailedBreakdownSpy).not.toHaveBeenCalled();
    });

    describe('HyperNeo-level compaction trigger', () => {
      afterEach(() => {
        setModelsCache(new Map());
      });

      function budgetCase(opts?: {
        provider?: string;
        model?: string;
        window?: number;
        totalUsed?: number;
        sdkMaxTokens?: number;
        isAutoCompactEnabled?: boolean;
      }) {
        const provider = opts?.provider ?? 'openrouter';
        const model = opts?.model ?? 'deepseek-v4';
        const window = opts?.window ?? 1_000_000;
        setModelsCache(
          new Map([
            [
              'global',
              [
                {
                  id: model,
                  name: model,
                  provider,
                  contextWindow: window,
                  available: true,
                },
              ],
            ],
          ])
        );
        const totalUsed = opts?.totalUsed ?? 950_000;
        const getContextUsageSpy = mock(async () => ({
          categories: [{ name: 'Messages', tokens: totalUsed }],
          totalTokens: totalUsed,
          maxTokens: opts?.sdkMaxTokens ?? window,
          rawMaxTokens: opts?.sdkMaxTokens ?? window,
          percentage: Math.round((totalUsed / window) * 100),
          gridRows: [],
          model,
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: opts?.isAutoCompactEnabled ?? true,
          apiUsage: null,
        }));
        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
        mockContext.session.config.provider = provider;
        mockContext.session.config.model = model;
        return { getContextUsageSpy, h: new SDKMessageHandler(mockContext) };
      }

      function turnEndResult(): SDKMessage {
        return {
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
      }

      it('enqueues /compact once when the budget is exceeded with an unknown SDK threshold', async () => {
        const { getContextUsageSpy, h } = budgetCase();

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(markCompactionTriggeredSpy).toHaveBeenCalledTimes(1);
        expect(enqueueMessageSpy).toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });
        expect(getIsCompactingSpy).toHaveBeenCalled();
        expect(isCoolingDownSpy).toHaveBeenCalled();
      });

      it('arms the turn-end delivery gate before awaiting the stale compacting publication', async () => {
        let compacting = true;
        let releaseCompacting!: () => void;
        getIsCompactingSpy.mockImplementation(() => compacting);
        setCompactingSpy.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              compacting = false;
              releaseCompacting = resolve;
            })
        );
        const { h } = budgetCase({ totalUsed: 50_000 });

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setCompactingSpy).toHaveBeenCalledWith(false);
        expect(setDeliveryGateSpy).toHaveBeenCalled();

        releaseCompacting();
        await handled;
        expect(setIdleSpy).toHaveBeenCalled();
      });

      it('arms the delivery gate for an enforcement-capable event-tick refresh while prompts are queued', async () => {
        hasQueuedMessagesSpy.mockImplementation(() => true);
        const { getContextUsageSpy, h } = budgetCase();

        for (let i = 0; i < 5; i++) {
          await h.handleMessage({
            type: 'assistant',
            uuid: `tick-${i}`,
            message: { role: 'assistant', content: [] },
          } as unknown as SDKMessage);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalled();
        expect(setDeliveryGateSpy).toHaveBeenCalled();
        expect(enqueueMessageSpy).toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });
      });

      it('drops an over-budget refresh whose query was replaced before usage resolved', async () => {
        let resolveUsage: ((value: unknown) => void) | undefined;
        const getContextUsageSpy = mock(
          () =>
            new Promise((resolve) => {
              resolveUsage = resolve;
            })
        );
        const { h } = budgetCase();
        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        mockContext.queryObject = { getContextUsage: mock(async () => ({})) } as never;

        resolveUsage?.({
          categories: [{ name: 'Messages', tokens: 950_000 }],
          totalTokens: 950_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 95,
          gridRows: [],
          model: 'deepseek-v4',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        });
        await handled;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(markCompactionTriggeredSpy).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('still enqueues /compact when a context.updated subscriber rejects', async () => {
        emitSpy.mockImplementation((event: string) =>
          event === 'context.updated' ? Promise.reject(new Error('bus down')) : Promise.resolve()
        );
        const { h } = budgetCase();

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(markCompactionTriggeredSpy).toHaveBeenCalledTimes(1);
        expect(enqueueMessageSpy).toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });
      });

      it('never enqueues the SDK /compact command for ACP sessions', async () => {
        const { getContextUsageSpy, h } = budgetCase({
          provider: 'acp',
          model: 'acp-agent-model',
          window: 200_000,
          totalUsed: 190_000,
          isAutoCompactEnabled: false,
        });

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(markCompactionTriggeredSpy).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('drops the compaction decision when the session model changes during usage sampling', async () => {
        let resolveSampling: (() => void) | undefined;
        const getContextUsageSpy = mock(
          () =>
            new Promise((resolve) => {
              resolveSampling = () =>
                resolve({
                  categories: [{ name: 'Messages', tokens: 950_000 }],
                  totalTokens: 950_000,
                  maxTokens: 1_000_000,
                  rawMaxTokens: 1_000_000,
                  percentage: 95,
                  gridRows: [],
                  model: 'deepseek-v4',
                  memoryFiles: [],
                  mcpTools: [],
                  agents: [],
                  isAutoCompactEnabled: true,
                  apiUsage: null,
                });
            })
        );
        const { h } = budgetCase();
        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        mockContext.session.config.model = 'switched-model';
        resolveSampling?.();
        await handled;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(markCompactionTriggeredSpy).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('samples fresh usage at turn end even when an event-tick refresh is still pending', async () => {
        let first = true;
        let resolveFirst: ((value: unknown) => void) | undefined;
        const getContextUsageSpy = mock(() => {
          if (first) {
            first = false;
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Promise.resolve({
            categories: [{ name: 'Messages', tokens: 950_000 }],
            totalTokens: 950_000,
            maxTokens: 1_000_000,
            rawMaxTokens: 1_000_000,
            percentage: 95,
            gridRows: [],
            model: 'deepseek-v4',
            memoryFiles: [],
            mcpTools: [],
            agents: [],
            isAutoCompactEnabled: true,
            apiUsage: null,
          });
        });
        const { h } = budgetCase();
        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;

        for (let i = 0; i < 5; i++) {
          await h.handleMessage({
            type: 'assistant',
            uuid: `tick-${i}`,
            message: { role: 'assistant', content: [] },
          } as unknown as SDKMessage);
        }

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        resolveFirst?.({
          categories: [{ name: 'Messages', tokens: 10_000 }],
          totalTokens: 10_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 1,
          gridRows: [],
          model: 'deepseek-v4',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        });
        await handled;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(2);
        expect(markCompactionTriggeredSpy).toHaveBeenCalledTimes(1);
        expect(enqueueMessageSpy).toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });
      });

      it('enqueues /compact without waiting for a stalled context.updated publication', async () => {
        let resolvePublish: (() => void) | undefined;
        mockInternalEventBus.publish = mock((event: string) => {
          if (event !== 'context.updated') return Promise.resolve();
          return new Promise<void>((resolve) => {
            resolvePublish = resolve;
          });
        });
        const { getContextUsageSpy, h } = budgetCase();

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(markCompactionTriggeredSpy).toHaveBeenCalled();
        expect(enqueueMessageSpy).toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });

        resolvePublish?.();
        await handled;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(enqueueMessageSpy).toHaveBeenCalledTimes(1);
      });

      it('does not run turn-end enforcement for nested subagent results', async () => {
        const { getContextUsageSpy, h } = budgetCase();

        await h.handleMessage({
          type: 'result',
          subtype: 'success',
          uuid: 'nested-result-uuid',
          parent_tool_use_id: 'outer-agent-tool-use',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          total_cost_usd: 0.001,
          modelUsage: {},
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).not.toHaveBeenCalled();
        expect(markCompactionTriggeredSpy).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('clears a dead delivered compaction without immediately re-enqueueing', async () => {
        hasCompactionsAwaitingBoundarySpy.mockImplementation(() => true);
        const { h } = budgetCase();

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(acknowledgeCompactionsAwaitingBoundarySpy).toHaveBeenCalledTimes(1);
        expect(clearCompactionCooldownSpy).toHaveBeenCalledTimes(1);
        expect(markCompactionTriggeredSpy).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('clears a dead delivered compaction even when turn-end sampling fails', async () => {
        hasCompactionsAwaitingBoundarySpy.mockImplementation(() => true);
        const { h } = budgetCase();
        mockContext.queryObject = {
          getContextUsage: mock(async () => {
            throw new Error('SDK exploded');
          }),
        } as never;

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(acknowledgeCompactionsAwaitingBoundarySpy).toHaveBeenCalledTimes(1);
        expect(clearCompactionCooldownSpy).toHaveBeenCalledTimes(1);
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('arms the turn-end gate before the sdk.message publication', async () => {
        let resolvePublish!: () => void;
        emitSpy.mockImplementation(
          (event: string) =>
            new Promise<void>((resolve) => {
              if (event === 'sdk.message') {
                resolvePublish = resolve;
              } else {
                resolve();
              }
            })
        );
        const { h } = budgetCase({ totalUsed: 50_000 });

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setDeliveryGateSpy).toHaveBeenCalled();

        resolvePublish();
        await handled;
      });

      it('holds the delivery gate closed through the terminal idle transition', async () => {
        let idleReleased = false;
        const releaseIdle: Array<() => void> = [];
        setIdleSpy.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              if (idleReleased) resolve();
              else releaseIdle.push(resolve);
            })
        );
        const { h } = budgetCase({ totalUsed: 50_000 });

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const turnEndSegment = setDeliveryGateSpy.mock.calls[0]?.[0] as Promise<void>;
        let opened = false;
        void turnEndSegment.then(() => {
          opened = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(opened).toBe(false);
        expect(setIdleSpy).toHaveBeenCalled();

        idleReleased = true;
        for (const release of releaseIdle) release();
        await handled;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(opened).toBe(true);
      });

      it('does not treat the ordinary turn result as a dead compaction after a mid-turn enqueue', async () => {
        hasQueuedMessagesSpy.mockImplementation(() => true);
        getStateSpy.mockImplementation(() => ({ status: 'processing', phase: 'streaming' }));
        const { h } = budgetCase();

        for (let i = 0; i < 5; i++) {
          await h.handleMessage({
            type: 'assistant',
            uuid: `tick-${i}`,
            message: { role: 'assistant', content: [] },
          } as unknown as SDKMessage);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(enqueueMessageSpy).toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });

        hasQueuedMessagesSpy.mockImplementation(() => false);
        hasOutstandingInternalCompactionSpy.mockImplementation(() => true);
        hasCompactionsAwaitingBoundarySpy.mockImplementation(() => true);

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(acknowledgeCompactionsAwaitingBoundarySpy).not.toHaveBeenCalled();
        expect(clearCompactionCooldownSpy).not.toHaveBeenCalled();

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(acknowledgeCompactionsAwaitingBoundarySpy).toHaveBeenCalledTimes(1);
        expect(clearCompactionCooldownSpy).toHaveBeenCalledTimes(1);
      });

      it('awaits the context publication on non-enforcement exits', async () => {
        let resolvePublish: (() => void) | undefined;
        mockInternalEventBus.publish = mock((event: string) => {
          if (event !== 'context.updated') return Promise.resolve();
          return new Promise<void>((resolve) => {
            resolvePublish = resolve;
          });
        });
        const { h } = budgetCase({
          provider: 'anthropic',
          model: 'sonnet',
          window: 200_000,
          totalUsed: 190_000,
        });

        const handled = h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(enqueueMessageSpy).not.toHaveBeenCalled();

        let settled = false;
        void handled.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        resolvePublish?.();
        await handled;
      });

      it('does not defer dead-compaction cleanup for an event-tick compaction enqueued while idle', async () => {
        hasQueuedMessagesSpy.mockImplementation(() => true);
        const sessionState = (state: 'busy' | 'idle'): SDKMessage =>
          ({
            type: 'system',
            subtype: 'session_state_changed',
            state,
            uuid: `state-${state}`,
            session_id: 'sdk-session-123',
          }) as unknown as SDKMessage;
        const { h } = budgetCase();

        for (let i = 0; i < 4; i++) {
          await h.handleMessage({
            type: 'assistant',
            uuid: `tick-${i}`,
            message: { role: 'assistant', content: [] },
          } as unknown as SDKMessage);
        }
        await h.handleMessage(sessionState('idle'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(enqueueMessageSpy).toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });

        hasQueuedMessagesSpy.mockImplementation(() => false);
        hasOutstandingInternalCompactionSpy.mockImplementation(() => true);
        hasCompactionsAwaitingBoundarySpy.mockImplementation(() => true);

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(acknowledgeCompactionsAwaitingBoundarySpy).toHaveBeenCalledTimes(1);
        expect(clearCompactionCooldownSpy).toHaveBeenCalledTimes(1);
      });

      it('ignores turn-end enforcement from a replaced query generation', async () => {
        hasCompactionsAwaitingBoundarySpy.mockImplementation(() => true);
        (mockContext as { getQueryGeneration?: () => number }).getQueryGeneration = mock(() => 7);
        const { getContextUsageSpy, h } = budgetCase();

        await h.handleMessage(turnEndResult(), 3);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).not.toHaveBeenCalled();
        expect(acknowledgeCompactionsAwaitingBoundarySpy).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('holds the delivery gate until the trailing session_state_changed idle lands', async () => {
        const sessionState = (state: 'busy' | 'idle'): SDKMessage =>
          ({
            type: 'system',
            subtype: 'session_state_changed',
            state,
            uuid: `state-${state}`,
            session_id: 'sdk-session-123',
          }) as unknown as SDKMessage;
        const { h } = budgetCase({ totalUsed: 50_000 });

        await h.handleMessage(sessionState('busy'));
        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const trailingSegment = setDeliveryGateSpy.mock.calls.at(-2)?.[0] as Promise<void>;
        let opened = false;
        void trailingSegment.then(() => {
          opened = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(opened).toBe(false);

        await h.handleMessage(sessionState('idle'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(opened).toBe(true);
      });

      it('suppresses the compaction decision while limit recovery owns the turn', async () => {
        (mockContext as { isLimitRecoveryPending?: () => boolean }).isLimitRecoveryPending = mock(
          () => true
        );
        const { getContextUsageSpy, h } = budgetCase();

        await h.handleMessage(turnEndResult());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContextUsageSpy).toHaveBeenCalledTimes(1);
        expect(markCompactionTriggeredSpy).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalled();
      });

      it('does not enqueue /compact for non-PROVIDER_NO_SDK_AUTO_COMPACT providers (SDK handles)', async () => {
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
        mockContextTracker.shouldCompactAt = mock(() => true);

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
        expect(mockContextTracker.shouldCompactAt).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });
      });

      it('does not enqueue /compact for custom-provider sessions (SDK handles via Options.settings)', async () => {
        setModelsCache(
          new Map([
            [
              'global',
              [
                {
                  id: 'fallback-model',
                  name: 'Fallback Model',
                  provider: 'custom-provider',
                  contextWindow: 128_000,
                  available: true,
                },
              ],
            ],
          ])
        );

        const getContextUsageSpy = mock(async () => ({
          categories: [{ name: 'Messages', tokens: 110_000 }],
          totalTokens: 110_000,
          maxTokens: Number.MAX_SAFE_INTEGER,
          rawMaxTokens: Number.MAX_SAFE_INTEGER,
          percentage: 0,
          gridRows: [],
          model: 'fallback-model',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: null,
        }));

        mockContext.queryObject = { getContextUsage: getContextUsageSpy } as never;
        mockContext.session.config.provider = 'custom-provider';
        mockContext.session.config.model = 'fallback-model';
        mockContextTracker.shouldCompactAt = mock(() => true);

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

        expect(mockContextTracker.shouldCompactAt).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });
      });

      it('does not enqueue /compact for native anthropic provider (SDK handles)', async () => {
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
        mockContext.session.config.provider = 'anthropic';
        mockContext.session.config.model = 'sonnet';

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
        expect(mockContextTracker.shouldCompactAt).not.toHaveBeenCalled();
        expect(enqueueMessageSpy).not.toHaveBeenCalledWith('/compact', true, {
          durable: true,
          prepend: true,
        });
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
        mockContext.session.config.provider = 'unknown-no-sdk-compact';
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
      const errorMessage: SDKMessage = {
        type: 'user',
        uuid: 'error-uuid',
        message: {
          role: 'user',
          content:
            '<local-command-stderr>Error: prompt is too long: 200000 tokens > 128000 maximum</local-command-stderr>',
        },
      } as unknown as SDKMessage;

      await handler.handleMessage(errorMessage);
      await handler.handleMessage({ ...errorMessage, uuid: 'error-uuid-2' } as SDKMessage);

      handler.markApiSuccess();

      await handler.handleMessage({ ...errorMessage, uuid: 'error-uuid-3' } as SDKMessage);

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

      expect(lifecycleStopSpy).toHaveBeenCalled();

      lifecycleStopSpy.mockClear();

      handlerWithQuery.resetCircuitBreaker();

      for (let i = 0; i < 4; i++) {
        await handlerWithQuery.handleMessage({
          ...errorMessage,
          uuid: `error-uuid-new-${i}`,
        } as SDKMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(lifecycleStopSpy).toHaveBeenCalled();
    });
  });

  describe('markMessageAccepted (ACP signal guard)', () => {
    it('does NOT signal delivery waiters when the row is failed (acceptance did not take)', async () => {
      getMessageByStatusAndUuidSpy.mockImplementation(() => null);
      const waiter = waitForDeliveryConsumption(mockSession.id, 'msg-failed');
      handler.markMessageAccepted('msg-failed');
      const winner = await Promise.race([
        waiter.promise.then(() => 'signaled' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50)),
      ]);
      expect(winner).toBe('timeout');
      waiter.cancel();
    });

    it('notifies the delivery layer when a consumed ACP kickoff is accepted (Codex P1)', () => {
      const onDeliveryTurnAccepted = mockContext.onDeliveryTurnAccepted as ReturnType<typeof mock>;
      getMessageByStatusAndUuidSpy.mockImplementation(() => ({ id: 'db-consumed' }));
      handler.markMessageAccepted('msg-accepted');
      expect(onDeliveryTurnAccepted).toHaveBeenCalled();
    });
  });

  describe('query-owner idle filter (B5e)', () => {
    const makeResult = (): SDKMessage =>
      ({
        type: 'result',
        subtype: 'success',
        uuid: 'result-uuid',
        parent_tool_use_id: null,
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0,
        modelUsage: {},
      }) as unknown as SDKMessage;

    const sessionState = (state: 'busy' | 'idle'): SDKMessage =>
      ({
        type: 'system',
        subtype: 'session_state_changed',
        state,
        uuid: `state-${state}`,
        session_id: 'sdk-session-123',
      }) as unknown as SDKMessage;

    const publishedTopics = () => emitSpy.mock.calls.map((call) => call[0] as string);
    const idleSettleArgs = () => setIdleSpy.mock.calls.map((call) => call[0]);
    const setGeneration = (value: number): void => {
      (mockContext as unknown as { getQueryGeneration: () => number }).getQueryGeneration = mock(
        () => value
      );
    };

    it('a current result settles idle with the invocation query owner and replays', async () => {
      setGeneration(3);

      await handler.handleMessage(makeResult(), 3);

      expect(beginTerminalIdleSpy).toHaveBeenCalledWith({ queryGeneration: 3, turnToken: 0 });
      expect(idleSettleArgs()).toContainEqual({ owner: { queryGeneration: 3, turnToken: 0 } });
      expect(publishedTopics()).toContain('query.trigger');
    });

    it('a stale result arms and settles with its own owner (paired) and skips the turn replay', async () => {
      setGeneration(9);

      await handler.handleMessage(makeResult(), 2);

      expect(beginTerminalIdleSpy).toHaveBeenCalledWith({ queryGeneration: 2, turnToken: 0 });
      expect(idleSettleArgs()).toContainEqual({ owner: { queryGeneration: 2, turnToken: 0 } });
      expect(publishedTopics()).not.toContain('query.trigger');
    });

    it('a result going stale during the errorClear publication skips the turn replay', async () => {
      let generation = 3;
      (mockContext as unknown as { getQueryGeneration: () => number }).getQueryGeneration = mock(
        () => generation
      );
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.errorClear') generation = 9;
      });

      await handler.handleMessage(makeResult(), 3);

      expect(idleSettleArgs()).toContainEqual({ owner: { queryGeneration: 3, turnToken: 0 } });
      expect(publishedTopics()).not.toContain('query.trigger');
    });

    it('a stale session-state idle does not settle idle, cancels its orphaned arm, and leaves the successor turn flags alone', async () => {
      setGeneration(9);
      setIdleSpy.mockClear();

      await handler.handleMessage(sessionState('idle'), 2);

      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(cancelTerminalIdleArmSpy).toHaveBeenCalledWith({ queryGeneration: 2, turnToken: 0 });
      expect(publishedTopics()).not.toContain('query.trigger');
      expect(
        (handler as unknown as { usesSessionStateChangedTurnEnd: boolean })
          .usesSessionStateChangedTurnEnd
      ).toBe(false);
    });

    it('a stale session-state busy event does not arm the successor turn-end expectations', async () => {
      setGeneration(9);

      await handler.handleMessage(sessionState('busy'), 2);

      const flags = handler as unknown as {
        usesSessionStateChangedTurnEnd: boolean;
        expectsSessionStateIdleAfterResult: boolean;
      };
      expect(flags.usesSessionStateChangedTurnEnd).toBe(false);
      expect(flags.expectsSessionStateIdleAfterResult).toBe(false);
    });

    it('an idle event going stale during the finishTurn await keeps the successor turn flags', async () => {
      let generation = 3;
      (mockContext as unknown as { getQueryGeneration: () => number }).getQueryGeneration = mock(
        () => generation
      );
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'query.trigger') generation = 9;
      });

      await handler.handleMessage(sessionState('idle'), 3);

      expect(idleSettleArgs()).toContainEqual({ owner: { queryGeneration: 3, turnToken: 0 } });
      expect(
        (handler as unknown as { usesSessionStateChangedTurnEnd: boolean })
          .usesSessionStateChangedTurnEnd
      ).toBe(true);
    });
  });

  describe('result-level limit interception', () => {
    const makeApiErrorResult = (overrides: Record<string, unknown> = {}): SDKMessage =>
      ({
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 429,
        result:
          'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-08-21 16:17:29 重置。]',
        uuid: 'result-uuid',
        session_id: 'test-session-id',
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        ...overrides,
      }) as unknown as SDKMessage;

    const makeRateLimitEvent = (resetsAtSeconds?: number): SDKMessage =>
      ({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          ...(resetsAtSeconds !== undefined ? { resetsAt: resetsAtSeconds } : {}),
          rateLimitType: 'five_hour',
        },
        uuid: 'rle-uuid',
        session_id: 'test-session-id',
      }) as unknown as SDKMessage;

    const publishedTopics = () => emitSpy.mock.calls.map((call) => call[0] as string);

    it('routes a synthetic api-error success result into the limit pipeline and skips turn replay', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(makeApiErrorResult());

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      const [errorText, hint] = onResultLimitError.mock.calls[0] as [
        string,
        { resetAtMs?: number | null; kind?: string | null },
      ];
      expect(errorText).toContain('429');
      expect(hint.kind).toBe('usage_limit');
      expect(publishedTopics()).not.toContain('query.trigger');
      expect(publishedTopics()).not.toContain('session.errorClear');
    });

    it('falls through to normal success handling when the limit pipeline declines', async () => {
      const onResultLimitError = mock(async () => false);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(makeApiErrorResult());

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      expect(publishedTopics()).not.toContain('query.trigger');
    });

    it('ignores genuine success results', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(makeApiErrorResult({ is_error: false, api_error_status: null }));

      expect(onResultLimitError).not.toHaveBeenCalled();
      expect(publishedTopics()).toContain('query.trigger');
    });

    it('ignores api-error results whose text is not a limit error', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(
        makeApiErrorResult({
          api_error_status: 500,
          terminal_reason: 'api_error',
          result: 'Error: 500 Internal Server Error',
        })
      );

      expect(onResultLimitError).not.toHaveBeenCalled();
      expect(publishedTopics()).toContain('query.trigger');
    });

    it('feeds a captured structured rate_limit_event into the assessment', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;
      const resetsAtSeconds = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);

      await handler.handleMessage(makeRateLimitEvent(resetsAtSeconds));
      await handler.handleMessage(
        makeApiErrorResult({ result: 'upstream rejected', api_error_status: 429 })
      );

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      const [, hint] = onResultLimitError.mock.calls[0] as [
        string,
        { resetAtMs?: number | null; kind?: string | null },
      ];
      expect(hint.resetAtMs).toBe(resetsAtSeconds * 1000);
      expect(hint.kind).toBe('usage_limit');
    });

    it('clears structured rate-limit info after a genuine success result', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(
        makeRateLimitEvent(Math.floor((Date.now() + 60 * 60 * 1000) / 1000))
      );
      await handler.handleMessage(makeApiErrorResult({ is_error: false, api_error_status: null }));
      await handler.handleMessage(
        makeApiErrorResult({ result: 'upstream rejected', api_error_status: 429 })
      );

      const [, hint] = onResultLimitError.mock.calls[0] as [
        string,
        { resetAtMs?: number | null; kind?: string | null },
      ];
      expect(hint.resetAtMs).toBeNull();
    });

    it('skips the idle transition and terminal fence when recovery engages', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(makeApiErrorResult());

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(publishedTopics()).not.toContain('query.trigger');
    });

    it('marks the intercepted result so delivery re-claim stays scoped to limit turns', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;
      const markRecoveryIntercepted = mock(() => {});
      mockDb.getSDKMessageRepo = mock(
        () => ({ markResultRecoveryIntercepted: markRecoveryIntercepted }) as never
      ) as never;

      await handler.handleMessage(makeApiErrorResult());

      expect(markRecoveryIntercepted).toHaveBeenCalledWith('test-session-id', 'result-uuid', false);
    });

    it('marks billing-terminal interceptions so their restart reclaim stays manual', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;
      const markRecoveryIntercepted = mock(() => {});
      mockDb.getSDKMessageRepo = mock(
        () => ({ markResultRecoveryIntercepted: markRecoveryIntercepted }) as never
      ) as never;

      await handler.handleMessage(
        makeApiErrorResult({
          api_error_status: null,
          result:
            "API Error: 403 You've reached your usage limit for this billing cycle. " +
            'To continue now, purchase extra usage or upgrade your plan.',
        })
      );

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      const [, hint] = onResultLimitError.mock.calls[0] as [
        string,
        { billingTerminal?: boolean | null },
      ];
      expect(hint.billingTerminal).toBe(true);
      expect(markRecoveryIntercepted).toHaveBeenCalledWith('test-session-id', 'result-uuid', true);
    });

    it('keeps numeric token totals when an intercepted result carries an empty usage object', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;
      mockSession.metadata = {
        messageCount: 2,
        totalTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        totalCost: 0.5,
        toolCallCount: 1,
      };

      await handler.handleMessage(makeApiErrorResult());

      expect(mockSession.metadata?.totalTokens).toBe(120);
      expect(mockSession.metadata?.inputTokens).toBe(100);
      expect(mockSession.metadata?.outputTokens).toBe(20);
    });

    it('clears captured limit evidence when the circuit breaker resets', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(
        makeRateLimitEvent(Math.floor((Date.now() + 60 * 60 * 1000) / 1000))
      );
      handler.resetCircuitBreaker();
      await handler.handleMessage(
        makeApiErrorResult({
          api_error_status: 500,
          result: 'Error: 500 Internal Server Error',
        })
      );

      expect(onResultLimitError).not.toHaveBeenCalled();
      expect(publishedTopics()).toContain('query.trigger');
    });

    it('ignores allowed rate-limit telemetry when assessing a later api error', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: Math.floor((Date.now() + 5 * 60 * 60 * 1000) / 1000),
          rateLimitType: 'five_hour',
        },
        uuid: 'rle-uuid',
        session_id: 'test-session-id',
      } as unknown as SDKMessage);
      await handler.handleMessage(
        makeApiErrorResult({
          api_error_status: 500,
          result: 'Error: 500 Internal Server Error',
        })
      );

      expect(onResultLimitError).not.toHaveBeenCalled();
      expect(publishedTopics()).toContain('query.trigger');
    });

    it('clears the captured rate-limit event after recovery engages', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(
        makeRateLimitEvent(Math.floor((Date.now() + 60 * 60 * 1000) / 1000))
      );
      await handler.handleMessage(
        makeApiErrorResult({ result: 'upstream rejected', api_error_status: 429 })
      );
      await handler.handleMessage(
        makeApiErrorResult({ result: 'upstream rejected', api_error_status: 429 })
      );

      expect(onResultLimitError).toHaveBeenCalledTimes(2);
      const [, secondHint] = onResultLimitError.mock.calls[1] as [
        string,
        { resetAtMs?: number | null },
      ];
      expect(secondHint.resetAtMs).toBeNull();
    });

    it('feeds a preceding assistant rate_limit error tag into the assessment', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage({
        type: 'assistant',
        message: { content: [] },
        parent_tool_use_id: null,
        error: 'rate_limit',
        uuid: 'assistant-uuid',
        session_id: 'test-session-id',
      } as unknown as SDKMessage);
      await handler.handleMessage(
        makeApiErrorResult({
          api_error_status: undefined,
          result: 'The request could not be completed',
        })
      );

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
    });

    it('ignores rate_limit tags from nested subagent assistant messages', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage({
        type: 'assistant',
        message: { content: [] },
        parent_tool_use_id: 'toolu_123',
        error: 'rate_limit',
        uuid: 'nested-assistant-uuid',
        session_id: 'test-session-id',
      } as unknown as SDKMessage);
      await handler.handleMessage(
        makeApiErrorResult({
          api_error_status: undefined,
          result: 'The request could not be completed',
        })
      );

      expect(onResultLimitError).not.toHaveBeenCalled();
    });

    it('records usage metadata before returning from limit interception', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(
        makeApiErrorResult({
          usage: { input_tokens: 100, output_tokens: 50 },
          total_cost_usd: 0.25,
        })
      );

      expect(updateSessionSpy).toHaveBeenCalled();
      expect(mockSession.metadata?.totalTokens).toBe(150);
      expect(mockSession.metadata?.inputTokens).toBe(100);
      expect(mockSession.metadata?.totalCost).toBe(0.25);
      expect(publishedTopics()).toContain('session.updated');
    });

    it('routes error-shaped results carrying 429 text into the limit pipeline', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['API Error: 429 rate limit exceeded'],
        uuid: 'result-uuid',
        session_id: 'test-session-id',
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
      } as unknown as SDKMessage);

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      const [errorText] = onResultLimitError.mock.calls[0] as [string];
      expect(errorText).toContain('429');
      expect(publishedTopics()).not.toContain('query.trigger');
    });

    it('passes the result user_message_uuid through to limit recovery', async () => {
      const onResultLimitError = mock(async () => true);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(makeApiErrorResult({ user_message_uuid: 'steer-uuid-1' }));

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      const thirdArg = onResultLimitError.mock.calls[0][2] as string | undefined;
      expect(thirdArg).toBe('steer-uuid-1');
    });

    it('consumes captured limit signals even when recovery declines', async () => {
      const onResultLimitError = mock(async () => false);
      mockContext.onResultLimitError = onResultLimitError;

      await handler.handleMessage(
        makeRateLimitEvent(Math.floor((Date.now() + 60 * 60 * 1000) / 1000))
      );
      await handler.handleMessage(
        makeApiErrorResult({ result: 'upstream rejected', api_error_status: 429 })
      );
      await handler.handleMessage(
        makeApiErrorResult({
          api_error_status: 500,
          result: 'Error: 500 Internal Server Error',
        })
      );

      expect(onResultLimitError).toHaveBeenCalledTimes(1);
      expect(publishedTopics()).toContain('query.trigger');
    });
  });

  describe('ack-selection table (C1b)', () => {
    const ackUuid = 'ack-user-uuid';
    const ackDbId = 'db-ack-user';
    const ackPersisted = {
      dbId: ackDbId,
      uuid: ackUuid,
      type: 'user',
      timestamp: 1700000000000,
      message: { role: 'user', content: [{ type: 'text', text: 'ack user' }] },
    } as unknown as SDKMessage & { dbId: string; timestamp: number };

    const ackMessage = {
      type: 'user',
      uuid: ackUuid,
      message: { role: 'user', content: [{ type: 'text', text: 'ack user' }] },
    } as unknown as SDKMessage;

    const ackResult = {
      type: 'result',
      subtype: 'success',
      uuid: 'result-uuid',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      modelUsage: {},
    } as unknown as SDKMessage;

    function statusSpy(
      status: 'enqueued' | 'deferred' | 'submitted' | 'consumed' | 'failed' | 'none'
    ) {
      getMessageByStatusAndUuidSpy.mockImplementation(
        (sessionId: string, queryStatus: string, uuid: string) =>
          status !== 'none' &&
          sessionId === 'test-session-id' &&
          uuid === ackUuid &&
          queryStatus === status
            ? ackPersisted
            : null
      );
    }

    const trapUuid = 'trap-queued-uuid';
    const trapDbId = 'db-trap-queued';
    const trapMessage = { role: 'user', content: [{ type: 'text', text: 'trap queued' }] };

    function setupTurnEndTrap() {
      const queued = {
        dbId: trapDbId,
        uuid: trapUuid,
        type: 'user',
        timestamp: 1700000000001,
        message: trapMessage,
      };
      getUserMessagesByStatusSpy.mockImplementation((sessionId: string, status: string) => {
        if (sessionId === 'test-session-id' && status === 'enqueued') {
          return { messages: [queued], total: 1 };
        }
        return { messages: [], total: 0 };
      });

      const markConsumed = mock(() => ({ ids: [queued.dbId], uuids: [queued.uuid] }));
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveriesConsumedAtTurnEnd: markConsumed,
      })) as never;

      return { markConsumed };
    }

    describe('acknowledgePersistedUserMessage by sendStatus', () => {
      it('consumes an enqueued user message and suppresses turn-end fallback', async () => {
        statusSpy('enqueued');
        await handler.handleMessage(ackMessage);
        expect(updateMessageStatusSpy).toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith(ackDbId);
        expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
          sessionId: 'test-session-id',
          messageIds: [ackDbId],
          status: 'consumed',
        });
        expect(saveSDKMessageSpy).not.toHaveBeenCalled();

        getUserMessagesByStatusSpy.mockClear();
        const { markConsumed } = setupTurnEndTrap();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('consumes a deferred user message and suppresses turn-end fallback', async () => {
        statusSpy('deferred');
        await handler.handleMessage(ackMessage);
        expect(updateMessageStatusSpy).toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith(ackDbId);
        expect(saveSDKMessageSpy).not.toHaveBeenCalled();

        getUserMessagesByStatusSpy.mockClear();
        const { markConsumed } = setupTurnEndTrap();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('consumes a submitted user message and suppresses turn-end fallback', async () => {
        statusSpy('submitted');
        await handler.handleMessage(ackMessage);
        expect(updateMessageStatusSpy).toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith(ackDbId);
        expect(saveSDKMessageSpy).not.toHaveBeenCalled();

        getUserMessagesByStatusSpy.mockClear();
        const { markConsumed } = setupTurnEndTrap();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('does not acknowledge a failed persisted user message and falls through', async () => {
        statusSpy('failed');
        await handler.handleMessage(ackMessage);
        expect(updateMessageStatusSpy).not.toHaveBeenCalled();
        expect(saveSDKMessageSpy).toHaveBeenCalledWith('test-session-id', ackMessage);

        getUserMessagesByStatusSpy.mockClear();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'enqueued');
      });

      it('suppresses duplicate SDK replay for a consumed persisted user message', async () => {
        statusSpy('consumed');
        await handler.handleMessage(ackMessage);
        expect(updateMessageStatusSpy).not.toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(saveSDKMessageSpy).not.toHaveBeenCalled();

        getUserMessagesByStatusSpy.mockClear();
        await handler.handleMessage({
          type: 'result',
          subtype: 'success',
          uuid: 'result-after-consumed',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          modelUsage: {},
        } as unknown as SDKMessage);

        expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
      });

      it('falls through to save a user message with no persisted sendStatus match', async () => {
        statusSpy('none');
        await handler.handleMessage(ackMessage);
        expect(updateMessageStatusSpy).not.toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(saveSDKMessageSpy).toHaveBeenCalledWith('test-session-id', ackMessage);

        getUserMessagesByStatusSpy.mockClear();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'enqueued');
      });
    });

    describe('handleMessageYielded by sendStatus', () => {
      const yieldAt = 1700000001234;

      it('consumes an enqueued message at pre-yield and suppresses turn-end fallback', async () => {
        hasPendingOrClaimedSpy.mockImplementation((id) => id === ackUuid);
        statusSpy('enqueued');
        mockMessageQueue.onMessageYielded?.(ackUuid, yieldAt);
        expect(updateMessageStatusSpy).toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith(ackDbId, yieldAt);
        expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
          sessionId: 'test-session-id',
          messageIds: [ackDbId],
          status: 'consumed',
        });
        expect(publishSpy).toHaveBeenCalledWith(
          'state.sdkMessages.delta',
          expect.objectContaining({
            added: expect.arrayContaining([
              expect.objectContaining({ uuid: ackUuid, timestamp: yieldAt }),
            ]),
            timestamp: yieldAt,
          }),
          { channel: 'session:test-session-id' }
        );

        getUserMessagesByStatusSpy.mockClear();
        const { markConsumed } = setupTurnEndTrap();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('consumes a submitted message at pre-yield and suppresses turn-end fallback', async () => {
        hasPendingOrClaimedSpy.mockImplementation((id) => id === ackUuid);
        statusSpy('submitted');
        mockMessageQueue.onMessageYielded?.(ackUuid, yieldAt);
        expect(updateMessageStatusSpy).toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith(ackDbId, yieldAt);
        expect(publishSpy).toHaveBeenCalledWith(
          'state.sdkMessages.delta',
          expect.objectContaining({
            added: expect.arrayContaining([
              expect.objectContaining({ uuid: ackUuid, timestamp: yieldAt }),
            ]),
            timestamp: yieldAt,
          }),
          { channel: 'session:test-session-id' }
        );

        getUserMessagesByStatusSpy.mockClear();
        const { markConsumed } = setupTurnEndTrap();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('consumes a deferred message at pre-yield and suppresses turn-end fallback', async () => {
        hasPendingOrClaimedSpy.mockImplementation((id) => id === ackUuid);
        statusSpy('deferred');
        mockMessageQueue.onMessageYielded?.(ackUuid, yieldAt);
        expect(updateMessageStatusSpy).toHaveBeenCalledWith([ackDbId], 'consumed');
        expect(mockDb.updateMessageTimestamp).toHaveBeenCalledWith(ackDbId, yieldAt);
        expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
          sessionId: 'test-session-id',
          messageIds: [ackDbId],
          status: 'consumed',
        });
        expect(publishSpy).toHaveBeenCalledWith(
          'state.sdkMessages.delta',
          expect.objectContaining({
            added: expect.arrayContaining([
              expect.objectContaining({ uuid: ackUuid, timestamp: yieldAt }),
            ]),
            timestamp: yieldAt,
          }),
          { channel: 'session:test-session-id' }
        );

        getUserMessagesByStatusSpy.mockClear();
        const { markConsumed } = setupTurnEndTrap();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('does nothing for a consumed message at pre-yield and leaves the fallback', async () => {
        statusSpy('consumed');
        mockMessageQueue.onMessageYielded?.(ackUuid, yieldAt);
        expect(updateMessageStatusSpy).not.toHaveBeenCalledWith([ackDbId], 'consumed');

        getUserMessagesByStatusSpy.mockClear();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'enqueued');
      });

      it('does nothing for a failed message at pre-yield and leaves the fallback', async () => {
        statusSpy('failed');
        mockMessageQueue.onMessageYielded?.(ackUuid, yieldAt);
        expect(updateMessageStatusSpy).not.toHaveBeenCalledWith([ackDbId], 'consumed');

        getUserMessagesByStatusSpy.mockClear();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'enqueued');
      });

      it('does nothing when no persisted message matches the yielded uuid and leaves the fallback', async () => {
        statusSpy('none');
        mockMessageQueue.onMessageYielded?.(ackUuid, yieldAt);
        expect(updateMessageStatusSpy).not.toHaveBeenCalledWith([ackDbId], 'consumed');

        getUserMessagesByStatusSpy.mockClear();
        await handler.handleMessage(ackResult);
        expect(getUserMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'enqueued');
      });
    });

    describe('acknowledgeOldestQueuedUserOnTurnEnd decision table', () => {
      const turnUuid = 'turn-end-uuid';
      const turnDbId = 'db-turn-end';
      const turnUser = {
        dbId: turnDbId,
        uuid: turnUuid,
        type: 'user',
        timestamp: 1700000000000,
        message: { role: 'user', content: [{ type: 'text', text: 'turn end' }] },
      };

      function makeResultMessage(): SDKMessage {
        return {
          type: 'result',
          subtype: 'success',
          uuid: 'result-uuid',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          modelUsage: {},
        } as unknown as SDKMessage;
      }

      function setTurnEndState(options: {
        durable: boolean;
        yielded: boolean;
        pending: boolean;
        active: boolean;
      }) {
        getUserMessagesByStatusSpy.mockImplementation((sessionId: string, status: string) => {
          if (sessionId === 'test-session-id' && status === 'enqueued') {
            return { messages: [turnUser], total: 1 };
          }
          return { messages: [], total: 0 };
        });

        const activeMessageId = options.active ? turnUuid : 'other-uuid';
        getStateSpy.mockReturnValue({
          status: 'processing',
          messageId: activeMessageId,
          phase: 'streaming',
        });

        if (options.durable) {
          mockDb.getJobQueueRepo = mock(() => ({
            activeDeliveryMessageUuids: () => new Set([turnUuid]),
            getActiveDeliveryBatchUuids: () => [turnUuid],
          })) as never;
        } else {
          mockDb.getJobQueueRepo = mock(() => ({
            activeDeliveryMessageUuids: () => new Set<string>(),
          })) as never;
        }

        hasYieldedSpy.mockImplementation((id: string) => id === turnUuid && options.yielded);
        hasPendingOrClaimedSpy.mockImplementation(
          (id: string) => id === turnUuid && options.pending
        );
        acknowledgeYieldedSpy.mockImplementation(
          (id: string) => id === turnUuid && options.yielded
        );
      }

      async function runRow(options: {
        durable: boolean;
        yielded: boolean;
        pending: boolean;
        active: boolean;
        expected: boolean;
      }) {
        const markConsumedSpy = mock(() => ({ ids: [turnDbId], uuids: [turnUuid] }));
        mockDb.getSDKMessageRepo = mock(() => ({
          markDeliveriesConsumedAtTurnEnd: markConsumedSpy,
        })) as never;

        setTurnEndState(options);
        await handler.handleMessage(makeResultMessage());
        return markConsumedSpy;
      }

      it('acknowledges a non-durable, non-yielded, non-pending message', async () => {
        const markConsumed = await runRow({
          durable: false,
          yielded: false,
          pending: false,
          active: false,
          expected: true,
        });
        expect(markConsumed).toHaveBeenCalledWith('test-session-id', [turnUuid], 'result-uuid');
      });

      it('acknowledges an active non-durable, non-yielded, non-pending message', async () => {
        const markConsumed = await runRow({
          durable: false,
          yielded: false,
          pending: false,
          active: true,
          expected: true,
        });
        expect(markConsumed).toHaveBeenCalledWith('test-session-id', [turnUuid], 'result-uuid');
      });

      it('acknowledges an inactive yielded non-durable message', async () => {
        const markConsumed = await runRow({
          durable: false,
          yielded: true,
          pending: false,
          active: false,
          expected: true,
        });
        expect(markConsumed).toHaveBeenCalledWith('test-session-id', [turnUuid], 'result-uuid');
        expect(acknowledgeYieldedSpy).toHaveBeenCalledWith(turnUuid);
      });

      it('acknowledges a yielded non-durable message that is also active', async () => {
        const markConsumed = await runRow({
          durable: false,
          yielded: true,
          pending: false,
          active: true,
          expected: true,
        });
        expect(markConsumed).toHaveBeenCalledWith('test-session-id', [turnUuid], 'result-uuid');
        expect(acknowledgeYieldedSpy).toHaveBeenCalledWith(turnUuid);
      });

      it('skips a durable message that is not yielded', async () => {
        const markConsumed = await runRow({
          durable: true,
          yielded: false,
          pending: false,
          active: false,
          expected: false,
        });
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('skips a durable message that is active but not yielded', async () => {
        const markConsumed = await runRow({
          durable: true,
          yielded: false,
          pending: false,
          active: true,
          expected: false,
        });
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('skips a durable yielded message that is not the active turn message', async () => {
        const markConsumed = await runRow({
          durable: true,
          yielded: true,
          pending: false,
          active: false,
          expected: false,
        });
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('acknowledges a durable yielded message that is the active turn message', async () => {
        const markConsumed = await runRow({
          durable: true,
          yielded: true,
          pending: false,
          active: true,
          expected: true,
        });
        expect(markConsumed).toHaveBeenCalledWith('test-session-id', [turnUuid], 'result-uuid');
        expect(acknowledgeYieldedSpy).toHaveBeenCalledWith(turnUuid);
      });

      it('skips a durable yielded active message that is pending or claimed', async () => {
        const markConsumed = await runRow({
          durable: true,
          yielded: true,
          pending: true,
          active: true,
          expected: false,
        });
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('skips a non-durable message that is pending or claimed', async () => {
        const markConsumed = await runRow({
          durable: false,
          yielded: false,
          pending: true,
          active: false,
          expected: false,
        });
        expect(markConsumed).not.toHaveBeenCalled();
      });

      it('finds no enqueued users when the persisted row has another sendStatus', async () => {
        getUserMessagesByStatusSpy.mockImplementation((_sessionId: string, status: string) => {
          if (status === 'submitted') {
            return { messages: [turnUser], total: 1 };
          }
          return { messages: [], total: 0 };
        });

        const markConsumedSpy = mock(() => ({ ids: [turnDbId], uuids: [turnUuid] }));
        mockDb.getSDKMessageRepo = mock(() => ({
          markDeliveriesConsumedAtTurnEnd: markConsumedSpy,
        })) as never;

        await handler.handleMessage(makeResultMessage());

        expect(getUserMessagesByStatusSpy).toHaveBeenCalledWith('test-session-id', 'enqueued');
        expect(markConsumedSpy).not.toHaveBeenCalled();
      });
    });
  });
});
