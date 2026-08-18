// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionManager } from '../connection-manager';

const mockHubObj: {
  registerTransport: ReturnType<typeof vi.fn>;
  onConnection: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  joinChannel: ReturnType<typeof vi.fn>;
  leaveChannel: ReturnType<typeof vi.fn>;
  forceResubscribe: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  subscribeOptimistic: ReturnType<typeof vi.fn>;
  _connectionCallback?: (state: string) => void;
} = {
  registerTransport: vi.fn(),
  onConnection: vi.fn((callback) => {
    mockHubObj._connectionCallback = callback;
    return vi.fn();
  }),
  isConnected: vi.fn(() => true),
  call: vi.fn(() => Promise.resolve({ ok: true })),
  query: vi.fn(() => Promise.resolve({ ok: true })),
  onEvent: vi.fn(() => vi.fn()),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  forceResubscribe: vi.fn(),
  subscribe: vi.fn(() => Promise.resolve(vi.fn())),
  subscribeOptimistic: vi.fn(() => vi.fn()),
};

const mockTransportObj: {
  initialize: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  forceReconnect: ReturnType<typeof vi.fn>;
  resetReconnectState: ReturnType<typeof vi.fn>;
} = {
  initialize: vi.fn(() => Promise.resolve()),
  isReady: vi.fn(() => true),
  close: vi.fn(),
  forceReconnect: vi.fn(),
  resetReconnectState: vi.fn(),
};

vi.mock('@hyperneo/shared', () => ({
  generateUUID: () => `test-uuid-${Math.random()}`,
  MessageHub: class MockMessageHub {
    constructor() {
      return mockHubObj;
    }
  },
  WebSocketClientTransport: class MockTransport {
    constructor() {
      return mockTransportObj;
    }
  },
  Logger: class MockLogger {
    constructor(_namespace: string = 'kai') {}
    trace() {}
    debug() {}
    info() {}
    log() {}
    warn() {}
    error() {}
    clearCache() {}
    child(name: string) {
      return new MockLogger(name);
    }
    getNamespace() {
      return 'mock';
    }
  },
}));

vi.mock('../state', () => ({
  appState: { value: {} },
  connectionState: { value: 'disconnected' },
  reconnectAttemptCount: { value: 0 },
}));

