/**
 * Session Manager Tests
 *
 * Unit tests for the main session orchestrator that coordinates
 * SessionCache, SessionLifecycle, ToolsConfigManager, and MessagePersistence.
 */

import { describe, expect, it, beforeEach, mock, afterEach, spyOn } from 'bun:test';
import { SessionManager, CleanupState } from '../../../../src/lib/session/session-manager';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import * as processWatchdog from '../../../../src/lib/process-watchdog';
import type { ProcessSnapshot } from '../../../../src/lib/process-watchdog';
import type { Database } from '../../../../src/storage/database';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { MessageHub, Session } from '@hyperneo/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import type { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockDb: Database;
  let mockMessageHub: MessageHub;
  let mockAuthManager: AuthManager;
  let mockSettingsManager: SettingsManager;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockJobQueue: JobQueueRepository;
  let mockJobProcessor: JobQueueProcessor;
  let config: Record<string, unknown>;
  let eventHandlers: Map<string, (...args: unknown[]) => unknown>;
  let listProcessesSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventHandlers = new Map();

    // Database mocks
    mockDb = {
      createSession: mock(() => {}),
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => ({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      })),
      listSessions: mock(() => []),
      getGlobalToolsConfig: mock(() => ({
        systemPrompt: {
          claudeCodePreset: { allowed: true, defaultEnabled: true },
        },
        mcpServers: {},
      })),
      saveGlobalToolsConfig: mock(() => {}),
      getMessagesByStatus: mock(() => []),
      saveSDKMessage: mock(() => {}),
      getUserMessages: mock(() => []),
      getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
      getSDKMessageCount: mock(() => 0),
      deleteMessagesAfter: mock(() => 0),
      deleteMessagesAtAndAfter: mock(() => 0),
      getUserMessageByUuid: mock(() => undefined),
      countMessagesAfter: mock(() => 0),
      updateMessage: mock(() => {}),
      saveUserMessage: mock(() => {}),
      getTaskRepo: mock(() => ({
        getTask: mock(() => null),
        getTaskByShortId: mock(() => null),
      })),
      getGoalRepo: mock(() => ({
        getGoal: mock(() => null),
        getGoalByShortId: mock(() => null),
      })),
    } as unknown as Database;

    // Message hub mocks
    mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock(() => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    // Auth manager mocks
    mockAuthManager = {
      getCurrentApiKey: mock(async () => 'test-api-key'),
      initialize: mock(async () => {}),
      getAuthStatus: mock(async () => ({ isAuthenticated: true })),
    } as unknown as AuthManager;

    // Settings manager mocks
    mockSettingsManager = {
      getSettings: mock(() => ({})),
      updateSettings: mock(() => {}),
      getGlobalSettings: mock(() => ({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      })),
      listMcpServersFromSources: mock(() => []),
    } as unknown as SettingsManager;

    // Event bus mocks - capture handlers for testing
    mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock((event: string, handler: (...args: unknown[]) => unknown, _opts: unknown) => {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      }),
    } as unknown as InternalEventBus<any>;

    // Job queue mocks
    mockJobQueue = {
      enqueue: mock(() => ({ id: 'job-id', queue: 'session.title_generation' })),
      listJobs: mock(() => []),
    } as unknown as JobQueueRepository;

    // Job processor mocks
    mockJobProcessor = {
      register: mock(() => {}),
      start: mock(() => {}),
      stop: mock(async () => {}),
    } as unknown as JobQueueProcessor;

    // Config
    config = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      workspaceRoot: '/default/workspace',
      disableWorktrees: true,
    };

    sessionManager = new SessionManager(
      mockDb,
      mockMessageHub,
      mockAuthManager,
      mockSettingsManager,
      mockInternalEventBus,
      config as Parameters<typeof SessionManager>[5],
      mockJobQueue,
      mockJobProcessor,
      undefined, // skillsManager
      undefined // appMcpServerRepo
    );
    // Default: listProcesses returns empty array (no test PIDs in process table).
    // Tests with live PIDs override this to include their fake PIDs.
    listProcessesSpy = spyOn(processWatchdog, 'listProcesses').mockResolvedValue([]);
  });

  afterEach(async () => {
    listProcessesSpy?.mockRestore();
    // Ensure cleanup after each test
    try {
      await sessionManager.cleanup();
    } catch {
      // Ignore cleanup errors in afterEach
    }
  });

  describe('constructor', () => {
    it('should initialize with clean state', () => {
      expect(sessionManager.getCleanupState()).toBe(CleanupState.IDLE);
    });

    it('should setup event subscriptions', () => {
      expect(mockInternalEventBus.subscribe).toHaveBeenCalledWith(
        'message.persisted',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should have no active sessions initially', () => {
      expect(sessionManager.getActiveSessions()).toBe(0);
    });
  });

  describe('start', () => {
    it('should register session.title_generation handler on jobProcessor', () => {
      expect(mockJobProcessor.register).not.toHaveBeenCalled();

      sessionManager.start();

      expect(mockJobProcessor.register).toHaveBeenCalledTimes(1);
      expect(mockJobProcessor.register).toHaveBeenCalledWith(
        'session.title_generation',
        expect.any(Function)
      );
    });

    it('should throw if called more than once', () => {
      sessionManager.start();

      expect(() => sessionManager.start()).toThrow('SessionManager.start() called more than once');
    });
  });

  describe('createSession', () => {
    it('should delegate to sessionLifecycle.create', async () => {
      (mockDb.createSession as ReturnType<typeof mock>).mockImplementation((session: Session) => {
        // Store created session for retrieval
        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(session);
      });

      const sessionId = await sessionManager.createSession({});

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
    });

    it('should create session with title', async () => {
      (mockDb.createSession as ReturnType<typeof mock>).mockImplementation((session: Session) => {
        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(session);
      });

      await sessionManager.createSession({ title: 'Test Session' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Session',
        })
      );
    });

    it('should create session with custom workspace path', async () => {
      (mockDb.createSession as ReturnType<typeof mock>).mockImplementation((session: Session) => {
        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(session);
      });

      await sessionManager.createSession({ workspacePath: '/custom/path' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: '/custom/path',
        })
      );
    });
  });

  describe('getSession', () => {
    it('should return null for non-existent session', () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

      const result = sessionManager.getSession('nonexistent');

      expect(result).toBeNull();
    });

    it('should return cached session', async () => {
      const mockSession: Session = {
        id: 'test-session-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      // First access loads and caches
      const result = sessionManager.getSession('test-session-id');

      expect(result).not.toBeNull();
    });
  });

  describe('getSessionAsync', () => {
    it('should return null for non-existent session', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

      const result = await sessionManager.getSessionAsync('nonexistent');

      expect(result).toBeNull();
    });

    it('should return cached session', async () => {
      const mockSession: Session = {
        id: 'test-session-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      const result = await sessionManager.getSessionAsync('test-session-id');

      expect(result).not.toBeNull();
    });
  });

  describe('setSpaceRuntimeMcpProvider (Space member self-heal wiring)', () => {
    it('wires onMissingMemberSpaceMcpServers on every constructed session when a provider is set', () => {
      const mockSession: Session = {
        id: 'test-session-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      const provider = { reattachMemberSpaceTools: mock(async () => {}) };
      sessionManager.setSpaceRuntimeMcpProvider(provider);

      const session = sessionManager.getSession('test-session-id');

      // Regression: the heal callback must be present at construction so a
      // freshly DB-hydrated Space member session can recover its in-process
      // space-agent-tools server after a daemon restart, before the background
      // reattach sweep reaches it. Previously the callback was wired only as a
      // side-effect of the attach step, so a hydrated-but-not-yet-attached
      // session had neither the server nor the callback and hard-failed.
      expect(session).not.toBeNull();
      expect(typeof session!.onMissingMemberSpaceMcpServers).toBe('function');
    });

    it('wired callback delegates to provider.reattachMemberSpaceTools(sessionId)', async () => {
      const mockSession: Session = {
        id: 'member-session-1',
        title: 'Member',
        workspacePath: '/ops',
        status: 'active',
        config: {},
        metadata: {},
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      const provider = { reattachMemberSpaceTools: mock(async () => {}) };
      sessionManager.setSpaceRuntimeMcpProvider(provider);

      const session = sessionManager.getSession('member-session-1');
      await session!.onMissingMemberSpaceMcpServers!('member-session-1', ['space-agent-tools']);

      expect(provider.reattachMemberSpaceTools).toHaveBeenCalledTimes(1);
      expect(provider.reattachMemberSpaceTools).toHaveBeenCalledWith('member-session-1');
    });

    it('leaves onMissingMemberSpaceMcpServers undefined when no provider is set', () => {
      const mockSession: Session = {
        id: 'no-provider-session',
        title: 'NoProvider',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);
      // No setSpaceRuntimeMcpProvider call — preserves pre-provider behavior.

      const session = sessionManager.getSession('no-provider-session');

      expect(session).not.toBeNull();
      expect(session!.onMissingMemberSpaceMcpServers).toBeUndefined();
    });
  });

  describe('registerSession / unregisterSession', () => {
    it('registerSession makes session retrievable via getSessionAsync', async () => {
      const mockSession: Session = {
        id: 'room:1:task:2:abc',
        title: 'Room Session',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };
      const fakeAgentSession = {
        getSessionData: mock(() => mockSession),
        cleanup: mock(async () => {}),
      } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

      sessionManager.registerSession(fakeAgentSession);

      const result = await sessionManager.getSessionAsync('room:1:task:2:abc');
      // Should return the exact same instance, not a DB-loaded duplicate
      expect(result).toBe(fakeAgentSession);
      // DB should not have been called since the instance is already in cache
      expect(mockDb.getSession).not.toHaveBeenCalled();
    });

    it('unregisterSession removes session from cache', async () => {
      const mockSession: Session = {
        id: 'room:1:task:2:xyz',
        title: 'Room Session',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };
      const fakeAgentSession = {
        getSessionData: mock(() => mockSession),
        cleanup: mock(async () => {}),
        getTrackedAgentRootPidsSplit: mock(() => ({ live: [], exited: [] })),
        getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
      } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

      sessionManager.registerSession(fakeAgentSession);
      await sessionManager.unregisterSession('room:1:task:2:xyz');

      // After unregister, getSession should return null (not in cache, not in DB)
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);
      const result = await sessionManager.getSessionAsync('room:1:task:2:xyz');
      expect(result).toBeNull();
    });

    it('unregisterSession preserves live and exited root PIDs for watchdog', async () => {
      const mockSession: Session = {
        id: 'room:1:task:2:abc',
        title: 'Room Session',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };
      const fakeAgentSession = {
        getSessionData: mock(() => mockSession),
        cleanup: mock(async () => {}),
        getTrackedAgentRootPidsSplit: mock(() => ({
          live: [7000],
          exited: [7001],
        })),
        getExitedRootPidTimestamps: mock(() => {
          const m = new Map<number, number>();
          m.set(7001, Date.now() - 5 * 60 * 1000);
          return m;
        }),
      } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

      sessionManager.registerSession(fakeAgentSession);
      listProcessesSpy.mockResolvedValue([
        { pid: 7000, ppid: 1, pgid: 7000, elapsedSeconds: 60, command: 'live-root' },
      ]);
      await sessionManager.unregisterSession('room:1:task:2:abc');

      // Pass snapshot with PID 7000 so snapshot-based identity
      // verification confirms it as live (first probe captures startTime).
      const fakeSnapshot = [
        { pid: 7000, ppid: 1, pgid: 7000, elapsedSeconds: 60, command: 'live-root' },
      ];
      const split = sessionManager.getTrackedAgentRootPidsSplit(fakeSnapshot);
      expect(split.live).toContain(7000);
      expect(split.exited).toContain(7001);
    });
  });

  describe('listSessions', () => {
    it('should return list from database', () => {
      const mockSessions: Session[] = [
        {
          id: '1',
          title: 'Session 1',
          workspacePath: '/1',
          status: 'active',
          config: {},
          metadata: {},
        },
        {
          id: '2',
          title: 'Session 2',
          workspacePath: '/2',
          status: 'active',
          config: {},
          metadata: {},
        },
      ];
      (mockDb.listSessions as ReturnType<typeof mock>).mockReturnValue(mockSessions);

      const result = sessionManager.listSessions();

      expect(result).toEqual(mockSessions);
      expect(mockDb.listSessions).toHaveBeenCalled();
    });

    it('should return empty array when no sessions', () => {
      (mockDb.listSessions as ReturnType<typeof mock>).mockReturnValue([]);

      const result = sessionManager.listSessions();

      expect(result).toEqual([]);
    });
  });

  describe('updateSession', () => {
    it('should delegate to sessionLifecycle.update', async () => {
      await sessionManager.updateSession('test-id', { title: 'Updated' });

      expect(mockDb.updateSession).toHaveBeenCalledWith('test-id', { title: 'Updated' });
    });

    it('should emit session.updated event', async () => {
      await sessionManager.updateSession('test-id', { title: 'Updated' });

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId: 'test-id',
        })
      );
    });
  });

  describe('deleteSessionResources (UI-only: session.delete RPC)', () => {
    it('should delete the DB row when called with the ui_session_delete trigger', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
      });

      // Task #85: `deleteSession(sessionId)` has been removed. The
      // `session.delete` RPC handler calls
      // `deleteSessionResources(sessionId, trigger)`, which is the only
      // path permitted to remove the sessions DB row + sdk_messages.
      // Note: `room.delete` RPC is retired and not registered.
      await sessionManager.deleteSessionResources('test-id', 'ui_session_delete');

      expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
    });
  });

  describe('archiveSessionResources (UI-only: session.archive + task.archive RPCs)', () => {
    it('should NOT delete the DB row when archiving (preserves conversation history)', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'archive-id',
        workspacePath: '/test',
      });

      // Task #85: archive is the "stash" path — worktree + SDK .jsonl
      // are moved out of the live directory but the DB row + sdk_messages
      // are preserved so the session is still viewable in the UI.
      await sessionManager.archiveSessionResources('archive-id', 'ui_session_archive');

      expect(mockDb.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe('interruptInMemorySession (non-UI lifecycle callers)', () => {
    it('should NOT delete the DB row — only stops the in-memory SDK subprocess', async () => {
      await sessionManager.interruptInMemorySession('ephemeral-id');

      expect(mockDb.deleteSession).not.toHaveBeenCalled();
    });

    it('preserves exited root PIDs after cache eviction for watchdog ownership', async () => {
      const mockSession: Session = {
        id: 'session-with-pids',
        title: 'PID Session',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };

      // Before cleanup: process is live. After cleanup: transitions to exited.
      const getSplit = mock(() => ({
        live: [5000],
        exited: [5001, 5002],
      }));
      const fakeAgentSession = {
        getSessionData: mock(() => mockSession),
        cleanup: mock(async () => {
          // Simulate cleanup transitioning live PID to exited
          getSplit.mockImplementation(() => ({
            live: [],
            exited: [5000, 5001, 5002],
          }));
        }),
        getTrackedAgentRootPidsSplit: getSplit,
        getExitedRootPidTimestamps: mock(() => {
          const m = new Map<number, number>();
          // Before cleanup: 5001 and 5002 already exited
          m.set(5001, Date.now() - 3 * 60 * 1000);
          m.set(5002, Date.now() - 7 * 60 * 1000);
          m.set(5000, Date.now() - 1 * 60 * 1000);
          return m;
        }),
      } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

      sessionManager.registerSession(fakeAgentSession);

      // Before interrupt: PIDs come from the session cache
      const beforeInterrupt = sessionManager.getTrackedAgentRootPidsSplit();
      expect(beforeInterrupt.live).toContain(5000);
      expect(beforeInterrupt.exited).toContain(5001);

      // Interrupt removes the session from cache
      await sessionManager.interruptInMemorySession('session-with-pids');

      // After interrupt: PIDs should still be visible via the SessionManager-level map.
      // cleanup() transitions live PID 5000 to exited, so all three are preserved as exited.
      const afterInterrupt = sessionManager.getTrackedAgentRootPidsSplit();
      expect(afterInterrupt.live).not.toContain(5000);
      expect(afterInterrupt.exited).toContain(5000);
      expect(afterInterrupt.exited).toContain(5001);
      expect(afterInterrupt.exited).toContain(5002);
    });

    it('evicted live root still present in snapshot is tracked as live', async () => {
      const mockSession: Session = {
        id: 'session-evicted-live',
        title: 'Evicted Live',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: {},
      };

      // Simulate cleanup that fails to kill the process
      const getSplit = mock(() => ({
        live: [8000],
        exited: [],
      }));
      const fakeAgentSession = {
        getSessionData: mock(() => mockSession),
        cleanup: mock(async () => {
          // Process survives cleanup â still live
          getSplit.mockImplementation(() => ({
            live: [8000],
            exited: [],
          }));
        }),
        getTrackedAgentRootPidsSplit: getSplit,
        getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
      } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

      sessionManager.registerSession(fakeAgentSession);
      listProcessesSpy.mockResolvedValue([
        { pid: 8000, ppid: 1, pgid: 8000, elapsedSeconds: 60, command: 'live-root' },
      ]);
      await sessionManager.interruptInMemorySession('session-evicted-live');

      // Pass snapshot with PID 8000 so snapshot-based identity
      // verification confirms it as live (first probe captures startTime).
      const fakeSnapshot = [
        { pid: 8000, ppid: 1, pgid: 8000, elapsedSeconds: 60, command: 'live-root' },
      ];
      const split = sessionManager.getTrackedAgentRootPidsSplit(fakeSnapshot);
      expect(split.live).toContain(8000);
      expect(split.exited).not.toContain(8000);
    });
  });

  it('promotes evicted live root to exited when the process leaves the process table', async () => {
    const mockSession: Session = {
      id: 'session-promote-live',
      title: 'Promote Live',
      workspacePath: '/test',
      status: 'active',
      config: {},
      metadata: {},
    };

    // Simulate a live root that survives cleanup
    const getSplit = mock(() => ({
      live: [9001],
      exited: [],
    }));
    const fakeAgentSession = {
      getSessionData: mock(() => mockSession),
      cleanup: mock(async () => {
        getSplit.mockImplementation(() => ({
          live: [9001],
          exited: [],
        }));
      }),
      getTrackedAgentRootPidsSplit: getSplit,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession);
    listProcessesSpy.mockResolvedValue([
      { pid: 9001, ppid: 1, pgid: 9001, elapsedSeconds: 60, command: 'live-root' },
    ]);
    await sessionManager.interruptInMemorySession('session-promote-live');

    // Pass snapshot with PID 9001 so identity is verified as live.
    const fakeSnapshot = [
      { pid: 9001, ppid: 1, pgid: 9001, elapsedSeconds: 60, command: 'live-root' },
    ];
    const before = sessionManager.getTrackedAgentRootPidsSplit(fakeSnapshot);
    expect(before.live).toContain(9001);
    expect(before.exited).not.toContain(9001);

    // Pass snapshot without PID 9001 (process exited) â promoted to exited.
    const otherSnapshot = [{ pid: 1, ppid: 0, pgid: 1, elapsedSeconds: 100, command: 'init' }];
    const after = sessionManager.getTrackedAgentRootPidsSplit(otherSnapshot);
    expect(after.live).not.toContain(9001);
    expect(after.exited).toContain(9001);
  });

  it('skips live-root promotion when no snapshot is provided', async () => {
    const mockSession: Session = {
      id: 'session-no-snapshot',
      title: 'No Snapshot',
      workspacePath: '/test',
      status: 'active',
      config: {},
      metadata: {},
    };

    const getSplit = mock(() => ({
      live: [9002],
      exited: [],
    }));
    const fakeAgentSession = {
      getSessionData: mock(() => mockSession),
      cleanup: mock(async () => {
        getSplit.mockImplementation(() => ({
          live: [9002],
          exited: [],
        }));
      }),
      getTrackedAgentRootPidsSplit: getSplit,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession);
    listProcessesSpy.mockResolvedValue([
      { pid: 9002, ppid: 1, pgid: 9002, elapsedSeconds: 60, command: 'live-root' },
    ]);
    await sessionManager.interruptInMemorySession('session-no-snapshot');

    // Without a snapshot, the evicted live root stays live â no false
    // promotion to exited when the process table is unavailable.
    const split = sessionManager.getTrackedAgentRootPidsSplit();
    expect(split.live).toContain(9002);
    expect(split.exited).not.toContain(9002);
  });

  it('removes evicted live root past retention window (PID reuse safety)', async () => {
    const mockSession: Session = {
      id: 'session-reuse-safety',
      title: 'Reuse Safety',
      workspacePath: '/test',
      status: 'active',
      config: {},
      metadata: {},
    };

    const getSplit = mock(() => ({
      live: [9999],
      exited: [],
    }));
    const fakeAgentSession = {
      getSessionData: mock(() => mockSession),
      cleanup: mock(async () => {
        getSplit.mockImplementation(() => ({
          live: [9999],
          exited: [],
        }));
      }),
      getTrackedAgentRootPidsSplit: getSplit,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession);
    listProcessesSpy.mockResolvedValue([
      { pid: 9999, ppid: 1, pgid: 9999, elapsedSeconds: 60, command: 'live-root' },
    ]);
    await sessionManager.interruptInMemorySession('session-reuse-safety');

    const RETENTION_MS = 15 * 60 * 1000;
    const futureNow = Date.now() + RETENTION_MS + 1000;

    // Call the internal method with a future timestamp and a snapshot
    // containing PID 9999 (simulating PID reuse by an unrelated process).
    // Access via type cast since expireEvictedRoots is private.
    const fakeSnapshot = [
      { pid: 9999, ppid: 1, pgid: 9999, elapsedSeconds: 60, command: 'unrelated' },
    ];
    (sessionManager as any).expireEvictedRoots(fakeSnapshot, futureNow);

    const after = sessionManager.getTrackedAgentRootPidsSplit();
    // PID should be completely removed â not live, not exited.
    // The retention window expired, so even though the PID exists in the
    // snapshot (reused by an unrelated process), it is removed.
    expect(after.live).not.toContain(9999);
    expect(after.exited).not.toContain(9999);
  });

  it('keeps evicted live root on successful identity verification via snapshot', async () => {
    const mockSession: Session = {
      id: 'session-identity-verified',
      title: 'Identity Verified',
      workspacePath: '/test',
      status: 'active',
      config: {},
      metadata: {},
    };

    const getSplit = mock(() => ({
      live: [7777],
      exited: [],
    }));
    const fakeAgentSession = {
      getSessionData: mock(() => mockSession),
      cleanup: mock(async () => {
        getSplit.mockImplementation(() => ({
          live: [7777],
          exited: [],
        }));
      }),
      getTrackedAgentRootPidsSplit: getSplit,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession);
    listProcessesSpy.mockResolvedValue([
      { pid: 7777, ppid: 1, pgid: 7777, elapsedSeconds: 60, command: 'live-root' },
    ]);
    await sessionManager.interruptInMemorySession('session-identity-verified');

    // Pass snapshot with PID 7777 â first probe captures startTime,
    // subsequent calls with matching elapsed time confirm identity.
    const fakeSnapshot = [
      { pid: 7777, ppid: 1, pgid: 7777, elapsedSeconds: 60, command: 'live-root' },
    ];
    const split = sessionManager.getTrackedAgentRootPidsSplit(fakeSnapshot);
    expect(split.live).toContain(7777);
    expect(split.exited).not.toContain(7777);
  });

  it('removes evicted live root on PID reuse detected via startTime mismatch', async () => {
    const mockSession: Session = {
      id: 'session-pid-reuse',
      title: 'PID Reuse',
      workspacePath: '/test',
      status: 'active',
      config: {},
      metadata: {},
    };

    const getSplit = mock(() => ({
      live: [6666],
      exited: [],
    }));
    const fakeAgentSession = {
      getSessionData: mock(() => mockSession),
      cleanup: mock(async () => {
        getSplit.mockImplementation(() => ({
          live: [6666],
          exited: [],
        }));
      }),
      getTrackedAgentRootPidsSplit: getSplit,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession);
    listProcessesSpy.mockResolvedValue([
      { pid: 6666, ppid: 1, pgid: 6666, elapsedSeconds: 60, command: 'original-process' },
    ]);
    await sessionManager.interruptInMemorySession('session-pid-reuse');

    // First snapshot: PID 6666 with 60s elapsed â captures startTime.
    const snapshot1 = [
      { pid: 6666, ppid: 1, pgid: 6666, elapsedSeconds: 60, command: 'original-process' },
    ];
    const first = sessionManager.getTrackedAgentRootPidsSplit(snapshot1);
    expect(first.live).toContain(6666);

    // Second snapshot: PID 6666 with 5s elapsed â startTime changed by ~55s,
    // indicating PID reuse by a different process.
    const snapshot2 = [
      { pid: 6666, ppid: 1, pgid: 6666, elapsedSeconds: 5, command: 'replaced-process' },
    ];
    const second = sessionManager.getTrackedAgentRootPidsSplit(snapshot2);
    // PID removed â startTime mismatch indicates PID reuse.
    expect(second.live).not.toContain(6666);
    expect(second.exited).not.toContain(6666);
  });

  it('refreshes evictedAt and startTime on same-PID re-eviction before watchdog poll', async () => {
    const mockSession: Session = {
      id: 'session-reevict',
      title: 'Re-Evict',
      workspacePath: '/test',
      status: 'active',
      config: {},
      metadata: {},
    };

    const getSplit1 = mock(() => ({
      live: [5555],
      exited: [],
    }));
    const fakeAgentSession1 = {
      getSessionData: mock(() => mockSession),
      cleanup: mock(async () => {}),
      getTrackedAgentRootPidsSplit: getSplit1,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession1);
    listProcessesSpy.mockResolvedValue([
      { pid: 5555, ppid: 1, pgid: 5555, elapsedSeconds: 60, command: 'live-root' },
    ]);
    await sessionManager.unregisterSession('session-reevict');

    // First eviction establishes evictedAt and startTime for PID 5555
    const first = sessionManager.getTrackedAgentRootPidsSplit([]);
    expect(first.live).toContain(5555);

    // Re-register the same PID via a new session eviction (PID reused by
    // a new daemon-owned session before the watchdog observed it).
    const getSplit2 = mock(() => ({
      live: [5555],
      exited: [],
    }));
    const fakeAgentSession2 = {
      getSessionData: mock(() => ({ ...mockSession, id: 'session-reevict-2' })),
      cleanup: mock(async () => {}),
      getTrackedAgentRootPidsSplit: getSplit2,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession2);
    listProcessesSpy.mockResolvedValue([
      { pid: 5555, ppid: 1, pgid: 5555, elapsedSeconds: 60, command: 'live-root' },
    ]);
    await sessionManager.unregisterSession('session-reevict-2');

    // After re-eviction, PID 5555 should still be tracked as live with
    // refreshed evictedAt (retention window restarts from now).
    const second = sessionManager.getTrackedAgentRootPidsSplit([]);
    expect(second.live).toContain(5555);
  });

  it('skips live-root preservation when identity baseline is unknown (listProcesses fails)', async () => {
    const mockSession: Session = {
      id: 'session-no-identity',
      title: 'No Identity',
      workspacePath: '/test',
      status: 'active',
      config: {},
      metadata: {},
    };

    const getSplit = mock(() => ({
      live: [4321],
      exited: [],
    }));
    const fakeAgentSession = {
      getSessionData: mock(() => mockSession),
      cleanup: mock(async () => {}),
      getTrackedAgentRootPidsSplit: getSplit,
      getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
    } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;

    sessionManager.registerSession(fakeAgentSession);
    // listProcesses returns empty — PID 4321 not found, no identity baseline.
    // The default beforeEach mock already returns [].
    await sessionManager.interruptInMemorySession('session-no-identity');

    // PID 4321 should NOT be tracked as live because no startTime
    // baseline was captured (cannot verify identity against reuse).
    const split = sessionManager.getTrackedAgentRootPidsSplit([]);
    expect(split.live).not.toContain(4321);
    expect(split.exited).not.toContain(4321);
  });

  describe('getActiveSessions', () => {
    it('should return count from sessionCache', () => {
      expect(sessionManager.getActiveSessions()).toBe(0);
    });
  });

  describe('getTotalSessions', () => {
    it('should return count from database', () => {
      (mockDb.listSessions as ReturnType<typeof mock>).mockReturnValue([
        { id: '1' } as Session,
        { id: '2' } as Session,
      ]);

      expect(sessionManager.getTotalSessions()).toBe(2);
    });
  });

  describe('getGlobalToolsConfig', () => {
    it('should delegate to toolsConfigManager', () => {
      const result = sessionManager.getGlobalToolsConfig();

      expect(result).toBeDefined();
    });
  });

  describe('saveGlobalToolsConfig', () => {
    it('should delegate to toolsConfigManager', () => {
      const config = { useClaudeCodePreset: true };
      sessionManager.saveGlobalToolsConfig(
        config as ReturnType<typeof sessionManager.getGlobalToolsConfig>
      );

      // Config should be saved (no error means success)
    });
  });

  describe('getFromDB', () => {
    it('should return session from database', () => {
      const mockSession = { id: 'test-id', title: 'Test' };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      const result = sessionManager.getSessionFromDB('test-id');

      expect(mockDb.getSession).toHaveBeenCalledWith('test-id');
      expect(result).toEqual(mockSession);
    });

    it('should return null if session not found', () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

      const result = sessionManager.getSessionFromDB('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('markOutputRemoved', () => {
    it('should delegate to sessionLifecycle', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        metadata: { removedOutputs: [] },
      });

      await sessionManager.markOutputRemoved('test-id', 'msg-uuid');

      expect(mockDb.updateSession).toHaveBeenCalled();
    });
  });

  describe('generateTitleAndRenameBranch', () => {
    it('should delegate to sessionLifecycle', async () => {
      // First create a session to populate the cache
      const mockSession: Session = {
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: { titleGenerated: true },
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      // Access session to cache it
      sessionManager.getSession('test-id');

      const result = await sessionManager.generateTitleAndRenameBranch('test-id', 'test message');

      expect(result).toBeDefined();
    });
  });

  describe('initializeSessionWorkspace (deprecated)', () => {
    it('should delegate to generateTitleAndRenameBranch', async () => {
      // First create a session to populate the cache
      const mockSession: Session = {
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        config: {},
        metadata: { titleGenerated: true },
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      // Access session to cache it
      sessionManager.getSession('test-id');

      const result = await sessionManager.initializeSessionWorkspace('test-id', 'test message');

      expect(result).toBeDefined();
    });
  });

  describe('cleanupOrphanedWorktrees', () => {
    it('should delegate to worktreeManager using the provided path', async () => {
      const result = await sessionManager.cleanupOrphanedWorktrees('/custom/path');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should use the provided path, not config.workspaceRoot', async () => {
      // This test verifies no global fallback occurs inside the method.
      // The provided path is distinct from config.workspaceRoot ('/default/workspace').
      const result = await sessionManager.cleanupOrphanedWorktrees('/explicit/repo');

      // cleanupOrphanedWorktrees should return an array (may be empty for non-git paths)
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getDatabase', () => {
    it('should return the database instance', () => {
      const db = sessionManager.getDatabase();

      expect(db).toBe(mockDb);
    });
  });

  describe('getSessionLifecycle', () => {
    it('should return the sessionLifecycle instance', () => {
      const lifecycle = sessionManager.getSessionLifecycle();

      expect(lifecycle).toBeDefined();
    });
  });

  describe('resetQuery hard reset', () => {
    function makePersistedSession(overrides: Partial<Session> = {}): Session {
      return {
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 1.0,
          queryMode: 'manual',
        },
        metadata: {
          messageCount: 2,
          totalTokens: 100,
          inputTokens: 40,
          outputTokens: 60,
          totalCost: 0.01,
          toolCallCount: 1,
        },
        sdkSessionId: 'sdk-session-123',
        ...overrides,
      } as Session;
    }

    it('keeps normal resetQuery behavior unless hardReset is explicitly requested', async () => {
      const persistedSession = makePersistedSession();
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(persistedSession);

      const oldSession = sessionManager.getSession('test-id');
      expect(oldSession).toBeInstanceOf(AgentSession);
      const lifecycleResetSpy = mock(async () => ({ success: true }));
      // biome-ignore lint: test mock access
      (oldSession as unknown as Record<string, unknown>).lifecycleManager = {
        reset: lifecycleResetSpy,
        cleanup: mock(async () => {}),
      };

      const result = await oldSession!.resetQuery({ restartQuery: true });

      expect(result).toEqual({ success: true });
      expect(lifecycleResetSpy).toHaveBeenCalledWith({ restartAfter: true });
      expect(sessionManager.getSession('test-id')).toBe(oldSession);

      await sessionManager.interruptInMemorySession('test-id');
    });

    it('reset without restart cancels and terminalizes durable jobs before replacement', async () => {
      const persistedSession = makePersistedSession();
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(persistedSession);
      const cancel = mock(() => ['pending-turn', 'pending-steer']);
      const markFailed = mock(() => null);
      mockDb.getJobQueueRepo = mock(() => ({ cancelForSessionWithMessages: cancel }));
      mockDb.getSDKMessageRepo = mock(() => ({ markDeliveryFailedByUuid: markFailed }));

      const oldSession = sessionManager.getSession('test-id')!;
      const result = await oldSession.resetQuery({ restartQuery: false, hardReset: true });
      const freshSession = sessionManager.getSession('test-id')!;

      expect(result).toEqual({ success: true });
      expect(cancel).toHaveBeenCalledWith('test-id');
      expect(markFailed).toHaveBeenCalledWith('test-id', 'pending-turn');
      expect(markFailed).toHaveBeenCalledWith('test-id', 'pending-steer');
      expect(freshSession.getProcessingState().status).toBe('idle');
    });

    it('replaces the cached AgentSession instance without recreating the DB row', async () => {
      const persistedSession = makePersistedSession();
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(persistedSession);

      const oldSession = sessionManager.getSession('test-id');
      expect(oldSession).toBeInstanceOf(AgentSession);
      const cleanupSpy = spyOn(oldSession!, 'cleanup');

      const result = await oldSession!.resetQuery({ restartQuery: false, hardReset: true });
      const freshSession = sessionManager.getSession('test-id');

      expect(result).toEqual({ success: true });
      expect(freshSession).toBeInstanceOf(AgentSession);
      expect(freshSession).not.toBe(oldSession);
      expect(freshSession!.getSessionData().id).toBe('test-id');
      expect(freshSession!.getSessionData().sdkSessionId).toBe('sdk-session-123');
      expect(mockDb.createSession).not.toHaveBeenCalled();
      expect(mockDb.deleteSession).not.toHaveBeenCalled();
      expect(mockDb.deleteMessagesAfter).not.toHaveBeenCalled();
      expect(mockDb.deleteMessagesAtAndAfter).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalled();
      expect(mockInternalEventBus.publish).toHaveBeenCalledWith('session.errorClear', {
        sessionId: 'test-id',
      });
      expect(mockInternalEventBus.publish).toHaveBeenCalledWith('session.reset', {
        sessionId: 'test-id',
        session: expect.objectContaining({ id: 'test-id' }),
        restartQuery: false,
      });
      expect(mockMessageHub.event).toHaveBeenCalledWith(
        'session.reset',
        { message: 'Agent has been reset and is ready for new messages' },
        { channel: 'session:test-id' }
      );

      await sessionManager.interruptInMemorySession('test-id');
    });

    it('preserves reset cost baseline on the existing session row', async () => {
      const persistedSession = makePersistedSession({
        metadata: {
          lastSdkCost: 0.05,
          costBaseline: 0.1,
        },
      });
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(persistedSession);

      const oldSession = sessionManager.getSession('test-id');
      await oldSession!.resetQuery({ restartQuery: false, hardReset: true });

      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          metadata: expect.objectContaining({
            lastSdkCost: 0,
          }),
        })
      );
      const updateSessionCalls = (mockDb.updateSession as ReturnType<typeof mock>).mock.calls;
      expect(updateSessionCalls[0][1].metadata.costBaseline).toBeCloseTo(0.15, 10);
      expect(persistedSession.metadata.costBaseline).toBe(0.1);
      expect(persistedSession.metadata.lastSdkCost).toBe(0.05);
      expect(persistedSession.sdkSessionId).toBe('sdk-session-123');
      expect(
        sessionManager.getSession('test-id')!.getSessionData().metadata.costBaseline
      ).toBeCloseTo(0.15, 10);

      await sessionManager.interruptInMemorySession('test-id');
    });

    it('replays pending messages on the fresh AgentSession when restart is requested', async () => {
      const persistedSession = makePersistedSession();
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(persistedSession);

      const oldSession = sessionManager.getSession('test-id');
      const order: string[] = [];
      const unregister = sessionManager.registerSessionResetSubscriber(async () => {
        order.push('subscriber:start');
        await Promise.resolve();
        order.push('subscriber:end');
      });
      let replayedSession: AgentSession | null = null;
      const replaySpy = spyOn(
        AgentSession.prototype,
        'replayPendingMessagesForImmediateMode'
      ).mockImplementation(async function (this: AgentSession) {
        order.push('replay');
        replayedSession = this;
      });

      try {
        const result = await oldSession!.resetQuery({ restartQuery: true, hardReset: true });
        const freshSession = sessionManager.getSession('test-id');

        expect(result).toEqual({ success: true });
        expect(freshSession).not.toBe(oldSession);
        expect(mockInternalEventBus.publish).toHaveBeenCalledWith('session.reset', {
          sessionId: 'test-id',
          session: expect.objectContaining({ id: 'test-id' }),
          restartQuery: true,
        });
        expect(replaySpy).toHaveBeenCalledTimes(1);
        expect(replayedSession).toBe(freshSession);
        expect(order).toEqual(['subscriber:start', 'subscriber:end', 'replay']);
      } finally {
        unregister();
        replaySpy.mockRestore();
        await sessionManager.interruptInMemorySession('test-id');
      }
    });

    it('coalesces concurrent hard resets for the same session', async () => {
      const persistedSession = makePersistedSession();
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(persistedSession);

      const oldSession = sessionManager.getSession('test-id');
      expect(oldSession).toBeInstanceOf(AgentSession);
      (mockDb.getSession as ReturnType<typeof mock>).mockClear();
      const replaySpy = spyOn(
        AgentSession.prototype,
        'replayPendingMessagesForImmediateMode'
      ).mockImplementation(async () => {});

      let releaseCleanup: () => void = () => {};
      const cleanupPromise = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const cleanupSpy = spyOn(oldSession!, 'cleanup').mockImplementation(async () => {
        await cleanupPromise;
      });

      try {
        const firstReset = oldSession!.resetQuery({ restartQuery: true, hardReset: true });
        await Promise.resolve();
        const secondReset = oldSession!.resetQuery({ restartQuery: true, hardReset: true });

        releaseCleanup();
        const [firstResult, secondResult] = await Promise.all([firstReset, secondReset]);

        expect(firstResult).toEqual({ success: true });
        expect(secondResult).toEqual({ success: true });
        expect(cleanupSpy).toHaveBeenCalledTimes(1);
        expect(replaySpy).toHaveBeenCalledTimes(1);
        expect(sessionManager.getSession('test-id')).not.toBe(oldSession);
      } finally {
        replaySpy.mockRestore();
        await sessionManager.interruptInMemorySession('test-id');
      }
    });
  });

  describe('cleanup', () => {
    it('should transition through cleanup states', async () => {
      expect(sessionManager.getCleanupState()).toBe(CleanupState.IDLE);

      const cleanupPromise = sessionManager.cleanup();

      // During cleanup, state should be CLEANING or already CLEANED
      // After cleanup completes, state should be CLEANED
      await cleanupPromise;

      expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
    });

    it('should prevent concurrent cleanup', async () => {
      const cleanup1 = sessionManager.cleanup();
      const cleanup2 = sessionManager.cleanup();

      await Promise.all([cleanup1, cleanup2]);

      // Both should complete without error, but only one should execute
      expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
    });

    it('should unsubscribe from event bus', async () => {
      await sessionManager.cleanup();

      // Event handlers should be unsubscribed
      expect(eventHandlers.size).toBe(0);
    });

    it('should clear session cache', async () => {
      await sessionManager.cleanup();

      expect(sessionManager.getActiveSessions()).toBe(0);
    });

    it('should handle cleanup when already cleaned', async () => {
      await sessionManager.cleanup();
      expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);

      // Second cleanup should be a no-op
      await sessionManager.cleanup();
      expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
    });

    it('should complete without draining pending tasks (processor handles drain)', async () => {
      // Background task draining is now handled by the job processor,
      // not by SessionManager. Cleanup should be immediate.
      await sessionManager.cleanup();

      expect(sessionManager.getCleanupState()).toBe(CleanupState.CLEANED);
    });
  });

  describe('InternalEventBus subscriptions', () => {
    describe('message.persisted handler', () => {
      it('should handle message persisted events', async () => {
        const handler = eventHandlers.get('message.persisted');
        expect(handler).toBeDefined();

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'test message',
          needsWorkspaceInit: false,
          hasDraftToClear: false,
        });
      });

      it('should skip title generation when workspace already initialized', async () => {
        const handler = eventHandlers.get('message.persisted');

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'test message',
          needsWorkspaceInit: false,
          hasDraftToClear: false,
        });

        // Should not call title generation
        expect(mockInternalEventBus.publish).not.toHaveBeenCalledWith(
          'session.updated',
          expect.objectContaining({ source: 'title-generated' })
        );
      });

      it('should enqueue title generation job when needsWorkspaceInit is true', async () => {
        const handler = eventHandlers.get('message.persisted');

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'test message',
          needsWorkspaceInit: true,
          hasDraftToClear: false,
        });

        expect(mockJobQueue.enqueue).toHaveBeenCalledWith({
          queue: 'session.title_generation',
          payload: { sessionId: 'test-id', userMessageText: 'test message' },
          maxRetries: 2,
        });
      });

      it('clears the draft on a direct match and keeps a staged transcript', async () => {
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: 'test message', inputDraftVoicePending: 'voice' },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'test message',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
        });

        // Direct (typing-only) match: the typing is cleared, the staged voice
        // the sender never saw stays for the next draft.
        expect(mockDb.updateSession).toHaveBeenCalledWith(
          'test-id',
          expect.objectContaining({
            metadata: expect.objectContaining({ inputDraft: null }),
          })
        );
        const call = mockDb.updateSession.mock.calls[0]?.[1] as {
          metadata: Record<string, unknown>;
        };
        expect(call.metadata.inputDraftVoicePending).toBeUndefined();
      });

      it('clears the draft and the staged transcript on a composition match', async () => {
        // The sender read the composed draft (typing + staged voice) and the
        // message carried both — the staging is consumed with the draft.
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: 'test message', inputDraftVoicePending: 'voice' },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'test message voice',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
        });

        expect(mockDb.updateSession).toHaveBeenCalledWith(
          'test-id',
          expect.objectContaining({
            metadata: expect.objectContaining({
              inputDraft: null,
              inputDraftVoicePending: null,
            }),
          })
        );
      });

      it('writes nothing when the fresh draft matches neither the text nor the composition', async () => {
        // The persistence-time flag came from a pre-send snapshot; a newer
        // draft saved in between must not be wiped by a stale match.
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: 'newer edits', inputDraftVoicePending: 'voice' },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'test message',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
        });

        expect(mockDb.updateSession).not.toHaveBeenCalled();
      });

      it("consumes only the staging when the sender's optimistic clear already emptied the draft", async () => {
        // The composer clears its input right after dispatching message.send;
        // that empty write commits during persistence, so the fresh read sees
        // the typing gone and matches neither directly nor by composition.
        // The pre-send snapshot (voicePendingSent) proves this exact staging
        // went out in the message — consume it WITHOUT touching the draft.
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: null, inputDraftVoicePending: 'voice' },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'typing voice',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
          voicePendingSent: 'voice',
        });

        expect(mockDb.updateSession).toHaveBeenCalledWith('test-id', {
          metadata: { inputDraftVoicePending: null },
        });
        const call = mockDb.updateSession.mock.calls[0]?.[1] as {
          metadata: Record<string, unknown>;
        };
        // The (already-emptied) draft is never rewritten by the fallback.
        expect(call.metadata.inputDraft).toBeUndefined();
      });

      it('keeps a staging that a later landing extended mid-send', async () => {
        // A NEW transcript appended during persistence grew the staging; only
        // the pre-send part went out in the message. Consuming the field
        // would drop the unsent extension — write nothing instead.
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: null, inputDraftVoicePending: 'voice more' },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'typing voice',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
          voicePendingSent: 'voice',
        });

        expect(mockDb.updateSession).not.toHaveBeenCalled();
      });

      it('consumes the staging when the sent text extends the pre-send composition', async () => {
        // Extend-then-send inside the debounce window: the fresh read
        // matches neither directly nor by exact composition (the sent text
        // has trailing typing), but the gate proved the voice went out —
        // consume the staging only, leaving the draft to the latest writer.
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: null, inputDraftVoicePending: 'voice' },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'typing voice now',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
          voicePendingSent: 'voice',
        });

        expect(mockDb.updateSession).toHaveBeenCalledWith('test-id', {
          metadata: { inputDraftVoicePending: null },
        });
      });

      it('clears both the empty draft and the staging on a voice-only composition send', async () => {
        // inputDraft empty, pending alone equals the sent text: the fresh
        // composition match consumes the staging with the (empty) draft.
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: null, inputDraftVoicePending: 'voice' },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'voice',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
        });

        expect(mockDb.updateSession).toHaveBeenCalledWith('test-id', {
          metadata: { inputDraft: null, inputDraftVoicePending: null },
        });
      });

      it("writes nothing when the sender's composition-match clear already consumed the staging", async () => {
        // Voice-only flow raced with the sending composer's own clear: that
        // composer DISPLAYED the voice-only composition and cleared through
        // session.clearInputDraftIf's composition match — the only path that
        // consumes a displayed staging — so the fresh read sees an absent
        // staging. The end state is already correct — the fallback must not
        // fire on an absent staging.
        const handler = eventHandlers.get('message.persisted');

        (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
          id: 'test-id',
          metadata: { inputDraft: null, inputDraftVoicePending: null },
        });

        await handler?.({
          sessionId: 'test-id',
          userMessageText: 'voice',
          needsWorkspaceInit: false,
          hasDraftToClear: true,
          voicePendingSent: 'voice',
        });

        expect(mockDb.updateSession).not.toHaveBeenCalled();
      });
    });

    describe('MCP registry / skills change handlers', () => {
      function makeFakeSession(id: string) {
        return {
          getSessionData: mock(() => ({ id })),
          reconcileEffectiveMcpServers: mock(() => {}),
          cleanup: mock(async () => {}),
          getTrackedAgentRootPidsSplit: mock(() => ({ live: [], exited: [] })),
          getExitedRootPidTimestamps: mock(() => new Map<number, number>()),
        } as unknown as import('../../../../src/lib/agent/agent-session').AgentSession;
      }

      it('subscribes to mcp.registry.changed and skills.changed', () => {
        expect(mockInternalEventBus.subscribe).toHaveBeenCalledWith(
          'mcp.registry.changed',
          expect.any(Function),
          expect.any(Object)
        );
        expect(mockInternalEventBus.subscribe).toHaveBeenCalledWith(
          'skills.changed',
          expect.any(Function),
          expect.any(Object)
        );
      });

      it('reconciles every active session when mcp.registry.changed fires', () => {
        const fakeA = makeFakeSession('session-a');
        const fakeB = makeFakeSession('session-b');
        sessionManager.registerSession(fakeA);
        sessionManager.registerSession(fakeB);

        const handler = eventHandlers.get('mcp.registry.changed');
        expect(handler).toBeDefined();
        handler?.({ sessionId: 'global' });

        expect(fakeA.reconcileEffectiveMcpServers).toHaveBeenCalledTimes(1);
        expect(fakeB.reconcileEffectiveMcpServers).toHaveBeenCalledTimes(1);
      });

      it('reconciles every active session when skills.changed fires', () => {
        const fake = makeFakeSession('session-c');
        sessionManager.registerSession(fake);

        const handler = eventHandlers.get('skills.changed');
        expect(handler).toBeDefined();
        handler?.({ sessionId: 'global' });

        expect(fake.reconcileEffectiveMcpServers).toHaveBeenCalledTimes(1);
      });

      it('a reconcile failure on one session does not abort the others', () => {
        const exploding = makeFakeSession('session-explode');
        (exploding.reconcileEffectiveMcpServers as ReturnType<typeof mock>).mockImplementation(
          () => {
            throw new Error('boom');
          }
        );
        const ok = makeFakeSession('session-ok');
        sessionManager.registerSession(exploding);
        sessionManager.registerSession(ok);

        const handler = eventHandlers.get('mcp.registry.changed');
        expect(() => handler?.({ sessionId: 'global' })).not.toThrow();
        expect(ok.reconcileEffectiveMcpServers).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('CleanupState enum', () => {
    it('should have IDLE state', () => {
      expect(CleanupState.IDLE).toBe('idle');
    });

    it('should have CLEANING state', () => {
      expect(CleanupState.CLEANING).toBe('cleaning');
    });

    it('should have CLEANED state', () => {
      expect(CleanupState.CLEANED).toBe('cleaned');
    });
  });
});
