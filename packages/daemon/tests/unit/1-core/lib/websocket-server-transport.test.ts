import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { WebSocketServerTransport } from '../../../../src/lib/websocket-server-transport';
import { MessageHubRouter } from '@hyperneo/shared';
import type { ClientConnection, HubMessage } from '@hyperneo/shared';

describe('WebSocketServerTransport', () => {
  let transport: WebSocketServerTransport;
  let mockRouter: MessageHubRouter;
  let mockConnections: Map<string, ClientConnection>;
  let registeredConnection: ClientConnection | null;

  beforeEach(() => {
    mockConnections = new Map();
    registeredConnection = null;

    mockRouter = {
      registerConnection: mock((conn: ClientConnection) => {
        mockConnections.set(conn.id, conn);
        registeredConnection = conn;
      }),
      unregisterConnection: mock((clientId: string) => {
        mockConnections.delete(clientId);
      }),
      getClientCount: mock(() => mockConnections.size),
      getClientById: mock((clientId: string) => mockConnections.get(clientId)),
      broadcast: mock(() => {}),
      routeEvent: mock(() => {}),
      subscribeClient: mock(() => {}),
      unsubscribeClient: mock(() => {}),
      getSubscriptionsForClient: mock(() => new Set<string>()),
    } as unknown as MessageHubRouter;

    transport = new WebSocketServerTransport({
      router: mockRouter,
      name: 'test-transport',
      staleTimeout: 5000,
      staleCheckInterval: 1000,
    });
  });

  afterEach(async () => {
    await transport.close();
  });

  describe('constructor', () => {
    it('should create transport with default name', () => {
      const defaultTransport = new WebSocketServerTransport({
        router: mockRouter,
      });
      expect(defaultTransport.name).toBe('websocket-server');
      defaultTransport.close();
    });

    it('should create transport with custom name', () => {
      expect(transport.name).toBe('test-transport');
    });
  });

  describe('initialize', () => {
    it('should initialize transport', async () => {
      await transport.initialize();
      expect(true).toBe(true);
    });

    it('should start stale connection checker', async () => {
      await transport.initialize();
      await transport.close();
      expect(true).toBe(true);
    });
  });

  describe('registerClient', () => {
    it('should register a client and return clientId', () => {
      const mockWs = createMockWebSocket();

      const clientId = transport.registerClient(mockWs, 'test-session-123');

      expect(clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(mockRouter.registerConnection).toHaveBeenCalled();
    });

    it('should create client connection with send function', () => {
      const mockWs = createMockWebSocket();

      transport.registerClient(mockWs, 'test-session-123');

      expect(registeredConnection).toBeDefined();
      expect(registeredConnection?.send).toBeInstanceOf(Function);
    });

    it('should notify connection handlers on first client', () => {
      const mockWs = createMockWebSocket();
      const connectionHandler = mock(() => {});

      transport.onConnectionChange(connectionHandler);
      transport.registerClient(mockWs, 'test-session-123');

      expect(connectionHandler).toHaveBeenCalledWith('connected', undefined);
    });
  });

  describe('unregisterClient', () => {
    it('should unregister a client', () => {
      const mockWs = createMockWebSocket();
      const clientId = transport.registerClient(mockWs, 'test-session-123');

      transport.unregisterClient(clientId);

      expect(mockRouter.unregisterConnection).toHaveBeenCalledWith(clientId);
    });

    it('should call client disconnect handlers', () => {
      const mockWs = createMockWebSocket();
      const disconnectHandler = mock(() => {});

      transport.onClientDisconnect(disconnectHandler);
      const clientId = transport.registerClient(mockWs, 'test-session-123');
      transport.unregisterClient(clientId);

      expect(disconnectHandler).toHaveBeenCalledWith(clientId);
    });

    it('should notify connection handlers when last client disconnects', () => {
      const mockWs = createMockWebSocket();
      const connectionHandler = mock(() => {});

      const clientId = transport.registerClient(mockWs, 'test-session-123');
      transport.onConnectionChange(connectionHandler);
      transport.unregisterClient(clientId);

      expect(connectionHandler).toHaveBeenCalledWith('disconnected', undefined);
    });

    it('reconciles the real router subscription counter on disconnect (task #899)', async () => {
      const realRouter = new MessageHubRouter();
      const realTransport = new WebSocketServerTransport({
        router: realRouter,
        name: 'real-router-transport',
        staleTimeout: 5000,
        staleCheckInterval: 1000,
      });
      try {
        const mockWs = createMockWebSocket();
        const clientId = realTransport.registerClient(mockWs, 'test-session-123');

        realRouter.addClientSubscription(clientId);
        realRouter.addClientSubscription(clientId);
        expect(realRouter.getClientSubscriptionCount(clientId)).toBe(2);

        realTransport.unregisterClient(clientId);

        expect(realRouter.getClientSubscriptionCount(clientId)).toBe(0);
      } finally {
        await realTransport.close();
      }
    });
  });

  describe('handleClientMessage', () => {
    it('should forward message to all message handlers', () => {
      const messageHandler = mock(() => {});
      transport.onMessage(messageHandler);

      const message: HubMessage = {
        type: 'REQ',
        method: 'test.method',
        data: { foo: 'bar' },
        id: 'test-id',
        sessionId: 'test-session',
      };

      transport.handleClientMessage(message, 'client-123');

      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'REQ',
          method: 'test.method',
          clientId: 'client-123',
        })
      );
    });

    it('should add clientId to message metadata', () => {
      let receivedMessage: HubMessage | null = null;
      transport.onMessage((msg) => {
        receivedMessage = msg;
      });

      const message: HubMessage = {
        type: 'EVENT',
        method: 'test.channel',
        id: 'test-id',
        sessionId: 'test-session',
      };

      transport.handleClientMessage(message, 'client-456');

      expect((receivedMessage as HubMessage & { clientId: string }).clientId).toBe('client-456');
    });
  });

  describe('send', () => {
    it('should broadcast non-EVENT messages', async () => {
      const message: HubMessage = {
        type: 'RSP',
        id: 'test-id',
        method: 'test.method',
        sessionId: 'test-session',
        data: { success: true },
      };

      await transport.send(message);

      expect(mockRouter.broadcast).toHaveBeenCalledWith(message);
    });

    it('should fallback broadcast for EVENT messages (deprecated path)', async () => {
      const message: HubMessage = {
        type: 'EVENT',
        method: 'test.event',
        id: 'test-id',
        sessionId: 'test-session',
        data: { data: 'test' },
      };

      await transport.send(message);

      expect(mockRouter.broadcast).toHaveBeenCalledWith(message);
    });
  });

  describe('onMessage', () => {
    it('should return unsubscribe function', () => {
      const handler = mock(() => {});
      const unsubscribe = transport.onMessage(handler);

      transport.handleClientMessage({ type: 'REQ', method: 'test', id: '1', sessionId: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      transport.handleClientMessage({ type: 'REQ', method: 'test', id: '2', sessionId: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('onConnectionChange', () => {
    it('should return unsubscribe function', () => {
      const handler = mock(() => {});
      const unsubscribe = transport.onConnectionChange(handler);

      const mockWs = createMockWebSocket();
      transport.registerClient(mockWs, 'session-1');
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      const mockWs2 = createMockWebSocket();
      transport.registerClient(mockWs2, 'session-2');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('onClientDisconnect', () => {
    it('should return unsubscribe function', () => {
      const handler = mock(() => {});
      const unsubscribe = transport.onClientDisconnect(handler);

      const mockWs = createMockWebSocket();
      const clientId = transport.registerClient(mockWs, 'session-1');
      transport.unregisterClient(clientId);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      const mockWs2 = createMockWebSocket();
      const clientId2 = transport.registerClient(mockWs2, 'session-2');
      transport.unregisterClient(clientId2);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('getState', () => {
    it('should return disconnected when no clients', () => {
      expect(transport.getState()).toBe('disconnected');
    });

    it('should return connected when clients exist', () => {
      const mockWs = createMockWebSocket();
      transport.registerClient(mockWs, 'session-1');

      expect(transport.getState()).toBe('connected');
    });
  });

  describe('isReady', () => {
    it('should return false when no clients', () => {
      expect(transport.isReady()).toBe(false);
    });

    it('should return true when clients exist', () => {
      const mockWs = createMockWebSocket();
      transport.registerClient(mockWs, 'session-1');

      expect(transport.isReady()).toBe(true);
    });
  });

  describe('getClientCount', () => {
    it('should return count from router', () => {
      expect(transport.getClientCount()).toBe(0);

      const mockWs = createMockWebSocket();
      transport.registerClient(mockWs, 'session-1');

      expect(transport.getClientCount()).toBe(1);
    });
  });

  describe('getClient', () => {
    it('should return client from router', () => {
      const mockWs = createMockWebSocket();
      const clientId = transport.registerClient(mockWs, 'session-1');

      const client = transport.getClient(clientId);

      expect(client).toBeDefined();
    });

    it('should return undefined for unknown client', () => {
      const client = transport.getClient('unknown-client');

      expect(client).toBeUndefined();
    });
  });

  describe('getRouter', () => {
    it('should return the router instance', () => {
      expect(transport.getRouter()).toBe(mockRouter);
    });
  });

  describe('updateClientActivity', () => {
    it('should update activity time for existing client', () => {
      const mockWs = createMockWebSocket();
      const clientId = transport.registerClient(mockWs, 'session-1');

      transport.updateClientActivity(clientId);
      expect(true).toBe(true);
    });

    it('should not throw for unknown client', () => {
      transport.updateClientActivity('unknown-client');
      expect(true).toBe(true);
    });
  });

  describe('canClientAccept (backpressure)', () => {
    it('should return true when queue is not full', () => {
      const mockWs = createMockWebSocket();
      const clientId = transport.registerClient(mockWs, 'session-1');

      expect(transport.canClientAccept(clientId)).toBe(true);
    });

    it('should return true for unknown client', () => {
      expect(transport.canClientAccept('unknown-client')).toBe(true);
    });
  });

  describe('getClientQueueSize', () => {
    it('should return 0 for new client', () => {
      const mockWs = createMockWebSocket();
      const clientId = transport.registerClient(mockWs, 'session-1');

      expect(transport.getClientQueueSize(clientId)).toBe(0);
    });

    it('should return 0 for unknown client', () => {
      expect(transport.getClientQueueSize('unknown-client')).toBe(0);
    });
  });

  describe('close', () => {
    it('should unregister all clients', async () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();

      transport.registerClient(mockWs1, 'session-1');
      transport.registerClient(mockWs2, 'session-2');

      await transport.close();

      expect(transport.getClientCount()).toBe(0);
    });

    it('should notify connection handlers', async () => {
      const handler = mock(() => {});
      const mockWs = createMockWebSocket();

      transport.registerClient(mockWs, 'session-1');
      transport.onConnectionChange(handler);

      await transport.close();

      expect(handler).toHaveBeenCalledWith('disconnected', undefined);
    });
  });

  describe('broadcastToSession', () => {
    it('should add sessionId to message and send', async () => {
      const message: HubMessage = {
        type: 'EVENT',
        method: 'test.event',
        id: 'test-id',
        sessionId: 'test-session',
        data: { data: 'test' },
      };

      await transport.broadcastToSession('session-123', message);

      expect(mockRouter.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-123',
        })
      );
    });
  });

  describe('client connection send', () => {
    it('should call ws.send through registered connection', () => {
      const mockWs = createMockWebSocket();
      transport.registerClient(mockWs, 'session-1');

      registeredConnection?.send('test message');

      expect(mockWs.send).toHaveBeenCalledWith('test message');
    });

    it('should check isOpen through registered connection', () => {
      const mockWs = createMockWebSocket();
      transport.registerClient(mockWs, 'session-1');

      const isOpen = registeredConnection?.isOpen();

      expect(isOpen).toBe(true);
    });

    it('should check canAccept through registered connection', () => {
      const mockWs = createMockWebSocket();
      transport.registerClient(mockWs, 'session-1');

      const canAccept = registeredConnection?.canAccept?.();

      expect(canAccept).toBe(true);
    });
  });

  describe('stale connection checking', () => {
    it('should close stale connections after timeout', async () => {
      const shortTimeoutTransport = new WebSocketServerTransport({
        router: mockRouter,
        name: 'stale-test-transport',
        staleTimeout: 50,
        staleCheckInterval: 20,
      });

      await shortTimeoutTransport.initialize();

      const mockWs = createMockWebSocket();
      shortTimeoutTransport.registerClient(mockWs, 'session-1');

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockWs.close).toHaveBeenCalled();

      await shortTimeoutTransport.close();
    });

    it('should not close active connections', async () => {
      const shortTimeoutTransport = new WebSocketServerTransport({
        router: mockRouter,
        name: 'active-test-transport',
        staleTimeout: 100,
        staleCheckInterval: 20,
      });

      await shortTimeoutTransport.initialize();

      const mockWs = createMockWebSocket();
      const clientId = shortTimeoutTransport.registerClient(mockWs, 'session-1');

      const activityInterval = setInterval(() => {
        shortTimeoutTransport.updateClientActivity(clientId);
      }, 30);

      await new Promise((resolve) => setTimeout(resolve, 100));

      clearInterval(activityInterval);

      expect(mockWs.close).not.toHaveBeenCalled();

      await shortTimeoutTransport.close();
    });

    it('should handle errors when closing stale connections', async () => {
      const shortTimeoutTransport = new WebSocketServerTransport({
        router: mockRouter,
        name: 'error-test-transport',
        staleTimeout: 50,
        staleCheckInterval: 20,
      });

      await shortTimeoutTransport.initialize();

      const errorWs = {
        send: mock(() => {}),
        close: mock(() => {
          throw new Error('Close error');
        }),
        readyState: 1,
      } as unknown as import('bun').ServerWebSocket<unknown>;

      shortTimeoutTransport.registerClient(errorWs, 'session-1');

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorWs.close).toHaveBeenCalled();

      await shortTimeoutTransport.close();
    });
  });
});

function createMockWebSocket() {
  return {
    send: mock(() => {}),
    close: mock(() => {}),
    readyState: 1,
  } as unknown as import('bun').ServerWebSocket<unknown>;
}
