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

describe('Session RPC Handlers — session.messages.byStatus', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;
  let getUserMessagesByStatus: ReturnType<typeof mock>;
  let getMessagesByStatus: ReturnType<typeof mock>;
  let getSessionAsync: ReturnType<typeof mock>;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    getUserMessagesByStatus = mock(() => ({
      messages: [
        {
          type: 'user',
          uuid: 'message-1',
          dbId: 'db-1',
          timestamp: 123,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'First' },
              { type: 'image' },
              { type: 'text', text: 'Second' },
            ],
          },
        },
      ],
      total: 42,
    }));
    getMessagesByStatus = mock(() => {
      throw new Error('unbounded path called');
    });
    getSessionAsync = mock(async () => ({
      getSessionData: () => ({ id: 'session-1' }),
    }));
    const sessionManager = {
      getSessionAsync,
      getDatabase: () => ({ getUserMessagesByStatus, getMessagesByStatus }),
    } as unknown as SessionManager;
    const { setupSessionHandlers } = await import(
      '../../../../src/lib/rpc-handlers/session-handlers'
    );
    setupSessionHandlers(messageHubData.hub, sessionManager, eventBus, {} as SpaceManager);
  });

  it('uses the bounded repository window and preserves its total', async () => {
    const handler = messageHubData.handlers.get('session.messages.byStatus');

    const result = (await handler!(
      { sessionId: 'session-1', status: 'consumed', limit: 2 },
      {}
    )) as {
      messages: Array<{
        dbId: string;
        uuid: string;
        timestamp: number;
        status: string;
        text: string;
      }>;
      total: number;
    };

    expect(getUserMessagesByStatus).toHaveBeenCalledWith('session-1', 'consumed', 2);
    expect(getMessagesByStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      messages: [
        {
          dbId: 'db-1',
          uuid: 'message-1',
          timestamp: 123,
          status: 'consumed',
          text: 'First\nSecond',
        },
      ],
      total: 42,
    });
  });

  it('defaults the bounded repository window to 20', async () => {
    const handler = messageHubData.handlers.get('session.messages.byStatus');

    await handler!({ sessionId: 'session-1', status: 'enqueued' }, {});

    expect(getUserMessagesByStatus).toHaveBeenCalledWith('session-1', 'enqueued', 20);
  });

  it.each([
    0,
    -1,
    1.5,
    1001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '20',
  ])('rejects invalid limit %p before accessing the session or database', async (limit) => {
    const handler = messageHubData.handlers.get('session.messages.byStatus');

    await expect(
      handler!({ sessionId: 'session-1', status: 'deferred', limit }, {})
    ).rejects.toThrow('Invalid limit: must be an integer between 1 and 1000');

    expect(getSessionAsync).not.toHaveBeenCalled();
    expect(getUserMessagesByStatus).not.toHaveBeenCalled();
  });

  it('rejects an invalid status before accessing the session or database', async () => {
    const handler = messageHubData.handlers.get('session.messages.byStatus');

    await expect(
      handler!({ sessionId: 'session-1', status: 'failed', limit: 20 }, {})
    ).rejects.toThrow('Invalid status');

    expect(getSessionAsync).not.toHaveBeenCalled();
    expect(getUserMessagesByStatus).not.toHaveBeenCalled();
  });
});

