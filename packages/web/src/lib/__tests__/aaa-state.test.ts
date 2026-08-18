// @ts-nocheck

import { signal } from '@preact/signals';
import {
  appState,
  initializeApplicationState,
  mergeSdkMessagesWithDedup,
  sessions,
  hasArchivedSessions,
  systemState,
  authStatus,
  healthStatus,
  apiConnectionStatus,
  globalSettings,
  activeSessions,
  recentSessions,
  isAgentWorking,
  currentAgentState,
  currentContextInfo,
  currentSession,
  connectionState,
} from '../state';
import { globalStore } from '../global-store';

const mockHub = {
  isConnected: vi.fn(() => true),
  subscribe: vi.fn(() => Promise.resolve(() => Promise.resolve())),
  subscribeOptimistic: vi.fn(() => () => {}),
  call: vi.fn(() => Promise.resolve({})),
  request: vi.fn(() => Promise.resolve({})),
  onEvent: vi.fn(() => () => {}),
  joinRoom: vi.fn(),
  leaveRoom: vi.fn(),
  onConnection: vi.fn(() => () => {}),
};

const waitForSessionSwitch = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('ApplicationState', () => {
  let currentSessionId: import('@preact/signals').Signal<string | null>;

  beforeEach(() => {
    mockHub.subscribe.mockReset();
    mockHub.request.mockReset();
    mockHub.onConnection.mockReset();

    mockHub.subscribe.mockImplementation(() => Promise.resolve(() => Promise.resolve()));
    mockHub.request.mockImplementation(() => Promise.resolve({}));
    mockHub.onConnection.mockImplementation(() => () => {});

    currentSessionId = signal(null) as import('@preact/signals').Signal<string | null>;
  });

  afterEach(() => {
    appState.cleanup();
  });

  describe('Subscription Leak Prevention', () => {
    it('should track subscriptions for cleanup', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      currentSessionId.value = 'test-session-1';

      const subscriptions = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions;

      expect(subscriptions.length).toBeGreaterThan(0);
    });

    it('should cleanup subscriptions on cleanup()', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      const subscriptionsBefore = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions;
      const subscriptionCount = subscriptionsBefore.length;

      let unsubscribeCalls = 0;
      subscriptionsBefore.forEach((_, index) => {
        const original = subscriptionsBefore[index];
        subscriptionsBefore[index] = () => {
          unsubscribeCalls++;
          if (original) original();
        };
      });

      appState.cleanup();

      expect(unsubscribeCalls).toBe(subscriptionCount);

      const subscriptionsAfter = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions;
      expect(subscriptionsAfter.length).toBe(0);
    });

    it('should not leak subscriptions on multiple initializations', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );
      appState.cleanup();

      const newSessionId = signal<string | null>(null);
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        newSessionId
      );

      const subscriptions = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions;
      expect(subscriptions.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Session Channel Management', () => {
    it('should auto-load session channels when currentSessionId changes', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      const activeSessionIdBefore = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdBefore).toBeNull();

      currentSessionId.value = 'auto-load-test-session';

      await waitForSessionSwitch();

      const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdAfter).toBe('auto-load-test-session');
    });

    it('should cleanup session channels on cleanupSessionChannels()', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      currentSessionId.value = 'cleanup-test-session';

      await waitForSessionSwitch();

      const activeSessionId = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionId).toBe('cleanup-test-session');

      await appState.cleanupSessionChannels('cleanup-test-session');

      const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdAfter).toBeNull();
    });

    it('should stop all session channels on cleanup()', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      currentSessionId.value = 'session-1';
      currentSessionId.value = 'session-2';
      currentSessionId.value = 'session-3';

      await waitForSessionSwitch();

      const activeSessionIdBefore = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdBefore).toBe('session-3');

      appState.cleanup();

      const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdAfter).toBeNull();
    });
  });

  describe('Initialization State', () => {
    it('should prevent double initialization', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      const initialized = (appState as unknown as { initialized: { value: boolean } }).initialized;
      expect(initialized.value).toBe(true);

      const subscriptionsBefore = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions.length;

      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      const subscriptionsAfter = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions.length;
      expect(subscriptionsAfter).toBe(subscriptionsBefore);
    });

    it('should reset initialized flag on cleanup', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      const initialized = (appState as unknown as { initialized: { value: boolean } }).initialized;
      expect(initialized.value).toBe(true);

      appState.cleanup();

      expect(initialized.value).toBe(false);
    });
  });
});

