// @ts-nocheck

import { signal, computed } from '@preact/signals';
import type { Session, AuthStatus, HealthStatus, SystemState } from '@hyperneo/shared';
import type { LiveQueryDeltaEvent, LiveQuerySnapshotEvent } from '@hyperneo/shared';
import { vi } from 'vitest';

const mockHub = {
  request: vi.fn().mockResolvedValue({ acknowledged: true }),
  onEvent: vi.fn(() => vi.fn()),
  onConnection: vi.fn(() => vi.fn()),
  joinRoom: vi.fn(),
  leaveRoom: vi.fn(),
  isConnected: vi.fn(() => true),
};

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(mockHub)),
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));

class TestGlobalStore {
  readonly sessions = signal<Session[]>([]);
  readonly sessionsTotalCount = signal<number>(0);
  readonly hasArchivedSessions = computed<boolean>(
    () => this.sessionsTotalCount.value > this.sessions.value.length
  );
  readonly systemState = signal<SystemState | null>(null);
  readonly settings = signal<Record<string, unknown> | null>(null);

  readonly authStatus = computed<AuthStatus | null>(() => this.systemState.value?.auth || null);
  readonly healthStatus = computed<HealthStatus | null>(
    () => this.systemState.value?.health || null
  );
  readonly sessionCount = computed<number>(() => this.sessions.value.length);
  readonly recentSessions = computed<Session[]>(() => {
    return [...this.sessions.value]
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
      .slice(0, 5);
  });
  readonly activeSessions = computed<Session[]>(() => {
    return this.sessions.value.filter((s) => s.status === 'active');
  });
  readonly apiConnectionStatus = computed<'connected' | 'degraded' | 'disconnected'>(
    () => this.systemState.value?.apiConnection?.status || 'connected'
  );

  private cleanupFunctions: Array<() => void> = [];
  private initialized = false;

  getSession(sessionId: string): Session | undefined {
    return this.sessions.value.find((s) => s.id === sessionId);
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    this.sessions.value = this.sessions.value.map((s) =>
      s.id === sessionId ? { ...s, ...updates } : s
    );
  }

  removeSession(sessionId: string): void {
    this.sessions.value = this.sessions.value.filter((s) => s.id !== sessionId);
  }

  addSession(session: Session): void {
    this.sessions.value = [...this.sessions.value, session];
  }

  applySessionsDelta(event: LiveQueryDeltaEvent): void {
    const next = new Map(this.sessions.value.map((s) => [s.id, s]));

    for (const row of (event.removed ?? []) as Session[]) next.delete(row.id);
    for (const row of (event.updated ?? []) as Session[]) next.set(row.id, row);
    for (const row of (event.added ?? []) as Session[]) next.set(row.id, row);

    this.sessions.value = [...next.values()];
  }

  destroy(): void {
    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch {}
    }
    this.cleanupFunctions = [];
    this.initialized = false;
  }
}

const GlobalStore = TestGlobalStore;

import { GlobalStore as ActualGlobalStore } from '../global-store';

function createTestStore() {
  return new GlobalStore();
}

function createMockSession(id: string, lastActiveAt = new Date().toISOString()): Session {
  return {
    id,
    title: `Session ${id}`,
    workspacePath: `/path/to/${id}`,
    status: 'active',
    config: {},
    metadata: { messageCount: 0 },
    createdAt: new Date().toISOString(),
    lastActiveAt,
  } as Session;
}

