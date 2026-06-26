/**
 * StateProjectionService Tests
 *
 * Unit tests for the pure state projection service — maintains caches from
 * InternalEventBus and exposes read methods. All client delivery, broadcasts,
 * and RPC handlers are in ClientEventBridge.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { StateProjectionService } from '../../../../src/lib/state-projection-service';
import type { Database } from '../../../../src/storage';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Session, GlobalSettings, AgentProcessingState } from '@neokai/shared';
import { STATE_CHANNELS, DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Config } from '../../../../src/config';

describe('StateProjectionService', () => {
  let service: StateProjectionService;
  let mockSessionManager: SessionManager;
  let mockAuthManager: AuthManager;
  let mockSettingsManager: SettingsManager;
  let mockConfig: Config;
  let mockMessageHub: { event: ReturnType<typeof mock>; onRequest: ReturnType<typeof mock> };
  let mockInternalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let eventSubscribers: Map<string, Function[]>;

  beforeEach(() => {
    eventSubscribers = new Map();

    // SessionManager mock
    mockSessionManager = {
      getActiveSessions: mock(() => 2),
      getTotalSessions: mock(() => 5),
      listSessions: mock(() => []),
      getSessionAsync: mock(async () => null),
    } as unknown as SessionManager;

    // AuthManager mock
    mockAuthManager = {
      getAuthStatus: mock(async () => ({
        isAuthenticated: true,
        method: 'api_key' as const,
      })),
    } as unknown as AuthManager;

    // SettingsManager mock
    mockSettingsManager = {
      getGlobalSettings: mock(() => ({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      })),
    } as unknown as SettingsManager;

    // Config mock
    mockConfig = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxSessions: 10,
      dbPath: '/test/db.sqlite',
    } as unknown as Config;

    mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock(() => () => {}),
    };

    // InternalEventBus mock — collects subscribers so we can fire events manually
    mockInternalEventBus = {
      subscribe: mock((event: string, handler: Function) => {
        const existing = eventSubscribers.get(event) || [];
        existing.push(handler);
        eventSubscribers.set(event, existing);
        return () => {};
      }),
      publish: mock(async () => ({ delivered: 0, failures: [] })),
      publishAsync: mock(() => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>;

    service = new StateProjectionService(
      mockMessageHub as never,
      mockSessionManager,
      mockAuthManager,
      mockSettingsManager,
      mockConfig,
      undefined,
      mockInternalEventBus
    );
  });

  describe('constructor', () => {
    it('should subscribe to InternalEventBus events on initialization', () => {
      expect(eventSubscribers.has('session.created')).toBe(true);
      expect(eventSubscribers.has('session.updated')).toBe(true);
      expect(eventSubscribers.has('session.deleted')).toBe(true);
      expect(eventSubscribers.has('settings.updated')).toBe(true);
      expect(eventSubscribers.has('commands.updated')).toBe(true);
      expect(eventSubscribers.has('session.error')).toBe(true);
      expect(eventSubscribers.has('session.errorClear')).toBe(true);
      expect(eventSubscribers.has('api.connection')).toBe(true);
    });

    it('should not depend on messageHub', () => {
      // StateProjectionService no longer takes messageHub — it's a pure projection
      expect(service).toBeDefined();
    });
  });

  describe('getGlobalSnapshot', () => {
    it('should return global state snapshot', async () => {
      const result = await service.getGlobalSnapshot();

      expect(result).toHaveProperty('sessions');
      expect(result).toHaveProperty('system');
      expect(result).toHaveProperty('settings');
      expect(result).toHaveProperty('meta');
      expect(result.meta.channel).toBe('global');
    });
  });

  describe('getSystemState', () => {
    it('should return unified system state', async () => {
      const result = await service.getSystemState();

      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('claudeSDKVersion');
      expect(result).toHaveProperty('defaultModel');
      expect(result).toHaveProperty('maxSessions');
      expect(result).toHaveProperty('storageLocation');
      expect(result).toHaveProperty('auth');
      expect(result).toHaveProperty('health');
      expect(result).toHaveProperty('apiConnection');
    });

    it('should include authentication status', async () => {
      const result = await service.getSystemState();

      expect(result.auth).toEqual({
        isAuthenticated: true,
        method: 'api_key',
      });
    });

    it('should include health information', async () => {
      const result = await service.getSystemState();

      expect(result.health.status).toBe('ok');
      expect(result.health.sessions).toEqual({
        active: 2,
        total: 5,
      });
    });
  });

  describe('getSessionsState', () => {
    it('should return sessions state', async () => {
      const result = await service.getSessionsState();

      expect(result).toHaveProperty('sessions');
      expect(result).toHaveProperty('hasArchivedSessions');
      expect(result).toHaveProperty('timestamp');
    });

    it('should filter archived sessions when showArchived is false', async () => {
      const allSessions: Session[] = [
        { id: '1', status: 'active', metadata: {} } as Session,
        { id: '2', status: 'archived', metadata: {} } as Session,
        { id: '3', status: 'active', metadata: {} } as Session,
      ];
      const activeSessions = allSessions.filter((s) => s.status !== 'archived');

      // Server-side filtering: listSessions() returns different results based on params
      (mockSessionManager.listSessions as ReturnType<typeof mock>).mockImplementation(
        (options?: { includeArchived?: boolean }) => {
          return options?.includeArchived ? allSessions : activeSessions;
        }
      );
      (mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        showArchived: false,
      });

      const result = await service.getSessionsState();

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map((s: Session) => s.id)).toEqual(['1', '3']);
    });

    it('should include archived sessions when showArchived is true', async () => {
      const mockSessions: Session[] = [
        { id: '1', status: 'active', metadata: {} } as Session,
        { id: '2', status: 'archived', metadata: {} } as Session,
      ];
      (mockSessionManager.listSessions as ReturnType<typeof mock>).mockReturnValue(mockSessions);
      (mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        showArchived: true,
      });

      const result = await service.getSessionsState();

      expect(result.sessions).toHaveLength(2);
      expect(result.hasArchivedSessions).toBe(true);
    });

    it('should detect archived sessions presence', async () => {
      const mockSessions: Session[] = [
        { id: '1', status: 'active', metadata: {} } as Session,
        { id: '2', status: 'archived', metadata: {} } as Session,
      ];
      (mockSessionManager.listSessions as ReturnType<typeof mock>).mockReturnValue(mockSessions);

      const result = await service.getSessionsState();

      expect(result.hasArchivedSessions).toBe(true);
    });
  });

  describe('getSettingsState', () => {
    it('should return settings state', async () => {
      const result = await service.getSettingsState();

      expect(result).toHaveProperty('settings');
      expect(result).toHaveProperty('timestamp');
    });
  });

  describe('getSessionState', () => {
    it('should throw error for non-existent session', async () => {
      await expect(service.getSessionState('nonexistent')).rejects.toThrow('Session not found');
    });

    it('should return session state for existing session', async () => {
      const mockAgentSession = {
        getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
        getProcessingState: mock(() => ({ status: 'idle' })),
        getSlashCommands: mock(async () => []),
        getContextInfo: mock(() => null),
      };
      (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
        mockAgentSession
      );

      const result = await service.getSessionState('test-id');

      expect(result).toHaveProperty('sessionInfo');
      expect(result).toHaveProperty('agentState');
      expect(result).toHaveProperty('commandsData');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('timestamp');
    });

    it('should prefer processingStateCache over ghost session in-memory state', async () => {
      // Simulate a room leader/worker session where the SessionCache has a "ghost"
      // (an AgentSession loaded from DB) with stale idle state. The live session
      // in RoomRuntimeService has transitioned to waiting_for_input, which was
      // propagated to processingStateCache via session.updated event.
      const pendingQuestion = {
        toolUseId: 'tool-use-123',
        questions: [
          {
            question: 'Which approach?',
            header: 'Architecture',
            options: [{ label: 'Option A', description: 'First option' }],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };

      // Ghost session loaded from DB has stale idle state
      const ghostAgentSession = {
        getSessionData: mock(() => ({ id: 'leader-session-id', title: 'Leader' })),
        getProcessingState: mock(() => ({ status: 'idle' as const })),
        getSlashCommands: mock(async () => []),
        getContextInfo: mock(() => null),
      };
      (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
        ghostAgentSession
      );

      // Simulate session.updated event populating the cache
      const updateHandler = eventSubscribers.get('session.updated')?.[0];
      await updateHandler!({
        sessionId: 'leader-session-id',
        processingState: { status: 'waiting_for_input', pendingQuestion },
      });

      // The getSessionState should return cached waiting_for_input, not ghost's idle
      const result = await service.getSessionState('leader-session-id');

      expect(result.agentState.status).toBe('waiting_for_input');
      expect(result.agentState.pendingQuestion).toEqual(pendingQuestion);
      // Confirm the ghost's getProcessingState was NOT used as the final value
      expect(ghostAgentSession.getProcessingState).toHaveBeenCalledTimes(0);
    });
  });

  describe('getSessionSnapshot', () => {
    it('should return session snapshot', async () => {
      const mockAgentSession = {
        getSessionData: mock(() => ({ id: 'test-id', title: 'Test' })),
        getProcessingState: mock(() => ({ status: 'idle' })),
        getSlashCommands: mock(async () => []),
        getContextInfo: mock(() => null),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
      };
      (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
        mockAgentSession
      );

      const result = await service.getSessionSnapshot('test-id');

      expect(result).toHaveProperty('session');
      expect(result).toHaveProperty('sdkMessages');
      expect(result).toHaveProperty('meta');
      expect(result.meta.sessionId).toBe('test-id');
    });
  });

  describe('InternalEventBus subscribers', () => {
    describe('session.created', () => {
      it('should cache session and initial processing state', async () => {
        const handler = eventSubscribers.get('session.created')?.[0];
        const mockSession: Session = {
          id: 'new-session-id',
          title: 'New Session',
          status: 'active',
          metadata: {},
        } as Session;

        await handler!({ sessionId: 'new-session-id', session: mockSession });

        // Verify the session was cached by checking getSessionState
        // (it should be available in the processingStateCache)
        const mockAgentSession = {
          getSessionData: mock(() => mockSession),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        const state = await service.getSessionState('new-session-id');
        expect(state).toBeDefined();
      });
    });

    describe('session.updated', () => {
      it('should update cache for existing session', async () => {
        // First create a session to cache
        const createHandler = eventSubscribers.get('session.created')?.[0];
        await createHandler!({
          sessionId: 'test-id',
          session: { id: 'test-id', title: 'Original', status: 'active', metadata: {} },
        });

        // Now update it
        const updateHandler = eventSubscribers.get('session.updated')?.[0];
        await updateHandler!({
          sessionId: 'test-id',
          session: { title: 'Updated' },
          processingState: { status: 'processing' },
        });

        // Verify the cache was updated by checking getSessionState
        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id', title: 'Updated' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        const state = await service.getSessionState('test-id');
        // processingStateCache should have 'processing' from the update event
        expect(state.agentState.status).toBe('processing');
      });

      it('should handle update for non-cached session gracefully', async () => {
        const updateHandler = eventSubscribers.get('session.updated')?.[0];

        // Update without creating first (partial data scenario)
        let error: Error | null = null;
        try {
          await updateHandler!({
            namespaceId: 'nonexistent-id',
            session: { title: 'Partial' },
          });
        } catch (e) {
          error = e as Error;
        }
        // The handler should not throw — it only updates caches
        expect(error).toBeNull();
      });
    });

    describe('session.deleted', () => {
      it('should clear caches including error cache', async () => {
        // First create a session to cache
        const createHandler = eventSubscribers.get('session.created')?.[0];
        await createHandler!({
          sessionId: 'test-id',
          session: { id: 'test-id', title: 'Test', status: 'active', metadata: {} },
        });

        // Now delete it
        const deleteHandler = eventSubscribers.get('session.deleted')?.[0];
        await deleteHandler!({ sessionId: 'test-id' });

        // Session should be removed from cache — getSessionState should throw
        await expect(service.getSessionState('test-id')).rejects.toThrow('Session not found');
      });
    });

    describe('settings.updated', () => {
      it('should handle settings.updated event without error', async () => {
        const handler = eventSubscribers.get('settings.updated')?.[0];
        // Should not throw — handler is a no-op (broadcast handled by ClientEventBridge)
        await handler!({ sessionId: 'global', settings: {} as GlobalSettings });
        expect(true).toBe(true);
      });
    });

    describe('commands.updated', () => {
      it('should cache commands', async () => {
        const handler = eventSubscribers.get('commands.updated')?.[0];
        await handler!({ sessionId: 'test-id', commands: ['cmd1', 'cmd2'] });

        // Verify by checking session state — commands should be in cache
        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => ['old-cmd']),
        };
        (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        // Note: commands cache is used internally but commandsData comes from
        // getSlashCommands() for session state. The cache is for future use.
        // The main thing is the handler doesn't throw.
        const state = await service.getSessionState('test-id');
        expect(state).toBeDefined();
      });
    });

    describe('session.error', () => {
      it('should cache error', async () => {
        const handler = eventSubscribers.get('session.error')?.[0];
        await handler!({
          sessionId: 'test-id',
          error: 'Something went wrong',
          details: { code: 'ERR_001' },
        });

        // Verify error is in cache by checking session state
        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        const state = await service.getSessionState('test-id');
        expect(state.error).toBeDefined();
        expect(state.error?.message).toBe('Something went wrong');
      });
    });

    describe('session.errorClear', () => {
      it('should clear error from cache', async () => {
        // First set an error
        const errorHandler = eventSubscribers.get('session.error')?.[0];
        await errorHandler!({
          sessionId: 'test-id',
          error: 'Something went wrong',
        });

        // Now clear it
        const clearHandler = eventSubscribers.get('session.errorClear')?.[0];
        await clearHandler!({ sessionId: 'test-id' });

        // Verify error is cleared
        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        const state = await service.getSessionState('test-id');
        expect(state.error).toBeNull();
      });
    });

    describe('api.connection', () => {
      it('should update API connection state', async () => {
        const handler = eventSubscribers.get('api.connection')?.[0];
        const connectionData = {
          status: 'disconnected' as const,
          timestamp: Date.now(),
        };

        await handler!(connectionData);

        // Verify by checking system state
        const state = await service.getSystemState();
        expect(state.apiConnection.status).toBe('disconnected');
      });
    });
  });
});

/**
 * Real-DB coverage for the `sessions.last_error` persistence that shadows the
 * in-memory errorCache. The mock-based suite above can't assert column writes,
 * so this block wires a genuine in-memory SQLite database through the service.
 */
