import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub.ts';
import { MessageHubRouter } from '../src/message-hub/router.ts';
import type { IMessageTransport, ConnectionState } from '../src/message-hub/types.ts';
import {
  MessageType,
  createEventMessage,
  createRequestMessage,
  type HubMessage,
} from '../src/message-hub/protocol.ts';

class MockTransport implements IMessageTransport {
  name = 'mock-transport';
  private messageHandler: ((message: HubMessage) => void) | null = null;
  private connectionHandler: ((state: ConnectionState, error?: Error) => void) | null = null;
  private _state: ConnectionState = 'connected';
  public sentMessages: HubMessage[] = [];

  async initialize(): Promise<void> {}

  async close(): Promise<void> {
    this._state = 'disconnected';
  }

  send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);
    return Promise.resolve();
  }

  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandler = handler;
    return () => {
      this.messageHandler = null;
    };
  }

  onConnectionChange(handler: (state: ConnectionState, error?: Error) => void): () => void {
    this.connectionHandler = handler;
    return () => {
      this.connectionHandler = null;
    };
  }

  getState(): ConnectionState {
    return this._state;
  }

  isReady(): boolean {
    return this._state === 'connected';
  }

  simulateMessage(message: HubMessage): void {
    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }

  simulateConnectionChange(state: ConnectionState, error?: Error): void {
    this._state = state;
    if (this.connectionHandler) {
      this.connectionHandler(state, error);
    }
  }

  disconnect(): void {
    this._state = 'disconnected';
  }

  reconnect(): void {
    this._state = 'connected';
    if (this.connectionHandler) {
      this.connectionHandler('connected');
    }
  }
}

