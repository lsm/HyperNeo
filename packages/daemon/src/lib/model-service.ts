import type { ModelInfo, Session } from '@hyperneo/shared';
import type { QueryLike } from './agent/query-like';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';
import { getProviderRegistry } from './providers/registry.js';
import {
  clearProviderFailure,
  classifyProviderFailure,
  getAllProviderFailures,
  recordClassifiedProviderFailure,
  removeProviderFailure,
} from './providers/provider-failure-store.js';
import type { Provider, ProviderFailureErrorKind } from '@hyperneo/shared/provider';
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

function getCuratedModelIds(providerId: string): Set<string> | undefined {
  const curatedModels = getProviderRegistry().getCuratedModels(providerId);
  return curatedModels === undefined ? undefined : new Set(curatedModels.map((model) => model.id));
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

function registeredFallbackModels(): ModelInfo[] {
  const registry = getProviderRegistry();
  return filterModelsByCuration(FALLBACK_MODELS.filter((model) => registry.has(model.provider)));
}

function mergeWithFallbackModels(providerModels: ModelInfo[]): ModelInfo[] {
  const modelMap = new Map<string, ModelInfo>();

  for (const model of [...registeredFallbackModels(), ...filterModelsByCuration(providerModels)]) {
    modelMap.set(`${model.provider}:${model.id}`, model);
  }

  return Array.from(modelMap.values());
}

const refreshInProgress = new Map<string, Promise<void>>();

const cacheGeneration = new Map<string, number>();

const refreshedMissingProviders = new Set<string>();

const pendingProviderSlices = new Map<string, ModelInfo[]>();

function pendingSliceKey(cacheKey: string, providerId: string): string {
  return `${cacheKey}:${providerId}`;
}

function mergePendingProviderSlices(cacheKey: string, models: ModelInfo[]): ModelInfo[] {
  let merged = models;
  for (const [key, slice] of pendingProviderSlices) {
    if (!key.startsWith(`${cacheKey}:`)) continue;
    const providerId = key.slice(cacheKey.length + 1);
    merged = [
      ...merged.filter((model) => model.provider !== providerId),
      ...filterProviderModels(providerId, slice),
    ];
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
  previousModels: ModelInfo[] | undefined
): void {
  const visiblePreviousModels = previousModels
    ? mergeWithFallbackModels(filterModelsByCuration(previousModels))
    : previousModels;
  const mergedModels = mergeWithFallbackModels(fetchedModels);
  if (
    fetchedModels.length > 0 &&
    visiblePreviousModels &&
    visiblePreviousModels.length > mergedModels.length
  ) {
    modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, visiblePreviousModels));
    cacheTimestamps.set(cacheKey, Date.now());
    return;
  }
  if (fetchedModels.length > 0 || !visiblePreviousModels || visiblePreviousModels.length === 0) {
    modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, mergedModels));
    cacheTimestamps.set(cacheKey, Date.now());
  }
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
        applyProviderLoadOutcome(result);
        applyRefreshedModels(cacheKey, result.models, previousModels);
      }
      /* v8 ignore next 2 */
    } catch {}
  })();

  refreshInProgress.set(cacheKey, refreshPromise);
  void refreshPromise.finally(() => releaseRefreshState(cacheKey, refreshPromise));
}

function releaseRefreshState(cacheKey: string, refreshPromise: Promise<void>): void {
  if (refreshInProgress.get(cacheKey) !== refreshPromise) {
    return;
  }
  refreshInProgress.delete(cacheKey);
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
  failures: ProviderLoadFailure[];
}

type ProviderModelLoadResult =
  | { status: 'loaded'; models: ModelInfo[] }
  | { status: 'unavailable'; models: ModelInfo[] }
  | { status: 'failed'; models: ModelInfo[]; error?: unknown };

function fallbackModelsFor(provider: Provider): ModelInfo[] {
  const cached = provider.getCachedModels?.();
  if (cached && cached.length > 0) {
    return filterProviderModels(provider.id, cached);
  }
  return filterProviderModels(
    provider.id,
    STATIC_MODEL_METADATA.filter((model) => model.provider === provider.id)
  );
}

async function loadProviderModels(provider: Provider): Promise<ProviderModelLoadResult> {
  try {
    if (!(await provider.isAvailable())) {
      return { status: 'unavailable', models: [] };
    }
    const models = await provider.getModels();
    if (models.length > 0) {
      return { status: 'loaded', models: filterProviderModels(provider.id, models) };
    }
    if (getProviderRegistry().getCuratedModels(provider.id)?.length === 0) {
      return { status: 'loaded', models: [] };
    }
    return { status: 'failed', models: fallbackModelsFor(provider) };
  } catch (error) {
    return { status: 'failed', models: fallbackModelsFor(provider), error };
  }
}

