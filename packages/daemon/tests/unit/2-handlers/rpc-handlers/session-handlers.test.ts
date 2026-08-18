import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { ModelInfo } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { setModelsCache } from '../../../../src/lib/model-service.js';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { detectStrandedProviders } from '../../../../src/lib/rpc-handlers/session-handlers';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';

function createMockInternalEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return {
    publishAsync: mock(() => {}),
    publish: mock(async () => ({ delivered: 0, failures: [] })),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
    getHandlerCount: mock(() => 0),
    getHandlerCountForSession: mock(() => 0),
    getHandlerCountForNamespace: mock(() => 0),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;

  return { hub, handlers };
}

describe('Session RPC Handlers — models.list', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();

    setModelsCache(new Map());
    resetProviderRegistry();
    resetProviderFactory();

    const { setupSessionHandlers } = await import(
      '../../../../src/lib/rpc-handlers/session-handlers'
    );
    setupSessionHandlers(messageHubData.hub, {} as SessionManager, eventBus, {} as SpaceManager);
  });

  it('returns cached models when cache is populated', async () => {
    const testCache = new Map<
      string,
      Array<{
        id: string;
        name: string;
        alias: string;
        family: string;
        provider: string;
        contextWindow: number;
        description: string;
        releaseDate: string;
        available: boolean;
      }>
    >();
    testCache.set('global', [
      {
        id: 'sonnet',
        name: 'Claude Sonnet',
        alias: 'default',
        family: 'sonnet',
        provider: 'anthropic',
        contextWindow: 200000,
        description: 'Fast model',
        releaseDate: '2025-01-01',
        available: true,
      },
    ]);
    setModelsCache(testCache);

    const handler = messageHubData.handlers.get('models.list');
    expect(handler).toBeDefined();

    const result = (await handler!({ useCache: true }, {})) as {
      models: Array<{ id: string; display_name: string }>;
      cached: boolean;
    };

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('sonnet');
    expect(result.cached).toBe(true);
  });

  it('triggers fallback refresh when cache is empty and useCache is true', {
    timeout: 15_000,
  }, async () => {
    const handler = messageHubData.handlers.get('models.list');

    const result = (await handler!({ useCache: true }, {})) as {
      models: Array<{ id: string; display_name: string }>;
      cached: boolean;
    };

    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.some((m) => m.id === 'sonnet')).toBe(true);
    expect(result.cached).toBe(false);
  });

  it('returns models with cached=false when forceRefresh is true', {
    timeout: 15_000,
  }, async () => {
    const handler = messageHubData.handlers.get('models.list');

    const result = (await handler!({ forceRefresh: true }, {})) as {
      models: Array<{ id: string; display_name: string }>;
      cached: boolean;
    };

    expect(result.models.length).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
  });

  it('returns models with cached=false when useCache is false', { timeout: 15_000 }, async () => {
    const handler = messageHubData.handlers.get('models.list');

    const result = (await handler!({ useCache: false }, {})) as {
      models: Array<{ id: string; display_name: string }>;
      cached: boolean;
    };

    expect(result.models.length).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
  });

  it('emits providers.changed when a stranded refresh recovers a missing provider', {
    timeout: 15_000,
  }, async () => {
    const recoveredModel = {
      id: 'glm-5',
      name: 'GLM-5',
      family: 'glm',
      provider: 'glm-recovered',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    } as ModelInfo;
    getProviderRegistry().register({
      id: 'glm-recovered',
      displayName: 'GLM',
      capabilities: {
        streaming: false,
        extendedThinking: false,
        thinkingModes: 'off',
        maxContextWindow: 1000,
        functionCalling: false,
        vision: false,
      },
      isAvailable: () => true,
      getModels: async () => [recoveredModel],
      ownsModel: () => true,
      getModelForTier: () => undefined,
      buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: false }),
    } as Provider);

    setModelsCache(new Map([['global', [{ id: 'sonnet', provider: 'anthropic' } as ModelInfo]]]));

    const handler = messageHubData.handlers.get('models.list');
    const result = (await handler!({ useCache: true }, {})) as {
      models: Array<{ id: string }>;
    };

    expect(result.models.some((m) => m.id === 'glm-5')).toBe(true);
    expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
      sessionId: 'global',
    });
  });

  describe('detectStrandedProviders', () => {
    function mockProvider(
      id: string,
      available: boolean | (() => boolean | Promise<boolean>)
    ): Provider {
      const isAvailable = typeof available === 'boolean' ? () => available : available;
      return {
        id,
        displayName: id,
        capabilities: {
          streaming: false,
          extendedThinking: false,
          thinkingModes: 'off',
          maxContextWindow: 1000,
          functionCalling: false,
          vision: false,
        },
        isAvailable,
        getModels: async () => [],
        ownsModel: () => false,
        getModelForTier: () => undefined,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: false }),
      } as Provider;
    }

    const anthropicOnly: ModelInfo[] = [{ id: 'sonnet', provider: 'anthropic' } as ModelInfo];

    it('detects a registered+available provider missing from the cache', async () => {
      getProviderRegistry().register(mockProvider('stranded-avail', true));
      const stranded = await detectStrandedProviders(anthropicOnly);
      expect(stranded).toContain('stranded-avail');
    });

    it('skips providers already represented in the cache', async () => {
      getProviderRegistry().register(mockProvider('stranded-rep', true));
      const stranded = await detectStrandedProviders([
        { id: 'x', provider: 'stranded-rep' } as ModelInfo,
      ]);
      expect(stranded).not.toContain('stranded-rep');
    });

    it('skips unavailable providers', async () => {
      getProviderRegistry().register(mockProvider('stranded-unavail', false));
      const stranded = await detectStrandedProviders(anthropicOnly);
      expect(stranded).not.toContain('stranded-unavail');
    });

    it('does not re-probe a provider already attempted in this cache lifetime', async () => {
      getProviderRegistry().register(mockProvider('stranded-once', true));
      const first = await detectStrandedProviders(anthropicOnly);
      expect(first).toContain('stranded-once');
      const again = await detectStrandedProviders(anthropicOnly);
      expect(again).not.toContain('stranded-once');
    });

    it('returns nothing when the cache already covers every provider', async () => {
      getProviderRegistry().register(mockProvider('stranded-covered', true));
      const stranded = await detectStrandedProviders([
        { id: 'x', provider: 'stranded-covered' } as ModelInfo,
      ]);
      expect(stranded).toEqual([]);
    });

    it('treats a provider whose isAvailable() never resolves as unavailable', async () => {
      getProviderRegistry().register(
        mockProvider('stranded-hang', () => new Promise<boolean>(() => {}))
      );
      const stranded = await detectStrandedProviders(anthropicOnly, 50);
      expect(stranded).not.toContain('stranded-hang');
    });

    it('claims providers before probing so concurrent calls do not duplicate-probe', async () => {
      let probeCount = 0;
      getProviderRegistry().register(
        mockProvider('stranded-claim', () => {
          probeCount++;
          return true;
        })
      );
      const first = detectStrandedProviders(anthropicOnly, 50);
      const second = detectStrandedProviders(anthropicOnly, 50);
      const [a, b] = await Promise.all([first, second]);
      expect(a).toContain('stranded-claim');
      expect(b).toEqual([]);
      expect(probeCount).toBe(1);
    });
  });

  describe('Session RPC Handlers — session.archive space eviction', () => {
    mock.module('../../../../src/lib/worktree-manager', () => ({
      WorktreeManager: class MockWorktreeManager {
        async getCommitsAhead() {
          return {
            hasCommitsAhead: true,
            commits: [{ hash: 'h1', message: 'wip', author: 'a', date: 'd' }],
            baseBranch: 'main',
          };
        }
      },
    }));

    let messageHubData: ReturnType<typeof createMockMessageHub>;
    let eventBus: ReturnType<typeof createMockInternalEventBus>;
    let removeSessionMock: ReturnType<typeof mock>;
    let archiveResourcesMock: ReturnType<typeof mock>;

    beforeEach(async () => {
      messageHubData = createMockMessageHub();
      eventBus = createMockInternalEventBus();
      removeSessionMock = mock(async () => ({ id: 'space-1', sessionIds: [] }));
      archiveResourcesMock = mock(async () => undefined);

      const sessionManager = {
        getSessionAsync: mock(async () => ({
          getSessionData: () => ({
            id: 'sess-1',
            status: 'active',
            context: { spaceId: 'space-1', roomId: 'room-1' },
            worktree: { branch: 'feature', worktreePath: '/wt', mainRepoPath: '/repo' },
          }),
        })),
        archiveSessionResources: archiveResourcesMock,
      } as unknown as SessionManager;

      const spaceManager = { removeSession: removeSessionMock } as unknown as SpaceManager;

      const { setupSessionHandlers } = await import(
        '../../../../src/lib/rpc-handlers/session-handlers'
      );
      setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, spaceManager);
    });

    it('does NOT evict a space session when the archive probe requires confirmation', async () => {
      const handler = messageHubData.handlers.get('session.archive');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'sess-1', confirmed: false }, {})) as {
        success: boolean;
        requiresConfirmation: boolean;
      };

      expect(result.success).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(removeSessionMock).not.toHaveBeenCalled();
      expect(archiveResourcesMock).not.toHaveBeenCalled();
    });

    it('evicts the space session only after archive succeeds', async () => {
      const handler = messageHubData.handlers.get('session.archive');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'sess-1', confirmed: true }, {})) as {
        success: boolean;
        requiresConfirmation: boolean;
      };

      expect(result.success).toBe(true);
      expect(archiveResourcesMock).toHaveBeenCalledWith('sess-1', 'ui_session_archive');
      expect(removeSessionMock).toHaveBeenCalledWith('space-1', 'sess-1');
    });
  });

  describe('Session RPC Handlers — session.messages.promotePending (v2)', () => {
    let messageHubData: ReturnType<typeof createMockMessageHub>;
    let eventBus: ReturnType<typeof createMockInternalEventBus>;
    let db: Database;
    let jobQueue: JobQueueRepository;
    let v2Previous: string | undefined;

    beforeEach(async () => {
      messageHubData = createMockMessageHub();
      eventBus = createMockInternalEventBus();
      v2Previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';

      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE sdk_messages (
          id TEXT PRIMARY KEY, session_id TEXT, message_type TEXT, message_subtype TEXT,
          sdk_message TEXT, timestamp TEXT, send_status TEXT, origin TEXT,
          is_renderable INTEGER DEFAULT 1, is_terminal INTEGER DEFAULT 0,
          conversation_turn_index INTEGER, parent_tool_use_id TEXT, task_id TEXT,
          sdk_uuid TEXT, replacement_metadata_normalized INTEGER DEFAULT 0
        );
        CREATE TABLE job_queue (
          id TEXT PRIMARY KEY, queue TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL DEFAULT '{}',
          result TEXT, error TEXT, priority INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3, retry_count INTEGER NOT NULL DEFAULT 0,
          run_at INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER,
          heartbeat_at INTEGER, completed_at INTEGER
        );
        CREATE UNIQUE INDEX uq_message_delivery_active_turn
          ON job_queue (queue, json_extract(payload, '$.sessionId'))
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.role') = 'turn'
            AND status IN ('pending', 'processing');
      `);
      jobQueue = new JobQueueRepository(db as never);
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', ?, ?, 'deferred', ?)`
      ).run(
        'db-1',
        'sess-1',
        JSON.stringify({
          type: 'user',
          uuid: 'promote-me',
          message: { role: 'user', content: 'next turn' },
        }),
        new Date().toISOString(),
        'promote-me'
      );

      const dbFacade = {
        getMessagesByStatus: (_sid: string, status: string) =>
          (
            db
              .prepare(
                `SELECT id AS dbId, sdk_message, timestamp FROM sdk_messages WHERE session_id = ? AND send_status = ?`
              )
              .all('sess-1', status) as Array<{
              dbId: string;
              sdk_message: string;
              timestamp: string;
            }>
          ).map((row) => ({ ...JSON.parse(row.sdk_message), dbId: row.dbId, timestamp: 0 })),
        updateMessageStatus: (ids: string[], status: string) =>
          db
            .prepare(
              `UPDATE sdk_messages SET send_status = ? WHERE id IN (${ids.map(() => '?').join(',')})`
            )
            .run(status, ...ids),
        getJobQueueRepo: () => jobQueue,
      };
      const sessionManager = {
        getSessionAsync: mock(async () => ({
          getSessionData: () => ({ id: 'sess-1', status: 'active' }),
          startQueryAndEnqueue: mock(async () => {}),
        })),
        getDatabase: () => dbFacade,
      } as unknown as SessionManager;

      const { setupSessionHandlers } = await import(
        '../../../../src/lib/rpc-handlers/session-handlers'
      );
      setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, {
        removeSession: mock(async () => ({ id: '', sessionIds: [] })),
      } as unknown as SpaceManager);
    });

    afterEach(() => {
      if (v2Previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = v2Previous;
      db.close();
    });

    it('routes the promoted message through deliverMessage (durable owner) under v2', async () => {
      const handler = messageHubData.handlers.get('session.messages.promotePending');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'sess-1', messageDbId: 'db-1' }, {})) as {
        promoted: boolean;
      };
      expect(result.promoted).toBe(true);

      const row = db.prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`).get('db-1') as {
        send_status: string;
      };
      expect(row.send_status).toBe('enqueued');
      const job = db
        .prepare(
          `SELECT json_extract(payload, '$.role') AS role FROM job_queue WHERE queue = ? AND json_extract(payload, '$.messageUuid') = ?`
        )
        .get(MESSAGE_DELIVERY, 'promote-me') as { role: string };
      expect(job.role).toBe('turn');
    });
  });

  describe('Session RPC Handlers — session.messages.retry (v2)', () => {
    let messageHubData: ReturnType<typeof createMockMessageHub>;
    let eventBus: ReturnType<typeof createMockInternalEventBus>;
    let db: Database;
    let jobQueue: JobQueueRepository;
    let v2Previous: string | undefined;
    let sessionStatus: string;
    let hydrateSpy: ReturnType<typeof mock>;

    beforeEach(async () => {
      messageHubData = createMockMessageHub();
      eventBus = createMockInternalEventBus();
      v2Previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
      sessionStatus = 'active';

      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE sdk_messages (
          id TEXT PRIMARY KEY, session_id TEXT, message_type TEXT, message_subtype TEXT,
          sdk_message TEXT, timestamp TEXT, send_status TEXT, origin TEXT,
          is_renderable INTEGER DEFAULT 1, is_terminal INTEGER DEFAULT 0,
          conversation_turn_index INTEGER, parent_tool_use_id TEXT, task_id TEXT,
          sdk_uuid TEXT, replacement_metadata_normalized INTEGER DEFAULT 0
        );
        CREATE TABLE job_queue (
          id TEXT PRIMARY KEY, queue TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL DEFAULT '{}',
          result TEXT, error TEXT, priority INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3, retry_count INTEGER NOT NULL DEFAULT 0,
          run_at INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER,
          heartbeat_at INTEGER, completed_at INTEGER
        );
        CREATE UNIQUE INDEX uq_message_delivery_active_turn
          ON job_queue (queue, json_extract(payload, '$.sessionId'))
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.role') = 'turn'
            AND status IN ('pending', 'processing');
      `);
      jobQueue = new JobQueueRepository(db as never);
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', ?, ?, 'failed', ?)`
      ).run(
        'db-failed',
        'sess-1',
        JSON.stringify({
          type: 'user',
          uuid: 'retry-me',
          message: { role: 'user', content: 'please retry' },
        }),
        new Date().toISOString(),
        'retry-me'
      );

      const dbFacade = {
        getMessagesByStatus: (_sid: string, status: string) =>
          (
            db
              .prepare(
                `SELECT id AS dbId, sdk_message, timestamp FROM sdk_messages WHERE session_id = ? AND send_status = ?`
              )
              .all('sess-1', status) as Array<{
              dbId: string;
              sdk_message: string;
              timestamp: string;
            }>
          ).map((row) => ({ ...JSON.parse(row.sdk_message), dbId: row.dbId, timestamp: 0 })),
        updateMessageStatus: (ids: string[], status: string) =>
          db
            .prepare(
              `UPDATE sdk_messages SET send_status = ? WHERE id IN (${ids.map(() => '?').join(',')})`
            )
            .run(status, ...ids),
        getJobQueueRepo: () => jobQueue,
        getSession: (sid: string) => ({ id: sid, status: sessionStatus }),
        getSDKMessageRepo: () => ({
          reopenDeliveryByUuid: (_sid: string, uuid: string) => {
            const row = db
              .prepare(
                `SELECT id FROM sdk_messages WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ? AND send_status = 'failed'`
              )
              .get('sess-1', uuid) as { id: string } | undefined;
            if (!row) return null;
            db.prepare(`UPDATE sdk_messages SET send_status = 'enqueued' WHERE id = ?`).run(row.id);
            return row.id;
          },
        }),
      };
      const sessionManager = {
        // biome-ignore lint: test mock assignment — hydrateSpy captured for the
        getSessionAsync: (hydrateSpy = mock(async () => ({
          getSessionData: () => ({ id: 'sess-1', status: 'active' }),
          startQueryAndEnqueue: mock(async () => {}),
        }))),
        getDatabase: () => dbFacade,
      } as unknown as SessionManager;

      const { setupSessionHandlers } = await import(
        '../../../../src/lib/rpc-handlers/session-handlers'
      );
      setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, {
        removeSession: mock(async () => ({ id: '', sessionIds: [] })),
      } as unknown as SpaceManager);
    });

    afterEach(() => {
      if (v2Previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = v2Previous;
      db.close();
    });

    it('reopens the failed row to enqueued and re-enqueues a durable turn job', async () => {
      const handler = messageHubData.handlers.get('session.messages.retry');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'sess-1', messageDbId: 'db-failed' }, {})) as {
        retried: boolean;
      };
      expect(result.retried).toBe(true);

      const row = db
        .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
        .get('db-failed') as { send_status: string };
      expect(row.send_status).toBe('enqueued');
      const job = db
        .prepare(
          `SELECT json_extract(payload, '$.role') AS role FROM job_queue WHERE queue = ? AND json_extract(payload, '$.messageUuid') = ?`
        )
        .get(MESSAGE_DELIVERY, 'retry-me') as { role: string };
      expect(job.role).toBe('turn');
    });

    it('returns retried:false for a non-failed message (nothing to reopen)', async () => {
      const result = (await messageHubData.handlers.get('session.messages.retry')!(
        { sessionId: 'sess-1', messageDbId: 'does-not-exist' },
        {}
      )) as { retried: boolean };
      expect(result.retried).toBe(false);
    });

    it('rejects retries for a terminal session (archived/ended) without reopening or hydrating (Codex #5 + P2)', async () => {
      for (const terminalStatus of ['archived', 'ended'] as const) {
        sessionStatus = terminalStatus;
        hydrateSpy.mockClear();
        const result = (await messageHubData.handlers.get('session.messages.retry')!(
          { sessionId: 'sess-1', messageDbId: 'db-failed' },
          {}
        )) as { retried: boolean };
        expect(result.retried).toBe(false);
        expect(hydrateSpy).not.toHaveBeenCalled();
        const row = db
          .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
          .get('db-failed') as { send_status: string };
        expect(row.send_status).toBe('failed');
      }
    });
  });
});