describe('MessageHub - Coverage Tests', () => {
  let hub: MessageHub;
  let transport: MockTransport;

  beforeEach(() => {
    hub = new MessageHub();
    transport = new MockTransport();
    hub.registerTransport(transport);
  });

  afterEach(() => {
    hub.cleanup();
  });

  describe('Router Management', () => {
    test('should allow replacing existing router', () => {
      const router1 = new MessageHubRouter();
      const router2 = new MessageHubRouter();

      hub.registerRouter(router1);
      hub.registerRouter(router2);

      expect(hub.getRouter()).toBe(router2);
    });

    test('should return registered router', () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);
      expect(hub.getRouter()).toBe(router);
    });

    test('should return null when no router registered', () => {
      expect(hub.getRouter()).toBeNull();
    });
  });

  describe('Request Handler Error Handling', () => {
    test('should send error response when handler throws', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      let handlerCalled = false;
      const handler = jest.fn(() => {
        handlerCalled = true;
        throw new Error('Handler error');
      });

      hub.onRequest('test.request', handler);

      const requestMessage = createRequestMessage({
        method: 'test.request',
        data: { test: true },
        sessionId: 'test-session',
      });

      transport.simulateMessage(requestMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalled();
      expect(handlerCalled).toBe(true);

      const errorResponses = transport.sentMessages.filter(
        (m) => m.type === MessageType.RESPONSE && m.error
      );
      expect(errorResponses.length).toBe(1);
      expect(errorResponses[0].error).toContain('Handler error');

      consoleErrorSpy.mockRestore();
    });

    test('should send error response when no handler registered', async () => {
      const requestMessage = createRequestMessage({
        method: 'no.handler',
        data: {},
        sessionId: 'test-session',
      });

      expect(() => transport.simulateMessage(requestMessage)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const errorResponses = transport.sentMessages.filter(
        (m) => m.type === MessageType.RESPONSE && m.error
      );
      expect(errorResponses.length).toBe(1);
      expect(errorResponses[0].error).toContain('No handler for method');
    });
  });

  describe('Query Handler Error Handling', () => {
    test('should send error response when query handler throws', async () => {
      const handler = jest.fn(async () => {
        throw new Error('Query handler error');
      });

      hub.onRequest('test.query', handler);

      const queryMessage = createRequestMessage({
        method: 'test.query',
        data: {},
        sessionId: 'test-session',
      });

      transport.simulateMessage(queryMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalled();

      const errorResponses = transport.sentMessages.filter(
        (m) => m.type === MessageType.RESPONSE && m.error
      );
      expect(errorResponses.length).toBe(1);
      expect(errorResponses[0].error).toContain('Query handler error');
    });

    test('should send METHOD_NOT_FOUND error when no query handler registered', async () => {
      const queryMessage = createRequestMessage({
        method: 'no.handler',
        data: {},
        sessionId: 'test-session',
      });

      transport.simulateMessage(queryMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const errorResponses = transport.sentMessages.filter(
        (m) => m.type === MessageType.RESPONSE && m.error
      );
      expect(errorResponses.length).toBe(1);
      expect(errorResponses[0].error).toContain('No handler for method');
    });
  });

  describe('Event Handler Error Handling', () => {
    test('should catch event handler errors and continue', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      let handler1Called = false;
      let handler2Called = false;

      const handler1 = jest.fn(() => {
        handler1Called = true;
        throw new Error('Handler 1 error');
      });
      const handler2 = jest.fn(() => {
        handler2Called = true;
      });

      hub.onEvent('test.event', handler1);
      hub.onEvent('test.event', handler2);

      const eventMessage = createEventMessage({
        method: 'test.event',
        data: { test: true },
        sessionId: 'test-session',
      });

      transport.simulateMessage(eventMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    test('should handle event with no handlers registered', async () => {
      const eventMessage = createEventMessage({
        method: 'no.handler',
        data: {},
        sessionId: 'test-session',
      });

      expect(() => transport.simulateMessage(eventMessage)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  describe('PING/PONG Handling', () => {
    test('should respond to PING with PONG', async () => {
      const pingMsg: HubMessage = {
        id: 'ping-123',
        type: MessageType.PING,
        sessionId: 'test-session',
        method: 'heartbeat',
        timestamp: new Date().toISOString(),
      };

      transport.simulateMessage(pingMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const pongs = transport.sentMessages.filter((m) => m.type === MessageType.PONG);
      expect(pongs.length).toBe(1);
      expect(pongs[0].requestId).toBe('ping-123');
    });

    test('should handle PONG message', async () => {
      const pongMsg: HubMessage = {
        id: 'pong-123',
        type: MessageType.PONG,
        sessionId: 'test-session',
        method: 'heartbeat',
        requestId: 'ping-123',
        timestamp: new Date().toISOString(),
      };

      transport.simulateMessage(pongMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe('Event Depth Tracking Cleanup', () => {
    test('should cleanup event depth map after handling', async () => {
      const handler = jest.fn();
      hub.onEvent('test.event', handler);

      const eventMsg = createEventMessage({
        method: 'test.event',
        data: { test: true },
        sessionId: 'test-session',
      });

      transport.simulateMessage(eventMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(hub['eventDepthMap'].size).toBe(0);
    });

    test('should cleanup depth map even if handler throws', async () => {
      const handler = jest.fn(() => {
        throw new Error('Handler error');
      });

      hub.onEvent('test.event', handler);

      const eventMsg = createEventMessage({
        method: 'test.event',
        data: { test: true },
        sessionId: 'test-session',
      });

      transport.simulateMessage(eventMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(hub['eventDepthMap'].size).toBe(0);
    });

    test('should prevent infinite event recursion', async () => {
      const handler = jest.fn();
      hub.onEvent('test.event', handler);

      const eventMsg = createEventMessage({
        method: 'test.event',
        data: { test: true },
        sessionId: 'test-session',
      });

      const maxDepth = (hub as unknown as { maxEventDepth: number }).maxEventDepth;
      hub['eventDepthMap'].set(eventMsg.id, maxDepth);

      transport.simulateMessage(eventMsg);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Room Command Handling', () => {
    test('should handle room.join command with router', async () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);

      const mockConnection = {
        id: 'client-1',
        send: jest.fn(),
        isOpen: () => true,
      };
      router.registerConnection(mockConnection);

      const joinMsg = createRequestMessage({
        method: 'room.join',
        data: { channel: 'test-room' },
        sessionId: 'test-session',
      });
      (joinMsg as unknown as { clientId: string }).clientId = 'client-1';

      transport.simulateMessage(joinMsg);

      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test('should handle room.leave command with router', async () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);

      const mockConnection = {
        id: 'client-1',
        send: jest.fn(),
        isOpen: () => true,
      };
      router.registerConnection(mockConnection);

      const joinMsg = createRequestMessage({
        method: 'room.join',
        data: { channel: 'test-room' },
        sessionId: 'test-session',
      });
      (joinMsg as unknown as { clientId: string }).clientId = 'client-1';
      transport.simulateMessage(joinMsg);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const leaveMsg = createRequestMessage({
        method: 'room.leave',
        data: { channel: 'test-room' },
        sessionId: 'test-session',
      });
      (leaveMsg as unknown as { clientId: string }).clientId = 'client-1';
      transport.simulateMessage(leaveMsg);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test('should ignore room commands when no router registered', async () => {
      const joinMsg = createRequestMessage({
        method: 'room.join',
        data: { channel: 'test-room' },
        sessionId: 'test-session',
      });

      expect(() => transport.simulateMessage(joinMsg)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  describe('Additional Utility Methods', () => {
    test('should get pending call count', () => {
      expect(hub.getPendingCallCount()).toBe(0);

      hub.request('test.method', {}).catch(() => {});

      expect(hub.getPendingCallCount()).toBe(1);
    });
  });

  describe('Invalid Method Names', () => {
    test('should reject invalid method names in query', async () => {
      await expect(hub.request('', {})).rejects.toThrow('Invalid method name');
    });

    test('should reject invalid method names in command', () => {
      expect(() => {
        hub.event('', {});
      }).toThrow('Invalid method name');
    });

    test('should reject invalid method names in event', () => {
      expect(() => {
        hub.event('', {});
      }).toThrow('Invalid method name');
    });

    test('should reject invalid method names in onQuery', () => {
      expect(() => {
        hub.onRequest('', async () => ({}));
      }).toThrow('Invalid method name');
    });

    test('should reject invalid method names in onCommand', () => {
      expect(() => {
        hub.onRequest('', () => {});
      }).toThrow('Invalid method name');
    });

    test('should reject invalid method names in onEvent', () => {
      expect(() => {
        hub.onEvent('', () => {});
      }).toThrow('Invalid method name');
    });
  });

  describe('Backpressure Limits', () => {
    test('should enforce max pending calls limit', async () => {
      const hubWithLimit = new MessageHub({ maxPendingCalls: 2 });
      const limitTransport = new MockTransport();
      hubWithLimit.registerTransport(limitTransport);

      hubWithLimit.request('test.method1', {}).catch(() => {});
      hubWithLimit.request('test.method2', {}).catch(() => {});

      await expect(hubWithLimit.request('test.method3', {})).rejects.toThrow(
        'Too many pending calls'
      );

      hubWithLimit.cleanup();
    });
  });

  describe('Query Timeout on Disconnect', () => {
    test('should timeout queries when transport disconnects', async () => {
      const queryPromise = hub.request('test.method', {}, { timeout: 100 });

      await new Promise((resolve) => setTimeout(resolve, 10));

      transport.disconnect();

      await expect(queryPromise).rejects.toThrow('Request timeout');
    });
  });
});
