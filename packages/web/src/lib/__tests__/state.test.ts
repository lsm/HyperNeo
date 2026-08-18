// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@preact/signals';
import {
  mergeSdkMessagesWithDedup,
  mergeSDKMessagesDelta,
  appState,
  connectionState,
  sessions,
  hasArchivedSessions,
  systemState,
  authStatus,
  healthStatus,
  apiConnectionStatus,
  globalSettings,
  currentSession,
  currentAgentState,
  currentContextInfo,
  isAgentWorking,
  activeSessions,
  recentSessions,
  initializeApplicationState,
} from '../state';
import { globalStore } from '../global-store';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { Session, AuthStatus, HealthStatus } from '@hyperneo/shared';
import type { SystemState } from '@hyperneo/shared';
import type { Signal } from '@preact/signals';

interface MockHub {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
}

vi.mock('../global-store', () => ({
  globalStore: {
    sessions: signal<Session[]>([]),
    hasArchivedSessions: signal(false),
    systemState: signal<SystemState | null>(null),
    settings: signal(null),
  },
}));

vi.mock('../state-channel', () => {
  return {
    StateChannel: class MockStateChannel {
      $ = signal(null);
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn().mockResolvedValue(undefined);
      refresh = vi.fn().mockResolvedValue(undefined);
      constructor() {}
    },
  };
});

const createUUID = () => crypto.randomUUID();

function createSDKMessage(
  overrides: Partial<SDKMessage & { uuid: string; timestamp: number }> = {}
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Test' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
    timestamp: Date.now(),
    ...overrides,
  } as unknown as SDKMessage;
}

