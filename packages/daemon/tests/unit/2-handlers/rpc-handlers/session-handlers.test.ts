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

import { describe, expect, it, beforeEach, mock } from 'bun:test';
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
});