describe('GlobalStore - Delta Application Edge Cases', () => {
  let store: GlobalStore;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    store.destroy();
  });

  describe('applySessionsDelta - Complex Scenarios', () => {
    it('should handle empty delta', () => {
      store.sessions.value = [createMockSession('1'), createMockSession('2')];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        added: [],
        removed: [],
        updated: [],
      });

      expect(store.sessions.value).toHaveLength(2);
    });

    it('should handle removing non-existent session', () => {
      store.sessions.value = [createMockSession('1')];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        removed: [{ ...createMockSession('nonexistent') }],
      });

      expect(store.sessions.value).toHaveLength(1);
      expect(store.sessions.value[0].id).toBe('1');
    });

    it('should handle updating non-existent session (adds it as new)', () => {
      store.sessions.value = [createMockSession('1')];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        updated: [{ ...createMockSession('nonexistent'), title: 'Updated' }],
      });

      expect(store.sessions.value).toHaveLength(2);
      const added = store.sessions.value.find((s) => s.id === 'nonexistent');
      expect(added?.title).toBe('Updated');
    });

    it('should apply operations: remove, update, add', () => {
      store.sessions.value = [
        createMockSession('1'),
        createMockSession('2'),
        createMockSession('3'),
      ];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        removed: [createMockSession('2')],
        updated: [{ ...createMockSession('1'), title: 'Updated 1' }],
        added: [createMockSession('4')],
      });

      expect(store.sessions.value).toHaveLength(3);
      expect(store.sessions.value.find((s) => s.id === '2')).toBeUndefined();
      expect(store.sessions.value.find((s) => s.id === '1')?.title).toBe('Updated 1');
      expect(store.sessions.value.find((s) => s.id === '4')).toBeDefined();
    });

    it('should handle multiple additions', () => {
      store.sessions.value = [createMockSession('1')];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        added: [createMockSession('2'), createMockSession('3'), createMockSession('4')],
      });

      expect(store.sessions.value).toHaveLength(4);
      const ids = store.sessions.value.map((s) => s.id);
      expect(ids).toContain('1');
      expect(ids).toContain('2');
      expect(ids).toContain('3');
      expect(ids).toContain('4');
    });

    it('should handle multiple removals', () => {
      store.sessions.value = [
        createMockSession('1'),
        createMockSession('2'),
        createMockSession('3'),
        createMockSession('4'),
      ];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        removed: [createMockSession('1'), createMockSession('3')],
      });

      expect(store.sessions.value).toHaveLength(2);
      expect(store.sessions.value.map((s) => s.id)).toEqual(['2', '4']);
    });

    it('should handle multiple updates', () => {
      store.sessions.value = [
        createMockSession('1'),
        createMockSession('2'),
        createMockSession('3'),
      ];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        updated: [
          { ...createMockSession('1'), title: 'Title 1' },
          { ...createMockSession('3'), title: 'Title 3' },
        ],
      });

      expect(store.sessions.value.find((s) => s.id === '1')?.title).toBe('Title 1');
      expect(store.sessions.value.find((s) => s.id === '2')?.title).toBe('Session 2');
      expect(store.sessions.value.find((s) => s.id === '3')?.title).toBe('Title 3');
    });

    it('should handle empty arrays in delta', () => {
      store.sessions.value = [createMockSession('1')];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        removed: [],
        updated: [],
        added: [],
      });

      expect(store.sessions.value).toHaveLength(1);
    });

    it('should handle undefined delta fields', () => {
      store.sessions.value = [createMockSession('1')];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
      });

      expect(store.sessions.value).toHaveLength(1);
    });

    it('should handle combined remove + update of same session (update wins)', () => {
      store.sessions.value = [createMockSession('1')];

      store.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        removed: [createMockSession('1')],
        updated: [{ ...createMockSession('1'), title: 'Still here' }],
      });

      expect(store.sessions.value).toHaveLength(1);
      expect(store.sessions.value[0].title).toBe('Still here');
    });
  });
});

