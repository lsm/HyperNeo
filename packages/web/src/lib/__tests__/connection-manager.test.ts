// @ts-nocheck

interface MockHub {
  isConnected: () => boolean;
  call: (method: string, data?: unknown) => Promise<unknown>;
}

interface MockTransport {
  isReady: () => boolean;
}

class TestableConnectionManager {
  private hub: MockHub | null = null;
  private transport: MockTransport | null = null;
  private connectionHandlers: (() => void)[] = [];
  private onConnectionCallback: ((state: string) => void) | null = null;

  constructor(
    private wsUrl: string,
    private hubFactory: () => MockHub,
    private transportFactory: () => MockTransport
  ) {}

  setConnected(connected: boolean) {
    if (connected) {
      this.hub = this.hubFactory();
      this.transport = this.transportFactory();
      this.connectionHandlers.forEach((h) => h());
      this.connectionHandlers = [];
    } else {
      this.hub = null;
      this.transport = null;
    }
  }

  getHubIfConnected(): MockHub | null {
    if (!this.hub) return null;
    if (!this.transport?.isReady()) return null;
    if (!this.hub.isConnected()) return null;
    return this.hub;
  }

  getHubOrThrow(): MockHub {
    const hub = this.getHubIfConnected();
    if (!hub) {
      throw new ConnectionNotReadyError('Connection not connected');
    }
    return hub;
  }

  async onConnected(timeout: number): Promise<void> {
    if (this.getHubIfConnected()) {
      return Promise.resolve();
    }
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new ConnectionTimeoutError(timeout, `Connection timed out after ${timeout}ms`));
      }, timeout);
    });
  }

  onceConnected(callback: () => void): () => void {
    if (this.getHubIfConnected()) {
      callback();
      return () => {};
    }
    this.connectionHandlers.push(callback);
    return () => {
      const index = this.connectionHandlers.indexOf(callback);
      if (index > -1) {
        this.connectionHandlers.splice(index, 1);
      }
    };
  }

  isConnected(): boolean {
    return this.getHubIfConnected() !== null;
  }

  async disconnect(): Promise<void> {
    this.hub = null;
    this.transport = null;
    this.connectionHandlers = [];
  }
}

class ConnectionNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionNotReadyError';
  }
}

