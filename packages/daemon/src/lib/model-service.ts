import type { ModelInfo, Session } from '@hyperneo/shared';
import type { QueryLike } from './agent/query-like.ts';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';
import { getProviderRegistry } from './providers/registry.js';
import {
  clearProviderFailure,
  classifyProviderFailure,
  getAllProviderFailures,
  getProviderFailure,
  recordClassifiedProviderFailure,
  removeProviderFailure,
} from './providers/provider-failure-store.js';
import type {
  Provider,
  ProviderFailureErrorKind,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import { getCodexBridgeModelInfos, resolveCodexBridgeModelId } from './providers/codex-models.js';
import { GlmProvider } from './providers/glm-provider.js';
import { KimiProvider } from './providers/kimi-provider.js';
import { DeepSeekProvider } from './providers/deepseek-provider.js';
import { MinimaxProvider } from './providers/minimax-provider.js';
import { COPILOT_ANTHROPIC_MODELS } from './providers/anthropic-copilot/models.js';

const LEGACY_MODEL_MAPPINGS: Record<string, string> = {
  default: 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5-20250929': 'sonnet',
  'claude-sonnet-4-20241022': 'sonnet',
  'claude-3-5-sonnet-20241022': 'sonnet',
  'claude-opus-4-5-20251101': 'opus',
  'claude-opus-4-20250514': 'opus',
  'claude-haiku-4-5-20251001': 'haiku',
  'claude-3-5-haiku-20241022': 'haiku',
};

const modelsCache = new Map<string, ModelInfo[]>();

const cacheTimestamps = new Map<string, number>();

const CACHE_TTL = 4 * 60 * 60 * 1000;

const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'sonnet',
    name: 'Claude Sonnet',
    alias: 'default',
    family: 'sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    description: 'Best balance of speed and intelligence',
    releaseDate: '2025-01-01',
    available: true,
  },
  {
    id: 'opus',
    name: 'Claude Opus',
    alias: 'opus',
    family: 'opus',
    provider: 'anthropic',
    contextWindow: 200000,
    description: 'Most capable model for complex tasks',
    releaseDate: '2025-01-01',
    available: true,
  },
  {
    id: 'haiku',
    name: 'Claude Haiku',
    alias: 'haiku',
    family: 'haiku',
    provider: 'anthropic',
    contextWindow: 200000,
    description: 'Fastest and most compact model',
    releaseDate: '2025-01-01',
    available: true,
  },
];

const STATIC_MODEL_METADATA: ModelInfo[] = [
  ...FALLBACK_MODELS,
  ...getCodexBridgeModelInfos(),
  ...GlmProvider.MODELS,
  ...KimiProvider.MODELS,
  ...DeepSeekProvider.MODELS,
  ...MinimaxProvider.MODELS,
  ...COPILOT_ANTHROPIC_MODELS,
];
const CODEX_STATIC_MODEL_METADATA = getCodexBridgeModelInfos();
const COPILOT_LEGACY_CODEX_STATIC_METADATA: ModelInfo[] = [
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex Mini',
    alias: 'codex-5.1-mini',
    providerAliases: ['gpt-5.1-mini'],
    family: 'gpt',
    provider: 'anthropic-copilot',
    contextWindow: 128000,
    preferContextWindowMetadata: true,
    description: 'GPT-5.1 Codex Mini via GitHub Copilot',
    releaseDate: '2025-12-01',
    available: true,
  },
];

export function getCuratedModelIds(providerId: string): Set<string> | undefined {
  const curatedModels = getProviderRegistry().getCuratedModels(providerId);
  if (curatedModels === undefined) return undefined;
  const curatedIds = new Set<string>();
  const staticProviderModels = STATIC_MODEL_METADATA.filter(
    (model) => model.provider === providerId
  );
  for (const curated of curatedModels) {
    curatedIds.add(curated.id);
    if (!KimiProvider.isCapacityTaggedModelId(curated.id)) {
      const canonical = findInModels(staticProviderModels, curated.id)?.id;
      if (canonical) curatedIds.add(canonical);
    }
  }
  return curatedIds;
}

function filterProviderModels(providerId: string, models: ModelInfo[]): ModelInfo[] {
  const curatedIds = getCuratedModelIds(providerId);
  return curatedIds === undefined ? models : models.filter((model) => curatedIds.has(model.id));
}

function filterModelsByCuration(models: ModelInfo[]): ModelInfo[] {
  const curatedIdsByProvider = new Map<string, Set<string> | undefined>();
  return models.filter((model) => {
    if (!curatedIdsByProvider.has(model.provider)) {
      curatedIdsByProvider.set(model.provider, getCuratedModelIds(model.provider));
    }
    const curatedIds = curatedIdsByProvider.get(model.provider);
    return curatedIds === undefined || curatedIds.has(model.id);
  });
}

function mergeWithFallbackModels(
  providerModels: ModelInfo[],
  unavailableProviders?: ReadonlySet<string>
): ModelInfo[] {
  const modelMap = new Map<string, ModelInfo>();
  const registry = getProviderRegistry();

  for (const model of FALLBACK_MODELS) {
    if (registry.has(model.provider) && !unavailableProviders?.has(model.provider)) {
      modelMap.set(`${model.provider}:${model.id}`, model);
    }
  }

  for (const model of providerModels) {
    modelMap.set(`${model.provider}:${model.id}`, model);
  }

  return Array.from(modelMap.values());
}

const refreshInProgress = new Map<string, Promise<void>>();

const cacheGeneration = new Map<string, number>();

const PROVIDER_RETRY_BACKOFF_MS = 60_000;

