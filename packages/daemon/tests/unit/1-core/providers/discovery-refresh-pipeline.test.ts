import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ModelInfo, ProviderRecord } from '@hyperneo/shared';
import type { Provider, ProviderId, ProviderSdkConfig } from '@hyperneo/shared/provider';
import type { ProviderRepository } from '../../../../src/storage/repositories/provider-repository';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import {
  applyDiscoveredSliceToLiveCache,
  assembleRefreshResult,
  type CommitSavedConfigDiscoveryRefreshCtx,
  type CommitSavedConfigDiscoveryRefreshDeps,
  credentialIdentity,
  markRefreshSucceededAndHealthy,
  persistLastGoodSlice,
  providerIgnoresSavedEndpoint,
  publishProvidersChangedWhenCoherent,
  revalidateBeforeCommittingSuccess,
  revalidateSavedConfigUnderLock,
  runCommitSavedConfigDiscoveryRefresh,
  stripPersistedDiscovery,
} from '../../../../src/lib/providers/discovery-refresh-pipeline';
import {
  applyDiscoveredProviderModels,
  clearModelsCache,
  getCurrentCacheLoad,
  getModelsCache,
  getModelsCacheClearSequence,
  getPendingProviderSlice,
  markModelsCacheSliceProtected,
  markProviderRefreshSucceeded,
  mergeDiscoveredWithStatic,
  releaseAppliedProviderSlice,
  restoreProviderModelsSlice,
  restoreProviderPendingSlice,
  schedulePendingSliceRelease,
  seedProviderCatalogModels,
  setModelsCache,
} from '../../../../src/lib/model-service';

function makeModel(id: string, provider = 'mock'): ModelInfo {
  return {
    id,
    name: id,
    alias: id,
    family: provider,
    provider,
    contextWindow: 128000,
    description: `${id} model`,
    releaseDate: '',
    available: true,
  };
}

function makeRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'row-1',
    providerId: 'mock',
    displayName: 'Mock',
    kind: 'built_in',
    authType: 'api_key',
    isEnabled: true,
    isDefault: false,
    sortOrder: 0,
    healthStatus: 'unknown',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createMockProviderRepo(...records: ProviderRecord[]) {
  const store = new Map(records.map((record) => [record.id, { ...record }]));
  const repo = {
    getProvider: (id: string) => store.get(id) ?? null,
    updateProvider: (id: string, params: Partial<ProviderRecord>) => {
      const existing = store.get(id);
      if (!existing) return null;
      Object.assign(existing, params, { updatedAt: 2 });
      return { ...existing };
    },
  };
  return { repo: repo as unknown as ProviderRepository, store };
}

class FakeProvider implements Provider {
  readonly id: ProviderId = 'mock';
  readonly displayName = 'Mock';
  readonly capabilities = {
    streaming: true,
    extendedThinking: false,
    thinkingModes: 'off' as const,
    maxContextWindow: 128000,
    functionCalling: true,
    vision: false,
  };
  clearModelCache = mock(() => {});
  getDiscoveryEndpointFingerprint = mock((baseUrl?: string) => `fp:${baseUrl ?? 'default'}`);

  constructor(
    private credentials: { type: 'api_key'; apiKey: string } | null = {
      type: 'api_key',
      apiKey: 'k',
    }
  ) {}

  async getCredentials() {
    return this.credentials;
  }

  isAvailable(): boolean {
    return true;
  }

  async getModels(): Promise<ModelInfo[]> {
    return [];
  }

  ownsModel(): boolean {
    return false;
  }

  getModelForTier(): string | undefined {
    return undefined;
  }

  buildSdkConfig(): ProviderSdkConfig {
    return { envVars: {}, isAnthropicCompatible: true };
  }
}

function createMockEventBus() {
  const published: Array<{ topic: string; payload: unknown }> = [];
  const bus = {
    publishAsync: mock(async (topic: string, payload: unknown) => {
      published.push({ topic, payload });
    }),
  };
  return { bus: bus as unknown as InternalEventBus<DaemonInternalEventMap>, published };
}