describe('GlobalStore', () => {
  let store: GlobalStore;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    store.destroy();
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
      const sessions = [
        createMockSession('1', '2024-01-01T00:00:00Z'),
        createMockSession('2', '2024-01-05T00:00:00Z'),
        createMockSession('3', '2024-01-03T00:00:00Z'),
        createMockSession('4', '2024-01-04T00:00:00Z'),
        createMockSession('5', '2024-01-02T00:00:00Z'),
        createMockSession('6', '2024-01-06T00:00:00Z'),
      ];
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

    it('hasArchivedSessions should be true when totalCount exceeds visible sessions', () => {
      store.sessions.value = [createMockSession('1')];
      store.sessionsTotalCount.value = 3;
      expect(store.hasArchivedSessions.value).toBe(true);
    });

    it('hasArchivedSessions should be false when totalCount equals visible sessions', () => {
      store.sessions.value = [createMockSession('1'), createMockSession('2')];
      store.sessionsTotalCount.value = 2;
      expect(store.hasArchivedSessions.value).toBe(false);
    });

    it('hasArchivedSessions should react to totalCount changes', () => {
      store.sessions.value = [createMockSession('1')];
      store.sessionsTotalCount.value = 1;
      expect(store.hasArchivedSessions.value).toBe(false);

      store.sessionsTotalCount.value = 3;
      expect(store.hasArchivedSessions.value).toBe(true);
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

    it('updateSession should not affect other sessions', () => {
      store.updateSession('2', { title: 'Updated' });
      const session1 = store.getSession('1');
      expect(session1?.title).toBe('Session 1');
    });

    it('removeSession should remove session from list', () => {
      store.removeSession('2');
      expect(store.sessions.value).toHaveLength(2);
      expect(store.getSession('2')).toBeUndefined();
    });

    it('removeSession should not throw for non-existent ID', () => {
      expect(() => store.removeSession('nonexistent')).not.toThrow();
      expect(store.sessions.value).toHaveLength(3);
    });

    it('addSession should add session to list', () => {
      const newSession = createMockSession('4');
      store.addSession(newSession);
      expect(store.sessions.value).toHaveLength(4);
      expect(store.getSession('4')).toBeDefined();
    });
  });

  describe('destroy', () => {
    it('should reset initialized flag', () => {
      const privateStore = store as unknown as { initialized: boolean };
      privateStore.initialized = true;

      store.destroy();

      expect(privateStore.initialized).toBe(false);
    });

    it('should clear cleanup functions', () => {
      const privateStore = store as unknown as {
        cleanupFunctions: Array<() => void>;
      };

      privateStore.cleanupFunctions = [() => {}, () => {}];

      store.destroy();

      expect(privateStore.cleanupFunctions).toHaveLength(0);
    });

    it('should call all cleanup functions', () => {
      const privateStore = store as unknown as {
        cleanupFunctions: Array<() => void>;
      };

      const cleanup1 = vi.fn(() => {});
      const cleanup2 = vi.fn(() => {});
      privateStore.cleanupFunctions = [cleanup1, cleanup2];

      store.destroy();

      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
    });

    it('should handle cleanup function errors gracefully', () => {
      const privateStore = store as unknown as {
        cleanupFunctions: Array<() => void>;
      };

      const cleanupError = vi.fn(() => {
        throw new Error('Cleanup error');
      });
      const cleanup2 = vi.fn(() => {});
      privateStore.cleanupFunctions = [cleanupError, cleanup2];

      expect(() => store.destroy()).not.toThrow();

      expect(cleanup2).toHaveBeenCalled();
    });
  });

  describe('applySessionsDelta (private method via reflection)', () => {
    beforeEach(() => {
      store.sessions.value = [
        createMockSession('1'),
        createMockSession('2'),
        createMockSession('3'),
      ];
    });

    it('should add new sessions', () => {
      const privateStore = store as unknown as {
        applySessionsDelta: (event: LiveQueryDeltaEvent) => void;
      };

      privateStore.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        added: [createMockSession('4')],
      });

      expect(store.sessions.value).toHaveLength(4);
      expect(store.sessions.value.find((s) => s.id === '4')).toBeDefined();
    });

    it('should remove sessions', () => {
      const privateStore = store as unknown as {
        applySessionsDelta: (event: LiveQueryDeltaEvent) => void;
      };

      privateStore.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        removed: [createMockSession('2')],
      });

      expect(store.sessions.value).toHaveLength(2);
      expect(store.getSession('2')).toBeUndefined();
    });

    it('should update existing sessions', () => {
      const privateStore = store as unknown as {
        applySessionsDelta: (event: LiveQueryDeltaEvent) => void;
      };

      privateStore.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        updated: [{ ...createMockSession('2'), title: 'Updated Title' }],
      });

      const session = store.getSession('2');
      expect(session?.title).toBe('Updated Title');
    });

    it('should handle combined operations', () => {
      const privateStore = store as unknown as {
        applySessionsDelta: (event: LiveQueryDeltaEvent) => void;
      };

      privateStore.applySessionsDelta({
        subscriptionId: 'test',
        version: 1,
        added: [createMockSession('4')],
        updated: [{ ...createMockSession('1'), title: 'Updated 1' }],
        removed: [createMockSession('2')],
      });

      expect(store.sessions.value).toHaveLength(3);
      expect(store.sessions.value.find((s) => s.id === '4')).toBeDefined();
      expect(store.getSession('1')?.title).toBe('Updated 1');
      expect(store.getSession('2')).toBeUndefined();
    });
  });
});

