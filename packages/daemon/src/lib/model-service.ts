import type { ModelInfo, Session } from '@hyperneo/shared';
import type { QueryLike } from './agent/query-like';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';
import { getProviderRegistry } from './providers/registry.js';
import type { Provider } from '@hyperneo/shared/provider';
import { getCodexBridgeModelInfos, resolveCodexBridgeModelId } from './providers/codex-models.js';
import { GlmProvider } from './providers/glm-provider.js';
import { KimiProvider } from './providers/kimi-provider.js';
import { DeepSeekProvider } from './providers/deepseek-provider.js';

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

function mergeWithFallbackModels(providerModels: ModelInfo[]): ModelInfo[] {
  const modelMap = new Map<string, ModelInfo>();
  const registry = getProviderRegistry();

  for (const model of FALLBACK_MODELS) {
    if (registry.has(model.provider)) {
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

async function triggerBackgroundRefresh(cacheKey: string): Promise<void> {
  if (refreshInProgress.has(cacheKey)) {
    return;
  }

  const generationAtStart = cacheGeneration.get(cacheKey) ?? 0;

  const refreshPromise = (async () => {
    try {
      const models = await loadModelsFromProviders();
      if (models.length > 0 && (cacheGeneration.get(cacheKey) ?? 0) === generationAtStart) {
        const mergedModels = mergeWithFallbackModels(models);
        modelsCache.set(cacheKey, mergedModels);
        cacheTimestamps.set(cacheKey, Date.now());
      }
      /* v8 ignore next 2 */
    } catch {
    } finally {
      refreshInProgress.delete(cacheKey);
      if (!modelsCache.has(cacheKey) && !cacheTimestamps.has(cacheKey)) {
        cacheGeneration.delete(cacheKey);
      }
    }
  })();

  refreshInProgress.set(cacheKey, refreshPromise);
}

function shouldWaitForOptionalProviders(registry = getProviderRegistry()): boolean {
  return process.env.NODE_ENV !== 'test' || registry.has('anthropic-copilot');
}

async function loadModelsFromProviders(): Promise<ModelInfo[]> {
  const registry = getProviderRegistry();
  if (registry.size === 0) {
    initializeProviders();
    await waitForOptionalProviderRegistration();
  } else if (shouldWaitForOptionalProviders(registry)) {
    await waitForOptionalProviderRegistration(registry);
  }
  const providers = getAvailableProviders();

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const available = await provider.isAvailable();
      if (!available) return [];
      return provider.getModels();
    })
  );

  const allModels: ModelInfo[] = [];
  results.forEach((result) => {
    /* v8 ignore next 2 */
    if (result.status === 'fulfilled') allModels.push(...result.value);
  });

  return allModels;
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

  return cachedModels;
}

export async function initializeModels(): Promise<void> {
  const cacheKey = 'global';

  if (modelsCache.has(cacheKey)) {
    return;
  }

  initializeProviders();
  await waitForOptionalProviderRegistration();

  try {
    const models = await loadModelsFromProviders();
    if (models.length > 0) {
      const mergedModels = mergePendingProviderSlices(cacheKey, mergeWithFallbackModels(models));
      modelsCache.set(cacheKey, mergedModels);
      cacheTimestamps.set(cacheKey, Date.now());
    } else {
      throw new Error('No models returned from providers');
    }
  } catch {
    const registry = getProviderRegistry();
    const filteredFallbacks = FALLBACK_MODELS.filter((m) => registry.has(m.provider));
    modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, filteredFallbacks));
    cacheTimestamps.set(cacheKey, Date.now());
  }
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
    try {
      if (signal?.aborted) {
        return;
      }
      const models = await loadModelsFromProviders();
      if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtStart) {
        return;
      }
      if (models.length > 0) {
        const mergedModels = mergeWithFallbackModels(models);
        if (previousModels && previousModels.length > mergedModels.length) {
          modelsCache.set(cacheKey, previousModels);
          cacheTimestamps.set(cacheKey, Date.now());
          return;
        }
        modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, mergedModels));
        cacheTimestamps.set(cacheKey, Date.now());
      } else if (!previousModels || previousModels.length === 0) {
        const registry = getProviderRegistry();
        const filteredFallbacks = FALLBACK_MODELS.filter((m) => registry.has(m.provider));
        modelsCache.set(cacheKey, mergePendingProviderSlices(cacheKey, filteredFallbacks));
        cacheTimestamps.set(cacheKey, Date.now());
      }
    } finally {
      refreshInProgress.delete(cacheKey);
      if (!modelsCache.has(cacheKey) && !cacheTimestamps.has(cacheKey)) {
        cacheGeneration.delete(cacheKey);
      }
    }
  })();

  refreshInProgress.set(cacheKey, refreshPromise);
  await refreshPromise;
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

  pendingProviderSlices.delete(pendingSliceKey(cacheKey, providerId));
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

  const staticProviderModels = STATIC_MODEL_METADATA.filter((m) => m.provider === providerId);
  return findInModels(staticProviderModels, idOrAlias) ?? null;
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

  const staticProviderModels = STATIC_MODEL_METADATA.filter((m) => m.provider === providerId);
  if (!findInModels(staticProviderModels, idOrAlias)) {
    return false;
  }

  if (sessionApiKey?.trim()) {
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
