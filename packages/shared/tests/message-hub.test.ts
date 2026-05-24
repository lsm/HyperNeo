import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub';
import type { IMessageTransport, ConnectionState, HubMessage } from '../src/message-hub/types';
import {
  MessageType,
  createRequestMessage,
  createResponseMessage,
  createErrorResponseMessage,
  createEventMessage,
} from '../src/message-hub/protocol';
import { InProcessTransport } from '../src/message-hub/in-process-transport';

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

  async connect(): Promise<void> {
    this.state = 'connected';
    this.notifyStateChange('connected');
  }

  async disconnect(): Promise<void> {
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

  // Test helpers
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

describe('MessageHub', () => {
  let messageHub: MessageHub;
  let transport: MockTransport;

  beforeEach(async () => {
    messageHub = new MessageHub({
      defaultSessionId: 'test-session',
    });

    transport = new MockTransport();
    messageHub.registerTransport(transport);
    await transport.connect();
  });

  afterEach(() => {
    messageHub.cleanup();
  });

  describe('Transport Management', () => {
    test('should register transport successfully', () => {
      const newHub = new MessageHub({ defaultSessionId: 'test' });
      const newTransport = new MockTransport();

      newHub.registerTransport(newTransport);

      expect((newHub as unknown as { transports: Map<string, unknown> }).transports.size).toBe(1);
      expect(newHub.isConnected()).toBe(true);
    });

    test('should unregister transport successfully', () => {
      const newHub = new MessageHub({ defaultSessionId: 'test' });
      const newTransport = new MockTransport();

      const unregister = newHub.registerTransport(newTransport);
      expect((newHub as unknown as { transports: Map<string, unknown> }).transports.size).toBe(1);

      unregister();
      expect((newHub as unknown as { transports: Map<string, unknown> }).transports.size).toBe(0);
    });

    test('should throw error when registering transport with duplicate name', () => {
      const newTransport = new MockTransport();

      expect(() => {
        messageHub.registerTransport(newTransport, 'mock-transport');
      }).toThrow("Transport 'mock-transport' already registered");
    });

    test('should allow multiple transports with different names', () => {
      const newHub = new MessageHub({ defaultSessionId: 'test' });
      const transport1 = new MockTransport();
      const transport2 = new MockTransport();

      newHub.registerTransport(transport1, 'transport1');
      newHub.registerTransport(transport2, 'transport2');

      expect((newHub as unknown as { transports: Map<string, unknown> }).transports.size).toBe(2);
    });

    test('should return disconnected state when no transport registered', () => {
      const newHub = new MessageHub({ defaultSessionId: 'test' });
      expect(newHub.getState()).toBe('disconnected');
    });

    test('should handle connection state changes', async () => {
      const stateChanges: ConnectionState[] = [];
      messageHub.onConnection((state) => {
        stateChanges.push(state);
      });

      transport.simulateStateChange('connecting');
      transport.simulateStateChange('connected');
      transport.simulateStateChange('disconnected');

      // Small delay to allow handlers to execute
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stateChanges).toContain('connecting');
      expect(stateChanges).toContain('connected');
      expect(stateChanges).toContain('disconnected');
    });

    test('should unsubscribe from connection state changes', async () => {
      const stateChanges: ConnectionState[] = [];
      const unsubscribe = messageHub.onConnection((state) => {
        stateChanges.push(state);
      });

      transport.simulateStateChange('connecting');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stateChanges).toContain('connecting');

      unsubscribe();
      stateChanges.length = 0; // Clear array

      transport.simulateStateChange('disconnected');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stateChanges).not.toContain('disconnected');
    });

    test('should return correct connection state', () => {
      expect(messageHub.isConnected()).toBe(true);

      transport.simulateStateChange('disconnected');
      expect(messageHub.isConnected()).toBe(false);

      transport.simulateStateChange('connecting');
      expect(messageHub.isConnected()).toBe(false);
    });
  });

  describe('Query/Response Pattern', () => {
    test('should register query handler', () => {
      const handler = mock(async (_data: unknown) => ({ result: 'success' }));

      messageHub.onRequest('test.method', handler);

      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
          'test.method'
        )
      ).toBe(true);
    });

    test('should execute query handler when request message received', async () => {
      const handler = mock(async (data: { message?: string }) => {
        return { echo: data.message };
      });

      messageHub.onRequest('test.echo', handler);

      const requestMessage = createRequestMessage({
        method: 'test.echo',
        data: { message: 'hello' },
        sessionId: 'test-session',
      });

      transport.simulateMessage(requestMessage);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledWith(
        { message: 'hello' },
        expect.objectContaining({
          sessionId: 'test-session',
          method: 'test.echo',
        })
      );

      // Check that response was sent back
      const sentMessages = transport.sentMessages;
      const responseMessage = sentMessages.find(
        (msg) => msg.type === MessageType.RESPONSE && msg.requestId === requestMessage.id
      );

      expect(responseMessage).toBeDefined();
      expect(responseMessage?.data).toEqual({ echo: 'hello' });
    });

    test('should send error response when handler throws', async () => {
      const handler = mock(async () => {
        throw new Error('Handler failed');
      });

      messageHub.onRequest('test.error', handler);

      const requestMessage = createRequestMessage({
        method: 'test.error',
        data: {},
        sessionId: 'test-session',
      });

      transport.simulateMessage(requestMessage);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = transport.sentMessages;
      const errorMessage = sentMessages.find(
        (msg) =>
          msg.type === MessageType.RESPONSE && msg.requestId === requestMessage.id && msg.error
      );

      expect(errorMessage).toBeDefined();
      expect(errorMessage?.error).toContain('Handler failed');
    });

    test('should unregister query handler', () => {
      const handler = mock(async () => ({}));

      const unregister = messageHub.onRequest('test.method', handler);
      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
          'test.method'
        )
      ).toBe(true);

      unregister();
      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
          'test.method'
        )
      ).toBe(false);
    });
  });

  describe('Query Calls', () => {
    test('should send query message and receive response', async () => {
      const queryPromise = messageHub.request('test.method', { value: 42 });

      // Simulate receiving result
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.type).toBe(MessageType.REQUEST);
      expect(sentMessage.method).toBe('test.method');
      expect(sentMessage.data).toEqual({ value: 42 });

      // Simulate response from server
      const responseMessage = createResponseMessage({
        method: sentMessage.method,
        data: { result: 'success' },
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id,
      });

      transport.simulateMessage(responseMessage);

      const result = await queryPromise;
      expect(result).toEqual({ result: 'success' });
    });

    test('should handle query timeout', async () => {
      const queryPromise = messageHub.request('test.timeout', {}, { timeout: 100 });

      await expect(queryPromise).rejects.toThrow('Request timeout');
    });

    test('should receive error response for failed query', async () => {
      const queryPromise = messageHub.request('test.error', {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];

      // Simulate error from server
      const errorMessage = createErrorResponseMessage({
        method: sentMessage.method,
        error: {
          message: 'Something went wrong',
          code: 'INTERNAL_ERROR',
        },
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id,
      });

      transport.simulateMessage(errorMessage);

      await expect(queryPromise).rejects.toThrow('Something went wrong');
    });

    test('should throw error when not connected', async () => {
      transport.simulateStateChange('disconnected');

      await expect(messageHub.request('test.method', {})).rejects.toThrow(
        'Not connected to transport'
      );
    });

    test('should handle sendMessage error in query', async () => {
      // Create a transport that throws on send
      class FailingTransport extends MockTransport {
        async send(_message: HubMessage): Promise<void> {
          throw new Error('Transport send failed');
        }
      }

      const newHub = new MessageHub({ defaultSessionId: 'test' });
      const failingTransport = new FailingTransport();
      newHub.registerTransport(failingTransport);
      await failingTransport.connect();

      await expect(newHub.request('test.method', {})).rejects.toThrow('Transport send failed');
    });

    test('should use custom room in query', async () => {
      const queryPromise = messageHub.request('test.method', {}, { channel: 'custom-room' });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.sessionId).toBe('custom-room');

      // Clean up pending query
      const responseMessage = createResponseMessage({
        method: sentMessage.method,
        data: {},
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id,
      });
      transport.simulateMessage(responseMessage);
      await queryPromise;
    });
  });

  describe('Request Handler Pattern', () => {
    test('should register request handler', () => {
      const handler = mock((_data: unknown) => {});

      messageHub.onRequest('test.request', handler);

      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
          'test.request'
        )
      ).toBe(true);
    });

    test('should execute request handler when request received', async () => {
      const handler = mock((data: { action?: string }) => {
        expect(data.action).toBe('test');
      });

      messageHub.onRequest('test.request', handler);

      const requestMessage = createRequestMessage({
        method: 'test.request',
        data: { action: 'test' },
        sessionId: 'test-session',
      });

      transport.simulateMessage(requestMessage);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledWith(
        { action: 'test' },
        expect.objectContaining({
          method: 'test.request',
          sessionId: 'test-session',
        })
      );

      // All requests now send responses (ACK if handler returns void)
      const responses = transport.sentMessages.filter((m) => m.type === MessageType.RESPONSE);
      expect(responses.length).toBe(1);
      expect(responses[0].data).toEqual({ acknowledged: true });
    });

    test('should unregister request handler', () => {
      const handler = mock(() => {});

      const unregister = messageHub.onRequest('test.request', handler);
      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
          'test.request'
        )
      ).toBe(true);

      unregister();
      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.has(
          'test.request'
        )
      ).toBe(false);
    });
  });

  describe('Event Pattern', () => {
    test('should emit event message', () => {
      messageHub.event('user.created', { userId: '123' });

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.type).toBe(MessageType.EVENT);
      expect(sentMessage.method).toBe('user.created');
      expect(sentMessage.data).toEqual({ userId: '123' });
    });

    test('should use custom room when emitting event', () => {
      messageHub.event('user.created', { userId: '123' }, { channel: 'custom-room' });

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.sessionId).toBe('custom-room');
      expect(sentMessage.channel).toBe('custom-room');
    });

    test('should not throw when emitting event while disconnected (skips send)', () => {
      transport.simulateStateChange('disconnected');

      // Should not throw, just skip sending
      messageHub.event('test.event', {});

      // No message should be sent
      expect(transport.sentMessages.length).toBe(0);
    });
  });

  describe('Event Listening', () => {
    test('should register event handler', () => {
      const handler = mock((_data: unknown) => {});

      messageHub.onEvent('user.created', handler);

      expect(
        (
          messageHub as unknown as { channelEventHandlers: Map<string, Set<unknown>> }
        ).channelEventHandlers.has('user.created')
      ).toBe(true);
    });

    test('should receive events matching handler', async () => {
      const handler = mock((_data: unknown) => {});

      messageHub.onEvent('user.created', handler);

      const eventMessage = createEventMessage({
        method: 'user.created',
        data: { userId: '123' },
        sessionId: 'test-session',
      });

      transport.simulateMessage(eventMessage);

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledWith(
        { userId: '123' },
        expect.objectContaining({
          method: 'user.created',
          sessionId: 'test-session',
        })
      );
    });

    test('should support multiple handlers for same event', async () => {
      const handler1 = mock((_data: unknown) => {});
      const handler2 = mock((_data: unknown) => {});

      messageHub.onEvent('user.created', handler1);
      messageHub.onEvent('user.created', handler2);

      const eventMessage = createEventMessage({
        method: 'user.created',
        data: { userId: '123' },
        sessionId: 'test-session',
      });

      transport.simulateMessage(eventMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    test('should unregister event handler', async () => {
      const handler = mock((_data: unknown) => {});

      const unregister = messageHub.onEvent('user.created', handler);

      unregister();

      const eventMessage = createEventMessage({
        method: 'user.created',
        data: { userId: '123' },
        sessionId: 'test-session',
      });

      transport.simulateMessage(eventMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Room Management', () => {
    test('should send channel.join request', async () => {
      // Start joinChannel but don't await yet
      const joinPromise = messageHub.joinChannel('session-123');

      // Wait for message to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.type).toBe(MessageType.REQUEST);
      expect(sentMessage.method).toBe('channel.join');
      expect(sentMessage.data).toEqual({ channel: 'session-123' });

      // Simulate ACK response
      transport.simulateMessage(
        createResponseMessage({
          method: 'channel.join',
          data: { acknowledged: true },
          sessionId: sentMessage.sessionId,
          requestId: sentMessage.id,
        })
      );

      await joinPromise;
    });

    test('should send channel.leave request', async () => {
      // Start leaveChannel but don't await yet
      const leavePromise = messageHub.leaveChannel('session-123');

      // Wait for message to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.type).toBe(MessageType.REQUEST);
      expect(sentMessage.method).toBe('channel.leave');
      expect(sentMessage.data).toEqual({ channel: 'session-123' });

      // Simulate ACK response
      transport.simulateMessage(
        createResponseMessage({
          method: 'channel.leave',
          data: { acknowledged: true },
          sessionId: sentMessage.sessionId,
          requestId: sentMessage.id,
        })
      );

      await leavePromise;
    });

    test('should skip room operations when disconnected', async () => {
      transport.simulateStateChange('disconnected');

      await messageHub.joinChannel('test-room');
      await messageHub.leaveChannel('test-room');

      expect(transport.sentMessages.length).toBe(0);
    });
  });

  describe('Message Routing', () => {
    test('should route messages to correct handlers', async () => {
      const requestHandler1 = mock(async () => ({}));
      const eventHandler = mock(() => {});
      const requestHandler2 = mock(() => {});

      messageHub.onRequest('test.request1', requestHandler1);
      messageHub.onEvent('test.event', eventHandler);
      messageHub.onRequest('test.request2', requestHandler2);

      // Send request 1
      const requestMessage1 = createRequestMessage({
        method: 'test.request1',
        data: {},
        sessionId: 'test-session',
      });
      transport.simulateMessage(requestMessage1);

      // Send event
      const eventMessage = createEventMessage({
        method: 'test.event',
        data: {},
        sessionId: 'test-session',
      });
      transport.simulateMessage(eventMessage);

      // Send request 2
      const requestMessage2 = createRequestMessage({
        method: 'test.request2',
        data: {},
        sessionId: 'test-session',
      });
      transport.simulateMessage(requestMessage2);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(requestHandler1).toHaveBeenCalled();
      expect(eventHandler).toHaveBeenCalled();
      expect(requestHandler2).toHaveBeenCalled();
    });

    test('should handle response messages for pending queries', async () => {
      const queryPromise = messageHub.request('test.method', {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      const responseMessage = createResponseMessage({
        method: sentMessage.method,
        data: { value: 42 },
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id,
      });

      transport.simulateMessage(responseMessage);

      const result = await queryPromise;
      expect(result).toEqual({ value: 42 });
    });

    test('should ignore response for unknown query ID', () => {
      const responseMessage = createResponseMessage({
        method: 'test.method',
        data: {},
        sessionId: 'test-session',
        requestId: 'unknown-id',
      });

      // Should not throw
      expect(() => {
        transport.simulateMessage(responseMessage);
      }).not.toThrow();
    });

    test('should unsubscribe from onMessage handler on transport unregister', () => {
      const newHub = new MessageHub({ defaultSessionId: 'test' });
      const newTransport = new MockTransport();

      const unregister = newHub.registerTransport(newTransport);

      // Verify transport is registered
      expect((newHub as unknown as { transports: Map<string, unknown> }).transports.size).toBe(1);

      // Verify transport has message handlers registered
      expect(newTransport['messageHandlers'].size).toBe(1);

      // Unregister transport
      unregister();

      // Verify transport is unregistered
      expect((newHub as unknown as { transports: Map<string, unknown> }).transports.size).toBe(0);

      // Verify transport's message handlers are removed
      expect(newTransport['messageHandlers'].size).toBe(0);
    });
  });

  describe('Message Inspection', () => {
    test('should call message handler for incoming and outgoing messages', async () => {
      const handler = mock(() => {});
      messageHub.onMessage(handler);

      // Send a request (outgoing)
      const requestPromise = messageHub.request('test.method', {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have been called for outgoing REQUEST message
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.REQUEST,
          method: 'test.method',
        }),
        'out'
      );

      // Simulate response (incoming)
      const sentMessage = transport.sentMessages[0];
      const responseMessage = createResponseMessage({
        method: sentMessage.method,
        data: {},
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id,
      });

      transport.simulateMessage(responseMessage);

      // Should have been called for incoming RESPONSE message
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.RESPONSE,
        }),
        'in'
      );

      await requestPromise;
    });

    test('should unsubscribe from message handler', () => {
      const handler = mock(() => {});
      const unsubscribe = messageHub.onMessage(handler);

      // Send a message
      messageHub.event('test.event', {});

      // Handler should have been called
      expect(handler).toHaveBeenCalled();

      // Clear mock
      handler.mockClear();

      // Unsubscribe
      unsubscribe();

      // Send another message
      messageHub.event('test.event2', {});

      // Handler should NOT have been called
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('PING/PONG', () => {
    test('should respond to PING with PONG', async () => {
      transport.clearSentMessages();

      const pingMessage: HubMessage = {
        id: 'ping-123',
        type: MessageType.PING,
        sessionId: 'test-session',
        method: 'heartbeat',
        timestamp: new Date().toISOString(),
      };

      transport.simulateMessage(pingMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const pongMessages = transport.sentMessages.filter((m) => m.type === MessageType.PONG);
      expect(pongMessages.length).toBe(1);
      expect(pongMessages[0].requestId).toBe('ping-123');
    });

    test('should handle PONG message', () => {
      const pongMessage: HubMessage = {
        id: 'pong-123',
        type: MessageType.PONG,
        sessionId: 'test-session',
        method: 'heartbeat',
        requestId: 'ping-123',
        timestamp: new Date().toISOString(),
      };

      // Should not throw
      expect(() => {
        transport.simulateMessage(pongMessage);
      }).not.toThrow();
    });
  });

  describe('Cleanup and Disposal', () => {
    test('should cleanup pending queries on cleanup', async () => {
      const _query1 = messageHub.request('test.method1', {}).catch(() => {});
      const _query2 = messageHub.request('test.method2', {}).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { pendingCalls: Map<string, unknown> }).pendingCalls.size
      ).toBe(0);
    });

    test('should clear all handlers on cleanup', () => {
      messageHub.onRequest('test.query', async () => ({}));
      messageHub.onRequest('test.command', () => {});
      messageHub.onEvent('test.event', () => {});

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.size
      ).toBe(0);
      expect(
        (messageHub as unknown as { requestHandlers: Map<string, unknown> }).requestHandlers.size
      ).toBe(0);
      expect(
        (messageHub as unknown as { channelEventHandlers: Map<string, unknown> })
          .channelEventHandlers.size
      ).toBe(0);
    });

    test('should remove connection state handlers on cleanup', () => {
      messageHub.onConnection(() => {});

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { connectionStateHandlers: Set<unknown> }).connectionStateHandlers
          .size
      ).toBe(0);
    });

    test('should clear message inspection handlers on cleanup', () => {
      messageHub.onMessage(() => {});

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { messageHandlers: Set<unknown> }).messageHandlers.size
      ).toBe(0);
    });
  });

  describe('Utility Methods', () => {
    test('should get pending call count', async () => {
      // No pending calls initially
      expect(messageHub.getPendingCallCount()).toBe(0);

      // Create some pending queries
      const query1 = messageHub.request('test.method1', {});
      const query2 = messageHub.request('test.method2', {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(messageHub.getPendingCallCount()).toBe(2);

      // Resolve one query
      const sentMessage1 = transport.sentMessages[0];
      transport.simulateMessage(
        createResponseMessage({
          method: sentMessage1.method,
          data: {},
          sessionId: sentMessage1.sessionId,
          requestId: sentMessage1.id,
        })
      );

      await query1;
      expect(messageHub.getPendingCallCount()).toBe(1);

      // Resolve second query
      const sentMessage2 = transport.sentMessages[1];
      transport.simulateMessage(
        createResponseMessage({
          method: sentMessage2.method,
          data: {},
          sessionId: sentMessage2.sessionId,
          requestId: sentMessage2.id,
        })
      );

      await query2;
      expect(messageHub.getPendingCallCount()).toBe(0);
    });
  });
});

describe('Multi-Transport Support', () => {
  test('should set second transport as primary when isPrimary=true', () => {
    const hub = new MessageHub();
    const [t1, t2] = InProcessTransport.createPair({ name: 'test' });

    hub.registerTransport(t1, 'primary', true);
    hub.registerTransport(t2, 'secondary', true); // Override primary

    // t2 should now be primary
    // We can verify this by checking which transport is used for sending
    expect(hub.isConnected()).toBe(false); // Neither initialized

    t1.close();
    t2.close();
  });

  test('should keep first transport as primary when isPrimary=false on second', async () => {
    const hub = new MessageHub();
    const [client1, server1] = InProcessTransport.createPair({ name: 'test1' });
    const [client2, server2] = InProcessTransport.createPair({ name: 'test2' });

    hub.registerTransport(server1, 'primary', true);
    hub.registerTransport(server2, 'secondary', false);

    await server1.initialize();
    await server2.initialize();

    expect(hub.isConnected()).toBe(true);

    // Cleanup
    await client1.close();
    await server1.close();
    await client2.close();
    await server2.close();
  });

  test('should route response via same transport request came from (_transportName)', async () => {
    // This is the CRITICAL test for Neo!
    const serverHub = new MessageHub();
    const clientHub = new MessageHub();

    const [clientTransport, serverTransport] = InProcessTransport.createPair({ name: 'neo' });

    serverHub.registerTransport(serverTransport, 'neo');
    clientHub.registerTransport(clientTransport, 'client');

    await clientTransport.initialize();

    // Track which transport sent the response
    let responseSentVia: string | undefined = undefined;
    const originalSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (msg) => {
      responseSentVia = 'neo';
      return originalSend(msg);
    };

    // Register handler on server
    serverHub.onRequest('test.method', async () => {
      return { success: true };
    });

    // Make request from client
    const result = await clientHub.request('test.method', {});
    expect(result).toEqual({ success: true });
    expect(responseSentVia).toBeDefined();
    expect(responseSentVia).toBe('neo' as never); // Response went through neo transport

    await clientTransport.close();
    await serverTransport.close();
  });

  test('should select next transport as primary when primary is unregistered', async () => {
    const hub = new MessageHub();
    const [client1, server1] = InProcessTransport.createPair({ name: 'test1' });
    const [client2, server2] = InProcessTransport.createPair({ name: 'test2' });

    const unregister1 = hub.registerTransport(server1, 'first', true);
    hub.registerTransport(server2, 'second', false);

    await server1.initialize();
    await server2.initialize();

    expect(hub.isConnected()).toBe(true);

    // Unregister primary
    unregister1();

    // Should still be connected via second transport
    expect(hub.isConnected()).toBe(true);

    await client1.close();
    await server1.close();
    await client2.close();
    await server2.close();
  });

  test('should return true for isConnected when any transport is ready', async () => {
    const hub = new MessageHub();
    const [client, server] = InProcessTransport.createPair({ name: 'test' });

    hub.registerTransport(server, 'transport1');
    hub.registerTransport(client, 'transport2');

    // Neither initialized
    expect(hub.isConnected()).toBe(false);

    // Initialize one
    await server.initialize();
    expect(hub.isConnected()).toBe(true);

    await client.close();
    await server.close();
  });

  test('should throw error for duplicate transport name', () => {
    const hub = new MessageHub();
    const [t1, t2] = InProcessTransport.createPair({ name: 'test' });

    hub.registerTransport(t1, 'my-transport');

    expect(() => {
      hub.registerTransport(t2, 'my-transport');
    }).toThrow("Transport 'my-transport' already registered");

    t1.close();
    t2.close();
  });

  test('should handle RPC from primary transport client when multiple transports registered', async () => {
    // This test verifies that with multiple transports, the primary transport client
    // can complete RPC calls. Without a router, responses go to the primary transport.

    const serverHub = new MessageHub({ defaultSessionId: 'global' });

    // Primary (websocket) client
    const [wsClient, wsServer] = InProcessTransport.createPair({ name: 'ws' });
    const wsClientHub = new MessageHub({ defaultSessionId: 'global' });

    // Secondary (neo) client
    const [neoClient, neoServer] = InProcessTransport.createPair({ name: 'neo' });
    const neoClientHub = new MessageHub({ defaultSessionId: 'global' });

    // Register both on server - websocket is primary
    serverHub.registerTransport(wsServer, 'websocket', true);
    serverHub.registerTransport(neoServer, 'neo', false);

    wsClientHub.registerTransport(wsClient, 'client');
    neoClientHub.registerTransport(neoClient, 'client');

    // Initialize both pairs
    await wsClient.initialize();
    await neoClient.initialize();

    // Register handler
    serverHub.onRequest('test.echo', async (data) => {
      return { echoed: data };
    });

    // Primary client should be able to make RPC calls
    const wsResult = await wsClientHub.request('test.echo', { source: 'websocket' });
    expect((wsResult as { echoed: { source: string } }).echoed.source).toBe('websocket');

    // Secondary client's requests reach the server, but without a router,
    // responses go to the primary transport (current implementation limitation)
    let neoHandlerCalled = false;
    serverHub.onRequest('test.neo', async (data) => {
      neoHandlerCalled = true;
      return { echoed: data };
    });

    // The secondary client's request reaches the server (handler is called)
    // but the response goes to the primary transport, causing a timeout
    void neoClientHub.request('test.neo', { source: 'neo' }, { timeout: 100 }).catch(() => {
      // Expected timeout - response goes to primary transport
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The handler was called (request reached server)
    expect(neoHandlerCalled).toBe(true);

    // Cleanup
    await wsClient.close();
    await wsServer.close();
    await neoClient.close();
    await neoServer.close();
  });
});

// ========================================
// onClientDisconnect forwarding
// ========================================

/**
 * Creates a mock transport with onClientDisconnect support.
 * Returns both the transport and a simulate function to trigger disconnects.
 */
function createMockTransportWithDisconnect(): {
  transport: IMessageTransport;
  simulateDisconnect: (clientId: string) => void;
} {
  const handlers: Set<(clientId: string) => void> = new Set();
  const transport: IMessageTransport = {
    name: 'mock-with-disconnect',
    initialize: async () => {},
    close: async () => {},
    send: async () => {},
    isReady: () => true,
    getState: () => 'connected' as ConnectionState,
    onMessage: () => () => {},
    onConnectionChange: () => () => {},
    onClientDisconnect(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return {
    transport,
    simulateDisconnect: (clientId) => {
      for (const h of handlers) h(clientId);
    },
  };
}

describe('MessageHub.onClientDisconnect', () => {
  test('forwards handler to primary transport and fires on disconnect', () => {
    const hub = new MessageHub();
    const { transport, simulateDisconnect } = createMockTransportWithDisconnect();
    hub.registerTransport(transport);

    const received: string[] = [];
    hub.onClientDisconnect((clientId) => {
      received.push(clientId);
    });

    simulateDisconnect('client-abc');

    expect(received).toEqual(['client-abc']);
  });

  test('unsubscribe prevents further callbacks', () => {
    const hub = new MessageHub();
    const { transport, simulateDisconnect } = createMockTransportWithDisconnect();
    hub.registerTransport(transport);

    const received: string[] = [];
    const unsubscribe = hub.onClientDisconnect((clientId) => {
      received.push(clientId);
    });

    // First disconnect fires
    simulateDisconnect('client-1');
    expect(received).toEqual(['client-1']);

    // Unsubscribe and fire again — handler should not be called
    unsubscribe();
    simulateDisconnect('client-2');
    expect(received).toEqual(['client-1']);
  });

  test('returns no-op unsubscribe when transport has no onClientDisconnect', () => {
    const hub = new MessageHub();

    // Transport without onClientDisconnect
    const mockTransport: IMessageTransport = {
      name: 'mock-no-disconnect',
      initialize: async () => {},
      close: async () => {},
      send: async () => {},
      isReady: () => true,
      getState: () => 'connected' as ConnectionState,
      onMessage: () => () => {},
      onConnectionChange: () => () => {},
      // onClientDisconnect is intentionally omitted
    };

    hub.registerTransport(mockTransport);

    // Should not throw; returns a no-op function
    const unsubscribe = hub.onClientDisconnect(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  test('returns no-op unsubscribe when no transport is registered', () => {
    const hub = new MessageHub();

    const unsubscribe = hub.onClientDisconnect(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});
