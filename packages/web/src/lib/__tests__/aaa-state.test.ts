// @ts-nocheck
/**
 * Tests for Application State Management
 *
 * Tests signal subscription leak fixes and state channel management.
 *
 * IMPORTANT: This file does NOT use mock.module() for StateChannel because:
 * 1. mock.module() affects the global module cache
 * 2. Bun runs test files in parallel
 * 3. Other tests (like aaa-reconnection-safari.test.ts) need the REAL StateChannel
 * 4. mock.restore() in afterAll doesn't help when tests run concurrently
 *
 * Instead, we mock at the MessageHub level, which is sufficient for testing
 * ApplicationState behavior without polluting the module cache.
 */

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

// Mock MessageHub - this is passed to initializeApplicationState and used by StateChannel
// No need for mock.module - we just pass this mock directly
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

// Helper to wait for debounced session switching (150ms debounce + buffer)
const waitForSessionSwitch = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('ApplicationState', () => {
  let currentSessionId: import('@preact/signals').Signal<string | null>;

  beforeEach(() => {
    // Reset MessageHub mocks
    mockHub.subscribe.mockReset();
    mockHub.request.mockReset();
    mockHub.onConnection.mockReset();

    // Restore default mock implementations
    mockHub.subscribe.mockImplementation(() => Promise.resolve(() => Promise.resolve()));
    mockHub.request.mockImplementation(() => Promise.resolve({}));
    mockHub.onConnection.mockImplementation(() => () => {});

    // Create fresh session ID signal for each test with explicit type
    currentSessionId = signal(null) as import('@preact/signals').Signal<string | null>;
  });

  afterEach(() => {
    // Cleanup state after each test
    appState.cleanup();
  });

  describe('Subscription Leak Prevention', () => {
    it('should track subscriptions for cleanup', async () => {
      // Initialize state
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      // Trigger a session change to create subscription
      currentSessionId.value = 'test-session-1';

      // Access private subscriptions array via reflection
      const subscriptions = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions;

      // Should have at least one subscription (from setupCurrentSessionAutoLoad)
      expect(subscriptions.length).toBeGreaterThan(0);
    });

    it('should cleanup subscriptions on cleanup()', async () => {
      // Initialize state
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      // Get subscriptions before cleanup
      const subscriptionsBefore = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions;
      const subscriptionCount = subscriptionsBefore.length;

      // Track unsubscribe calls
      let unsubscribeCalls = 0;
      subscriptionsBefore.forEach((_, index) => {
        const original = subscriptionsBefore[index];
        subscriptionsBefore[index] = () => {
          unsubscribeCalls++;
          if (original) original();
        };
      });

      // Cleanup
      appState.cleanup();

      // Verify subscriptions were called
      expect(unsubscribeCalls).toBe(subscriptionCount);

      // Verify subscriptions array is cleared
      const subscriptionsAfter = (appState as unknown as { subscriptions: Array<() => void> })
        .subscriptions;
      expect(subscriptionsAfter.length).toBe(0);
    });

    it('should not leak subscriptions on multiple initializations', async () => {
      // Initialize, cleanup, re-initialize pattern
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );
      appState.cleanup();

      // Create fresh signal for second initialization
      const newSessionId = signal<string | null>(null);
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        newSessionId
      );

      // Should not have accumulated subscriptions
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

      // Initially no active session
      const activeSessionIdBefore = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdBefore).toBeNull();

      // Change session ID
      currentSessionId.value = 'auto-load-test-session';

      // Wait for debounced session switch to complete
      await waitForSessionSwitch();

      // Should have set the active session
      const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdAfter).toBe('auto-load-test-session');
    });

    it('should cleanup session channels on cleanupSessionChannels()', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      // Create channels for a session
      currentSessionId.value = 'cleanup-test-session';

      // Wait for debounced session switch to complete
      await waitForSessionSwitch();

      const activeSessionId = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionId).toBe('cleanup-test-session');

      // Cleanup specific session
      await appState.cleanupSessionChannels('cleanup-test-session');

      // Should be removed
      const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdAfter).toBeNull();
    });

    it('should stop all session channels on cleanup()', async () => {
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      // Create multiple sessions (only last one is active due to single-session invariant)
      currentSessionId.value = 'session-1';
      currentSessionId.value = 'session-2';
      currentSessionId.value = 'session-3';

      // Wait for debounced session switch to complete
      await waitForSessionSwitch();

      // Only the current session has channels (single-session invariant)
      const activeSessionIdBefore = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdBefore).toBe('session-3');

      // Cleanup all
      appState.cleanup();

      // All should be cleared
      const activeSessionIdAfter = (appState as unknown as { activeSessionId: string | null })
        .activeSessionId;
      expect(activeSessionIdAfter).toBeNull();
    });
  });

  // NOTE: Global state channels tests removed - global state is now managed by globalStore

  describe('Initialization State', () => {
    it('should prevent double initialization', async () => {
      // First initialization
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        currentSessionId
      );

      // Access private initialized signal
      const initialized = (appState as unknown as { initialized: { value: boolean } }).initialized;
      expect(initialized.value).toBe(true);

      // Try to initialize again - should be a no-op (no error, no extra subscriptions)
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

      // Access private initialized signal
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

    // Set to null (should not throw)
    currentSessionId.value = null;

    // No active session should be set
    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBeNull();
  });

  it('should handle rapid session ID changes', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    // Rapid changes
    for (let i = 0; i < 10; i++) {
      currentSessionId.value = `rapid-session-${i}`;
    }

    // Wait for debounced session switch to complete
    await waitForSessionSwitch();

    // Only the last session has channels (single-session invariant + debounce)
    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBe('rapid-session-9');
  });

  it('should create new channels when switching back to a session', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    // Set session
    currentSessionId.value = 'reuse-test';
    await waitForSessionSwitch();

    const channels1 = appState.getSessionChannels('reuse-test');

    // Switch away (this will cleanup 'reuse-test' channels after debounce)
    currentSessionId.value = 'other-session';
    await waitForSessionSwitch();

    // Switch back (this will create new channels)
    currentSessionId.value = 'reuse-test';
    await waitForSessionSwitch();

    const channels2 = appState.getSessionChannels('reuse-test');

    // After cleanup on switch fix: channels are recreated, not reused
    expect(channels1).not.toBe(channels2);

    // But both should be valid channel instances
    expect(channels1).toBeDefined();
    expect(channels2).toBeDefined();
    expect(channels1.session).toBeDefined();
    expect(channels2.session).toBeDefined();
  });

  it('should throw when getSessionChannels called before init', () => {
    // Don't initialize - should throw
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
    // Don't initialize - call refreshAll (should not throw)
    await appState.refreshAll();

    // Verify no hub calls were made since we're not initialized
    expect(mockHub.request).not.toHaveBeenCalled();
  });

  it('should refresh session channels when initialized', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    // Set up a session
    currentSessionId.value = 'refresh-test-session';
    await waitForSessionSwitch();

    // Call refreshAll - should not throw
    await appState.refreshAll();

    // Verify the session channels exist after refresh
    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBe('refresh-test-session');
  });

  it('should handle refreshAll when no active session channels', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    // Don't set a session - no active channels

    // Call refreshAll - should not throw
    await appState.refreshAll();

    // Verify no active session is set
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

    // Make subscribe throw an error
    mockHub.subscribe.mockRejectedValueOnce(new Error('Channel start failed'));

    // Get channels - this will start the async switch
    currentSessionId.value = 'error-test-session';
    await waitForSessionSwitch();

    // Wait a bit more for the async error handler
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Error should be handled gracefully (caught by .catch)
  });

  it('should return existing channels when same session requested', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    // Set session and wait
    currentSessionId.value = 'same-session';
    await waitForSessionSwitch();

    const channels1 = appState.getSessionChannels('same-session');
    const channels2 = appState.getSessionChannels('same-session');

    // Should return the same instance
    expect(channels1).toBe(channels2);
  });

  it('should cleanupSessionChannels only for matching session', async () => {
    await initializeApplicationState(
      mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
      currentSessionId
    );

    // Set up a session
    currentSessionId.value = 'active-session';
    await waitForSessionSwitch();

    // Try to cleanup a different session (should be a no-op)
    await appState.cleanupSessionChannels('other-session');

    // Active session should still be set
    const activeSessionId = (appState as unknown as { activeSessionId: string | null })
      .activeSessionId;
    expect(activeSessionId).toBe('active-session');
  });
});