interface ProviderRetryEntry {
  lastAttemptAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const providerRetryEntries = new Map<string, ProviderRetryEntry>();

let providerRetryGeneration = 0;

let modelLoadSequence = 0;

const providerAppliedSeq = new Map<string, number>();

const refreshModes = new Map<string, boolean>();

const pendingProviderSlices = new Map<string, ModelInfo[]>();

function pendingSliceKey(cacheKey: string, providerId: string): string {
  return `${cacheKey}:${providerId}`;
}

function mergePendingProviderSlices(cacheKey: string, models: ModelInfo[]): ModelInfo[] {
  let merged = models;
  for (const [key, slice] of pendingProviderSlices) {
    if (!key.startsWith(`${cacheKey}:`)) continue;
    const providerId = key.slice(cacheKey.length + 1);
    merged = [...merged.filter((model) => model.provider !== providerId), ...slice];
  }
  return merged;
}

export async function getSupportedModelsFromQuery(
  queryObject: QueryLike | null,
  cacheKey: string = 'global'
): Promise<ModelInfo[]> {
  if (modelsCache.has(cacheKey)) {
    return modelsCache.get(cacheKey)!;
  }

  if (queryObject && typeof queryObject.supportedModels === 'function') {
    try {
      const { getAnthropicModelsFromQuery } = await import('./providers/anthropic-provider.js');
      const models = await getAnthropicModelsFromQuery(queryObject);
      if (models.length > 0) {
        modelsCache.set(cacheKey, models);
        cacheTimestamps.set(cacheKey, Date.now());
        return models;
      }
      /* v8 ignore next 2 */
    } catch {}
  }

  return [];
}

function getAvailableProviders(): Provider[] {
  const registry = getProviderRegistry();
  return registry.getAll();
}

function applyRefreshedModels(
  cacheKey: string,
  fetchedModels: ModelInfo[],
  previousModels: ModelInfo[] | undefined,
  supersededProviderIds: string[] = [],
  preservePreviousOnShrink = true,
  unavailableProviders?: ReadonlySet<string>
): void {
  if (fetchedModels.length > 0) {
    const mergedModels = mergeWithFallbackModels(fetchedModels, unavailableProviders);
    if (preservePreviousOnShrink && previousModels && previousModels.length > mergedModels.length) {
      const superseded = new Set(supersededProviderIds);
      const retainedPrevious = previousModels.filter((m) => !superseded.has(m.provider));
      const supersededSlices = mergedModels.filter((m) => superseded.has(m.provider));
      const overlaid =
        superseded.size > 0 ? [...retainedPrevious, ...supersededSlices] : previousModels;
      modelsCache.set(cacheKey, overlaid);
    } else {
      modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, mergedModels));
    }
    cacheTimestamps.set(cacheKey, Date.now());
    return;
  }
  if (preservePreviousOnShrink && previousModels && previousModels.length > 0) {
    return;
  }
  const registry = getProviderRegistry();
  const filteredFallbacks = FALLBACK_MODELS.filter(
    (m) => registry.has(m.provider) && !unavailableProviders?.has(m.provider)
  );
  modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, filteredFallbacks));
  cacheTimestamps.set(cacheKey, Date.now());
}

async function triggerBackgroundRefresh(cacheKey: string): Promise<void> {
  if (refreshInProgress.has(cacheKey)) {
    return;
  }

  const generationAtStart = cacheGeneration.get(cacheKey) ?? 0;
  const previousModels = modelsCache.get(cacheKey);

  const refreshPromise = (async () => {
    try {
      const result = await loadModelsFromProviders();
      if ((cacheGeneration.get(cacheKey) ?? 0) === generationAtStart) {
        const current = pruneSupersededProviders(result);
        applyProviderLoadOutcome(current);
        applyRefreshedModels(
          cacheKey,
          current.models,
          previousModels,
          current.supersededProviderIds
        );
      }
      /* v8 ignore next 2 */
    } catch {}
  })();

  refreshModes.set(cacheKey, false);
  refreshInProgress.set(cacheKey, refreshPromise);
  void refreshPromise.finally(() => releaseRefreshState(cacheKey, refreshPromise));
}

function releaseRefreshState(cacheKey: string, refreshPromise: Promise<void>): void {
  if (refreshInProgress.get(cacheKey) !== refreshPromise) {
    return;
  }
  refreshInProgress.delete(cacheKey);
  refreshModes.delete(cacheKey);
  if (!modelsCache.has(cacheKey) && !cacheTimestamps.has(cacheKey)) {
    cacheGeneration.delete(cacheKey);
  }
}

function shouldWaitForOptionalProviders(registry = getProviderRegistry()): boolean {
  return process.env.NODE_ENV !== 'test' || registry.has('anthropic-copilot');
}

interface ProviderLoadFailure {
  readonly providerId: string;
  readonly errorKind: ProviderFailureErrorKind;
  readonly message: string;
}

interface ModelsLoadResult {
  models: ModelInfo[];
  succeededProviderIds: string[];
  loadedProviderIds: string[];
  supersededProviderIds: string[];
  failures: ProviderLoadFailure[];
  unavailableProviderIds: string[];
  loadSeq: number;
  providerIds: string[];
  forcedDiscoveryError?: unknown;
}

function pruneSupersededProviders(result: ModelsLoadResult): ModelsLoadResult {
  const superseded = new Set(result.supersededProviderIds);
  const newlySuperseded = result.providerIds.filter(
    (providerId) =>
      (providerAppliedSeq.get(providerId) ?? 0) > result.loadSeq && !superseded.has(providerId)
  );
  if (newlySuperseded.length === 0) return result;
  for (const providerId of newlySuperseded) superseded.add(providerId);
  const models = result.models.filter((m) => !m.provider || !superseded.has(m.provider));
  for (const providerId of superseded) {
    models.push(...(modelsCache.get('global')?.filter((m) => m.provider === providerId) ?? []));
  }
  return {
    ...result,
    models,
    succeededProviderIds: result.succeededProviderIds.filter((id) => !superseded.has(id)),
    loadedProviderIds: result.loadedProviderIds.filter((id) => !superseded.has(id)),
    failures: result.failures.filter((f) => !superseded.has(f.providerId)),
    supersededProviderIds: Array.from(superseded),
  };
}

type ProviderModelLoadResult =
  | { status: 'loaded'; models: ModelInfo[] }
  | { status: 'unavailable'; models: ModelInfo[] }
  | { status: 'failed'; models: ModelInfo[]; error?: unknown };

export function fallbackModelsFor(provider: Provider): ModelInfo[] {
  const cached = provider.getCachedModels?.();
  if (cached && cached.length > 0) {
    return cached;
  }
  return STATIC_MODEL_METADATA.filter((model) => model.provider === provider.id);
}