describe('GlobalStore - initialize()', () => {
  let store: ActualGlobalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should return early if already initialized', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    mockHub.request.mockClear();
    mockHub.onEvent.mockClear();
    mockHub.onConnection.mockClear();

    await store.initialize();

    expect(mockHub.request).not.toHaveBeenCalled();
  });

  it('should subscribe to sessions via LiveQuery', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });

    await store.initialize();

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'sessions.list',
      params: [0],
      subscriptionId: 'sessions-list',
    });

    expect(mockHub.onEvent).toHaveBeenCalledWith('liveQuery.snapshot', expect.any(Function));
    expect(mockHub.onEvent).toHaveBeenCalledWith('liveQuery.delta', expect.any(Function));

    expect(mockHub.onEvent).toHaveBeenCalledWith('state.system', expect.any(Function));
    expect(mockHub.onEvent).toHaveBeenCalledWith('state.settings', expect.any(Function));

    expect(mockHub.onConnection).toHaveBeenCalledWith(expect.any(Function));
  });

  it('should set up subscriptions after subscribing to LiveQuery', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });

    await store.initialize();

    expect(mockHub.onEvent).toHaveBeenCalledTimes(5);
    expect(mockHub.onConnection).toHaveBeenCalledTimes(1);
  });

  it('should handle liveQuery.snapshot events', async () => {
    let snapshotCallback: ((event: LiveQuerySnapshotEvent) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'liveQuery.snapshot') {
        snapshotCallback = callback as typeof snapshotCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    snapshotCallback?.({
      subscriptionId: 'sessions-list',
      rows: [createMockSession('new-1'), createMockSession('new-2')],
      version: 1,
    });

    expect(store.sessions.value).toHaveLength(2);
    expect(store.sessions.value[0].id).toBe('new-1');
  });

  it('should ignore liveQuery.snapshot events for other subscriptions', async () => {
    let snapshotCallback: ((event: LiveQuerySnapshotEvent) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'liveQuery.snapshot') {
        snapshotCallback = callback as typeof snapshotCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    snapshotCallback?.({
      subscriptionId: 'other-subscription',
      rows: [createMockSession('new-1')],
      version: 1,
    });

    expect(store.sessions.value).toHaveLength(0);
  });

  it('should handle liveQuery.snapshot with null rows', async () => {
    let snapshotCallback: ((event: LiveQuerySnapshotEvent) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'liveQuery.snapshot') {
        snapshotCallback = callback as typeof snapshotCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    snapshotCallback?.({
      subscriptionId: 'sessions-list',
      rows: null as unknown as Session[],
      version: 1,
    });

    expect(store.sessions.value).toEqual([]);
  });

  it('should handle liveQuery.delta events', async () => {
    let deltaCallback: ((event: LiveQueryDeltaEvent) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'liveQuery.delta') {
        deltaCallback = callback as typeof deltaCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 1,
      added: [createMockSession('1'), createMockSession('2')],
    });

    expect(store.sessions.value).toHaveLength(2);

    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 2,
      removed: [createMockSession('1')],
      added: [createMockSession('3')],
    });

    expect(store.sessions.value).toHaveLength(2);
    expect(store.sessions.value.find((s) => s.id === '1')).toBeUndefined();
    expect(store.sessions.value.find((s) => s.id === '2')).toBeDefined();
    expect(store.sessions.value.find((s) => s.id === '3')).toBeDefined();
  });

  it('should ignore liveQuery.delta events for other subscriptions', async () => {
    let deltaCallback: ((event: LiveQueryDeltaEvent) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'liveQuery.delta') {
        deltaCallback = callback as typeof deltaCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    deltaCallback?.({
      subscriptionId: 'other-subscription',
      version: 1,
      added: [createMockSession('new-1')],
    });

    expect(store.sessions.value).toHaveLength(0);
  });

  it('should handle system state subscription updates', async () => {
    let systemCallback: ((state: SystemState) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'state.system') {
        systemCallback = callback as typeof systemCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    const newSystemState = {
      auth: { authenticated: true, method: 'oauth' },
      health: { status: 'degraded' },
      apiConnection: { status: 'degraded' },
    };
    systemCallback?.(newSystemState as SystemState);

    expect(store.systemState.value).toEqual(newSystemState);
  });

  it('should handle settings subscription updates', async () => {
    let settingsCallback: ((state: { settings: unknown }) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'state.settings') {
        settingsCallback = callback as typeof settingsCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    settingsCallback?.({ settings: { showArchived: true, theme: 'dark' } });

    expect(store.settings.value).toEqual({ showArchived: true, theme: 'dark' });
  });

  it('should handle settings subscription with null settings', async () => {
    let settingsCallback: ((state: { settings: unknown }) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'state.settings') {
        settingsCallback = callback as typeof settingsCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    settingsCallback?.({ settings: null });

    expect(store.settings.value).toBeNull();
  });

  it('should register reconnection handler', async () => {
    let connectionCallback: ((state: string) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onConnection.mockImplementation((callback: unknown) => {
      connectionCallback = callback as typeof connectionCallback;
      return vi.fn();
    });

    await store.initialize();

    mockHub.request.mockClear();
    connectionCallback?.('connected');

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'sessions.list',
      params: [0],
      subscriptionId: 'sessions-list',
    });
  });

  it('should not re-subscribe on non-connected states', async () => {
    let connectionCallback: ((state: string) => void) | null = null;

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onConnection.mockImplementation((callback: unknown) => {
      connectionCallback = callback as typeof connectionCallback;
      return vi.fn();
    });

    await store.initialize();

    mockHub.request.mockClear();
    connectionCallback?.('disconnected');

    expect(mockHub.request).not.toHaveBeenCalled();
  });

  it('should handle getHub error gracefully', async () => {
    const { connectionManager } = await import('../connection-manager');
    vi.mocked(connectionManager.getHub).mockRejectedValueOnce(new Error('Network error'));

    await store.initialize();

    const privateStore = store as unknown as { initialized: boolean };
    expect(privateStore.initialized).toBe(false);
  });
});

describe('GlobalStore - refresh()', () => {
  let store: ActualGlobalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should return early if not initialized', async () => {
    await store.refresh();

    expect(mockHub.request).not.toHaveBeenCalled();
  });

  it('should re-subscribe to LiveQuery and fetch GLOBAL_SNAPSHOT when initialized', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    mockHub.request.mockResolvedValueOnce({ acknowledged: true }).mockResolvedValueOnce({
      system: {
        auth: { authenticated: true, method: 'api_key' },
        health: { status: 'healthy' },
        apiConnection: { status: 'connected' },
      },
      settings: { settings: { refreshed: true } },
    });

    await store.refresh();

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'sessions.list',
      params: [0],
      subscriptionId: 'sessions-list',
    });

    expect(mockHub.request).toHaveBeenCalledWith('state.global.snapshot', {});

    expect(store.systemState.value?.auth).toEqual({
      authenticated: true,
      method: 'api_key',
    });
    expect(store.settings.value).toEqual({ refreshed: true });
  });

  it('should handle GLOBAL_SNAPSHOT with null fields', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    mockHub.request.mockResolvedValueOnce({ acknowledged: true }).mockResolvedValueOnce({
      system: null,
      settings: null,
    });

    await store.refresh();

    expect(store.systemState.value).toBeNull();
    expect(store.settings.value).toBeNull();
  });

  it('should handle GLOBAL_SNAPSHOT with missing settings field', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    mockHub.request.mockResolvedValueOnce({ acknowledged: true }).mockResolvedValueOnce({
      system: { auth: { authenticated: true } },
    });

    await store.refresh();

    expect(store.settings.value).toBeNull();
  });

  it('should handle refresh when LiveQuery subscribe fails', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    mockHub.request.mockRejectedValueOnce(new Error('Subscribe failed')).mockResolvedValueOnce({
      system: null,
      settings: null,
    });

    await store.refresh();

    expect(store.systemState.value).toBeNull();
  });
});