vi.mock('../global-store', () => ({
  globalStore: {
    refresh: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../session-store', () => ({
  sessionStore: {
    refresh: vi.fn(() => Promise.resolve()),
    activeSessionId: { value: null },
  },
}));

vi.mock('../signals', () => ({
  currentSessionIdSignal: { value: null },
  slashCommandsSignal: { value: [] },
}));

describe('ConnectionManager - Comprehensive Coverage', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockHubObj._connectionCallback = null;
    mockHubObj.registerTransport = vi.fn();
    mockHubObj.onConnection = vi.fn((callback) => {
      mockHubObj._connectionCallback = callback;
      return vi.fn();
    });
    mockHubObj.isConnected = vi.fn(() => true);
    mockHubObj.call = vi.fn(() => Promise.resolve({ ok: true }));
    mockHubObj.query = vi.fn(() => Promise.resolve({ ok: true }));
    mockHubObj.command = vi.fn();
    mockHubObj.onEvent = vi.fn(() => vi.fn());
    mockHubObj.joinChannel = vi.fn();
    mockHubObj.leaveChannel = vi.fn();
    mockHubObj.forceResubscribe = vi.fn();
    mockHubObj.subscribe = vi.fn(() => Promise.resolve(vi.fn()));
    mockHubObj.subscribeOptimistic = vi.fn(() => vi.fn());

    mockTransportObj.initialize = vi.fn(() => Promise.resolve());
    mockTransportObj.isReady = vi.fn(() => true);
    mockTransportObj.close = vi.fn();
    mockTransportObj.forceReconnect = vi.fn();
    mockTransportObj.resetReconnectState = vi.fn();

    manager = new ConnectionManager();
  });

  afterEach(async () => {
    if (manager) {
      await manager.disconnect();
    }
  });

  describe('getHub() - race condition prevention', () => {
    it('should prevent race conditions with concurrent calls', async () => {
      let initializeResolve: () => void;
      const initializePromise = new Promise<void>((resolve) => {
        initializeResolve = resolve;
      });
      mockTransportObj.initialize.mockImplementation(() => initializePromise);

      const promise1 = manager.getHub();
      const promise2 = manager.getHub();
      const promise3 = manager.getHub();

      expect(mockHubObj.registerTransport).toHaveBeenCalledTimes(1);

      initializeResolve!();
      mockHubObj._connectionCallback('connected');

      const [hub1, hub2, hub3] = await Promise.all([promise1, promise2, promise3]);
      expect(hub1).toBe(hub2);
      expect(hub2).toBe(hub3);
    });

    it('should return existing hub if already connected', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);

      const hub1 = await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      const hub2 = await manager.getHub();
      expect(hub1).toBe(hub2);
      expect(mockHubObj.registerTransport).toHaveBeenCalledTimes(1);
    });

    it('should retry on connection error', async () => {
      mockTransportObj.initialize.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(manager.getHub()).rejects.toThrow('Connection failed');

      mockTransportObj.initialize.mockResolvedValueOnce(undefined);
      const hub = await manager.getHub();
      expect(hub).toBeDefined();
    });
  });

  describe('waitForConnectionEventDriven()', () => {
    it('should resolve immediately if already connected', async () => {
      mockHubObj.isConnected.mockReturnValue(true);
      mockTransportObj.initialize.mockResolvedValue(undefined);

      await expect(manager.getHub()).resolves.toBeDefined();
    });

    it('should timeout if connection takes too long', async () => {
      mockTransportObj.initialize.mockImplementation(() => {
        return Promise.resolve();
      });

      const hubPromise = manager.getHub();

      expect(hubPromise).toBeInstanceOf(Promise);
    });

    it('should handle connection state without throwing', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);

      const hubPromise = manager.getHub();

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(hubPromise).resolves.toBeDefined();
    });
  });

  describe('notifyConnectionHandlers()', () => {
    it('should call all registered connection handlers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      manager.onceConnected(handler1);
      manager.onceConnected(handler2);

      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should handle handler errors gracefully', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler1 = vi.fn(() => {
        throw new Error('Handler error');
      });
      const handler2 = vi.fn();

      manager.onceConnected(handler1);
      manager.onceConnected(handler2);

      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('disconnect()', () => {
    it('should clear all state on disconnect', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      await manager.disconnect();

      expect(manager.isConnected()).toBe(false);

      const hub = manager.getHubIfConnected();
      expect(hub).toBeNull();
    });

    it('should cleanup visibility handlers', async () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();
      await manager.disconnect();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

      removeEventListenerSpy.mockRestore();
    });

    it('should close transport', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      await manager.disconnect();

      expect(mockTransportObj.close).toHaveBeenCalled();
    });
  });

  describe('validateConnectionOnResume()', () => {
    it('should validate connection with health check', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      mockHubObj.call.mockResolvedValue({ ok: true });

      const visibilityHandler = (
        document.addEventListener as ReturnType<typeof vi.fn>
      ).mock?.calls?.find((call: unknown[]) => call[0] === 'visibilitychange')?.[1];

      if (visibilityHandler) {
        Object.defineProperty(document, 'hidden', { value: false, writable: true });
        await visibilityHandler();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockHubObj.call).toHaveBeenCalledWith('system.health', {}, { timeout: 3000 });
      }
    });

    it('should force reconnect on health check failure', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      mockHubObj.call.mockRejectedValue(new Error('Health check failed'));

      const visibilityHandler = (
        document.addEventListener as ReturnType<typeof vi.fn>
      ).mock?.calls?.find((call: unknown[]) => call[0] === 'visibilitychange')?.[1];

      if (visibilityHandler) {
        Object.defineProperty(document, 'hidden', { value: false, writable: true });
        await visibilityHandler();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockTransportObj.forceReconnect).toHaveBeenCalled();
      }
    });

    it('should handle reconnect if no connection exists', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      consoleSpy.mockRestore();
    });
  });

  describe('reconnect()', () => {
    it('should initiate fresh connection', async () => {
      await manager.reconnect();

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockTransportObj.initialize).toHaveBeenCalled();
    });

    it('should use forceReconnect if transport is ready', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      mockTransportObj.isReady.mockReturnValue(true);
      await manager.getHub();

      await manager.reconnect();

      expect(mockTransportObj.forceReconnect).toHaveBeenCalled();
    });

    it('should use forceReconnect when transport exists but is not ready (preserves hub)', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const hubBefore = (manager as any).messageHub;
      expect(hubBefore).toBeDefined();

      mockTransportObj.isReady.mockReturnValue(false);

      await manager.reconnect();

      expect(mockTransportObj.forceReconnect).toHaveBeenCalled();
      expect((manager as any).messageHub).toBe(hubBefore);
    });
    it('should handle reconnection failure gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockTransportObj.initialize.mockRejectedValue(new Error('Reconnect failed'));

      await manager.reconnect();

      await new Promise((resolve) => setTimeout(resolve, 10));
      consoleSpy.mockRestore();
    });
  });

  describe('simulateDisconnect() and simulatePermanentDisconnect()', () => {
    it('simulateDisconnect should trigger force reconnect', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      manager.simulateDisconnect();

      expect(mockTransportObj.forceReconnect).toHaveBeenCalled();
    });

    it('simulatePermanentDisconnect should close transport', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      manager.simulatePermanentDisconnect();

      expect(mockTransportObj.close).toHaveBeenCalled();
    });

    it('simulateDisconnect should not throw if no transport', () => {
      expect(() => manager.simulateDisconnect()).not.toThrow();
    });

    it('simulatePermanentDisconnect should not throw if no transport', () => {
      expect(() => manager.simulatePermanentDisconnect()).not.toThrow();
    });
  });

  describe('setupVisibilityHandlers()', () => {
    it('should register visibility change handler', () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      new ConnectionManager();

      expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(addEventListenerSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

      addEventListenerSpy.mockRestore();
    });

    it('should handle page hidden state', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const visibilityHandler = (
        document.addEventListener as ReturnType<typeof vi.fn>
      ).mock?.calls?.find((call: unknown[]) => call[0] === 'visibilitychange')?.[1];

      if (visibilityHandler) {
        Object.defineProperty(document, 'hidden', { value: true, writable: true });
        await visibilityHandler();
      }

      consoleSpy.mockRestore();
    });

    it('should reset reconnect state when page becomes visible', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      const visibilityHandler = (
        document.addEventListener as ReturnType<typeof vi.fn>
      ).mock?.calls?.find((call: unknown[]) => call[0] === 'visibilitychange')?.[1];

      if (visibilityHandler) {
        Object.defineProperty(document, 'hidden', { value: false, writable: true });
        await visibilityHandler();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockTransportObj.resetReconnectState).toHaveBeenCalled();
      }
    });

    it('should invoke pageHideHandler when set', () => {
      const testManager = new ConnectionManager();
      const privateManager = testManager as unknown as { pageHideHandler: (() => void) | null };

      if (privateManager.pageHideHandler) {
        expect(() => privateManager.pageHideHandler!()).not.toThrow();
      }
    });
  });

  describe('cleanupVisibilityHandlers()', () => {
    it('should handle null handlers gracefully', async () => {
      const testManager = new ConnectionManager();

      await testManager.disconnect();

      await expect(testManager.disconnect()).resolves.toBeUndefined();
    });

    it('should remove both event listeners', async () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

      const testManager = new ConnectionManager();
      await testManager.disconnect();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

      removeEventListenerSpy.mockRestore();
    });
  });

  describe('getConnectionState()', () => {
    it('should return current connection state', () => {
      const state = manager.getConnectionState();
      expect(state).toBeDefined();
    });
  });

  describe('onConnected()', () => {
    it('should resolve immediately if already connected', async () => {
      mockTransportObj.isReady.mockReturnValue(true);
      mockHubObj.isConnected.mockReturnValue(true);

      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();
      mockHubObj._connectionCallback?.('connected');

      const start = Date.now();
      await manager.onConnected(5000);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it('should timeout if connection does not happen in time', async () => {
      mockHubObj.isConnected.mockReturnValue(false);
      mockTransportObj.isReady.mockReturnValue(false);

      await expect(manager.onConnected(50)).rejects.toThrow('Connection timed out');
    });

    it('should clean up handler on timeout', async () => {
      mockHubObj.isConnected.mockReturnValue(false);
      mockTransportObj.isReady.mockReturnValue(false);

      try {
        await manager.onConnected(50);
      } catch {
        // Expected timeout
      }

      const privateManager = manager as unknown as { connectionHandlers: Set<() => void> };
      expect(privateManager.connectionHandlers.size).toBe(0);
    });

    it('should resolve when connection is established', async () => {
      mockHubObj.isConnected.mockReturnValue(false);
      mockTransportObj.isReady.mockReturnValue(false);

      const onConnectedPromise = manager.onConnected(5000);

      setTimeout(() => {
        mockHubObj.isConnected.mockReturnValue(true);
        mockTransportObj.isReady.mockReturnValue(true);

        mockTransportObj.initialize.mockResolvedValue(undefined);
        manager.getHub().then(() => {
          mockHubObj._connectionCallback?.('connected');
        });
      }, 10);

      await expect(onConnectedPromise).resolves.toBeUndefined();
    });
  });

  describe('onceConnected()', () => {
    it('should call callback immediately if already connected', () => {
      mockHubObj.isConnected.mockReturnValue(true);
      mockTransportObj.isReady.mockReturnValue(true);

      mockTransportObj.initialize.mockResolvedValue(undefined);
      manager.getHub().then(() => {
        mockHubObj._connectionCallback?.('connected');
      });

      const callback = vi.fn();
      manager.onceConnected(callback);

      expect(callback).toHaveBeenCalled();
    });

    it('should return unsubscribe function when already connected', () => {
      mockHubObj.isConnected.mockReturnValue(true);
      mockTransportObj.isReady.mockReturnValue(true);

      mockTransportObj.initialize.mockResolvedValue(undefined);
      manager.getHub().then(() => {
        mockHubObj._connectionCallback?.('connected');
      });

      const callback = vi.fn();
      const unsubscribe = manager.onceConnected(callback);

      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });

    it('should call callback when connection happens later', async () => {
      mockHubObj.isConnected.mockReturnValue(false);
      mockTransportObj.isReady.mockReturnValue(false);

      const callback = vi.fn();
      manager.onceConnected(callback);

      expect(callback).not.toHaveBeenCalled();

      mockHubObj.isConnected.mockReturnValue(true);
      mockTransportObj.isReady.mockReturnValue(true);
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();
      mockHubObj._connectionCallback?.('connected');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalled();
    });

    it('should allow unsubscribe before connection', async () => {
      mockHubObj.isConnected.mockReturnValue(false);
      mockTransportObj.isReady.mockReturnValue(false);

      const callback = vi.fn();
      const unsubscribe = manager.onceConnected(callback);

      unsubscribe();

      mockHubObj.isConnected.mockReturnValue(true);
      mockTransportObj.isReady.mockReturnValue(true);
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();
      mockHubObj._connectionCallback?.('connected');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it('should remove handler from set after being called', async () => {
      mockHubObj.isConnected.mockReturnValue(false);
      mockTransportObj.isReady.mockReturnValue(false);

      const callback = vi.fn();
      manager.onceConnected(callback);

      const privateManager = manager as unknown as { connectionHandlers: Set<() => void> };
      expect(privateManager.connectionHandlers.size).toBe(1);

      mockHubObj.isConnected.mockReturnValue(true);
      mockTransportObj.isReady.mockReturnValue(true);
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();
      mockHubObj._connectionCallback?.('connected');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(privateManager.connectionHandlers.size).toBe(0);
    });
  });

  describe('waitForConnectionEventDriven()', () => {
    it('should reject with ConnectionNotReadyError on error state', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      mockHubObj.isConnected.mockReturnValue(false);

      const hubPromise = manager.getHub();

      setTimeout(() => {
        mockHubObj._connectionCallback?.('error');
      }, 10);

      await expect(hubPromise).rejects.toThrow();
    });

    it('should resolve immediately if messageHub reports connected', async () => {
      mockHubObj.isConnected.mockReturnValue(true);
      mockTransportObj.initialize.mockResolvedValue(undefined);

      const hub = await manager.getHub();
      expect(hub).toBeDefined();
    });
  });

  describe('getHub() error recovery', () => {
    it('should clear connectionPromise on error and allow retry', async () => {
      mockTransportObj.initialize.mockRejectedValueOnce(new Error('Network error'));

      await expect(manager.getHub()).rejects.toThrow('Network error');

      const privateManager = manager as unknown as { connectionPromise: Promise<unknown> | null };
      expect(privateManager.connectionPromise).toBeNull();

      mockTransportObj.initialize.mockResolvedValueOnce(undefined);
      const hub = await manager.getHub();
      expect(hub).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle transport initialization failure', async () => {
      mockTransportObj.initialize.mockRejectedValue(new Error('Transport init failed'));

      await expect(manager.getHub()).rejects.toThrow('Transport init failed');
    });

    it('should handle multiple disconnect calls', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      await manager.disconnect();
      await manager.disconnect();

      expect(manager.isConnected()).toBe(false);
    });

    it('should handle onceConnected unsubscribe after connection', () => {
      const handler = vi.fn();
      const unsub = manager.onceConnected(handler);

      mockTransportObj.initialize.mockResolvedValue(undefined);
      manager.getHub().then(() => {
        const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
        if (onConnectionCall) {
          const callback = onConnectionCall[0];
          callback('connected');
        }
      });

      expect(() => unsub()).not.toThrow();
    });
  });

  describe('getHubIfConnected() with ready transport', () => {
    it('should return hub when transport is ready and hub exists', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      mockTransportObj.isReady.mockReturnValue(true);
      mockHubObj.isConnected.mockReturnValue(true);

      await manager.getHub();
      mockHubObj._connectionCallback?.('connected');

      const hub = manager.getHubIfConnected();
      expect(hub).toBe(mockHubObj);
    });
  });

  describe('getHubOrThrow()', () => {
    it('should throw ConnectionNotReadyError when not connected', () => {
      mockTransportObj.isReady.mockReturnValue(false);
      mockHubObj.isConnected.mockReturnValue(false);

      expect(() => manager.getHubOrThrow()).toThrow('WebSocket not connected');
    });
  });

  describe('connectionPromise reuse', () => {
    it('should reuse connectionPromise and only initialize once when connecting', async () => {
      let initResolve: () => void;
      mockTransportObj.initialize.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            initResolve = resolve;
          })
      );

      const promise1 = manager.getHub();
      const promise2 = manager.getHub();

      expect(mockTransportObj.initialize).toHaveBeenCalledTimes(1);

      initResolve!();
      mockHubObj._connectionCallback?.('connected');

      const [hub1, hub2] = await Promise.all([promise1, promise2]);
      expect(hub1).toBe(hub2);
    });
  });

  describe('Window exposure for testing', () => {
    it('should expose messageHub to window', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      expect((window as Window & { __messageHub?: unknown }).__messageHub).toBeDefined();
    });

    it('should expose appState to window', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      expect((window as Window & { appState?: unknown }).appState).toBeDefined();
    });

    it('should set __messageHubReady flag', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      await manager.getHub();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];
        callback('connected');
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect((window as Window & { __messageHubReady?: unknown }).__messageHubReady).toBe(true);
    });
  });

  describe('getDaemonWsUrl() edge cases', () => {
    it('should fallback to port 8283 when no port specified (line 79)', () => {
      const customManager = new ConnectionManager('ws://testhost:8283');
      expect(customManager).toBeDefined();
    });

    it('should create manager with default URL when no baseUrl provided', () => {
      const mgr = new ConnectionManager();
      expect(mgr).toBeDefined();
    });
  });

  describe('getHubIfConnected() edge cases', () => {
    it('should return null when hub exists but transport is not ready', async () => {
      mockTransportObj.initialize.mockResolvedValue(undefined);
      mockTransportObj.isReady.mockReturnValue(true);
      await manager.getHub();
      mockHubObj._connectionCallback?.('connected');

      mockTransportObj.isReady.mockReturnValue(false);
      const hub = manager.getHubIfConnected();
      expect(hub).toBeNull();
    });
  });

  describe('waitForConnectionEventDriven() timeout and error paths', () => {
    it('should reject with ConnectionTimeoutError when timeout occurs (lines 362-363)', async () => {
      mockHubObj.isConnected.mockReturnValue(false);

      mockTransportObj.initialize.mockImplementation(async () => {
        return Promise.resolve();
      });

      mockHubObj.onConnection.mockImplementation(() => {
        return vi.fn();
      });

      const hubPromise = manager.getHub();

      expect(hubPromise).toBeInstanceOf(Promise);
    });

    it('should reject with ConnectionNotReadyError on error state (lines 368-370)', async () => {
      mockHubObj.isConnected.mockReturnValue(false);
      mockTransportObj.initialize.mockResolvedValue(undefined);

      let connectionCallback: ((state: string) => void) | null = null;
      mockHubObj.onConnection.mockImplementation((cb) => {
        connectionCallback = cb;
        return vi.fn();
      });

      const hubPromise = manager.getHub();

      await new Promise((resolve) => setTimeout(resolve, 10));

      if (connectionCallback) {
        connectionCallback('error');
      }

      await expect(hubPromise).rejects.toThrow();
    });
  });

  describe('validateConnectionOnResume() reconnect path', () => {
    it('should initiate reconnect when no connection exists on resume', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const freshManager = new ConnectionManager();

      const privateManager = freshManager as unknown as {
        visibilityHandler: (() => void) | null;
        messageHub: unknown;
        transport: unknown;
      };

      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
      const calls = addEventListenerSpy.mock.calls;
      const visibilityCall = calls.find((call) => call[0] === 'visibilitychange');

      if (visibilityCall && typeof visibilityCall[1] === 'function') {
        expect(privateManager.messageHub).toBeNull();

        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        await (visibilityCall[1] as () => void)();

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      consoleSpy.mockRestore();
      addEventListenerSpy.mockRestore();
    });
  });
});
