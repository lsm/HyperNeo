import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { CustomEndpointConfig, GlobalSettings } from '@hyperneo/shared';
import {
  registerCustomEndpointHandlers,
  clearModelListCache,
} from '../../../../src/lib/rpc-handlers/custom-endpoint-handlers';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

const syncCalls: Array<CustomEndpointConfig[] | undefined> = [];
mock.module('../../../../src/lib/providers/factory', () => ({
  syncCustomEndpointProviders: mock(async (configs: CustomEndpointConfig[] | undefined) => {
    syncCalls.push(configs);
  }),
}));

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
    clearModelListCache();
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

    it('sanitizes voice credentials in the settings.updated broadcast', async () => {
      settings = createMockSettings();
      (settings.state.settings as { voice?: { apiKey?: string } }).voice = {
        enabled: true,
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'whisper-1',
        apiKey: 'sk-leaked',
      };
      const published: Array<{ settings: GlobalSettings }> = [];
      const capturingBus = {
        publish: mock(async () => {}),
        publishAsync: mock((event: string, payload: { settings: GlobalSettings }) => {
          if (event === 'settings.updated') published.push(payload);
        }),
        subscribe: mock(() => () => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      registerCustomEndpointHandlers(hubData.hub, settings.manager, capturingBus);

      const handler = hubData.handlers.get('customEndpoints.add')!;
      await handler({ endpoint: validEndpoint }, {});

      expect(published).toHaveLength(1);
      expect(published[0].settings.voice?.apiKey).toBeUndefined();
      expect(published[0].settings.voice?.hasApiKey).toBe(true);
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
              type: 'bedrock' as unknown as 'openai-chat',
            },
          },
          {}
        )
      ).rejects.toThrow(/type 'bedrock' is invalid/);
    });

    it('accepts an in-range autoCompactPercent and rejects out-of-range values', async () => {
      const handler = hubData.handlers.get('customEndpoints.add')!;
      const withPercent = (pct: number) => ({
        endpoint: {
          ...validEndpoint,
          id: `pct-${pct}`,
          models: validEndpoint.models.map((m) => ({
            ...m,
            capabilities: { ...m.capabilities, autoCompactPercent: pct },
          })),
        },
      });
      await handler(withPercent(50), {});
      await handler(withPercent(90), {});
      await handler(withPercent(100), {});
      await expect(handler(withPercent(49), {})).rejects.toThrow(/autoCompactPercent/);
      await expect(handler(withPercent(101), {})).rejects.toThrow(/autoCompactPercent/);
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
      await Promise.all([add({ endpoint: a }, {}), add({ endpoint: b }, {})]);
      const ids = (settings.state.settings.customEndpoints ?? []).map((e) => e.id).sort();
      expect(ids).toEqual(['a', 'b']);
    });
  });

  describe('customEndpoints.listModels', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('fetches models from /v1/models for openai-chat', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4', object: 'model' },
            { id: 'gpt-3.5-turbo', object: 'model' },
          ],
        }),
      })) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const result = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        models: Array<{ id: string }>;
        fromCache: boolean;
      };
      expect(result.models).toHaveLength(2);
      expect(result.models[0].id).toBe('gpt-4');
      expect(result.fromCache).toBe(false);
    });

    it('fetches models from /api/tags for ollama-native', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          models: [{ name: 'llama2' }, { name: 'codellama', model: 'codellama:7b' }],
        }),
      })) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const result = (await handler(
        { baseUrl: 'http://localhost:11434', type: 'ollama-native' },
        {}
      )) as { models: Array<{ id: string }> };
      expect(result.models).toHaveLength(2);
      expect(result.models[0].id).toBe('llama2');
      expect(result.models[1].id).toBe('codellama');
    });

    it('returns cached results within 30s', async () => {
      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'm1', object: 'model' }],
          }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const first = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        fromCache: boolean;
      };
      expect(first.fromCache).toBe(false);
      expect(callCount).toBe(1);

      const second = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        fromCache: boolean;
      };
      expect(second.fromCache).toBe(true);
      expect(callCount).toBe(1);
    });

    it('bypasses a fresh cache entry when force is true', async () => {
      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            data: [{ id: `m${callCount}`, object: 'model' }],
          }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const first = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        fromCache: boolean;
      };
      expect(first.fromCache).toBe(false);
      expect(callCount).toBe(1);

      const forced = (await handler({ baseUrl: 'http://localhost:1234/v1', force: true }, {})) as {
        models: Array<{ id: string }>;
        fromCache: boolean;
      };
      expect(forced.fromCache).toBe(false);
      expect(callCount).toBe(2);
      expect(forced.models).toHaveLength(1);
      expect(forced.models[0].id).toBe('m2');
    });

    it('persists a forced refresh as the new cache entry', async () => {
      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            data: [{ id: `m${callCount}`, object: 'model' }],
          }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler({ baseUrl: 'http://localhost:1234/v1' }, {});
      await handler({ baseUrl: 'http://localhost:1234/v1', force: true }, {});

      const afterForce = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        models: Array<{ id: string }>;
        fromCache: boolean;
      };
      expect(afterForce.fromCache).toBe(true);
      expect(callCount).toBe(2);
      expect(afterForce.models[0].id).toBe('m2');
    });

    it('propagates fetch failures under force instead of serving the fresh cache', async () => {
      let fail = false;
      global.fetch = mock(async () => {
        if (fail) throw new Error('Connection refused');
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'm1', object: 'model' }],
          }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const first = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        fromCache: boolean;
      };
      expect(first.fromCache).toBe(false);

      fail = true;
      await expect(
        handler({ baseUrl: 'http://localhost:1234/v1', force: true }, {})
      ).rejects.toThrow(/Connection refused/);
    });

    it('throws on HTTP error', async () => {
      global.fetch = mock(async () => ({
        ok: false,
        status: 401,
      })) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await expect(handler({ baseUrl: 'http://localhost:1234/v1' }, {})).rejects.toThrow(
        /HTTP 401/
      );
    });

    it('throws on network/timeout errors', async () => {
      global.fetch = mock(async () => {
        throw new Error('Connection refused');
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await expect(handler({ baseUrl: 'http://localhost:1234/v1' }, {})).rejects.toThrow(
        /Connection refused/
      );
    });

    it('rejects invalid baseUrl', async () => {
      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await expect(handler({ baseUrl: '' }, {})).rejects.toThrow(/baseUrl is required/);
      await expect(handler({ baseUrl: 'ftp://nope' }, {})).rejects.toThrow(/http/);
    });

    it('includes Authorization and extra headers', async () => {
      let capturedHeaders: Record<string, string> = {};
      global.fetch = mock(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        capturedHeaders = init?.headers ?? {};
        return {
          ok: true,
          json: async () => ({ data: [] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler(
        {
          baseUrl: 'http://localhost:1234/v1',
          apiKey: 'sk-test',
          headers: { 'X-Custom': 'val' },
        },
        {}
      );
      expect(capturedHeaders.Authorization).toBe('Bearer sk-test');
      expect(capturedHeaders['X-Custom']).toBe('val');
    });

    it('filters out entries with missing ids', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: 'valid', object: 'model' },
            { id: '', object: 'model' },
            { object: 'model' },
          ],
        }),
      })) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const result = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        models: Array<{ id: string }>;
      };
      expect(result.models).toHaveLength(1);
      expect(result.models[0].id).toBe('valid');
    });

    it('does not double-append /v1 when baseUrl already ends in /v1', async () => {
      let capturedUrl = '';
      global.fetch = mock(async (url: unknown) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'm1', object: 'model' }] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler({ baseUrl: 'http://localhost:1234/v1' }, {});
      expect(capturedUrl).toBe('http://localhost:1234/v1/models');
    });

    it('strips /v1/models from baseUrl before appending', async () => {
      let capturedUrl = '';
      global.fetch = mock(async (url: unknown) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'm1', object: 'model' }] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler({ baseUrl: 'http://localhost:1234/v1/models' }, {});
      expect(capturedUrl).toBe('http://localhost:1234/v1/models');
    });

    it('strips /chat/completions from baseUrl before appending', async () => {
      let capturedUrl = '';
      global.fetch = mock(async (url: unknown) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'm1', object: 'model' }] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler({ baseUrl: 'http://localhost:1234/v1/chat/completions' }, {});
      expect(capturedUrl).toBe('http://localhost:1234/v1/models');
    });

    it('derives model from Azure deployment URL without probing', async () => {
      let fetchCalled = false;
      global.fetch = mock(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ data: [] }) };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const result = (await handler(
        {
          baseUrl:
            'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview',
        },
        {}
      )) as { models: Array<{ id: string }>; fromCache: boolean };
      expect(result.models).toHaveLength(1);
      expect(result.models[0].id).toBe('gpt-4o');
      expect(result.fromCache).toBe(false);
      expect(fetchCalled).toBe(false);
    });

    it('derives model from Azure deployment baseUrl without chat suffix', async () => {
      let fetchCalled = false;
      global.fetch = mock(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ data: [] }) };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const result = (await handler(
        {
          baseUrl:
            'https://my-resource.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-08-01-preview',
        },
        {}
      )) as { models: Array<{ id: string }> };
      expect(result.models).toHaveLength(1);
      expect(result.models[0].id).toBe('gpt-4o');
      expect(fetchCalled).toBe(false);
    });

    it('strips /api/chat from ollama baseUrl before appending', async () => {
      let capturedUrl = '';
      global.fetch = mock(async (url: unknown) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ models: [{ name: 'llama2' }] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler({ baseUrl: 'http://localhost:11434/api/chat', type: 'ollama-native' }, {});
      expect(capturedUrl).toBe('http://localhost:11434/api/tags');
    });

    it('strips /v1/messages from anthropic baseUrl before appending', async () => {
      let capturedUrl = '';
      global.fetch = mock(async (url: unknown) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ data: [] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler(
        { baseUrl: 'http://localhost:1234/v1/messages', type: 'anthropic-messages' },
        {}
      );
      expect(capturedUrl).toBe('http://localhost:1234/v1/models');
    });

    it('strips /v1/messages/count_tokens from anthropic baseUrl before appending', async () => {
      let capturedUrl = '';
      global.fetch = mock(async (url: unknown) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ data: [] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler(
        {
          baseUrl: 'http://localhost:1234/v1/messages/count_tokens',
          type: 'anthropic-messages',
        },
        {}
      );
      expect(capturedUrl).toBe('http://localhost:1234/v1/models');
    });

    it('accepts anthropic-messages model objects with type and display_name', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-4-5', type: 'model', display_name: 'Claude Sonnet 4.5' },
            { id: 'claude-opus-4-5', object: 'model' },
            { id: 'skipped', type: 'unknown' },
          ],
        }),
      })) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const result = (await handler(
        { baseUrl: 'http://localhost:1234/v1', type: 'anthropic-messages' },
        {}
      )) as { models: Array<{ id: string; name?: string }> };
      expect(result.models).toHaveLength(2);
      expect(result.models[0].id).toBe('claude-sonnet-4-5');
      expect(result.models[0].name).toBe('Claude Sonnet 4.5');
      expect(result.models[1].id).toBe('claude-opus-4-5');
    });

    it('sends anthropic auth headers for anthropic-messages endpoints', async () => {
      let capturedHeaders: Record<string, string> = {};
      global.fetch = mock(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        capturedHeaders = init?.headers ?? {};
        return {
          ok: true,
          json: async () => ({ data: [] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler(
        {
          baseUrl: 'http://localhost:1234/v1',
          type: 'anthropic-messages',
          apiKey: 'sk-ant',
        },
        {}
      );
      expect(capturedHeaders.Authorization).toBe('Bearer sk-ant');
      expect(capturedHeaders['x-api-key']).toBe('sk-ant');
      expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    });

    it('sends anthropic-version even without apiKey for anthropic-messages', async () => {
      let capturedHeaders: Record<string, string> = {};
      global.fetch = mock(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        capturedHeaders = init?.headers ?? {};
        return {
          ok: true,
          json: async () => ({ data: [] }),
        };
      }) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      await handler(
        {
          baseUrl: 'http://localhost:1234/v1',
          type: 'anthropic-messages',
          headers: { 'x-api-key': 'from-headers' },
        },
        {}
      );
      expect(capturedHeaders.Authorization).toBeUndefined();
      expect(capturedHeaders['x-api-key']).toBe('from-headers');
      expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    });

    it('accepts openai entries that omit the object field', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4' },
            { id: 'gpt-3.5-turbo', object: 'model' },
            { id: 'skipped', object: 'fine-tune' },
          ],
        }),
      })) as unknown as typeof fetch;

      const handler = hubData.handlers.get('customEndpoints.listModels')!;
      const result = (await handler({ baseUrl: 'http://localhost:1234/v1' }, {})) as {
        models: Array<{ id: string }>;
      };
      expect(result.models).toHaveLength(2);
      expect(result.models.map((m) => m.id)).toContain('gpt-4');
      expect(result.models.map((m) => m.id)).toContain('gpt-3.5-turbo');
    });
  });
});