function withoutFingerprint(provider: FakeProvider): Provider {
  (provider as unknown as Record<string, unknown>).getDiscoveryEndpointFingerprint = undefined;
  return provider;
}

function padConfigForBudget(budget: number, fingerprint?: string): string {
  const wrapperReserve =
    `"discoveredModels":${JSON.stringify({ models: [], truncated: true })}`.length + 1;
  const fingerprintReserve =
    fingerprint === undefined ? 0 : `,"fingerprint":${JSON.stringify(fingerprint)}`.length;
  return JSON.stringify({
    pad: 'x'.repeat(64 * 1024 - 11 - wrapperReserve - fingerprintReserve - budget),
  });
}

function makeDeps(
  overrides: Partial<CommitSavedConfigDiscoveryRefreshDeps> = {}
): CommitSavedConfigDiscoveryRefreshDeps {
  return {
    providerRepo: createMockProviderRepo().repo,
    provider: new FakeProvider(),
    internalEventBus: createMockEventBus().bus,
    getModelsCacheClearSequence,
    getCurrentCacheLoad,
    getModelsCache,
    restoreProviderModelsSlice,
    applyDiscoveredProviderModels,
    releaseAppliedProviderSlice,
    getPendingProviderSlice,
    restoreProviderPendingSlice,
    schedulePendingSliceRelease,
    markProviderRefreshSucceeded,
    mergeDiscoveredWithStatic,
    markModelsCacheSliceProtected,
    seedProviderCatalogModels,
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<CommitSavedConfigDiscoveryRefreshCtx> = {}
): CommitSavedConfigDiscoveryRefreshCtx {
  return {
    deps: makeDeps(),
    providerId: 'mock',
    rowId: 'row-1',
    savedConfig: { baseUrl: undefined, configJson: undefined },
    discoveryBaseUrl: undefined,
    originalConfigJson: undefined,
    credentialsAtStart: 'null',
    clearsAtStart: getModelsCacheClearSequence(),
    discovered: [makeModel('mock-1'), makeModel('mock-2')],
    persistedDiscovered: [],
    ...overrides,
  };
}

describe('discovery-refresh pipeline helpers', () => {
  beforeEach(() => {
    resetProviderRegistry();
    clearModelsCache();
  });

  afterEach(() => {
    resetProviderRegistry();
    clearModelsCache();
  });

  describe('stripPersistedDiscovery', () => {
    it('removes the discoveredModels wrapper and keeps other keys', () => {
      const stripped = stripPersistedDiscovery(
        JSON.stringify({ command: 'x', discoveredModels: { models: [{ id: 'a' }] } })
      );
      expect(JSON.parse(stripped!)).toEqual({ command: 'x' });
    });

    it('returns invalid or wrapper-free config unchanged', () => {
      expect(stripPersistedDiscovery('not json')).toBe('not json');
      expect(stripPersistedDiscovery(JSON.stringify([1]))).toBe(JSON.stringify([1]));
      expect(stripPersistedDiscovery(JSON.stringify({ command: 'x' }))).toBe(
        JSON.stringify({ command: 'x' })
      );
      expect(stripPersistedDiscovery(undefined)).toBeUndefined();
    });
  });

  describe('credentialIdentity', () => {
    it('snapshots null, api keys, and volatility-stable oauth identities', () => {
      expect(credentialIdentity(null)).toBe('null');
      expect(credentialIdentity(undefined)).toBe('null');
      expect(credentialIdentity({ type: 'api_key', apiKey: 'a' })).not.toBe(
        credentialIdentity({ type: 'api_key', apiKey: 'b' })
      );
      expect(
        credentialIdentity({ type: 'oauth', accessToken: 'volatile', refreshToken: 'r' })
      ).toBe(credentialIdentity({ type: 'oauth', accessToken: 'other', refreshToken: 'r' }));
      expect(credentialIdentity({ type: 'oauth', accessToken: 'a' })).not.toBe(
        credentialIdentity({ type: 'oauth', accessToken: 'b' })
      );
    });
  });

  describe('providerIgnoresSavedEndpoint', () => {
    it('ignores saved endpoints only when the fingerprint does not depend on them', () => {
      const fingerprinted = new FakeProvider();
      expect(providerIgnoresSavedEndpoint(fingerprinted, undefined)).toBe(false);
      expect(providerIgnoresSavedEndpoint(fingerprinted, 'https://x')).toBe(false);

      const fixed = new (class extends FakeProvider {
        getDiscoveryEndpointFingerprint = mock(() => 'same');
      })();
      expect(providerIgnoresSavedEndpoint(fixed, 'https://x')).toBe(true);

      const throwing = new (class extends FakeProvider {
        getDiscoveryEndpointFingerprint = mock(() => {
          throw new Error('unsupported');
        });
      })();
      const anthropic = new (class extends FakeProvider {
        readonly id = 'anthropic' as const;
      })();
      expect(providerIgnoresSavedEndpoint(anthropic, 'https://x')).toBe(true);
      const copilot = withoutFingerprint(
        new (class extends FakeProvider {
          readonly id = 'anthropic-copilot' as const;
        })()
      );
      expect(providerIgnoresSavedEndpoint(copilot, 'https://x')).toBe(true);
      expect(providerIgnoresSavedEndpoint(throwing, 'https://x')).toBe(false);
    });
  });

  describe('revalidateSavedConfigUnderLock', () => {
    it('halts as superseded when the saved config row changed', async () => {
      const { repo } = createMockProviderRepo(makeRecord({ configJson: 'changed' }));
      const provider = new FakeProvider();
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo, provider }),
        savedConfig: { configJson: 'original' },
      });
      const out = await revalidateSavedConfigUnderLock(ctx);
      expect(out.outcome).toEqual({ success: false, reason: 'superseded' });
      expect(provider.clearModelCache).toHaveBeenCalledTimes(1);
    });

    it('enriches the context with the current record when unchanged', async () => {
      const record = makeRecord();
      const { repo } = createMockProviderRepo(record);
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo, provider: new FakeProvider(null) }),
        savedConfig: { configJson: undefined },
        credentialsAtStart: 'null',
      });
      const out = await revalidateSavedConfigUnderLock(ctx);
      expect(out.outcome).toBeUndefined();
      expect(out.currentRecord).toEqual(record);
    });
  });

  describe('persistLastGoodSlice', () => {
    it('persists curated-first discovered ids under the wrapper key', () => {
      getProviderRegistry().setCuratedModels('mock', [{ id: 'mock-2', name: 'Mock 2' }]);
      const { repo, store } = createMockProviderRepo(makeRecord({ configJson: '{"a":1}' }));
      const ctx = makeCtx({
        deps: makeDeps({
          providerRepo: repo,
          provider: new (class extends FakeProvider {
            getDiscoveryEndpointFingerprint = mock(() => 'fp:saved');
          })(),
        }),
        discoveryBaseUrl: 'https://saved',
        currentRecord: store.get('row-1') ?? null,
      });
      const out = persistLastGoodSlice(ctx);
      expect(out.truncated).toBe(false);
      const persisted = JSON.parse(store.get('row-1')!.configJson!);
      expect(persisted).toEqual({
        a: 1,
        discoveredModels: {
          models: [
            { id: 'mock-2', name: 'Mock 2' },
            { id: 'mock-1', name: 'mock-1' },
          ],
          fingerprint: 'fp:saved',
        },
      });
      expect(out.persistedConfig).toEqual({
        baseUrl: undefined,
        configJson: store.get('row-1')!.configJson,
      });
      expect(out.persistedEntries).toEqual([
        { id: 'mock-2', name: 'Mock 2' },
        { id: 'mock-1', name: 'mock-1' },
      ]);
    });

    it('canonicalizes curated aliases against the discovered catalog when persisting', () => {
      getProviderRegistry().setCuratedModels('mock', [{ id: 'mock-k3' }]);
      const { repo, store } = createMockProviderRepo(makeRecord());
      const canonical = { ...makeModel('mock-k3[1m]'), name: 'Mock K3', alias: 'mock-k3' };
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo }),
        discovered: [canonical],
        currentRecord: store.get('row-1') ?? null,
      });
      const out = persistLastGoodSlice(ctx);
      expect(out.persistedEntries).toEqual([{ id: 'mock-k3[1m]', name: 'Mock K3' }]);
      const persisted = JSON.parse(store.get('row-1')!.configJson!);
      expect(persisted.discoveredModels.models).toEqual([{ id: 'mock-k3[1m]', name: 'Mock K3' }]);
    });

    it('delegates bounding to the landed builder, reserving bare capacity for later curated ids', () => {
      const longName = 'A'.repeat(60);
      getProviderRegistry().setCuratedModels('mock', [
        { id: 'cur-a', name: longName },
        { id: 'cur-b' },
      ]);
      const fullFirst = JSON.stringify({ id: 'cur-a', name: longName }).length;
      const { repo, store } = createMockProviderRepo(
        makeRecord({ configJson: padConfigForBudget(2 + fullFirst, 'fp:default') })
      );
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo }),
        discovered: [makeModel('cur-a'), makeModel('cur-b')],
        currentRecord: store.get('row-1') ?? null,
      });
      const out = persistLastGoodSlice(ctx);
      expect(out.truncated).toBe(false);
      const persisted = JSON.parse(store.get('row-1')!.configJson!);
      expect(persisted.discoveredModels).toEqual({
        models: [{ id: 'cur-a' }, { id: 'cur-b', name: 'cur-b' }],
        fingerprint: 'fp:default',
      });
      expect(out.persistedEntries).toEqual([{ id: 'cur-a' }, { id: 'cur-b', name: 'cur-b' }]);
    });

    it('rejects persistence when the remaining config budget cannot hold the wrapper', () => {
      const provider = new FakeProvider();
      const { repo, store } = createMockProviderRepo(
        makeRecord({ configJson: padConfigForBudget(1, 'fp:default') })
      );
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo, provider }),
        currentRecord: store.get('row-1') ?? null,
      });
      expect(() => persistLastGoodSlice(ctx)).toThrow(/no capacity to persist discovery results/);
      expect(provider.clearModelCache).toHaveBeenCalledTimes(1);
    });

    it('clears the provider cache and rethrows when the saved config is unwritable', () => {
      const provider = new FakeProvider();
      const { repo } = createMockProviderRepo(makeRecord({ configJson: 'not json' }));
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo, provider }),
        currentRecord: makeRecord({ configJson: 'not json' }),
      });
      expect(() => persistLastGoodSlice(ctx)).toThrow(/not valid JSON/);
      expect(provider.clearModelCache).toHaveBeenCalledTimes(1);
    });

    it('rejects endpoint-specific persistence when no fingerprint is available', () => {
      const provider = withoutFingerprint(new FakeProvider());
      const { repo, store } = createMockProviderRepo(makeRecord({ configJson: '{"a":1}' }));
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo, provider }),
        discoveryBaseUrl: 'https://saved',
        currentRecord: store.get('row-1') ?? null,
      });
      expect(() => persistLastGoodSlice(ctx)).toThrow(/without an endpoint fingerprint/);
      expect(provider.clearModelCache).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.get('row-1')!.configJson!)).toEqual({ a: 1 });
    });
  });

  describe('applyDiscoveredSliceToLiveCache', () => {
    it('applies the normalized slice and releases the pending overlay', async () => {
      setModelsCache(new Map([['global', [makeModel('other-1', 'other')]]]));
      const applied: string[] = [];
      const protectedKeys: string[] = [];
      const deps = makeDeps({
        applyDiscoveredProviderModels: ((providerId: string, models: ModelInfo[]) => {
          applied.push(providerId);
          return { applied: true, models };
        }) as CommitSavedConfigDiscoveryRefreshDeps['applyDiscoveredProviderModels'],
        getModelsCache: () => getModelsCache(),
        getPendingProviderSlice: () => [makeModel('stale-overlay')],
        markModelsCacheSliceProtected: (cacheKey?: string) => protectedKeys.push(cacheKey ?? ''),
      });
      const out = await applyDiscoveredSliceToLiveCache(
        makeCtx({ deps, discoveryBaseUrl: 'https://saved' })
      );
      expect(applied).toEqual(['mock']);
      expect(out.appliedSlice!.map((model) => model.id)).toEqual(['mock-1', 'mock-2']);
      expect(out.previousOverlay).toEqual([makeModel('stale-overlay')]);
      expect(protectedKeys).toEqual([]);
    });

    it('schedules a pending release when the cache is not initialized', async () => {
      setModelsCache(new Map());
      const scheduled: string[] = [];
      const deps = makeDeps({
        applyDiscoveredProviderModels: ((_providerId: string, models: ModelInfo[]) => ({
          applied: false,
          models,
        })) as CommitSavedConfigDiscoveryRefreshDeps['applyDiscoveredProviderModels'],
        getModelsCache: () => new Map(),
        getCurrentCacheLoad: () => undefined,
        schedulePendingSliceRelease: (providerId: string) => scheduled.push(providerId),
      });
      const out = await applyDiscoveredSliceToLiveCache(makeCtx({ deps }));
      expect(scheduled).toEqual(['mock']);
      expect(out.appliedSlice!.map((model) => model.id)).toEqual(['mock-1', 'mock-2']);
    });

    it('rolls back and halts when superseded while awaiting an in-flight cache load', async () => {
      let resolveLoad: () => void = () => {};
      const load = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      const { repo, store } = createMockProviderRepo(makeRecord({ configJson: '{"a":1}' }));
      const restored: string[] = [];
      const deps = makeDeps({
        providerRepo: repo,
        applyDiscoveredProviderModels: ((_providerId: string, models: ModelInfo[]) => ({
          applied: false,
          models,
        })) as CommitSavedConfigDiscoveryRefreshDeps['applyDiscoveredProviderModels'],
        getModelsCache: () => new Map(),
        getCurrentCacheLoad: () => load,
        restoreProviderModelsSlice: (providerId: string) => restored.push(providerId),
      });
      const run = applyDiscoveredSliceToLiveCache(
        makeCtx({
          deps,
          persistedConfig: { configJson: JSON.stringify({ a: 1 }) },
          originalConfigJson: undefined,
        })
      );
      store.get('row-1')!.configJson = '{"a":2}';
      resolveLoad();
      const out = await run;
      expect(out.outcome).toEqual({ success: false, reason: 'superseded' });
      expect(restored).toEqual(['mock']);
      expect(JSON.parse(store.get('row-1')!.configJson!)).toEqual({ a: 2 });
    });

    it('skips snapshot restores when a cache clear caused the supersession', async () => {
      let resolveLoad: () => void = () => {};
      const load = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      const { repo, store } = createMockProviderRepo(makeRecord({ configJson: '{"a":1}' }));
      const restored: string[] = [];
      const deps = makeDeps({
        providerRepo: repo,
        applyDiscoveredProviderModels: ((_providerId: string, models: ModelInfo[]) => ({
          applied: false,
          models,
        })) as CommitSavedConfigDiscoveryRefreshDeps['applyDiscoveredProviderModels'],
        getModelsCache: () => new Map(),
        getCurrentCacheLoad: () => load,
        getModelsCacheClearSequence: () => 6,
        restoreProviderModelsSlice: (providerId: string) => restored.push(providerId),
      });
      const run = applyDiscoveredSliceToLiveCache(
        makeCtx({
          deps,
          clearsAtStart: 5,
          persistedConfig: { configJson: JSON.stringify({ a: 1 }) },
          originalConfigJson: '{"orig":1}',
        })
      );
      resolveLoad();
      const out = await run;
      expect(out.outcome).toEqual({ success: false, reason: 'superseded' });
      expect(restored).toEqual([]);
      expect(JSON.parse(store.get('row-1')!.configJson!)).toEqual({ orig: 1 });
    });

    it('keeps the pre-apply slice for rollback across the deferred retry', async () => {
      let resolveLoad: () => void = () => {};
      const load = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      const { repo } = createMockProviderRepo(
        makeRecord({ configJson: '{"a":1}', baseUrl: undefined })
      );
      const cacheMap = new Map<string, ModelInfo[]>();
      let applyCalls = 0;
      const deps = makeDeps({
        providerRepo: repo,
        provider: new FakeProvider(null),
        applyDiscoveredProviderModels: ((_providerId: string, models: ModelInfo[]) => {
          applyCalls += 1;
          return { applied: applyCalls > 1, models };
        }) as CommitSavedConfigDiscoveryRefreshDeps['applyDiscoveredProviderModels'],
        getModelsCache: (() => cacheMap) as CommitSavedConfigDiscoveryRefreshDeps['getModelsCache'],
        getCurrentCacheLoad: () =>
          load.then(() => {
            cacheMap.set('global', [makeModel('mock-1'), makeModel('mock-2')]);
          }),
      });
      const run = applyDiscoveredSliceToLiveCache(
        makeCtx({
          deps,
          credentialsAtStart: 'null',
          persistedConfig: { configJson: JSON.stringify({ a: 1 }) },
        })
      );
      resolveLoad();
      const out = await run;
      expect(out.outcome).toBeUndefined();
      expect(out.appliedSlice!.map((model) => model.id)).toEqual(['mock-1', 'mock-2']);
      expect(out.previousSlice).toEqual([]);
    });

    it('seeds from the newly persisted entries rather than the pre-refresh snapshot', async () => {
      const seededFrom: Array<ReadonlyArray<{ id: string; name?: string }>> = [];
      const deps = makeDeps({
        applyDiscoveredProviderModels: ((
          _providerId: string,
          models: ModelInfo[],
          _cacheKey?: string,
          persistedDiscovered?: ReadonlyArray<{ id: string; name?: string }>
        ) => {
          seededFrom.push(persistedDiscovered ?? []);
          return { applied: true, models };
        }) as CommitSavedConfigDiscoveryRefreshDeps['applyDiscoveredProviderModels'],
        getModelsCache: () => new Map([['global', []]]),
      });
      const out = await applyDiscoveredSliceToLiveCache(
        makeCtx({
          deps,
          persistedDiscovered: [{ id: 'old-entry' }],
          persistedEntries: [{ id: 'curated-only', name: 'Curated Only' }],
        })
      );
      expect(out.outcome).toBeUndefined();
      expect(seededFrom).toEqual([[{ id: 'curated-only', name: 'Curated Only' }]]);
    });
  });

  describe('revalidateBeforeCommittingSuccess', () => {
    it('restores prior slices and reverts the persisted wrapper when superseded', async () => {
      const { repo, store } = createMockProviderRepo(makeRecord({ configJson: '{"persisted":1}' }));
      const restored: string[] = [];
      const overlays: Array<ModelInfo[] | undefined> = [];
      const deps = makeDeps({
        providerRepo: repo,
        restoreProviderModelsSlice: (providerId: string) => restored.push(providerId),
        restoreProviderPendingSlice: (_providerId: string, slice) => overlays.push(slice),
      });
      const ctx = makeCtx({
        deps,
        persistedConfig: { configJson: store.get('row-1')!.configJson },
        originalConfigJson: '{"original":1}',
        previousSlice: [makeModel('prior-1')],
        previousOverlay: undefined,
      });
      const out = await revalidateBeforeCommittingSuccess(ctx);
      expect(out.outcome).toEqual({ success: false, reason: 'superseded' });
      expect(restored).toEqual(['mock']);
      expect(overlays).toEqual([undefined]);
      expect(JSON.parse(store.get('row-1')!.configJson!)).toEqual({ original: 1 });
    });

    it('skips snapshot restores when a cache clear caused the supersession', async () => {
      const { repo, store } = createMockProviderRepo(makeRecord({ configJson: '{"persisted":1}' }));
      const restored: string[] = [];
      const overlays: Array<ModelInfo[] | undefined> = [];
      const deps = makeDeps({
        providerRepo: repo,
        getModelsCacheClearSequence: () => 6,
        restoreProviderModelsSlice: (providerId: string) => restored.push(providerId),
        restoreProviderPendingSlice: (_providerId, slice) => overlays.push(slice),
      });
      const out = await revalidateBeforeCommittingSuccess(
        makeCtx({
          deps,
          clearsAtStart: 5,
          persistedConfig: { configJson: store.get('row-1')!.configJson },
          originalConfigJson: '{"original":1}',
          previousSlice: [makeModel('prior-1')],
        })
      );
      expect(out.outcome).toEqual({ success: false, reason: 'superseded' });
      expect(restored).toEqual([]);
      expect(overlays).toEqual([]);
      expect(JSON.parse(store.get('row-1')!.configJson!)).toEqual({ original: 1 });
    });

    it('passes through when the commit is still current', async () => {
      const { repo } = createMockProviderRepo(makeRecord());
      const provider = new FakeProvider(null);
      const ctx = makeCtx({
        deps: makeDeps({ providerRepo: repo, provider }),
        credentialsAtStart: 'null',
        persistedConfig: { configJson: undefined },
      });
      const out = await revalidateBeforeCommittingSuccess(ctx);
      expect(out).toBe(ctx);
    });
  });

  describe('markRefreshSucceededAndHealthy / publish / assemble', () => {
    it('marks success, seeds the catalog from the applied slice, and updates health', () => {
      const { repo, store } = createMockProviderRepo(makeRecord());
      const seeded: ModelInfo[][] = [];
      const protectedKeys: string[] = [];
      const deps = makeDeps({
        providerRepo: repo,
        markProviderRefreshSucceeded: () => true,
        seedProviderCatalogModels: (_provider, models) => seeded.push(models),
        markModelsCacheSliceProtected: (cacheKey?: string) => protectedKeys.push(cacheKey ?? ''),
      });
      const ctx = makeCtx({ deps, appliedSlice: [makeModel('applied-1')] });
      const out = markRefreshSucceededAndHealthy(ctx);
      expect(out.recoveredFailure).toBe(true);
      expect(seeded).toEqual([[makeModel('applied-1')]]);
      expect(protectedKeys).toEqual([]);
      expect(store.get('row-1')!.healthStatus).toBe('healthy');
      expect(store.get('row-1')!.lastHealthCheckAt).toBeGreaterThan(0);
    });

    it('protects the cache on success only for endpoint-specific refreshes', () => {
      const protectedKeys: string[] = [];
      const deps = makeDeps({
        markModelsCacheSliceProtected: (cacheKey?: string) => protectedKeys.push(cacheKey ?? ''),
      });
      markRefreshSucceededAndHealthy(makeCtx({ deps, discoveryBaseUrl: 'https://saved' }));
      expect(protectedKeys).toEqual(['global']);
    });

    it('defers failure-state clearing until the health row is persisted', () => {
      const marked: string[] = [];
      const deps = makeDeps({
        providerRepo: {
          getProvider: () => makeRecord(),
          updateProvider: () => {
            throw new Error('db locked');
          },
        } as unknown as ProviderRepository,
        markProviderRefreshSucceeded: (providerId: string) => {
          marked.push(providerId);
          return false;
        },
      });
      expect(() => markRefreshSucceededAndHealthy(makeCtx({ deps }))).toThrow(/db locked/);
      expect(marked).toEqual([]);
    });

    it('publishes providers.changed only when no failure was recovered', () => {
      const { bus, published } = createMockEventBus();
      expect(
        publishProvidersChangedWhenCoherent(
          makeCtx({ deps: makeDeps({ internalEventBus: bus }), recoveredFailure: false })
        ).outcome
      ).toBeUndefined();
      expect(published).toEqual([{ topic: 'providers.changed', payload: { sessionId: 'global' } }]);
      expect(
        publishProvidersChangedWhenCoherent(
          makeCtx({ deps: makeDeps({ internalEventBus: bus }), recoveredFailure: true })
        ).outcome
      ).toBeUndefined();
      expect(published).toHaveLength(1);
    });

    it('assembles the success outcome from the discovered slice', () => {
      const outcome = assembleRefreshResult(makeCtx({ truncated: true })).outcome;
      expect(outcome).toEqual({
        success: true,
        truncated: true,
        models: [
          { id: 'mock-1', name: 'mock-1' },
          { id: 'mock-2', name: 'mock-2' },
        ],
      });
    });
  });
});