describe('ApplicationState - Edge Cases', () => {
  let currentSessionId: import('@preact/signals').Signal<string | null>;

  beforeEach(() => {
    currentSessionId = signal(null) as import('@preact/signals').Signal<string | null>;
  });

  afterEach(() => {
    appState.cleanup();
  });

  it('should handle null session ID in auto-load', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    currentSessionId.value = null;

    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBeNull();
  });

  it('should handle rapid session ID changes', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    for (let i = 0; i < 10; i++) {
      currentSessionId.value = `rapid-session-${i}`;
    }

    await waitForSessionSwitch();

    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBe('rapid-session-9');
  });

  it('should create new channels when switching back to a session', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    currentSessionId.value = 'reuse-test';
    await waitForSessionSwitch();

    const channels1 = appState.getSessionChannels('reuse-test');

    currentSessionId.value = 'other-session';
    await waitForSessionSwitch();

    currentSessionId.value = 'reuse-test';
    await waitForSessionSwitch();

    const channels2 = appState.getSessionChannels('reuse-test');

    expect(channels1).not.toBe(channels2);

    expect(channels1).toBeDefined();
    expect(channels2).toBeDefined();
    expect(channels1.session).toBeDefined();
    expect(channels2.session).toBeDefined();
  });

  it('should throw when getSessionChannels called before init', () => {
    expect(() => appState.getSessionChannels('test')).toThrow('State not initialized');
  });
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
describe('ApplicationState - refreshAll', () => {
  let currentSessionId: import('@preact/signals').Signal<string | null>;

  beforeEach(() => {
    mockHub.subscribe.mockReset();
    mockHub.request.mockReset();
    mockHub.onConnection.mockReset();
    mockHub.subscribe.mockImplementation(() => Promise.resolve(() => Promise.resolve()));
    mockHub.request.mockImplementation(() => Promise.resolve({}));
    mockHub.onConnection.mockImplementation(() => () => {});
    currentSessionId = signal(null) as import('@preact/signals').Signal<string | null>;
  });

  afterEach(() => {
    appState.cleanup();
  });

  it('should return early when refreshAll called without initialization', async () => {
    await appState.refreshAll();

    expect(mockHub.request).not.toHaveBeenCalled();
  });

  it('should refresh session channels when initialized', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    currentSessionId.value = 'refresh-test-session';
    await waitForSessionSwitch();

    await appState.refreshAll();

    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBe('refresh-test-session');
  });

  it('should handle refreshAll when no active session channels', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    await appState.refreshAll();

    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBeNull();
  });
});

describe('ApplicationState - Session Channel Switch Error Handling', () => {
  let currentSessionId: import('@preact/signals').Signal<string | null>;

  beforeEach(() => {
    mockHub.subscribe.mockReset();
    mockHub.request.mockReset();
    mockHub.onConnection.mockReset();
    mockHub.subscribe.mockImplementation(() => Promise.resolve(() => Promise.resolve()));
    mockHub.request.mockImplementation(() => Promise.resolve({}));
    mockHub.onConnection.mockImplementation(() => () => {});
    currentSessionId = signal(null) as import('@preact/signals').Signal<string | null>;
  });

  afterEach(() => {
    appState.cleanup();
  });

  it('should log channel switch errors', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    mockHub.subscribe.mockRejectedValueOnce(new Error('Channel start failed'));

    currentSessionId.value = 'error-test-session';
    await waitForSessionSwitch();

    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('should return existing channels when same session requested', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    currentSessionId.value = 'same-session';
    await waitForSessionSwitch();

    const channels1 = appState.getSessionChannels('same-session');
    const channels2 = appState.getSessionChannels('same-session');

    expect(channels1).toBe(channels2);
  });

  it('should cleanupSessionChannels only for matching session', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    currentSessionId.value = 'active-session';
    await waitForSessionSwitch();

    await appState.cleanupSessionChannels('other-session');

    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBe('active-session');
  });
});

