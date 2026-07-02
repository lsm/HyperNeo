/**
 * Tests for AppMcpStore and MCP API helpers
 *
 * AppMcpStore tests verify:
 * - LiveQuery snapshot populates appMcpServers signal
 * - LiveQuery delta (added/removed/updated) updates signal correctly
 * - WebSocket reconnect re-subscribes automatically
 * - unsubscribe() calls liveQuery.unsubscribe and resets state
 * - Idempotent subscribe/unsubscribe behavior
 * - Stale-event guard discards events after unsubscribe
 * - Post-await unsubscribe race guard prevents dangling handlers
 * - Error propagation via subscribe() rejection and error signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppMcpServer, LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@hyperneo/shared';
import { McpRegistryListResponse, McpRegistryCreateResponse } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type EventHandler<T = unknown> = (data: T) => void;

interface MockHub {
  _handlers: Map<string, EventHandler[]>;
  _connectionHandlers: EventHandler[];
  onEvent: <T>(method: string, handler: EventHandler<T>) => () => void;
  onConnection: (handler: EventHandler<string>) => () => void;
  request: ReturnType<typeof vi.fn>;
  fire: <T>(method: string, data: T) => void;
  fireConnection: (state: string) => void;
}

function createMockHub(): MockHub {
  const _handlers = new Map<string, EventHandler[]>();
  const _connectionHandlers: EventHandler[] = [];
  return {
    _handlers,
    _connectionHandlers,
    onEvent: <T>(method: string, handler: EventHandler<T>) => {
      if (!_handlers.has(method)) _handlers.set(method, []);
      _handlers.get(method)!.push(handler as EventHandler);
      return () => {
        const list = _handlers.get(method);
        if (list) {
          const i = list.indexOf(handler as EventHandler);
          if (i >= 0) list.splice(i, 1);
        }
      };
    },
    onConnection: (handler: EventHandler<string>) => {
      _connectionHandlers.push(handler as EventHandler);
      return () => {
        const i = _connectionHandlers.indexOf(handler as EventHandler);
        if (i >= 0) _connectionHandlers.splice(i, 1);
      };
    },
    request: vi.fn(),
    fire: <T>(method: string, data: T) => {
      for (const h of _handlers.get(method) ?? []) h(data);
    },
    fireConnection: (state: string) => {
      for (const h of _connectionHandlers) h(state);
    },
  };
}

vi.mock('../connection-manager.ts', () => ({
  connectionManager: {
    getHub: vi.fn(),
    getHubIfConnected: vi.fn(),
  },
}));

import { connectionManager } from '../connection-manager.js';
import { appMcpStore } from '../app-mcp-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMcpServer(id: string, overrides: Partial<AppMcpServer> = {}): AppMcpServer {
  return {
    id,
    name: `Server ${id}`,
    sourceType: 'stdio',
    command: 'npx',
    args: ['-y', '@some/server'],
    env: {},
    enabled: true,
    source: 'user',
    ...overrides,
  };
}

const SUBSCRIPTION_ID = 'mcpServers-global';

// ---------------------------------------------------------------------------
// AppMcpStore Tests
// ---------------------------------------------------------------------------

describe('AppMcpStore', () => {
  let mockHub: MockHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHub = createMockHub();

    // Reset store signals
    appMcpStore.appMcpServers.value = [];
    appMcpStore.loading.value = false;
    appMcpStore.error.value = null;

    vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
    vi.mocked(mockHub.request).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    appMcpStore.unsubscribe();
  });

  // ---------------------------------------------------------------------------
  // subscribe()
  // ---------------------------------------------------------------------------

  describe('subscribe()', () => {
    it('should send liveQuery.subscribe request with mcpServers.global query', async () => {
      await appMcpStore.subscribe();
      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('should set loading true while awaiting snapshot', async () => {
      // Override getHub to control when it resolves
      let resolveHub: (hub: MockHub) => void;
      const hubPromise = new Promise<MockHub>((resolve) => {
        resolveHub = (hub) => resolve(hub);
      });
      vi.mocked(connectionManager.getHub).mockReturnValue(hubPromise as never);

      const loadingValues: boolean[] = [];
      const unsub = appMcpStore.loading.subscribe((v) => loadingValues.push(v));

      // Start subscribe but don't await yet — it will pause at getHub()
      const subPromise = appMcpStore.subscribe();

      // Resolve the hub — this schedules the continuation as a microtask
      resolveHub!(mockHub);

      // Flush microtasks so the continuation (loading.value = true) runs
      await Promise.resolve();

      // Now loading should be true (set after hub resolves but before snapshot)
      expect(appMcpStore.loading.value).toBe(true);

      // Fire snapshot to complete
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [],
        version: 1,
      });

      await subPromise;
      expect(appMcpStore.loading.value).toBe(false);

      unsub();
    });

    it('should populate appMcpServers from snapshot rows', async () => {
      const servers = [makeMcpServer('1'), makeMcpServer('2')];

      await appMcpStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: servers,
        version: 1,
      });

      expect(appMcpStore.appMcpServers.value).toHaveLength(2);
      expect(appMcpStore.appMcpServers.value[0].id).toBe('1');
      expect(appMcpStore.appMcpServers.value[1].id).toBe('2');
    });

    it('should be idempotent — second subscribe() call is no-op', async () => {
      await appMcpStore.subscribe();
      mockHub.request.mockClear();
      await appMcpStore.subscribe();
      // No new request should have been made
      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('should set error signal and re-throw when hub subscription fails', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('subscribe failed'));

      await expect(appMcpStore.subscribe()).rejects.toThrow('subscribe failed');
      expect(appMcpStore.error.value).toBe('subscribe failed');
      expect(appMcpStore.loading.value).toBe(false);
    });

    it('should clean up handlers and clear activeSubscriptionIds on subscribe failure', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('subscribe failed'));

      await expect(appMcpStore.subscribe()).rejects.toThrow('subscribe failed');

      // Subscribe again after failure — should register fresh handlers, not leak old ones
      vi.mocked(mockHub.request).mockResolvedValue({ ok: true });
      await appMcpStore.subscribe();

      // Fire a snapshot for the second subscription — should only process once
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeMcpServer('fresh')],
        version: 1,
      });

      // If handlers were leaked from the first failed subscribe, we'd see duplicate
      // processing. Since we only have one server, the count proves no duplication.
      expect(appMcpStore.appMcpServers.value).toHaveLength(1);
      expect(appMcpStore.appMcpServers.value[0].id).toBe('fresh');
    });
  });

  // ---------------------------------------------------------------------------
  // liveQuery.delta handling
  // ---------------------------------------------------------------------------

  describe('delta handling', () => {
    beforeEach(async () => {
      await appMcpStore.subscribe();
      // Populate initial state
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeMcpServer('1'), makeMcpServer('2')],
        version: 1,
      });
      expect(appMcpStore.appMcpServers.value).toHaveLength(2);
    });

    it('should add new servers from delta.added', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        added: [makeMcpServer('3')],
        version: 2,
      });

      expect(appMcpStore.appMcpServers.value).toHaveLength(3);
      expect(appMcpStore.appMcpServers.value.find((s) => s.id === '3')).toBeDefined();
    });

    it('should remove servers from delta.removed', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        removed: [
          { id: '1', name: 'Server 1', sourceType: 'stdio', enabled: true } as AppMcpServer,
        ],
        version: 2,
      });

      expect(appMcpStore.appMcpServers.value).toHaveLength(1);
      expect(appMcpStore.appMcpServers.value.find((s) => s.id === '1')).toBeUndefined();
    });

    it('should update existing servers from delta.updated', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        updated: [makeMcpServer('1', { name: 'Updated Server 1', enabled: false })],
        version: 2,
      });

      const server1 = appMcpStore.appMcpServers.value.find((s) => s.id === '1');
      expect(server1?.name).toBe('Updated Server 1');
      expect(server1?.enabled).toBe(false);
    });

    it('should ignore delta with wrong subscriptionId', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: 'other-subscription',
        added: [makeMcpServer('99')],
        version: 2,
      });

      expect(appMcpStore.appMcpServers.value).toHaveLength(2);
      expect(appMcpStore.appMcpServers.value.find((s) => s.id === '99')).toBeUndefined();
    });

    it('should ignore snapshot with wrong subscriptionId', () => {
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: 'other-subscription',
        rows: [makeMcpServer('99')],
        version: 2,
      });

      expect(appMcpStore.appMcpServers.value).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Stale-event guard
  // ---------------------------------------------------------------------------

  describe('stale-event guard', () => {
    it('should discard snapshot event fired after unsubscribe', async () => {
      await appMcpStore.subscribe();

      // Manually fire a snapshot for the subscription — before unsubscribe
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeMcpServer('pre-1')],
        version: 1,
      });
      expect(appMcpStore.appMcpServers.value).toHaveLength(1);

      // Now unsubscribe — this clears the activeSubscriptionIds guard
      appMcpStore.unsubscribe();

      // Fire a stale snapshot — should be ignored (activeSubscriptionIds no longer has the subId)
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeMcpServer('stale-server')],
        version: 2,
      });

      // The stale event should NOT have updated the signal (it is already empty after unsubscribe)
      expect(appMcpStore.appMcpServers.value).toHaveLength(0);
    });

    it('should discard delta event fired after unsubscribe', async () => {
      await appMcpStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeMcpServer('1'), makeMcpServer('2')],
        version: 1,
      });
      expect(appMcpStore.appMcpServers.value).toHaveLength(2);

      // Unsubscribe — clears the stale-event guard
      appMcpStore.unsubscribe();

      // Fire a stale delta — should be ignored
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        added: [makeMcpServer('stale-add')],
        version: 2,
      });

      // Signal is empty after unsubscribe, stale event does not repopulate it
      expect(appMcpStore.appMcpServers.value).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Post-await unsubscribe race guard
  // ---------------------------------------------------------------------------

  describe('post-await unsubscribe race guard', () => {
    it('should not leave dangling handlers when unsubscribe races with hub resolution', async () => {
      // Control when hub.request resolves so we can race unsubscribe() against it
      let resolveRequest: () => void;
      const requestPromise = new Promise<void>((resolve) => {
        resolveRequest = () => resolve();
      });
      vi.mocked(mockHub.request).mockReturnValue(requestPromise as never);

      // Override getHub to resolve immediately
      vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);

      // Start subscribe but don't await — it will pause at hub.request
      const subPromise = appMcpStore.subscribe();

      // Unsubscribe while the subscribe request is still in-flight
      appMcpStore.unsubscribe();

      // Now allow the request to resolve
      resolveRequest!();

      // If subscribe() has a race guard, calling unsubscribe() mid-await should
      // have called teardownCleanly() and removed all handlers.
      // Verify: no liveQuery.unsubscribe call was made from the subscribe's
      // cleanup path (only from our explicit unsubscribe call above).
      // The subscribe's own cleanup path should have cleaned up already.
      // This is implicitly verified by the afterEach unsubscribe() not crashing —
      // if handlers were left dangling, calling unsubscribe again would fail
      // because cleanup functions might try to double-unsub.
      await subPromise;

      // Verify the store is in a clean unsubscribed state
      expect(appMcpStore.loading.value).toBe(false);
      expect(appMcpStore.appMcpServers.value).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Reconnect handling
  // ---------------------------------------------------------------------------

  describe('WebSocket reconnect', () => {
    it('should re-subscribe with same subscriptionId on reconnect', async () => {
      await appMcpStore.subscribe();

      // Simulate reconnect
      mockHub.fireConnection('connected');

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('should set loading true before re-subscribe on reconnect', async () => {
      await appMcpStore.subscribe();
      // Clear the request mock so we can check the loading state during reconnect
      mockHub.request.mockClear();

      const loadingValues: boolean[] = [];
      const unsub = appMcpStore.loading.subscribe((v) => loadingValues.push(v));

      mockHub.fireConnection('connected');

      // Loading should have been set to true during reconnect
      expect(loadingValues).toContain(true);

      unsub();
    });
  });

  // ---------------------------------------------------------------------------
  // unsubscribe()
  // ---------------------------------------------------------------------------

  describe('unsubscribe()', () => {
    it('should call liveQuery.unsubscribe', async () => {
      await appMcpStore.subscribe();
      mockHub.request.mockClear();

      appMcpStore.unsubscribe();

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('should clear appMcpServers signal', async () => {
      await appMcpStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeMcpServer('1')],
        version: 1,
      });
      expect(appMcpStore.appMcpServers.value).toHaveLength(1);

      appMcpStore.unsubscribe();

      expect(appMcpStore.appMcpServers.value).toHaveLength(0);
    });

    it('should clear error signal', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('fail'));
      await expect(appMcpStore.subscribe()).rejects.toThrow();
      expect(appMcpStore.error.value).not.toBeNull();

      appMcpStore.unsubscribe();
      expect(appMcpStore.error.value).toBeNull();
    });

    it('should be idempotent — second unsubscribe() call is no-op', async () => {
      await appMcpStore.subscribe();
      appMcpStore.unsubscribe();
      mockHub.request.mockClear();

      appMcpStore.unsubscribe();

      // No request should have been made
      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('should be safe to call before subscribe()', () => {
      // Should not throw
      expect(() => appMcpStore.unsubscribe()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// API Helper Type Tests
// ---------------------------------------------------------------------------

/**
 * Type-level tests verifying that API helpers accept and return the correct types.
 * These are compile-time checks expressed as runtime assertions using typed mocks.
 */