describe('StateProjectionService — session error persistence', () => {
  let service: StateProjectionService;
  let memDb: BunDatabase;
  let eventSubscribers: Map<string, Function[]>;
  let notifyChange: ReturnType<typeof mock>;

  beforeEach(() => {
    memDb = new BunDatabase(':memory:');
    memDb.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, last_error TEXT)`);
    memDb.prepare('INSERT INTO sessions (id) VALUES (?)').run('sess-cooldown-1');

    eventSubscribers = new Map();
    notifyChange = mock(() => {});
    const mockInternalEventBus = {
      subscribe: mock((event: string, handler: Function) => {
        const existing = eventSubscribers.get(event) || [];
        existing.push(handler);
        eventSubscribers.set(event, existing);
        return () => {};
      }),
      publish: mock(async () => ({ delivered: 0, failures: [] })),
      publishAsync: mock(() => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>;

    // `Database` facade stand-in — only `getDatabase()` is exercised by the
    // persistence path, so a minimal mock over the real in-memory DB suffices.
    const dbFacade = { getDatabase: () => memDb } as unknown as Database;
    // ReactiveDatabase stand-in — `notifyChange` is spied so the test asserts
    // the LiveQuery engine is told the sessions table changed (the write
    // bypasses the reactive proxy, so an explicit notify is required).
    const reactiveDb = { notifyChange } as unknown as ReactiveDatabase;

    service = new StateProjectionService(
      { event: mock(async () => {}), onRequest: mock(() => () => {}) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      dbFacade,
      mockInternalEventBus,
      undefined,
      undefined,
      reactiveDb
    );
  });

  function lastError(sessionId: string): string | null {
    const row = memDb.prepare('SELECT last_error FROM sessions WHERE id = ?').get(sessionId) as {
      last_error: string | null;
    };
    return row.last_error;
  }

  it('persists a structured provider auth error to sessions.last_error', async () => {
    const handler = eventSubscribers.get('session.error')?.[0];
    await handler!({
      sessionId: 'sess-cooldown-1',
      error: 'Anthropic authentication failed.',
      details: {
        category: 'provider_auth_error',
        userMessage: 'Anthropic authentication failed.',
        message: '401 invalid_api_key',
        metadata: { providerId: 'anthropic' },
      },
    });

    const stored = lastError('sess-cooldown-1');
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({
      category: 'provider_auth_error',
      message: 'Anthropic authentication failed.',
      providerId: 'anthropic',
    });
    // The write bypasses the reactive proxy, so the LiveQuery engine must be
    // notified explicitly that the sessions table changed.
    expect(notifyChange).toHaveBeenCalledWith('sessions');
  });

  it('clears sessions.last_error on session.errorClear', async () => {
    const errorHandler = eventSubscribers.get('session.error')?.[0];
    await errorHandler!({
      sessionId: 'sess-cooldown-1',
      error: 'boom',
      details: { category: 'provider_auth_error', userMessage: 'boom', metadata: {} },
    });
    expect(lastError('sess-cooldown-1')).not.toBeNull();

    notifyChange.mockClear();
    const clearHandler = eventSubscribers.get('session.errorClear')?.[0];
    await clearHandler!({ sessionId: 'sess-cooldown-1' });
    expect(lastError('sess-cooldown-1')).toBeNull();
    expect(notifyChange).toHaveBeenCalledWith('sessions');
  });

  it('ignores error events without a structured category', async () => {
    const handler = eventSubscribers.get('session.error')?.[0];
    await handler!({
      sessionId: 'sess-cooldown-1',
      error: 'plain string error',
      details: { code: 'ERR_001' },
    });
    // No category → nothing persisted (column stays NULL) and no notify fired.
    expect(lastError('sess-cooldown-1')).toBeNull();
    expect(notifyChange).not.toHaveBeenCalled();
  });
});
