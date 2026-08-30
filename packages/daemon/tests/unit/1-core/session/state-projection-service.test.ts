import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { StateProjectionService } from '../../../../src/lib/state-projection-service';
import type { Database } from '../../../../src/storage';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Session, GlobalSettings, AgentProcessingState } from '@hyperneo/shared';
import { STATE_CHANNELS, DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';
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

    mockSessionManager = {
      getActiveSessions: mock(() => 2),
      getTotalSessions: mock(() => 5),
      listSessions: mock(() => []),
      getSessionAsync: mock(async () => null),
      getSessionForControl: mock(async () => null),
    } as unknown as SessionManager;

    mockAuthManager = {
      getAuthStatus: mock(async () => ({
        isAuthenticated: true,
        method: 'api_key' as const,
      })),
    } as unknown as AuthManager;

    mockSettingsManager = {
      getGlobalSettings: mock(() => ({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      })),
    } as unknown as SettingsManager;

    mockConfig = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxSessions: 10,
      dbPath: '/test/db.sqlite',
    } as unknown as Config;

    mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock(() => () => {}),
    };

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

    it('strips a legacy inline voice API key from projected settings', async () => {
      (mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
          apiKey: 'sk-leaked',
        },
      });

      const result = await service.getSettingsState();
      const voice = (result.settings as GlobalSettings).voice;

      expect(voice?.apiKey).toBeUndefined();
      expect(voice?.hasApiKey).toBe(true);
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
      (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
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

      const ghostAgentSession = {
        getSessionData: mock(() => ({ id: 'leader-session-id', title: 'Leader' })),
        getProcessingState: mock(() => ({ status: 'idle' as const })),
        getSlashCommands: mock(async () => []),
        getContextInfo: mock(() => null),
      };
      (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
        ghostAgentSession
      );

      const updateHandler = eventSubscribers.get('session.updated')?.[0];
      await updateHandler!({
        sessionId: 'leader-session-id',
        processingState: { status: 'waiting_for_input', pendingQuestion },
      });

      const result = await service.getSessionState('leader-session-id');

      expect(result.agentState.status).toBe('waiting_for_input');
      expect(result.agentState.pendingQuestion).toEqual(pendingQuestion);
      expect(ghostAgentSession.getProcessingState).toHaveBeenCalledTimes(0);
    });
  });

  describe('getSessionState capture-order revision', () => {
    function mockAgent() {
      return {
        getSessionData: mock(() => ({ id: 'rev-session', title: 'Rev' })),
        getProcessingState: mock(() => ({ status: 'idle' })),
        getSlashCommands: mock(async () => []),
        getContextInfo: mock(() => null),
      };
    }

    it('stamps a strictly increasing revision on consecutive calls', async () => {
      (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
        mockAgent()
      );

      const a = await service.getSessionState('rev-session');
      const b = await service.getSessionState('rev-session');
      const c = await service.getSessionState('rev-session');

      expect(typeof a.revision).toBe('number');
      expect(b.revision).toBe(a.revision! + 1);
      expect(c.revision).toBe(b.revision! + 1);
    });

    it('keeps per-session revision counters independent', async () => {
      (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
        mockAgent()
      );

      const a1 = await service.getSessionState('session-a');
      const b1 = await service.getSessionState('session-b');
      const a2 = await service.getSessionState('session-a');

      expect(a1.revision).toBe(1);
      expect(b1.revision).toBe(1);
      expect(a2.revision).toBe(2);
    });

    it('stamps a stable daemon-instance epoch alongside the revision', async () => {
      (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
        mockAgent()
      );
      const a = await service.getSessionState('rev-session');
      const b = await service.getSessionState('rev-session');
      expect(typeof a.daemonEpoch).toBe('string');
      expect(a.daemonEpoch).toBeTruthy();
      expect(b.daemonEpoch).toBe(a.daemonEpoch);
    });
  });

  describe('broadcastSessionStateChange fallback ordering fields', () => {
    it('stamps revision + daemonEpoch on the fallback state when getSessionState throws', async () => {
      const createdHandler = eventSubscribers.get('session.created')?.[0];
      await createdHandler!({ session: { id: 'fall-session', title: 'Fall' } });
      (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(null);

      await service.broadcastSessionStateChange('fall-session');

      const sessionEmissions = (mockMessageHub.event as ReturnType<typeof mock>).mock.calls.filter(
        (c) => c[0] === STATE_CHANNELS.SESSION
      );
      expect(sessionEmissions.length).toBeGreaterThan(0);
      const fallback = sessionEmissions[sessionEmissions.length - 1][1] as Record<string, unknown>;
      expect(typeof fallback.revision).toBe('number');
      expect(typeof fallback.daemonEpoch).toBe('string');
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
      (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
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

        const mockAgentSession = {
          getSessionData: mock(() => mockSession),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        const state = await service.getSessionState('new-session-id');
        expect(state).toBeDefined();
      });
    });

    describe('session.updated', () => {
      it('should update cache for existing session', async () => {
        const createHandler = eventSubscribers.get('session.created')?.[0];
        await createHandler!({
          sessionId: 'test-id',
          session: { id: 'test-id', title: 'Original', status: 'active', metadata: {} },
        });

        const updateHandler = eventSubscribers.get('session.updated')?.[0];
        await updateHandler!({
          sessionId: 'test-id',
          session: { title: 'Updated' },
          processingState: { status: 'processing' },
        });

        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id', title: 'Updated' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        const state = await service.getSessionState('test-id');
        expect(state.agentState.status).toBe('processing');
      });

      it('should handle update for non-cached session gracefully', async () => {
        const updateHandler = eventSubscribers.get('session.updated')?.[0];

        let error: Error | null = null;
        try {
          await updateHandler!({
            namespaceId: 'nonexistent-id',
            session: { title: 'Partial' },
          });
        } catch (e) {
          error = e as Error;
        }
        expect(error).toBeNull();
      });
    });

    describe('session.deleted', () => {
      it('should clear caches including error cache', async () => {
        const createHandler = eventSubscribers.get('session.created')?.[0];
        await createHandler!({
          sessionId: 'test-id',
          session: { id: 'test-id', title: 'Test', status: 'active', metadata: {} },
        });

        const deleteHandler = eventSubscribers.get('session.deleted')?.[0];
        await deleteHandler!({ sessionId: 'test-id' });

        await expect(service.getSessionState('test-id')).rejects.toThrow('Session not found');
      });
    });

    describe('settings.updated', () => {
      it('should handle settings.updated event without error', async () => {
        const handler = eventSubscribers.get('settings.updated')?.[0];
        await handler!({ sessionId: 'global', settings: {} as GlobalSettings });
        expect(true).toBe(true);
      });
    });

    describe('commands.updated', () => {
      it('should cache commands', async () => {
        const handler = eventSubscribers.get('commands.updated')?.[0];
        await handler!({ sessionId: 'test-id', commands: ['cmd1', 'cmd2'] });

        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => ['old-cmd']),
        };
        (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

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

        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
          mockAgentSession
        );

        const state = await service.getSessionState('test-id');
        expect(state.error).toBeDefined();
        expect(state.error?.message).toBe('Something went wrong');
      });
    });

    describe('session.errorClear', () => {
      it('should clear error from cache', async () => {
        const errorHandler = eventSubscribers.get('session.error')?.[0];
        await errorHandler!({
          sessionId: 'test-id',
          error: 'Something went wrong',
        });

        const clearHandler = eventSubscribers.get('session.errorClear')?.[0];
        await clearHandler!({ sessionId: 'test-id' });

        const mockAgentSession = {
          getSessionData: mock(() => ({ id: 'test-id' })),
          getProcessingState: mock(() => ({ status: 'idle' })),
          getSlashCommands: mock(async () => []),
        };
        (mockSessionManager.getSessionForControl as ReturnType<typeof mock>).mockResolvedValue(
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

        const state = await service.getSystemState();
        expect(state.apiConnection.status).toBe('disconnected');
      });
    });
  });
});

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

    const dbFacade = { getDatabase: () => memDb } as unknown as Database;
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
    expect(lastError('sess-cooldown-1')).toBeNull();
    expect(notifyChange).not.toHaveBeenCalled();
  });
});
