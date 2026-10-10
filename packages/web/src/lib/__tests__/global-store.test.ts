import type {
  LiveQueryDeltaEvent,
  LiveQuerySnapshotEvent,
  Session,
  SettingsState,
  SystemState,
} from '@hyperneo/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';
import type { GlobalSettings } from '@hyperneo/shared/types/settings';
import { vi } from 'vitest';
import { connectionManager } from '../connection-manager';
import { GlobalStore } from '../global-store';

type Unsubscribe = ReturnType<typeof vi.fn<() => void>>;

const hub = vi.hoisted(() => {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const connectionHandlers = new Set<(state: string) => void>();
  const unsubscribers: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  const state: { snapshot: unknown } = { snapshot: null };

  const track = (remove: () => void) => {
    const unsub = vi.fn<() => void>(remove);
    unsubscribers.push(unsub);
    return unsub;
  };

  return {
    eventHandlers,
    connectionHandlers,
    unsubscribers,
    state,
    request: vi.fn<(method: string, data?: unknown) => Promise<unknown>>(),
    onEvent: vi.fn((channel: string, handler: (data: unknown) => void) => {
      const handlers = eventHandlers.get(channel) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(channel, handlers);
      return track(() => handlers.delete(handler));
    }),
    onConnection: vi.fn((handler: (state: string) => void) => {
      connectionHandlers.add(handler);
      return track(() => connectionHandlers.delete(handler));
    }),
    emit(channel: string, data: unknown) {
      for (const handler of [...(eventHandlers.get(channel) ?? [])]) handler(data);
    },
    setConnection(connectionState: string) {
      for (const handler of [...connectionHandlers]) handler(connectionState);
    },
  };
});

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(hub)),
    getHubIfConnected: vi.fn(() => hub),
  },
}));

function defaultRequest(method: string): Promise<unknown> {
  if (method === 'state.global.snapshot') return Promise.resolve(hub.state.snapshot);
  return Promise.resolve({ acknowledged: true });
}

function resetHub(): void {
  vi.clearAllMocks();
  hub.eventHandlers.clear();
  hub.connectionHandlers.clear();
  hub.unsubscribers.length = 0;
  hub.state.snapshot = null;
  hub.request.mockImplementation(defaultRequest);
}

function createMockSession(id: string, lastActiveAt = new Date().toISOString()): Session {
  return {
    id,
    title: `Session ${id}`,
    workspacePath: `/path/to/${id}`,
    status: 'active',
    config: { model: 'default', maxTokens: 1024, temperature: 0 },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    createdAt: new Date().toISOString(),
    lastActiveAt,
  };
}

function createSystemState(overrides: Partial<SystemState> = {}): SystemState {
  return {
    version: '1.0.0',
    claudeSDKVersion: '1.0.0',
    defaultModel: 'default',
    maxSessions: 10,
    storageLocation: '/tmp/hyperneo',
    auth: { method: 'api_key', isAuthenticated: true },
    health: { status: 'ok', version: '1.0.0', uptime: 1, sessions: { active: 0, total: 0 } },
    apiConnection: { status: 'connected', timestamp: 1 },
    credentialStore: { backend: 'keychain', keychainAvailable: true },
    timestamp: 1,
    ...overrides,
  };
}

function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...DEFAULT_GLOBAL_SETTINGS, ...overrides };
}

function settingsState(settings: GlobalSettings): SettingsState {
  return { settings, timestamp: 1 };
}

function emitSnapshot(event: Partial<LiveQuerySnapshotEvent>): void {
  hub.emit('liveQuery.snapshot', {
    subscriptionId: 'sessions-list',
    rows: [],
    version: 1,
    ...event,
  } satisfies LiveQuerySnapshotEvent);
}

function emitDelta(event: Partial<LiveQueryDeltaEvent>): void {
  hub.emit('liveQuery.delta', {
    subscriptionId: 'sessions-list',
    version: 1,
    ...event,
  } satisfies LiveQueryDeltaEvent);
}

function subscribeCalls(): unknown[] {
  return hub.request.mock.calls
    .filter(([method]) => method === 'liveQuery.subscribe')
    .map(([, data]) => data);
}

async function createInitializedStore(...sessions: Session[]): Promise<GlobalStore> {
  const store = new GlobalStore();
  await store.initialize();
  if (sessions.length > 0) emitSnapshot({ rows: sessions });
  return store;
}

