/**
 * Test MessageHub reconnection behavior
 *
 * In the new simplified API:
 * - No automatic resubscription (no SUBSCRIBE messages)
 * - Event handlers persist across reconnects (local state)
 * - Queries timeout on disconnect
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub.ts';
import { MessageType } from '../src/message-hub/protocol.ts';
import type { HubMessage, IMessageTransport, ConnectionState } from '../src/message-hub/types.ts';

/**
 * Mock transport for testing
 */
class MockTransport implements IMessageTransport {
  name = 'mock-transport';
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<(state: ConnectionState, error?: Error) => void> = new Set();
  private state: ConnectionState = 'disconnected';
  sentMessages: HubMessage[] = [];

  async initialize(): Promise<void> {
    this.state = 'connected';
    this.notifyConnectionHandlers('connected');
  }

  async close(): Promise<void> {
    this.state = 'disconnected';
    this.notifyConnectionHandlers('disconnected');
  }

  async send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnectionChange(handler: (state: ConnectionState, error?: Error) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  isReady(): boolean {
    return this.state === 'connected';
  }

  getState(): ConnectionState {
    return this.state;
  }

  // Test helpers
  simulateDisconnect(): void {
    this.state = 'disconnected';
    this.notifyConnectionHandlers('disconnected');
  }

  simulateReconnect(): void {
    this.state = 'connected';
    this.notifyConnectionHandlers('connected');
  }

  receiveMessage(message: HubMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }

  private notifyConnectionHandlers(state: ConnectionState, error?: Error): void {
    for (const handler of this.connectionHandlers) {
      handler(state, error);
    }
  }
}

describe('MessageHub Reconnection', () => {
  let hub: MessageHub;
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    hub = new MessageHub();
  });

  afterEach(async () => {
    hub.cleanup();
    await transport.close();
  });

  it('should maintain event handlers across reconnection', async () => {
    // 1. Register transport and initialize
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Register event handler
    let eventCount = 0;
    hub.onEvent('test.event', () => {
      eventCount++;
    });

    // 3. Clear sent messages
    transport.clearSentMessages();

    // 4. Simulate disconnect
    transport.simulateDisconnect();
    expect(hub.isConnected()).toBe(false);

    // 5. Simulate reconnect
    transport.simulateReconnect();
    expect(hub.isConnected()).toBe(true);

    // Wait for any connection logic
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 6. No messages should be sent on reconnect (new API doesn't auto-resubscribe)
    // Event handlers persist as local state, no network messages needed
    expect(transport.sentMessages.length).toBe(0);

    // 7. But event handler should still work (local state persists)
    const testEvent: HubMessage = {
      id: 'event-1',
      type: MessageType.EVENT,
      method: 'test.event',
      sessionId: 'test-session',
      data: { message: 'test' },
      timestamp: new Date().toISOString(),
    };

    transport.receiveMessage(testEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(eventCount).toBe(1);
  });

  it('should handle events after reconnection', async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Register event handler
    let eventReceived = false;
    const handler = (_data: unknown) => {
      eventReceived = true;
    };

    hub.onEvent('test.event', handler);

    // 3. Reconnect
    transport.clearSentMessages();
    transport.simulateDisconnect();
    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Receive event after reconnection
    const testEvent: HubMessage = {
      id: 'event-1',
      type: MessageType.EVENT,
      method: 'test.event',
      sessionId: 'test-session',
      data: { message: 'test' },
      timestamp: new Date().toISOString(),
    };

    transport.receiveMessage(testEvent);

    // Wait for event to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 5. Verify event was received
    expect(eventReceived).toBe(true);
  });

  it('should timeout pending queries on disconnect', async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Start a query
    const queryPromise = hub.request('test.method', {}, { timeout: 100 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 3. Disconnect before receiving response
    transport.simulateDisconnect();

    // 4. Query should timeout
    await expect(queryPromise).rejects.toThrow('Request timeout');
  });

  it('should allow new queries after reconnection', async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Disconnect
    transport.simulateDisconnect();

    // 3. Reconnect
    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Make new query
    const queryPromise = hub.request('test.method', {}, { timeout: 1000 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have sent query
    const queries = transport.sentMessages.filter((m) => m.type === MessageType.REQUEST);
    expect(queries.length).toBe(1);

    // Clean up
    queryPromise.catch(() => {});
  });

  it('should handle multiple reconnections without errors', async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Register event handler
    let eventCount = 0;
    hub.onEvent('test.event', () => {
      eventCount++;
    });

    // 3. Multiple disconnect/reconnect cycles
    for (let i = 0; i < 3; i++) {
      transport.simulateDisconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      transport.simulateReconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // 4. Event handler should still work
    const testEvent: HubMessage = {
      id: `event-${Date.now()}`,
      type: MessageType.EVENT,
      method: 'test.event',
      sessionId: 'test-session',
      data: { message: 'test' },
      timestamp: new Date().toISOString(),
    };

    transport.receiveMessage(testEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(eventCount).toBe(1);
  });

  it('should not throw when reconnecting with no handlers', async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Disconnect and reconnect with no handlers registered
    transport.simulateDisconnect();

    // Should not throw
    expect(() => {
      transport.simulateReconnect();
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('should continue to handle events after multiple reconnects', async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Register event handler
    const receivedEvents: unknown[] = [];
    hub.onEvent('test.event', (data) => {
      receivedEvents.push(data);
    });

    // 3. Send event before disconnect
    const event1: HubMessage = {
      id: 'event-1',
      type: MessageType.EVENT,
      method: 'test.event',
      sessionId: 'test-session',
      data: { eventId: 'E1' },
      timestamp: new Date().toISOString(),
    };
    transport.receiveMessage(event1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Disconnect and reconnect
    transport.simulateDisconnect();
    transport.simulateReconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 5. Send event after reconnect
    const event2: HubMessage = {
      id: 'event-2',
      type: MessageType.EVENT,
      method: 'test.event',
      sessionId: 'test-session',
      data: { eventId: 'E2' },
      timestamp: new Date().toISOString(),
    };
    transport.receiveMessage(event2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 6. Verify both events were received
    expect(receivedEvents.length).toBe(2);
    expect((receivedEvents[0] as { eventId: string }).eventId).toBe('E1');
    expect((receivedEvents[1] as { eventId: string }).eventId).toBe('E2');
  });
});
