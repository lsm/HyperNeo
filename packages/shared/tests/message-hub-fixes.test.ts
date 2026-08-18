import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub';
import type { IMessageTransport, ConnectionState, HubMessage } from '../src/message-hub/types';
import { MessageType, createEventMessage, isValidMessage } from '../src/message-hub/protocol';

class MockTransport implements IMessageTransport {
  readonly name = 'mock-transport';
  private state: ConnectionState = 'connected';
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private stateHandlers: Set<(state: ConnectionState) => void> = new Set();
  public sentMessages: HubMessage[] = [];

  async initialize(): Promise<void> {
    this.state = 'connected';
    this.notifyStateChange('connected');
  }

  async close(): Promise<void> {
    this.state = 'disconnected';
    this.notifyStateChange('disconnected');
  }

  async send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === 'connected';
  }

  simulateMessage(message: HubMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  simulateStateChange(state: ConnectionState): void {
    this.state = state;
    this.notifyStateChange(state);
  }

  private notifyStateChange(state: ConnectionState): void {
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

describe('MessageHub Critical Fixes', () => {
  let messageHub: MessageHub;
  let transport: MockTransport;

  beforeEach(async () => {
    messageHub = new MessageHub({
      defaultSessionId: 'test-session',
    });

    transport = new MockTransport();
    messageHub.registerTransport(transport);
    await transport.initialize();
  });

  afterEach(() => {
    messageHub.cleanup();
  });

  describe('Runtime Message Validation', () => {
    test('should validate message structure', () => {
      const validMessage: HubMessage = {
        id: 'test-id',
        type: MessageType.EVENT,
        sessionId: 'test-session',
        method: 'test.method',
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(validMessage)).toBe(true);
    });

    test('should reject message with missing required fields', () => {
      const invalidMessage = {
        id: 'test-id',
        type: MessageType.EVENT,
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test('should reject message with invalid type', () => {
      const invalidMessage = {
        id: 'test-id',
        type: 'INVALID_TYPE',
        sessionId: 'test-session',
        method: 'test.method',
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test('should reject RESPONSE message without requestId', () => {
      const invalidMessage = {
        id: 'test-id',
        type: MessageType.RESPONSE,
        sessionId: 'test-session',
        method: 'test.method',
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test('should reject message with invalid method format', () => {
      const invalidMessage = {
        id: 'test-id',
        type: MessageType.EVENT,
        sessionId: 'test-session',
        method: 'invalid-no-dot',
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test('should reject message with colon in method name', () => {
      const invalidMessage = {
        id: 'test-id',
        type: MessageType.EVENT,
        sessionId: 'test-session',
        method: 'test:with.colon',
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });
  });

  describe('PING/PONG Handlers', () => {
    test('should respond to PING with PONG', async () => {
      transport.clearSentMessages();

      transport.simulateMessage({
        id: 'ping-id',
        type: MessageType.PING,
        sessionId: 'test-session',
        method: 'heartbeat',
        timestamp: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const pongMessages = transport.sentMessages.filter((m) => m.type === MessageType.PONG);

      expect(pongMessages.length).toBe(1);
      expect(pongMessages[0].requestId).toBe('ping-id');
      expect(pongMessages[0].sessionId).toBe('test-session');
    });

    test('should handle PONG messages without error', async () => {
      expect(() => {
        transport.simulateMessage({
          id: 'pong-id',
          type: MessageType.PONG,
          sessionId: 'test-session',
          method: 'heartbeat',
          requestId: 'original-ping-id',
          timestamp: new Date().toISOString(),
        });
      }).not.toThrow();
    });
  });

  describe('Method Name Validation', () => {
    test('should reject method names with colons in onQuery', () => {
      expect(() => {
        messageHub.onRequest('test:invalid.method', async () => ({}));
      }).toThrow();
    });

    test('should reject method names with colons in onRequest', () => {
      expect(() => {
        messageHub.onRequest('test:invalid.method', async () => ({}));
      }).toThrow();
    });

    test('should reject method names with colons in onEvent', () => {
      expect(() => {
        messageHub.onEvent('test:invalid.method', () => {});
      }).toThrow();
    });

    test('should accept valid method names', () => {
      expect(() => {
        messageHub.onRequest('test.valid-method_name', async () => ({}));
      }).not.toThrow();
    });

    test('should reject method names without dots', () => {
      expect(() => {
        messageHub.onRequest('testinvalid', async () => ({}));
      }).toThrow();
    });

    test('should reject method names starting with dot', () => {
      expect(() => {
        messageHub.onRequest('.test.invalid', async () => ({}));
      }).toThrow();
    });

    test('should reject method names ending with dot', () => {
      expect(() => {
        messageHub.onRequest('test.invalid.', async () => ({}));
      }).toThrow();
    });

    test('should reject empty method names', () => {
      expect(() => {
        messageHub.onRequest('', async () => ({}));
      }).toThrow('Invalid method name');
    });
  });

  describe('Event Handler Persistence', () => {
    test('should maintain event handlers across connection state changes', async () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
      };

      messageHub.onEvent('user.created', handler);

      transport.simulateMessage(
        createEventMessage({
          method: 'user.created',
          data: { userId: '123' },
          sessionId: 'test-session',
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(callCount).toBe(1);

      transport.simulateStateChange('disconnected');
      await new Promise((resolve) => setTimeout(resolve, 10));
      transport.simulateStateChange('connected');
      await new Promise((resolve) => setTimeout(resolve, 10));

      transport.simulateMessage(
        createEventMessage({
          method: 'user.created',
          data: { userId: '456' },
          sessionId: 'test-session',
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(callCount).toBe(2);
    });

    test('should stop receiving events after unsubscribe', async () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
      };

      const unsubscribe = messageHub.onEvent('user.created', handler);
      unsubscribe();

      transport.simulateMessage(
        createEventMessage({
          method: 'user.created',
          data: { userId: '789' },
          sessionId: 'test-session',
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(callCount).toBe(0);
    });
  });

  describe('Connection State Tracking', () => {
    test('should track connection state correctly', () => {
      expect(messageHub.isConnected()).toBe(true);
      expect(messageHub.getState()).toBe('connected');

      transport.simulateStateChange('disconnected');
      expect(messageHub.isConnected()).toBe(false);
      expect(messageHub.getState()).toBe('disconnected');

      transport.simulateStateChange('connecting');
      expect(messageHub.isConnected()).toBe(false);
      expect(messageHub.getState()).toBe('connecting');

      transport.simulateStateChange('connected');
      expect(messageHub.isConnected()).toBe(true);
      expect(messageHub.getState()).toBe('connected');
    });
  });

  describe('Error Resilience', () => {
    test('should handle malformed incoming messages gracefully', async () => {
      const malformedMessage = {
        id: 'test',
      } as unknown as HubMessage;

      expect(isValidMessage(malformedMessage)).toBe(false);
    });

    test('should continue processing after handler errors', async () => {
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      let handler1Called = false;
      let handler2Called = false;

      const handler1 = () => {
        handler1Called = true;
        throw new Error('Handler 1 error');
      };
      const handler2 = () => {
        handler2Called = true;
      };

      messageHub.onEvent('test.event', handler1);
      messageHub.onEvent('test.event', handler2);

      const eventMsg = createEventMessage({
        method: 'test.event',
        data: {},
        sessionId: 'test-session',
      });

      transport.simulateMessage(eventMsg);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);

      consoleErrorSpy.mockRestore();
    });
  });
});
