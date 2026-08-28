import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import {
  setupProviderHandlers,
  resolveCredentialsForHydration,
} from '../../../../src/lib/rpc-handlers/provider-handlers';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { GlmProvider } from '../../../../src/lib/providers/glm-provider';
import { AcpProvider } from '../../../../src/lib/providers/acp-provider';
import {
  clearModelsCache,
  getModelsCache,
  hasRefreshBeenAttemptedFor,
  markRefreshAttemptedFor,
  setModelsCache,
} from '../../../../src/lib/model-service';
import {
  getProviderFailure,
  recordClassifiedProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';
import { detectStrandedProviders } from '../../../../src/lib/rpc-handlers/session-handlers';
import type { ProviderRepository } from '../../../../src/storage/repositories/provider-repository';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import { KeychainUnavailableError } from '../../../../src/lib/credentials/credential-store';
import type { ProviderRecord, CreateProviderParams, ModelInfo } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

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

function createMockProviderRepo(): ProviderRepository {
  const records = new Map<string, ProviderRecord>();
  let nextId = 1;

  return {
    listProviders: () => Array.from(records.values()).sort((a, b) => a.sortOrder - b.sortOrder),
    listEnabledProviders: () =>
      Array.from(records.values())
        .filter((r) => r.isEnabled)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    getProvider: (id: string) => records.get(id) ?? null,
    getProviderByProviderId: (providerId: string) =>
      Array.from(records.values()).find((r) => r.providerId === providerId) ?? null,
    isProviderIdTaken: (providerId: string) =>
      Array.from(records.values()).some((r) => r.providerId === providerId),
    createProvider: (params: CreateProviderParams) => {
      const id = String(nextId++);
      const now = Date.now();
      const record: ProviderRecord = {
        id,
        providerId: params.providerId,
        displayName: params.displayName,
        kind: params.kind,
        authType: params.authType,
        isEnabled: params.isEnabled ?? true,
        isDefault: params.isDefault ?? false,
        sortOrder: params.sortOrder ?? 0,
        baseUrl: params.baseUrl,
        configJson: params.configJson,
        customEndpointConfigJson: params.customEndpointConfigJson,
        healthStatus: 'unknown',
        createdAt: now,
        updatedAt: now,
      };
      records.set(id, record);
      return record;
    },
    updateProvider: (id: string, params) => {
      const existing = records.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...params, updatedAt: Date.now() };
      records.set(id, updated);
      return updated;
    },
    deleteProvider: (id: string) => {
      return records.delete(id);
    },
    setDefaultProvider: (id: string) => {
      for (const r of records.values()) {
        r.isDefault = r.id === id;
      }
    },
    countProviders: () => records.size,
  } as unknown as ProviderRepository;
}

function createMockCredentialManager(): ProviderCredentialManager {
  const store = new Map<string, string>();
  return {
    storeApiKey: mock(async (providerId: string, apiKey: string) => {
      store.set(providerId, apiKey);
    }),
    storeOAuthTokens: mock(async (providerId: string, tokens: object) => {
      store.set(providerId, JSON.stringify(tokens));
    }),
    getCredentials: mock(async (providerId: string) => {
      const raw = store.get(providerId);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.accessToken !== undefined) {
          return { type: 'oauth' as const, accessToken: parsed.accessToken };
        }
      } catch {}
      return { type: 'api_key' as const, apiKey: raw };
    }),
    removeCredentials: mock(async (providerId: string) => {
      store.delete(providerId);
    }),
    migrateFromEnv: mock(async () => false),
  } as unknown as ProviderCredentialManager;
}