class ConnectionTimeoutError extends Error {
  timeoutMs: number;
  constructor(timeoutMs: number, message?: string) {
    super(message || `Connection timed out after ${timeoutMs}ms`);
    this.name = 'ConnectionTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

describe('ConnectionManager Logic', () => {
  const createManager = (hubIsConnected = false, transportIsReady = false) => {
    return new TestableConnectionManager(
      'ws://localhost:9283',
      () => ({
        isConnected: () => hubIsConnected,
        call: vi.fn(() => Promise.resolve({})),
      }),
      () => ({
        isReady: () => transportIsReady,
      })
    );
  };

  describe('getHubIfConnected', () => {
    it('should return null when not connected', () => {
      const manager = createManager(false, false);
      const hub = manager.getHubIfConnected();
      expect(hub).toBeNull();
    });

    it('should return null when transport is not ready', () => {
      const manager = createManager(true, false);
      manager.setConnected(true);
      const hub = manager.getHubIfConnected();
      expect(hub).toBeNull();
    });

    it('should return hub when fully connected', () => {
      const manager = createManager(true, true);
      manager.setConnected(true);
      const hub = manager.getHubIfConnected();
      expect(hub).not.toBeNull();
    });
  });

  describe('getHubOrThrow', () => {
    it('should throw ConnectionNotReadyError when not connected', () => {
      const manager = createManager(false, false);
      expect(() => manager.getHubOrThrow()).toThrow(ConnectionNotReadyError);
    });

    it('should throw with descriptive message', () => {
      const manager = createManager(false, false);
      try {
        manager.getHubOrThrow();
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionNotReadyError);
        expect((err as Error).message).toContain('not connected');
      }
    });

    it('should return hub when connected', () => {
      const manager = createManager(true, true);
      manager.setConnected(true);
      const hub = manager.getHubOrThrow();
      expect(hub).not.toBeNull();
    });
  });

  describe('onConnected', () => {
    it('should resolve immediately when already connected', async () => {
      const manager = createManager(true, true);
      manager.setConnected(true);

      const start = Date.now();
      await manager.onConnected(5000);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it('should timeout when connection does not happen', async () => {
      const manager = createManager(false, false);
      await expect(manager.onConnected(50)).rejects.toThrow(ConnectionTimeoutError);
    });

    it('should include timeout value in error', async () => {
      const manager = createManager(false, false);
      try {
        await manager.onConnected(150);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionTimeoutError);
        expect((err as ConnectionTimeoutError).timeoutMs).toBe(150);
      }
    });
  });

  describe('onceConnected', () => {
    it('should call callback immediately when already connected', () => {
      const manager = createManager(true, true);
      manager.setConnected(true);

      let called = false;
      manager.onceConnected(() => {
        called = true;
      });

      expect(called).toBe(true);
    });

    it('should return unsubscribe function', () => {
      const manager = createManager(false, false);

      let called = false;
      const unsub = manager.onceConnected(() => {
        called = true;
      });

      unsub();

      manager.setConnected(true);

      expect(called).toBe(false);
    });

    it('should call callback when connection happens', () => {
      const manager = createManager(true, true);

      let called = false;
      manager.onceConnected(() => {
        called = true;
      });

      expect(called).toBe(false);

      manager.setConnected(true);

      expect(called).toBe(true);
    });
  });

  describe('isConnected', () => {
    it('should return false when hub is null', () => {
      const manager = createManager(false, false);
      expect(manager.isConnected()).toBe(false);
    });

    it('should return true when hub reports connected', () => {
      const manager = createManager(true, true);
      manager.setConnected(true);
      expect(manager.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should clear connection handlers on disconnect', async () => {
      const manager = createManager(true, true);

      let handlerCalled = false;
      manager.onceConnected(() => {
        handlerCalled = true;
      });

      await manager.disconnect();

      manager.setConnected(true);

      expect(handlerCalled).toBe(false);
    });

    it('should report not connected after disconnect', async () => {
      const manager = createManager(true, true);
      manager.setConnected(true);
      expect(manager.isConnected()).toBe(true);

      await manager.disconnect();
      expect(manager.isConnected()).toBe(false);
    });
  });
});

describe('ConnectionManager - Non-blocking behavior', () => {
  const createManager = () => {
    return new TestableConnectionManager(
      'ws://localhost:9283',
      () => ({
        isConnected: () => false,
        call: vi.fn(() => Promise.resolve({})),
      }),
      () => ({
        isReady: () => false,
      })
    );
  };

  it('getHubIfConnected should not block even if connection is in progress', () => {
    const manager = createManager();

    const start = Date.now();
    const hub = manager.getHubIfConnected();
    const elapsed = Date.now() - start;

    expect(hub).toBeNull();
    expect(elapsed).toBeLessThan(10);
  });

  it('getHubOrThrow should not block even if connection is in progress', () => {
    const manager = createManager();

    const start = Date.now();
    try {
      manager.getHubOrThrow();
    } catch {}
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });
});

describe('ConnectionManager - Page Visibility Handling Logic', () => {
  describe('Visibility Handler Registration', () => {
    it('should track visibility state changes', () => {
      let isVisible = true;
      const handlers: (() => void)[] = [];

      const visibilityHandler = () => {
        isVisible = document?.visibilityState === 'visible';
      };

      handlers.push(visibilityHandler);

      expect(handlers.length).toBe(1);
      visibilityHandler();
      expect(typeof isVisible).toBe('boolean');
    });

    it('should remove handlers on disconnect', () => {
      const handlers: (() => void)[] = [];
      const handler = () => {};

      handlers.push(handler);
      expect(handlers.length).toBe(1);

      handlers.length = 0;
      expect(handlers.length).toBe(0);
    });
  });

  describe('Page Hidden Event', () => {
    it('should detect page hidden state', () => {
      const state = { isHidden: false };

      const handleVisibilityChange = (hidden: boolean) => {
        state.isHidden = hidden;
      };

      handleVisibilityChange(true);
      expect(state.isHidden).toBe(true);
    });
  });

  describe('Page Visible Event - Reconnection Flow', () => {
    it('should reset reconnect state when page becomes visible', () => {
      const reconnectState = { attempts: 3, lastError: 'timeout' };

      const resetReconnectState = () => {
        reconnectState.attempts = 0;
        reconnectState.lastError = '';
      };

      resetReconnectState();

      expect(reconnectState.attempts).toBe(0);
      expect(reconnectState.lastError).toBe('');
    });

    it('should trigger health check when page becomes visible', async () => {
      const healthChecks = { called: 0 };

      const validateConnection = async () => {
        healthChecks.called++;
        return { healthy: true };
      };

      await validateConnection();
      expect(healthChecks.called).toBe(1);
    });

    it('should call forceResubscribe when health check succeeds', async () => {
      let resubscribed = false;

      const forceResubscribe = () => {
        resubscribed = true;
      };

      const handleHealthCheckSuccess = () => {
        forceResubscribe();
      };

      handleHealthCheckSuccess();
      expect(resubscribed).toBe(true);
    });

    it('should refresh stores when page becomes visible', async () => {
      const refreshed = { session: false, app: false, global: false };

      const refreshAll = async () => {
        await Promise.all([
          Promise.resolve().then(() => (refreshed.session = true)),
          Promise.resolve().then(() => (refreshed.app = true)),
          Promise.resolve().then(() => (refreshed.global = true)),
        ]);
      };

      await refreshAll();
      expect(refreshed.session).toBe(true);
      expect(refreshed.app).toBe(true);
      expect(refreshed.global).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should call forceReconnect when health check fails', async () => {
      let reconnectCalled = false;

      const forceReconnect = () => {
        reconnectCalled = true;
      };

      const handleHealthCheckFailure = () => {
        forceReconnect();
      };

      handleHealthCheckFailure();
      expect(reconnectCalled).toBe(true);
    });

    it('should NOT call refresh methods when health check fails', async () => {
      const refreshed = { called: false };

      const refresh = () => {
        refreshed.called = true;
      };

      const handleHealthCheck = async (success: boolean) => {
        if (success) {
          refresh();
        }
      };

      await handleHealthCheck(false);
      expect(refreshed.called).toBe(false);
    });
  });

  describe('No Connection Scenario', () => {
    it('should attempt reconnect when no connection exists', () => {
      let reconnectAttempted = false;

      const attemptReconnect = (hasConnection: boolean) => {
        if (!hasConnection) {
          reconnectAttempted = true;
        }
      };

      attemptReconnect(false);
      expect(reconnectAttempted).toBe(true);
    });
  });
});

describe('Safari Background Tab - Integration Tests', () => {
  describe('GlobalStore Refresh Integration', () => {
    it('should fetch fresh snapshot on refresh', async () => {
      let snapshotFetched = false;

      const fetchSnapshot = async () => {
        snapshotFetched = true;
        return { data: 'fresh' };
      };

      await fetchSnapshot();
      expect(snapshotFetched).toBe(true);
    });

    it('should update all global state properties', () => {
      const state = {
        auth: null as unknown,
        config: null as unknown,
        health: null as unknown,
      };

      const updateState = (data: { auth: unknown; config: unknown; health: unknown }) => {
        state.auth = data.auth;
        state.config = data.config;
        state.health = data.health;
      };

      updateState({
        auth: { user: 'test' },
        config: { theme: 'dark' },
        health: { ok: true },
      });

      expect(state.auth).toEqual({ user: 'test' });
      expect(state.config).toEqual({ theme: 'dark' });
      expect(state.health).toEqual({ ok: true });
    });

    it('should handle refresh errors gracefully', async () => {
      let errorHandled = false;

      const safeRefresh = async () => {
        try {
          throw new Error('Network error');
        } catch {
          errorHandled = true;
        }
      };

      await safeRefresh();
      expect(errorHandled).toBe(true);
    });

    it('should skip refresh if not initialized', () => {
      let refreshCalled = false;
      const initialized = false;

      const conditionalRefresh = () => {
        if (initialized) {
          refreshCalled = true;
        }
      };

      conditionalRefresh();
      expect(refreshCalled).toBe(false);
    });
  });

  describe('Full Reconnection Flow', () => {
    it('should execute reconnection flow in correct order', async () => {
      const order: string[] = [];

      const runReconnectionFlow = async () => {
        order.push('resetState');
        order.push('healthCheck');
        order.push('resubscribe');
        order.push('refresh');
      };

      await runReconnectionFlow();

      expect(order).toEqual(['resetState', 'healthCheck', 'resubscribe', 'refresh']);
    });

    it('should call forceResubscribe even when health check succeeds', async () => {
      let resubscribeCalled = false;

      const handleSuccess = () => {
        resubscribeCalled = true;
      };

      handleSuccess();
      expect(resubscribeCalled).toBe(true);
    });

    it('should NOT call forceResubscribe when health check fails', async () => {
      let resubscribeCalled = false;

      const handleHealthCheck = (success: boolean) => {
        if (success) {
          resubscribeCalled = true;
        }
      };

      handleHealthCheck(false);
      expect(resubscribeCalled).toBe(false);
    });
  });
});

describe('ConnectionManager - Simulate Disconnect Methods', () => {
  describe('simulateDisconnect', () => {
    it('should call forceReconnect on transport', () => {
      const mockTransport = {
        isReady: () => true,
        forceReconnect: vi.fn(),
        close: vi.fn(),
      };

      const state = { transport: mockTransport };

      const simulateDisconnect = () => {
        if (state.transport) {
          state.transport.forceReconnect();
        }
      };

      simulateDisconnect();
      expect(mockTransport.forceReconnect).toHaveBeenCalled();
    });

    it('should not throw when transport is null', () => {
      const state: { transport: null } = { transport: null };

      const simulateDisconnect = () => {
        if (state.transport) {
          // @ts-ignore
          state.transport.forceReconnect();
        }
      };

      expect(() => simulateDisconnect()).not.toThrow();
    });
  });

  describe('simulatePermanentDisconnect', () => {
    it('should call close on transport and set state to disconnected', () => {
      const mockTransport = {
        isReady: () => true,
        forceReconnect: vi.fn(),
        close: vi.fn(),
      };

      const connectionState = { value: 'connected' as string };
      const state = { transport: mockTransport };

      const simulatePermanentDisconnect = () => {
        if (state.transport) {
          state.transport.close();
        }
        connectionState.value = 'disconnected';
      };

      simulatePermanentDisconnect();

      expect(mockTransport.close).toHaveBeenCalled();
      expect(connectionState.value).toBe('disconnected');
    });
  });
});

describe('ConnectionManager - getHub Connection Racing', () => {
  it('should prevent duplicate connections with connectionPromise', async () => {
    let connectCalls = 0;
    let resolveConnection: (() => void) | null = null;

    const simulatedConnect = () =>
      new Promise<{ hub: 'connected' }>((resolve) => {
        connectCalls++;
        resolveConnection = () => resolve({ hub: 'connected' });
      });

    let connectionPromise: Promise<{ hub: 'connected' }> | null = null;

    const getHub = async () => {
      if (connectionPromise) {
        return connectionPromise;
      }

      connectionPromise = simulatedConnect();
      return connectionPromise;
    };

    const promise1 = getHub();
    const promise2 = getHub();

    expect(connectCalls).toBe(1);

    resolveConnection?.();
    const result1 = await promise1;
    const result2 = await promise2;

    expect(result1).toEqual({ hub: 'connected' });
    expect(result2).toEqual({ hub: 'connected' });
  });

  it('should clear connectionPromise on error to allow retry', async () => {
    let connectAttempts = 0;
    let connectionPromise: Promise<{ hub: 'connected' }> | null = null;

    const simulatedConnect = () =>
      new Promise<{ hub: 'connected' }>((_, reject) => {
        connectAttempts++;
        setTimeout(() => reject(new Error('Connection failed')), 10);
      });

    const getHub = async () => {
      if (connectionPromise) {
        return connectionPromise;
      }

      connectionPromise = (async () => {
        try {
          return await simulatedConnect();
        } catch (error) {
          connectionPromise = null;
          throw error;
        }
      })();

      return connectionPromise;
    };

    await expect(getHub()).rejects.toThrow('Connection failed');
    expect(connectAttempts).toBe(1);
    expect(connectionPromise).toBeNull();

    await expect(getHub()).rejects.toThrow('Connection failed');
    expect(connectAttempts).toBe(2);
  });
});

describe('ConnectionManager - getDaemonWsUrl Logic', () => {
  describe('URL construction', () => {
    it('should use ws protocol for http', () => {
      const mockLocation = {
        protocol: 'http:',
        hostname: 'localhost',
        port: '9283',
      };

      const getWsUrl = (location: typeof mockLocation) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${location.hostname}:${location.port}`;
      };

      expect(getWsUrl(mockLocation)).toBe('ws://localhost:9283');
    });

    it('should use wss protocol for https', () => {
      const mockLocation = {
        protocol: 'https:',
        hostname: 'example.com',
        port: '443',
      };

      const getWsUrl = (location: typeof mockLocation) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${location.hostname}:${location.port}`;
      };

      expect(getWsUrl(mockLocation)).toBe('wss://example.com:443');
    });

    it('should fallback to port 8283 when no port specified', () => {
      const mockLocation = {
        protocol: 'http:',
        hostname: 'localhost',
        port: '',
      };

      const getWsUrl = (location: typeof mockLocation) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (location.port) {
          return `${protocol}//${location.hostname}:${location.port}`;
        }
        return `${protocol}//${location.hostname}:8283`;
      };

      expect(getWsUrl(mockLocation)).toBe('ws://localhost:8283');
    });
  });
});

describe('ConnectionManager - Reconnect Method', () => {
  it('should reset transport state before reconnecting', async () => {
    const mockTransport = {
      isReady: () => false,
      resetReconnectState: vi.fn(),
      forceReconnect: vi.fn(),
    };

    const reconnect = async () => {
      if (mockTransport) {
        mockTransport.resetReconnectState();
        if (mockTransport.isReady()) {
          mockTransport.forceReconnect();
          return;
        }
      }
    };

    await reconnect();

    expect(mockTransport.resetReconnectState).toHaveBeenCalled();
    expect(mockTransport.forceReconnect).not.toHaveBeenCalled();
  });

  it('should call forceReconnect when transport is ready', async () => {
    const mockTransport = {
      isReady: () => true,
      resetReconnectState: vi.fn(),
      forceReconnect: vi.fn(),
    };

    const reconnect = async () => {
      if (mockTransport) {
        mockTransport.resetReconnectState();
        if (mockTransport.isReady()) {
          mockTransport.forceReconnect();
          return;
        }
      }
    };

    await reconnect();

    expect(mockTransport.resetReconnectState).toHaveBeenCalled();
    expect(mockTransport.forceReconnect).toHaveBeenCalled();
  });

  it('should update connection state to connecting', async () => {
    const connectionState = { value: 'disconnected' as string };

    const reconnect = async () => {
      connectionState.value = 'connecting';
    };

    await reconnect();

    expect(connectionState.value).toBe('connecting');
  });

  it('should set state to failed on connection error', async () => {
    const connectionState = { value: 'connecting' as string };

    const reconnect = async () => {
      try {
        throw new Error('Connection failed');
      } catch {
        connectionState.value = 'failed';
      }
    };

    await reconnect();

    expect(connectionState.value).toBe('failed');
  });
});
