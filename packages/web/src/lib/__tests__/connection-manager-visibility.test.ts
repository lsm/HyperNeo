// @ts-nocheck
/**
 * Unit tests for ConnectionManager page visibility handling
 *
 * Tests the Safari background tab reconnection behavior:
 * - Page visibility change detection
 * - Force resubscription on foreground return
 * - State refresh after validation
 */

import { ConnectionManager } from '../connection-manager';
import { globalStore } from '../global-store';
import { sessionStore } from '../session-store';
import { appState } from '../state';

describe('ConnectionManager - Page Visibility Handling', () => {
  let connectionManager: ConnectionManager;
  let visibilityChangeHandler: ((event: Event) => void) | null = null;
  let pageHideHandler: ((event: Event) => void) | null = null;
  let originalAddEventListener: unknown;
  let originalRemoveEventListener: unknown;

  beforeEach(() => {
    // Capture original methods
    originalAddEventListener = global.document?.addEventListener;
    originalRemoveEventListener = global.document?.removeEventListener;

    // Mock to capture event listeners
    global.document.addEventListener = vi.fn((type: string, listener: EventListener) => {
      if (type === 'visibilitychange') {
        visibilityChangeHandler = listener as (event: Event) => void;
      } else if (type === 'pagehide') {
        pageHideHandler = listener as (event: Event) => void;
      }
      // Don't request original - just track handlers
    }) as unknown as typeof global.document.addEventListener;

    global.document.removeEventListener = vi.fn((type: string, listener: EventListener) => {
      if (type === 'visibilitychange' && listener === visibilityChangeHandler) {
        visibilityChangeHandler = null;
      } else if (type === 'pagehide' && listener === pageHideHandler) {
        pageHideHandler = null;
      }
      // Don't request original - just track handlers
    }) as unknown as typeof global.document.addEventListener;

    connectionManager = new ConnectionManager();
  });

  afterEach(() => {
    if (originalAddEventListener) {
      global.document.addEventListener = originalAddEventListener;
    }
    if (originalRemoveEventListener) {
      global.document.removeEventListener = originalRemoveEventListener;
    }
    visibilityChangeHandler = null;
    pageHideHandler = null;
  });

  describe('Visibility Handler Registration', () => {
    it('should register visibilitychange handler on construction', () => {
      expect(visibilityChangeHandler).not.toBeNull();
    });

    it('should register pagehide handler on construction', () => {
      expect(pageHideHandler).not.toBeNull();
    });

    it('should remove handlers on disconnect', async () => {
      await connectionManager.disconnect();
      expect(document.removeEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function)
      );
      expect(document.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    });
  });

  describe('Page Hidden Event', () => {
    it('should handle page becoming hidden without error', () => {
      // Simulate page becoming hidden
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });

      // Should not throw when page becomes hidden
      expect(() => visibilityChangeHandler?.(new Event('visibilitychange'))).not.toThrow();
    });
  });

  describe('Page Visible Event - Reconnection Flow', () => {
    let mockTransport: Record<string, unknown>;
    let mockMessageHub: Record<string, unknown>;
    beforeEach(() => {
      // Create mock transport with resetReconnectState
      mockTransport = {
        isReady: vi.fn(() => true),
        resetReconnectState: vi.fn(() => {}),
        forceReconnect: vi.fn(() => {}),
        close: vi.fn(() => {}),
      };

      // Create mock MessageHub
      mockMessageHub = {
        request: vi.fn(() => Promise.resolve({ status: 'ok' })),
        forceResubscribe: vi.fn(() => {}),
        isConnected: vi.fn(() => true),
        joinChannel: vi.fn(() => {}),
        leaveChannel: vi.fn(() => {}),
      };

      // Inject mocks into connection manager
      (connectionManager as unknown as Record<string, unknown>).transport = mockTransport;
      (connectionManager as unknown as Record<string, unknown>).messageHub = mockMessageHub;
    });

    afterEach(() => {
      // Restore all mocks to prevent test pollution
      const sessionStoreRefresh = sessionStore.refresh as unknown;
      if (
        typeof sessionStoreRefresh === 'object' &&
        sessionStoreRefresh !== null &&
        'mockRestore' in sessionStoreRefresh &&
        typeof (sessionStoreRefresh as { mockRestore: unknown }).mockRestore === 'function'
      ) {
        (sessionStoreRefresh as { mockRestore: () => void }).mockRestore();
      }
      const appStateRefresh = appState.refreshAll as unknown;
      if (
        typeof appStateRefresh === 'object' &&
        appStateRefresh !== null &&
        'mockRestore' in appStateRefresh &&
        typeof (appStateRefresh as { mockRestore: unknown }).mockRestore === 'function'
      ) {
        (appStateRefresh as { mockRestore: () => void }).mockRestore();
      }
      const globalStoreRefresh = globalStore.refresh as unknown;
      if (
        typeof globalStoreRefresh === 'object' &&
        globalStoreRefresh !== null &&
        'mockRestore' in globalStoreRefresh &&
        typeof (globalStoreRefresh as { mockRestore: unknown }).mockRestore === 'function'
      ) {
        (globalStoreRefresh as { mockRestore: () => void }).mockRestore();
      }
    });

    it('should reset reconnect state when page becomes visible', () => {
      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      expect(mockTransport.resetReconnectState).toHaveBeenCalled();
    });

    it('should trigger validateConnectionOnResume when page becomes visible', async () => {
      const validateSpy = vi.spyOn(
        connectionManager as unknown as Record<string, unknown>,
        'validateConnectionOnResume'
      );

      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      // Wait for async request
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(validateSpy).toHaveBeenCalled();
    });

    it('should request joinChannel when health check succeeds', async () => {
      const _appStateRefreshSpy = vi.spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
      const _globalStoreRefreshSpy = vi.spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      // Wait for async validation
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockMessageHub.joinChannel).toHaveBeenCalledWith('global');
    });

    it('should refresh sessionStore, appState, and globalStore', async () => {
      // Soft-resume drives full per-session recovery (recover), not state-only
      // refresh — see SessionStore.recover / refreshAllSessionStores.
      const sessionStoreRefreshSpy = vi.spyOn(sessionStore, 'recover').mockResolvedValue(undefined);
      const appStateRefreshSpy = vi.spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
      const globalStoreRefreshSpy = vi.spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      // Wait for async validation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // FIX: sessionStore.recover() is now requested to sync agent state for status bar
      expect(sessionStoreRefreshSpy).toHaveBeenCalled();
      expect(appStateRefreshSpy).toHaveBeenCalled();
      expect(globalStoreRefreshSpy).toHaveBeenCalled();
    });

    it('should request refreshes in parallel (Promise.all)', async () => {
      const refreshStartTimes: number[] = [];

      const _sessionStoreRefreshSpy = vi
        .spyOn(sessionStore, 'recover')
        .mockImplementation(async () => {
          refreshStartTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
        });

      const _appStateRefreshSpy = vi.spyOn(appState, 'refreshAll').mockImplementation(async () => {
        refreshStartTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const _globalStoreRefreshSpy = vi
        .spyOn(globalStore, 'refresh')
        .mockImplementation(async () => {
          refreshStartTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
        });

      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 200));

      // All 3 should start within 10ms of each other (parallel execution)
      expect(refreshStartTimes.length).toBe(3);
      const maxDiff = Math.max(...refreshStartTimes) - Math.min(...refreshStartTimes);
      expect(maxDiff).toBeLessThan(10);
    });
  });

  describe('Error Handling', () => {
    let mockTransport: Record<string, unknown>;
    let mockMessageHub: Record<string, unknown>;
    let appStateRefreshSpy: ReturnType<typeof spyOn> | null = null;
    let globalStoreRefreshSpy: ReturnType<typeof spyOn> | null = null;

    beforeEach(() => {
      // Set up spies in beforeEach to track all requests in this describe block
      appStateRefreshSpy = vi.spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
      globalStoreRefreshSpy = vi.spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

      mockTransport = {
        isReady: vi.fn(() => true),
        resetReconnectState: vi.fn(() => {}),
        forceReconnect: vi.fn(() => {}),
      };

      mockMessageHub = {
        request: vi.fn(() => Promise.reject(new Error('Health check failed'))),
        forceResubscribe: vi.fn(() => {}),
        isConnected: vi.fn(() => true),
        joinChannel: vi.fn(() => {}),
        leaveChannel: vi.fn(() => {}),
      };

      (connectionManager as unknown as Record<string, unknown>).transport = mockTransport;
      (connectionManager as unknown as Record<string, unknown>).messageHub = mockMessageHub;
    });

    afterEach(() => {
      // Clean up spies
      if (appStateRefreshSpy) {
        appStateRefreshSpy.mockRestore();
        appStateRefreshSpy = null;
      }
      if (globalStoreRefreshSpy) {
        globalStoreRefreshSpy.mockRestore();
        globalStoreRefreshSpy = null;
      }
    });

    it('should request forceReconnect when health check fails', async () => {
      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      // Wait for async validation to fail
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockTransport.forceReconnect).toHaveBeenCalled();
    });

    it('should NOT request refresh methods when health check fails', async () => {
      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      // Wait for async validation to fail
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(appStateRefreshSpy).not.toHaveBeenCalled();
      expect(globalStoreRefreshSpy).not.toHaveBeenCalled();
    });
  });

  describe('No Connection Scenario', () => {
    beforeEach(() => {
      // No transport or messageHub
      (connectionManager as unknown as Record<string, unknown>).transport = null;
      (connectionManager as unknown as Record<string, unknown>).messageHub = null;
    });

    it('should attempt reconnect when no connection exists', async () => {
      const reconnectSpy = vi.spyOn(connectionManager, 'reconnect').mockResolvedValue(undefined);

      // Simulate page becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      // Wait for async request
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(reconnectSpy).toHaveBeenCalled();
    });
  });
});