const PROVIDER_CATALOG_CACHE_TTL_MS = 10_000;

let providerCatalogEpoch = 0;

const providerCatalogRevisions = new Map<string, number>();

export function bumpProviderCatalogEpoch(providerId?: string): void {
  providerCatalogEpoch += 1;
  if (providerId) {
    providerCatalogRevisions.set(providerId, (providerCatalogRevisions.get(providerId) ?? 0) + 1);
  }
}

export function getProviderCatalogEpoch(providerId?: string): number {
  if (providerId) {
    return providerCatalogRevisions.get(providerId) ?? 0;
  }
  return providerCatalogEpoch;
}

export function peekProviderCatalogModels(
  providerId: string,
  provider: Provider
): ModelInfo[] | null {
  const curatedNow = getProviderRegistry().getCuratedModels(providerId);
  const curatedStamp =
    curatedNow === undefined ? undefined : curatedNow.map((model) => model.id).join(',');
  const cached = providerCatalogCache.get(provider);
  if (
    cached &&
    cached.curatedStamp === curatedStamp &&
    cached.epoch === providerCatalogEpoch &&
    Date.now() - cached.at < PROVIDER_CATALOG_CACHE_TTL_MS
  ) {
    return cached.models;
  }
  return null;
}

const scopedCatalogStamps = new Map<string, string>();

function peekSessionCatalogModels(cacheKey: string): ModelInfo[] | null {
  const cached = modelsCache.get(cacheKey);
  const at = cacheTimestamps.get(cacheKey);
  if (!cached || at === undefined || Date.now() - at >= CACHE_TTL) {
    return null;
  }
  return cached;
}

function scopedCatalogStamp(providerId: string, sessionConfig: ProviderSessionConfig): string {
  return JSON.stringify([
    providerId,
    sessionConfig.baseUrl ?? '',
    sessionConfig.apiKey ?? '',
    typeof sessionConfig.region === 'string' ? sessionConfig.region : '',
    getProviderCatalogEpoch(),
  ]);
}

export async function ensureScopedProviderCatalogModels(
  sessionCacheKey: string,
  providerId: string,
  sessionConfig: ProviderSessionConfig
): Promise<void> {
  const stamp = scopedCatalogStamp(providerId, sessionConfig);
  const cached = peekSessionCatalogModels(sessionCacheKey);
  if (cached && scopedCatalogStamps.get(sessionCacheKey) === stamp) {
    return;
  }
  const provider = getProviderRegistry().get(providerId);
  if (!provider?.getModelsForSessionConfig) return;
  const dropScopedCatalog = () => {
    modelsCache.delete(sessionCacheKey);
    cacheTimestamps.delete(sessionCacheKey);
    scopedCatalogStamps.delete(sessionCacheKey);
  };
  try {
    const models = await provider.getModelsForSessionConfig(sessionConfig);
    modelsCache.set(sessionCacheKey, models);
    cacheTimestamps.set(sessionCacheKey, Date.now());
    scopedCatalogStamps.set(sessionCacheKey, stamp);
  } catch {
    dropScopedCatalog();
  }
}

const providerCatalogCache = new WeakMap<
  Provider,
  {
    models: ModelInfo[];
    at: number;
    curatedStamp: string | undefined;
    epoch: number;
  }
>();

const providerCatalogInFlight = new WeakMap<
  Provider,
  { key: string; promise: Promise<ModelInfo[]> }
>();

export function getProviderCatalogModels(
  providerId: string,
  provider: Provider
): Promise<ModelInfo[]> {
  const curatedNow = getProviderRegistry().getCuratedModels(providerId);
  const curatedStamp =
    curatedNow === undefined ? undefined : curatedNow.map((model) => model.id).join(',');
  const cached = providerCatalogCache.get(provider);
  if (
    cached &&
    cached.curatedStamp === curatedStamp &&
    cached.epoch === providerCatalogEpoch &&
    Date.now() - cached.at < PROVIDER_CATALOG_CACHE_TTL_MS
  ) {
    return Promise.resolve(cached.models);
  }
  const inflightKey = `${curatedStamp ?? ''}|${providerCatalogEpoch}`;
  const existing = providerCatalogInFlight.get(provider);
  if (existing && existing.key === inflightKey) {
    return existing.promise;
  }
  const promise = loadProviderCatalogModels(providerId, provider);
  providerCatalogInFlight.set(provider, { key: inflightKey, promise });
  void promise.finally(() => {
    const entry = providerCatalogInFlight.get(provider);
    if (entry?.promise === promise) providerCatalogInFlight.delete(provider);
  });
  return promise;
}

async function loadProviderCatalogModels(
  providerId: string,
  provider: Provider
): Promise<ModelInfo[]> {
  let models: ModelInfo[] = [];
  for (let attempt = 0; ; attempt += 1) {
    const curatedNow = getProviderRegistry().getCuratedModels(providerId);
    const curatedStamp =
      curatedNow === undefined ? undefined : curatedNow.map((model) => model.id).join(',');
    const cached = providerCatalogCache.get(provider);
    if (
      cached &&
      cached.curatedStamp === curatedStamp &&
      cached.epoch === providerCatalogEpoch &&
      Date.now() - cached.at < PROVIDER_CATALOG_CACHE_TTL_MS
    ) {
      return cached.models;
    }
    const epochAtFetch = providerCatalogEpoch;
    try {
      const fetched = await provider.getModels();
      if (fetched.length > 0 || provider.hasCuratedModelList?.()) {
        models = fetched;
      } else {
        models =
          curatedNow !== undefined && curatedNow.length === 0
            ? fetched
            : fallbackModelsFor(provider);
      }
    } catch {
      models = fallbackModelsFor(provider);
    }
    if (providerCatalogEpoch === epochAtFetch) {
      if (models.length > 0) {
        providerCatalogCache.set(provider, {
          models,
          at: Date.now(),
          curatedStamp,
          epoch: epochAtFetch,
        });
      }
      return models;
    }
    if (attempt >= 2) {
      return models;
    }
  }
}