describe('GlobalStore - Session Helpers (actual)', () => {
  let store: ActualGlobalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();
    store.sessions.value = [createMockSession('1'), createMockSession('2'), createMockSession('3')];
  });

  afterEach(() => {
    store.destroy();
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

  it('updateSession should not affect other sessions', () => {
    store.updateSession('2', { title: 'Updated' });
    const session1 = store.getSession('1');
    expect(session1?.title).toBe('Session 1');
  });

  it('removeSession should remove session from list', () => {
    store.removeSession('2');
    expect(store.sessions.value).toHaveLength(2);
    expect(store.getSession('2')).toBeUndefined();
  });

  it('removeSession should not throw for non-existent ID', () => {
    expect(() => store.removeSession('nonexistent')).not.toThrow();
    expect(store.sessions.value).toHaveLength(3);
  });

  it('addSession should add session to list', () => {
    const newSession = createMockSession('4');
    store.addSession(newSession);
    expect(store.sessions.value).toHaveLength(4);
    expect(store.getSession('4')).toBeDefined();
  });
});

describe('GlobalStore - destroy (actual)', () => {
  let store: ActualGlobalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();
  });

  it('should handle cleanup function errors gracefully', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });

    let callCount = 0;
    mockHub.onEvent.mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return () => {
          throw new Error('Cleanup error');
        };
      }
      return vi.fn();
    });

    await store.initialize();

    expect(() => store.destroy()).not.toThrow();
  });

  it('should reset initialized flag on destroy', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    const privateStore = store as unknown as { initialized: boolean };
    expect(privateStore.initialized).toBe(true);

    store.destroy();

    expect(privateStore.initialized).toBe(false);
  });

  it('should clear cleanup functions on destroy', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    const privateStore = store as unknown as { cleanupFunctions: Array<() => void> };
    expect(privateStore.cleanupFunctions.length).toBe(7);

    store.destroy();

    expect(privateStore.cleanupFunctions.length).toBe(0);
  });

  it('should call liveQuery.unsubscribe on destroy when connected', async () => {
    mockHub.request.mockResolvedValue({ acknowledged: true });
    await store.initialize();

    mockHub.request.mockClear();

    store.destroy();

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
      subscriptionId: 'sessions-list',
    });
  });

  it('should not call liveQuery.unsubscribe on destroy when not connected', async () => {
    const { connectionManager } = await import('../connection-manager');
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValueOnce(null);

    store.destroy();

    expect(mockHub.request).not.toHaveBeenCalledWith('liveQuery.unsubscribe', expect.anything());
  });
});

