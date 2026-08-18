import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupTestHandlers } from '../../../../src/lib/rpc-handlers/test-handlers';
import type { Database } from '../../../../src/storage/database';
import type { SDKMessage } from '@hyperneo/shared/sdk';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;

  return { hub, handlers };
}

function createMockDatabase(): {
  db: Database;
  mocks: {
    saveSDKMessage: ReturnType<typeof mock>;
  };
} {
  const mocks = {
    saveSDKMessage: mock(() => {}),
  };

  return {
    db: {
      saveSDKMessage: mocks.saveSDKMessage,
    } as unknown as Database,
    mocks,
  };
}

describe('Test RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let dbData: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    dbData = createMockDatabase();

    setupTestHandlers(messageHubData.hub, dbData.db);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('test.injectSDKMessage', () => {
    it('injects SDK message and returns success', async () => {
      const handler = messageHubData.handlers.get('test.injectSDKMessage');
      expect(handler).toBeDefined();

      const message: SDKMessage = {
        uuid: 'msg-uuid-123',
        type: 'text',
        content: 'Test message content',
      } as SDKMessage;

      const result = (await handler!(
        {
          sessionId: 'session-123',
          message,
        },
        {}
      )) as { success: boolean; uuid: string };

      expect(result.success).toBe(true);
      expect(result.uuid).toBe('msg-uuid-123');
    });

    it('saves message to database', async () => {
      const handler = messageHubData.handlers.get('test.injectSDKMessage');
      expect(handler).toBeDefined();

      const message: SDKMessage = {
        uuid: 'msg-uuid-456',
        type: 'text',
        content: 'Another test message',
      } as SDKMessage;

      await handler!(
        {
          sessionId: 'session-456',
          message,
        },
        {}
      );

      expect(dbData.mocks.saveSDKMessage).toHaveBeenCalledWith('session-456', message);
    });

    it('broadcasts delta event with timestamp', async () => {
      const handler = messageHubData.handlers.get('test.injectSDKMessage');
      expect(handler).toBeDefined();

      const message: SDKMessage = {
        uuid: 'msg-uuid-789',
        type: 'text',
        content: 'Test message for broadcast',
      } as SDKMessage;

      await handler!(
        {
          sessionId: 'session-789',
          message,
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: expect.arrayContaining([
            expect.objectContaining({
              uuid: 'msg-uuid-789',
              timestamp: expect.any(Number),
            }),
          ]),
        }),
        { channel: 'session:session-789' }
      );
    });

    it('handles different message types', async () => {
      const handler = messageHubData.handlers.get('test.injectSDKMessage');
      expect(handler).toBeDefined();

      const toolUseMessage: SDKMessage = {
        uuid: 'tool-msg-123',
        type: 'tool_use',
        content: 'Read',
        toolUseId: 'tooluse-123',
      } as SDKMessage;

      const result = (await handler!(
        {
          sessionId: 'session-abc',
          message: toolUseMessage,
        },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('handles tool_result messages', async () => {
      const handler = messageHubData.handlers.get('test.injectSDKMessage');
      expect(handler).toBeDefined();

      const toolResultMessage: SDKMessage = {
        uuid: 'result-msg-456',
        type: 'tool_result',
        content: 'File contents here',
        toolUseId: 'tooluse-123',
      } as SDKMessage;

      const result = (await handler!(
        {
          sessionId: 'session-xyz',
          message: toolResultMessage,
        },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('adds timestamp to message for client merge logic', async () => {
      const handler = messageHubData.handlers.get('test.injectSDKMessage');
      expect(handler).toBeDefined();

      const beforeTime = Date.now();

      const message: SDKMessage = {
        uuid: 'timestamp-test',
        type: 'text',
        content: 'Testing timestamp',
      } as SDKMessage;

      await handler!(
        {
          sessionId: 'session-ts',
          message,
        },
        {}
      );

      const afterTime = Date.now();

      const eventCall = (messageHubData.hub.event as ReturnType<typeof mock>).mock.calls[0];
      const deltaData = eventCall[1] as { added: Array<{ timestamp: number }> };

      expect(deltaData.added[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(deltaData.added[0].timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('test.broadcastDelta', () => {
    it('broadcasts delta to specified channel', async () => {
      const handler = messageHubData.handlers.get('test.broadcastDelta');
      expect(handler).toBeDefined();

      await handler!(
        {
          sessionId: 'session-123',
          channel: 'state.custom.delta',
          data: { items: ['a', 'b', 'c'] },
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith(
        'state.custom.delta',
        { items: ['a', 'b', 'c'] },
        { channel: 'session:session-123' }
      );
    });

    it('broadcasts to correct session channel', async () => {
      const handler = messageHubData.handlers.get('test.broadcastDelta');
      expect(handler).toBeDefined();

      await handler!(
        {
          sessionId: 'different-session',
          channel: 'test.event',
          data: { key: 'value' },
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith(
        'test.event',
        { key: 'value' },
        { channel: 'session:different-session' }
      );
    });

    it('handles complex delta data', async () => {
      const handler = messageHubData.handlers.get('test.broadcastDelta');
      expect(handler).toBeDefined();

      const complexData = {
        added: [{ id: 1, name: 'Item 1' }],
        updated: [{ id: 2, name: 'Updated Item' }],
        removed: [3, 4, 5],
        timestamp: Date.now(),
      };

      await handler!(
        {
          sessionId: 'session-complex',
          channel: 'state.complex.delta',
          data: complexData,
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith('state.complex.delta', complexData, {
        channel: 'session:session-complex',
      });
    });

    it('handles empty delta data', async () => {
      const handler = messageHubData.handlers.get('test.broadcastDelta');
      expect(handler).toBeDefined();

      await handler!(
        {
          sessionId: 'session-empty',
          channel: 'state.empty.delta',
          data: {},
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith(
        'state.empty.delta',
        {},
        { channel: 'session:session-empty' }
      );
    });

    it('handles null delta data', async () => {
      const handler = messageHubData.handlers.get('test.broadcastDelta');
      expect(handler).toBeDefined();

      await handler!(
        {
          sessionId: 'session-null',
          channel: 'state.null.delta',
          data: null,
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith('state.null.delta', null, {
        channel: 'session:session-null',
      });
    });

    it('handles array delta data', async () => {
      const handler = messageHubData.handlers.get('test.broadcastDelta');
      expect(handler).toBeDefined();

      const arrayData = [1, 2, 3, 4, 5];

      await handler!(
        {
          sessionId: 'session-array',
          channel: 'state.array.delta',
          data: arrayData,
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith('state.array.delta', arrayData, {
        channel: 'session:session-array',
      });
    });

    it('handles string delta data', async () => {
      const handler = messageHubData.handlers.get('test.broadcastDelta');
      expect(handler).toBeDefined();

      await handler!(
        {
          sessionId: 'session-string',
          channel: 'state.string.delta',
          data: 'simple string data',
        },
        {}
      );

      expect(messageHubData.hub.event).toHaveBeenCalledWith(
        'state.string.delta',
        'simple string data',
        { channel: 'session:session-string' }
      );
    });
  });
});
