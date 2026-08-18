// @ts-nocheck

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
    originalAddEventListener = global.document?.addEventListener;
    originalRemoveEventListener = global.document?.removeEventListener;

    global.document.addEventListener = vi.fn((type: string, listener: EventListener) => {
      if (type === 'visibilitychange') {
        visibilityChangeHandler = listener as (event: Event) => void;
      } else if (type === 'pagehide') {
        pageHideHandler = listener as (event: Event) => void;
      }
    }) as unknown as typeof global.document.addEventListener;

    global.document.removeEventListener = vi.fn((type: string, listener: EventListener) => {
      if (type === 'visibilitychange' && listener === visibilityChangeHandler) {
        visibilityChangeHandler = null;
      } else if (type === 'pagehide' && listener === pageHideHandler) {
        pageHideHandler = null;
      }
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
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });

      expect(() => visibilityChangeHandler?.(new Event('visibilitychange'))).not.toThrow();
    });
  });

  describe('Page Visible Event - Reconnection Flow', () => {
    let mockTransport: Record<string, unknown>;
    let mockMessageHub: Record<string, unknown>;
    beforeEach(() => {
      mockTransport = {
        isReady: vi.fn(() => true),
        resetReconnectState: vi.fn(() => {}),
        forceReconnect: vi.fn(() => {}),
        close: vi.fn(() => {}),
      };

      mockMessageHub = {
        request: vi.fn(() => Promise.resolve({ status: 'ok' })),
        forceResubscribe: vi.fn(() => {}),
        isConnected: vi.fn(() => true),
        joinChannel: vi.fn(() => {}),
        leaveChannel: vi.fn(() => {}),
      };

      (connectionManager as unknown as Record<string, unknown>).transport = mockTransport;
      (connectionManager as unknown as Record<string, unknown>).messageHub = mockMessageHub;
    });

    afterEach(() => {
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

      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(validateSpy).toHaveBeenCalled();
    });

    it('should request joinChannel when health check succeeds', async () => {
      const _appStateRefreshSpy = vi.spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
      const _globalStoreRefreshSpy = vi.spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockMessageHub.joinChannel).toHaveBeenCalledWith('global');
    });

    it('should refresh sessionStore, appState, and globalStore', async () => {
      const sessionStoreRefreshSpy = vi.spyOn(sessionStore, 'recover').mockResolvedValue(undefined);
      const appStateRefreshSpy = vi.spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
      const globalStoreRefreshSpy = vi.spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      await new Promise((resolve) => setTimeout(resolve, 100));

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

      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      await new Promise((resolve) => setTimeout(resolve, 200));

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
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockTransport.forceReconnect).toHaveBeenCalled();
    });

    it('should NOT request refresh methods when health check fails', async () => {
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(appStateRefreshSpy).not.toHaveBeenCalled();
      expect(globalStoreRefreshSpy).not.toHaveBeenCalled();
    });
  });

  describe('No Connection Scenario', () => {
    beforeEach(() => {
      (connectionManager as unknown as Record<string, unknown>).transport = null;
      (connectionManager as unknown as Record<string, unknown>).messageHub = null;
    });

    it('should attempt reconnect when no connection exists', async () => {
      const reconnectSpy = vi.spyOn(connectionManager, 'reconnect').mockResolvedValue(undefined);

      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });

      visibilityChangeHandler?.(new Event('visibilitychange'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(reconnectSpy).toHaveBeenCalled();
    });
  });
});