describe('Session RPC Handlers — models.list', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;

  function registerAvailableAnthropicProvider(): void {
    getProviderRegistry().register({
      id: 'anthropic',
      displayName: 'Anthropic',
      capabilities: {
        streaming: true,
        extendedThinking: true,
        thinkingModes: 'granular',
        maxContextWindow: 200000,
        functionCalling: true,
        vision: true,
      },
      isAvailable: () => true,
      getModels: async () => [
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
      ],
      ownsModel: () => true,
      getModelForTier: () => 'sonnet',
      buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
    } as Provider);
  }

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
    registerAvailableAnthropicProvider();
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
    registerAvailableAnthropicProvider();
    const handler = messageHubData.handlers.get('models.list');

    const result = (await handler!({ forceRefresh: true }, {})) as {
      models: Array<{ id: string; display_name: string }>;
      cached: boolean;
    };

    expect(result.models.length).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
  });

  it('returns models with cached=false when useCache is false', { timeout: 15_000 }, async () => {
    registerAvailableAnthropicProvider();
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

describe('Session RPC Handlers — session.update voice adoption', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;
  let sessionManager: {
    getSession: ReturnType<typeof mock>;
    getSessionFromDB: ReturnType<typeof mock>;
    updateSession: ReturnType<typeof mock>;
  };
  let existingPending: string | null;
  let existingDraft: string | null;
  let sessionExists: boolean;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    existingPending = null;
    existingDraft = null;
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

  it('clears the staged transcript when the write contains it (adoption)', async () => {
    existingPending = 'the voice text';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'my edits the voice text' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'my edits the voice text', inputDraftVoicePending: null },
    });
  });

  it('keeps the staged transcript when the write lacks it (cross-tab safety)', async () => {
    existingPending = 'the voice text';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'unaware tab typing' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'unaware tab typing' },
    });
  });

  it('adopts across a CJK composition boundary', async () => {
    existingPending = '世界';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: '你好世界' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: '你好世界', inputDraftVoicePending: null },
    });
  });

  it('clears typing only on an empty write while a draft was staged', async () => {
    existingPending = 'voice';
    existingDraft = 'typing';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: null } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null },
    });
  });

  it('keeps an UNSEEN staged transcript on an empty write over an already-empty draft', async () => {
    existingPending = 'voice';
    existingDraft = null;
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: null } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null },
    });
    expect(sessionManager.updateSession).toHaveBeenCalledTimes(1);
  });

  it('treats a whitespace-only write as a typing clear that keeps the staging', async () => {
    existingPending = 'voice';
    existingDraft = null;
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: '   ' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: '   ' },
    });
  });

  it('acknowledges with success only — no version or folded-value protocol', async () => {
    existingPending = 'voice';
    const handler = messageHubData.handlers.get('session.update');
    const result = (await handler!(
      { sessionId: 's1', metadata: { inputDraft: 'has voice' } },
      {}
    )) as Record<string, unknown>;
    expect(result).toEqual({ success: true });
  });

  it('leaves the staged transcript untouched on a metadata-only write (no inputDraft key)', async () => {
    existingPending = 'voice';
    existingDraft = 'typing';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { title: 'New title' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { title: 'New title' },
    });
  });

  it('consumes a MID-STRING coincidental containment (the documented trade-off)', async () => {
    existingPending = 'ok';
    existingDraft = 'typed';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'looks ok to me' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'looks ok to me', inputDraftVoicePending: null },
    });
  });

  it('adopts a trailing-whitespace transcript through a trimmed save', async () => {
    existingPending = 'hello';
    existingDraft = 'typed';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'typed hello' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'typed hello', inputDraftVoicePending: null },
    });
  });

  it('adopts a LEGACY untrimmed pending (staged by a pre-PR daemon) through a trimmed save', async () => {
    existingPending = 'hello ';
    existingDraft = 'typed';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'typed hello' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'typed hello', inputDraftVoicePending: null },
    });
  });

  it('no longer registers the retired reconciliation RPCs', async () => {
    expect(messageHubData.handlers.get('session.stripVoiceBaseline')).toBeUndefined();
    expect(messageHubData.handlers.get('session.mergeVoiceDraftBackup')).toBeUndefined();
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
  let sessionExists: boolean;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    existingPending = 'existing';
    existingAppendLog = null;
    sessionExists = true;
    sessionManager = {
      getSessionFromDB: mock(() =>
        sessionExists
          ? {
              id: 's1',
              metadata: {
                inputDraftVoicePending: existingPending,
                inputDraftVoiceAppendLog: existingAppendLog,
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

  it('appends with no leading space and no baseline snapshot when nothing is pending', async () => {
    existingPending = null;
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: 'hello' },
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

  it('stages whole at exactly the character limit and rejects one character over', async () => {
    existingPending = 'p'.repeat(99_994);
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello' }, {})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: `${'p'.repeat(99_994)} hello` },
    });
    existingPending = 'p'.repeat(99_995);
    await expect(handler!({ sessionId: 's1', text: 'hello' }, {})).rejects.toThrow(
      'Pending voice draft is at the character limit'
    );
  });

  it('normalizes a trailing-whitespace transcript at staging', async () => {
    existingPending = null;
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello  ' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: 'hello' },
    });
  });

  it('normalizes a legacy untrimmed pending when composing the next append', async () => {
    existingPending = '  spaced  ';
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'more' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: 'spaced more' },
    });
  });

  it('rejects a non-string dedupId before reading or writing', async () => {
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await expect(
      handler!({ sessionId: 's1', text: 'hello', dedupId: 42 as never }, {})
    ).rejects.toThrow('dedupId must be a string when provided');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('propagates a failed commit without announcing a landing or acking success', async () => {
    sessionManager.updateSession.mockImplementation(async () => {
      throw new Error('db locked');
    });
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await expect(handler!({ sessionId: 's1', text: 'hello' }, {})).rejects.toThrow('db locked');
    expect(
      messageHubData.hub.event.mock.calls.filter(([m]) => m === 'session.voiceLanded')
    ).toHaveLength(0);
  });

  it('prunes expired dedup-log entries on the next append', async () => {
    const ttlMs = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;
    existingAppendLog = [
      { id: 'expired', ts: Date.now() - ttlMs - 1_000 },
      { id: 'fresh', ts: Date.now() },
    ];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-2' }, {});
    const updates = sessionManager.updateSession.mock.calls[0]?.[1] as {
      metadata: { inputDraftVoiceAppendLog: Array<{ id: string; ts: number }> };
    };
    const ids = updates.metadata.inputDraftVoiceAppendLog.map((entry) => entry.id);
    expect(ids).toContain('fresh');
    expect(ids).toContain('entry-2');
    expect(ids).not.toContain('expired');
  });

  it('does not match a replayed dedupId whose log entry expired', async () => {
    const ttlMs = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;
    existingAppendLog = [{ id: 'entry-1', ts: Date.now() - ttlMs - 1_000 }];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-1' }, {})) as {
      success: boolean;
      deduped?: boolean;
    };
    expect(result.deduped).toBeUndefined();
    expect(sessionManager.updateSession).toHaveBeenCalled();
  });

  it('records the outbox dedupId alongside the append and announces the landing', async () => {
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-1' }, {})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    const updates = sessionManager.updateSession.mock.calls[0]?.[1] as {
      metadata: { inputDraftVoiceAppendLog: Array<{ id: string; ts: number }> };
    };
    expect(updates.metadata.inputDraftVoiceAppendLog).toHaveLength(1);
    expect(updates.metadata.inputDraftVoiceAppendLog[0].id).toBe('entry-1');
  });

  it('skips a deduped replay without writing or re-announcing the landing', async () => {
    existingAppendLog = [{ id: 'entry-1', ts: Date.now() }];
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello', dedupId: 'entry-1' }, {})) as {
      success: boolean;
      deduped?: boolean;
    };
    expect(result).toEqual({ success: true, deduped: true });
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
    expect(
      messageHubData.hub.event.mock.calls.filter(([m]) => m === 'session.voiceLanded')
    ).toHaveLength(0);
  });

  it('emits session.voiceLanded on the session channel after a genuine commit', async () => {
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello' }, {});
    expect(messageHubData.hub.event).toHaveBeenCalledWith(
      'session.voiceLanded',
      { sessionId: 's1' },
      { channel: 'session:s1' }
    );
  });

  it('does not announce a landing when the append is refused', async () => {
    existingPending = 'p'.repeat(100_000);
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await expect(handler!({ sessionId: 's1', text: 'more' }, {})).rejects.toThrow();
    expect(
      messageHubData.hub.event.mock.calls.filter(([m]) => m === 'session.voiceLanded')
    ).toHaveLength(0);
  });
});

