import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { ClearConversationCancelledError } from '../../../../src/lib/agent/agent-session';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import {
  QueryModeHandler,
  type QueryModeHandlerContext,
} from '../../../../src/lib/agent/query-mode-handler';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database as DatabaseImpl } from '../../../../src/storage/sqlite-compat';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';

function byStatusResult(messages: SDKMessage[]): { messages: SDKMessage[]; total: number } {
  return { messages, total: messages.length };
}

describe('QueryModeHandler', () => {
  let handler: QueryModeHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageQueue: MessageQueue;
  let mockLogger: Logger;

  let getUserMessagesByStatusSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let enqueueWithIdSpy: ReturnType<typeof mock>;
  let sizeSpy: ReturnType<typeof mock>;
  let hasPendingOrInFlightSpy: ReturnType<typeof mock>;
  let ensureQueryStartedSpy: ReturnType<typeof mock>;
  let v2Previous: string | undefined;

  beforeEach(() => {
    v2Previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
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

    getUserMessagesByStatusSpy = mock(() => ({ messages: [], total: 0 }));
    updateMessageStatusSpy = mock(() => {});
    mockDb = {
      getUserMessagesByStatus: getUserMessagesByStatusSpy,
      updateMessageStatus: updateMessageStatusSpy,
      getJobQueueRepo: () => ({ activeDeliveryMessageUuids: () => new Set<string>() }),
    } as unknown as Database;

    emitSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    enqueueWithIdSpy = mock(async () => {});
    sizeSpy = mock(() => 0);
    hasPendingOrInFlightSpy = mock(() => false);
    mockMessageQueue = {
      enqueueWithId: enqueueWithIdSpy,
      hasPendingOrInFlight: hasPendingOrInFlightSpy,
      size: sizeSpy,
    } as unknown as MessageQueue;

    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    ensureQueryStartedSpy = mock(async () => {});
  });

  afterEach(() => {
    if (v2Previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = v2Previous;
  });

  function createContext(): QueryModeHandlerContext {
    return {
      session: mockSession,
      db: mockDb,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      messageQueue: mockMessageQueue,
      logger: mockLogger,
      ensureQueryStarted: ensureQueryStartedSpy,
    };
  }

  function createHandler(): QueryModeHandler {
    return new QueryModeHandler(createContext());
  }

  describe('constructor', () => {
    it('should create handler with dependencies', () => {
      handler = createHandler();
      expect(handler).toBeDefined();
    });
  });

  describe('handleQueryTrigger', () => {
    it('should return success with 0 messages if no deferred messages', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult([]));
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 0 });
    });

    it('should update message status to enqueued', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'enqueued');
    });

    it('should emit messages.statusChanged event', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-1'],
        status: 'enqueued',
      });
    });

    it('should call ensureQueryStarted', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(ensureQueryStartedSpy).toHaveBeenCalled();
    });

    it('should enqueue messages with string content', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello world' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Hello world');
    });

    it('should enqueue messages with array content', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Line 1' },
              { type: 'text', text: 'Line 2' },
            ],
          },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Line 1\nLine 2');
    });

    it('should preserve image blocks when enqueueing deferred multimodal messages', async () => {
      const content = [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'abc' },
        },
        { type: 'text' as const, text: 'Describe this' },
      ];
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', content);
    });

    it('should skip non-user messages', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should skip messages without content', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      await handler.handleQueryTrigger();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should skip deferred rows without a resolvable uuid but still mark them enqueued', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-legacy',
          type: 'user',
          message: { role: 'user', content: 'Legacy row without uuid' },
        } as unknown as SDKMessage,
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-legacy', 'db-1'], 'enqueued');
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Hello');
    });

    it('should skip deferred rows with an empty uuid', async () => {
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-empty',
          uuid: '',
          type: 'user',
          message: { role: 'user', content: 'Empty uuid' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 1 });
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should return error on failure', async () => {
      getUserMessagesByStatusSpy.mockImplementation(() => {
        throw new Error('Database error');
      });
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({
        success: false,
        messageCount: 0,
        error: 'Database error',
      });
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to trigger query:', expect.any(Error));
    });

    it('should return message count on success', async () => {
      const savedMessages: SDKMessage[] = [
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'Hello' } },
        { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'World' } },
      ] as unknown as SDKMessage[];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(savedMessages));
      handler = createHandler();

      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
    });
  });

  describe('sendEnqueuedMessagesOnTurnEnd', () => {
    it('should return early if no enqueued messages', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult([]));
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('should enqueue enqueued messages', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Queued message' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(queuedMessages));
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(ensureQueryStartedSpy).toHaveBeenCalled();
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Queued message');
    });

    it('should skip enqueued messages already owned by the message queue', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Already queued' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(queuedMessages));
      hasPendingOrInFlightSpy.mockImplementation((uuid: string) => uuid === 'uuid-1');
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('should skip non-user messages', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'system',
          subtype: 'init',
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(queuedMessages));
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      getUserMessagesByStatusSpy.mockImplementation(() => {
        throw new Error('Database error');
      });
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send enqueued messages on turn end:',
        expect.any(Error)
      );
    });

    it('should process multiple enqueued messages', async () => {
      const queuedMessages: SDKMessage[] = [
        { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'First' } },
        {
          dbId: 'db-2',
          uuid: 'uuid-2',
          type: 'user',
          message: { role: 'user', content: 'Second' },
        },
      ] as unknown as SDKMessage[];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(queuedMessages));
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'First');
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-2', 'Second');
    });

    it('should preserve image blocks when replaying enqueued messages', async () => {
      const content = [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'abc' },
        },
        { type: 'text' as const, text: 'Describe this' },
      ];
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(queuedMessages));
      handler = createHandler();

      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', content);
    });
  });

  describe('replayPendingMessagesForImmediateMode', () => {
    it('should replay enqueued messages before deferred messages', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-enqueued-1',
          uuid: 'uuid-enqueued-1',
          type: 'user',
          message: { role: 'user', content: 'Current turn (enqueued)' },
        } as unknown as SDKMessage,
      ];
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-deferred-1',
          uuid: 'uuid-deferred-1',
          type: 'user',
          message: { role: 'user', content: 'Next turn (deferred)' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        status === 'enqueued' ? byStatusResult(queuedMessages) : byStatusResult(savedMessages)
      );
      handler = createHandler();

      await handler.replayPendingMessagesForImmediateMode();

      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
      expect(enqueueWithIdSpy.mock.calls[0]).toEqual([
        'uuid-enqueued-1',
        'Current turn (enqueued)',
      ]);
      expect(enqueueWithIdSpy.mock.calls[1]).toEqual(['uuid-deferred-1', 'Next turn (deferred)']);
    });
  });

  describe('replayPendingMessagesForAutomaticTurnEnd', () => {
    function waitingForInputStateManager() {
      return {
        getState: () => ({ status: 'waiting_for_input' }),
        setQueuedIfIdle: async () => false,
      };
    }

    it('skips replay entirely when queryMode is manual', async () => {
      mockSession.config.queryMode = 'manual';
      handler = createHandler();

      await handler.replayPendingMessagesForAutomaticTurnEnd();

      expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('skips replay when the session is waiting for user input', async () => {
      handler = new QueryModeHandler({
        ...createContext(),
        stateManager: waitingForInputStateManager(),
      });

      await handler.replayPendingMessagesForAutomaticTurnEnd();

      expect(getUserMessagesByStatusSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('replays with enqueued-first ordering when guards pass', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-enqueued-1',
          uuid: 'uuid-enqueued-1',
          type: 'user',
          message: { role: 'user', content: 'Current turn (enqueued)' },
        } as unknown as SDKMessage,
      ];
      const savedMessages: SDKMessage[] = [
        {
          dbId: 'db-deferred-1',
          uuid: 'uuid-deferred-1',
          type: 'user',
          message: { role: 'user', content: 'Next turn (deferred)' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        status === 'enqueued' ? byStatusResult(queuedMessages) : byStatusResult(savedMessages)
      );
      handler = createHandler();

      await handler.replayPendingMessagesForAutomaticTurnEnd();

      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
      expect(enqueueWithIdSpy.mock.calls[0]).toEqual([
        'uuid-enqueued-1',
        'Current turn (enqueued)',
      ]);
      expect(enqueueWithIdSpy.mock.calls[1]).toEqual(['uuid-deferred-1', 'Next turn (deferred)']);
    });

    it('proceeds when no state manager is available', async () => {
      const queuedMessages: SDKMessage[] = [
        {
          dbId: 'db-1',
          uuid: 'uuid-1',
          type: 'user',
          message: { role: 'user', content: 'Pending' },
        } as unknown as SDKMessage,
      ];
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        status === 'enqueued' ? byStatusResult(queuedMessages) : byStatusResult([])
      );
      handler = createHandler();

      await handler.replayPendingMessagesForAutomaticTurnEnd();

      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-1', 'Pending');
    });
  });

  describe('turn-end flush context reset (resetContextPerTurn slots)', () => {
    function deferredBatch(count: number): SDKMessage[] {
      return Array.from({ length: count }, (_, i) => ({
        dbId: `db-${i + 1}`,
        uuid: `uuid-${i + 1}`,
        type: 'user',
        isSynthetic: true,
        message: { role: 'user', content: `message ${i + 1}` },
      })) as unknown as SDKMessage[];
    }

    function resetSlotContext(clearSpy: ReturnType<typeof mock>): QueryModeHandlerContext {
      return {
        ...createContext(),
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      };
    }

    function resetSlotDb(): void {
      mockDb = {
        getUserMessagesByStatus: getUserMessagesByStatusSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getJobQueueRepo: () => ({
          activeDeliveryMessageUuids: () => new Set<string>(),
          hasActiveTurnDeliveryJob: () => false,
        }),
      } as unknown as Database;
    }

    it('clears exactly once before the first message of a deferred batch (v1)', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      enqueueWithIdSpy.mockImplementation(async (uuid: string) => {
        order.push(uuid);
      });
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(3)));
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      await handler.handleQueryTrigger();

      expect(order).toEqual(['clear', 'uuid-1', 'uuid-2', 'uuid-3']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('clears exactly once before replaying enqueued messages on turn end (v1)', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      enqueueWithIdSpy.mockImplementation(async (uuid: string) => {
        order.push(uuid);
      });
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(2)));
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(order).toEqual(['clear', 'uuid-1', 'uuid-2']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('never clears for a slot that does not reset context', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(3)));
      resetSlotDb();

      handler = new QueryModeHandler({
        ...createContext(),
        slotResetsContext: () => false,
        clearConversationContext: clearSpy,
      });
      await handler.handleQueryTrigger();

      expect(clearSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(3);
    });

    it('never clears on the first turn before prior context exists', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(3)));
      resetSlotDb();

      handler = new QueryModeHandler({
        ...createContext(),
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      });
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(clearSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(3);
    });

    it('never clears while another delivery job is active for the session', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(3)));
      resetSlotDb();
      mockDb = {
        getUserMessagesByStatus: getUserMessagesByStatusSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getJobQueueRepo: () => ({
          activeDeliveryMessageUuids: () => new Set<string>(['uuid-active']),
          hasActiveTurnDeliveryJob: () => false,
        }),
      } as unknown as Database;

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(clearSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).toHaveBeenLastCalledWith(['db-1', 'db-2', 'db-3'], 'deferred');
    });

    it('delivers a human-only backlog first and clears for the task input pending behind it', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      enqueueWithIdSpy.mockImplementation(async (uuid: string) => {
        order.push(uuid);
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-human',
            uuid: 'uuid-human',
            type: 'user',
            isSynthetic: false,
            inputKind: 'human',
            message: { role: 'user', content: 'a human follow-up' },
          },
        ] as unknown as SDKMessage[])
      );
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      const result = await handler.handleQueryTrigger({ pendingTaskInput: true });

      expect(result).toEqual({ success: true, messageCount: 1 });
      expect(order).toEqual(['uuid-human', 'clear']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('defers task rows without clearing while the memory queue is mid-turn', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-human',
            uuid: 'uuid-human',
            type: 'user',
            isSynthetic: false,
            inputKind: 'human',
            message: { role: 'user', content: 'a human follow-up' },
          },
          ...deferredBatch(2),
        ] as unknown as SDKMessage[])
      );
      resetSlotDb();
      sizeSpy.mockImplementation(() => 1);

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(clearSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-human', 'a human follow-up');
      expect(updateMessageStatusSpy).toHaveBeenLastCalledWith(['db-1', 'db-2'], 'deferred');
    });

    it('defers task rows while the leading human row turn is still processing', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-human',
            uuid: 'uuid-human',
            type: 'user',
            isSynthetic: false,
            inputKind: 'human',
            message: { role: 'user', content: 'a human follow-up' },
          },
          ...deferredBatch(2),
        ] as unknown as SDKMessage[])
      );
      resetSlotDb();
      sizeSpy.mockImplementation(() => 0);

      handler = new QueryModeHandler({
        ...resetSlotContext(clearSpy),
        stateManager: {
          setQueuedIfIdle: async () => false,
          getState: () => ({ status: 'processing' }),
        },
      });
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(clearSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-human', 'a human follow-up');
      expect(updateMessageStatusSpy).toHaveBeenLastCalledWith(['db-1', 'db-2'], 'deferred');
    });

    it('re-triggers the deferred flush after the blocking delivery job settles', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      enqueueWithIdSpy.mockImplementation(async (uuid: string) => {
        order.push(uuid);
      });
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(1)));
      resetSlotDb();
      let jobActive = true;
      setTimeout(() => {
        jobActive = false;
      }, 50);
      mockDb = {
        getUserMessagesByStatus: getUserMessagesByStatusSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getJobQueueRepo: () => ({
          activeDeliveryMessageUuids: () => (jobActive ? new Set(['uuid-active']) : new Set()),
          hasActiveTurnDeliveryJob: () => false,
        }),
      } as unknown as Database;

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      await handler.replayPendingMessagesForImmediateMode();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(order).toEqual(['clear', 'uuid-1']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('delivers leading human rows before the clear that fronts the task rows', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      enqueueWithIdSpy.mockImplementation(async (uuid: string) => {
        order.push(uuid);
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-human',
            uuid: 'uuid-human',
            type: 'user',
            isSynthetic: false,
            inputKind: 'human',
            message: { role: 'user', content: 'a human follow-up' },
          },
          ...deferredBatch(2),
        ] as unknown as SDKMessage[])
      );
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(order).toEqual(['uuid-human', 'clear', 'uuid-1', 'uuid-2']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('never clears for human-only deliverables on a reset slot', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-human',
            uuid: 'uuid-human',
            type: 'user',
            isSynthetic: false,
            message: { role: 'user', content: 'a human follow-up' },
          },
        ] as unknown as SDKMessage[])
      );
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 1 });
      expect(clearSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).toHaveBeenCalledWith('uuid-human', 'a human follow-up');
    });

    it('replays mixed pending states behind exactly one clear at the front (v1)', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      enqueueWithIdSpy.mockImplementation(async (uuid: string) => {
        order.push(uuid);
      });
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        byStatusResult(
          status === 'enqueued'
            ? [
                {
                  dbId: 'db-enq',
                  uuid: 'uuid-enq',
                  type: 'user',
                  isSynthetic: true,
                  message: { role: 'user', content: 'queued task' },
                },
              ]
            : [
                {
                  dbId: 'db-def',
                  uuid: 'uuid-def',
                  type: 'user',
                  isSynthetic: true,
                  message: { role: 'user', content: 'deferred task' },
                },
              ]
        )
      );
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      await handler.replayPendingMessagesForImmediateMode();

      expect(order).toEqual(['clear', 'uuid-enq', 'uuid-def']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('skips the clear when no message is deliverable', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-owned',
            uuid: 'uuid-owned',
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'owned by the durable queue' },
          },
        ] as unknown as SDKMessage[])
      );
      resetSlotDb();
      mockDb = {
        getUserMessagesByStatus: getUserMessagesByStatusSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getJobQueueRepo: () => ({
          activeDeliveryMessageUuids: () => new Set<string>(['uuid-owned']),
          hasActiveTurnDeliveryJob: () => false,
        }),
      } as unknown as Database;

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 1 });
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('keeps flushing when the pre-flush clear fails (non-cancellation)', async () => {
      const clearSpy = mock(async () => {
        throw new Error('MessageQueueTimeoutError: /clear delivery timed out');
      });
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(3)));
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(String(mockLogger.warn.mock.calls[0][0])).toContain('flushing without clear');
    });

    it('aborts the flush when the pre-flush clear is cancelled by teardown', async () => {
      const clearSpy = mock(async () => {
        throw new ClearConversationCancelledError();
      });
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(3)));
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      await expect(handler.handleQueryTrigger()).rejects.toThrow('cancelled by query teardown');

      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('propagates a cancelled clear out of the enqueued-row turn-end replay', async () => {
      const clearSpy = mock(async () => {
        throw new ClearConversationCancelledError();
      });
      getUserMessagesByStatusSpy.mockReturnValue(byStatusResult(deferredBatch(2)));
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      await expect(handler.sendEnqueuedMessagesOnTurnEnd()).rejects.toThrow(
        'cancelled by query teardown'
      );

      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('clears before the deferred task when the enqueued replay carried only human rows', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      enqueueWithIdSpy.mockImplementation(async (uuid: string) => {
        order.push(uuid);
      });
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        byStatusResult(
          status === 'enqueued'
            ? [
                {
                  dbId: 'db-human',
                  uuid: 'uuid-human',
                  type: 'user',
                  isSynthetic: false,
                  inputKind: 'human',
                  message: { role: 'user', content: 'a human follow-up' },
                },
              ]
            : [
                {
                  dbId: 'db-task',
                  uuid: 'uuid-task',
                  type: 'user',
                  isSynthetic: true,
                  inputKind: 'task',
                  message: { role: 'user', content: 'the deferred task' },
                },
              ]
        )
      );
      resetSlotDb();

      handler = new QueryModeHandler(resetSlotContext(clearSpy));
      await handler.replayPendingMessagesForImmediateMode();

      expect(order).toEqual(['uuid-human', 'clear', 'uuid-task']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('durable delivery (v2 default) — task #861 item 3', () => {
    let jobQueue: JobQueueRepository;
    let jobsDb: Database;

    beforeEach(() => {
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
      jobsDb = new DatabaseImpl(':memory:');
      jobsDb.exec(`
        CREATE TABLE job_queue (
          id TEXT PRIMARY KEY,
          queue TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          payload TEXT NOT NULL DEFAULT '{}',
          result TEXT, error TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          retry_count INTEGER NOT NULL DEFAULT 0,
          run_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          heartbeat_at INTEGER, completed_at INTEGER
        );
        CREATE UNIQUE INDEX uq_message_delivery_active_turn
          ON job_queue (queue, json_extract(payload, '$.sessionId'))
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.role') = 'turn'
            AND status IN ('pending', 'processing');
      `);
      jobQueue = new JobQueueRepository(jobsDb as never);
      mockDb = {
        getUserMessagesByStatus: getUserMessagesByStatusSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getJobQueueRepo: () => jobQueue,
      } as unknown as Database;
    });

    afterEach(() => {
      jobsDb.close();
    });

    function deliveryUuids(): Array<{ uuid: string; role: string }> {
      return jobsDb
        .prepare(
          `SELECT json_extract(payload, '$.messageUuid') AS uuid,
                  json_extract(payload, '$.role') AS role
             FROM job_queue WHERE queue = 'message_delivery'
            ORDER BY created_at ASC`
        )
        .all() as Array<{ uuid: string; role: string }>;
    }

    it('handleQueryTrigger coalesces multiple deferred messages into ONE batched turn job', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2', 'db-3'], 'enqueued');
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].uuid).toBe('uuid-1');
      expect(jobs[0].role).toBe('turn');
      const row = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .get() as { payload: string };
      expect(JSON.parse(row.payload).batchUuids).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('handleQueryTrigger with deliverIndividually sends each deferred message as its own job', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger({ deliverIndividually: true });

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1', 'db-2', 'db-3'], 'enqueued');
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid)).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      expect(jobs.find((j) => j.uuid === 'uuid-1')?.role).toBe('turn');
      expect(jobs.filter((j) => j.role === 'steer')).toHaveLength(2);
      const payloads = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      expect(payloads.every((p) => !('batchUuids' in JSON.parse(p.payload)))).toBe(true);
    });

    it('handleQueryTrigger with excludeMessageUuid leaves the excluded row deferred', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger({
        deliverIndividually: true,
        excludeMessageUuid: 'uuid-2',
      });

      expect(result).toEqual({ success: true, messageCount: 1 });
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-1'], 'enqueued');
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid)).toEqual(['uuid-1']);
    });

    it('handleQueryTrigger creates durable ownership before publishing enqueued status', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
        ] as unknown as SDKMessage[])
      );
      let ownedWhenPublished = false;
      emitSpy.mockImplementation(async (event: string) => {
        if (event === 'messages.statusChanged') {
          ownedWhenPublished = jobQueue.activeDeliveryMessageUuids('test-session-id').has('uuid-1');
        }
      });

      handler = new QueryModeHandler(createContext());
      await handler.handleQueryTrigger();

      expect(ownedWhenPublished).toBe(true);
    });

    it('handleQueryTrigger publishes enqueued status when durable enqueue fails', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
        ] as unknown as SDKMessage[])
      );
      const enqueue = jobQueue.enqueue.bind(jobQueue);
      jobQueue.enqueue = mock(() => {
        throw new Error('queue unavailable');
      });

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: false, messageCount: 0, error: 'queue unavailable' });
      expect(emitSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-1'],
        status: 'enqueued',
      });
      jobQueue.enqueue = enqueue;
    });

    it('handleQueryTrigger falls back to per-message jobs when a turn is already active', async () => {
      jobQueue.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: 'test-session-id',
          messageUuid: 'uuid-active',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid).sort()).toEqual(['uuid-1', 'uuid-2', 'uuid-active']);
      expect(jobs.filter((j) => j.role === 'steer')).toHaveLength(2);
      const payloads = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      expect(payloads.every((p) => !('batchUuids' in JSON.parse(p.payload)))).toBe(true);
    });

    it('handleQueryTrigger does NOT batch a mixed flush (image between texts preserves queue order)', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          {
            dbId: 'db-2',
            uuid: 'uuid-2',
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'image', source: { type: 'base64' } }],
            },
          },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(3);
      expect(jobs.find((j) => j.uuid === 'uuid-1')?.role).toBe('turn');
      expect(jobs.find((j) => j.uuid === 'uuid-2')?.role).toBe('steer');
      expect(jobs.find((j) => j.uuid === 'uuid-3')?.role).toBe('steer');
      const payloads = jobsDb
        .prepare(`SELECT payload FROM job_queue WHERE queue = 'message_delivery'`)
        .all() as Array<{ payload: string }>;
      expect(payloads.every((p) => !('batchUuids' in JSON.parse(p.payload)))).toBe(true);
    });

    it('handleQueryTrigger does NOT batch a flush containing an SDK slash command', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-1',
            uuid: 'uuid-1',
            type: 'user',
            message: { role: 'user', content: '/compact' },
          },
          {
            dbId: 'db-2',
            uuid: 'uuid-2',
            type: 'user',
            message: { role: 'user', content: 'note' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 2 });
      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(2);
      expect(jobs.find((j) => j.uuid === 'uuid-1')?.role).toBe('turn');
      expect(jobs.find((j) => j.uuid === 'uuid-2')?.role).toBe('steer');
    });

    it('handleQueryTrigger skips batch-owned members in the per-message fallback (replay race)', async () => {
      jobQueue.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: 'test-session-id',
          messageUuid: 'uuid-1',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          batchUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        },
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'one' } },
          { dbId: 'db-2', uuid: 'uuid-2', type: 'user', message: { role: 'user', content: 'two' } },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      const jobs = deliveryUuids();
      expect(jobs.map((j) => j.uuid)).toEqual(['uuid-1']);
      expect(jobs[0].role).toBe('turn');
    });

    it('sendEnqueuedMessagesOnTurnEnd enqueues a durable job per enqueued message', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          { dbId: 'db-1', uuid: 'uuid-1', type: 'user', message: { role: 'user', content: 'q' } },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      await handler.sendEnqueuedMessagesOnTurnEnd();

      const jobs = deliveryUuids();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].uuid).toBe('uuid-1');
      expect(jobs[0].role).toBe('turn');
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('sendEnqueuedMessagesOnTurnEnd skips v2 delivery owned by the durable queue', async () => {
      jobQueue.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: 'test-session-id',
          messageUuid: 'uuid-owned',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-owned',
            uuid: 'uuid-owned',
            type: 'user',
            message: { role: 'user', content: 'already durable' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler(createContext());
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(deliveryUuids()).toEqual([{ uuid: 'uuid-owned', role: 'turn' }]);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('sendEnqueuedMessagesOnTurnEnd skips v2 delivery owned by the in-memory queue', async () => {
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-owned',
            uuid: 'uuid-owned',
            type: 'user',
            message: { role: 'user', content: 'already admitted' },
          },
        ] as unknown as SDKMessage[])
      );
      hasPendingOrInFlightSpy.mockImplementation((uuid: string) => uuid === 'uuid-owned');

      handler = new QueryModeHandler(createContext());
      await handler.sendEnqueuedMessagesOnTurnEnd();

      expect(deliveryUuids()).toEqual([]);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('excludes re-deferred task rows from the trailing enqueued announce', async () => {
      jobQueue.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: 'test-session-id',
          messageUuid: 'uuid-active',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-human',
            uuid: 'uuid-human',
            type: 'user',
            isSynthetic: false,
            inputKind: 'human',
            message: { role: 'user', content: 'a human follow-up' },
          },
          {
            dbId: 'db-task',
            uuid: 'uuid-task',
            type: 'user',
            isSynthetic: true,
            inputKind: 'task',
            message: { role: 'user', content: 'handoff' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler({
        ...createContext(),
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: async () => {},
      });
      await handler.handleQueryTrigger();

      const events = emitSpy.mock.calls
        .filter(([event]) => event === 'messages.statusChanged')
        .map(([, payload]) => payload as { status: string; messageIds: string[] });
      const enqueuedIds = events
        .filter((p) => p.status === 'enqueued')
        .flatMap((p) => p.messageIds);
      const deferredIds = events
        .filter((p) => p.status === 'deferred')
        .flatMap((p) => p.messageIds);
      expect(deferredIds).toEqual(['db-task']);
      expect(enqueuedIds).toContain('db-human');
      expect(enqueuedIds).not.toContain('db-task');
    });

    it('replay defers the deferred-task pass while the replayed human job is active', async () => {
      const clearSpy = mock(async () => {});
      getUserMessagesByStatusSpy.mockImplementation((_: string, status: string) =>
        byStatusResult(
          status === 'enqueued'
            ? [
                {
                  dbId: 'db-human',
                  uuid: 'uuid-human',
                  type: 'user',
                  isSynthetic: false,
                  inputKind: 'human',
                  message: { role: 'user', content: 'a human follow-up' },
                },
              ]
            : [
                {
                  dbId: 'db-task',
                  uuid: 'uuid-task',
                  type: 'user',
                  isSynthetic: true,
                  inputKind: 'task',
                  message: { role: 'user', content: 'the deferred task' },
                },
              ]
        )
      );

      handler = new QueryModeHandler({
        ...createContext(),
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      });
      await handler.replayPendingMessagesForImmediateMode();

      expect(clearSpy).not.toHaveBeenCalled();
      const jobs = deliveryUuids();
      expect(jobs).toEqual([{ uuid: 'uuid-human', role: 'turn' }]);
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
    });

    it('handleQueryTrigger clears exactly once before the durable batch job is created (#1085)', async () => {
      const order: string[] = [];
      const clearSpy = mock(async () => {
        order.push('clear');
      });
      const enqueue = jobQueue.enqueue.bind(jobQueue);
      jobQueue.enqueue = mock((...args: Parameters<typeof enqueue>) => {
        order.push('job');
        return enqueue(...args);
      });
      getUserMessagesByStatusSpy.mockReturnValue(
        byStatusResult([
          {
            dbId: 'db-1',
            uuid: 'uuid-1',
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'one' },
          },
          {
            dbId: 'db-2',
            uuid: 'uuid-2',
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'two' },
          },
          {
            dbId: 'db-3',
            uuid: 'uuid-3',
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'three' },
          },
        ] as unknown as SDKMessage[])
      );

      handler = new QueryModeHandler({
        ...createContext(),
        session: { ...mockSession, sdkSessionId: 'prior-sdk-session' },
        slotResetsContext: () => true,
        clearConversationContext: clearSpy,
      });
      const result = await handler.handleQueryTrigger();

      expect(result).toEqual({ success: true, messageCount: 3 });
      expect(order).toEqual(['clear', 'job']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(deliveryUuids()).toHaveLength(1);
      jobQueue.enqueue = enqueue;
    });
  });
});