describe('runCommitSavedConfigDiscoveryRefresh', () => {
  beforeEach(() => {
    resetProviderRegistry();
    clearModelsCache();
  });

  afterEach(() => {
    resetProviderRegistry();
    clearModelsCache();
  });

  it('commits persist -> apply -> publish against the landed model-service pipes', async () => {
    const record = makeRecord();
    const { repo, store } = createMockProviderRepo(record);
    const { bus, published } = createMockEventBus();
    setModelsCache(new Map([['global', [makeModel('resident-1', 'other')]]]));
    const provider = new FakeProvider();
    const ctx = makeCtx({
      deps: makeDeps({
        providerRepo: repo,
        provider,
        internalEventBus: bus,
        getModelsCache: () => getModelsCache(),
      }),
      credentialsAtStart: credentialIdentity(await provider.getCredentials()),
      clearsAtStart: getModelsCacheClearSequence(),
    });
    const out = await runCommitSavedConfigDiscoveryRefresh(ctx);
    expect(out.outcome).toEqual({
      success: true,
      models: [
        { id: 'mock-1', name: 'mock-1' },
        { id: 'mock-2', name: 'mock-2' },
      ],
    });
    const persisted = JSON.parse(store.get('row-1')!.configJson!);
    expect(persisted.discoveredModels.models.map((model: { id: string }) => model.id)).toEqual([
      'mock-1',
      'mock-2',
    ]);
    expect(
      getModelsCache()
        .get('global')!
        .map((model) => model.id)
    ).toEqual(['resident-1', 'mock-1', 'mock-2']);
    expect(store.get('row-1')!.healthStatus).toBe('healthy');
    expect(published).toEqual([{ topic: 'providers.changed', payload: { sessionId: 'global' } }]);
  });

  it('halts before persisting when the saved config was superseded under the lock', async () => {
    const { repo, store } = createMockProviderRepo(makeRecord({ configJson: '{"a":2}' }));
    const { bus, published } = createMockEventBus();
    const ctx = makeCtx({
      deps: makeDeps({ providerRepo: repo, internalEventBus: bus }),
      savedConfig: { configJson: '{"a":1}' },
    });
    const out = await runCommitSavedConfigDiscoveryRefresh(ctx);
    expect(out.outcome).toEqual({ success: false, reason: 'superseded' });
    expect(JSON.parse(store.get('row-1')!.configJson!)).toEqual({ a: 2 });
    expect(published).toHaveLength(0);
  });

  it('never protects the cache when an endpoint-specific commit is superseded at final revalidation', async () => {
    const original = makeRecord({ configJson: '{"orig":1}' });
    const store = new Map([[original.id, { ...original }]]);
    let reads = 0;
    const repo = {
      getProvider: (id: string) => {
        reads += 1;
        const row = store.get(id);
        if (!row) return null;
        if (reads >= 4 && row.configJson !== '{"externally-changed":1}') {
          row.configJson = '{"externally-changed":1}';
        }
        return { ...row };
      },
      updateProvider: (id: string, params: Partial<ProviderRecord>) => {
        const existing = store.get(id);
        if (!existing) return null;
        Object.assign(existing, params);
        return { ...existing };
      },
    } as unknown as ProviderRepository;
    const protectedKeys: string[] = [];
    setModelsCache(new Map([['global', [makeModel('resident-1', 'other')]]]));
    const provider = new FakeProvider(null);
    const ctx = makeCtx({
      deps: makeDeps({
        providerRepo: repo,
        provider,
        getModelsCache: () => getModelsCache(),
        markModelsCacheSliceProtected: (cacheKey?: string) => protectedKeys.push(cacheKey ?? ''),
      }),
      savedConfig: { configJson: '{"orig":1}' },
      discoveryBaseUrl: 'https://saved',
      credentialsAtStart: 'null',
      clearsAtStart: getModelsCacheClearSequence(),
    });
    const out = await runCommitSavedConfigDiscoveryRefresh(ctx);
    expect(out.outcome).toEqual({ success: false, reason: 'superseded' });
    expect(protectedKeys).toEqual([]);
    expect(JSON.parse(store.get('row-1')!.configJson!)).toEqual({ 'externally-changed': 1 });
  });
});