describe('GlobalStore - Delta Application', () => {
  let store: GlobalStore;

  beforeEach(() => {
    resetHub();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should leave sessions untouched for an empty delta', async () => {
    store = await createInitializedStore(createMockSession('1'), createMockSession('2'));
    const before = store.sessions.value;

    emitDelta({ added: [], removed: [], updated: [] });

    expect(store.sessions.value).toBe(before);
    expect(store.sessions.value).toHaveLength(2);
  });

  it('should leave sessions untouched when delta fields are undefined', async () => {
    store = await createInitializedStore(createMockSession('1'));
    const before = store.sessions.value;

    emitDelta({});

    expect(store.sessions.value).toBe(before);
    expect(store.sessions.value).toHaveLength(1);
  });

  it('should add new sessions', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3')
    );

    emitDelta({ added: [createMockSession('4')] });

    expect(store.sessions.value).toHaveLength(4);
    expect(store.getSession('4')).toBeDefined();
  });

  it('should remove sessions', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3')
    );

    emitDelta({ removed: [createMockSession('2')] });

    expect(store.sessions.value).toHaveLength(2);
    expect(store.getSession('2')).toBeUndefined();
  });

  it('should update existing sessions', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3')
    );

    emitDelta({ updated: [{ ...createMockSession('2'), title: 'Updated Title' }] });

    expect(store.getSession('2')?.title).toBe('Updated Title');
    expect(store.sessions.value).toHaveLength(3);
  });

  it('should handle removing non-existent session', async () => {
    store = await createInitializedStore(createMockSession('1'));

    emitDelta({ removed: [createMockSession('nonexistent')] });

    expect(store.sessions.value).toHaveLength(1);
    expect(store.sessions.value[0].id).toBe('1');
  });

  it('should handle updating non-existent session (adds it as new)', async () => {
    store = await createInitializedStore(createMockSession('1'));

    emitDelta({ updated: [{ ...createMockSession('nonexistent'), title: 'Updated' }] });

    expect(store.sessions.value).toHaveLength(2);
    expect(store.getSession('nonexistent')?.title).toBe('Updated');
  });

  it('should apply operations: remove, update, add', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3')
    );

    emitDelta({
      removed: [createMockSession('2')],
      updated: [{ ...createMockSession('1'), title: 'Updated 1' }],
      added: [createMockSession('4')],
    });

    expect(store.sessions.value).toHaveLength(3);
    expect(store.getSession('2')).toBeUndefined();
    expect(store.getSession('1')?.title).toBe('Updated 1');
    expect(store.getSession('4')).toBeDefined();
  });

  it('should handle multiple additions', async () => {
    store = await createInitializedStore(createMockSession('1'));

    emitDelta({
      added: [createMockSession('2'), createMockSession('3'), createMockSession('4')],
    });

    expect(store.sessions.value.map((s) => s.id)).toEqual(['1', '2', '3', '4']);
  });

  it('should handle multiple removals', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3'),
      createMockSession('4')
    );

    emitDelta({ removed: [createMockSession('1'), createMockSession('3')] });

    expect(store.sessions.value.map((s) => s.id)).toEqual(['2', '4']);
  });

  it('should handle multiple updates', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3')
    );

    emitDelta({
      updated: [
        { ...createMockSession('1'), title: 'Title 1' },
        { ...createMockSession('3'), title: 'Title 3' },
      ],
    });

    expect(store.getSession('1')?.title).toBe('Title 1');
    expect(store.getSession('2')?.title).toBe('Session 2');
    expect(store.getSession('3')?.title).toBe('Title 3');
  });

  it('should handle combined remove + update of same session (update wins)', async () => {
    store = await createInitializedStore(createMockSession('1'));

    emitDelta({
      removed: [createMockSession('1')],
      updated: [{ ...createMockSession('1'), title: 'Still here' }],
    });

    expect(store.sessions.value).toHaveLength(1);
    expect(store.sessions.value[0].title).toBe('Still here');
  });

  it('should apply sequential deltas', async () => {
    store = await createInitializedStore();

    emitDelta({ added: [createMockSession('1'), createMockSession('2')] });
    expect(store.sessions.value).toHaveLength(2);

    emitDelta({ version: 2, removed: [createMockSession('1')], added: [createMockSession('3')] });

    expect(store.sessions.value.map((s) => s.id)).toEqual(['2', '3']);
  });

  it('should ignore delta for other subscription IDs', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3')
    );

    emitDelta({
      subscriptionId: 'other-subscription',
      removed: [createMockSession('1')],
      added: [createMockSession('5')],
      metadata: { totalCount: 99, archivedCount: 99 },
    });

    expect(store.sessions.value.map((s) => s.id)).toEqual(['1', '2', '3']);
    expect(store.sessionsTotalCount.value).toBe(0);
    expect(store.archivedSessionCount.value).toBe(0);
  });
});