describe('Session RPC Handlers — session.update voice baseline refresh', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;
  let sessionManager: {
    getSession: ReturnType<typeof mock>;
    getSessionFromDB: ReturnType<typeof mock>;
    updateSession: ReturnType<typeof mock>;
  };
  let existingPending: string | null;
  let existingDraft: string | null;
  let existingBaseline: string | null | undefined;
  let existingBaselineSeq: number | null | undefined;
  let existingDraftVersion: number | null | undefined;
  let sessionExists: boolean;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    existingPending = null;
    existingDraft = null;
    existingBaseline = undefined;
    existingBaselineSeq = undefined;
    existingDraftVersion = undefined;
    sessionExists = true;
    sessionManager = {
      getSession: mock(() => null),
      getSessionFromDB: mock(() =>
        sessionExists
          ? {
              id: 's1',
              metadata: {
                inputDraft: existingDraft,
                inputDraftVoicePending: existingPending,
                inputDraftVoiceBaseline: existingBaseline,
                inputDraftVoiceBaselineSeq: existingBaselineSeq,
                inputDraftVersion: existingDraftVersion,
              },
            }
          : null
      ),
      updateSession: mock(async () => {}),
    } as unknown as SessionManager;

    const { setupSessionHandlers } = await import(
      '../../../../src/lib/rpc-handlers/session-handlers'
    );
    setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, {} as SpaceManager);
  });

  it('returns the folded draft value so the client can adopt it', async () => {
    existingPending = null;
    existingDraft = 'old draft voice words';
    existingBaseline = 'old draft';
    existingDraftVersion = 2;
    const handler = messageHubData.handlers.get('session.update');
    const result = (await handler!(
      { sessionId: 's1', metadata: { inputDraft: 'stale edits' } },
      {}
    )) as { success: boolean; draftVersion?: number; draftValue?: string };
    expect(result.success).toBe(true);
    expect(result.draftVersion).toBe(3);
    expect(result.draftValue).toBe('stale edits voice words');
  });

  it('re-anchors the baseline to the new draft when a pending sequence is staged', async () => {
    existingPending = 'voice';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'a b' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'a b', inputDraftVoiceBaseline: 'a b', inputDraftVersion: 1 },
    });
  });

  it('leaves the baseline untouched when no pending sequence is staged', async () => {
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'plain edit' } }, {});
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: Record<string, unknown>;
    };
    expect(write.metadata.inputDraftVoiceBaseline).toBeUndefined();
  });

  it('anchors a cleared draft to an empty baseline (pending merges onto nothing)', async () => {
    existingPending = 'voice';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: null } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null, inputDraftVoiceBaseline: '', inputDraftVersion: 1 },
    });
  });

  it('folds the merged transcripts into a stale save (baseline lingers, pending cleared)', async () => {
    existingPending = null;
    existingDraft = 'old draft voice words';
    existingBaseline = 'old draft';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'stale edits' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: 'stale edits voice words',
        inputDraftVoiceBaseline: 'stale edits',
        inputDraftVersion: 1,
      },
    });
  });

  it('reduces a stale-folded draft to the transcripts on the retrying strip', async () => {
    existingPending = null;
    existingDraft = 'stale edits voice words';
    existingBaseline = 'stale edits';
    existingBaselineSeq = 1;
    const handler = messageHubData.handlers.get('session.stripVoiceBaseline');
    const result = (await handler!(
      { sessionId: 's1', expected: 'stale edits voice words', expectedSeq: 1 },
      {}
    )) as { updated: boolean; value: string };
    expect(result).toEqual({ updated: true, value: 'voice words' });
  });

  it('applies a post-merge save as-is when it already carries the transcripts', async () => {
    existingPending = null;
    existingDraft = 'old draft voice words';
    existingBaseline = 'old draft';
    existingDraftVersion = 3;
    const handler = messageHubData.handlers.get('session.update');
    await handler!(
      {
        sessionId: 's1',
        expectedDraftVersion: 3,
        metadata: { inputDraft: 'new edits voice words' },
      },
      {}
    );
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: 'new edits voice words',
        inputDraftVoiceBaseline: null,
        inputDraftVersion: 4,
      },
    });
  });

  it('folds a stale save that coincidentally ends with the transcript phrase', async () => {
    existingPending = null;
    existingDraft = 'please say hello';
    existingBaseline = 'please say';
    existingDraftVersion = 2;
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'please say hello' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: 'please say hello hello',
        inputDraftVoiceBaseline: 'please say hello',
        inputDraftVersion: 3,
      },
    });
  });
});

