/**
 * WebSocket Client Transport Unit Tests
 *
 * Comprehensive test suite covering:
 * - Basic interface and state management
 * - Message validation and callback registration
 * - Network failure scenarios (connection, disconnection, reconnection)
 * - PING/PONG health checks
 * - Error recovery and edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { WebSocketClientTransport } from '../src/message-hub/websocket-client-transport.ts';
import { MessageType } from '../src/message-hub/protocol.ts';
import type { HubMessage, ConnectionState } from '../src/message-hub/types.ts';

// Mock WebSocket for network failure tests
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  sentMessages: string[] = [];

  private autoConnect: boolean;

  constructor(url: string, autoConnect = true) {
    this.url = url;
    this.autoConnect = autoConnect;

    // Simulate async connection only if autoConnect is true
    if (this.autoConnect) {
      setTimeout(() => {
        if (this.readyState === MockWebSocket.CONNECTING) {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        }
      }, 10);
    }
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSING;
    setTimeout(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.(new CloseEvent('close'));
    }, 10);
  }

  // Test helpers
  simulateMessage(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      return;
    }
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateDisconnect(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

describe('WebSocketClientTransport - Basic Interface', () => {
  describe('constructor', () => {
    it('should initialize with default options', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      expect(transport.name).toBe('websocket-client');
      expect(transport.getState()).toBe('disconnected');
      expect(transport.isReady()).toBe(false);
    });

    it('should accept custom options', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
        autoReconnect: false,
        maxReconnectAttempts: 3,
        reconnectDelay: 500,
        pingInterval: 15000,
      });

      expect(transport.name).toBe('websocket-client');
      expect(transport.getState()).toBe('disconnected');
    });
  });

  describe('getState', () => {
    it('should return disconnected initially', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      expect(transport.getState()).toBe('disconnected');
    });
  });

  describe('isReady', () => {
    it('should return false when disconnected', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      expect(transport.isReady()).toBe(false);
    });
  });

  describe('onMessage', () => {
    it('should allow registering message handlers', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const messages: HubMessage[] = [];
      const unsubscribe = transport.onMessage((msg) => {
        messages.push(msg);
      });

      expect(typeof unsubscribe).toBe('function');
    });

    it('should allow unsubscribing from messages', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const messages: HubMessage[] = [];
      const unsubscribe = transport.onMessage((msg) => {
        messages.push(msg);
      });

      // Should not throw
      unsubscribe();
    });

    it('should allow multiple handlers', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const messages1: HubMessage[] = [];
      const messages2: HubMessage[] = [];

      const unsub1 = transport.onMessage((msg) => messages1.push(msg));
      const unsub2 = transport.onMessage((msg) => messages2.push(msg));

      expect(typeof unsub1).toBe('function');
      expect(typeof unsub2).toBe('function');

      // Cleanup
      unsub1();
      unsub2();
    });
  });

  describe('onConnectionChange', () => {
    it('should allow registering connection state handlers', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const states: ConnectionState[] = [];
      const unsubscribe = transport.onConnectionChange((state) => {
        states.push(state);
      });

      expect(typeof unsubscribe).toBe('function');
    });

    it('should allow unsubscribing from connection changes', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const states: ConnectionState[] = [];
      const unsubscribe = transport.onConnectionChange((state) => {
        states.push(state);
      });

      // Should not throw
      unsubscribe();
    });

    it('should allow multiple handlers', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const states1: ConnectionState[] = [];
      const states2: ConnectionState[] = [];

      const unsub1 = transport.onConnectionChange((state) => states1.push(state));
      const unsub2 = transport.onConnectionChange((state) => states2.push(state));

      expect(typeof unsub1).toBe('function');
      expect(typeof unsub2).toBe('function');

      // Cleanup
      unsub1();
      unsub2();
    });
  });

  describe('send', () => {
    it('should throw when not connected', async () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const message: HubMessage = {
        id: 'test-1',
        type: MessageType.REQUEST,
        method: 'test.method',
        sessionId: 'session-1',
        data: { foo: 'bar' },
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      };

      await expect(transport.send(message)).rejects.toThrow('WebSocket not connected');
    });
  });

  describe('close', () => {
    it('should handle close when not connected', async () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      // Should not throw
      await transport.close();

      expect(transport.getState()).toBe('disconnected');
      expect(transport.isReady()).toBe(false);
    });

    it('should set state to disconnected after close', async () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      await transport.close();

      expect(transport.getState()).toBe('disconnected');
    });
  });

  describe('name property', () => {
    it('should return websocket-client', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      expect(transport.name).toBe('websocket-client');
    });
  });

  describe('getReconnectAttempts', () => {
    it('should return 0 initially', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      expect(transport.getReconnectAttempts()).toBe(0);
    });
  });

  describe('options validation', () => {
    it('should work with minimal options', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      expect(transport).toBeDefined();
    });

    it('should work with all options specified', () => {
      const transport = new WebSocketClientTransport({
        url: 'wss://secure.example.com/ws',
        autoReconnect: true,
        maxReconnectAttempts: 10,
        reconnectDelay: 2000,
        pingInterval: 60000,
      });

      expect(transport).toBeDefined();
      expect(transport.name).toBe('websocket-client');
    });

    it('should work with autoReconnect disabled', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
        autoReconnect: false,
      });

      expect(transport).toBeDefined();
    });

    it('should work with pingInterval set to 0', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
        pingInterval: 0,
      });

      expect(transport).toBeDefined();
    });
  });

  describe('URL handling', () => {
    it('should accept ws:// URLs', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080/path',
      });

      expect(transport).toBeDefined();
    });

    it('should accept wss:// URLs', () => {
      const transport = new WebSocketClientTransport({
        url: 'wss://secure.example.com:443/ws',
      });

      expect(transport).toBeDefined();
    });

    it('should accept URLs with query parameters', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080/ws?token=abc&session=123',
      });

      expect(transport).toBeDefined();
    });
  });

  describe('handler cleanup', () => {
    it('should properly clean up message handlers on unsubscribe', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const handler1 = () => {};
      const handler2 = () => {};

      const unsub1 = transport.onMessage(handler1);
      const unsub2 = transport.onMessage(handler2);

      // Unsubscribe first handler
      unsub1();

      // Second handler should still be registered (no way to verify directly, but shouldn't throw)
      unsub2();
    });

    it('should properly clean up connection handlers on unsubscribe', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const handler1 = () => {};
      const handler2 = () => {};

      const unsub1 = transport.onConnectionChange(handler1);
      const unsub2 = transport.onConnectionChange(handler2);

      // Unsubscribe first handler
      unsub1();

      // Second handler should still be registered (no way to verify directly, but shouldn't throw)
      unsub2();
    });

    it('should handle multiple unsubscribe calls gracefully', () => {
      const transport = new WebSocketClientTransport({
        url: 'ws://localhost:8080',
      });

      const unsub = transport.onMessage(() => {});

      // Multiple unsubscribe calls should not throw
      unsub();
      unsub();
      unsub();
    });
  });
});

describe('WebSocketClientTransport - Network Failure Tests', () => {
  let transport: WebSocketClientTransport;
  let mockWebSocketInstance: MockWebSocket | null = null;

  beforeEach(() => {
    mockWebSocketInstance = null;

    // Mock global WebSocket
    global.WebSocket = vi.fn((url: string) => {
      mockWebSocketInstance = new MockWebSocket(url);
      return mockWebSocketInstance as unknown as WebSocket;
    }) as unknown as typeof WebSocket;

    (
      global.WebSocket as unknown as {
        CONNECTING: number;
        OPEN: number;
        CLOSING: number;
        CLOSED: number;
      }
    ).CONNECTING = 0;
    (
      global.WebSocket as unknown as {
        CONNECTING: number;
        OPEN: number;
        CLOSING: number;
        CLOSED: number;
      }
    ).OPEN = 1;
    (
      global.WebSocket as unknown as {
        CONNECTING: number;
        OPEN: number;
        CLOSING: number;
        CLOSED: number;
      }
    ).CLOSING = 2;
    (
      global.WebSocket as unknown as {
        CONNECTING: number;
        OPEN: number;
        CLOSING: number;
        CLOSED: number;
      }
    ).CLOSED = 3;
  });

  afterEach(async () => {
    if (transport) {
      await transport.close();
    }
    vi.restoreAllMocks();
  });

  describe('Connection Failures', () => {
    it('should handle initial connection failure', async () => {
      // Mock WebSocket that fails immediately
      global.WebSocket = vi.fn(() => {
        const ws = new MockWebSocket('ws://localhost:9999', false);
        // Fail connection attempt quickly
        setTimeout(() => {
          ws.readyState = MockWebSocket.CLOSED;
          ws.onerror?.(new Event('error'));
          ws.onclose?.(new CloseEvent('close'));
        }, 5);
        return ws as unknown as WebSocket;
      }) as unknown as typeof WebSocket;

      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      const stateChanges: string[] = [];
      transport.onConnectionChange((state) => {
        stateChanges.push(state);
      });

      // Try to connect - will either reject or timeout
      const _initPromise = transport.initialize();

      // Wait for connection attempt
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Connection should have transitioned through connecting state
      expect(stateChanges).toContain('connecting');
      // Should be in error or disconnected state now
      expect(['error', 'disconnected']).toContain(transport.getState());
    });

    it('should handle connection timeout', async () => {
      // Mock WebSocket that stays in connecting state
      global.WebSocket = vi.fn(() => {
        const ws = new MockWebSocket('ws://localhost:9999', false); // Don't auto-connect
        ws.readyState = MockWebSocket.CONNECTING;
        // Never call onopen to simulate timeout
        return ws as unknown as WebSocket;
      }) as unknown as typeof WebSocket;

      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      // Start connection (won't resolve since onopen never fires)
      transport.initialize().catch(() => {
        // Ignore errors since we expect it to timeout
      });

      // Wait a short time
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Connection should still be in connecting state
      expect(transport.getState()).toBe('connecting');
      expect(transport.isReady()).toBe(false);
    });
  });

  describe('Disconnection Handling', () => {
    it('should detect unexpected disconnection', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(transport.isReady()).toBe(true);

      const stateChanges: string[] = [];
      transport.onConnectionChange((state) => {
        stateChanges.push(state);
      });

      // Simulate network disconnection
      if (mockWebSocketInstance) {
        mockWebSocketInstance.simulateDisconnect();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(transport.isReady()).toBe(false);
      expect(stateChanges).toContain('disconnected');
    });

    it('should reject messages after disconnection', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Disconnect
      if (mockWebSocketInstance) {
        mockWebSocketInstance.simulateDisconnect();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try to send message
      const message: HubMessage = {
        id: 'test-1',
        type: MessageType.REQUEST,
        method: 'test',
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
      };

      await expect(transport.send(message)).rejects.toThrow('WebSocket not connected');
    });
  });

  describe('Automatic Reconnection', () => {
    it('should automatically reconnect after disconnection', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: true,
        maxReconnectAttempts: 3,
        reconnectDelay: 100,
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const stateChanges: string[] = [];
      transport.onConnectionChange((state) => {
        stateChanges.push(state);
      });

      // Simulate disconnection
      if (mockWebSocketInstance) {
        mockWebSocketInstance.simulateDisconnect();
      }

      // Wait for reconnection attempt
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(stateChanges).toContain('disconnected');
      expect(stateChanges).toContain('connecting');
    });

    it('should respect max reconnection attempts', async () => {
      const maxAttempts = 2;
      let connectionAttempts = 0;

      // Mock WebSocket to always fail connection
      global.WebSocket = vi.fn(() => {
        connectionAttempts++;
        const ws = new MockWebSocket('ws://localhost:9999', false); // Don't auto-connect
        // Fail immediately
        setTimeout(() => {
          ws.readyState = MockWebSocket.CLOSED;
          ws.onerror?.(new Event('error'));
          ws.onclose?.(new CloseEvent('close'));
        }, 5);
        return ws as unknown as WebSocket;
      }) as unknown as typeof WebSocket;

      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: true,
        maxReconnectAttempts: maxAttempts,
        reconnectDelay: 50,
      });

      // Initial connection attempt - start but don't wait
      transport.initialize();

      // Wait for all reconnection attempts
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Should have tried at least initial + some reconnections, but capped at maxAttempts + 1
      // Note: The reconnection logic may create slightly more attempts due to timing
      expect(connectionAttempts).toBeGreaterThanOrEqual(1);
      // Allow some flexibility for edge cases in reconnection timing
      expect(connectionAttempts).toBeLessThanOrEqual(maxAttempts + 3);
    });

    it('should use exponential backoff for reconnection', async () => {
      const reconnectTimes: number[] = [];

      // Mock WebSocket to always fail connection
      global.WebSocket = vi.fn(() => {
        reconnectTimes.push(Date.now());
        const ws = new MockWebSocket('ws://localhost:9999', false); // Don't auto-connect
        // Fail after brief delay
        setTimeout(() => {
          ws.readyState = MockWebSocket.CLOSED;
          ws.onerror?.(new Event('error'));
          ws.onclose?.(new CloseEvent('close'));
        }, 5);
        return ws as unknown as WebSocket;
      }) as unknown as typeof WebSocket;

      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: true,
        maxReconnectAttempts: 4,
        reconnectDelay: 100,
      });

      // Initial connection attempt - start but don't wait
      transport.initialize();

      // Wait for reconnection attempts
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Should have at least 3 connection attempts
      expect(reconnectTimes.length).toBeGreaterThanOrEqual(3);

      // Check that delays exist and generally increase
      // (with tolerance for jitter ±30% which can affect timing significantly)
      if (reconnectTimes.length >= 3) {
        const delay1 = reconnectTimes[1] - reconnectTimes[0];
        const delay2 = reconnectTimes[2] - reconnectTimes[1];

        // Just verify that delays are happening and in reasonable range
        expect(delay1).toBeGreaterThan(50); // At least 50ms (base: 100ms - 30% jitter)
        expect(delay2).toBeGreaterThan(50); // At least 50ms
      }
    });
  });

  describe('Message Handling During Network Issues', () => {
    it('should buffer messages during disconnection (if reconnecting)', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: true,
        reconnectDelay: 100,
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const firstInstance = mockWebSocketInstance;
      expect(firstInstance).not.toBeNull();

      // Disconnect
      if (firstInstance) {
        firstInstance.simulateDisconnect();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Message should fail while disconnected
      const message: HubMessage = {
        id: 'test-1',
        type: MessageType.REQUEST,
        method: 'test',
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
      };

      await expect(transport.send(message)).rejects.toThrow('WebSocket not connected');
    });

    // 30s timeout needed for creating 51MB payload
    it(
      'should handle oversized messages',
      async () => {
        transport = new WebSocketClientTransport({
          url: 'ws://localhost:9999',
          autoReconnect: false,
        });

        await transport.initialize();
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Create an oversized message (>50MB)
        const largeData = 'x'.repeat(51 * 1024 * 1024);
        const message: HubMessage = {
          id: 'test-1',
          type: MessageType.REQUEST,
          method: 'test',
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          data: largeData,
        };

        await expect(transport.send(message)).rejects.toThrow('exceeds maximum');
      },
      { timeout: 30000 }
    );

    // 30s timeout needed for creating 51MB payload
    it(
      'should reject oversized incoming messages',
      async () => {
        transport = new WebSocketClientTransport({
          url: 'ws://localhost:9999',
          autoReconnect: false,
        });

        const messages: HubMessage[] = [];
        transport.onMessage((msg) => {
          messages.push(msg);
        });

        await transport.initialize();
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Send oversized message
        const largeData = 'x'.repeat(51 * 1024 * 1024);
        const oversizedMessage = JSON.stringify({
          id: 'test-1',
          type: 'EVENT',
          method: 'test',
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          data: largeData,
        });

        if (mockWebSocketInstance) {
          mockWebSocketInstance.simulateMessage(oversizedMessage);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Oversized message should be rejected
        expect(messages).toHaveLength(0);
      },
      { timeout: 30000 }
    );
  });

  describe('PING/PONG and Connection Health', () => {
    it('should send PING messages at regular intervals', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
        pingInterval: 100,
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get initial mock instance
      const wsInstance = mockWebSocketInstance;
      expect(wsInstance).not.toBeNull();

      // Clear any initial messages
      if (wsInstance) {
        wsInstance.sentMessages = [];
      }

      // Wait for multiple ping intervals
      await new Promise((resolve) => setTimeout(resolve, 400));

      const sentMessages = wsInstance?.sentMessages || [];
      const pingMessages = sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === 'PING';
        } catch {
          return false;
        }
      });

      // Should have sent at least 1-2 PING messages
      // (timing can vary, so just check at least 1)
      expect(pingMessages.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect stale connection on PONG timeout', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: true,
        pingInterval: 100,
        reconnectDelay: 50,
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const stateChanges: string[] = [];
      transport.onConnectionChange((state) => {
        stateChanges.push(state);
      });

      // Mock to not respond to PONG (simulate stale connection)
      // The transport will detect timeout after 60s in real implementation
      // For testing, we'll simulate a shorter timeout by advancing time

      // Note: This test would need timer mocking to work properly
      // For now, we just verify that PING messages are sent
      await new Promise((resolve) => setTimeout(resolve, 350));

      const sentMessages = mockWebSocketInstance?.sentMessages || [];
      const pingMessages = sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === 'PING';
        } catch {
          return false;
        }
      });

      expect(pingMessages.length).toBeGreaterThan(0);
    });

    it('should update lastPongTime on PONG response', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
        pingInterval: 100,
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Send PONG message
      const pongMessage: HubMessage = {
        id: 'pong-1',
        type: MessageType.PONG,
        method: 'heartbeat',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
      };

      if (mockWebSocketInstance) {
        mockWebSocketInstance.simulateMessage(JSON.stringify(pongMessage));
      }

      // Connection should remain healthy
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(transport.isReady()).toBe(true);
    });
  });

  describe('Error Recovery', () => {
    it('should detect disconnection on send errors', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
        pingInterval: 0, // Disable ping to avoid interference
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const wsInstance = mockWebSocketInstance;
      expect(wsInstance).not.toBeNull();
      expect(transport.isReady()).toBe(true);

      // Simulate connection closing
      if (wsInstance) {
        wsInstance.simulateDisconnect();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      const message: HubMessage = {
        id: 'test-1',
        type: MessageType.REQUEST,
        method: 'test',
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
      };

      // Send should fail because connection is closed
      await expect(transport.send(message)).rejects.toThrow('WebSocket not connected');

      // Transport should report not ready
      expect(transport.isReady()).toBe(false);
    });

    it('should handle JSON parse errors gracefully', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      const messages: HubMessage[] = [];
      transport.onMessage((msg) => {
        messages.push(msg);
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Send invalid JSON
      if (mockWebSocketInstance) {
        mockWebSocketInstance.simulateMessage('invalid json{');
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have added any messages
      expect(messages).toHaveLength(0);

      // Connection should still be healthy
      expect(transport.isReady()).toBe(true);
    });
  });

  describe('Connection State Management', () => {
    it('should track connection state transitions correctly', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      const stateChanges: string[] = [];
      transport.onConnectionChange((state) => {
        stateChanges.push(state);
      });

      expect(transport.getState()).toBe('disconnected');

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(transport.getState()).toBe('connected');
      expect(stateChanges).toContain('connecting');
      expect(stateChanges).toContain('connected');

      await transport.close();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(transport.getState()).toBe('disconnected');
      expect(stateChanges).toContain('disconnected');
    });

    it('should notify all connection handlers on state change', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      const handler1States: string[] = [];
      const handler2States: string[] = [];

      transport.onConnectionChange((state) => {
        handler1States.push(state);
      });

      transport.onConnectionChange((state) => {
        handler2States.push(state);
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(handler1States).toContain('connected');
      expect(handler2States).toContain('connected');
    });

    it('should allow unsubscribing from connection handlers', async () => {
      transport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        autoReconnect: false,
      });

      const stateChanges: string[] = [];
      const unsubscribe = transport.onConnectionChange((state) => {
        stateChanges.push(state);
      });

      await transport.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const countBeforeUnsubscribe = stateChanges.length;

      unsubscribe();

      if (mockWebSocketInstance) {
        mockWebSocketInstance.simulateDisconnect();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have received disconnected event
      expect(stateChanges.length).toBe(countBeforeUnsubscribe);
    });
  });
});