describe('GlobalStore - Counts and Archived Sessions', () => {
  let store: GlobalStore;

  beforeEach(() => {
    resetHub();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should start with zero counts and no archived sessions', () => {
    store = new GlobalStore();

    expect(store.sessionsTotalCount.value).toBe(0);
    expect(store.archivedSessionCount.value).toBe(0);
    expect(store.hasArchivedSessions.value).toBe(false);
  });

  it('should be true when totalCount exceeds visible sessions', async () => {
    store = await createInitializedStore();

    emitSnapshot({ rows: [createMockSession('1')], metadata: { totalCount: 5 } });

    expect(store.sessionsTotalCount.value).toBe(5);
    expect(store.hasArchivedSessions.value).toBe(true);
  });

  it('should be false when totalCount equals visible sessions', async () => {
    store = await createInitializedStore();

    emitSnapshot({
      rows: [createMockSession('1'), createMockSession('2')],
      metadata: { totalCount: 2 },
    });

    expect(store.hasArchivedSessions.value).toBe(false);
  });

  it('should be true when archivedCount is positive even if totalCount equals visible sessions', async () => {
    store = await createInitializedStore();

    emitSnapshot({
      rows: [createMockSession('1'), createMockSession('2')],
      metadata: { totalCount: 2, archivedCount: 3 },
    });

    expect(store.archivedSessionCount.value).toBe(3);
    expect(store.hasArchivedSessions.value).toBe(true);
  });

  it('should update counts from delta metadata', async () => {
    store = await createInitializedStore();
    emitSnapshot({
      rows: [createMockSession('1')],
      metadata: { totalCount: 1, archivedCount: 2 },
    });
    expect(store.hasArchivedSessions.value).toBe(true);

    emitDelta({ added: [createMockSession('2')], metadata: { totalCount: 2, archivedCount: 0 } });

    expect(store.sessionsTotalCount.value).toBe(2);
    expect(store.archivedSessionCount.value).toBe(0);
    expect(store.hasArchivedSessions.value).toBe(false);
  });

  it('should report archived sessions when a delta raises archivedCount', async () => {
    store = await createInitializedStore(createMockSession('1'));
    expect(store.hasArchivedSessions.value).toBe(false);

    emitDelta({ removed: [createMockSession('1')], metadata: { archivedCount: 1 } });

    expect(store.sessions.value).toHaveLength(0);
    expect(store.hasArchivedSessions.value).toBe(true);
  });

  it('should keep previous counts when metadata omits them', async () => {
    store = await createInitializedStore();
    emitSnapshot({ rows: [createMockSession('1')], metadata: { totalCount: 4, archivedCount: 3 } });

    emitSnapshot({ rows: [createMockSession('1')] });
    emitDelta({ updated: [createMockSession('1')], metadata: {} });

    expect(store.sessionsTotalCount.value).toBe(4);
    expect(store.archivedSessionCount.value).toBe(3);
  });

  it('should react to totalCount changes as sessions arrive', async () => {
    store = await createInitializedStore();
    emitSnapshot({ rows: [createMockSession('1')], metadata: { totalCount: 1 } });
    expect(store.hasArchivedSessions.value).toBe(false);

    emitDelta({ metadata: { totalCount: 3 } });

    expect(store.hasArchivedSessions.value).toBe(true);
  });
});

describe('GlobalStore - Initial State', () => {
  let store: GlobalStore;

  beforeEach(() => {
    resetHub();
    store = new GlobalStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should start with empty sessions array', () => {
    expect(store.sessions.value).toEqual([]);
    expect(store.sessionCount.value).toBe(0);
  });

  it('should start with null systemState and derived statuses', () => {
    expect(store.systemState.value).toBeNull();
    expect(store.authStatus.value).toBeNull();
    expect(store.healthStatus.value).toBeNull();
    expect(store.credentialStoreStatus.value).toBeNull();
    expect(store.apiConnectionStatus.value).toBe('connected');
  });

  it('should start with null settings', () => {
    expect(store.settings.value).toBeNull();
  });
});