describe('mergeSdkMessagesWithDedup', () => {
  const createMessage = (
    uuid: string,
    timestamp: number,
    content = 'test'
  ): Record<string, unknown> => ({
    type: 'assistant',
    uuid,
    timestamp,
    message: { content },
  });

  it('should return existing messages when added is undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [createMessage('a', 100), createMessage('b', 200)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, undefined);
    expect(result).toBe(existing);
  });

  it('should return existing messages when added is empty', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [createMessage('a', 100), createMessage('b', 200)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, []);
    expect(result).toBe(existing);
  });

  it('should append new messages without duplicates', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [createMessage('a', 100), createMessage('b', 200)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [createMessage('c', 300)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, added);

    expect(result).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c']);
  });

  it('should deduplicate messages with same UUID (reconnection bug fix)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [
      createMessage('a', 100),
      createMessage('b', 200),
      createMessage('c', 300),
      createMessage('d', 400),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [createMessage('d', 400, 'duplicate')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, added);

    expect(result).toHaveLength(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should update existing message when duplicate UUID arrives with newer data', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [createMessage('a', 100, 'old content')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [createMessage('a', 100, 'new content')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, added);

    expect(result).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result[0] as any).message.content).toBe('new content');
  });

  it('should maintain chronological order by timestamp', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [createMessage('b', 200), createMessage('d', 400)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [createMessage('a', 100), createMessage('c', 300)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, added);

    expect(result).toHaveLength(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should handle multiple duplicates in single delta', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [createMessage('a', 100), createMessage('b', 200)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [createMessage('a', 100), createMessage('b', 200), createMessage('c', 300)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, added);

    expect(result).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c']);
  });

  it('should handle empty existing messages', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [createMessage('a', 100), createMessage('b', 200)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup([], added);

    expect(result).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b']);
  });
});

