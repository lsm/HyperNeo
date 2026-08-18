import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub.ts';
import { MessageType } from '../src/message-hub/protocol.ts';
import type { HubMessage, IMessageTransport, ConnectionState } from '../src/message-hub/types.ts';

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
    hub.registerTransport(transport);
    await transport.initialize();

    let eventCount = 0;
    hub.onEvent('test.event', () => {
      eventCount++;
    });

    transport.clearSentMessages();

    transport.simulateDisconnect();
    expect(hub.isConnected()).toBe(false);

    transport.simulateReconnect();
    expect(hub.isConnected()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(transport.sentMessages.length).toBe(0);

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
    hub.registerTransport(transport);
    await transport.initialize();

    let eventReceived = false;
    const handler = (_data: unknown) => {
      eventReceived = true;
    };

    hub.onEvent('test.event', handler);

    transport.clearSentMessages();
    transport.simulateDisconnect();
    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

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

    expect(eventReceived).toBe(true);
  });

  it('should timeout pending queries on disconnect', async () => {
    hub.registerTransport(transport);
    await transport.initialize();

    const queryPromise = hub.request('test.method', {}, { timeout: 100 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    transport.simulateDisconnect();

    await expect(queryPromise).rejects.toThrow('Request timeout');
  });

  it('should allow new queries after reconnection', async () => {
    hub.registerTransport(transport);
    await transport.initialize();

    transport.simulateDisconnect();

    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

    const queryPromise = hub.request('test.method', {}, { timeout: 1000 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const queries = transport.sentMessages.filter((m) => m.type === MessageType.REQUEST);
    expect(queries.length).toBe(1);

    queryPromise.catch(() => {});
  });

  it('should handle multiple reconnections without errors', async () => {
    hub.registerTransport(transport);
    await transport.initialize();

    let eventCount = 0;
    hub.onEvent('test.event', () => {
      eventCount++;
    });

    for (let i = 0; i < 3; i++) {
      transport.simulateDisconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      transport.simulateReconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

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
    hub.registerTransport(transport);
    await transport.initialize();

    transport.simulateDisconnect();

    expect(() => {
      transport.simulateReconnect();
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('should continue to handle events after multiple reconnects', async () => {
    hub.registerTransport(transport);
    await transport.initialize();

    const receivedEvents: unknown[] = [];
    hub.onEvent('test.event', (data) => {
      receivedEvents.push(data);
    });

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

    transport.simulateDisconnect();
    transport.simulateReconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

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

    expect(receivedEvents.length).toBe(2);
    expect((receivedEvents[0] as { eventId: string }).eventId).toBe('E1');
    expect((receivedEvents[1] as { eventId: string }).eventId).toBe('E2');
  });
});