describe('Session RPC Handlers — session.appendVoiceDraft', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;
  let sessionManager: {
    getSessionFromDB: ReturnType<typeof mock>;
    updateSession: ReturnType<typeof mock>;
  };
  let existingPending: string | null;
  let existingAppendLog: Array<{ id: string; ts: number }> | null;
  let existingDraft: string | null;
  let existingBaseline: string | null | undefined;
  let existingBaselineSeq: number | null | undefined;
  let existingMergeClaimLog: Array<{ id: string; ts: number }> | null;
  let existingDraftVersion: number | null | undefined;
  let sessionExists: boolean;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    existingPending = 'existing';
    existingAppendLog = null;
    existingDraft = null;
    existingBaseline = undefined;
    existingBaselineSeq = undefined;
    existingMergeClaimLog = null;
    existingDraftVersion = undefined;
    sessionExists = true;
    sessionManager = {
      getSessionFromDB: mock(() =>
        sessionExists
          ? {
              id: 's1',
              metadata: {
                inputDraft: existingDraft,
                inputDraftVoicePending: existingPending,
                inputDraftVoiceBaseline: existingBaseline,
                inputDraftVoiceBaselineSeq: existingBaselineSeq,
                inputDraftVoiceAppendLog: existingAppendLog,
                inputDraftVoiceMergeClaimLog: existingMergeClaimLog,
                inputDraftVersion: existingDraftVersion,
              },
            }
          : null
      ),
      updateSession: mock(async () => {}),
    } as unknown as SessionManager;

    const { setupSessionHandlers } = await import(
      '../../../../src/lib/rpc-handlers/session-handlers'
    );
    setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, {} as SpaceManager);
  });

  it('appends the transcript to the pending voice-draft field with a separating space', async () => {
    existingPending = 'existing';
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    expect(handler).toBeDefined();
    const result = (await handler!({ sessionId: 's1', text: 'hello world' }, {})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: 'existing hello world' },
    });
  });

  it('does not insert a space across a CJK boundary', async () => {
    existingPending = '你好';
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: '世界' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: '你好世界' },
    });
  });

  it('appends with no leading space when nothing is pending', async () => {
    existingPending = null;
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraftVoicePending: 'hello',
        inputDraftVoiceBaseline: '',
        inputDraftVoiceBaselineSeq: 1,
      },
    });
  });

  it('throws when the session does not exist and does not write', async () => {
    sessionExists = false;
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await expect(handler!({ sessionId: 'missing', text: 'hi' }, {})).rejects.toThrow(
      'Session not found'
    );
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only text before reading or writing the pending field', async () => {
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await expect(handler!({ sessionId: 's1', text: '   ' }, {})).rejects.toThrow();
    expect(sessionManager.getSessionFromDB).not.toHaveBeenCalled();
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('rejects instead of truncating when the pending field is at the character limit', async () => {
    existingPending = 'p'.repeat(100_000);
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await expect(handler!({ sessionId: 's1', text: 'more' }, {})).rejects.toThrow(
      'Pending voice draft is at the character limit'
    );
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('records the outbox dedupId alongside the append', async () => {
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-1' }, {})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraftVoicePending: 'existing hello',
        inputDraftVoiceAppendLog: [{ id: 'entry-1', ts: expect.any(Number) }],
      },
    });
  });

  it('skips a re-append whose dedupId already merged (idempotent replay)', async () => {
    existingAppendLog = [{ id: 'entry-1', ts: Date.now() }];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-1' }, {})) as {
      success: boolean;
      deduped: boolean;
    };
    expect(result).toEqual({ success: true, deduped: true });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('dedups an out-of-order replay even after a later entry committed', async () => {
    existingAppendLog = [
      { id: 'entry-1', ts: Date.now() },
      { id: 'entry-2', ts: Date.now() },
    ];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-1' }, {})) as {
      success: boolean;
      deduped: boolean;
    };
    expect(result).toEqual({ success: true, deduped: true });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('accumulates processed ids with no count cap — only the TTL bounds the log', async () => {
    existingAppendLog = Array.from({ length: 600 }, (_, i) => ({
      id: `entry-${i}`,
      ts: Date.now(),
    }));
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-600' }, {});
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: { inputDraftVoiceAppendLog: Array<{ id: string }> };
    };
    expect(write.metadata.inputDraftVoiceAppendLog).toHaveLength(601);
    expect(write.metadata.inputDraftVoiceAppendLog.map((e) => e.id)).toContain('entry-0');
  });

  it('prunes dedup ids past the retry lifetime instead of keeping them forever', async () => {
    existingAppendLog = [
      { id: 'stale', ts: Date.now() - 25 * 60 * 60 * 1000 },
      { id: 'fresh', ts: Date.now() },
    ];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-new' }, {});
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: { inputDraftVoiceAppendLog: Array<{ id: string }> };
    };
    expect(write.metadata.inputDraftVoiceAppendLog.map((e) => e.id)).toEqual([
      'fresh',
      'entry-new',
    ]);
  });

  it('no longer dedups an id past the retry lifetime', async () => {
    existingAppendLog = [{ id: 'entry-1', ts: Date.now() - 25 * 60 * 60 * 1000 }];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-1' }, {})) as {
      success: boolean;
      deduped?: boolean;
    };
    expect(result).toEqual({ success: true });
    expect(sessionManager.updateSession).toHaveBeenCalled();
  });

  it('ignores the dedup guard when no dedupId is supplied (live one-shot path)', async () => {
    existingAppendLog = [{ id: 'entry-1', ts: Date.now() }];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: 'existing hello' },
    });
  });

  it('snapshots the pre-sequence draft as the merge baseline on a new pending sequence', async () => {
    existingPending = null;
    existingDraft = 'user draft';
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraftVoicePending: 'hello',
        inputDraftVoiceBaseline: 'user draft',
        inputDraftVoiceBaselineSeq: 1,
      },
    });
  });

  it('does not overwrite the baseline mid-sequence (pending already staged)', async () => {
    existingPending = 'first';
    existingDraft = 'draft at sequence start';
    existingBaseline = 'draft at sequence start';
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'second' }, {});
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: Record<string, unknown>;
    };
    expect(write.metadata.inputDraftVoiceBaseline).toBeUndefined();
  });

  it('strips the pre-sequence baseline, keeping every merged transcript (stripVoiceBaseline)', async () => {
    const handler = messageHubData.handlers.get('session.stripVoiceBaseline');
    expect(handler).toBeDefined();
    existingBaseline = 'stale baseline';
    existingBaselineSeq = 3;
    existingDraft = 'stale baseline first second';
    const result = (await handler!(
      { sessionId: 's1', expected: 'stale baseline first second', expectedSeq: 3 },
      {}
    )) as { updated: boolean; value: string };
    expect(result).toEqual({ updated: true, value: 'first second' });
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: 'first second',
        inputDraftVoiceBaseline: null,
        inputDraftVoiceLastStrippedSeq: 3,
        inputDraftVersion: 1,
      },
    });
  });

  it('declines the strip when a NEWER sequence replaced the baseline (draft text unchanged)', async () => {
    const handler = messageHubData.handlers.get('session.stripVoiceBaseline');
    existingBaseline = 'stale baseline transcript';
    existingBaselineSeq = 2;
    existingDraft = 'stale baseline transcript';
    const result = (await handler!(
      { sessionId: 's1', expected: 'stale baseline transcript', expectedSeq: 1 },
      {}
    )) as { updated: boolean };
    expect(result).toEqual({ updated: false });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('strips to an empty draft when the baseline alone remains (stripVoiceBaseline)', async () => {
    existingBaseline = 'stale baseline';
    existingBaselineSeq = 1;
    existingDraft = 'stale baseline';
    const handler = messageHubData.handlers.get('session.stripVoiceBaseline');
    const result = (await handler!(
      { sessionId: 's1', expected: 'stale baseline', expectedSeq: 1 },
      {}
    )) as { updated: boolean; value: string };
    expect(result).toEqual({ updated: true, value: '' });
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: null,
        inputDraftVoiceBaseline: null,
        inputDraftVoiceLastStrippedSeq: 1,
        inputDraftVersion: 1,
      },
    });
  });

  it('declines the strip without a baseline snapshot or on a draft mismatch', async () => {
    const handler = messageHubData.handlers.get('session.stripVoiceBaseline');
    existingBaseline = undefined;
    existingDraft = 'any';
    expect(await handler!({ sessionId: 's1', expected: 'any', expectedSeq: 1 }, {})).toEqual({
      updated: false,
    });

    existingBaseline = 'old';
    existingBaselineSeq = 1;
    existingDraft = 'newer edit from elsewhere';
    expect(
      await handler!({ sessionId: 's1', expected: 'old transcripts', expectedSeq: 1 }, {})
    ).toEqual({ updated: false });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('pushes a backup ONTO the merged transcripts, keeping both (mergeVoiceDraftBackup)', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    expect(handler).toBeDefined();
    existingPending = null;
    existingBaseline = 'stale baseline';
    existingBaselineSeq = 2;
    existingDraft = 'stale baseline first second';
    const result = (await handler!({ sessionId: 's1', content: 'user edits' }, {})) as {
      merged: boolean;
      value: string;
    };
    expect(result).toEqual({ merged: true, value: 'user edits first second' });
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: 'user edits first second',
        inputDraftVoiceBaseline: null,
        inputDraftVersion: 1,
      },
    });
  });

  it('re-anchors the baseline when the pending is still staged (nothing merged yet)', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingPending = 'voice';
    existingBaseline = 'old draft';
    existingBaselineSeq = 1;
    existingDraft = 'old draft';
    const result = (await handler!({ sessionId: 's1', content: 'user edits' }, {})) as {
      merged: boolean;
      value: string;
    };
    expect(result).toEqual({ merged: true, value: 'user edits' });
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: 'user edits',
        inputDraftVoiceBaseline: 'user edits',
        inputDraftVersion: 1,
      },
    });
  });

  it('writes the backup as a plain draft when no sequence lingers', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingBaseline = undefined;
    existingDraft = 'anything';
    const result = (await handler!({ sessionId: 's1', content: 'user edits' }, {})) as {
      merged: boolean;
      value: string;
    };
    expect(result).toEqual({ merged: true, value: 'user edits' });
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'user edits', inputDraftVersion: 1 },
    });
  });

  it('declines the merge when the draft diverged from the baseline snapshot', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingPending = null;
    existingBaseline = 'old';
    existingBaselineSeq = 1;
    existingDraft = 'an unrelated newer draft';
    const result = (await handler!({ sessionId: 's1', content: 'user edits' }, {})) as {
      merged: boolean;
    };
    expect(result).toEqual({ merged: false });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('clears the draft when an empty backup is pushed (owed clear retry)', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingBaseline = undefined;
    existingDraft = 'stale';
    const result = (await handler!({ sessionId: 's1', content: '' }, {})) as {
      merged: boolean;
      value: string;
    };
    expect(result).toEqual({ merged: true, value: '' });
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null, inputDraftVersion: 1 },
    });
  });

  it('acknowledges a retry of an already-committed claim without rewriting (mergeVoiceDraftBackup)', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingBaseline = 'old';
    existingBaselineSeq = 1;
    existingDraft = 'old voice';
    existingMergeClaimLog = [{ id: 'claim-1', ts: Date.now() }];
    const result = (await handler!(
      { sessionId: 's1', content: 'user edits', claimId: 'claim-1' },
      {}
    )) as { merged: boolean; value: string };
    expect(result).toEqual({ merged: true, value: 'old voice' });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('retains every live claim across concurrent commits (merge claim LOG)', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingPending = null;
    existingBaseline = 'old';
    existingBaselineSeq = 1;
    existingDraft = 'old voice';
    existingMergeClaimLog = [{ id: 'claim-a', ts: Date.now() }];
    const result = (await handler!(
      { sessionId: 's1', content: 'tab b edits', claimId: 'claim-b' },
      {}
    )) as { merged: boolean };
    expect(result.merged).toBe(true);
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: Record<string, unknown>;
    };
    expect(write.metadata.inputDraftVoiceMergeClaimLog.map((e: { id: string }) => e.id)).toEqual([
      'claim-a',
      'claim-b',
    ]);
    const replay = (await handler!(
      { sessionId: 's1', content: 'tab a edits', claimId: 'claim-a' },
      {}
    )) as { merged: boolean; value: string };
    expect(replay.merged).toBe(true);
  });

  it('declines the merge when backup + transcripts would truncate at the limit', async () => {
    existingPending = null;
    existingBaseline = 'old';
    existingBaselineSeq = 1;
    existingDraft = `old ${'x'.repeat(99_000)}`;
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    const result = (await handler!({ sessionId: 's1', content: 'y'.repeat(5_000) }, {})) as {
      merged: boolean;
    };
    expect(result).toEqual({ merged: false });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('re-anchors a staged baseline when clearInputDraftIf clears the draft', async () => {
    const handler = messageHubData.handlers.get('session.clearInputDraftIf');
    existingDraft = 'full draft';
    existingPending = 'voice';
    existingBaseline = 'full draft';
    const result = (await handler!({ sessionId: 's1', expected: 'full draft' }, {})) as {
      cleared: boolean;
    };
    expect(result.cleared).toBe(true);
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: Record<string, unknown>;
    };
    expect(write.metadata.inputDraftVoiceBaseline).toBe('');
  });

  it('retains every claim for the full retry lifetime (no count cap)', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingPending = null;
    existingBaseline = 'old';
    existingBaselineSeq = 1;
    existingDraft = 'old voice';
    existingMergeClaimLog = Array.from({ length: 25 }, (_, i) => ({
      id: `claim-${i}`,
      ts: Date.now(),
    }));
    await handler!({ sessionId: 's1', content: 'edits', claimId: 'claim-25' }, {});
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: { inputDraftVoiceMergeClaimLog: Array<{ id: string }> };
    };
    expect(write.metadata.inputDraftVoiceMergeClaimLog).toHaveLength(26);
    expect(write.metadata.inputDraftVoiceMergeClaimLog.map((e) => e.id)).toContain('claim-0');
  });

  it('records the committed claim id alongside the merged draft', async () => {
    const handler = messageHubData.handlers.get('session.mergeVoiceDraftBackup');
    existingPending = null;
    existingBaseline = 'old';
    existingBaselineSeq = 1;
    existingDraft = 'old voice';
    await handler!({ sessionId: 's1', content: 'user edits', claimId: 'claim-2' }, {});
    const write = sessionManager.updateSession.mock.calls[0][1] as {
      metadata: Record<string, unknown>;
    };
    expect(write.metadata.inputDraft).toBe('user edits voice');
    expect(write.metadata.inputDraftVoiceMergeClaimLog).toEqual([
      { id: 'claim-2', ts: expect.any(Number) },
    ]);
  });
});