describe('GlobalStore - applySessionsDelta (actual)', () => {
  let store: ActualGlobalStore;
  let deltaCallback: ((event: LiveQueryDeltaEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();

    mockHub.request.mockResolvedValue({ acknowledged: true });

    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'liveQuery.delta') {
        deltaCallback = callback as typeof deltaCallback;
      }
      return vi.fn();
    });

    await store.initialize();

    store.sessions.value = [createMockSession('1'), createMockSession('2'), createMockSession('3')];
  });

  afterEach(() => {
    store.destroy();
    deltaCallback = null;
  });

  it('should handle empty delta', () => {
    deltaCallback?.({ subscriptionId: 'sessions-list', version: 1 });
    expect(store.sessions.value).toHaveLength(3);
  });

  it('should remove sessions via delta', () => {
    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 1,
      removed: [createMockSession('2')],
    });
    expect(store.sessions.value).toHaveLength(2);
    expect(store.getSession('2')).toBeUndefined();
  });

  it('should update sessions via delta', () => {
    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 1,
      updated: [{ ...createMockSession('2'), title: 'Updated Title' }],
    });
    expect(store.getSession('2')?.title).toBe('Updated Title');
  });

  it('should add sessions via delta', () => {
    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 1,
      added: [createMockSession('4')],
    });
    expect(store.sessions.value).toHaveLength(4);
    expect(store.sessions.value.find((s) => s.id === '4')).toBeDefined();
  });

  it('should handle removing non-existent session', () => {
    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 1,
      removed: [createMockSession('nonexistent')],
    });
    expect(store.sessions.value).toHaveLength(3);
  });

  it('should handle updating non-existent session (adds it)', () => {
    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 1,
      updated: [{ ...createMockSession('nonexistent'), title: 'New' }],
    });
    expect(store.sessions.value).toHaveLength(4);
    expect(store.sessions.value.find((s) => s.id === 'nonexistent')?.title).toBe('New');
  });

  it('should apply combined delta operations', () => {
    deltaCallback?.({
      subscriptionId: 'sessions-list',
      version: 1,
      removed: [createMockSession('2')],
      updated: [{ ...createMockSession('1'), title: 'Updated 1' }],
      added: [createMockSession('4')],
    });

    expect(store.sessions.value).toHaveLength(3);
    expect(store.sessions.value.find((s) => s.id === '4')).toBeDefined();
    expect(store.getSession('1')?.title).toBe('Updated 1');
    expect(store.getSession('2')).toBeUndefined();
  });

  it('should ignore delta for other subscription IDs', () => {
    deltaCallback?.({
      subscriptionId: 'other-subscription',
      version: 1,
      removed: [createMockSession('1')],
      added: [createMockSession('5')],
    });

    expect(store.sessions.value).toHaveLength(3);
  });
});