describe('mergeSdkMessagesWithDedup', () => {
  // Helper to create a mock SDK message with uuid and timestamp
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
    // Scenario: Snapshot contains [A, B, C, D], then delta arrives with D again
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [
      createMessage('a', 100),
      createMessage('b', 200),
      createMessage('c', 300),
      createMessage('d', 400),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [createMessage('d', 400, 'duplicate')]; // Same UUID as existing 'd'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mergeSdkMessagesWithDedup(existing, added);

    // Should NOT have duplicate - only 4 messages, not 5
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
    // Added message should overwrite existing (takes precedence)
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
    // Should be sorted by timestamp, not insertion order
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((m: any) => m.uuid)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should handle multiple duplicates in single delta', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = [createMessage('a', 100), createMessage('b', 200)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const added: any = [
      createMessage('a', 100), // duplicate
      createMessage('b', 200), // duplicate
      createMessage('c', 300), // new
    ];
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
    // Reset global store state for each test
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
        } as unknown as import('@neokai/shared').Session,
        {
          id: '2',
          title: 'Session 2',
          status: 'idle',
        } as unknown as import('@neokai/shared').Session,
      ];

      expect(sessions.value).toHaveLength(2);
      expect(sessions.value[0].id).toBe('1');
    });
  });

  describe('hasArchivedSessions signal', () => {
    it('should reflect globalStore hasArchivedSessions', () => {
      // hasArchivedSessions is now a computed derived from sessionsTotalCount > sessions.length
      expect(hasArchivedSessions.value).toBe(false);

      // Set totalCount greater than visible sessions to indicate archived sessions exist
      globalStore.sessions.value = [
        {
          id: '1',
          title: 'Active Session',
          status: 'active',
        } as unknown as import('@neokai/shared').Session,
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
        mockSettings as unknown as import('@neokai/shared').GlobalSettings;

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
        { id: '1', status: 'active' } as unknown as import('@neokai/shared').Session,
        { id: '2', status: 'idle' } as unknown as import('@neokai/shared').Session,
        { id: '3', status: 'active' } as unknown as import('@neokai/shared').Session,
        { id: '4', status: 'archived' } as unknown as import('@neokai/shared').Session,
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
        } as unknown as import('@neokai/shared').Session,
        {
          id: '2',
          lastActiveAt: new Date(now - 5000).toISOString(),
        } as unknown as import('@neokai/shared').Session,
        {
          id: '3',
          lastActiveAt: new Date(now).toISOString(),
        } as unknown as import('@neokai/shared').Session,
        {
          id: '4',
          lastActiveAt: new Date(now - 2000).toISOString(),
        } as unknown as import('@neokai/shared').Session,
        {
          id: '5',
          lastActiveAt: new Date(now - 3000).toISOString(),
        } as unknown as import('@neokai/shared').Session,
        {
          id: '6',
          lastActiveAt: new Date(now - 4000).toISOString(),
        } as unknown as import('@neokai/shared').Session,
        {
          id: '7',
          lastActiveAt: new Date(now - 6000).toISOString(),
        } as unknown as import('@neokai/shared').Session,
      ];

      const recent = recentSessions.value;
      expect(recent).toHaveLength(5);
      expect(recent.map((s) => s.id)).toEqual(['3', '1', '4', '5', '6']);
    });
  });

  describe('isAgentWorking signal', () => {
    it('should return false when currentAgentState is idle', async () => {
      // Need to initialize state first to access session-related signals
      const sessionId = signal<string | null>(null);
      await initializeApplicationState(
        mockHub as unknown as Parameters<typeof initializeApplicationState>[0],
        sessionId
      );

      // When no session is active, currentAgentState defaults to idle
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
      // connectionState is exported directly
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