describe('Session RPC Handlers — session.get voice draft merge', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;
  let sessionManager: {
    getSessionAsync: ReturnType<typeof mock>;
    updateSession: ReturnType<typeof mock>;
  };

  async function setup(metadata: Record<string, unknown>) {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    const sessionData = { id: 's1', metadata };
    sessionManager = {
      getSessionAsync: mock(async () => ({ getSessionData: () => sessionData })),
      updateSession: mock(async () => {}),
    } as unknown as SessionManager;
    const { setupSessionHandlers } = await import(
      '../../../../src/lib/rpc-handlers/session-handlers'
    );
    setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, {} as SpaceManager);
    return messageHubData.handlers.get('session.get');
  }

  it('merges a pending voice transcript into the draft and clears the staging field', async () => {
    const handler = await setup({
      inputDraft: 'existing',
      inputDraftVoicePending: 'hello world',
    });
    expect(handler).toBeDefined();
    await handler!({ sessionId: 's1' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: {
        inputDraft: 'existing hello world',
        inputDraftVoicePending: null,
        inputDraftVersion: 1,
      },
    });
  });

  it('leaves the draft untouched when there is no pending transcript', async () => {
    const handler = await setup({ inputDraft: 'existing' });
    await handler!({ sessionId: 's1' }, {});
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('ignores a whitespace-only pending transcript', async () => {
    const handler = await setup({ inputDraft: 'existing', inputDraftVoicePending: '   ' });
    await handler!({ sessionId: 's1' }, {});
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('retains the pending transcript when a full draft leaves no room for it', async () => {
    const fullDraft = 'x'.repeat(100_000);
    const handler = await setup({ inputDraft: fullDraft, inputDraftVoicePending: 'hello' });
    await handler!({ sessionId: 's1' }, {});
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });
});

describe('Session RPC Handlers — session.clearInputDraftIf', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;
  let sessionManager: {
    getSessionFromDB: ReturnType<typeof mock>;
    updateSession: ReturnType<typeof mock>;
  };
  let persistedDraft: string | null;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    persistedDraft = 'snapshot';
    sessionManager = {
      getSessionFromDB: mock(() => ({ id: 's1', metadata: { inputDraft: persistedDraft } })),
      updateSession: mock(async () => {}),
    } as unknown as SessionManager;
    const { setupSessionHandlers } = await import(
      '../../../../src/lib/rpc-handlers/session-handlers'
    );
    setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, {} as SpaceManager);
  });

  it('clears the draft when it still equals the expected click-time snapshot', async () => {
    const handler = messageHubData.handlers.get('session.clearInputDraftIf');
    expect(handler).toBeDefined();
    const result = (await handler!({ sessionId: 's1', expected: 'snapshot' }, {})) as {
      cleared: boolean;
    };
    expect(result.cleared).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null, inputDraftVersion: 1 },
    });
  });

  it('does not clear when the persisted draft has newer edits', async () => {
    persistedDraft = 'newer edits';
    const handler = messageHubData.handlers.get('session.clearInputDraftIf');
    const result = (await handler!({ sessionId: 's1', expected: 'snapshot' }, {})) as {
      cleared: boolean;
    };
    expect(result.cleared).toBe(false);
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('trims both sides before comparing', async () => {
    persistedDraft = '  snapshot  ';
    const handler = messageHubData.handlers.get('session.clearInputDraftIf');
    const result = (await handler!({ sessionId: 's1', expected: ' snapshot ' }, {})) as {
      cleared: boolean;
    };
    expect(result.cleared).toBe(true);
  });
});