function withCuratedEntries(providerId: string, models: ModelInfo[]): ModelInfo[] {
  const curatedModels = getProviderRegistry().getCuratedModels(providerId);
  if (curatedModels === undefined) return models;
  const knownIds = new Set(models.map((model) => model.id));
  const staticProviderModels = STATIC_MODEL_METADATA.filter(
    (model) => model.provider === providerId
  );
  const missing = curatedModels.flatMap((curated) => {
    if (knownIds.has(curated.id)) return [];
    const known = findInModels(staticProviderModels, curated.id);
    if (known) return [{ ...known }];
    return [
      {
        id: curated.id,
        name: curated.name ?? curated.id,
        alias: '',
        family: providerId,
        provider: providerId,
        contextWindow: 128000,
        description: `Curated model ${curated.name ?? curated.id}`,
        releaseDate: '',
        available: true,
      },
    ];
  });
  return missing.length === 0 ? models : [...models, ...missing];
}

async function loadProviderModels(
  provider: Provider,
  options?: { forceRemote?: boolean }
): Promise<ProviderModelLoadResult> {
  try {
    if (!(await provider.isAvailable())) {
      return { status: 'unavailable', models: [] };
    }
    const discovered =
      options?.forceRemote && provider.listRemoteModels
        ? await provider.listRemoteModels({ force: true })
        : null;
    const models = discovered
      ? withCuratedEntries(provider.id, discovered)
      : await provider.getModels();
    if (
      models.length > 0 ||
      provider.hasCuratedModelList?.() ||
      getCuratedModelIds(provider.id)?.size === 0
    ) {
      return { status: 'loaded', models };
    }
    return {
      status: 'failed',
      models: fallbackModelsFor(provider),
      error: new Error('Provider returned no models'),
    };
  } catch (error) {
    return { status: 'failed', models: fallbackModelsFor(provider), error };
  }
}

async function loadModelsFromProviders(options?: {
  forceRemote?: boolean;
}): Promise<ModelsLoadResult> {
  const registry = getProviderRegistry();
  if (registry.size === 0) {
    initializeProviders();
    await waitForOptionalProviderRegistration();
  } else if (shouldWaitForOptionalProviders(registry)) {
    await waitForOptionalProviderRegistration(registry);
  }
  const providers = getAvailableProviders();
  const loadSeq = ++modelLoadSequence;

  const results = await Promise.allSettled(
    providers.map((provider) => loadProviderModels(provider, options))
  );

  const allModels: ModelInfo[] = [];
  const succeededProviderIds: string[] = [];
  const loadedProviderIds: string[] = [];
  const supersededProviderIds: string[] = [];
  const failures: ProviderLoadFailure[] = [];
  const unavailableProviderIds: string[] = [];
  let forcedDiscoveryError: unknown;
  results.forEach((result, index) => {
    const provider = providers[index];
    /* v8 ignore next 2 */
    if (result.status !== 'fulfilled') return;
    if ((providerAppliedSeq.get(provider.id) ?? 0) > loadSeq) {
      const cachedSlice =
        modelsCache.get('global')?.filter((m) => m.provider === provider.id) ?? [];
      allModels.push(...cachedSlice);
      supersededProviderIds.push(provider.id);
      return;
    }
    allModels.push(...result.value.models);
    if (result.value.status === 'failed') {
      if (result.value.error !== undefined) {
        failures.push({ providerId: provider.id, ...classifyProviderFailure(result.value.error) });
        if (
          options?.forceRemote &&
          provider.listRemoteModels &&
          forcedDiscoveryError === undefined
        ) {
          forcedDiscoveryError = result.value.error;
        }
      }
      return;
    }
    if (result.value.status === 'unavailable') {
      unavailableProviderIds.push(provider.id);
      return;
    }
    succeededProviderIds.push(provider.id);
    if (result.value.status === 'loaded') {
      loadedProviderIds.push(provider.id);
    }
  });

  return {
    models: allModels,
    succeededProviderIds,
    loadedProviderIds,
    supersededProviderIds,
    failures,
    unavailableProviderIds,
    loadSeq,
    providerIds: providers.map((provider) => provider.id),
    forcedDiscoveryError,
  };
}

function applyProviderLoadOutcome(result: ModelsLoadResult): void {
  const registry = getProviderRegistry();
  for (const failure of getAllProviderFailures()) {
    if (!registry.has(failure.providerId)) {
      removeProviderFailure(failure.providerId);
      clearProviderRetry(failure.providerId);
    }
  }
  for (const providerId of result.succeededProviderIds) {
    providerAppliedSeq.set(providerId, result.loadSeq);
  }
  for (const providerId of result.loadedProviderIds) {
    clearProviderFailure(providerId);
    clearProviderRetry(providerId);
  }
  for (const providerId of result.succeededProviderIds) {
    if (result.loadedProviderIds.includes(providerId)) continue;
    if (getProviderFailure(providerId)?.errorKind === 'transient') {
      armProviderRetryTimer(providerId);
    }
  }
  for (const failure of result.failures) {
    if (!registry.has(failure.providerId)) {
      continue;
    }
    providerAppliedSeq.set(failure.providerId, result.loadSeq);
    recordClassifiedProviderFailure(failure.providerId, failure);
    if (failure.errorKind === 'transient') {
      armProviderRetryTimer(failure.providerId);
    } else {
      cancelProviderRetryTimer(failure.providerId);
    }
  }
}

function getOrCreateProviderRetryEntry(providerId: string): ProviderRetryEntry {
  let entry = providerRetryEntries.get(providerId);
  if (!entry) {
    entry = { lastAttemptAt: Date.now(), timer: null };
    providerRetryEntries.set(providerId, entry);
  }
  return entry;
}

function cancelProviderRetryTimer(providerId: string): void {
  const entry = providerRetryEntries.get(providerId);
  if (!entry?.timer) return;
  clearTimeout(entry.timer);
  entry.timer = null;
}

function clearProviderRetry(providerId: string): void {
  cancelProviderRetryTimer(providerId);
  providerRetryEntries.delete(providerId);
  providerProbesInFlight.delete(providerId);
}

function armProviderRetryTimer(providerId: string): void {
  const entry = getOrCreateProviderRetryEntry(providerId);
  if (entry.timer) return;
  entry.lastAttemptAt = Date.now();
  const timer = setTimeout(() => {
    entry.timer = null;
    entry.lastAttemptAt = Date.now();
    void runScheduledProviderRetry(providerId);
  }, PROVIDER_RETRY_BACKOFF_MS);
  timer.unref?.();
  entry.timer = timer;
}

