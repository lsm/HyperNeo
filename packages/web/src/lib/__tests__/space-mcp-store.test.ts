import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent, SpaceMcpEntry } from '@hyperneo/shared';

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
import { spaceMcpStore } from '../space-mcp-store.js';

function makeEntry(serverId: string, overrides: Partial<SpaceMcpEntry> = {}): SpaceMcpEntry {
  return {
    serverId,
    name: `Server ${serverId}`,
    sourceType: 'stdio',
    source: 'user',
    globallyEnabled: true,
    overridden: false,
    enabled: true,
    ...overrides,
  };
}

const SPACE_ID = 'space-1';
const SUBSCRIPTION_ID = `spaceMcp-${SPACE_ID}`;

describe('SpaceMcpStore', () => {
  let mockHub: MockHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHub = createMockHub();

    spaceMcpStore.entries.value = new Map();
    spaceMcpStore.loading.value = false;
    spaceMcpStore.error.value = null;

    vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
    vi.mocked(mockHub.request).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    spaceMcpStore.unsubscribe();
  });

  describe('subscribe()', () => {
    it('sends liveQuery.subscribe with mcpEnablement.bySpace', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'mcpEnablement.bySpace',
        params: [SPACE_ID],
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('populates entries from the snapshot', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      const rows = [makeEntry('srv-1'), makeEntry('srv-2', { enabled: false, overridden: true })];
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows,
        version: 1,
      });

      expect(spaceMcpStore.entries.value.size).toBe(2);
      expect(spaceMcpStore.entries.value.get('srv-1')?.enabled).toBe(true);
      expect(spaceMcpStore.entries.value.get('srv-2')?.overridden).toBe(true);
      expect(spaceMcpStore.loading.value).toBe(false);
    });

    it('is idempotent — second subscribe with same spaceId is a no-op', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      mockHub.request.mockClear();
      await spaceMcpStore.subscribe(SPACE_ID);
      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('swaps subscriptions when spaceId changes', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      const newSpaceId = 'space-2';
      const newSub = `spaceMcp-${newSpaceId}`;
      await spaceMcpStore.subscribe(newSpaceId);

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
        subscriptionId: SUBSCRIPTION_ID,
      });
      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'mcpEnablement.bySpace',
        params: [newSpaceId],
        subscriptionId: newSub,
      });
    });

    it('surfaces subscription errors via error signal', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('boom'));
      await expect(spaceMcpStore.subscribe(SPACE_ID)).rejects.toThrow('boom');
      expect(spaceMcpStore.error.value).toBe('boom');
      expect(spaceMcpStore.loading.value).toBe(false);
    });
  });

  describe('delta handling', () => {
    beforeEach(async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeEntry('srv-1'), makeEntry('srv-2')],
        version: 1,
      });
    });

    it('applies added rows', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        added: [makeEntry('srv-3')],
        version: 2,
      });
      expect(spaceMcpStore.entries.value.has('srv-3')).toBe(true);
      expect(spaceMcpStore.entries.value.size).toBe(3);
    });

    it('applies updated rows in-place', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        updated: [makeEntry('srv-1', { enabled: false, overridden: true })],
        version: 2,
      });
      expect(spaceMcpStore.entries.value.get('srv-1')?.enabled).toBe(false);
      expect(spaceMcpStore.entries.value.get('srv-1')?.overridden).toBe(true);
    });

    it('applies removed rows', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        removed: [makeEntry('srv-2')],
        version: 2,
      });
      expect(spaceMcpStore.entries.value.has('srv-2')).toBe(false);
      expect(spaceMcpStore.entries.value.size).toBe(1);
    });

    it('ignores deltas with a different subscriptionId', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: 'other',
        added: [makeEntry('srv-99')],
        version: 2,
      });
      expect(spaceMcpStore.entries.value.has('srv-99')).toBe(false);
    });
  });

  describe('stale-event guard', () => {
    it('discards snapshot events fired after unsubscribe', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeEntry('srv-1')],
        version: 1,
      });
      expect(spaceMcpStore.entries.value.size).toBe(1);

      spaceMcpStore.unsubscribe();

      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeEntry('stale')],
        version: 2,
      });
      expect(spaceMcpStore.entries.value.size).toBe(0);
    });

    it('discards delta events fired after unsubscribe', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeEntry('srv-1')],
        version: 1,
      });
      spaceMcpStore.unsubscribe();

      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        added: [makeEntry('stale')],
        version: 2,
      });
      expect(spaceMcpStore.entries.value.size).toBe(0);
    });
  });

  describe('WebSocket reconnect', () => {
    it('re-subscribes when the socket reconnects', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      mockHub.request.mockClear();

      mockHub.fireConnection('connected');

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'mcpEnablement.bySpace',
        params: [SPACE_ID],
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('sets loading=true during re-subscribe', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);

      const values: boolean[] = [];
      const unsub = spaceMcpStore.loading.subscribe((v) => values.push(v));
      mockHub.fireConnection('connected');
      expect(values).toContain(true);
      unsub();
    });
  });

  describe('unsubscribe()', () => {
    it('calls liveQuery.unsubscribe and clears entries', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeEntry('srv-1')],
        version: 1,
      });
      mockHub.request.mockClear();

      spaceMcpStore.unsubscribe();

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
        subscriptionId: SUBSCRIPTION_ID,
      });
      expect(spaceMcpStore.entries.value.size).toBe(0);
    });

    it('is safe to call before subscribe()', () => {
      expect(() => spaceMcpStore.unsubscribe()).not.toThrow();
    });

    it('is idempotent across repeated unsubscribe calls', async () => {
      await spaceMcpStore.subscribe(SPACE_ID);
      spaceMcpStore.unsubscribe();
      mockHub.request.mockClear();
      spaceMcpStore.unsubscribe();
      expect(mockHub.request).not.toHaveBeenCalled();
    });
  });
});