describe('Session RPC Handlers — session.get voice composition', () => {
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

  it('presents the composition of draft and pending without persisting anything', async () => {
    const handler = await setup({
      inputDraft: 'existing',
      inputDraftVoicePending: 'hello world',
    });
    expect(handler).toBeDefined();
    const result = (await handler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string; inputDraftVoicePending: string } };
    };
    expect(result.session.metadata.inputDraft).toBe('existing hello world');
    expect(result.session.metadata.inputDraftVoicePending).toBe('hello world');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('composes across a CJK boundary with no separating space', async () => {
    const handler = await setup({ inputDraft: '你', inputDraftVoicePending: '世界' });
    const result = (await handler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string } };
    };
    expect(result.session.metadata.inputDraft).toBe('你世界');
  });

  it('returns the draft alone when there is no pending transcript', async () => {
    const handler = await setup({ inputDraft: 'existing' });
    const result = (await handler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string } };
    };
    expect(result.session.metadata.inputDraft).toBe('existing');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('ignores a whitespace-only pending transcript', async () => {
    const handler = await setup({ inputDraft: 'existing', inputDraftVoicePending: '   ' });
    const result = (await handler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string } };
    };
    expect(result.session.metadata.inputDraft).toBe('existing');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('returns the raw draft when the composition would not fit whole', async () => {
    const fullDraft = 'x'.repeat(100_000);
    const handler = await setup({ inputDraft: fullDraft, inputDraftVoicePending: 'hello' });
    const result = (await handler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string; inputDraftVoicePending: string } };
    };
    expect(result.session.metadata.inputDraft).toBe(fullDraft);
    expect(result.session.metadata.inputDraftVoicePending).toBe('hello');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('presents the composition at exactly the character limit and raw one over', async () => {
    const draft = 'x'.repeat(99_995);
    const handler = await setup({ inputDraft: draft, inputDraftVoicePending: 'abcd' });
    const result = (await handler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string } };
    };
    expect(result.session.metadata.inputDraft).toBe(`${draft} abcd`);
    expect(result.session.metadata.inputDraft.length).toBe(100_000);

    const overHandler = await setup({ inputDraft: `${draft}x`, inputDraftVoicePending: 'abcd' });
    const overResult = (await overHandler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string } };
    };
    expect(overResult.session.metadata.inputDraft).toBe(`${draft}x`);
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
  let persistedPending: string | null;

  beforeEach(async () => {
    messageHubData = createMockMessageHub();
    eventBus = createMockInternalEventBus();
    persistedDraft = 'snapshot';
    persistedPending = null;
    sessionManager = {
      getSessionFromDB: mock(() => ({
        id: 's1',
        metadata: { inputDraft: persistedDraft, inputDraftVoicePending: persistedPending },
      })),
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
      metadata: { inputDraft: null },
    });
  });

  it('keeps the staged transcript on a direct (typing-only) match', async () => {
    persistedDraft = 'snapshot';
    persistedPending = 'voice';
    const handler = messageHubData.handlers.get('session.clearInputDraftIf');
    const result = (await handler!({ sessionId: 's1', expected: 'snapshot' }, {})) as {
      cleared: boolean;
    };
    expect(result.cleared).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null },
    });
  });

  it('clears the staged transcript too on a composition match', async () => {
    persistedDraft = 'snapshot';
    persistedPending = 'voice';
    const handler = messageHubData.handlers.get('session.clearInputDraftIf');
    const result = (await handler!({ sessionId: 's1', expected: 'snapshot voice' }, {})) as {
      cleared: boolean;
    };
    expect(result.cleared).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null, inputDraftVoicePending: null },
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

  it('clears both on a voice-only composition match (the displayed-draft discard path)', async () => {
    persistedDraft = null;
    persistedPending = 'voice';
    const handler = messageHubData.handlers.get('session.clearInputDraftIf');
    const result = (await handler!({ sessionId: 's1', expected: 'voice' }, {})) as {
      cleared: boolean;
    };
    expect(result.cleared).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null, inputDraftVoicePending: null },
    });
  });
});