function cancelAllProviderRetries(): void {
  for (const entry of providerRetryEntries.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  providerRetryEntries.clear();
  providerAppliedSeq.clear();
  providerProbesInFlight.clear();
  providerRetryGeneration += 1;
}

function replaceProviderModelsInCache(providerId: string, models: ModelInfo[]): void {
  const cacheKey = 'global';
  const pending = pendingProviderSlices.get(pendingSliceKey(cacheKey, providerId));
  const slice = pending ?? models;
  const existing = modelsCache.get(cacheKey);
  if (!existing || existing.length === 0) {
    modelsCache.set(cacheKey, mergeWithFallbackModels(slice));
    return;
  }
  modelsCache.set(cacheKey, [...existing.filter((m) => m.provider !== providerId), ...slice]);
}

const PROVIDER_RETRY_PROBE_TIMEOUT_MS = 30_000;

function raceProviderProbe<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const providerProbesInFlight = new Map<string, Promise<ProviderModelLoadResult>>();

async function runScheduledProviderRetry(providerId: string): Promise<void> {
  const generationAtStart = providerRetryGeneration;
  const probeSeq = ++modelLoadSequence;
  const provider = getProviderRegistry().get(providerId);
  if (!provider) {
    providerRetryEntries.delete(providerId);
    return;
  }
  if (providerProbesInFlight.has(providerId)) {
    armProviderRetryTimer(providerId);
    return;
  }
  const probe = loadProviderModels(provider);
  providerProbesInFlight.set(providerId, probe);
  void probe
    .finally(() => {
      if (providerProbesInFlight.get(providerId) === probe) {
        providerProbesInFlight.delete(providerId);
      }
    })
    .catch(() => {});
  const result = await raceProviderProbe(probe, PROVIDER_RETRY_PROBE_TIMEOUT_MS);
  if (
    providerRetryGeneration !== generationAtStart ||
    (providerAppliedSeq.get(providerId) ?? 0) > probeSeq
  ) {
    return;
  }
  if (result === 'timeout' || result.status === 'unavailable') {
    armProviderRetryTimer(providerId);
    return;
  }
  const error = result.status === 'failed' ? result.error : undefined;
  if (error !== undefined) {
    applyProviderLoadOutcome({
      models: [],
      succeededProviderIds: [],
      loadedProviderIds: [],
      supersededProviderIds: [],
      unavailableProviderIds: [],
      failures: [{ providerId, ...classifyProviderFailure(error) }],
      loadSeq: probeSeq,
      providerIds: [providerId],
    });
    return;
  }
  providerAppliedSeq.set(providerId, probeSeq);
  replaceProviderModelsInCache(providerId, result.models);
  clearProviderFailure(providerId);
  clearProviderRetry(providerId);
}

export type ProviderRecoveryOutcome = 'no-op' | 'recovered' | 'failed';

export async function recoverDormantProvider(providerId: string): Promise<ProviderRecoveryOutcome> {
  if (getProviderFailure(providerId)?.errorKind !== 'credential') return 'no-op';
  const provider = getProviderRegistry().get(providerId);
  if (!provider) return 'no-op';

  clearProviderRetry(providerId);
  provider.clearModelCache?.();

  const generationAtStart = providerRetryGeneration;
  const failureAtStart = getProviderFailure(providerId);
  const probeSeq = ++modelLoadSequence;
  const result = await raceProviderProbe(
    loadProviderModels(provider),
    PROVIDER_RETRY_PROBE_TIMEOUT_MS
  );
  if ((providerAppliedSeq.get(providerId) ?? 0) > probeSeq) {
    return getProviderFailure(providerId) ? 'failed' : 'no-op';
  }
  if (result === 'timeout' || result.status === 'unavailable') {
    if (providerRetryGeneration === generationAtStart) {
      armProviderRetryTimer(providerId);
      return 'failed';
    }
    return getProviderFailure(providerId) ? 'failed' : 'no-op';
  }
  const error = result.status === 'failed' ? result.error : undefined;
  if (error !== undefined) {
    if (providerRetryGeneration !== generationAtStart) {
      return getProviderFailure(providerId) ? 'failed' : 'no-op';
    }
    applyProviderLoadOutcome({
      models: [],
      succeededProviderIds: [],
      loadedProviderIds: [],
      supersededProviderIds: [],
      unavailableProviderIds: [],
      failures: [{ providerId, ...classifyProviderFailure(error) }],
      loadSeq: probeSeq,
      providerIds: [providerId],
    });
    return 'failed';
  }
  const currentFailure = getProviderFailure(providerId);
  if (providerRetryGeneration !== generationAtStart && currentFailure !== failureAtStart) {
    return currentFailure ? 'failed' : 'no-op';
  }
  clearProviderFailure(providerId);
  clearProviderRetry(providerId);
  if (providerRetryGeneration !== generationAtStart) {
    return 'recovered';
  }
  providerAppliedSeq.set(providerId, probeSeq);
  replaceProviderModelsInCache(providerId, result.models);
  return 'recovered';
}

function isCacheStale(cacheKey: string): boolean {
  const timestamp = cacheTimestamps.get(cacheKey);
  if (!timestamp) return true;
  return Date.now() - timestamp > CACHE_TTL;
}

function readCachedModels(cacheKey: string): ModelInfo[] | null {
  const cachedModels = modelsCache.get(cacheKey);
  if (!cachedModels) {
    return null;
  }
  if (isCacheStale(cacheKey)) {
    triggerBackgroundRefresh(cacheKey).catch(() => {});
  }
  if (cachedModels.length === 0) {
    return null;
  }
  return cachedModels;
}

export function getAvailableModels(cacheKey: string = 'global'): ModelInfo[] {
  const cachedModels = readCachedModels(cacheKey);
  return cachedModels === null ? [] : filterModelsByCuration(cachedModels);
}

export async function initializeModels(): Promise<void> {
  const cacheKey = 'global';

  if (modelsCache.has(cacheKey)) {
    return;
  }

  const generationAtStart = cacheGeneration.get(cacheKey) ?? 0;

  const refreshPromise = (async () => {
    initializeProviders();
    await waitForOptionalProviderRegistration();
    if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtStart) {
      return;
    }
    try {
      const result = await loadModelsFromProviders();
      const isCurrentGeneration = (cacheGeneration.get(cacheKey) ?? 0) === generationAtStart;
      if (!isCurrentGeneration) {
        return;
      }
      applyProviderLoadOutcome(pruneSupersededProviders(result));
      if (result.models.length > 0) {
        const mergedModels = mergePendingProviderSlices(
          cacheKey,
          mergeWithFallbackModels(result.models)
        );
        modelsCache.set(cacheKey, mergedModels);
        cacheTimestamps.set(cacheKey, Date.now());
      } else {
        throw new Error('No models returned from providers');
      }
    } catch {
      if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtStart) {
        return;
      }
      const registry = getProviderRegistry();
      const filteredFallbacks = FALLBACK_MODELS.filter((m) => registry.has(m.provider));
      modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, filteredFallbacks));
      cacheTimestamps.set(cacheKey, Date.now());
    }
  })();

  refreshModes.set(cacheKey, false);
  refreshInProgress.set(cacheKey, refreshPromise);
  await refreshPromise.finally(() => releaseRefreshState(cacheKey, refreshPromise));
}

