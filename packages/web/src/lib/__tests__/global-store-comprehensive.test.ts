// @ts-nocheck

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '@hyperneo/shared';
import { STATE_CHANNELS } from '@hyperneo/shared';

vi.mock('../connection-manager.js', () => {
  const mockHub = {
    request: vi.fn().mockResolvedValue({ acknowledged: true }),
    onEvent: vi.fn(() => vi.fn()),
    onConnection: vi.fn(() => vi.fn()),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    isConnected: vi.fn(() => true),
  };
  return {
    connectionManager: {
      getHubIfConnected: vi.fn(() => mockHub),
      getHub: vi.fn(async () => mockHub),
    },
  };
});

import { GlobalStore } from '../global-store.js';

import { connectionManager } from '../connection-manager.js';

function createMockSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    workspacePath: `/path/to/${id}`,
    status: 'active',
    config: {},
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    createdAt: '2024-01-01T00:00:00Z',
    lastActiveAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockHub(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue({ acknowledged: true }),
    onEvent: vi.fn(() => vi.fn()),
    onConnection: vi.fn(() => vi.fn()),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

describe('GlobalStore', () => {
  let store: GlobalStore;

  beforeEach(() => {
    store = new GlobalStore();
    vi.clearAllMocks();
    (
      connectionManager as unknown as {
        getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
        getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
      }
    ).getHubIfConnected.mockReturnValue(createMockHub());
    (
      connectionManager as unknown as {
        getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
        getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
      }
    ).getHub.mockResolvedValue(createMockHub());
  });

  describe('Initial State', () => {
    it('should start with empty sessions array', () => {
      expect(store.sessions.value).toEqual([]);
    });

    it('should start with hasArchivedSessions as false', () => {
      expect(store.hasArchivedSessions.value).toBe(false);
    });

    it('should start with null systemState', () => {
      expect(store.systemState.value).toBeNull();
    });

    it('should start with null settings', () => {
      expect(store.settings.value).toBeNull();
    });

    it('should start with initialized as false', () => {
      const privateStore = store as unknown as { initialized: boolean };
      expect(privateStore.initialized).toBe(false);
    });
  });

  describe('Computed Accessors', () => {
    it('authStatus should return null when systemState is null', () => {
      expect(store.authStatus.value).toBeNull();
    });

    it('authStatus should return auth from systemState', () => {
      store.systemState.value = {
        auth: { authenticated: true, method: 'api_key' },
        health: { status: 'healthy' },
        apiConnection: { status: 'connected' },
      };
      expect(store.authStatus.value).toEqual({
        authenticated: true,
        method: 'api_key',
      });
    });

    it('healthStatus should return null when systemState is null', () => {
      expect(store.healthStatus.value).toBeNull();
    });

    it('healthStatus should return health from systemState', () => {
      store.systemState.value = {
        auth: { authenticated: true, method: 'api_key' },
        health: { status: 'healthy' },
        apiConnection: { status: 'connected' },
      };
      expect(store.healthStatus.value).toEqual({ status: 'healthy' });
    });

    it('sessionCount should return 0 when no sessions', () => {
      expect(store.sessionCount.value).toBe(0);
    });

    it('sessionCount should return correct count', () => {
      store.sessions.value = [createMockSession('1'), createMockSession('2')];
      expect(store.sessionCount.value).toBe(2);
    });

    it('recentSessions should return last 5 sessions sorted by lastActiveAt', () => {
      const session1 = createMockSession('1');
      session1.lastActiveAt = '2024-01-01T00:00:00Z';
      const session2 = createMockSession('2');
      session2.lastActiveAt = '2024-01-05T00:00:00Z';
      const session3 = createMockSession('3');
      session3.lastActiveAt = '2024-01-03T00:00:00Z';
      const session4 = createMockSession('4');
      session4.lastActiveAt = '2024-01-04T00:00:00Z';
      const session5 = createMockSession('5');
      session5.lastActiveAt = '2024-01-02T00:00:00Z';
      const session6 = createMockSession('6');
      session6.lastActiveAt = '2024-01-06T00:00:00Z';

      const sessions = [session1, session2, session3, session4, session5, session6];
      store.sessions.value = sessions;

      const recent = store.recentSessions.value;
      expect(recent).toHaveLength(5);
      expect(recent[0].id).toBe('6');
      expect(recent[1].id).toBe('2');
      expect(recent[2].id).toBe('4');
      expect(recent[3].id).toBe('3');
      expect(recent[4].id).toBe('5');
    });

    it('activeSessions should filter by active status', () => {
      const sessions = [
        createMockSession('1'),
        { ...createMockSession('2'), status: 'archived' as const },
        createMockSession('3'),
      ];
      store.sessions.value = sessions;

      const active = store.activeSessions.value;
      expect(active).toHaveLength(2);
      expect(active.map((s) => s.id)).toEqual(['1', '3']);
    });

    it('apiConnectionStatus should return connected by default', () => {
      expect(store.apiConnectionStatus.value).toBe('connected');
    });

    it('apiConnectionStatus should reflect systemState', () => {
      store.systemState.value = {
        auth: { authenticated: true, method: 'api_key' },
        health: { status: 'healthy' },
        apiConnection: { status: 'degraded' },
      };
      expect(store.apiConnectionStatus.value).toBe('degraded');
    });
  });

  describe('initialize', () => {
    it('should subscribe to LiveQuery and state channels', async () => {
      const mockHub = createMockHub();
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.initialize();

      expect(mockHub.onEvent).toHaveBeenCalledWith('liveQuery.snapshot', expect.any(Function));
      expect(mockHub.onEvent).toHaveBeenCalledWith('liveQuery.delta', expect.any(Function));
      expect(mockHub.onEvent).toHaveBeenCalledWith(
        STATE_CHANNELS.GLOBAL_SYSTEM,
        expect.any(Function)
      );
      expect(mockHub.onEvent).toHaveBeenCalledWith(
        STATE_CHANNELS.GLOBAL_SETTINGS,
        expect.any(Function)
      );
      expect(mockHub.onConnection).toHaveBeenCalledWith(expect.any(Function));
      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'sessions.list',
        params: [0],
        subscriptionId: 'sessions-list',
      });
    });

    it('should not initialize twice', async () => {
      const mockHub = createMockHub();
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.initialize();

      const privateStore = store as unknown as { initialized: boolean };
      expect(privateStore.initialized).toBe(true);

      mockHub.request.mockClear();

      await store.initialize();

      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('should derive hasArchivedSessions from totalCount metadata', async () => {
      expect(store.hasArchivedSessions.value).toBe(false);

      store.sessions.value = [createMockSession('1')];
      store.sessionsTotalCount.value = 3;

      expect(store.hasArchivedSessions.value).toBe(true);
    });
  });

  describe('refresh', () => {
    beforeEach(async () => {
      const mockHub = createMockHub();
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);
      await store.initialize();
    });

    it('should re-subscribe to LiveQuery and fetch GLOBAL_SNAPSHOT', async () => {
      const mockHub = createMockHub({
        request: vi.fn(async (method: string) => {
          if (method === STATE_CHANNELS.GLOBAL_SNAPSHOT) {
            return {
              system: {
                auth: { authenticated: true, method: 'oauth' },
                health: { status: 'healthy' },
                apiConnection: { status: 'connected' },
              },
              settings: { settings: { permissionMode: 'acceptEdits' } },
            };
          }
          return { acknowledged: true };
        }),
      });
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.refresh();

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'sessions.list',
        params: [0],
        subscriptionId: 'sessions-list',
      });
      expect(mockHub.request).toHaveBeenCalledWith(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

      expect(store.systemState.value?.auth?.method).toBe('oauth');
      expect(store.settings.value?.permissionMode).toBe('acceptEdits');
    });

    it('should update system and settings from GLOBAL_SNAPSHOT', async () => {
      const mockHub = createMockHub({
        request: vi.fn(async (method: string) => {
          if (method === STATE_CHANNELS.GLOBAL_SNAPSHOT) {
            return {
              system: {
                auth: { authenticated: true, method: 'api_key' },
                health: { status: 'healthy' },
                apiConnection: { status: 'connected' },
              },
              settings: { settings: { permissionMode: 'bypassPermissions' } },
            };
          }
          return { acknowledged: true };
        }),
      });
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.refresh();

      expect(store.systemState.value?.auth?.method).toBe('api_key');
      expect(store.settings.value?.permissionMode).toBe('bypassPermissions');
    });

    it('should handle null snapshot gracefully', async () => {
      const mockHub = createMockHub({
        request: vi.fn(async (method: string) => {
          if (method === STATE_CHANNELS.GLOBAL_SNAPSHOT) {
            return null;
          }
          return { acknowledged: true };
        }),
      });
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.refresh();
    });
  });

  describe('LiveQuery Event Handling', () => {
    it('should update sessions from LiveQuery snapshot event', async () => {
      const snapshotHandlers: Array<(event: unknown) => void> = [];
      const mockHub = createMockHub({
        onEvent: vi.fn((event: string, handler: (event: unknown) => void) => {
          if (event === 'liveQuery.snapshot') {
            snapshotHandlers.push(handler);
          }
          return vi.fn();
        }),
      });
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.initialize();

      expect(snapshotHandlers.length).toBe(1);
      snapshotHandlers[0]({
        subscriptionId: 'sessions-list',
        rows: [createMockSession('sess-1'), createMockSession('sess-2')],
      });

      expect(store.sessions.value).toHaveLength(2);
      expect(store.sessions.value[0].id).toBe('sess-1');
      expect(store.sessions.value[1].id).toBe('sess-2');
    });

    it('should ignore snapshot events for other subscription IDs', async () => {
      const snapshotHandlers: Array<(event: unknown) => void> = [];
      const mockHub = createMockHub({
        onEvent: vi.fn((event: string, handler: (event: unknown) => void) => {
          if (event === 'liveQuery.snapshot') {
            snapshotHandlers.push(handler);
          }
          return vi.fn();
        }),
      });
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.initialize();

      snapshotHandlers[0]({
        subscriptionId: 'other-subscription',
        rows: [createMockSession('sess-other')],
      });

      expect(store.sessions.value).toHaveLength(0);
    });

    it('should apply delta events correctly', async () => {
      const deltaHandlers: Array<(event: unknown) => void> = [];
      const mockHub = createMockHub({
        onEvent: vi.fn((event: string, handler: (event: unknown) => void) => {
          if (event === 'liveQuery.delta') {
            deltaHandlers.push(handler);
          }
          return vi.fn();
        }),
      });
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      store.sessions.value = [createMockSession('1'), createMockSession('2')];

      await store.initialize();

      expect(deltaHandlers.length).toBe(1);
      deltaHandlers[0]({
        subscriptionId: 'sessions-list',
        added: [createMockSession('3')],
        updated: [{ ...createMockSession('1'), title: 'Updated Session 1' }],
        removed: [createMockSession('2')],
      });

      expect(store.sessions.value).toHaveLength(2);
      expect(store.sessions.value.find((s) => s.id === '1')?.title).toBe('Updated Session 1');
      expect(store.sessions.value.find((s) => s.id === '2')).toBeUndefined();
      expect(store.sessions.value.find((s) => s.id === '3')).toBeDefined();
    });
  });

  describe('Session Helpers', () => {
    beforeEach(() => {
      store.sessions.value = [
        createMockSession('1'),
        createMockSession('2'),
        createMockSession('3'),
      ];
    });

    it('getSession should return session by ID', () => {
      const session = store.getSession('2');
      expect(session).toBeDefined();
      expect(session?.id).toBe('2');
    });

    it('getSession should return undefined for non-existent ID', () => {
      const session = store.getSession('nonexistent');
      expect(session).toBeUndefined();
    });

    it('updateSession should update session properties', () => {
      store.updateSession('2', { title: 'Updated Title' });
      const session = store.getSession('2');
      expect(session?.title).toBe('Updated Title');
    });

    it('removeSession should remove session from list', () => {
      store.removeSession('2');
      expect(store.sessions.value).toHaveLength(2);
      expect(store.getSession('2')).toBeUndefined();
    });

    it('addSession should add session to list', () => {
      const newSession = createMockSession('4');
      store.addSession(newSession);
      expect(store.sessions.value).toHaveLength(4);
      expect(store.getSession('4')).toBeDefined();
    });
  });

  describe('destroy', () => {
    it('should reset initialized flag', async () => {
      const mockHub = createMockHub();
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.initialize();
      store.destroy();

      const privateStore = store as unknown as { initialized: boolean };
      expect(privateStore.initialized).toBe(false);
    });

    it('should clear cleanup functions', async () => {
      const mockHub = createMockHub();
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);

      await store.initialize();
      store.destroy();

      const privateStore = store as unknown as { cleanupFunctions: Array<() => void> };
      expect(privateStore.cleanupFunctions).toHaveLength(0);
    });

    it('should unsubscribe from LiveQuery on destroy', async () => {
      const mockHub = createMockHub();
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHub.mockResolvedValue(mockHub);
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHubIfConnected.mockReturnValue(mockHub);

      await store.initialize();
      store.destroy();

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
        subscriptionId: 'sessions-list',
      });
    });
  });
});