describe('GlobalStore - Computed Accessors', () => {
  let store: GlobalStore;

  beforeEach(() => {
    resetHub();
  });

  afterEach(() => {
    store.destroy();
  });

  it('authStatus, healthStatus and credentialStoreStatus should follow system state events', async () => {
    store = await createInitializedStore();
    const system = createSystemState();

    hub.emit('state.system', system);

    expect(store.authStatus.value).toEqual({ method: 'api_key', isAuthenticated: true });
    expect(store.healthStatus.value).toEqual(system.health);
    expect(store.credentialStoreStatus.value).toEqual({
      backend: 'keychain',
      keychainAvailable: true,
    });
  });

  it('sessionCount should return correct count', async () => {
    store = await createInitializedStore(createMockSession('1'), createMockSession('2'));

    expect(store.sessionCount.value).toBe(2);
  });

  it('recentSessions should return last 5 sessions sorted by lastActiveAt', async () => {
    store = await createInitializedStore(
      createMockSession('1', '2024-01-01T00:00:00Z'),
      createMockSession('2', '2024-01-05T00:00:00Z'),
      createMockSession('3', '2024-01-03T00:00:00Z'),
      createMockSession('4', '2024-01-04T00:00:00Z'),
      createMockSession('5', '2024-01-02T00:00:00Z'),
      createMockSession('6', '2024-01-06T00:00:00Z')
    );

    expect(store.recentSessions.value.map((s) => s.id)).toEqual(['6', '2', '4', '3', '5']);
    expect(store.sessions.value.map((s) => s.id)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('recentSessions should handle sessions with same lastActiveAt', async () => {
    const sameTime = '2024-01-01T00:00:00Z';
    store = await createInitializedStore(
      createMockSession('1', sameTime),
      createMockSession('2', sameTime)
    );

    expect(store.recentSessions.value.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('activeSessions should filter by active status', async () => {
    store = await createInitializedStore(
      createMockSession('1'),
      { ...createMockSession('2'), status: 'archived' },
      createMockSession('3')
    );

    expect(store.activeSessions.value.map((s) => s.id)).toEqual(['1', '3']);
  });

  it.each(['connected', 'degraded', 'disconnected'] as const)(
    'apiConnectionStatus should reflect %s system state',
    async (status) => {
      store = await createInitializedStore();

      hub.emit('state.system', createSystemState({ apiConnection: { status, timestamp: 2 } }));

      expect(store.apiConnectionStatus.value).toBe(status);
    }
  );
});

describe('GlobalStore - Session Helpers', () => {
  let store: GlobalStore;

  beforeEach(async () => {
    resetHub();
    store = await createInitializedStore(
      createMockSession('1'),
      createMockSession('2'),
      createMockSession('3')
    );
  });

  afterEach(() => {
    store.destroy();
  });

  it('getSession should return session by ID', () => {
    expect(store.getSession('2')?.id).toBe('2');
  });

  it('getSession should return undefined for non-existent ID', () => {
    expect(store.getSession('nonexistent')).toBeUndefined();
  });

  it('updateSession should update session properties', () => {
    store.updateSession('2', { title: 'Updated Title' });
    expect(store.getSession('2')?.title).toBe('Updated Title');
  });

  it('updateSession should not affect other sessions', () => {
    store.updateSession('2', { title: 'Updated' });
    expect(store.getSession('1')?.title).toBe('Session 1');
    expect(store.getSession('3')?.title).toBe('Session 3');
  });

  it('removeSession should remove session from list', () => {
    store.removeSession('2');
    expect(store.sessions.value.map((s) => s.id)).toEqual(['1', '3']);
  });

  it('removeSession should not throw for non-existent ID', () => {
    expect(() => store.removeSession('nonexistent')).not.toThrow();
    expect(store.sessions.value).toHaveLength(3);
  });

  it('addSession should add session to list', () => {
    store.addSession(createMockSession('4'));
    expect(store.sessions.value.map((s) => s.id)).toEqual(['1', '2', '3', '4']);
  });

  it('should apply a later delta on top of local mutations', () => {
    store.updateSession('1', { title: 'Local' });
    store.addSession(createMockSession('4'));

    emitDelta({ removed: [createMockSession('4')] });

    expect(store.getSession('1')?.title).toBe('Local');
    expect(store.getSession('4')).toBeUndefined();
  });
});

describe('GlobalStore - initialize()', () => {
  let store: GlobalStore;

  beforeEach(() => {
    resetHub();
    store = new GlobalStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should return early if already initialized', async () => {
    await store.initialize();
    hub.request.mockClear();
    hub.onEvent.mockClear();
    hub.onConnection.mockClear();
    vi.mocked(connectionManager.getHub).mockClear();

    await store.initialize();

    expect(connectionManager.getHub).not.toHaveBeenCalled();
    expect(hub.request).not.toHaveBeenCalled();
    expect(hub.onEvent).not.toHaveBeenCalled();
    expect(hub.onConnection).not.toHaveBeenCalled();
  });

  it('should subscribe to sessions via LiveQuery', async () => {
    await store.initialize();

    expect(hub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'sessions.list',
      params: [0],
      subscriptionId: 'sessions-list',
    });
    expect(hub.onEvent).toHaveBeenCalledWith('liveQuery.snapshot', expect.any(Function));
    expect(hub.onEvent).toHaveBeenCalledWith('liveQuery.delta', expect.any(Function));
    expect(hub.onEvent).toHaveBeenCalledWith('state.system', expect.any(Function));
    expect(hub.onEvent).toHaveBeenCalledWith('state.settings', expect.any(Function));
    expect(hub.onConnection).toHaveBeenCalledWith(expect.any(Function));
  });

  it('should register five event handlers and one connection handler', async () => {
    await store.initialize();

    expect(hub.onEvent).toHaveBeenCalledTimes(5);
    expect(hub.onConnection).toHaveBeenCalledTimes(1);
  });

  it('should apply the global snapshot fetched during initialization', async () => {
    const system = createSystemState();
    const settings = createSettings({ showArchived: true });
    hub.state.snapshot = { system, settings: settingsState(settings) };

    await store.initialize();

    expect(hub.request).toHaveBeenCalledWith('state.global.snapshot', { includeSessions: false });
    expect(store.systemState.value).toEqual(system);
    expect(store.settings.value).toEqual(settings);
  });

  it('should handle liveQuery.snapshot events', async () => {
    await store.initialize();

    emitSnapshot({ rows: [createMockSession('new-1'), createMockSession('new-2')] });

    expect(store.sessions.value.map((s) => s.id)).toEqual(['new-1', 'new-2']);
  });

  it('should replace sessions on snapshot', async () => {
    store = await createInitializedStore(createMockSession('old-1'), createMockSession('old-2'));

    emitSnapshot({
      rows: [createMockSession('new-1'), createMockSession('new-2'), createMockSession('new-3')],
      version: 5,
    });

    expect(store.sessions.value.map((s) => s.id)).toEqual(['new-1', 'new-2', 'new-3']);
  });

  it('should handle snapshot with empty rows', async () => {
    store = await createInitializedStore(createMockSession('old-1'));

    emitSnapshot({ rows: [], version: 2 });

    expect(store.sessions.value).toHaveLength(0);
  });

  it('should handle liveQuery.snapshot with null rows', async () => {
    store = await createInitializedStore(createMockSession('old-1'));

    hub.emit('liveQuery.snapshot', { subscriptionId: 'sessions-list', rows: null, version: 1 });

    expect(store.sessions.value).toEqual([]);
  });

  it('should ignore liveQuery.snapshot events for other subscriptions', async () => {
    store = await createInitializedStore(createMockSession('existing'));

    emitSnapshot({
      subscriptionId: 'other-subscription',
      rows: [createMockSession('should-not-appear')],
      metadata: { totalCount: 99, archivedCount: 99 },
    });

    expect(store.sessions.value.map((s) => s.id)).toEqual(['existing']);
    expect(store.sessionsTotalCount.value).toBe(0);
    expect(store.archivedSessionCount.value).toBe(0);
  });

  it('should handle system state subscription updates', async () => {
    await store.initialize();
    const system = createSystemState({
      auth: { method: 'oauth', isAuthenticated: true },
      apiConnection: { status: 'degraded', timestamp: 2 },
    });

    hub.emit('state.system', system);

    expect(store.systemState.value).toEqual(system);
  });

  it('should handle settings subscription updates', async () => {
    await store.initialize();
    const settings = createSettings({ showArchived: true });

    hub.emit('state.settings', settingsState(settings));

    expect(store.settings.value).toEqual(settings);
  });

  it.each([
    ['missing', { timestamp: 2 }],
    ['null', { settings: null, timestamp: 2 }],
  ])('should clear settings when the settings field is %s', async (_label, state) => {
    await store.initialize();
    hub.emit('state.settings', settingsState(createSettings()));

    hub.emit('state.settings', state);

    expect(store.settings.value).toBeNull();
  });

  it('should re-subscribe with archived sessions when showArchived turns on', async () => {
    await store.initialize();
    hub.request.mockClear();

    hub.emit('state.settings', settingsState(createSettings({ showArchived: true })));
    await Promise.resolve();

    expect(subscribeCalls()).toEqual([
      { queryName: 'sessions.list', params: [1], subscriptionId: 'sessions-list' },
    ]);
  });

  it('should not re-subscribe when showArchived is unchanged', async () => {
    await store.initialize();
    hub.request.mockClear();

    hub.emit('state.settings', settingsState(createSettings({ showArchived: false })));
    await Promise.resolve();

    expect(subscribeCalls()).toEqual([]);
  });

  it('should re-subscribe on reconnection', async () => {
    await store.initialize();
    hub.request.mockClear();

    hub.setConnection('connected');

    expect(subscribeCalls()).toEqual([
      { queryName: 'sessions.list', params: [0], subscriptionId: 'sessions-list' },
    ]);
  });

  it('should not re-subscribe on non-connected states', async () => {
    await store.initialize();
    hub.request.mockClear();

    hub.setConnection('disconnected');

    expect(hub.request).not.toHaveBeenCalled();
  });

  it('should swallow a rejected LiveQuery subscription', async () => {
    hub.request.mockImplementation((method: string) =>
      method === 'liveQuery.subscribe'
        ? Promise.reject(new Error('Subscribe failed'))
        : defaultRequest(method)
    );

    await expect(store.initialize()).resolves.toBeUndefined();

    emitSnapshot({ rows: [createMockSession('1')] });
    expect(store.sessions.value).toHaveLength(1);
  });

  it('should stay uninitialized when getHub fails', async () => {
    vi.mocked(connectionManager.getHub).mockRejectedValueOnce(new Error('Network error'));

    await store.initialize();
    await store.refresh();

    expect(hub.request).not.toHaveBeenCalled();
    expect(hub.onEvent).not.toHaveBeenCalled();

    await store.initialize();

    expect(subscribeCalls()).toHaveLength(1);
  });
});

describe('GlobalStore - refresh()', () => {
  let store: GlobalStore;

  beforeEach(() => {
    resetHub();
    store = new GlobalStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should return early if not initialized', async () => {
    await store.refresh();

    expect(connectionManager.getHub).not.toHaveBeenCalled();
    expect(hub.request).not.toHaveBeenCalled();
  });

  it('should re-subscribe to LiveQuery and fetch GLOBAL_SNAPSHOT when initialized', async () => {
    await store.initialize();
    hub.request.mockClear();
    const system = createSystemState();
    const settings = createSettings({ model: 'refreshed' });
    hub.state.snapshot = { system, settings: settingsState(settings) };

    await store.refresh();

    expect(hub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'sessions.list',
      params: [0],
      subscriptionId: 'sessions-list',
    });
    expect(hub.request).toHaveBeenCalledWith('state.global.snapshot', { includeSessions: false });
    expect(store.systemState.value).toEqual(system);
    expect(store.settings.value).toEqual(settings);
  });

  it('should subscribe with archived sessions when showArchived is set', async () => {
    hub.state.snapshot = {
      system: createSystemState(),
      settings: settingsState(createSettings({ showArchived: true })),
    };
    await store.initialize();
    hub.request.mockClear();

    await store.refresh();

    expect(subscribeCalls()).toEqual([
      { queryName: 'sessions.list', params: [1], subscriptionId: 'sessions-list' },
    ]);
  });

  it('should handle GLOBAL_SNAPSHOT with null fields', async () => {
    hub.state.snapshot = {
      system: createSystemState(),
      settings: settingsState(createSettings()),
    };
    await store.initialize();
    hub.state.snapshot = { system: null, settings: null };

    await store.refresh();

    expect(store.systemState.value).toBeNull();
    expect(store.settings.value).toBeNull();
  });

  it('should handle GLOBAL_SNAPSHOT with missing settings field', async () => {
    hub.state.snapshot = { system: createSystemState(), settings: settingsState(createSettings()) };
    await store.initialize();
    hub.state.snapshot = { system: createSystemState() };

    await store.refresh();

    expect(store.systemState.value).toEqual(createSystemState());
    expect(store.settings.value).toBeNull();
  });

  it('should keep state when GLOBAL_SNAPSHOT is empty', async () => {
    const system = createSystemState();
    hub.state.snapshot = { system, settings: settingsState(createSettings()) };
    await store.initialize();
    hub.state.snapshot = null;

    await store.refresh();

    expect(store.systemState.value).toEqual(system);
  });

  it('should handle refresh when LiveQuery subscribe fails', async () => {
    await store.initialize();
    hub.state.snapshot = { system: createSystemState(), settings: null };
    hub.request.mockImplementation((method: string) =>
      method === 'liveQuery.subscribe'
        ? Promise.reject(new Error('Subscribe failed'))
        : defaultRequest(method)
    );

    await expect(store.refresh()).resolves.toBeUndefined();

    expect(store.systemState.value).toEqual(createSystemState());
  });
});

describe('GlobalStore - destroy', () => {
  let store: GlobalStore;

  beforeEach(() => {
    resetHub();
    store = new GlobalStore();
  });

  it('should call every registered unsubscriber exactly once', async () => {
    await store.initialize();
    const unsubscribers: Unsubscribe[] = [...hub.unsubscribers];
    expect(unsubscribers).toHaveLength(6);
    for (const unsub of unsubscribers) expect(unsub).not.toHaveBeenCalled();

    store.destroy();

    for (const unsub of unsubscribers) expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('should clear cleanup functions so a second destroy does not re-run them', async () => {
    await store.initialize();
    const unsubscribers: Unsubscribe[] = [...hub.unsubscribers];

    store.destroy();
    store.destroy();

    for (const unsub of unsubscribers) expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('should stop applying events after destroy', async () => {
    store = await createInitializedStore(createMockSession('1'));

    store.destroy();
    emitDelta({ added: [createMockSession('2')] });
    emitSnapshot({ rows: [] });
    hub.emit('state.system', createSystemState());

    expect(store.sessions.value.map((s) => s.id)).toEqual(['1']);
    expect(store.systemState.value).toBeNull();
  });

  it('should handle cleanup function errors gracefully', async () => {
    await store.initialize();
    const unsubscribers: Unsubscribe[] = [...hub.unsubscribers];
    unsubscribers[1].mockImplementation(() => {
      throw new Error('Cleanup error');
    });

    expect(() => store.destroy()).not.toThrow();

    for (const unsub of unsubscribers) expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('should reset initialized so initialize subscribes again', async () => {
    await store.initialize();
    store.destroy();
    hub.request.mockClear();
    hub.onEvent.mockClear();

    await store.initialize();

    expect(subscribeCalls()).toHaveLength(1);
    expect(hub.onEvent).toHaveBeenCalledTimes(5);
    store.destroy();
  });

  it('should make refresh a no-op after destroy', async () => {
    await store.initialize();
    store.destroy();
    hub.request.mockClear();

    await store.refresh();

    expect(hub.request).not.toHaveBeenCalled();
  });

  it('should call liveQuery.unsubscribe on destroy when connected', async () => {
    await store.initialize();
    hub.request.mockClear();

    store.destroy();

    expect(hub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
      subscriptionId: 'sessions-list',
    });
  });

  it('should swallow a rejected liveQuery.unsubscribe', async () => {
    await store.initialize();
    hub.request.mockRejectedValueOnce(new Error('Unsubscribe failed'));

    expect(() => store.destroy()).not.toThrow();
    await Promise.resolve();
  });

  it('should not call liveQuery.unsubscribe on destroy when not connected', () => {
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValueOnce(null);

    store.destroy();

    expect(hub.request).not.toHaveBeenCalled();
  });
});