describe('Provider RPC handlers', () => {
  let hubData: ReturnType<typeof createMockMessageHub>;
  let repo: ReturnType<typeof createMockProviderRepo>;
  let creds: ReturnType<typeof createMockCredentialManager>;
  let eventBus: ReturnType<typeof createMockInternalEventBus>;

  beforeEach(() => {
    hubData = createMockMessageHub();
    repo = createMockProviderRepo();
    creds = createMockCredentialManager();
    eventBus = createMockInternalEventBus();
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
    clearModelsCache();
  });

  function setup(): Map<string, RequestHandler> {
    setupProviderHandlers({
      messageHub: hubData.hub,
      providerRepo: repo,
      credentialManager: creds,
      internalEventBus: eventBus,
    });
    return hubData.handlers;
  }

  describe('providers.list', () => {
    it('returns empty array when no providers', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.list')!({}, {})) as {
        providers: ProviderRecord[];
      };
      expect(result.providers).toEqual([]);
    });

    it('returns providers with availability', async () => {
      repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.list')!({}, {})) as {
        providers: Array<ProviderRecord & { available: boolean }>;
      };
      expect(result.providers.length).toBe(1);
      expect(result.providers[0].providerId).toBe('anthropic');
    });

    it('marks a throwing provider unavailable instead of failing the whole listing', async () => {
      const healthy = repo.createProvider({
        providerId: 'probe-ok',
        displayName: 'Probe OK',
        kind: 'built_in',
        authType: 'api_key',
      });
      const broken = repo.createProvider({
        providerId: 'probe-broken',
        displayName: 'Probe Broken',
        kind: 'built_in',
        authType: 'api_key',
      });
      getProviderRegistry().register({
        id: 'probe-ok',
        displayName: 'Probe OK',
        isAvailable: mock(async () => true),
      } as Provider);
      getProviderRegistry().register({
        id: 'probe-broken',
        displayName: 'Probe Broken',
        isAvailable: mock(async () => {
          throw new Error('probe exploded');
        }),
      } as Provider);
      const handlers = setup();

      const result = (await handlers.get('providers.list')!({}, {})) as {
        providers: Array<ProviderRecord & { available: boolean }>;
      };

      expect(result.providers).toHaveLength(2);
      const ok = result.providers.find((p) => p.id === healthy.id);
      const failed = result.providers.find((p) => p.id === broken.id);
      expect(ok?.available).toBe(true);
      expect(failed?.available).toBe(false);
    });
  });

  describe('providers.listRemoteModels', () => {
    it('routes options through the provider capability and returns curation candidates', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
      });
      const listRemoteModels = mock(async () => [
        {
          id: 'remote-model',
          name: 'Remote Model',
          alias: 'remote',
          family: 'remote',
          provider: 'remote',
          contextWindow: 1000,
          description: 'Remote model',
          releaseDate: '2026-01-01',
          available: true,
        },
      ]);
      getProviderRegistry().register({
        id: 'remote',
        listRemoteModels,
      } as unknown as Provider);
      const handlers = setup();

      const result = await handlers.get('providers.listRemoteModels')!(
        { id: created.id, options: { force: true, baseUrl: ' https://models.example/v1 ' } },
        {}
      );

      expect(listRemoteModels).toHaveBeenCalledWith({
        force: true,
        baseUrl: 'https://models.example/v1',
      });
      expect(result).toEqual({ models: [{ id: 'remote-model', name: 'Remote Model' }] });
    });

    it('rejects unknown, unregistered, and unsupported providers', async () => {
      const unregistered = repo.createProvider({
        providerId: 'unregistered',
        displayName: 'Unregistered',
        kind: 'built_in',
        authType: 'none',
      });
      const unsupported = repo.createProvider({
        providerId: 'unsupported',
        displayName: 'Unsupported',
        kind: 'built_in',
        authType: 'none',
      });
      getProviderRegistry().register({ id: 'unsupported' } as Provider);
      const handlers = setup();
      const handler = handlers.get('providers.listRemoteModels')!;

      await expect(handler({ id: 'missing' }, {})).rejects.toThrow('Provider missing not found');
      await expect(handler({ id: unregistered.id }, {})).rejects.toThrow(
        'Provider unregistered is not registered'
      );
      await expect(handler({ id: unsupported.id }, {})).rejects.toThrow(
        'Provider unsupported does not support remote model listing'
      );
    });

    it.each([
      [null, 'Invalid remote model request'],
      [{}, 'Provider id is required'],
      [{ id: 'provider', extra: true }, 'Unknown remote model request field: extra'],
      [{ id: 'provider', options: null }, 'Remote model options must be an object'],
      [{ id: 'provider', options: { extra: true } }, 'Unknown remote model option: extra'],
      [{ id: 'provider', options: { force: 'yes' } }, 'force must be a boolean'],
      [{ id: 'provider', options: { command: 42 } }, 'ACP command must be a string'],
      [{ id: 'provider', options: { command: '   ' } }, 'ACP command is required'],
      [
        { id: 'provider', options: { command: 'x'.repeat(64 * 1024 + 1) } },
        'ACP command must be ≤ 65536 chars',
      ],
      [{ id: 'provider', options: { baseUrl: 42 } }, 'baseUrl must be a string'],
      [
        { id: 'provider', options: { baseUrl: `https://${'x'.repeat(2048)}` } },
        'baseUrl must be ≤ 2048 chars',
      ],
      [{ id: 'provider', options: { baseUrl: 'not a URL' } }, 'Invalid baseUrl'],
      [
        { id: 'provider', options: { baseUrl: 'file:///tmp/models' } },
        'baseUrl must use http:// or https://',
      ],
    ])('rejects invalid request %#', async (data: unknown, error: string) => {
      const created = repo.createProvider({
        providerId: 'provider',
        displayName: 'Provider',
        kind: 'built_in',
        authType: 'none',
      });
      const handlers = setup();
      const request =
        data && typeof data === 'object' && !Array.isArray(data) && 'id' in data
          ? { ...(data as Record<string, unknown>), id: created.id }
          : data;

      await expect(handlers.get('providers.listRemoteModels')!(request, {})).rejects.toThrow(error);
    });

    it('rejects provider-inappropriate options before discovery', async () => {
      const acp = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
      });
      const remote = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      const listRemoteModels = mock(async () => [] as ModelInfo[]);
      getProviderRegistry().register({ id: 'remote', listRemoteModels } as unknown as Provider);
      const handlers = setup();
      const handler = handlers.get('providers.listRemoteModels')!;

      await expect(
        handler({ id: acp.id, options: { baseUrl: 'https://models.example' } }, {})
      ).rejects.toThrow('baseUrl is not supported for ACP providers');
      await expect(
        handler({ id: remote.id, options: { command: 'devin acp' } }, {})
      ).rejects.toThrow('command is only supported for ACP providers');
      expect(listRemoteModels).not.toHaveBeenCalled();
    });

    it('preserves ACP override parity and leaves saved and cached state unchanged', async () => {
      const fixture = `${process.execPath} ${process.cwd()}/tests/fixtures/mock-acp-server.ts`;
      const created = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      const provider = new AcpProvider({}, async () => {});
      provider.setAcpCommand('registered acp');
      provider.setCachedModels([
        {
          id: 'acp-cached',
          name: 'ACP Cached',
          alias: 'acp-cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          description: 'Cached ACP model',
          releaseDate: '2026-01-01',
          available: true,
        },
      ]);
      getProviderRegistry().register(provider);
      const globalModels: ModelInfo[] = [
        {
          id: 'global-cached',
          name: 'Global Cached',
          alias: 'global-cached',
          family: 'anthropic',
          provider: 'anthropic',
          contextWindow: 100000,
          description: 'Cached global model',
          releaseDate: '2026-01-01',
          available: true,
        },
      ];
      setModelsCache(new Map([['global', globalModels]]));
      const handlers = setup();

      const canonical = await handlers.get('providers.listRemoteModels')!(
        { id: created.id, options: { command: `  ${fixture}  ` } },
        {}
      );
      const legacy = await handlers.get('providers.fetchAcpModels')!(
        { id: created.id, command: fixture },
        {}
      );

      expect(canonical).toEqual({ models: [{ id: 'default', name: 'Default' }] });
      expect(legacy).toEqual(canonical);
      expect(repo.getProvider(created.id)?.configJson).toBe(created.configJson);
      expect(provider.getAcpCommand()).toBe('registered acp');
      expect(provider.getCachedModels()?.map((model) => model.id)).toEqual(['acp-cached']);
      expect(getModelsCache().get('global')).toEqual(globalModels);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('uses persisted and explicit environment commands through the canonical route', async () => {
      const originalCommand = process.env.HYPERNEO_ACP_COMMAND;
      process.env.HYPERNEO_ACP_COMMAND = 'hyperneo-env-acp-binary';
      const created = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'hyperneo-saved-acp-binary' }),
      });
      const handlers = setup();
      const handler = handlers.get('providers.listRemoteModels')!;

      try {
        await expect(handler({ id: created.id }, {})).rejects.toThrow('hyperneo-saved-acp-binary');
        await expect(handler({ id: created.id, options: { command: '' } }, {})).rejects.toThrow(
          'hyperneo-env-acp-binary'
        );
      } finally {
        if (originalCommand === undefined) delete process.env.HYPERNEO_ACP_COMMAND;
        else process.env.HYPERNEO_ACP_COMMAND = originalCommand;
      }
    });
  });

  describe('providers.refreshDiscovery', () => {
    afterEach(() => {
      resetProviderFailureStore();
    });

    function makeDiscoveredModel(id: string, name?: string): ModelInfo {
      return {
        id,
        name: name ?? id,
        alias: id,
        family: 'remote',
        provider: 'remote',
        contextWindow: 100000,
        description: `${id} discovered remotely`,
        releaseDate: '2026-01-01',
        available: true,
      };
    }

    function registerRemoteProvider(
      overrides: {
        listRemoteModels?: () => Promise<ModelInfo[]>;
        getModels?: () => Promise<ModelInfo[]>;
        getDiscoveryEndpointFingerprint?: (discoveryBaseUrl?: string) => string;
      } = {}
    ): { listRemoteModels: ReturnType<typeof mock>; getModels: ReturnType<typeof mock> } {
      const listRemoteModels = mock(overrides.listRemoteModels ?? (async () => []));
      const getModels = mock(overrides.getModels ?? (async () => []));
      getProviderRegistry().register({
        id: 'remote',
        isAvailable: async () => true,
        listRemoteModels,
        getModels,
        ...(overrides.getDiscoveryEndpointFingerprint
          ? { getDiscoveryEndpointFingerprint: overrides.getDiscoveryEndpointFingerprint }
          : {}),
      } as unknown as Provider);
      return { listRemoteModels, getModels };
    }

    function parsePersisted(configJson: string | undefined): Record<string, unknown> {
      return JSON.parse(configJson ?? 'null') as Record<string, unknown>;
    }

    it('rejects invalid requests before touching providers or state', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      registerRemoteProvider();
      const handlers = setup();
      const handler = handlers.get('providers.refreshDiscovery')!;

      await expect(handler(null, {})).rejects.toThrow('Invalid refresh discovery request');
      await expect(handler({ id: created.id, options: {} }, {})).rejects.toThrow(
        'Unknown refresh discovery request field: options'
      );
      await expect(handler({ id: '' }, {})).rejects.toThrow('Provider id is required');
      await expect(handler({ id: 'missing' }, {})).rejects.toThrow('Provider missing not found');

      const unregistered = repo.createProvider({
        providerId: 'unregistered',
        displayName: 'Unregistered',
        kind: 'built_in',
        authType: 'none',
      });
      await expect(handler({ id: unregistered.id }, {})).rejects.toThrow(
        'Provider unregistered is not registered'
      );

      const unsupported = repo.createProvider({
        providerId: 'unsupported',
        displayName: 'Unsupported',
        kind: 'built_in',
        authType: 'none',
      });
      getProviderRegistry().register({ id: 'unsupported' } as Provider);
      await expect(handler({ id: unsupported.id }, {})).rejects.toThrow(
        'Provider unsupported does not support remote model listing'
      );

      expect(eventBus.publishAsync).not.toHaveBeenCalled();
      expect(getModelsCache().size).toBe(0);
    });

    it('commits persist, cache slice, then publish in order for the saved config', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      const discovered = [makeDiscoveredModel('remote-a'), makeDiscoveredModel('remote-b')];
      const merged = [...discovered];
      registerRemoteProvider({
        listRemoteModels: async () => discovered,
        getModels: async () => merged,
      });
      const staleSlice = makeDiscoveredModel('remote-stale');
      setModelsCache(new Map([['global', [staleSlice]]]));
      let cacheAtPublish: ModelInfo[] | undefined;
      let configAtPublish: string | undefined;
      eventBus.publishAsync = mock((() => {
        cacheAtPublish = getModelsCache().get('global');
        configAtPublish = repo.getProvider(created.id)?.configJson;
      }) as typeof eventBus.publishAsync);
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; models: Array<{ id: string }> };

      expect(result.success).toBe(true);
      expect(result.models.map((model) => model.id)).toEqual(['remote-a', 'remote-b']);
      expect(cacheAtPublish).toEqual([...merged]);
      expect(configAtPublish).not.toBeUndefined();

      const persisted = parsePersisted(repo.getProvider(created.id)?.configJson);
      expect(persisted.command).toBe('saved acp');
      expect(persisted.discoveredModels).toEqual({
        models: [
          { id: 'remote-a', name: 'remote-a' },
          { id: 'remote-b', name: 'remote-b' },
        ],
      });
      expect(configAtPublish).toBe(repo.getProvider(created.id)?.configJson);
      expect(getModelsCache().get('global')).toEqual([...merged]);
      expect(eventBus.publishAsync).toHaveBeenCalledTimes(1);
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('defers the live slice without creating an uninitialized global cache entry', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      eventBus.publishAsync = mock(() => {}) as typeof eventBus.publishAsync;
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      expect(getModelsCache().has('global')).toBe(false);
      const persisted = parsePersisted(repo.getProvider(created.id)?.configJson);
      expect(persisted.discoveredModels).toEqual({
        models: [{ id: 'remote-a', name: 'remote-a' }],
      });
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('discards everything when an in-flight refresh invalidation lands mid-fetch', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      const { refreshModels } = await import('../../../../src/lib/model-service');
      let listingDepth = 0;
      registerRemoteProvider({
        listRemoteModels: async () => {
          if (listingDepth > 0) return [makeDiscoveredModel('remote-a')];
          listingDepth += 1;
          const refreshPromise = refreshModels();
          clearModelsCache();
          await refreshPromise;
          listingDepth -= 1;
          return [makeDiscoveredModel('remote-a')];
        },
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; reason?: string };

      expect(result).toEqual({ success: false, reason: 'superseded' });
      expect(repo.getProvider(created.id)?.configJson).toBe(
        JSON.stringify({ command: 'saved acp' })
      );
      expect(getModelsCache().has('global')).toBe(false);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('discards everything when the saved config changes mid-fetch', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => {
          repo.updateProvider(created.id, { configJson: JSON.stringify({ command: 'rotated' }) });
          return [makeDiscoveredModel('remote-a')];
        },
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; reason?: string };

      expect(result).toEqual({ success: false, reason: 'superseded' });
      expect(repo.getProvider(created.id)?.configJson).toBe(JSON.stringify({ command: 'rotated' }));
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('throws and mutates nothing when discovery yields no models', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [],
        getModels: async () => [],
      });
      const handlers = setup();

      await expect(
        handlers.get('providers.refreshDiscovery')!({ id: created.id }, {})
      ).rejects.toThrow('Provider remote returned no models');

      expect(repo.getProvider(created.id)?.configJson).toBe(
        JSON.stringify({ command: 'saved acp' })
      );
      expect(getModelsCache().size).toBe(0);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('persists curated-first with a truncation marker inside the 64 KiB bound', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ region: 'china' }),
      });
      const total = 2000;
      const discovered = Array.from({ length: total }, (_, index) =>
        makeDiscoveredModel(`m-${index}`, `Name ${index}`)
      );
      getProviderRegistry().setCuratedModels('remote', [{ id: `m-${total - 1}` }]);
      registerRemoteProvider({
        listRemoteModels: async () => discovered,
        getModels: async () => discovered,
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; truncated?: boolean };

      const persisted = parsePersisted(repo.getProvider(created.id)?.configJson) as {
        region: string;
        discoveredModels: { models: Array<{ id: string; name: string }>; truncated?: boolean };
      };
      expect(result.truncated).toBe(true);
      expect(result.success).toBe(true);
      expect(persisted.region).toBe('china');
      expect(persisted.discoveredModels.truncated).toBe(true);
      expect((repo.getProvider(created.id)?.configJson ?? '').length).toBeLessThan(64 * 1024);
      expect(persisted.discoveredModels.models[0]?.id).toBe(`m-${total - 1}`);
      expect(persisted.discoveredModels.models.length).toBeLessThan(total);
      const persistedIds = new Set(persisted.discoveredModels.models.map((model) => model.id));
      for (const model of getProviderRegistry().getCuratedModels('remote') ?? []) {
        if (persistedIds.has(model.id)) continue;
        throw new Error(`curated id ${model.id} lost to truncation`);
      }
    });

    it('merges into existing config keys', async () => {
      const withConfig = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: '{"region":"china","models":[{"id":"static-one"}],"broken":true}',
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a', 'Remote A')],
        getModels: async () => [makeDiscoveredModel('remote-a', 'Remote A')],
      });
      const handlers = setup();
      const handler = handlers.get('providers.refreshDiscovery')!;

      await handler({ id: withConfig.id }, {});

      const first = parsePersisted(repo.getProvider(withConfig.id)?.configJson) as Record<
        string,
        unknown
      > & { discoveredModels: { models: Array<{ id: string; name?: string }> } };
      expect(first.region).toBe('china');
      expect(first.broken).toBe(true);
      expect(first.discoveredModels.models).toEqual([{ id: 'remote-a', name: 'Remote A' }]);
    });

    it('rejects refresh on unparsable JSON to avoid overwriting the saved configuration', async () => {
      const withBrokenConfig = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: 'not-json{',
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a', 'Remote A')],
        getModels: async () => [makeDiscoveredModel('remote-a', 'Remote A')],
      });
      const handlers = setup();
      const handler = handlers.get('providers.refreshDiscovery')!;

      await expect(handler({ id: withBrokenConfig.id }, {})).rejects.toThrow(
        /Saved provider config is not valid JSON/
      );
      expect(repo.getProvider(withBrokenConfig.id)?.configJson).toBe('not-json{');
    });

    it('persists configured curated ids ahead of discovery even when discovery omits them', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      getProviderRegistry().setCuratedModels('remote', [
        { id: 'curated-absent' },
        { id: 'curated-named', name: 'Curated Named' },
      ]);
      registerRemoteProvider({
        listRemoteModels: async () => [
          makeDiscoveredModel('curated-named'),
          makeDiscoveredModel('overflow-a'),
        ],
        getModels: async () => [makeDiscoveredModel('curated-named')],
      });
      const handlers = setup();

      await handlers.get('providers.refreshDiscovery')!({ id: created.id }, {});

      const persisted = parsePersisted(repo.getProvider(created.id)?.configJson) as {
        discoveredModels: { models: Array<{ id: string; name?: string }> };
      };
      expect(persisted.discoveredModels.models).toEqual([
        { id: 'curated-absent' },
        { id: 'curated-named', name: 'Curated Named' },
        { id: 'overflow-a', name: 'overflow-a' },
      ]);
    });

    it('keeps configured curated models in the live slice when discovery omits them', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      getProviderRegistry().setCuratedModels('remote', [
        { id: 'kept-curated' },
        { id: 'fetched-curated' },
      ]);
      const keptFromPreviousSlice = makeDiscoveredModel('kept-curated');
      const fetched = [makeDiscoveredModel('fetched-curated')];
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('kept-curated'), ...fetched],
        getModels: async () => fetched,
      });
      setModelsCache(new Map([['global', [keptFromPreviousSlice]]]));
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      const slice = (getModelsCache().get('global') ?? []).filter(
        (model) => model.provider === 'remote'
      );
      expect(slice.map((model) => model.id)).toContain('kept-curated');
      expect(slice.map((model) => model.id)).toContain('fetched-curated');
    });

    it('treats an empty forced discovery result as a failed refresh even with static fallbacks', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [],
        getModels: async () => [makeDiscoveredModel('static-fallback')],
      });
      setModelsCache(new Map([['global', [makeDiscoveredModel('existing')]]]));
      const handlers = setup();

      await expect(
        handlers.get('providers.refreshDiscovery')!({ id: created.id }, {})
      ).rejects.toThrow('Provider remote returned no models');

      expect(repo.getProvider(created.id)?.configJson).toBe(
        JSON.stringify({ command: 'saved acp' })
      );
      expect(getModelsCache().get('global')).toEqual([makeDiscoveredModel('existing')]);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('discards everything when the credential identity changes mid-fetch', async () => {
      let credentials: unknown = { type: 'api_key', apiKey: 'key-1' };
      const created = repo.createProvider({
        providerId: 'cred-remote',
        displayName: 'Cred Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      const listRemoteModels = mock(async () => {
        credentials = { type: 'api_key', apiKey: 'key-2' };
        return [makeDiscoveredModel('remote-a')];
      });
      getProviderRegistry().register({
        id: 'cred-remote',
        getCredentials: async () => credentials,
        listRemoteModels,
        getModels: async () => [makeDiscoveredModel('remote-a')],
      } as unknown as Provider);
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; reason?: string };

      expect(listRemoteModels).toHaveBeenCalledWith({ force: true });
      expect(result).toEqual({ success: false, reason: 'superseded' });
      expect(repo.getProvider(created.id)?.configJson).toBe(
        JSON.stringify({ command: 'saved acp' })
      );
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('clears recorded failure and retry state when the refresh succeeds', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      recordClassifiedProviderFailure('remote', {
        errorKind: 'transient',
        message: 'upstream 503',
      });
      markRefreshAttemptedFor(['remote']);
      expect(getProviderFailure('remote')).toBeDefined();
      expect(hasRefreshBeenAttemptedFor('remote')).toBe(true);
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      expect(getProviderFailure('remote')).toBeUndefined();
      expect(hasRefreshBeenAttemptedFor('remote')).toBe(false);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('discards everything when a global cache clear lands mid-fetch', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => {
          clearModelsCache();
          return [makeDiscoveredModel('remote-a')];
        },
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; reason?: string };

      expect(result).toEqual({ success: false, reason: 'superseded' });
      expect(repo.getProvider(created.id)?.configJson).toBe(
        JSON.stringify({ command: 'saved acp' })
      );
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('discards everything when a global cache clear lands during the credentials await', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'saved acp' }),
      });
      let credentialReads = 0;
      getProviderRegistry().register({
        id: 'remote',
        isAvailable: async () => true,
        getCredentials: async () => {
          credentialReads += 1;
          if (credentialReads === 3) clearModelsCache();
          return null;
        },
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      } as unknown as Provider);
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; reason?: string };

      expect(result).toEqual({ success: false, reason: 'superseded' });
      expect(repo.getProvider(created.id)?.configJson).toBe(
        JSON.stringify({ command: 'saved acp' })
      );
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('refreshes the cache timestamp when the slice applies so stale reads cannot clobber it', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      const { getModels } = registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('override-endpoint-model')],
        getModels: async () => [makeDiscoveredModel('default-endpoint-model')],
      });
      setModelsCache(
        new Map([['global', [makeDiscoveredModel('existing')]]]),
        Date.now() - 5 * 60 * 60 * 1000
      );
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      expect(
        getModelsCache()
          .get('global')
          ?.map((model) => model.id)
      ).toEqual(['override-endpoint-model']);

      const { getAvailableModels } = await import('../../../../src/lib/model-service');
      getAvailableModels('global');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(getModels).not.toHaveBeenCalled();
      expect(
        getModelsCache()
          .get('global')
          ?.map((model) => model.id)
      ).toEqual(['override-endpoint-model']);
    });

    it('rejects the refresh when the saved config cannot fit the discovery wrapper', async () => {
      const pad = 'x'.repeat(64 * 1024 - 20);
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ pad }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      setModelsCache(new Map([['global', [makeDiscoveredModel('existing')]]]));
      const handlers = setup();

      await expect(
        handlers.get('providers.refreshDiscovery')!({ id: created.id }, {})
      ).rejects.toThrow('no capacity to persist discovery results');

      expect(repo.getProvider(created.id)?.configJson).toBe(JSON.stringify({ pad }));
      expect(getModelsCache().get('global')).toEqual([makeDiscoveredModel('existing')]);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('ignores session-scoped cache clears while a saved-config refresh is in flight', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      registerRemoteProvider({
        listRemoteModels: async () => {
          clearModelsCache('session-123');
          return [makeDiscoveredModel('remote-a')];
        },
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      const persisted = parsePersisted(repo.getProvider(created.id)?.configJson);
      expect(persisted.discoveredModels).toEqual({
        models: [{ id: 'remote-a', name: 'remote-a' }],
      });
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('rejects the refresh when curated entries alone exceed the persistence budget', async () => {
      const pad = 'x'.repeat(65_390);
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ pad }),
      });
      getProviderRegistry().setCuratedModels('remote', [
        { id: 'curated-model-a' },
        { id: 'curated-model-b' },
        { id: 'curated-model-c' },
        { id: 'curated-model-d' },
        { id: 'curated-model-e' },
      ]);
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      setModelsCache(new Map([['global', [makeDiscoveredModel('existing')]]]));
      const handlers = setup();

      await expect(
        handlers.get('providers.refreshDiscovery')!({ id: created.id }, {})
      ).rejects.toThrow('no capacity to retain all curated models');

      expect(repo.getProvider(created.id)?.configJson).toBe(JSON.stringify({ pad }));
      expect(getModelsCache().get('global')).toEqual([makeDiscoveredModel('existing')]);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('retains a deferred slice through an in-flight initialization and lands both catalogs', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      const slowModels: ModelInfo[] = [
        {
          ...makeDiscoveredModel('slow-provider-model', 'Slow Provider Model'),
          provider: 'slow-provider',
        },
      ];
      getProviderRegistry().register({
        id: 'slow-provider',
        isAvailable: async () => true,
        getModels: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return slowModels;
        },
      } as unknown as Provider);
      const refreshed = [makeDiscoveredModel('refreshed-a')];
      const { listRemoteModels: listRemoteModelsMock, getModels: getModelsMock } =
        registerRemoteProvider({
          listRemoteModels: async () => refreshed,
          getModels: async () => refreshed,
        });
      const handlers = setup();
      const { refreshModels } = await import('../../../../src/lib/model-service');

      const loadPromise = refreshModels();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };
      expect(result.success).toBe(true);
      await loadPromise;

      const models = getModelsCache().get('global') ?? [];
      const ids = models.map((model) => model.id).sort();
      expect(ids).toContain('slow-provider-model');
      expect(ids).toContain('refreshed-a');

      const replaced = [makeDiscoveredModel('replaced-b')];
      listRemoteModelsMock.mockImplementation(async () => replaced);
      getModelsMock.mockImplementation(async () => replaced);
      await refreshModels();

      const afterIds = (getModelsCache().get('global') ?? []).map((model) => model.id);
      expect(afterIds).not.toContain('refreshed-a');
    });

    it('does not discard the persisted discovery when forced strict fetch fails', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      const refreshed = [makeDiscoveredModel('refreshed-a')];
      const { listRemoteModels: listRemoteModelsMock, getModels: getModelsMock } =
        registerRemoteProvider({
          listRemoteModels: async () => refreshed,
          getModels: async () => refreshed,
        });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getModelsCache().has('global')).toBe(false);

      listRemoteModelsMock.mockImplementation(async () => []);
      getModelsMock.mockImplementation(async () => []);
      const { refreshModels } = await import('../../../../src/lib/model-service');
      await expect(refreshModels(undefined, { forceRemote: true })).rejects.toThrow();

      const persisted = parsePersisted(repo.getProvider(created.id)?.configJson) as {
        discoveredModels: { models: Array<{ id: string }> };
      };
      expect(persisted.discoveredModels.models.map((m) => m.id)).toContain('refreshed-a');
    });

    it('treats a forced rebuild as authoritative over a scheduled deferred slice', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      const refreshed = [makeDiscoveredModel('refreshed-a')];
      const { listRemoteModels: listRemoteModelsMock, getModels: getModelsMock } =
        registerRemoteProvider({
          listRemoteModels: async () => refreshed,
          getModels: async () => refreshed,
        });
      getProviderRegistry().register({
        id: 'later-provider',
        isAvailable: async () => true,
        getModels: async () => [
          { ...makeDiscoveredModel('later-model'), provider: 'later-provider' },
        ],
      } as unknown as Provider);
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getModelsCache().has('global')).toBe(false);

      listRemoteModelsMock.mockImplementation(async () => []);
      getModelsMock.mockImplementation(async () => []);
      const { refreshModels } = await import('../../../../src/lib/model-service');
      const forced = [makeDiscoveredModel('forced-a')];
      listRemoteModelsMock.mockImplementation(async () => forced);
      getModelsMock.mockImplementation(async () => forced);
      await refreshModels(undefined, { forceRemote: true });

      const ids = (getModelsCache().get('global') ?? []).map((model) => model.id);
      expect(ids).toContain('forced-a');
      expect(ids).not.toContain('refreshed-a');
      expect(ids).toContain('later-model');
    });

    it('keeps a scheduled deferred slice when the next load omits the provider', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('refreshed-a')],
        getModels: async () => [makeDiscoveredModel('refreshed-a')],
      });
      getProviderRegistry().register({
        id: 'flaky',
        isAvailable: async () => true,
        getModels: async () => {
          throw new Error('flaky provider down');
        },
      } as unknown as Provider);
      getProviderRegistry().register({
        id: 'stable',
        isAvailable: async () => true,
        getModels: async () => [{ ...makeDiscoveredModel('stable-model'), provider: 'stable' }],
      } as unknown as Provider);
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getModelsCache().has('global')).toBe(false);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      const ids = (getModelsCache().get('global') ?? []).map((model) => model.id);
      expect(ids).toContain('refreshed-a');
      expect(ids).toContain('stable-model');
    });

    it('retains the deferred saved-endpoint slice when an ordinary initialization loads the default endpoint', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        baseUrl: 'https://saved-endpoint.example',
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('saved-endpoint-model')],
        getModels: async () => [makeDiscoveredModel('default-endpoint-model')],
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getModelsCache().has('global')).toBe(false);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      const ids = (getModelsCache().get('global') ?? []).map((model) => model.id);
      expect(ids).toContain('saved-endpoint-model');
      expect(ids).not.toContain('default-endpoint-model');
    });

    it('invalidates the provider catalog cache when the refresh succeeds', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      let catalogLoads = 0;
      const provider = {
        id: 'remote',
        isAvailable: async () => true,
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => {
          catalogLoads += 1;
          return [makeDiscoveredModel('remote-a')];
        },
      } as unknown as Provider;
      getProviderRegistry().register(provider);
      const handlers = setup();
      const { getProviderCatalogModels } = await import('../../../../src/lib/model-service');

      await getProviderCatalogModels('remote', provider);
      expect(catalogLoads).toBe(1);

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };
      expect(result.success).toBe(true);

      await getProviderCatalogModels('remote', provider);
      expect(catalogLoads).toBe(2);
    });

    it('seeds the canonical model instead of a duplicate alias when curation stores an alias', async () => {
      const created = repo.createProvider({
        providerId: 'kimi',
        displayName: 'Kimi',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ models: [{ id: 'kimi' }] }),
      });
      getProviderRegistry().setCuratedModels('kimi', [{ id: 'kimi' }]);
      getProviderRegistry().register({
        id: 'kimi',
        isAvailable: async () => true,
        listRemoteModels: async () => [
          { ...makeDiscoveredModel('kimi-for-coding'), provider: 'kimi' },
        ],
        getModels: async () => [{ ...makeDiscoveredModel('kimi-for-coding'), provider: 'kimi' }],
      } as unknown as Provider);
      setModelsCache(new Map([['global', [makeDiscoveredModel('existing')]]]));
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      const slice = (getModelsCache().get('global') ?? []).filter(
        (model) => model.provider === 'kimi'
      );
      const ids = slice.map((model) => model.id);
      expect(ids).toContain('kimi-for-coding');
      expect(ids).not.toContain('kimi');
    });

    it('strips persisted discovery when an update changes the effective configuration', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ region: 'china', extra: true }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();
      await handlers.get('providers.refreshDiscovery')!({ id: created.id }, {});
      expect(repo.getProvider(created.id)?.configJson).toContain('discoveredModels');

      const updated = (await handlers.get('providers.update')!(
        { id: created.id, params: { configJson: JSON.stringify({ region: 'global' }) } },
        {}
      )) as { provider: ProviderRecord };

      const stored = JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(stored.region).toBe('global');
      expect(stored).not.toHaveProperty('discoveredModels');
      expect(JSON.parse(updated.provider.configJson ?? '{}')).not.toHaveProperty(
        'discoveredModels'
      );
    });

    it('retains persisted discovery when a curation-only config update is saved', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ region: 'china' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();
      await handlers.get('providers.refreshDiscovery')!({ id: created.id }, {});
      const storedBefore = JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(storedBefore.discoveredModels).toBeDefined();

      const mergedConfig = JSON.stringify({
        region: 'china',
        models: [{ id: 'remote-a' }],
        discoveredModels: storedBefore.discoveredModels,
      });
      const updated = (await handlers.get('providers.update')!(
        { id: created.id, params: { configJson: mergedConfig } },
        {}
      )) as { provider: ProviderRecord };

      const storedAfter = JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(storedAfter.discoveredModels).toEqual(storedBefore.discoveredModels);
      expect(storedAfter.models).toEqual([{ id: 'remote-a' }]);
      expect(
        (JSON.parse(updated.provider.configJson ?? '{}') as Record<string, unknown>)
          .discoveredModels
      ).toEqual(storedBefore.discoveredModels);
    });

    it('strips persisted discovery when a curation-only save also changes the endpoint', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        baseUrl: 'https://old-endpoint.example',
        configJson: JSON.stringify({ region: 'china' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();
      await handlers.get('providers.refreshDiscovery')!({ id: created.id }, {});
      expect(repo.getProvider(created.id)?.configJson).toContain('discoveredModels');

      const updated = (await handlers.get('providers.update')!(
        {
          id: created.id,
          params: {
            baseUrl: 'https://new-endpoint.example',
            configJson: JSON.stringify({ region: 'china', models: [{ id: 'remote-a' }] }),
          },
        },
        {}
      )) as { provider: ProviderRecord };

      const stored = JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(stored).not.toHaveProperty('discoveredModels');
      expect(stored.models).toEqual([{ id: 'remote-a' }]);
      expect(repo.getProvider(created.id)?.baseUrl).toBe('https://new-endpoint.example');
      expect(JSON.parse(updated.provider.configJson ?? '{}')).not.toHaveProperty(
        'discoveredModels'
      );
    });

    it('strips persisted discovery when a built-in provider is disabled', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ region: 'china' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();
      await handlers.get('providers.refreshDiscovery')!({ id: created.id }, {});
      expect(repo.getProvider(created.id)?.configJson).toContain('discoveredModels');

      const updated = (await handlers.get('providers.update')!(
        { id: created.id, params: { isEnabled: false } },
        {}
      )) as { provider: ProviderRecord };

      expect(updated.provider.isEnabled).toBe(false);
      expect(JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}')).not.toHaveProperty(
        'discoveredModels'
      );
    });

    it('restores server-owned discoveredModels when a stale client snapshot saves curation', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ region: 'china' }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();
      await handlers.get('providers.refreshDiscovery')!({ id: created.id }, {});
      const storedBefore = JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(storedBefore.discoveredModels).toBeDefined();

      const staleSnapshot = JSON.stringify({
        region: 'china',
        models: [{ id: 'remote-a' }],
        discoveredModels: { models: [{ id: 'stale' }] },
      });
      await handlers.get('providers.update')!(
        { id: created.id, params: { configJson: staleSnapshot } },
        {}
      );

      const storedAfter = JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(storedAfter.discoveredModels).toEqual(storedBefore.discoveredModels);
      expect(storedAfter.models).toEqual([{ id: 'remote-a' }]);
    });

    it('rejects a stale-snapshot curation save that would overflow the configJson limit after restoring discovery', async () => {
      const pad = 'x'.repeat(65_200);
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ region: 'china', pad }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
      });
      const handlers = setup();
      await handlers.get('providers.refreshDiscovery')!({ id: created.id }, {});
      const storedBefore = JSON.parse(repo.getProvider(created.id)?.configJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(storedBefore.discoveredModels).toBeDefined();

      const staleSnapshot = JSON.stringify({
        region: 'china',
        pad,
        models: [{ id: 'remote-a' }, { id: `filler-${'y'.repeat(240)}` }],
      });
      const originalConfig = repo.getProvider(created.id)?.configJson;
      expect(staleSnapshot.length).toBeLessThanOrEqual(64 * 1024);
      expect(staleSnapshot.length).toBeGreaterThan(64 * 1024 - 100);

      await expect(
        handlers.get('providers.update')!(
          { id: created.id, params: { configJson: staleSnapshot } },
          {}
        )
      ).rejects.toThrow(/after restoring persisted discovery/);
      expect(repo.getProvider(created.id)?.configJson).toBe(originalConfig);
    });

    it('releases the applied slice so later forced rebuilds can replace the catalog', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
      });
      const catalogA = [makeDiscoveredModel('catalog-a')];
      const catalogB = [makeDiscoveredModel('catalog-b')];
      const { listRemoteModels, getModels } = registerRemoteProvider({
        listRemoteModels: async () => catalogA,
        getModels: async () => catalogA,
      });
      setModelsCache(new Map([['global', [makeDiscoveredModel('stale')]]]));
      const handlers = setup();
      const handler = handlers.get('providers.refreshDiscovery')!;

      const result = (await handler({ id: created.id }, {})) as { success: boolean };
      expect(result.success).toBe(true);
      expect(getModelsCache().get('global')).toEqual([...catalogA]);

      listRemoteModels.mockImplementation(async () => catalogB);
      getModels.mockImplementation(async () => catalogB);
      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getModelsCache().get('global')).toEqual([...catalogB]);
    });

    it('accounts for the discovery fingerprint length in the persistence budget', async () => {
      const pad = 'x'.repeat(65_000);
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({ region: 'china', pad }),
      });
      registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
        getDiscoveryEndpointFingerprint: () => 'f'.repeat(300),
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      const finalConfigJson = repo.getProvider(created.id)?.configJson ?? '';
      expect(finalConfigJson.length).toBeLessThanOrEqual(64 * 1024);
      expect(JSON.parse(finalConfigJson).discoveredModels.fingerprint).toBe('f'.repeat(300));
    });

    it('omits the baseUrl override and fingerprints the effective endpoint when the saved base URL is empty', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        baseUrl: '',
      });
      let fingerprintedBaseUrl: string | undefined | 'unset' = 'unset';
      const { listRemoteModels } = registerRemoteProvider({
        listRemoteModels: async () => [makeDiscoveredModel('remote-a')],
        getModels: async () => [makeDiscoveredModel('remote-a')],
        getDiscoveryEndpointFingerprint: (discoveryBaseUrl?: string) => {
          fingerprintedBaseUrl = discoveryBaseUrl;
          return 'fp-effective-endpoint';
        },
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
      expect(listRemoteModels).toHaveBeenCalledWith({ force: true });
      expect(fingerprintedBaseUrl).toBeUndefined();
      const persisted = parsePersisted(repo.getProvider(created.id)?.configJson) as {
        discoveredModels: { fingerprint?: string };
      };
      expect(persisted.discoveredModels.fingerprint).toBe('fp-effective-endpoint');
    });

    it('caps the persisted blob by remaining config capacity for large existing payloads', async () => {
      const pad = 'x'.repeat(63_000);
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ pad }),
      });
      const discovered = Array.from({ length: 500 }, (_, index) =>
        makeDiscoveredModel(`m-${index}`, `Name ${index}`)
      );
      registerRemoteProvider({
        listRemoteModels: async () => discovered,
        getModels: async () => discovered,
      });
      const handlers = setup();

      const result = (await handlers.get('providers.refreshDiscovery')!(
        { id: created.id },
        {}
      )) as { success: boolean; truncated?: boolean };

      const finalConfigJson = repo.getProvider(created.id)?.configJson ?? '';
      expect(result.success).toBe(true);
      expect(finalConfigJson.length).toBeLessThan(64 * 1024);
      const persisted = JSON.parse(finalConfigJson) as {
        pad: string;
        discoveredModels: { models: unknown[]; truncated?: boolean };
      };
      expect(persisted.pad).toBe(pad);
      expect(persisted.discoveredModels.truncated).toBe(true);
    });
  });

  describe('providers.fetchAcpModels', () => {
    it('rejects unknown and non-ACP providers', async () => {
      const anthropic = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();

      await expect(
        handlers.get('providers.fetchAcpModels')!({ id: 'missing', command: 'devin acp' }, {})
      ).rejects.toThrow('Provider missing not found');
      await expect(
        handlers.get('providers.fetchAcpModels')!({ id: anthropic.id, command: 'devin acp' }, {})
      ).rejects.toThrow('is not an ACP provider');
    });

    it('rejects invalid command overrides before discovery', async () => {
      const acp = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
      });
      getProviderRegistry().register(new AcpProvider({}, async () => {}));
      const handlers = setup();

      await expect(
        handlers.get('providers.fetchAcpModels')!({ id: acp.id, command: '   ' }, {})
      ).rejects.toThrow('ACP command is required');
      await expect(
        handlers.get('providers.fetchAcpModels')!({ id: acp.id, command: 42 }, {})
      ).rejects.toThrow('ACP command must be a string');
    });

    it('hydrates the fallback provider from the requested record command', async () => {
      const originalCommand = process.env.HYPERNEO_ACP_COMMAND;
      delete process.env.HYPERNEO_ACP_COMMAND;
      const acp = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'hyperneo-missing-acp-binary' }),
      });
      const handlers = setup();

      try {
        await expect(handlers.get('providers.fetchAcpModels')!({ id: acp.id }, {})).rejects.toThrow(
          'hyperneo-missing-acp-binary'
        );
      } finally {
        if (originalCommand === undefined) delete process.env.HYPERNEO_ACP_COMMAND;
        else process.env.HYPERNEO_ACP_COMMAND = originalCommand;
      }
    });

    it('resolves an empty-string command through the environment fallback', async () => {
      const originalCommand = process.env.HYPERNEO_ACP_COMMAND;
      process.env.HYPERNEO_ACP_COMMAND = 'hyperneo-env-acp-binary';
      const acp = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
        configJson: JSON.stringify({ command: 'hyperneo-missing-acp-binary' }),
      });
      const handlers = setup();

      try {
        await expect(
          handlers.get('providers.fetchAcpModels')!({ id: acp.id, command: '' }, {})
        ).rejects.toThrow('hyperneo-env-acp-binary');
        await expect(handlers.get('providers.fetchAcpModels')!({ id: acp.id }, {})).rejects.toThrow(
          'hyperneo-missing-acp-binary'
        );
      } finally {
        if (originalCommand === undefined) delete process.env.HYPERNEO_ACP_COMMAND;
        else process.env.HYPERNEO_ACP_COMMAND = originalCommand;
      }
    });
  });

  describe('providers.create', () => {
    it('creates a provider and stores credentials', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'sk-or-test' },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.providerId).toBe('openrouter');
      expect(creds.storeApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-test');
    });

    it('strips client-supplied persisted discovery before creating the row', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            kind: 'built_in',
            authType: 'api_key',
            configJson: JSON.stringify({
              models: [{ id: 'kept-model' }],
              discoveredModels: { models: [{ id: 'stale-from-previous-account' }] },
            }),
          },
          credentials: { apiKey: 'sk-or-test' },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      const stored = JSON.parse(result.provider.configJson ?? '{}') as Record<string, unknown>;
      expect(stored.models).toEqual([{ id: 'kept-model' }]);
      expect(stored).not.toHaveProperty('discoveredModels');
      expect(repo.getProvider(result.provider.id)?.configJson).toBe(result.provider.configJson);
    });

    it('does not store custom_endpoint credentials in the credential store', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'custom:lm',
            displayName: 'LM Studio',
            kind: 'custom_endpoint',
            authType: 'api_key',
          },
          credentials: { apiKey: 'inline-key' },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(creds.storeApiKey).not.toHaveBeenCalled();
    });

    it('rejects invalid ACP commands before creating or mutating the provider', async () => {
      const provider = new AcpProvider({}, async () => {});
      provider.setAcpCommand('devin acp');
      getProviderRegistry().register(provider);
      const handlers = setup();

      await expect(
        handlers.get('providers.create')!(
          {
            params: {
              providerId: 'acp',
              displayName: 'ACP Agent',
              kind: 'built_in',
              authType: 'none',
              configJson: JSON.stringify({ command: "devin 'acp" }),
            },
          },
          {}
        )
      ).rejects.toThrow('Invalid ACP command: unmatched quote');

      expect(repo.listProviders()).toEqual([]);
      expect(provider.getAcpCommand()).toBe('devin acp');

      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'acp',
            displayName: 'ACP Agent',
            kind: 'built_in',
            authType: 'none',
            configJson: JSON.stringify({ command: 'fixed acp' }),
          },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(repo.listProviders()).toHaveLength(1);
      expect(provider.getAcpCommand()).toBe('fixed acp');
    });

    it('does not activate a command from a disabled ACP record', async () => {
      const provider = new AcpProvider({}, async () => {});
      provider.setAcpCommand('old acp');
      getProviderRegistry().register(provider);
      const handlers = setup();

      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'acp',
            displayName: 'ACP Agent',
            kind: 'built_in',
            authType: 'none',
            isEnabled: false,
            configJson: JSON.stringify({ command: 'new acp' }),
          },
        },
        {}
      )) as { provider: ProviderRecord };

      expect(result.provider.isEnabled).toBe(false);
      expect(provider.getAcpCommand()).toBe('old acp');
    });

    it('unregisters a live built-in provider when created as disabled', async () => {
      getProviderRegistry().register(new AcpProvider({}, async () => {}));
      const handlers = setup();

      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'acp',
            displayName: 'ACP Agent',
            kind: 'built_in',
            authType: 'none',
            isEnabled: false,
            configJson: JSON.stringify({ command: 'new acp' }),
          },
        },
        {}
      )) as { provider: ProviderRecord };

      expect(result.provider.isEnabled).toBe(false);
      expect(getProviderRegistry().has('acp')).toBe(false);
    });

    it('does not log out a live built-in provider when created as disabled', async () => {
      const logout = mock(async () => {});
      getProviderRegistry().register({
        id: 'acp',
        displayName: 'ACP Agent',
        capabilities: {
          streaming: false,
          extendedThinking: false,
          thinkingModes: 'off',
          maxContextWindow: 1000,
          functionCalling: false,
          vision: false,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: () => false,
        getModelForTier: () => undefined,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: false }),
        logout,
        shutdown: mock(async () => {}),
      } as Provider);
      const handlers = setup();

      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'acp',
            displayName: 'ACP Agent',
            kind: 'built_in',
            authType: 'none',
            isEnabled: false,
          },
        },
        {}
      )) as { provider: ProviderRecord };

      expect(result.provider.isEnabled).toBe(false);
      expect(getProviderRegistry().has('acp')).toBe(false);
      expect(logout).not.toHaveBeenCalled();
    });

    it('rolls back the provider row and surfaces keychain guidance when storeApiKey throws KeychainUnavailableError', async () => {
      creds.storeApiKey = mock(async () => {
        throw new KeychainUnavailableError('User interaction is not allowed.');
      });
      const handlers = setup();

      await expect(
        handlers.get('providers.create')!(
          {
            params: {
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              kind: 'built_in',
              authType: 'api_key',
            },
            credentials: { apiKey: 'sk-or-test' },
          },
          {}
        )
      ).rejects.toThrow('macOS Keychain is locked or unavailable');

      expect(repo.listProviders()).toEqual([]);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('re-registers a built-in provider that was previously unregistered', async () => {
      const registry = getProviderRegistry();
      registry.unregister('anthropic-codex');
      expect(registry.has('anthropic-codex')).toBe(false);

      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'anthropic-codex',
            displayName: 'OpenAI (Codex)',
            kind: 'built_in',
            authType: 'oauth',
          },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(registry.has('anthropic-codex')).toBe(true);
    });

    it('rejects invalid kind', async () => {
      const handlers = setup();
      await expect(
        handlers.get('providers.create')!(
          {
            params: {
              providerId: 'x',
              displayName: 'X',
              kind: 'invalid',
              authType: 'api_key',
            },
          },
          {}
        )
      ).rejects.toThrow('kind must be one of');
    });

    it('emits providers.changed after creation', async () => {
      const handlers = setup();
      await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'sk-or-test' },
        },
        {}
      );
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });
  });

  describe('providers.update', () => {
    it('updates display name', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.update')!(
        { id: created.id, params: { displayName: 'Anthropic Inc' } },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.displayName).toBe('Anthropic Inc');
    });

    it('rejects invalid ACP commands before persisting or mutating the provider', async () => {
      const originalConfig = JSON.stringify({ command: 'devin acp' });
      const created = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
        configJson: originalConfig,
      });
      const provider = new AcpProvider({}, async () => {});
      provider.setAcpCommand('devin acp');
      getProviderRegistry().register(provider);
      const handlers = setup();

      await expect(
        handlers.get('providers.update')!(
          {
            id: created.id,
            params: {
              configJson: JSON.stringify({ command: "devin 'acp" }),
            },
          },
          {}
        )
      ).rejects.toThrow('Invalid ACP command: unmatched quote');

      expect(repo.getProvider(created.id)?.configJson).toBe(originalConfig);
      expect(provider.getAcpCommand()).toBe('devin acp');

      await expect(
        handlers.get('providers.update')!(
          { id: created.id, params: { configJson: '{invalid' } },
          {}
        )
      ).rejects.toThrow('Invalid ACP config JSON');
      expect(repo.getProvider(created.id)?.configJson).toBe(originalConfig);

      await expect(
        handlers.get('providers.update')!({ id: created.id, params: { configJson: 'null' } }, {})
      ).rejects.toThrow('Invalid ACP config JSON');
      expect(repo.getProvider(created.id)?.configJson).toBe(originalConfig);
    });

    it('emits providers.changed after update', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      await handlers.get('providers.update')!(
        { id: created.id, params: { displayName: 'Anthropic Inc' } },
        {}
      );
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });
  });

  describe('providers.delete', () => {
    it('disables a built-in provider instead of deleting the row', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.delete')!({ id: created.id }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      const after = repo.getProvider(created.id);
      expect(after).not.toBeNull();
      expect(after?.isEnabled).toBe(false);
    });

    it('strips persisted discovery when deleting a built-in provider', async () => {
      const created = repo.createProvider({
        providerId: 'remote',
        displayName: 'Remote',
        kind: 'built_in',
        authType: 'api_key',
        configJson: JSON.stringify({
          region: 'china',
          discoveredModels: { models: [{ id: 'remote-a' }] },
        }),
      });
      const handlers = setup();
      await handlers.get('providers.delete')!({ id: created.id }, {});

      const after = repo.getProvider(created.id);
      const stored = JSON.parse(after?.configJson ?? '{}') as Record<string, unknown>;
      expect(stored.region).toBe('china');
      expect(stored).not.toHaveProperty('discoveredModels');
      expect(after?.isEnabled).toBe(false);
    });

    it('throws when provider not found', async () => {
      const handlers = setup();
      await expect(handlers.get('providers.delete')!({ id: 'missing' }, {})).rejects.toThrow(
        'not found'
      );
    });

    it('emits providers.changed after deletion', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      await handlers.get('providers.delete')!({ id: created.id }, {});
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });
  });

  describe('providers.setDefault', () => {
    it('sets default provider', async () => {
      const a = repo.createProvider({
        providerId: 'a',
        displayName: 'A',
        kind: 'built_in',
        authType: 'none',
      });
      const b = repo.createProvider({
        providerId: 'b',
        displayName: 'B',
        kind: 'built_in',
        authType: 'none',
      });
      const cachedModels = [{ id: 'sonnet', provider: 'anthropic' } as ModelInfo];
      setModelsCache(new Map([['global', cachedModels]]));
      const handlers = setup();

      await handlers.get('providers.setDefault')!({ id: b.id }, {});
      expect(repo.getProvider(a.id)?.isDefault).toBe(false);
      expect(repo.getProvider(b.id)?.isDefault).toBe(true);
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
      expect(getModelsCache().get('global')).toEqual(cachedModels);
    });
  });

  describe('providers.create', () => {
    it('creates a provider and stores apiKey credentials', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'sk-or-test' },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.providerId).toBe('openrouter');
      expect(creds.storeApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-test');
    });

    it('creates a provider and stores OAuth credentials', async () => {
      const handlers = setup();
      const result = (await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'anthropic-codex',
            displayName: 'OpenAI (Codex)',
            kind: 'built_in',
            authType: 'oauth',
          },
          credentials: {
            oauthAccessToken: 'tok-test',
            oauthRefreshToken: 'ref-test',
            oauthExpiresAt: 12345678,
          },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(creds.storeOAuthTokens).toHaveBeenCalledWith('anthropic-codex', {
        accessToken: 'tok-test',
        refreshToken: 'ref-test',
        expiresAt: 12345678,
      });
    });

    it('rejects invalid kind', async () => {
      const handlers = setup();
      await expect(
        handlers.get('providers.create')!(
          {
            params: {
              providerId: 'x',
              displayName: 'X',
              kind: 'invalid',
              authType: 'api_key',
            },
          },
          {}
        )
      ).rejects.toThrow('kind must be one of');
    });
  });

  describe('providers.get', () => {
    it('returns a provider by id with availability', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.get')!({ id: created.id }, {})) as {
        provider: ProviderRecord & { available: boolean };
      };

      expect(result.provider.providerId).toBe('anthropic');
      expect(result.provider.available).toBe(false);
    });

    it('throws when provider not found', async () => {
      const handlers = setup();
      await expect(handlers.get('providers.get')!({ id: 'missing' }, {})).rejects.toThrow(
        'not found'
      );
    });
  });

  describe('providers.update', () => {
    it('updates display name', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.update')!(
        { id: created.id, params: { displayName: 'Anthropic Inc' } },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.displayName).toBe('Anthropic Inc');
    });

    it('updates OAuth credentials', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic-codex',
        displayName: 'OpenAI (Codex)',
        kind: 'built_in',
        authType: 'none',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.update')!(
        {
          id: created.id,
          params: {},
          credentials: {
            oauthAccessToken: 'new-tok',
            oauthRefreshToken: 'new-ref',
            oauthExpiresAt: 87654321,
          },
        },
        {}
      )) as { success: boolean; provider: ProviderRecord };

      expect(result.success).toBe(true);
      expect(result.provider.authType).toBe('oauth');
      expect(creds.storeOAuthTokens).toHaveBeenCalledWith('anthropic-codex', {
        accessToken: 'new-tok',
        refreshToken: 'new-ref',
        expiresAt: 87654321,
      });
    });

    it('surfaces keychain guidance and leaves the record untouched when storeApiKey throws KeychainUnavailableError', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'none',
      });
      creds.storeApiKey = mock(async () => {
        throw new KeychainUnavailableError('User interaction is not allowed.');
      });
      const handlers = setup();

      await expect(
        handlers.get('providers.update')!(
          { id: created.id, params: {}, credentials: { apiKey: 'sk-new' } },
          {}
        )
      ).rejects.toThrow('macOS Keychain is locked or unavailable');

      const after = repo.getProvider(created.id);
      expect(after?.authType).toBe('none');
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('restores the pre-strip row when credential storage fails during a discovery-invalidating update', async () => {
      const originalConfig = JSON.stringify({
        region: 'china',
        discoveredModels: { models: [{ id: 'remote-a' }] },
      });
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
        configJson: originalConfig,
      });
      creds.storeApiKey = mock(async () => {
        throw new KeychainUnavailableError('User interaction is not allowed.');
      });
      const handlers = setup();

      await expect(
        handlers.get('providers.update')!(
          { id: created.id, params: {}, credentials: { apiKey: 'sk-new' } },
          {}
        )
      ).rejects.toThrow('macOS Keychain is locked or unavailable');

      expect(repo.getProvider(created.id)?.configJson).toBe(originalConfig);
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('clears the global models cache and stranded-probe gate on disable→enable so recovery can run', async () => {
      const created = repo.createProvider({
        providerId: 'glm',
        displayName: 'GLM',
        kind: 'built_in',
        authType: 'none',
      });

      getProviderRegistry().register({
        id: 'glm',
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
        getModels: async () => [],
        ownsModel: () => true,
        getModelForTier: () => undefined,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: false }),
      } as Provider);

      const anthropicOnly = [{ id: 'sonnet', provider: 'anthropic' } as ModelInfo];
      setModelsCache(new Map([['global', anthropicOnly]]));

      expect(await detectStrandedProviders(anthropicOnly)).toEqual(['glm']);
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);
      expect(await detectStrandedProviders(anthropicOnly)).toEqual([]);

      const handlers = setup();

      await handlers.get('providers.update')!({ id: created.id, params: { isEnabled: false } }, {});
      expect(getProviderRegistry().has('glm')).toBe(false);
      expect(getModelsCache().size).toBe(0);
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(false);

      await handlers.get('providers.update')!(
        { id: created.id, params: { isEnabled: true }, credentials: { apiKey: 'glm-key' } },
        {}
      );
      expect(getProviderRegistry().has('glm')).toBe(true);
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(false);

      const provider = getProviderRegistry().get('glm');
      expect(provider).toBeDefined();
      expect(await provider!.isAvailable()).toBe(true);

      expect(await detectStrandedProviders(anthropicOnly)).toEqual(['glm']);
    });

    it('disable preserves stored credentials: disable must not log the provider out', async () => {
      const created = repo.createProvider({
        providerId: 'glm',
        displayName: 'GLM',
        kind: 'built_in',
        authType: 'none',
      });
      await creds.storeOAuthTokens('glm', { accessToken: 'glm-oauth-token' });

      const logout = mock(async () => {});
      getProviderRegistry().register({
        id: 'glm',
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
        getModels: async () => [],
        ownsModel: () => true,
        getModelForTier: () => undefined,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: false }),
        logout,
        shutdown: mock(async () => {}),
      } as Provider);

      const handlers = setup();

      await handlers.get('providers.update')!({ id: created.id, params: { isEnabled: false } }, {});
      expect(getProviderRegistry().has('glm')).toBe(false);
      expect(logout).not.toHaveBeenCalled();
      expect(await creds.getCredentials('glm')).toEqual({
        type: 'oauth',
        accessToken: 'glm-oauth-token',
      });

      await handlers.get('providers.update')!({ id: created.id, params: { isEnabled: true } }, {});
      expect(getProviderRegistry().has('glm')).toBe(true);
      expect(logout).not.toHaveBeenCalled();
      expect(await creds.getCredentials('glm')).toEqual({
        type: 'oauth',
        accessToken: 'glm-oauth-token',
      });
    });
  });

  describe('providers.delete', () => {
    it('disables a built-in provider instead of deleting the row', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.delete')!({ id: created.id }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      const after = repo.getProvider(created.id);
      expect(after).not.toBeNull();
      expect(after?.isEnabled).toBe(false);
    });

    it('throws when provider not found', async () => {
      const handlers = setup();
      await expect(handlers.get('providers.delete')!({ id: 'missing' }, {})).rejects.toThrow(
        'not found'
      );
    });

    it('logs the provider out on delete (destructive removal clears stored credentials)', async () => {
      const created = repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const logout = mock(async () => {});
      getProviderRegistry().register({
        id: 'anthropic',
        displayName: 'Anthropic',
        capabilities: {
          streaming: false,
          extendedThinking: false,
          thinkingModes: 'off',
          maxContextWindow: 1000,
          functionCalling: false,
          vision: false,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: () => false,
        getModelForTier: () => undefined,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: false }),
        logout,
        shutdown: mock(async () => {}),
      } as Provider);
      const handlers = setup();

      const result = (await handlers.get('providers.delete')!({ id: created.id }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(logout).toHaveBeenCalled();
    });

    it('blocks delete when removeCredentials throws KeychainUnavailableError for built_in', async () => {
      const created = repo.createProvider({
        providerId: 'my-provider',
        displayName: 'My Provider',
        kind: 'built_in',
        authType: 'api_key',
      });
      creds.removeCredentials = mock(async () => {
        throw new KeychainUnavailableError('The user name or passphrase is not correct');
      });
      const handlers = setup();

      await expect(handlers.get('providers.delete')!({ id: created.id }, {})).rejects.toThrow(
        'security unlock-keychain'
      );

      expect(repo.getProvider(created.id)).not.toBeNull();
      expect(creds.removeCredentials).toHaveBeenCalledWith('my-provider');
      expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    it('allows custom_endpoint delete even when keychain is locked', async () => {
      const created = repo.createProvider({
        providerId: 'my-endpoint',
        displayName: 'My Endpoint',
        kind: 'custom_endpoint',
        authType: 'api_key',
      });
      creds.removeCredentials = mock(async () => {
        throw new KeychainUnavailableError('keychain locked');
      });
      const handlers = setup();

      const result = (await handlers.get('providers.delete')!({ id: created.id }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(repo.getProvider(created.id)).toBeNull();
      expect(creds.removeCredentials).not.toHaveBeenCalled();
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('rethrows non-keychain errors from removeCredentials', async () => {
      const created = repo.createProvider({
        providerId: 'my-provider',
        displayName: 'My Provider',
        kind: 'built_in',
        authType: 'api_key',
      });
      creds.removeCredentials = mock(async () => {
        throw new Error('database is locked');
      });
      const handlers = setup();

      await expect(handlers.get('providers.delete')!({ id: created.id }, {})).rejects.toThrow(
        'database is locked'
      );
    });
  });

  describe('providers.setDefault', () => {
    it('sets default provider', async () => {
      const a = repo.createProvider({
        providerId: 'a',
        displayName: 'A',
        kind: 'built_in',
        authType: 'none',
      });
      const b = repo.createProvider({
        providerId: 'b',
        displayName: 'B',
        kind: 'built_in',
        authType: 'none',
      });
      const handlers = setup();

      await handlers.get('providers.setDefault')!({ id: b.id }, {});
      expect(repo.getProvider(a.id)?.isDefault).toBe(false);
      expect(repo.getProvider(b.id)?.isDefault).toBe(true);
    });
  });

  describe('providers.test', () => {
    it('returns healthy for available provider', async () => {
      repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      const registry = getProviderRegistry();
      registry.register({
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
        getModels: async () => [],
        ownsModel: () => true,
        getModelForTier: () => 'sonnet',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);

      const handlers = setup();
      const result = (await handlers.get('providers.test')!(
        { id: repo.listProviders()[0].id },
        {}
      )) as {
        healthy: boolean;
      };

      expect(result.healthy).toBe(true);
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('probes the ACP command during provider tests even when models are cached', async () => {
      const created = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
      });
      const provider = new AcpProvider({}, async () => {
        throw new Error('command unavailable');
      });
      provider.setAcpCommand('broken acp');
      provider.setCachedModels([
        {
          id: 'acp-cached',
          name: 'ACP Cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          available: true,
        },
      ]);
      getProviderRegistry().register(provider);
      const handlers = setup();

      const result = (await handlers.get('providers.test')!({ id: created.id }, {})) as {
        healthy: boolean;
        error?: string;
      };

      expect(result).toEqual({ healthy: false, error: 'command unavailable' });
    });

    it('re-probes the ACP command on repeated explicit provider tests', async () => {
      const created = repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
      });
      let probes = 0;
      const provider = new AcpProvider({}, async () => {
        probes++;
      });
      provider.setAcpCommand('devin acp');
      getProviderRegistry().register(provider);
      const handlers = setup();

      await handlers.get('providers.test')!({ id: created.id }, {});
      await handlers.get('providers.test')!({ id: created.id }, {});

      expect(probes).toBe(2);
    });

    it('returns unhealthy for missing provider', async () => {
      const created = repo.createProvider({
        providerId: 'missing',
        displayName: 'Missing',
        kind: 'built_in',
        authType: 'api_key',
      });
      const handlers = setup();
      const result = (await handlers.get('providers.test')!({ id: created.id }, {})) as {
        healthy: boolean;
        error: string;
      };

      expect(result.healthy).toBe(false);
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });
  });

  describe('providers.healthCheck', () => {
    it('returns healthy results for available providers', async () => {
      repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'built_in',
        authType: 'api_key',
      });
      repo.createProvider({
        providerId: 'openrouter',
        displayName: 'OpenRouter',
        kind: 'built_in',
        authType: 'api_key',
      });
      const registry = getProviderRegistry();
      registry.register({
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
        getModels: async () => [],
        ownsModel: () => true,
        getModelForTier: () => 'sonnet',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);

      const handlers = setup();
      const result = (await handlers.get('providers.healthCheck')!({}, {})) as {
        results: Array<{ providerId: string; healthy: boolean; error?: string }>;
      };

      expect(result.results.length).toBe(2);
      const anthropic = result.results.find((r) => r.providerId === 'anthropic');
      const openrouter = result.results.find((r) => r.providerId === 'openrouter');
      expect(anthropic?.healthy).toBe(true);
      expect(openrouter?.healthy).toBe(false);
      expect(openrouter?.error).toBe('Not registered');
      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('probes ACP providers during bulk health checks even when models are cached', async () => {
      repo.createProvider({
        providerId: 'acp',
        displayName: 'ACP Agent',
        kind: 'built_in',
        authType: 'none',
      });
      const provider = new AcpProvider({}, async () => {
        throw new Error('command unavailable');
      });
      provider.setAcpCommand('broken acp');
      provider.setCachedModels([
        {
          id: 'acp-cached',
          name: 'ACP Cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          available: true,
        },
      ]);
      getProviderRegistry().register(provider);
      const handlers = setup();

      const result = (await handlers.get('providers.healthCheck')!({}, {})) as {
        results: Array<{ providerId: string; healthy: boolean; error?: string }>;
      };

      expect(result.results).toEqual([
        { providerId: 'acp', healthy: false, error: 'command unavailable' },
      ]);
    });

    it('returns unhealthy when provider is not available', async () => {
      repo.createProvider({
        providerId: 'unavailable',
        displayName: 'Unavailable',
        kind: 'built_in',
        authType: 'api_key',
      });
      const registry = getProviderRegistry();
      registry.register({
        id: 'unavailable',
        displayName: 'Unavailable',
        capabilities: {
          streaming: true,
          extendedThinking: false,
          thinkingModes: 'off',
          maxContextWindow: 1000,
          functionCalling: false,
          vision: false,
        },
        isAvailable: () => false,
        getModels: async () => [],
        ownsModel: () => true,
        getModelForTier: () => 'default',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);

      const handlers = setup();
      const result = (await handlers.get('providers.healthCheck')!({}, {})) as {
        results: Array<{ providerId: string; healthy: boolean; error?: string }>;
      };

      expect(result.results[0].healthy).toBe(false);
      expect(result.results[0].error).toBe('Not available');
    });

    it('returns unhealthy when getModels throws', async () => {
      repo.createProvider({
        providerId: 'broken',
        displayName: 'Broken',
        kind: 'built_in',
        authType: 'api_key',
      });
      const registry = getProviderRegistry();
      registry.register({
        id: 'broken',
        displayName: 'Broken',
        capabilities: {
          streaming: true,
          extendedThinking: false,
          thinkingModes: 'off',
          maxContextWindow: 1000,
          functionCalling: false,
          vision: false,
        },
        isAvailable: () => true,
        getModels: async () => {
          throw new Error('model fetch failed');
        },
        ownsModel: () => true,
        getModelForTier: () => 'default',
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);

      const handlers = setup();
      const result = (await handlers.get('providers.healthCheck')!({}, {})) as {
        results: Array<{ providerId: string; healthy: boolean; error?: string }>;
      };

      expect(result.results[0].healthy).toBe(false);
      expect(result.results[0].error).toBe('model fetch failed');
    });
  });

  describe('credential hydration (connected-vs-available gap)', () => {
    it('hydrates the live GLM provider on create with an API key', async () => {
      const handlers = setup();
      await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'glm',
            displayName: 'GLM',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'glm-key' },
        },
        {}
      );

      const provider = getProviderRegistry().get('glm');
      expect(provider).toBeDefined();
      expect(await provider!.isAvailable()).toBe(true);
    });

    it('hydrates from the request even when the credential-store read returns null', async () => {
      creds.getCredentials = mock(async () => null);
      const handlers = setup();

      await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'glm',
            displayName: 'GLM',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'glm-key' },
        },
        {}
      );

      const provider = getProviderRegistry().get('glm');
      expect(provider).toBeDefined();
      expect(await provider!.isAvailable()).toBe(true);
    });

    it('hydrates the live provider on update with an API key', async () => {
      const created = repo.createProvider({
        providerId: 'glm',
        displayName: 'GLM',
        kind: 'built_in',
        authType: 'none',
      });
      const handlers = setup();
      expect(getProviderRegistry().has('glm')).toBe(false);

      await handlers.get('providers.update')!(
        { id: created.id, params: {}, credentials: { apiKey: 'glm-key' } },
        {}
      );

      const provider = getProviderRegistry().get('glm');
      expect(provider).toBeDefined();
      expect(await provider!.isAvailable()).toBe(true);
    });

    it('invalidates the model cache when credentials change', async () => {
      const handlers = setup();
      await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'glm',
            displayName: 'GLM',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'glm-key' },
        },
        {}
      );

      expect(eventBus.publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });
    });

    it('preserves the live key on a config-only resync instead of re-reading a stale store', async () => {
      const handlers = setup();
      await handlers.get('providers.create')!(
        {
          params: {
            providerId: 'glm',
            displayName: 'GLM',
            kind: 'built_in',
            authType: 'api_key',
          },
          credentials: { apiKey: 'new' },
        },
        {}
      );
      const provider = getProviderRegistry().get('glm') as GlmProvider | undefined;
      const credAfterCreate = provider?.getCredentials();
      expect(credAfterCreate?.type === 'api_key' && credAfterCreate.apiKey).toBe('new');

      creds.getCredentials = mock(async () => ({ type: 'api_key', apiKey: 'old' }));

      const created = repo.listProviders().find((p) => p.providerId === 'glm')!;
      await handlers.get('providers.update')!(
        { id: created.id, params: { configJson: '{"region":"x"}' } },
        {}
      );

      const credAfterUpdate = provider?.getCredentials();
      expect(credAfterUpdate?.type === 'api_key' && credAfterUpdate.apiKey).toBe('new');
    });

    it('hydrateOAuth: submitted tokens win over a stale store, raw preserved', async () => {
      const staleCm = {
        getCredentials: mock(async () => ({
          type: 'oauth' as const,
          accessToken: 'stale-tok',
          refreshToken: 'stale-ref',
          expiresAt: 111,
          raw: { accountId: 'acct-1', planType: 'pro' },
        })),
      } as unknown as ProviderCredentialManager;

      const creds = await resolveCredentialsForHydration(staleCm, 'anthropic-codex', {
        oauthAccessToken: 'fresh-tok',
        oauthRefreshToken: 'fresh-ref',
        oauthExpiresAt: 222,
      });

      expect(creds).toEqual({
        type: 'oauth',
        accessToken: 'fresh-tok',
        refreshToken: 'fresh-ref',
        expiresAt: 222,
        raw: { accountId: 'acct-1', planType: 'pro' },
      });
    });

    it('hydrateOAuth: falls back to submitted tokens with no raw when store is empty', async () => {
      const emptyCm = {
        getCredentials: mock(async () => null),
      } as unknown as ProviderCredentialManager;

      const creds = await resolveCredentialsForHydration(emptyCm, 'anthropic-codex', {
        oauthAccessToken: 'fresh-tok',
        oauthRefreshToken: 'fresh-ref',
        oauthExpiresAt: 222,
      });

      expect(creds).toEqual({
        type: 'oauth',
        accessToken: 'fresh-tok',
        refreshToken: 'fresh-ref',
        expiresAt: 222,
      });
    });
  });
});
