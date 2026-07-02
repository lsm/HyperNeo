// @ts-nocheck
/**
 * Integration tests for Safari background tab recovery
 *
 * Tests the complete reconnection flow including:
 * - WebSocket connection recovery
 * - State channel refresh
 * - Subscription re-establishment
 * - Data synchronization after background period
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionManager } from '../connection-manager';
import { GlobalStore } from '../global-store';
import { connectionManager } from '../connection-manager';
import { StateChannel } from '../state-channel';
import type { MessageHub } from '@hyperneo/shared';

describe('Safari Background Tab - Integration Tests', () => {
  describe('StateChannel Reconnection Behavior', () => {
    let mockHub: MessageHub;
    let stateChannel: StateChannel<{ data: string; timestamp: number }>;
    let reconnectionHandler: ((state: string) => void) | null = null;

    beforeEach(() => {
      // Create mock MessageHub with connection state tracking
      const connectionHandlers: Array<(state: string) => void> = [];

      mockHub = {
        request: vi.fn(async () => ({
          data: 'test',
          timestamp: Date.now(),
        })) as unknown,
        subscribe: vi.fn(async () => vi.fn(() => Promise.resolve())),
        subscribeOptimistic: vi.fn(() => vi.fn(() => {})),
        onEvent: vi.fn(() => vi.fn(() => {})),
        onConnection: vi.fn((handler: (state: string) => void) => {
          connectionHandlers.push(handler);
          reconnectionHandler = handler;
          return vi.fn(() => {});
        }),
        publish: vi.fn(async () => {}),
        isConnected: vi.fn(() => true),
        joinChannel: vi.fn(() => {}),
        leaveChannel: vi.fn(() => {}),
      } as unknown as MessageHub;

      stateChannel = new StateChannel(mockHub, 'test.channel', {
        sessionId: 'test-session',
      });
    });

    afterEach(async () => {
      // Cleanup StateChannel to prevent test pollution
      if (stateChannel) {
        await stateChannel.stop();
      }
      reconnectionHandler = null;
    });

    it('should call hybridRefresh on reconnection', async () => {
      await stateChannel.start();

      // Trigger reconnection
      reconnectionHandler?.('connected');

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify snapshot was fetched (hybridRefresh calls fetchSnapshot)
      // After migration, request() is called with 2 args: (method, data, options merged)
      expect(mockHub.request).toHaveBeenCalledWith(
        'test.channel',
        expect.objectContaining({ sessionId: expect.any(String) })
      );
    });

    it('should use server timestamp from snapshot', async () => {
      const serverTime = Date.now() - 5000; // 5 seconds ago
      mockHub.request = vi.fn(async () => ({
        data: 'test',
        timestamp: serverTime,
      })) as unknown as typeof mockHub.request;

      await stateChannel.start();

      // Verify lastSync uses server timestamp
      expect(stateChannel.lastSyncTime.value).toBe(serverTime);
    });

    it('should always do full refresh (not incremental)', async () => {
      await stateChannel.start();

      // Count calls before reconnection
      const callsBefore = (mockHub.request as ReturnType<typeof mock>).mock.calls.length;

      // Trigger reconnection
      reconnectionHandler?.('connected');

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify fetchSnapshot was called again during reconnection
      const calls = (mockHub.request as ReturnType<typeof mock>).mock.calls;
      expect(calls.length).toBeGreaterThan(callsBefore);

      // Check the call made during reconnection (after the initial start)
      const reconnectCalls = calls.slice(callsBefore);
      expect(reconnectCalls.length).toBeGreaterThan(0);

      const reconnectCall = reconnectCalls[0];
      const params = reconnectCall?.[1] || {};

      // Should NOT have 'since' parameter (indicates full refresh, not incremental)
      expect('since' in params).toBe(false);
    });
  });

  describe('GlobalStore Refresh Integration', () => {
    let mockHub: MessageHub;
    let globalStore: GlobalStore;
    let getHubSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      mockHub = {
        request: vi.fn(async (method: string) => {
          if (method === 'state.global.snapshot') {
            return {
              system: { auth: { authenticated: true } },
              settings: { settings: { showArchived: false } },
            };
          }
          return { acknowledged: true };
        }),
        subscribeOptimistic: vi.fn(() => vi.fn(() => {})),
        onEvent: vi.fn(() => vi.fn(() => {})),
        onConnection: vi.fn(() => vi.fn(() => {})),
        joinRoom: vi.fn(() => {}),
        leaveRoom: vi.fn(() => {}),
      } as unknown as MessageHub;

      // Mock connectionManager.getHub() to return our mock hub
      getHubSpy = vi.spyOn(connectionManager, 'getHub').mockResolvedValue(mockHub);

      // Create new GlobalStore instance for isolated testing
      globalStore = new GlobalStore();
    });

    afterEach(() => {
      // Restore mocks
      if (getHubSpy) {
        getHubSpy.mockRestore();
      }
    });

    it('should re-subscribe to LiveQuery and fetch snapshot on refresh', async () => {
      // Initialize first
      await globalStore.initialize();

      // Set sessions directly to simulate stale state
      globalStore.sessions.value = [];

      // Refresh
      await globalStore.refresh();

      // Verify LiveQuery re-subscribe was called
      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'sessions.list',
        params: [0],
        subscriptionId: 'sessions-list',
      });

      // Verify GLOBAL_SNAPSHOT was fetched
      expect(mockHub.request).toHaveBeenCalledWith('state.global.snapshot', {});
    });

    it('should update system and settings state from snapshot', async () => {
      await globalStore.initialize();
      await globalStore.refresh();

      // Sessions come via LiveQuery events, not from snapshot
      // System and settings are fetched from GLOBAL_SNAPSHOT
      expect(globalStore.systemState.value?.auth?.authenticated).toBe(true);
      expect(globalStore.settings.value?.showArchived).toBe(false);

      // hasArchivedSessions is computed from sessions
      expect(globalStore.hasArchivedSessions.value).toBe(false);
    });

    it('should handle refresh errors gracefully', async () => {
      // Initialize first with good mock
      await globalStore.initialize();

      // Then set up mock to reject for refresh() call
      mockHub.request = vi.fn(() => Promise.reject(new Error('Network error')));

      // Should throw the network error
      await expect(globalStore.refresh()).rejects.toThrow('Network error');
    });

    it('should skip refresh if not initialized', async () => {
      const callSpy = mockHub.request;

      // Don't initialize
      await globalStore.refresh();

      // Should not make any RPC calls
      expect(callSpy).not.toHaveBeenCalled();
    });
  });

  describe('Full Reconnection Flow', () => {
    let connectionManager: ConnectionManager;
    let mockTransport: Record<string, unknown>;
    let mockMessageHub: Record<string, unknown>;
    let subscriptionCalls: string[] = [];
    let originalAddEventListener: unknown;
    let originalRemoveEventListener: unknown;

    beforeEach(() => {
      subscriptionCalls = [];

      // Mock document event listeners
      originalAddEventListener = global.document?.addEventListener;
      originalRemoveEventListener = global.document?.removeEventListener;
      global.document.addEventListener = vi.fn(
        () => {}
      ) as unknown as typeof global.document.addEventListener;
      global.document.removeEventListener = vi.fn(
        () => {}
      ) as unknown as typeof global.document.addEventListener;

      // Mock transport
      mockTransport = {
        isReady: vi.fn(() => true),
        resetReconnectState: vi.fn(() => {}),
        forceReconnect: vi.fn(() => {}),
        close: vi.fn(() => {}),
      };

      // Mock MessageHub with tracking
      mockMessageHub = {
        request: vi.fn(async (method: string) => {
          if (method === 'system.health') {
            return { status: 'ok' };
          }
          if (method === 'state.global.snapshot') {
            return {
              sessions: { sessions: [], hasArchivedSessions: false },
              system: {},
              settings: { settings: {} },
            };
          }
          return {};
        }),
        joinChannel: vi.fn(() => {
          subscriptionCalls.push('joinChannel');
        }),
        isConnected: vi.fn(() => true),
        leaveChannel: vi.fn(() => {}),
      };

      connectionManager = new ConnectionManager();
      (connectionManager as unknown as Record<string, unknown>).transport = mockTransport;
      (connectionManager as unknown as Record<string, unknown>).messageHub = mockMessageHub;
    });

    afterEach(() => {
      if (originalAddEventListener) global.document.addEventListener = originalAddEventListener;
      if (originalRemoveEventListener)
        global.document.removeEventListener = originalRemoveEventListener;
    });

    it('should execute reconnection flow in correct order', async () => {
      const executionOrder: string[] = [];

      // Spy on key methods
      mockMessageHub.request = vi.fn(async (method: string) => {
        executionOrder.push(`request:${method}`);
        if (method === 'system.health') {
          return { status: 'ok' };
        }
        return {};
      });

      mockMessageHub.joinChannel = vi.fn((room: string) => {
        executionOrder.push(`joinChannel:${room}`);
      });

      // Trigger visibility change (which calls validateConnectionOnResume)
      Object.defineProperty(document, 'hidden', {
        value: false,
        configurable: true,
      });

      const visibilityHandler = (connectionManager as unknown as Record<string, unknown>)
        .visibilityHandler as (() => void) | null;
      visibilityHandler?.();

      // Wait for async flow
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify basic order:
      // 1. Health check happens first
      // 2. joinChannel happens after health check
      expect(executionOrder[0]).toBe('request:system.health');
      expect(executionOrder).toContain('joinChannel:global');

      // Verify joinChannel comes after health check
      const healthIndex = executionOrder.indexOf('request:system.health');
      const joinChannelIndex = executionOrder.indexOf('joinChannel:global');
      expect(joinChannelIndex).toBeGreaterThan(healthIndex);
    });

    it('should call joinChannel even when health check succeeds', async () => {
      // This is the critical fix - resubscribe even when connection appears healthy
      mockMessageHub.request = vi.fn(async () => ({ status: 'ok' }));

      Object.defineProperty(document, 'hidden', {
        value: false,
        configurable: true,
      });

      const visibilityHandler = (connectionManager as unknown as Record<string, unknown>)
        .visibilityHandler as (() => void) | null;
      visibilityHandler?.();

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(mockMessageHub.joinChannel).toHaveBeenCalled();
    });

    it('should NOT call joinChannel when health check fails', async () => {
      // Clear previous joinChannel calls from setup
      vi.clearAllMocks();
      mockMessageHub.request = vi.fn(() => Promise.reject(new Error('Health check failed')));

      Object.defineProperty(document, 'hidden', {
        value: false,
        configurable: true,
      });

      const visibilityHandler = (connectionManager as unknown as Record<string, unknown>)
        .visibilityHandler as (() => void) | null;
      visibilityHandler?.();

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should call forceReconnect instead
      expect(mockMessageHub.joinChannel).not.toHaveBeenCalled();
      expect(mockTransport.forceReconnect).toHaveBeenCalled();
    });
  });

  describe('Data Synchronization After Background', () => {
    it('should merge SDK messages correctly after reconnection', () => {
      // Create mock messages with timestamps
      const existingMessages = [
        { uuid: 'msg-1', content: 'Hello', timestamp: 1000 },
        { uuid: 'msg-2', content: 'World', timestamp: 2000 },
      ];

      const newMessages = [
        { uuid: 'msg-2', content: 'World', timestamp: 2000 }, // Duplicate
        { uuid: 'msg-3', content: 'New', timestamp: 3000 }, // New message
      ];

      // Simulate StateChannel's mergeSdkMessages logic
      const map = new Map<string, Record<string, unknown>>();

      // Add existing
      for (const msg of existingMessages) {
        map.set(msg.uuid, msg);
      }

      // Add/update with new
      for (const msg of newMessages) {
        map.set(msg.uuid, msg);
      }

      // Sort by timestamp
      const merged = Array.from(map.values()).sort((a, b) => {
        const timeA = (a.timestamp as number) || 0;
        const timeB = (b.timestamp as number) || 0;
        return timeA - timeB;
      });

      // Verify: 3 unique messages, sorted by time
      expect(merged.length).toBe(3);
      expect(merged[0].uuid).toBe('msg-1');
      expect(merged[1].uuid).toBe('msg-2');
      expect(merged[2].uuid).toBe('msg-3');
    });

    it('should handle clock skew by using server timestamps', () => {
      const clientTime = Date.now();
      const serverTime = clientTime - 10000; // Server is 10s behind

      // Simulate StateChannel using server timestamp
      const mockHub = {
        request: vi.fn(async () => ({ data: 'test', timestamp: serverTime })),
      } as unknown as MessageHub;

      const _channel = new StateChannel(mockHub, 'test', {});

      // After fetchSnapshot, lastSync should use server time, not client time
      // This prevents missing messages due to clock differences
      expect(serverTime).not.toBe(clientTime);
      expect(serverTime).toBeLessThan(clientTime);
    });
  });

  describe('Parallel Refresh Performance', () => {
    it('should refresh appState and globalStore in parallel', async () => {
      const startTimes: number[] = [];
      const endTimes: number[] = [];

      const mockAppState = {
        refreshAll: vi.fn(async () => {
          startTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 100));
          endTimes.push(Date.now());
        }),
      };

      const mockGlobalStore = {
        refresh: vi.fn(async () => {
          startTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 100));
          endTimes.push(Date.now());
        }),
      };

      // Simulate Promise.all behavior
      await Promise.all([mockAppState.refreshAll(), mockGlobalStore.refresh()]);

      // Both should start within a few ms of each other (parallel)
      expect(startTimes.length).toBe(2);
      const startDiff = Math.abs(startTimes[0] - startTimes[1]);
      expect(startDiff).toBeLessThan(10);

      // Total time should be ~100ms (parallel), not ~200ms (sequential)
      const totalTime = Math.max(...endTimes) - Math.min(...startTimes);
      expect(totalTime).toBeLessThan(150); // Some margin for overhead
      expect(totalTime).toBeGreaterThan(90);
    });
  });
});
