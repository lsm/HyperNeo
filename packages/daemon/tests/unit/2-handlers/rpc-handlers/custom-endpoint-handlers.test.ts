/**
 * Tests for Custom Endpoint RPC handlers.
 *
 * Verifies validation, persistence, and provider registry sync for the
 * customEndpoints.list / add / update / remove handlers.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { CustomEndpointConfig, GlobalSettings } from '@neokai/shared';
import { registerCustomEndpointHandlers } from '../../../../src/lib/rpc-handlers/custom-endpoint-handlers';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

// Capture sync calls so each test can assert that the provider registry was
// re-synced with the latest list of endpoints.
const syncCalls: Array<CustomEndpointConfig[] | undefined> = [];
mock.module('../../../../src/lib/providers/factory', () => ({
  syncCustomEndpointProviders: mock(async (configs: CustomEndpointConfig[] | undefined) => {
    syncCalls.push(configs);
  }),
}));

// Track model-cache invalidations so we can assert mutations clear stale data.
const clearModelsCacheCalls: Array<string | undefined> = [];
mock.module('../../../../src/lib/model-service', () => ({
  clearModelsCache: mock((cacheKey?: string) => {
    clearModelsCacheCalls.push(cacheKey);
  }),
}));

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockSettings(initial: CustomEndpointConfig[] = []): {
  manager: SettingsManager;
  state: { settings: GlobalSettings };
} {
  const state = {
    settings: { customEndpoints: initial } as unknown as GlobalSettings,
  };
  const manager = {
    getGlobalSettings: mock(() => state.settings),
    updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => {
      state.settings = { ...state.settings, ...updates } as GlobalSettings;
      return state.settings;
    }),
  } as unknown as SettingsManager;
  return { manager, state };
}

const validEndpoint: CustomEndpointConfig = {
  id: 'lmstudio',
  name: 'LM Studio Local',
  baseUrl: 'http://localhost:1234/v1',
  models: [{ id: 'qwen2.5-7b' }],
};

describe('Custom Endpoint RPC handlers', () => {
  let hubData: ReturnType<typeof createMockMessageHub>;
  let settings: ReturnType<typeof createMockSettings>;
  let eventBus: InternalEventBus<DaemonInternalEventMap>;

  beforeEach(() => {
    syncCalls.splice(0);
    clearModelsCacheCalls.splice(0);
    hubData = createMockMessageHub();
    settings = createMockSettings();
    eventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>;
    registerCustomEndpointHandlers(hubData.hub, settings.manager, eventBus);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('customEndpoints.list', () => {
    it('returns an empty list when none are configured', async () => {
      const handler = hubData.handlers.get('customEndpoints.list')!;
      const result = (await handler({}, {})) as { endpoints: CustomEndpointConfig[] };
      expect(result.endpoints).toEqual([]);
    });

    it('returns configured endpoints', async () => {
      settings = createMockSettings([validEndpoint]);
      registerCustomEndpointHandlers(hubData.hub, settings.manager, eventBus);
      const handler = hubData.handlers.get('customEndpoints.list')!;
      const result = (await handler({}, {})) as { endpoints: CustomEndpointConfig[] };
      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].id).toBe('lmstudio');
    });
  });

  describe('customEndpoints.add', () => {
    it('appends a new endpoint, persists, and syncs the registry', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await handler({ endpoint: validEndpoint }, {});
      expect(settings.state.settings.customEndpoints).toEqual([validEndpoint]);
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0]).toEqual([validEndpoint]);
    });

    it('rejects duplicates by id', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await handler({ endpoint: validEndpoint }, {});
      await expect(handler({ endpoint: validEndpoint }, {})).rejects.toThrow(/already exists/);
    });

    it('rejects invalid baseUrl', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await expect(
        handler({ endpoint: { ...validEndpoint, baseUrl: 'ftp://nope' } }, {})
      ).rejects.toThrow(/baseUrl/);
    });

    it('rejects endpoints without models', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await expect(handler({ endpoint: { ...validEndpoint, models: [] } }, {})).rejects.toThrow(
        /at least one model/
      );
    });

    it('rejects ids with invalid characters', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await expect(handler({ endpoint: { ...validEndpoint, id: 'bad/id' } }, {})).rejects.toThrow(
        /invalid/
      );
    });

    it('rejects unknown endpoint type values', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await expect(
        handler(
          {
            endpoint: {
              ...validEndpoint,
              // `bedrock` isn't one of the three supported upstream surfaces;
              // must be rejected before persistence or registry sync so we
              // don't store a config the factory can't dispatch on.
              type: 'bedrock' as unknown as 'openai-chat',
            },
          },
          {}
        )
      ).rejects.toThrow(/type 'bedrock' is invalid/);
    });

    it('accepts the three supported endpoint types', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await handler({ endpoint: { ...validEndpoint, id: 'a', type: 'openai-chat' } }, {});
      await handler(
        {
          endpoint: {
            ...validEndpoint,
            id: 'b',
            type: 'anthropic-messages',
          },
        },
        {}
      );
      await handler({ endpoint: { ...validEndpoint, id: 'c', type: 'ollama-native' } }, {});
      const ids = (settings.state.settings.customEndpoints ?? []).map((e) => e.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('rejects defaultModelId that does not match any model', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await expect(
        handler({ endpoint: { ...validEndpoint, defaultModelId: 'unknown' } }, {})
      ).rejects.toThrow(/defaultModelId/);
    });
  });

  describe('customEndpoints.update', () => {
    beforeEach(async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await handler({ endpoint: validEndpoint }, {});
    });

    it('replaces the matching entry', async () => {
      const handler = hubData.handlers.get('customEndpoints.update')!;
      const updated = { ...validEndpoint, name: 'Renamed' };
      await handler({ endpoint: updated }, {});
      expect(settings.state.settings.customEndpoints?.[0].name).toBe('Renamed');
      expect(syncCalls.at(-1)).toEqual([updated]);
    });

    it('rejects updates for unknown ids', async () => {
      const handler = hubData.handlers.get('customEndpoints.update')!;
      await expect(handler({ endpoint: { ...validEndpoint, id: 'missing' } }, {})).rejects.toThrow(
        /not found/
      );
    });
  });

  describe('customEndpoints.remove', () => {
    beforeEach(async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      await handler({ endpoint: validEndpoint }, {});
    });

    it('removes a configured endpoint and re-syncs', async () => {
      const handler = hubData.handlers.get('customEndpoints.remove')!;
      await handler({ id: 'lmstudio' }, {});
      expect(settings.state.settings.customEndpoints).toEqual([]);
      expect(syncCalls.at(-1)).toEqual([]);
    });

    it('rejects removal of unknown ids', async () => {
      const handler = hubData.handlers.get('customEndpoints.remove')!;
      await expect(handler({ id: 'missing' }, {})).rejects.toThrow(/not found/);
    });
  });

  describe('cache invalidation', () => {
    it('clears the global models cache after each successful mutation', async () => {
      const add = hubData.handlers.get('customEndpoints.add')!;
      await add({ endpoint: validEndpoint }, {});
      const cacheCountAfterAdd = clearModelsCacheCalls.length;
      expect(cacheCountAfterAdd).toBeGreaterThanOrEqual(1);

      const update = hubData.handlers.get('customEndpoints.update')!;
      await update({ endpoint: { ...validEndpoint, name: 'Renamed' } }, {});
      expect(clearModelsCacheCalls.length).toBeGreaterThan(cacheCountAfterAdd);

      const remove = hubData.handlers.get('customEndpoints.remove')!;
      await remove({ id: validEndpoint.id }, {});
      expect(clearModelsCacheCalls.length).toBeGreaterThan(cacheCountAfterAdd + 1);
    });
  });

  describe('concurrent mutation safety', () => {
    it('serialises concurrent add calls so no entry is lost', async () => {
      const add = hubData.handlers.get('customEndpoints.add')!;
      const a = { ...validEndpoint, id: 'a', name: 'A' };
      const b = { ...validEndpoint, id: 'b', name: 'B' };
      // Fire both adds without awaiting between them. Without locking the
      // second add would read the same pre-update array as the first and
      // overwrite it on persist.
      await Promise.all([add({ endpoint: a }, {}), add({ endpoint: b }, {})]);
      const ids = (settings.state.settings.customEndpoints ?? []).map((e) => e.id).sort();
      expect(ids).toEqual(['a', 'b']);
    });
  });
});