describe('Computed Signals', () => {
  beforeEach(() => {
    globalStore.sessions.value = [];
    globalStore.systemState.value = null;
    globalStore.settings.value = null;
  });

  describe('sessions signal', () => {
    it('should reflect globalStore sessions', () => {
      globalStore.sessions.value = [
        {
          id: '1',
          title: 'Session 1',
          status: 'active',
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '2',
          title: 'Session 2',
          status: 'idle',
        } as unknown as import('@hyperneo/shared').Session,
      ];

      expect(sessions.value).toHaveLength(2);
      expect(sessions.value[0].id).toBe('1');
    });
  });

  describe('hasArchivedSessions signal', () => {
    it('should reflect globalStore hasArchivedSessions', () => {
      expect(hasArchivedSessions.value).toBe(false);

      globalStore.sessions.value = [
        {
          id: '1',
          title: 'Active Session',
          status: 'active',
        } as unknown as import('@hyperneo/shared').Session,
      ];
      globalStore.sessionsTotalCount.value = 5;

      expect(hasArchivedSessions.value).toBe(true);
    });
  });

  describe('systemState signal', () => {
    it('should reflect globalStore systemState', () => {
      expect(systemState.value).toBeNull();

      const mockSystemState = {
        auth: { method: 'api-key' as const, hasCredentials: true },
        health: { healthy: true, lastCheck: Date.now() },
        apiConnection: { status: 'connected' as const },
      };
      globalStore.systemState.value = mockSystemState;

      expect(systemState.value).toBe(mockSystemState);
    });
  });

  describe('authStatus signal', () => {
    it('should return null when systemState is null', () => {
      globalStore.systemState.value = null;
      expect(authStatus.value).toBeNull();
    });

    it('should return auth from systemState', () => {
      const mockAuth = { method: 'api-key' as const, hasCredentials: true };
      globalStore.systemState.value = {
        auth: mockAuth,
        health: { healthy: true, lastCheck: Date.now() },
        apiConnection: { status: 'connected' as const },
      };

      expect(authStatus.value).toBe(mockAuth);
    });
  });

  describe('healthStatus signal', () => {
    it('should return null when systemState is null', () => {
      globalStore.systemState.value = null;
      expect(healthStatus.value).toBeNull();
    });

    it('should return health from systemState', () => {
      const mockHealth = { healthy: true, lastCheck: Date.now() };
      globalStore.systemState.value = {
        auth: { method: 'api-key' as const, hasCredentials: true },
        health: mockHealth,
        apiConnection: { status: 'connected' as const },
      };

      expect(healthStatus.value).toBe(mockHealth);
    });
  });

  describe('apiConnectionStatus signal', () => {
    it('should return null when systemState is null', () => {
      globalStore.systemState.value = null;
      expect(apiConnectionStatus.value).toBeNull();
    });

    it('should return apiConnection from systemState', () => {
      const mockApiConnection = { status: 'connected' as const };
      globalStore.systemState.value = {
        auth: { method: 'api-key' as const, hasCredentials: true },
        health: { healthy: true, lastCheck: Date.now() },
        apiConnection: mockApiConnection,
      };

      expect(apiConnectionStatus.value).toBe(mockApiConnection);
    });
  });

  describe('globalSettings signal', () => {
    it('should return null when settings is null', () => {
      globalStore.settings.value = null;
      expect(globalSettings.value).toBeNull();
    });

    it('should return settings from globalStore', () => {
      const mockSettings = { theme: 'dark' };
      globalStore.settings.value =
        mockSettings as unknown as import('@hyperneo/shared').GlobalSettings;

      expect(globalSettings.value).toBe(mockSettings);
    });
  });

  describe('activeSessions signal', () => {
    it('should return 0 when no sessions', () => {
      globalStore.sessions.value = [];
      expect(activeSessions.value).toBe(0);
    });

    it('should count only active sessions', () => {
      globalStore.sessions.value = [
        { id: '1', status: 'active' } as unknown as import('@hyperneo/shared').Session,
        { id: '2', status: 'idle' } as unknown as import('@hyperneo/shared').Session,
        { id: '3', status: 'active' } as unknown as import('@hyperneo/shared').Session,
        { id: '4', status: 'archived' } as unknown as import('@hyperneo/shared').Session,
      ];

      expect(activeSessions.value).toBe(2);
    });
  });

  describe('recentSessions signal', () => {
    it('should return empty array when no sessions', () => {
      globalStore.sessions.value = [];
      expect(recentSessions.value).toHaveLength(0);
    });

    it('should return max 5 sessions sorted by lastActiveAt', () => {
      const now = Date.now();
      globalStore.sessions.value = [
        {
          id: '1',
          lastActiveAt: new Date(now - 1000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '2',
          lastActiveAt: new Date(now - 5000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '3',
          lastActiveAt: new Date(now).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '4',
          lastActiveAt: new Date(now - 2000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '5',
          lastActiveAt: new Date(now - 3000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '6',
          lastActiveAt: new Date(now - 4000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '7',
          lastActiveAt: new Date(now - 6000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
      ];

      const recent = recentSessions.value;
      expect(recent).toHaveLength(5);
      expect(recent.map((s) => s.id)).toEqual(['3', '1', '4', '5', '6']);
    });

    it('should not mutate the source sessions array', () => {
      const now = Date.now();
      const source = [
        {
          id: '1',
          lastActiveAt: new Date(now - 1000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '2',
          lastActiveAt: new Date(now - 5000).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
        {
          id: '3',
          lastActiveAt: new Date(now).toISOString(),
        } as unknown as import('@hyperneo/shared').Session,
      ];
      globalStore.sessions.value = source;

      const _ = recentSessions.value;

      expect(source.map((s) => s.id)).toEqual(['1', '2', '3']);
      expect(globalStore.sessions.value.map((s) => s.id)).toEqual(['1', '2', '3']);
      expect(sessions.value.map((s) => s.id)).toEqual(['1', '2', '3']);
    });
  });

  describe('isAgentWorking signal', () => {
    it('should return false when currentAgentState is idle', async () => {
      const sessionId = signal<string | null>(null);
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        sessionId
      );

      expect(isAgentWorking.value).toBe(false);

      appState.cleanup();
    });
  });

  describe('currentAgentState signal', () => {
    it('should return idle when no session is active', async () => {
      const sessionId = signal<string | null>(null);
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        sessionId
      );

      expect(currentAgentState.value).toEqual({ status: 'idle' });

      appState.cleanup();
    });
  });

  describe('currentContextInfo signal', () => {
    it('should return null when no session is active', async () => {
      const sessionId = signal<string | null>(null);
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        sessionId
      );

      expect(currentContextInfo.value).toBeNull();

      appState.cleanup();
    });
  });

  describe('currentSession signal', () => {
    it('should return null when no session is active', async () => {
      const sessionId = signal<string | null>(null);
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        sessionId
      );

      expect(currentSession.value).toBeNull();

      appState.cleanup();
    });
  });

  describe('connectionState signal', () => {
    it('should be a signal with default value', () => {
      expect(connectionState.value).toBeDefined();
    });

    it('should accept valid connection states', () => {
      connectionState.value = 'connecting';
      expect(connectionState.value).toBe('connecting');

      connectionState.value = 'connected';
      expect(connectionState.value).toBe('connected');

      connectionState.value = 'disconnected';
      expect(connectionState.value).toBe('disconnected');

      connectionState.value = 'reconnecting';
      expect(connectionState.value).toBe('reconnecting');

      connectionState.value = 'failed';
      expect(connectionState.value).toBe('failed');

      connectionState.value = 'error';
      expect(connectionState.value).toBe('error');
    });
  });
});
