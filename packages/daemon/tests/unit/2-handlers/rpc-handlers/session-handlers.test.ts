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
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { setModelsCache } from '../../../../src/lib/model-service.js';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';

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

  beforeEach(async () => {
    messageHubData = createMockMessageHub();

    // Fully reset provider and cache state so each test is isolated.
    // setModelsCache(new Map()) empties modelsCache and cacheTimestamps.
    setModelsCache(new Map());
    resetProviderRegistry();
    resetProviderFactory();

    // Import and set up handlers after cache is clean
    const { setupSessionHandlers } = await import(
      '../../../../src/lib/rpc-handlers/session-handlers'
    );
    setupSessionHandlers(
      messageHubData.hub,
      {} as SessionManager,
      {} as DaemonHub,
      {} as SpaceManager
    );
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

  it(
    'triggers fallback refresh when cache is empty and useCache is true',
    async () => {
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
    },
    { timeout: 15_000 }
  );

  it(
    'returns models with cached=false when forceRefresh is true',
    async () => {
      const handler = messageHubData.handlers.get('models.list');

      const result = (await handler!({ forceRefresh: true }, {})) as {
        models: Array<{ id: string; display_name: string }>;
        cached: boolean;
      };

      // With no providers, refreshModels() restores FALLBACK_MODELS
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.cached).toBe(false);
    },
    { timeout: 15_000 }
  );

  it(
    'returns models with cached=false when useCache is false',
    async () => {
      const handler = messageHubData.handlers.get('models.list');

      const result = (await handler!({ useCache: false }, {})) as {
        models: Array<{ id: string; display_name: string }>;
        cached: boolean;
      };

      // useCache: false is treated as forceRefresh
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.cached).toBe(false);
    },
    { timeout: 15_000 }
  );
});