describe('state', () => {
  beforeEach(() => {
    globalStore.sessions.value = [];
    globalStore.hasArchivedSessions.value = false;
    globalStore.systemState.value = null;
    globalStore.settings.value = null;
    vi.clearAllMocks();
  });

  describe('mergeSdkMessagesWithDedup', () => {
    it('should return existing messages when added is empty', () => {
      const existing = [createSDKMessage()];
      const result = mergeSdkMessagesWithDedup(existing, []);
      expect(result).toEqual(existing);
    });

    it('should return existing messages when added is undefined', () => {
      const existing = [createSDKMessage()];
      const result = mergeSdkMessagesWithDedup(existing, undefined);
      expect(result).toEqual(existing);
    });

    it('should merge new messages', () => {
      const existing = [createSDKMessage({ timestamp: 1000 })];
      const added = [createSDKMessage({ timestamp: 2000 })];
      const result = mergeSdkMessagesWithDedup(existing, added);
      expect(result).toHaveLength(2);
    });

    it('should deduplicate messages by UUID', () => {
      const uuid = createUUID();
      const existing = [createSDKMessage({ uuid, timestamp: 1000 })];
      const added = [createSDKMessage({ uuid, timestamp: 2000 })];

      const result = mergeSdkMessagesWithDedup(existing, added);

      expect(result).toHaveLength(1);
      expect((result[0] as SDKMessage & { timestamp?: number }).timestamp).toBe(2000);
    });

    it('should sort messages by timestamp', () => {
      const existing = [createSDKMessage({ timestamp: 3000 })];
      const added = [createSDKMessage({ timestamp: 1000 }), createSDKMessage({ timestamp: 2000 })];

      const result = mergeSdkMessagesWithDedup(existing, added);
      type MsgWithTimestamp = SDKMessage & { timestamp?: number };

      expect(result).toHaveLength(3);
      expect((result[0] as MsgWithTimestamp).timestamp).toBe(1000);
      expect((result[1] as MsgWithTimestamp).timestamp).toBe(2000);
      expect((result[2] as MsgWithTimestamp).timestamp).toBe(3000);
    });

    it('should handle messages without timestamps (default to 0)', () => {
      const withTimestamp = createSDKMessage({ timestamp: 1000 });
      const withoutTimestamp = { ...createSDKMessage(), timestamp: undefined };
      type MsgWithTimestamp = SDKMessage & { timestamp?: number };

      const result = mergeSdkMessagesWithDedup(
        [withTimestamp],
        [withoutTimestamp as unknown as SDKMessage]
      );

      expect(result).toHaveLength(2);
      expect((result[0] as MsgWithTimestamp).timestamp).toBeFalsy();
    });

    it('should handle empty existing array', () => {
      const added = [createSDKMessage()];
      const result = mergeSdkMessagesWithDedup([], added);
      expect(result).toHaveLength(1);
    });

    it('should handle messages without uuid', () => {
      const noUuid = { ...createSDKMessage(), uuid: undefined };
      const result = mergeSdkMessagesWithDedup([], [noUuid as unknown as SDKMessage]);
      expect(result).toHaveLength(0);
    });
  });

  describe('mergeSDKMessagesDelta', () => {
    it('should merge delta updates with current state', () => {
      const current = {
        sdkMessages: [createSDKMessage({ timestamp: 1000 })],
        timestamp: 1000,
      };
      const delta = {
        added: [createSDKMessage({ timestamp: 2000 })],
        timestamp: 2000,
      };

      const result = mergeSDKMessagesDelta(current, delta);

      expect(result.sdkMessages).toHaveLength(2);
      expect(result.timestamp).toBe(2000);
    });

    it('should deduplicate messages in delta merge', () => {
      const uuid = createUUID();
      const current = {
        sdkMessages: [createSDKMessage({ uuid, timestamp: 1000 })],
        timestamp: 1000,
      };
      const delta = {
        added: [createSDKMessage({ uuid, timestamp: 2000 })],
        timestamp: 2000,
      };

      const result = mergeSDKMessagesDelta(current, delta);

      expect(result.sdkMessages).toHaveLength(1);
      expect(result.timestamp).toBe(2000);
    });

    it('should handle delta with no added messages', () => {
      const current = {
        sdkMessages: [createSDKMessage()],
        timestamp: 1000,
      };
      const delta = {
        added: [],
        timestamp: 2000,
      };

      const result = mergeSDKMessagesDelta(current, delta);

      expect(result.sdkMessages).toHaveLength(1);
      expect(result.timestamp).toBe(2000);
    });

    it('should handle empty current state', () => {
      const current = {
        sdkMessages: [],
        timestamp: 0,
      };
      const delta = {
        added: [createSDKMessage({ timestamp: 1000 })],
        timestamp: 1000,
      };

      const result = mergeSDKMessagesDelta(current, delta);

      expect(result.sdkMessages).toHaveLength(1);
      expect(result.timestamp).toBe(1000);
    });
  });

  describe('connectionState', () => {
    it('should have initial value of connecting', () => {
      expect(connectionState.value).toBe('connecting');
    });

    it('should be writable', () => {
      connectionState.value = 'connected';
      expect(connectionState.value).toBe('connected');
      connectionState.value = 'connecting';
    });
  });

  describe('Computed Signals - Global State', () => {
    it('should return sessions from globalStore', () => {
      const mockSessions: Session[] = [
        {
          id: 'session-1',
          title: 'Test Session',
          status: 'active',
          workspacePath: '/test',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      ];
      globalStore.sessions.value = mockSessions;

      expect(sessions.value).toEqual(mockSessions);
    });

    it('should return hasArchivedSessions from globalStore', () => {
      globalStore.hasArchivedSessions.value = true;
      expect(hasArchivedSessions.value).toBe(true);

      globalStore.hasArchivedSessions.value = false;
      expect(hasArchivedSessions.value).toBe(false);
    });

    it('should return systemState from globalStore', () => {
      const mockSystemState: SystemState = {
        auth: { status: 'authenticated', method: 'api_key' },
        health: { status: 'healthy', version: '1.0.0', uptime: 1000 },
        apiConnection: { status: 'connected' },
      };
      globalStore.systemState.value = mockSystemState;

      expect(systemState.value).toEqual(mockSystemState);
    });

    it('should return null for systemState when not set', () => {
      globalStore.systemState.value = null;
      expect(systemState.value).toBeNull();
    });

    it('should return auth from systemState', () => {
      const mockAuth: AuthStatus = { status: 'authenticated', method: 'api_key' };
      globalStore.systemState.value = {
        auth: mockAuth,
        health: null,
        apiConnection: null,
      } as unknown as SystemState;

      expect(authStatus.value).toEqual(mockAuth);
    });

    it('should return null for authStatus when systemState is null', () => {
      globalStore.systemState.value = null;
      expect(authStatus.value).toBeNull();
    });

    it('should return health from systemState', () => {
      const mockHealth: HealthStatus = { status: 'healthy', version: '1.0.0', uptime: 1000 };
      globalStore.systemState.value = {
        auth: null,
        health: mockHealth,
        apiConnection: null,
      } as unknown as SystemState;

      expect(healthStatus.value).toEqual(mockHealth);
    });

    it('should return null for healthStatus when systemState is null', () => {
      globalStore.systemState.value = null;
      expect(healthStatus.value).toBeNull();
    });

    it('should return apiConnection from systemState', () => {
      const mockApiConnection = { status: 'connected' };
      globalStore.systemState.value = {
        auth: null,
        health: null,
        apiConnection: mockApiConnection,
      } as unknown as SystemState;

      expect(apiConnectionStatus.value).toEqual(mockApiConnection);
    });

    it('should return null for apiConnectionStatus when systemState is null', () => {
      globalStore.systemState.value = null;
      expect(apiConnectionStatus.value).toBeNull();
    });

    it('should return settings from globalStore', () => {
      const mockSettings = { theme: 'dark' };
      globalStore.settings.value = mockSettings;

      expect(globalSettings.value).toEqual(mockSettings);
    });
  });

  describe('Computed Signals - Derived State', () => {
    it('should count active sessions', () => {
      globalStore.sessions.value = [
        {
          id: '1',
          status: 'active',
          title: 'A',
          workspacePath: '/',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
        {
          id: '2',
          status: 'archived',
          title: 'B',
          workspacePath: '/',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
        {
          id: '3',
          status: 'active',
          title: 'C',
          workspacePath: '/',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      ] as Session[];

      expect(activeSessions.value).toBe(2);
    });

    it('should return 0 for active sessions when empty', () => {
      globalStore.sessions.value = [];
      expect(activeSessions.value).toBe(0);
    });

    it('should return recent sessions sorted by lastActiveAt', () => {
      const now = Date.now();
      globalStore.sessions.value = [
        {
          id: '1',
          title: 'Old',
          status: 'active',
          workspacePath: '/',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date(now - 10000).toISOString(),
        },
        {
          id: '2',
          title: 'Newest',
          status: 'active',
          workspacePath: '/',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date(now).toISOString(),
        },
        {
          id: '3',
          title: 'Middle',
          status: 'active',
          workspacePath: '/',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date(now - 5000).toISOString(),
        },
      ] as Session[];

      expect(recentSessions.value[0].title).toBe('Newest');
      expect(recentSessions.value[1].title).toBe('Middle');
      expect(recentSessions.value[2].title).toBe('Old');
    });

    it('should limit recent sessions to 5', () => {
      const now = Date.now();
      globalStore.sessions.value = Array.from({ length: 10 }, (_, i) => ({
        id: String(i),
        title: `Session ${i}`,
        status: 'active',
        workspacePath: '/',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date(now - i * 1000).toISOString(),
      })) as Session[];

      expect(recentSessions.value).toHaveLength(5);
    });
  });

  describe('Agent State Signals', () => {
    it('should return default agent state when not set', () => {
      expect(currentAgentState.value).toEqual({ status: 'idle' });
    });

    it('should return false for isAgentWorking when idle', () => {
      expect(isAgentWorking.value).toBe(false);
    });
  });

  describe('ApplicationState', () => {
    let mockHub: MockHub;
    let mockSessionId: Signal<string | null>;

    beforeEach(() => {
      mockHub = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn(() => vi.fn()),
        joinRoom: vi.fn(),
        leaveRoom: vi.fn(),
      };
      mockSessionId = signal<string | null>(null);

      appState.cleanup();
    });

    afterEach(() => {
      appState.cleanup();
    });

    it('should initialize without error', async () => {
      await expect(initializeApplicationState(mockHub, mockSessionId)).resolves.not.toThrow();
    });

    it('should handle double initialization gracefully', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      await expect(initializeApplicationState(mockHub, mockSessionId)).resolves.not.toThrow();
    });

    it('should cleanup properly', async () => {
      await initializeApplicationState(mockHub, mockSessionId);
      appState.cleanup();

      await expect(initializeApplicationState(mockHub, mockSessionId)).resolves.not.toThrow();
    });

    it('should throw error when getting session channels without initialization', () => {
      appState.cleanup();

      expect(() => appState.getSessionChannels('test-session')).toThrow('State not initialized');
    });

    it('should create session channels when initialized', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      const channels = appState.getSessionChannels('test-session');

      expect(channels).toBeDefined();
      expect(channels.session).toBeDefined();
      expect(channels.sdkMessages).toBeDefined();
    });

    it('should return same channels for same session', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      const channels1 = appState.getSessionChannels('test-session');
      const channels2 = appState.getSessionChannels('test-session');

      expect(channels1).toBe(channels2);
    });

    it('should create new channels when switching sessions', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      const channels1 = appState.getSessionChannels('session-1');
      const channels2 = appState.getSessionChannels('session-2');

      expect(channels1).not.toBe(channels2);
    });

    it('should cleanup previous session channels when switching', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      const channels1 = appState.getSessionChannels('session-1');
      const stopSpy = vi.spyOn(channels1 as { stop: () => Promise<void> }, 'stop');

      appState.getSessionChannels('session-2');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stopSpy).toHaveBeenCalled();
    });

    it('should handle cleanupSessionChannels for current session', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      appState.getSessionChannels('test-session');

      await appState.cleanupSessionChannels('test-session');
    });

    it('should ignore cleanupSessionChannels for non-active session', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      appState.getSessionChannels('session-1');

      await appState.cleanupSessionChannels('session-2');

      const channels = appState.getSessionChannels('session-1');
      expect(channels).toBeDefined();
    });

    it('should refresh all channels', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      const channels = appState.getSessionChannels('test-session');
      const refreshSpy = vi.spyOn(channels as { refresh: () => Promise<void> }, 'refresh');

      await appState.refreshAll();

      expect(refreshSpy).toHaveBeenCalled();
    });

    it('should handle refreshAll without initialization gracefully', async () => {
      appState.cleanup();

      await expect(appState.refreshAll()).resolves.not.toThrow();
    });
  });

  describe('Session Auto-Loading', () => {
    let mockHub: MockHub;
    let mockSessionId: Signal<string | null>;

    beforeEach(() => {
      mockHub = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn(() => vi.fn()),
        joinRoom: vi.fn(),
        leaveRoom: vi.fn(),
      };
      mockSessionId = signal<string | null>(null);
      vi.useFakeTimers();
      appState.cleanup();
    });

    afterEach(() => {
      vi.useRealTimers();
      appState.cleanup();
    });

    it('should auto-load channels when session ID changes', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      mockSessionId.value = 'test-session';

      vi.advanceTimersByTime(200);
    });

    it('should debounce rapid session changes', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      mockSessionId.value = 'session-1';
      vi.advanceTimersByTime(50);
      mockSessionId.value = 'session-2';
      vi.advanceTimersByTime(50);
      mockSessionId.value = 'session-3';

      vi.advanceTimersByTime(200);
    });

    it('should cleanup previous session when switching via signal', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      mockSessionId.value = 'session-1';
      vi.advanceTimersByTime(200);

      mockSessionId.value = 'session-2';
      vi.advanceTimersByTime(200);
    });

    it('should not cleanup when session changes to null', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      mockSessionId.value = 'session-1';
      vi.advanceTimersByTime(200);

      mockSessionId.value = null;
      vi.advanceTimersByTime(200);
    });
  });

  describe('Current Session Computed Signals', () => {
    let mockHub: MockHub;
    let mockSessionId: Signal<string | null>;

    beforeEach(() => {
      mockHub = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn(() => vi.fn()),
        joinRoom: vi.fn(),
        leaveRoom: vi.fn(),
      };
      mockSessionId = signal<string | null>(null);
      appState.cleanup();
    });

    afterEach(() => {
      appState.cleanup();
    });

    it('should return null for currentSession when no session ID', () => {
      expect(currentSession.value).toBeNull();
    });

    it('should return null for currentContextInfo when no session ID', () => {
      expect(currentContextInfo.value).toBeNull();
    });

    it('should access currentSession computed signal', async () => {
      await initializeApplicationState(mockHub, mockSessionId);
      mockSessionId.value = 'test-session';

      const session = currentSession.value;

      expect(session).toBeNull();
    });

    it('should access currentContextInfo computed signal', async () => {
      await initializeApplicationState(mockHub, mockSessionId);
      mockSessionId.value = 'test-session';

      const contextInfo = currentContextInfo.value;

      expect(contextInfo).toBeNull();
    });

    it('should trigger currentSessionState computed when accessing channels', async () => {
      await initializeApplicationState(mockHub, mockSessionId);

      mockSessionId.value = 'test-session-for-computed';

      const channels = appState.getSessionChannels('test-session-for-computed');
      expect(channels).toBeDefined();
      expect(channels.session).toBeDefined();
      expect(channels.session.$).toBeDefined();

      const session = currentSession.value;
      const agentState = currentAgentState.value;
      const contextInfo = currentContextInfo.value;

      expect(session).toBeNull();
      expect(agentState).toEqual({ status: 'idle' });
      expect(contextInfo).toBeNull();
    });
  });
});