async function loadModelsFromProviders(): Promise<ModelsLoadResult> {
  const registry = getProviderRegistry();
  if (registry.size === 0) {
    initializeProviders();
    await waitForOptionalProviderRegistration();
  } else if (shouldWaitForOptionalProviders(registry)) {
    await waitForOptionalProviderRegistration(registry);
  }
  const providers = getAvailableProviders();

  const results = await Promise.allSettled(
    providers.map((provider) => loadProviderModels(provider))
  );

  const allModels: ModelInfo[] = [];
  const succeededProviderIds: string[] = [];
  const failures: ProviderLoadFailure[] = [];
  results.forEach((result, index) => {
    const provider = providers[index];
    /* v8 ignore next 2 */
    if (result.status !== 'fulfilled') return;
    allModels.push(...result.value.models);
    if (result.value.status === 'failed' && result.value.error !== undefined) {
      failures.push({ providerId: provider.id, ...classifyProviderFailure(result.value.error) });
    } else {
      succeededProviderIds.push(provider.id);
    }
  });

  return { models: allModels, succeededProviderIds, failures };
}

function applyProviderLoadOutcome(result: ModelsLoadResult): void {
  const registry = getProviderRegistry();
  for (const failure of getAllProviderFailures()) {
    if (!registry.has(failure.providerId)) {
      removeProviderFailure(failure.providerId);
    }
  }
  for (const providerId of result.succeededProviderIds) {
    clearProviderFailure(providerId);
  }
  for (const failure of result.failures) {
    if (!registry.has(failure.providerId)) {
      continue;
    }
    recordClassifiedProviderFailure(failure.providerId, failure);
  }
}

function isCacheStale(cacheKey: string): boolean {
  const timestamp = cacheTimestamps.get(cacheKey);
  if (!timestamp) return true;
  return Date.now() - timestamp > CACHE_TTL;
}

export function getAvailableModels(cacheKey: string = 'global'): ModelInfo[] {
  const cachedModels = modelsCache.get(cacheKey);

  if (!cachedModels || cachedModels.length === 0) {
    return [];
  }

  if (isCacheStale(cacheKey)) {
    triggerBackgroundRefresh(cacheKey).catch(() => {});
  }

  return filterModelsByCuration(cachedModels);
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
      applyProviderLoadOutcome(result);
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
      modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, registeredFallbackModels()));
      cacheTimestamps.set(cacheKey, Date.now());
    }
  })();

  refreshInProgress.set(cacheKey, refreshPromise);
  await refreshPromise.finally(() => releaseRefreshState(cacheKey, refreshPromise));
}

function clearProviderModelCaches(): void {
  const registry = getProviderRegistry();
  for (const provider of registry.getAll()) {
    if (provider.clearModelCache) {
      provider.clearModelCache();
    }
  }
}

export function clearModelsCache(cacheKey?: string): void {
  if (cacheKey) {
    const hadInFlight = refreshInProgress.has(cacheKey);
    modelsCache.delete(cacheKey);
    cacheTimestamps.delete(cacheKey);
    refreshInProgress.delete(cacheKey);
    for (const key of pendingProviderSlices.keys()) {
      if (key.startsWith(`${cacheKey}:`)) pendingProviderSlices.delete(key);
    }
    if (hadInFlight || cacheGeneration.has(cacheKey)) {
      cacheGeneration.set(cacheKey, (cacheGeneration.get(cacheKey) ?? 0) + 1);
    }
  } else {
    const inFlightKeys = new Set(refreshInProgress.keys());
    modelsCache.clear();
    cacheTimestamps.clear();
    refreshInProgress.clear();
    clearProviderModelCaches();
    pendingProviderSlices.clear();
    for (const key of inFlightKeys) {
      cacheGeneration.set(key, (cacheGeneration.get(key) ?? 0) + 1);
    }
    refreshedMissingProviders.clear();
  }
}

export function hasRefreshBeenAttemptedFor(providerId: string): boolean {
  return refreshedMissingProviders.has(providerId);
}

export function markRefreshAttemptedFor(providerIds: string[]): void {
  for (const id of providerIds) refreshedMissingProviders.add(id);
}

export async function refreshModels(signal?: AbortSignal): Promise<void> {
  const cacheKey = 'global';

  const inProgress = refreshInProgress.get(cacheKey);
  if (inProgress) {
    await inProgress;
    if (signal?.aborted) {
      return;
    }
  }

  if (refreshInProgress.has(cacheKey)) {
    await refreshInProgress.get(cacheKey);
    return;
  }
  if (signal?.aborted) {
    return;
  }

  const generationAtStart = cacheGeneration.get(cacheKey) ?? 0;
  const previousModels = modelsCache.get(cacheKey);
  clearProviderModelCaches();

  const refreshPromise = (async () => {
    if (signal?.aborted) {
      return;
    }
    const result = await loadModelsFromProviders();
    if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtStart) {
      return;
    }
    applyProviderLoadOutcome(result);
    applyRefreshedModels(cacheKey, result.models, previousModels);
  })();

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

  const visibleModels = filterProviderModels(providerId, models);
  pendingProviderSlices.set(pendingSliceKey(cacheKey, providerId), models);
  modelsCache.set(cacheKey, [
    ...cachedModels.filter((model) => model.provider !== providerId),
    ...visibleModels,
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
          ...filterProviderModels(providerId, models),
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
        if (normalized.startsWith(prefix) && (!bestPrefix || prefix.length > bestPrefix.length)) {
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
  return getModelInfo(session.config.model, cacheKey, providerId);
}

export async function getModelInfoUnfiltered(
  idOrAlias: string,
  cacheKey: string = 'global'
): Promise<ModelInfo | null> {
  const availableModels = getAvailableModels(cacheKey);
  return findInModels(availableModels, idOrAlias) ?? null;
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