describe('MCP API helpers types', () => {
  it('listAppMcpServers returns McpRegistryListResponse', async () => {
    const mockResponse: McpRegistryListResponse = {
      servers: [
        {
          id: 'srv-1',
          name: 'fetch-mcp',
          sourceType: 'stdio',
          command: 'npx',
          args: ['-y', '@tokenizin/mcp-npx-fetch'],
          env: {},
          enabled: true,
          source: 'user',
        },
      ],
    };

    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue({
      request: vi.fn().mockResolvedValue(mockResponse),
    } as never);

    const { listAppMcpServers } = await import('../api-helpers.js');
    const result = await listAppMcpServers();
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].id).toBe('srv-1');
  });

  it('createAppMcpServer accepts CreateAppMcpServerRequest', async () => {
    const mockResponse: McpRegistryCreateResponse = {
      server: {
        id: 'srv-new',
        name: 'new-server',
        sourceType: 'stdio',
        command: 'npx',
        args: ['-y', '@some/server'],
        env: {},
        enabled: true,
        source: 'user',
      },
    };

    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue({
      request: vi.fn().mockResolvedValue(mockResponse),
    } as never);

    const { createAppMcpServer } = await import('../api-helpers.js');
    const result = await createAppMcpServer({
      name: 'new-server',
      sourceType: 'stdio',
      command: 'npx',
      args: ['-y', '@some/server'],
    });
    expect(result.server.id).toBe('srv-new');
  });

  it('setAppMcpServerEnabled accepts id and enabled boolean', async () => {
    const mockResponse = {
      server: {
        id: 'srv-1',
        name: 'Server',
        sourceType: 'stdio' as const,
        enabled: false,
      },
    };

    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue({
      request: vi.fn().mockResolvedValue(mockResponse),
    } as never);

    const { setAppMcpServerEnabled } = await import('../api-helpers.js');
    const result = await setAppMcpServerEnabled('srv-1', false);
    expect(result.server.enabled).toBe(false);
  });

  it('deleteAppMcpServer accepts id string', async () => {
    const mockResponse = { success: true };

    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue({
      request: vi.fn().mockResolvedValue(mockResponse),
    } as never);

    const { deleteAppMcpServer } = await import('../api-helpers.js');
    const result = await deleteAppMcpServer('srv-1');
    expect(result.success).toBe(true);
  });

  it('throws ConnectionNotReadyError when not connected', async () => {
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null as never);

    const { ConnectionNotReadyError } = await import('../errors.js');
    const { listAppMcpServers } = await import('../api-helpers.js');
    await expect(listAppMcpServers()).rejects.toBeInstanceOf(ConnectionNotReadyError);
  });
});