function clearProviderModelCaches(forceRemote = false): void {
  const registry = getProviderRegistry();
  for (const provider of registry.getAll()) {
    if (forceRemote && provider.listRemoteModels) {
      continue;
    }
    if (provider.clearModelCache) {
      provider.clearModelCache();
    }
  }
}

function clearFailedStrictProviderCaches(result: ModelsLoadResult): void {
  const registry = getProviderRegistry();
  for (const failure of result.failures) {
    const provider = registry.get(failure.providerId);
    if (provider?.listRemoteModels && !provider.hasCuratedModelList?.()) {
      provider.clearModelCache?.();
    }
  }
}

export function clearModelsCache(cacheKey?: string, providerId?: string): void {
  if (cacheKey) {
    const hadInFlight = refreshInProgress.has(cacheKey);
    modelsCache.delete(cacheKey);
    cacheTimestamps.delete(cacheKey);
    refreshInProgress.delete(cacheKey);
    refreshModes.delete(cacheKey);
    scopedCatalogStamps.delete(cacheKey);
    for (const key of pendingProviderSlices.keys()) {
      if (key.startsWith(`${cacheKey}:`)) pendingProviderSlices.delete(key);
    }
    if (cacheKey === 'global') {
      cancelAllProviderRetries();
    }
    if (hadInFlight || cacheGeneration.has(cacheKey)) {
      cacheGeneration.set(cacheKey, (cacheGeneration.get(cacheKey) ?? 0) + 1);
    }
  } else {
    const inFlightKeys = new Set(refreshInProgress.keys());
    modelsCache.clear();
    cacheTimestamps.clear();
    refreshInProgress.clear();
    refreshModes.clear();
    clearProviderModelCaches();
    pendingProviderSlices.clear();
    scopedCatalogStamps.clear();
    for (const key of inFlightKeys) {
      cacheGeneration.set(key, (cacheGeneration.get(key) ?? 0) + 1);
    }
    cancelAllProviderRetries();
    bumpProviderCatalogEpoch(providerId);
  }
}

export function hasRefreshBeenAttemptedFor(providerId: string): boolean {
  const entry = providerRetryEntries.get(providerId);
  if (entry && Date.now() - entry.lastAttemptAt < PROVIDER_RETRY_BACKOFF_MS) {
    return true;
  }
  return getProviderFailure(providerId)?.errorKind === 'credential';
}

export function markRefreshAttemptedFor(providerIds: string[]): void {
  const now = Date.now();
  for (const id of providerIds) {
    getOrCreateProviderRetryEntry(id).lastAttemptAt = now;
  }
}

export async function refreshModels(
  signal?: AbortSignal,
  options?: { forceRemote?: boolean }
): Promise<void> {
  const cacheKey = 'global';
  const forceRemote = options?.forceRemote ?? false;

  for (;;) {
    const inProgress = refreshInProgress.get(cacheKey);
    if (!inProgress) break;
    const joinedForced = refreshModes.get(cacheKey) ?? false;
    const generationAtJoin = cacheGeneration.get(cacheKey) ?? 0;
    let joinError: unknown;
    try {
      await inProgress;
    } catch (error) {
      joinError = error;
    }
    if (!forceRemote || signal?.aborted) {
      return;
    }
    const superseded = (cacheGeneration.get(cacheKey) ?? 0) !== generationAtJoin;
    if (!superseded && joinedForced) {
      if (joinError !== undefined) throw joinError;
      return;
    }
  }
  if (signal?.aborted) {
    return;
  }

  const generationAtStart = cacheGeneration.get(cacheKey) ?? 0;
  const previousModels = modelsCache.get(cacheKey);
  clearProviderModelCaches(forceRemote);

  const refreshPromise = (async () => {
    if (signal?.aborted) {
      return;
    }
    const result = await loadModelsFromProviders({ forceRemote });
    if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtStart) {
      return;
    }
    const current = pruneSupersededProviders(result);
    applyProviderLoadOutcome(current);
    bumpProviderCatalogEpoch();
    if (current.forcedDiscoveryError !== undefined) {
      clearFailedStrictProviderCaches(current);
      if (current.loadedProviderIds.length > 0) {
        applyRefreshedModels(
          cacheKey,
          current.models,
          undefined,
          current.supersededProviderIds,
          false,
          new Set(current.unavailableProviderIds)
        );
      }
      throw current.forcedDiscoveryError;
    }
    applyRefreshedModels(
      cacheKey,
      current.models,
      previousModels,
      current.supersededProviderIds,
      !forceRemote,
      forceRemote ? new Set(current.unavailableProviderIds) : undefined
    );
  })();

  refreshModes.set(cacheKey, forceRemote);
  refreshInProgress.set(cacheKey, refreshPromise);
  await refreshPromise.finally(() => releaseRefreshState(cacheKey, refreshPromise));
}