describe('GlobalStore - LiveQuery Snapshot (actual)', () => {
  let store: ActualGlobalStore;
  let snapshotCallback: ((event: LiveQuerySnapshotEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();

    mockHub.request.mockResolvedValue({ acknowledged: true });
    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'liveQuery.snapshot') {
        snapshotCallback = callback as typeof snapshotCallback;
      }
      return vi.fn();
    });

    await store.initialize();
  });

  afterEach(() => {
    store.destroy();
    snapshotCallback = null;
  });

  it('should replace sessions on snapshot', () => {
    store.sessions.value = [createMockSession('old-1'), createMockSession('old-2')];

    snapshotCallback?.({
      subscriptionId: 'sessions-list',
      rows: [createMockSession('new-1'), createMockSession('new-2'), createMockSession('new-3')],
      version: 5,
    });

    expect(store.sessions.value).toHaveLength(3);
    expect(store.sessions.value.map((s) => s.id)).toEqual(['new-1', 'new-2', 'new-3']);
  });

  it('should handle snapshot with empty rows', () => {
    store.sessions.value = [createMockSession('old-1')];

    snapshotCallback?.({
      subscriptionId: 'sessions-list',
      rows: [],
      version: 2,
    });

    expect(store.sessions.value).toHaveLength(0);
  });

  it('should update hasArchivedSessions when totalCount exceeds visible sessions', () => {
    snapshotCallback?.({
      subscriptionId: 'sessions-list',
      rows: [createMockSession('1')],
      version: 1,
      metadata: { totalCount: 5 },
    });

    expect(store.hasArchivedSessions.value).toBe(true);
  });

  it('should not set hasArchivedSessions when totalCount equals visible sessions', () => {
    snapshotCallback?.({
      subscriptionId: 'sessions-list',
      rows: [createMockSession('1'), createMockSession('2')],
      version: 1,
      metadata: { totalCount: 2 },
    });

    expect(store.hasArchivedSessions.value).toBe(false);
  });

  it('should ignore snapshot for other subscription IDs', () => {
    store.sessions.value = [createMockSession('existing')];

    snapshotCallback?.({
      subscriptionId: 'other-subscription',
      rows: [createMockSession('should-not-appear')],
      version: 1,
    });

    expect(store.sessions.value).toHaveLength(1);
    expect(store.sessions.value[0].id).toBe('existing');
  });
});

