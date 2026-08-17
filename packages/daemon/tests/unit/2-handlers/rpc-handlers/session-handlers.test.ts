/**
 * Unit tests for Session RPC Handlers — models.list empty-cache fallback
 *
 * These tests use real model-service functions with controlled cache state
 * to avoid mock.module cross-file contamination in the 2-handlers shard.
 *
 * NOTE: We avoid clearModelsCache() because other test files
 * install top-level mock.module on model-service.js that Bun does not
 * fully restore, leaving clearModelsCache as a no-op.  setModelsCache()
 * is unaffected, so we use setModelsCache(new Map()) to empty the cache.
 */

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

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
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

    // Fully reset provider and cache state so each test is isolated.
    // setModelsCache(new Map()) empties modelsCache and cacheTimestamps.
    setModelsCache(new Map());
    resetProviderRegistry();
    resetProviderFactory();

    // Import and set up handlers after cache is clean
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
    // Cache is empty because beforeEach calls setModelsCache(new Map())
    const handler = messageHubData.handlers.get('models.list');

    const result = (await handler!({ useCache: true }, {})) as {
      models: Array<{ id: string; display_name: string }>;
      cached: boolean;
    };

    // refreshModels() restores FALLBACK_MODELS when no providers are available
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

    // With no providers, refreshModels() restores FALLBACK_MODELS
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
  });

  it('returns models with cached=false when useCache is false', { timeout: 15_000 }, async () => {
    const handler = messageHubData.handlers.get('models.list');

    const result = (await handler!({ useCache: false }, {})) as {
      models: Array<{ id: string; display_name: string }>;
      cached: boolean;
    };

    // useCache: false is treated as forceRefresh
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
  });

  it('emits providers.changed when a stranded refresh recovers a missing provider', {
    timeout: 15_000,
  }, async () => {
    // A concurrent models.list caller that already returned the stale catalog
    // is claimed out of probing (the tried-set marks before awaiting), so it
    // won't trigger its own refresh. Broadcast providers.changed when the
    // refresh actually recovers a provider so that picker re-fetches.
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
    // Minimal provider mock. Each test uses a unique id so the module-level
    // retry tracking (which clearModelsCache can't reset in this contaminated
    // shard) never bleeds across tests.
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
      // Second call within the same cache lifetime must not re-probe (prevents a
      // refresh storm when getModels() persistently fails).
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
      // A stalled probe (e.g. local Ollama with an unreachable OLLAMA_BASE_URL
      // and no fetch timeout) must not block models.list — the probe is bounded
      // by a timeout and resolves to "unavailable". Short timeout keeps the
      // test fast.
      getProviderRegistry().register(
        mockProvider('stranded-hang', () => new Promise<boolean>(() => {}))
      );
      const stranded = await detectStrandedProviders(anthropicOnly, 50);
      expect(stranded).not.toContain('stranded-hang');
    });

    it('claims providers before probing so concurrent calls do not duplicate-probe', async () => {
      // The filter + mark run synchronously before the first await, so a second
      // concurrent detectStrandedProviders sees the providers as already
      // attempted and skips them — no duplicate probes or refresh fan-out.
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
    // The archive handler dynamically imports WorktreeManager to check for
    // commits-ahead. Intercept it so we can drive the requiresConfirmation path
    // deterministically without spinning up a real git repo.
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
      // Regression: the unconfirmed probe must not remove the session from its
      // Space. Previously the handler evicted membership before the confirmation
      // gate, so cancelling the dialog left an active session missing from its
      // Space permanently.
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

  // Task #861 item 3 — the session.messages.promotePending RPC (UI "promote
  // next-turn → current turn") routes through the durable owner under v2.
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
      // Seed one deferred user message.
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
        // Parse the sdk_message blob into an SDK message (+dbId) the way the real
        // SDKMessageRepository.getMessagesByStatus does, so isSDKUserMessage +
        // toReplayContent see the expected shape.
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

      // The deferred row was flipped to enqueued ...
      const row = db.prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`).get('db-1') as {
        send_status: string;
      };
      expect(row.send_status).toBe('enqueued');
      // ... and a durable turn job was enqueued for it (not the legacy inline feed).
      const job = db
        .prepare(
          `SELECT json_extract(payload, '$.role') AS role FROM job_queue WHERE queue = ? AND json_extract(payload, '$.messageUuid') = ?`
        )
        .get(MESSAGE_DELIVERY, 'promote-me') as { role: string };
      expect(job.role).toBe('turn');
    });
  });

  // Manual "Retry" affordance for a failed user message — reopens failed→
  // enqueued and re-enqueues the durable delivery job. Mirrors promotePending.
  describe('Session RPC Handlers — session.messages.retry (v2)', () => {
    let messageHubData: ReturnType<typeof createMockMessageHub>;
    let eventBus: ReturnType<typeof createMockInternalEventBus>;
    let db: Database;
    let jobQueue: JobQueueRepository;
    let v2Previous: string | undefined;
    /** Persisted session status returned by the mock db; defaults to active. */
    let sessionStatus: string;
    /** Hydration spy — terminal statuses must reject BEFORE hydrating (Codex P2). */
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
      // Seed one FAILED user message (a consumed-then-errored turn that exhausted).
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
        // terminal-status assertion (hydration must not happen at all there).
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

      // The failed row was reopened to enqueued ...
      const row = db
        .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
        .get('db-failed') as { send_status: string };
      expect(row.send_status).toBe('enqueued');
      // ... and a durable turn job was enqueued for it.
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
        // The session was never hydrated: constructing an AgentSession for an
        // evicted terminal session schedules the pending-message replay, which
        // enqueues delivery jobs for OTHER pending prompts (the archived
        // barrier does not cover `ended`). (Codex P2.)
        expect(hydrateSpy).not.toHaveBeenCalled();
        // The failed row was NOT reopened to enqueued.
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
    // The composer read the composed draft (typing + pending) and saved what
    // it saw — the transcript is now inside the written text, so the staging
    // is consumed in the same write.
    existingPending = 'the voice text';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'my edits the voice text' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'my edits the voice text', inputDraftVoicePending: null },
    });
  });

  it('keeps the staged transcript when the write lacks it (cross-tab safety)', async () => {
    // A tab that never re-read the draft (typing since before the landing)
    // must never be able to wipe a transcript it never saw.
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
    // A landing deferred by typing, then a send/clear inside the composer's
    // save debounce: the stored draft is empty because the typing was never
    // persisted — NOT because the composer showed a voice-only draft. The
    // empty write must clear typing only; a discard is expressed by the
    // composer that displayed the composition via session.clearInputDraftIf.
    // (Regression: the empty stored draft used to be read as a deliberate
    // voice-only discard, silently dropping transcripts no composer showed.)
    existingPending = 'voice';
    existingDraft = null;
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: null } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: null },
    });
    // And nothing else — the staging field is never touched by this write.
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
    // An unrelated metadata write (title, cost tracking, …) must never enter
    // the voice logic: the draftWrite gate is `!== undefined`, so a write
    // without an inputDraft key skips it entirely.
    existingPending = 'voice';
    existingDraft = 'typing';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { title: 'New title' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { title: 'New title' },
    });
  });

  it('consumes a MID-STRING coincidental containment (the documented trade-off)', async () => {
    // The containment needle may appear anywhere in the write, not only as a
    // suffix: this pins the documented coincidental-substring acceptance —
    // an endsWith/word-boundary tightening would break here while passing
    // every suffix-shaped adoption test above.
    existingPending = 'ok';
    existingDraft = 'typed';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'looks ok to me' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'looks ok to me', inputDraftVoicePending: null },
    });
  });

  it('adopts a trailing-whitespace transcript through a trimmed save', async () => {
    // appendVoiceDraft normalizes staging by trimming (STT output often
    // carries trailing whitespace), so the web's TRIMMED debounced saves can
    // still adopt: without the staging trim, '...hello' would never contain
    // 'hello ' and the transcript would duplicate on every read, unadoptable.
    existingPending = 'hello';
    existingDraft = 'typed';
    const handler = messageHubData.handlers.get('session.update');
    await handler!({ sessionId: 's1', metadata: { inputDraft: 'typed hello' } }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraft: 'typed hello', inputDraftVoicePending: null },
    });
  });

  it('adopts a LEGACY untrimmed pending (staged by a pre-PR daemon) through a trimmed save', async () => {
    // Values staged before staging normalized can carry surrounding
    // whitespace; the containment needle is trimmed so the web's trimmed
    // saves can still adopt them instead of duplicating on every read.
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
    // Writes the dedicated pending field — never the live inputDraft, which the
    // client's debounced saves could otherwise clobber.
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
    // 99_994 + 1 separator + 5 = 100_000 exactly: the boundary itself fits.
    existingPending = 'p'.repeat(99_994);
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    const result = (await handler!({ sessionId: 's1', text: 'hello' }, {})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: `${'p'.repeat(99_994)} hello` },
    });
    // One more character cannot fit whole.
    existingPending = 'p'.repeat(99_995);
    await expect(handler!({ sessionId: 's1', text: 'hello' }, {})).rejects.toThrow(
      'Pending voice draft is at the character limit'
    );
  });

  it('normalizes a trailing-whitespace transcript at staging', async () => {
    // STT output routinely carries trailing whitespace; the staging is
    // trimmed so the web's trimmed debounced saves can still adopt it.
    existingPending = null;
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'hello  ' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: 'hello' },
    });
  });

  it('normalizes a legacy untrimmed pending when composing the next append', async () => {
    // A pending staged by a pre-PR daemon can carry surrounding whitespace;
    // the next append trims it before joining so the stored value heals.
    existingPending = '  spaced  ';
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await handler!({ sessionId: 's1', text: 'more' }, {});
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', {
      metadata: { inputDraftVoicePending: 'spaced more' },
    });
  });

  it('rejects a non-string dedupId before reading or writing', async () => {
    // The dedup log's own type filter silently drops non-string ids, so an
    // unvalidated id would append once and double-append on replay — the
    // exact failure the log exists to prevent.
    const handler = messageHubData.handlers.get('session.appendVoiceDraft');
    await expect(
      handler!({ sessionId: 's1', text: 'hello', dedupId: 42 as never }, {})
    ).rejects.toThrow('dedupId must be a string when provided');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('propagates a failed commit without announcing a landing or acking success', async () => {
    // An acked-but-uncommitted entry would be dropped from the client outbox
    // (it believes delivery done), losing the transcript — the handler must
    // reject, emit no session.voiceLanded, and let the outbox retry.
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
    // The TTL filter keeps the metadata-resident append log bounded; deleting
    // it would grow the log without bound with nothing failing.
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
    // Outside the outbox retry lifetime (24h + slack), a replayed id is
    // unknown again: it appends rather than dedups.
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
    // PURE read: the pending stays staged; adoption consumes it, not the read.
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
    // Presenting a TRUNCATED composition would let a client save it back and
    // durably drop the transcript's tail — the draft alone is returned and
    // the pending waits for room.
    expect(result.session.metadata.inputDraft).toBe(fullDraft);
    expect(result.session.metadata.inputDraftVoicePending).toBe('hello');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('presents the composition at exactly the character limit and raw one over', async () => {
    // 99_995 + 1 separator + 4 = 100_000 exactly: the boundary composes whole.
    const draft = 'x'.repeat(99_995);
    const handler = await setup({ inputDraft: draft, inputDraftVoicePending: 'abcd' });
    const result = (await handler!({ sessionId: 's1' }, {})) as {
      session: { metadata: { inputDraft: string } };
    };
    expect(result.session.metadata.inputDraft).toBe(`${draft} abcd`);
    expect(result.session.metadata.inputDraft.length).toBe(100_000);

    // One character more would slice the tail off — the raw draft is returned.
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
    // The sender never saw the staged voice — it stays for the next draft.
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
    // The sender read the composed draft (typing + voice) and its message
    // carried both — the staging is consumed with the draft.
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
    // A composer that loaded the voice-only composition (empty stored draft,
    // pending alone) and was deliberately cleared: its clearInputDraftIf
    // matches the composition and consumes the staging atomically. This is
    // the ONLY path that discards a transcript the user saw — a bare empty
    // session.update clears typing only and can never wipe a staging.
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