/** @public */
export function getModelsCache(): Map<string, ModelInfo[]> {
  return new Map(modelsCache);
}

/** @public */
export function setModelsCache(cache: Map<string, ModelInfo[]>, timestamp?: number): void {
  modelsCache.clear();
  cacheTimestamps.clear();
  const ts = timestamp ?? Date.now();
  for (const [key, models] of cache.entries()) {
    modelsCache.set(key, models);
    cacheTimestamps.set(key, ts);
  }
}

export function updateProviderModelsInCache(
  providerId: string,
  models: ModelInfo[],
  cacheKey: string = 'global'
): boolean {
  const cachedModels = modelsCache.get(cacheKey);
  if (!cachedModels) {
    pendingProviderSlices.set(pendingSliceKey(cacheKey, providerId), models);
    return false;
  }

  pendingProviderSlices.set(pendingSliceKey(cacheKey, providerId), models);
  modelsCache.set(cacheKey, [
    ...cachedModels.filter((model) => model.provider !== providerId),
    ...models,
  ]);
  const generationAtUpdate = cacheGeneration.get(cacheKey) ?? 0;
  const inFlight = refreshInProgress.get(cacheKey);
  if (inFlight) {
    inFlight
      .then(() => {
        if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtUpdate) return;
        const current = modelsCache.get(cacheKey);
        if (!current) return;
        modelsCache.set(cacheKey, [
          ...current.filter((model) => model.provider !== providerId),
          ...models,
        ]);
      })
      .catch(() => {});
  }
  return true;
}

export function findInModels(models: ModelInfo[], idOrAlias: string): ModelInfo | undefined {
  const normalized = idOrAlias.toLowerCase();

  let found = models.find((m) => m.id === idOrAlias);

  if (!found) {
    found = models.find((m) => m.id.toLowerCase() === normalized);
  }

  if (!found) {
    found = models.find((m) => m.alias === idOrAlias);
  }

  if (!found) {
    found = models.find((m) => m.alias.toLowerCase() === normalized);
  }

  if (!found) {
    found = models.find((m) =>
      m.providerAliases?.some((alias) => alias.toLowerCase() === normalized)
    );
  }

  if (!found) {
    let bestPrefix: { model: ModelInfo; length: number } | undefined;
    for (const model of models) {
      for (const rawPrefix of model.providerAliasPrefixes ?? []) {
        const prefix = rawPrefix.toLowerCase();
        const boundary =
          normalized === prefix ||
          normalized.startsWith(`${prefix}-`) ||
          normalized.startsWith(`${prefix}[`);
        if (boundary && (!bestPrefix || prefix.length > bestPrefix.length)) {
          bestPrefix = { model, length: prefix.length };
        }
      }
    }
    found = bestPrefix?.model;
  }

  if (!found) {
    const legacyMappedId = LEGACY_MODEL_MAPPINGS[idOrAlias];
    if (legacyMappedId) {
      found = models.find((m) => m.id === legacyMappedId);
    }
  }

  return found;
}

function overlayCodexStaticMetadata(model: ModelInfo): ModelInfo {
  const resolvedCodexId =
    resolveCodexBridgeModelId(model.id) ?? resolveCodexBridgeModelId(model.alias);
  const staticModel = resolvedCodexId
    ? findInModels(CODEX_STATIC_MODEL_METADATA, resolvedCodexId)
    : (findInModels(COPILOT_LEGACY_CODEX_STATIC_METADATA, model.id) ??
      findInModels(COPILOT_LEGACY_CODEX_STATIC_METADATA, model.alias));
  return staticModel
    ? {
        ...model,
        contextWindow: staticModel.contextWindow,
        preferContextWindowMetadata: staticModel.preferContextWindowMetadata,
      }
    : model;
}

export async function getModelInfo(
  idOrAlias: string,
  cacheKey: string,
  providerId: string
): Promise<ModelInfo | null> {
  const availableModels = getAvailableModels(cacheKey);
  const providerModels = availableModels.filter((m) => m.provider === providerId);
  const fromCache = findInModels(providerModels, idOrAlias);
  if (fromCache) {
    return providerId === 'anthropic-copilot' ? overlayCodexStaticMetadata(fromCache) : fromCache;
  }

  const staticProviderModels = filterProviderModels(
    providerId,
    STATIC_MODEL_METADATA.filter((model) => model.provider === providerId)
  );
  const staticModel = findInModels(staticProviderModels, idOrAlias) ?? null;
  return providerId === 'anthropic-copilot' && staticModel
    ? overlayCodexStaticMetadata(staticModel)
    : staticModel;
}

export async function getSessionModelInfo(
  session: Pick<Session, 'config'>,
  cacheKey: string = 'global'
): Promise<ModelInfo | null> {
  const providerId = session.config.provider;
  if (!providerId) return null;
  const modelInfo = await getModelInfo(session.config.model, cacheKey, providerId);
  if (modelInfo) return modelInfo;
  const rawModels = readCachedModels(cacheKey);
  if (rawModels) {
    const providerModels = rawModels.filter((m) => m.provider === providerId);
    const fromRaw = findInModels(providerModels, session.config.model);
    if (fromRaw) {
      return providerId === 'anthropic-copilot' ? overlayCodexStaticMetadata(fromRaw) : fromRaw;
    }
  }
  const staticProviderModels = STATIC_MODEL_METADATA.filter((m) => m.provider === providerId);
  const fromStatic = findInModels(staticProviderModels, session.config.model) ?? null;
  return providerId === 'anthropic-copilot' && fromStatic
    ? overlayCodexStaticMetadata(fromStatic)
    : fromStatic;
}

export async function getModelInfoUnfiltered(
  idOrAlias: string,
  cacheKey: string = 'global'
): Promise<ModelInfo | null> {
  const cachedModels = readCachedModels(cacheKey);
  return cachedModels === null ? null : (findInModels(cachedModels, idOrAlias) ?? null);
}