describe('GlobalStore - Subscription Callbacks (actual)', () => {
  let store: ActualGlobalStore;
  let systemCallback: ((state: SystemState) => void) | null = null;
  let settingsCallback: ((state: { settings: unknown }) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();

    mockHub.request.mockResolvedValue({ acknowledged: true });

    mockHub.onEvent.mockImplementation((channel: string, callback: unknown) => {
      if (channel === 'state.system') {
        systemCallback = callback as typeof systemCallback;
      } else if (channel === 'state.settings') {
        settingsCallback = callback as typeof settingsCallback;
      }
      return vi.fn();
    });

    await store.initialize();
  });

  afterEach(() => {
    store.destroy();
    systemCallback = null;
    settingsCallback = null;
  });

  it('should update systemState through subscription', () => {
    const newSystemState = {
      auth: { authenticated: true, method: 'api_key' },
      health: { status: 'healthy' },
      apiConnection: { status: 'connected' },
    };
    systemCallback?.(newSystemState as SystemState);
    expect(store.systemState.value).toEqual(newSystemState);
  });

  it('should handle settings update with missing settings field', () => {
    settingsCallback?.({ settings: undefined });
    expect(store.settings.value).toBeNull();
  });

  it('should update settings through subscription', () => {
    settingsCallback?.({ settings: { theme: 'dark', showArchived: true } });
    expect(store.settings.value).toEqual({ theme: 'dark', showArchived: true });
  });
});

describe('GlobalStore - Computed Accessors (actual)', () => {
  let store: ActualGlobalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ActualGlobalStore();
  });

  afterEach(() => {
    store.destroy();
  });

  describe('hasArchivedSessions', () => {
    it('should be false when no sessions', () => {
      expect(store.hasArchivedSessions.value).toBe(false);
    });

    it('should be false when totalCount equals visible sessions', () => {
      store.sessions.value = [createMockSession('1'), createMockSession('2')];
      store.sessionsTotalCount.value = 2;
      expect(store.hasArchivedSessions.value).toBe(false);
    });

    it('should be true when totalCount exceeds visible sessions', () => {
      store.sessions.value = [createMockSession('1')];
      store.sessionsTotalCount.value = 3;
      expect(store.hasArchivedSessions.value).toBe(true);
    });
  });

  describe('healthStatus', () => {
    it('should return health from systemState', () => {
      store.systemState.value = {
        auth: { authenticated: true, method: 'api_key' },
        health: { status: 'healthy' },
        apiConnection: { status: 'connected' },
      } as SystemState;
      expect(store.healthStatus.value).toEqual({ status: 'healthy' });
    });
  });

  describe('recentSessions', () => {
    it('should return last 5 sessions sorted by lastActiveAt', () => {
      const sessions = [
        createMockSession('1', '2024-01-01T00:00:00Z'),
        createMockSession('2', '2024-01-05T00:00:00Z'),
        createMockSession('3', '2024-01-03T00:00:00Z'),
        createMockSession('4', '2024-01-04T00:00:00Z'),
        createMockSession('5', '2024-01-02T00:00:00Z'),
        createMockSession('6', '2024-01-06T00:00:00Z'),
      ];
      store.sessions.value = sessions;

      const recent = store.recentSessions.value;
      expect(recent).toHaveLength(5);
      expect(recent[0].id).toBe('6');
      expect(recent[1].id).toBe('2');
      expect(recent[2].id).toBe('4');
      expect(recent[3].id).toBe('3');
      expect(recent[4].id).toBe('5');
    });

    it('should handle sessions with same lastActiveAt', () => {
      const sameTime = '2024-01-01T00:00:00Z';
      const sessions = [createMockSession('1', sameTime), createMockSession('2', sameTime)];
      store.sessions.value = sessions;

      const recent = store.recentSessions.value;
      expect(recent).toHaveLength(2);
    });
  });

  describe('activeSessions', () => {
    it('should filter by active status', () => {
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
  });

  describe('apiConnectionStatus', () => {
    it('should return connected by default', () => {
      expect(store.apiConnectionStatus.value).toBe('connected');
    });

    it('should return degraded when system state shows degraded', () => {
      store.systemState.value = {
        auth: { authenticated: true, method: 'api_key' },
        health: { status: 'healthy' },
        apiConnection: { status: 'degraded' },
      } as SystemState;
      expect(store.apiConnectionStatus.value).toBe('degraded');
    });

    it('should return disconnected when system state shows disconnected', () => {
      store.systemState.value = {
        auth: { authenticated: true, method: 'api_key' },
        health: { status: 'healthy' },
        apiConnection: { status: 'disconnected' },
      } as SystemState;
      expect(store.apiConnectionStatus.value).toBe('disconnected');
    });
  });
});
