import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { createWebSocketHandlers } from '../../../../src/routes/setup-websocket';
import { MessageType } from '@hyperneo/shared';

interface MockWebSocket {
  data: {
    connectionSessionId: string;
    clientId?: string;
    joinedChannels?: Set<string>;
  };
  send: ReturnType<typeof mock>;
  readyState: number;
}

interface MockTransport {
  registerClient: ReturnType<typeof mock>;
  unregisterClient: ReturnType<typeof mock>;
  updateClientActivity: ReturnType<typeof mock>;
  verifyChannelMembership: ReturnType<typeof mock>;
  handleClientMessage: ReturnType<typeof mock>;
}

interface MockSessionManager {
  getSessionAsync: ReturnType<typeof mock>;
}

describe('createWebSocketHandlers', () => {
  let mockTransport: MockTransport;
  let mockSessionManager: MockSessionManager;
  let handlers: ReturnType<typeof createWebSocketHandlers>;

  beforeEach(() => {
    mockTransport = {
      registerClient: mock(() => 'client-123'),
      unregisterClient: mock(),
      updateClientActivity: mock(),
      verifyChannelMembership: mock(),
      handleClientMessage: mock(),
    };

    mockSessionManager = {
      getSessionAsync: mock(async () => ({ id: 'session-1' })),
      getSessionForControl: mock(async () => ({ id: 'session-1' })),
    };

    handlers = createWebSocketHandlers(
      mockTransport as unknown as Parameters<typeof createWebSocketHandlers>[0],
      mockSessionManager as unknown as Parameters<typeof createWebSocketHandlers>[1]
    );
  });

  afterEach(() => {
    mockTransport.registerClient.mockClear();
    mockTransport.unregisterClient.mockClear();
    mockTransport.updateClientActivity.mockClear();
    mockTransport.verifyChannelMembership.mockClear();
    mockTransport.handleClientMessage.mockClear();
    mockSessionManager.getSessionAsync.mockClear();
  });

  describe('open handler', () => {
    it('should register client with transport', () => {
      const ws: MockWebSocket = {
        data: { connectionSessionId: 'global' },
        send: mock(),
        readyState: 1,
      };

      handlers.open(ws as unknown as Parameters<typeof handlers.open>[0]);

      expect(mockTransport.registerClient).toHaveBeenCalledTimes(1);
      expect(mockTransport.registerClient).toHaveBeenCalledWith(ws, 'global');
    });

    it('should store clientId on websocket data', () => {
      const ws: MockWebSocket = {
        data: { connectionSessionId: 'global' },
        send: mock(),
        readyState: 1,
      };

      handlers.open(ws as unknown as Parameters<typeof handlers.open>[0]);

      expect(ws.data.clientId).toBe('client-123');
    });

    it('should send connection.established event', () => {
      const ws: MockWebSocket = {
        data: { connectionSessionId: 'global' },
        send: mock(),
        readyState: 1,
      };

      handlers.open(ws as unknown as Parameters<typeof handlers.open>[0]);

      expect(ws.send).toHaveBeenCalledTimes(1);

      const sentMessage = JSON.parse(ws.send.mock.calls[0][0] as string);
      expect(sentMessage.type).toBe('EVENT');
      expect(sentMessage.method).toBe('connection.established');
      expect(sentMessage.data.message).toBe('WebSocket connection established');
      expect(sentMessage.data.protocol).toBe('MessageHub');
      expect(sentMessage.data.version).toBe('1.0.0');
    });
  });

  describe('message handler', () => {
    describe('ping/pong handling', () => {
      it('should respond to ping with pong', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        const pingMessage = JSON.stringify({
          id: 'ping-1',
          type: 'ping',
          namespaceId: 'global',
          sessionId: 'global',
        });

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          pingMessage
        );

        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentMessage = JSON.parse(ws.send.mock.calls[0][0] as string);
        expect(sentMessage.type).toBe(MessageType.PONG);
        expect(sentMessage.requestId).toBe('ping-1');
        expect(sentMessage.method).toBe('heartbeat');
      });

      it('should respond to PING (uppercase) with pong', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        const pingMessage = JSON.stringify({
          id: 'ping-2',
          type: 'PING',
          namespaceId: 'global',
          sessionId: 'global',
        });

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          pingMessage
        );

        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentMessage = JSON.parse(ws.send.mock.calls[0][0] as string);
        expect(sentMessage.type).toBe(MessageType.PONG);
      });

      it('should update client activity on ping', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({ type: 'ping', sessionId: 'global' })
        );

        expect(mockTransport.updateClientActivity).toHaveBeenCalledWith('client-123');
      });

      it('should verify channel membership on ping (self-healing)', async () => {
        const ws: MockWebSocket = {
          data: {
            connectionSessionId: 'global',
            clientId: 'client-123',
            joinedChannels: new Set(['session-1', 'session-2']),
          },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({ type: 'ping', sessionId: 'global' })
        );

        expect(mockTransport.verifyChannelMembership).toHaveBeenCalledWith('client-123', [
          'global',
          'session-1',
          'session-2',
        ]);
      });

      it('should use global sessionId for pong if not provided in ping', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({ type: 'ping' })
        );

        const sentMessage = JSON.parse(ws.send.mock.calls[0][0] as string);
        expect(sentMessage.sessionId).toBe('global');
      });
    });

    describe('session validation', () => {
      it('should return error for non-existent session', async () => {
        mockSessionManager.getSessionAsync.mockImplementation(async () => null);
        mockSessionManager.getSessionForControl.mockImplementation(async () => null);

        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            id: 'req-1',
            type: 'REQ',
            method: 'test.method',
            sessionId: 'non-existent-session',
          })
        );

        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentMessage = JSON.parse(ws.send.mock.calls[0][0] as string);
        expect(sentMessage.type).toBe('RSP');
        expect(sentMessage.errorCode).toBe('SESSION_NOT_FOUND');
        expect(sentMessage.error).toContain('Session not found');
      });

      it('should skip session validation for global session', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            id: 'req-1',
            type: 'REQ',
            method: 'test.method',
            namespaceId: 'global',
            sessionId: 'global',
          })
        );

        expect(mockSessionManager.getSessionAsync).not.toHaveBeenCalled();
        expect(mockTransport.handleClientMessage).toHaveBeenCalled();
      });

      it('should default to global sessionId when not provided', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            id: 'req-1',
            type: 'REQ',
            method: 'test.method',
          })
        );

        expect(mockTransport.handleClientMessage).toHaveBeenCalled();
      });
    });

    describe('channel tracking', () => {
      it('should track channel.join', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            type: 'REQ',
            method: 'channel.join',
            namespaceId: 'global',
            sessionId: 'global',
            data: { channel: 'session-new' },
          })
        );

        expect(ws.data.joinedChannels).toBeDefined();
        expect(ws.data.joinedChannels!.has('session-new')).toBe(true);
      });

      it('should track multiple channel joins', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            type: 'REQ',
            method: 'channel.join',
            namespaceId: 'global',
            sessionId: 'global',
            data: { channel: 'session-1' },
          })
        );

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            type: 'REQ',
            method: 'channel.join',
            namespaceId: 'global',
            sessionId: 'global',
            data: { channel: 'session-2' },
          })
        );

        expect(ws.data.joinedChannels!.has('session-1')).toBe(true);
        expect(ws.data.joinedChannels!.has('session-2')).toBe(true);
        expect(ws.data.joinedChannels!.size).toBe(2);
      });

      it('should track channel.leave', async () => {
        const ws: MockWebSocket = {
          data: {
            connectionSessionId: 'global',
            clientId: 'client-123',
            joinedChannels: new Set(['session-1', 'session-2']),
          },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            type: 'REQ',
            method: 'channel.leave',
            namespaceId: 'global',
            sessionId: 'global',
            data: { channel: 'session-1' },
          })
        );

        expect(ws.data.joinedChannels!.has('session-1')).toBe(false);
        expect(ws.data.joinedChannels!.has('session-2')).toBe(true);
      });
    });

    describe('message size validation', () => {
      it('should reject messages larger than 50MB', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        const largeContent = 'x'.repeat(51 * 1024 * 1024);
        const largeMessage = JSON.stringify({
          type: 'REQ',
          method: 'test.method',
          namespaceId: 'global',
          sessionId: 'global',
          data: { content: largeContent },
        });

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          largeMessage
        );

        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentMessage = JSON.parse(ws.send.mock.calls[0][0] as string);
        expect(sentMessage.type).toBe('RSP');
        expect(sentMessage.errorCode).toBe('MESSAGE_TOO_LARGE');
        expect(sentMessage.error).toContain('exceeds maximum');
      });

      it('should accept messages smaller than 50MB', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            type: 'REQ',
            method: 'test.method',
            namespaceId: 'global',
            sessionId: 'global',
            data: { content: 'small content' },
          })
        );

        expect(mockTransport.handleClientMessage).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle invalid JSON gracefully', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          'not valid json'
        );

        expect(ws.send).toHaveBeenCalledTimes(1);
        const sentMessage = JSON.parse(ws.send.mock.calls[0][0] as string);
        expect(sentMessage.type).toBe('RSP');
        expect(sentMessage.errorCode).toBe('INVALID_MESSAGE');
      });

      it('should handle Buffer messages', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        const bufferMessage = Buffer.from(
          JSON.stringify({
            type: 'REQ',
            method: 'test.method',
            namespaceId: 'global',
            sessionId: 'global',
          })
        );

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          bufferMessage
        );

        expect(mockTransport.handleClientMessage).toHaveBeenCalled();
      });

      it('should handle messages without clientId', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global' },
          send: mock(),
          readyState: 1,
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify({
            type: 'REQ',
            method: 'test.method',
            namespaceId: 'global',
            sessionId: 'global',
          })
        );

        expect(mockTransport.handleClientMessage).not.toHaveBeenCalled();
      });
    });

    describe('message passing to transport', () => {
      it('should pass valid messages to transport', async () => {
        const ws: MockWebSocket = {
          data: { connectionSessionId: 'global', clientId: 'client-123' },
          send: mock(),
          readyState: 1,
        };

        const message = {
          id: 'req-1',
          type: 'REQ',
          method: 'test.method',
          namespaceId: 'global',
          sessionId: 'global',
          data: { key: 'value' },
        };

        await handlers.message(
          ws as unknown as Parameters<typeof handlers.message>[0],
          JSON.stringify(message)
        );

        expect(mockTransport.handleClientMessage).toHaveBeenCalledTimes(1);

        expect(mockTransport.handleClientMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'req-1',
            type: 'REQ',
            method: 'test.method',
            namespaceId: 'global',
            sessionId: 'global',
          }),
          'client-123'
        );
      });
    });
  });

  describe('close handler', () => {
    it('should unregister client on close', () => {
      const ws: MockWebSocket = {
        data: { connectionSessionId: 'global', clientId: 'client-123' },
        send: mock(),
        readyState: 3,
      };

      handlers.close(ws as unknown as Parameters<typeof handlers.close>[0]);

      expect(mockTransport.unregisterClient).toHaveBeenCalledWith('client-123');
    });

    it('should handle close without clientId', () => {
      const ws: MockWebSocket = {
        data: { connectionSessionId: 'global' },
        send: mock(),
        readyState: 3,
      };

      handlers.close(ws as unknown as Parameters<typeof handlers.close>[0]);

      expect(mockTransport.unregisterClient).not.toHaveBeenCalled();
    });
  });

  describe('error handler', () => {
    it('should unregister client on error', () => {
      const ws: MockWebSocket = {
        data: { connectionSessionId: 'global', clientId: 'client-123' },
        send: mock(),
        readyState: 1,
      };

      const error = new Error('WebSocket error');
      handlers.error(ws as unknown as Parameters<typeof handlers.error>[0], error);

      expect(mockTransport.unregisterClient).toHaveBeenCalledWith('client-123');
    });

    it('should handle error without clientId', () => {
      const ws: MockWebSocket = {
        data: { connectionSessionId: 'global' },
        send: mock(),
        readyState: 1,
      };

      const error = new Error('WebSocket error');
      handlers.error(ws as unknown as Parameters<typeof handlers.error>[0], error);

      expect(mockTransport.unregisterClient).not.toHaveBeenCalled();
    });
  });
});