export async function isValidModel(
  idOrAlias: string,
  cacheKey: string,
  providerId: string,
  sessionApiKey?: string
): Promise<boolean> {
  const availableModels = getAvailableModels(cacheKey);
  const providerModels = availableModels.filter((m) => m.provider === providerId);
  if (findInModels(providerModels, idOrAlias)) {
    return true;
  }

  const staticProviderModels = filterProviderModels(
    providerId,
    STATIC_MODEL_METADATA.filter((model) => model.provider === providerId)
  );
  if (!findInModels(staticProviderModels, idOrAlias)) {
    return false;
  }

  if (sessionApiKey?.trim() && providerId !== 'anthropic-copilot') {
    return true;
  }

  const provider = getProviderRegistry().get(providerId);
  if (!provider) {
    return false;
  }

  try {
    return await provider.isAvailable();
  } catch {
    return false;
  }
}

export function isCuratedOutModel(
  idOrAlias: string,
  providerId: string,
  cacheKey: string = 'global'
): boolean {
  const curatedIds = getCuratedModelIds(providerId);
  if (curatedIds === undefined) {
    return false;
  }

  const rawModels = readCachedModels(cacheKey);
  const knownModel =
    (rawModels &&
      findInModels(
        rawModels.filter((model) => model.provider === providerId),
        idOrAlias
      )) ??
    findInModels(
      STATIC_MODEL_METADATA.filter((model) => model.provider === providerId),
      idOrAlias
    );

  if (knownModel) {
    return !curatedIds.has(knownModel.id);
  }

  return !curatedIds.has(idOrAlias);
}

function resolveCuratedCanonicalModelId(
  idOrAlias: string,
  providerId: string,
  cacheKey: string = 'global'
): string | null {
  const rawModels = readCachedModels(cacheKey);
  const knownModel =
    (rawModels
      ? findInModels(
          rawModels.filter((model) => model.provider === providerId),
          idOrAlias
        )
      : undefined) ??
    findInModels(
      STATIC_MODEL_METADATA.filter((model) => model.provider === providerId),
      idOrAlias
    );
  return knownModel?.id ?? null;
}

export async function resolveVisibleCanonicalModelId(
  idOrAlias: string,
  providerId: string,
  cacheKey: string = 'global',
  preloadedModels?: ModelInfo[]
): Promise<string | null> {
  const cachedId = resolveCuratedCanonicalModelId(idOrAlias, providerId, cacheKey);
  let liveModels: ModelInfo[] | null = preloadedModels ?? null;
  if (preloadedModels === undefined) {
    const provider = getProviderRegistry().get(providerId);
    if (provider) {
      const cachedCatalog = peekProviderCatalogModels(providerId, provider);
      if (cachedCatalog) {
        liveModels = cachedCatalog;
      } else {
        try {
          if (await provider.isAvailable()) {
            liveModels = await getProviderCatalogModels(providerId, provider);
          }
        } catch {
          liveModels = fallbackModelsFor(provider);
        }
      }
    }
  }

  if (cachedId) {
    if (liveModels === null) return cachedId;
    const liveResolved = findInModels(liveModels, idOrAlias);
    if (liveResolved) return liveResolved.id;
    if (liveModels.some((model) => model.id === cachedId)) return cachedId;
    return null;
  }
  if (liveModels === null) return null;
  return findInModels(liveModels, idOrAlias)?.id ?? null;
}

export function isCuratedOutModelAllowingExactId(
  idOrAlias: string,
  providerId: string,
  cacheKey: string = 'global'
): boolean {
  const curatedIds = getCuratedModelIds(providerId);
  if (curatedIds !== undefined) {
    const lowerInput = idOrAlias.toLowerCase();
    const scopedModels = cacheKey !== 'global' ? peekSessionCatalogModels(cacheKey) : null;
    for (const curatedId of curatedIds) {
      if (curatedId.toLowerCase() === lowerInput) {
        if (scopedModels && !findInModels(scopedModels, idOrAlias)) {
          return true;
        }
        return false;
      }
    }
    if (scopedModels) {
      const scopedCanonical = findInModels(scopedModels, idOrAlias)?.id;
      if (!scopedCanonical) {
        return true;
      }
      for (const curatedId of curatedIds) {
        if (findInModels(scopedModels, curatedId)?.id === scopedCanonical) {
          return false;
        }
      }
      return true;
    }
    const canonicalInput = resolveCuratedCanonicalModelId(idOrAlias, providerId);
    if (canonicalInput) {
      for (const curatedId of curatedIds) {
        const canonicalCurated = resolveCuratedCanonicalModelId(curatedId, providerId);
        if (canonicalCurated === canonicalInput) {
          return false;
        }
      }
    }
  }
  return isCuratedOutModel(idOrAlias, providerId);
}

export async function isModelExcludedByCuration(
  idOrAlias: string,
  providerId: string,
  cacheKey: string = 'global'
): Promise<boolean> {
  const registry = getProviderRegistry();
  const curatedBefore = registry.getCuratedModels(providerId);
  if (curatedBefore === undefined) {
    return false;
  }
  if (curatedBefore.length === 0) {
    return true;
  }

  const canonicalId = await resolveVisibleCanonicalModelId(idOrAlias, providerId, cacheKey);
  if (!canonicalId) {
    return true;
  }

  const curatedAfter = registry.getCuratedModels(providerId);
  if (curatedAfter === undefined) {
    return false;
  }
  const expandedCuratedIds = getCuratedModelIds(providerId);
  if (expandedCuratedIds === undefined) {
    return false;
  }
  if (expandedCuratedIds.has(canonicalId)) {
    return false;
  }
  for (const entry of curatedAfter) {
    const entryCanonical = await resolveVisibleCanonicalModelId(entry.id, providerId, cacheKey);
    if (entryCanonical === canonicalId) {
      return false;
    }
  }
  return true;
}

export async function resolveModelAlias(
  idOrAlias: string,
  cacheKey: string,
  providerId: string
): Promise<string> {
  const modelInfo = await getModelInfo(idOrAlias, cacheKey, providerId);
  if (modelInfo) {
    return modelInfo.id;
  }
  return idOrAlias;
}

export async function resolveModelAliasUnfiltered(
  idOrAlias: string,
  cacheKey: string = 'global'
): Promise<string> {
  const modelInfo = await getModelInfoUnfiltered(idOrAlias, cacheKey);
  if (modelInfo) {
    return modelInfo.id;
  }
  return idOrAlias;
}
