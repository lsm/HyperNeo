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
  if (fetchedModels.length > 0) {
    const mergedModels = mergeWithFallbackModels(fetchedModels);
    if (previousModels && previousModels.length > mergedModels.length) {
      modelsCache.set(cacheKey, previousModels);
    } else {
      modelsCache.set(cacheKey, mergedModels);
    }
    cacheTimestamps.set(cacheKey, Date.now());
    return;
  }
  if (!previousModels || previousModels.length === 0) {
    const registry = getProviderRegistry();
    const filteredFallbacks = FALLBACK_MODELS.filter((m) => registry.has(m.provider));
    modelsCache.set(cacheKey, filteredFallbacks);
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
    providers.map(async (provider) => {
      const available = await provider.isAvailable();
      if (!available) return [];
      return provider.getModels();
    })
  );

  const allModels: ModelInfo[] = [];
  const succeededProviderIds: string[] = [];
  const failures: ProviderLoadFailure[] = [];
  results.forEach((result, index) => {
    const provider = providers[index];
    if (result.status === 'fulfilled') {
      succeededProviderIds.push(provider.id);
      allModels.push(...result.value);
    } else {
      failures.push({ providerId: provider.id, ...classifyProviderFailure(result.reason) });
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

  return cachedModels;
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
        const mergedModels = mergeWithFallbackModels(result.models);
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
      modelsCache.set(cacheKey, filteredFallbacks);
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
    if (hadInFlight || cacheGeneration.has(cacheKey)) {
      cacheGeneration.set(cacheKey, (cacheGeneration.get(cacheKey) ?? 0) + 1);
    }
  } else {
    const inFlightKeys = new Set(refreshInProgress.keys());
    modelsCache.clear();
    cacheTimestamps.clear();
    refreshInProgress.clear();
    clearProviderModelCaches();
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

  const staticProviderModels = STATIC_MODEL_METADATA.filter((m) => m.provider === providerId);
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
