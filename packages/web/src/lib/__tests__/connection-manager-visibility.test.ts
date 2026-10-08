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
        isSuspended: vi.fn(() => false),
        suspend: vi.fn(() => {}),
        resume: vi.fn(() => {}),
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
        isSuspended: vi.fn(() => false),
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

  describe('Background grace and quiet resume', () => {
    const setHidden = (hidden: boolean) =>
      Object.defineProperty(document, 'hidden', {
        value: hidden,
        writable: true,
        configurable: true,
      });
    let transport: Record<string, ReturnType<typeof vi.fn>>;
    let markSessionsRecovering: ReturnType<typeof vi.fn>;
    let manager: ConnectionManager;

    beforeEach(() => {
      vi.useFakeTimers();
      markSessionsRecovering = vi.fn();
      manager = new ConnectionManager('ws://test', {
        lifecycle: { setState: vi.fn(), getState: vi.fn() },
        createEventEffects: vi.fn(),
        createResumeEffects: (effects: Record<string, unknown>) => ({
          ...effects,
          getActiveSpaceId: () => null,
          refreshSessions: vi.fn(async () => {}),
          refreshApp: vi.fn(async () => {}),
          refreshGlobal: vi.fn(async () => {}),
          refreshSpace: vi.fn(async () => {}),
        }),
        markSessionsRecovering,
      });
      transport = {
        isReady: vi.fn(() => true),
        isSuspended: vi.fn(() => false),
        suspend: vi.fn(),
        resume: vi.fn(),
        resetReconnectState: vi.fn(),
        forceReconnect: vi.fn(),
      };
      (manager as unknown as Record<string, unknown>).transport = transport;
      (manager as unknown as Record<string, unknown>).messageHub = {
        request: vi.fn(async () => ({ status: 'ok' })),
        joinChannel: vi.fn(async () => {}),
        isConnected: vi.fn(() => true),
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      setHidden(false);
    });

    it('keeps the socket through a short switch and closes it after 20 s hidden', () => {
      setHidden(true);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      vi.advanceTimersByTime(19_000);
      setHidden(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      vi.advanceTimersByTime(5_000);
      expect(transport.suspend).not.toHaveBeenCalled();

      setHidden(true);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      vi.advanceTimersByTime(20_000);
      expect(transport.suspend).toHaveBeenCalledTimes(1);
    });

    it('does not suspend a page that became visible without a visibilitychange', () => {
      setHidden(true);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      setHidden(false);
      vi.advanceTimersByTime(20_000);
      expect(transport.suspend).not.toHaveBeenCalled();
    });

    it('runs one resume check when pageshow and visibilitychange both arrive', async () => {
      const hub = (manager as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
        .messageHub;
      hub.isConnected.mockReturnValue(false);
      transport.isSuspended.mockReturnValue(true);
      setHidden(false);
      window.dispatchEvent(new Event('pageshow'));
      transport.isSuspended.mockReturnValue(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      expect(hub.request).not.toHaveBeenCalled();
      expect(markSessionsRecovering).not.toHaveBeenCalled();

      hub.isConnected.mockReturnValue(true);
      (manager as unknown as { notifyConnectionHandlers(): void }).notifyConnectionHandlers();
      await vi.runAllTimersAsync();
      expect(hub.request).toHaveBeenCalledTimes(1);
      expect(transport.forceReconnect).not.toHaveBeenCalled();
    });

    it('does not stay stuck on a resume that never connected', async () => {
      const hub = (manager as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
        .messageHub;
      hub.isConnected.mockReturnValue(false);
      transport.isSuspended.mockReturnValue(true);
      setHidden(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      transport.isSuspended.mockReturnValue(false);
      setHidden(true);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      setHidden(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      expect(transport.resetReconnectState).toHaveBeenCalledTimes(1);
    });

    it('runs one resume check after two resumes that waited for the same connection', async () => {
      const hub = (manager as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
        .messageHub;
      hub.isConnected.mockReturnValue(false);
      transport.isSuspended.mockReturnValue(true);
      setHidden(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      setHidden(true);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      vi.advanceTimersByTime(20_000);
      setHidden(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      expect(transport.resume).toHaveBeenCalledTimes(2);

      hub.isConnected.mockReturnValue(true);
      (manager as unknown as { notifyConnectionHandlers(): void }).notifyConnectionHandlers();
      await vi.runAllTimersAsync();
      expect(hub.request).toHaveBeenCalledTimes(1);
    });

    it('resumes a suspended socket when the page is shown again', () => {
      transport.isSuspended.mockReturnValue(true);
      setHidden(false);
      window.dispatchEvent(new Event('pageshow'));
      expect(transport.resume).toHaveBeenCalledTimes(1);
    });

    it('resumes a suspended socket and rejoins its channels once it reconnects', async () => {
      const hub = (manager as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
        .messageHub;
      hub.isConnected.mockReturnValue(false);
      transport.isSuspended.mockReturnValue(true);
      setHidden(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      expect(transport.resume).toHaveBeenCalledTimes(1);
      expect(hub.joinChannel).not.toHaveBeenCalled();

      hub.isConnected.mockReturnValue(true);
      (manager as unknown as { notifyConnectionHandlers(): void }).notifyConnectionHandlers();
      await vi.runAllTimersAsync();
      expect(hub.joinChannel).toHaveBeenCalledWith('global');
      expect(transport.forceReconnect).not.toHaveBeenCalled();
    });

    it('does not mark sessions recovering when the live socket answers', async () => {
      setHidden(false);
      visibilityChangeHandler?.(new Event('visibilitychange'));
      await vi.runAllTimersAsync();
      expect(markSessionsRecovering).not.toHaveBeenCalled();
      expect(transport.forceReconnect).not.toHaveBeenCalled();
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
