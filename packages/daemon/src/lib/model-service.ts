/**
 * Model Service - Unified model loading from providers
 *
 * This service manages model information by:
 * 1. Delegating to registered providers for model lists
 * 2. Caching models with 4-hour TTL
 * 3. Lazy background refresh when cache is stale
 *
 * The provider system (Phase 1) replaced ad-hoc model loading with a proper abstraction.
 * This file now acts as a facade over the provider registry.
 */

import type { ModelInfo, Session } from '@hyperneo/shared';
import type { QueryLike } from './agent/query-like';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';
import { getProviderRegistry } from './providers/registry.js';
import type { Provider } from '@hyperneo/shared/provider';
import { getCodexBridgeModelInfos, resolveCodexBridgeModelId } from './providers/codex-models.js';
import { GlmProvider } from './providers/glm-provider.js';
import { KimiProvider } from './providers/kimi-provider.js';

/**
 * Legacy model ID mappings to SDK model IDs
 * Maps old-style full IDs and aliases to current SDK identifiers
 * This is needed for backward compatibility with existing sessions
 */
const LEGACY_MODEL_MAPPINGS: Record<string, string> = {
  // Old alias mappings
  default: 'sonnet', // Legacy: 'default' maps to 'sonnet'
  // Full model IDs (any sonnet variant maps to sonnet)
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5-20250929': 'sonnet',
  'claude-sonnet-4-20241022': 'sonnet',
  'claude-3-5-sonnet-20241022': 'sonnet',
  // Opus - SDK uses 'opus'
  'claude-opus-4-5-20251101': 'opus',
  'claude-opus-4-20250514': 'opus',
  // Haiku - SDK uses 'haiku'
  'claude-haiku-4-5-20251001': 'haiku',
  'claude-3-5-haiku-20241022': 'haiku',
};

/**
 * In-memory cache of loaded models
 * Key: unique cache key (e.g., 'global' or session ID)
 * Value: array of ModelInfo
 */
const modelsCache = new Map<string, ModelInfo[]>();

/**
 * Timestamp tracking for cache freshness
 * Key: unique cache key
 * Value: timestamp (ms) when models were loaded
 */
const cacheTimestamps = new Map<string, number>();

/**
 * Cache TTL in milliseconds (4 hours)
 */
const CACHE_TTL = 4 * 60 * 60 * 1000;

/**
 * Static fallback models used when no providers are available (e.g., no API keys).
 * These are well-known Anthropic models with standard metadata so that model
 * resolution (alias → ID) still works without a live API call.
 */
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

/**
 * Static metadata for providers whose model catalog is known locally.
 *
 * This is used only for deterministic metadata lookup (current model display,
 * context-window resolution) when live provider loading is unavailable. It does
 * not make those providers available for use.
 *
 * GLM and Kimi are included because their context windows must be resolvable
 * even when the daemon starts without the provider's env var set globally but
 * the session supplies credentials via `session.config.providerConfig.apiKey`.
 * Without these entries, `getSessionModelInfo()` returns null and the HyperNeo
 * fallback compaction threshold can't be computed — sessions would run into the
 * real context limit with no compaction trigger.
 */
const STATIC_MODEL_METADATA: ModelInfo[] = [
  ...FALLBACK_MODELS,
  ...getCodexBridgeModelInfos(),
  ...GlmProvider.MODELS,
  ...KimiProvider.MODELS,
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

/**
 * Merge provider-loaded models with FALLBACK_MODELS.
 * This ensures well-known Anthropic model aliases (opus, sonnet, haiku)
 * are always available for resolution, even when only non-Anthropic
 * providers are configured.
 *
 * Provider models take precedence over fallback models with the same
 * (provider, id) pair. Models with the same id but different providers
 * are kept as separate entries so that provider-filtered lookup in
 * getModelInfo can distinguish them (e.g. both 'anthropic' and
 * 'anthropic-copilot' may expose 'claude-sonnet-4.6').
 */
function mergeWithFallbackModels(providerModels: ModelInfo[]): ModelInfo[] {
  // Key by "provider:id" so same-id models from different providers
  // are preserved as distinct entries rather than last-writer-wins.
  const modelMap = new Map<string, ModelInfo>();
  const registry = getProviderRegistry();

  // Add fallback models only when their provider is still registered.
  // This prevents disabled/deleted providers from leaving ghost entries.
  for (const model of FALLBACK_MODELS) {
    if (registry.has(model.provider)) {
      modelMap.set(`${model.provider}:${model.id}`, model);
    }
  }

  // Provider models override fallbacks with same (provider, id)
  for (const model of providerModels) {
    modelMap.set(`${model.provider}:${model.id}`, model);
  }

  return Array.from(modelMap.values());
}

/**
 * Track if a background refresh is in progress for a given cache key
 */
const refreshInProgress = new Map<string, Promise<void>>();

/**
 * Per-key monotonic generation counters used to invalidate in-flight
 * background refreshes.  `clearModelsCache(key)` bumps the counter for
 * that key only, so a session-scoped clear cannot accidentally cancel a
 * global refresh or vice-versa.
 */
const cacheGeneration = new Map<string, number>();

/**
 * Provider IDs that `models.list` has already probed via the stranded-provider
 * self-heal check while the current cache has been live. Prevents a refresh
 * storm when a connected provider's `getModels()` persistently fails (invalid
 * key, flaky upstream): each provider is retried at most once per cache
 * lifetime. Reset by `clearModelsCache()` so a re-connect (which clears the
 * cache) gets a fresh attempt.
 */
const refreshedMissingProviders = new Set<string>();

/**
 * Get supported models from an existing Claude SDK query object
 * This uses the AnthropicProvider to convert SDK models to ModelInfo
 *
 * @param queryObject - Existing SDK query object from a session
 * @param cacheKey - Unique key for caching (e.g., session ID or 'global')
 * @returns Array of ModelInfo, or empty array if query doesn't support it
 */
export async function getSupportedModelsFromQuery(
  queryObject: QueryLike | null,
  cacheKey: string = 'global'
): Promise<ModelInfo[]> {
  // Return cached if available
  if (modelsCache.has(cacheKey)) {
    return modelsCache.get(cacheKey)!;
  }

  // Try to get models from query object using AnthropicProvider
  if (queryObject && typeof queryObject.supportedModels === 'function') {
    try {
      const { getAnthropicModelsFromQuery } = await import('./providers/anthropic-provider.js');
      const models = await getAnthropicModelsFromQuery(queryObject);
      if (models.length > 0) {
        // Cache the result with timestamp
        modelsCache.set(cacheKey, models);
        cacheTimestamps.set(cacheKey, Date.now());
        return models;
      }
      /* v8 ignore next 2 */
    } catch {
      // Failed to load models from SDK
    }
  }

  return [];
}

/**
 * Get all available providers
 */
function getAvailableProviders(): Provider[] {
  const registry = getProviderRegistry();
  // Synchronous check - we'll filter later if needed
  return registry.getAll();
}

/**
 * Trigger background refresh of models if cache is stale
 * Does not block - runs asynchronously
 */
async function triggerBackgroundRefresh(cacheKey: string): Promise<void> {
  // Check if refresh already in progress
  if (refreshInProgress.has(cacheKey)) {
    return;
  }

  const generationAtStart = cacheGeneration.get(cacheKey) ?? 0;

  // Start background refresh
  const refreshPromise = (async () => {
    try {
      const models = await loadModelsFromProviders();
      // Only write if the cache wasn't cleared while we were loading.
      // This prevents a stale pre-change provider list from overwriting
      // the cache after `clearModelsCache()` has been called.
      if (models.length > 0 && (cacheGeneration.get(cacheKey) ?? 0) === generationAtStart) {
        // Merge with fallback models to ensure Anthropic aliases are always available
        const mergedModels = mergeWithFallbackModels(models);
        modelsCache.set(cacheKey, mergedModels);
        cacheTimestamps.set(cacheKey, Date.now());
      }
      /* v8 ignore next 2 */
    } catch {
      // Background refresh failed
    } finally {
      refreshInProgress.delete(cacheKey);
      // Prune generation tracking if the cache key is no longer referenced
      if (!modelsCache.has(cacheKey) && !cacheTimestamps.has(cacheKey)) {
        cacheGeneration.delete(cacheKey);
      }
    }
  })();

  refreshInProgress.set(cacheKey, refreshPromise);
}

/**
 * Load models from all available providers
 */
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

  // Fan out in parallel so a slow provider probe (Kimi, GLM, MiniMax, Codex,
  // ACP, Custom Endpoint each do a 5s-bounded network probe in getModels())
  // does not serialise behind the others. Promise.allSettled preserves the
  // existing per-provider fault tolerance — one failing probe does not hide
  // the rest of the list. Order is preserved by mapping back over the
  // original `providers` array.
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
    // Rejections are swallowed — model picker shows whatever loaded.
  });

  return allModels;
}

/**
 * Check if cache is stale (older than CACHE_TTL)
 */
function isCacheStale(cacheKey: string): boolean {
  const timestamp = cacheTimestamps.get(cacheKey);
  if (!timestamp) return true;
  return Date.now() - timestamp > CACHE_TTL;
}

/**
 * Get all available models - unified list from all providers
 *
 * Implements lazy refresh: returns cache immediately, triggers background refresh if stale
 *
 * @param cacheKey - Cache key to look up dynamic models
 * @returns Array of ModelInfo including all available providers
 */
export function getAvailableModels(cacheKey: string = 'global'): ModelInfo[] {
  const cachedModels = modelsCache.get(cacheKey);

  if (!cachedModels || cachedModels.length === 0) {
    // Models not loaded or failed to load - return empty array
    // Callers should initialize models first via initializeModels()
    return [];
  }

  // Trigger background refresh if stale (non-blocking)
  if (isCacheStale(cacheKey)) {
    triggerBackgroundRefresh(cacheKey).catch(() => {
      // Ignore errors - we already have cached data
    });
  }

  return cachedModels;
}

/**
 * Initialize models on app startup
 * MUST be called before any other model functions
 *
 * @returns Promise that resolves when models are loaded
 * @throws Error if all providers fail to load models
 */
export async function initializeModels(): Promise<void> {
  const cacheKey = 'global';

  // Skip if already initialized
  if (modelsCache.has(cacheKey)) {
    return;
  }

  // Initialize the provider system (registers built-in providers)
  initializeProviders();
  await waitForOptionalProviderRegistration();

  try {
    const models = await loadModelsFromProviders();
    if (models.length > 0) {
      // Merge provider models with FALLBACK_MODELS to ensure well-known Anthropic
      // model aliases (opus, sonnet, haiku) are always available for resolution,
      // even when only non-Anthropic providers are configured
      const mergedModels = mergeWithFallbackModels(models);
      modelsCache.set(cacheKey, mergedModels);
      cacheTimestamps.set(cacheKey, Date.now());
    } else {
      throw new Error('No models returned from providers');
    }
  } catch {
    // Failed to load models - use well-known Anthropic models as fallback,
    // but only for providers that are still registered.
    const registry = getProviderRegistry();
    const filteredFallbacks = FALLBACK_MODELS.filter((m) => registry.has(m.provider));
    modelsCache.set(cacheKey, filteredFallbacks);
    cacheTimestamps.set(cacheKey, Date.now());
  }
}

/**
 * Clear per-provider model caches so the next getModels() call re-fetches
 * from each provider's API.
 */
function clearProviderModelCaches(): void {
  const registry = getProviderRegistry();
  for (const provider of registry.getAll()) {
    if (provider.clearModelCache) {
      provider.clearModelCache();
    }
  }
}

/**
 * Clear the models cache for a specific key or all.
 * Provider-level caches are only cleared on a full clear (no cacheKey).
 *
 * Also bumps the per-key cache generation so any in-flight background
 * refreshes for that key drop their stale results instead of overwriting
 * the cleared cache.
 */
export function clearModelsCache(cacheKey?: string): void {
  if (cacheKey) {
    const hadInFlight = refreshInProgress.has(cacheKey);
    modelsCache.delete(cacheKey);
    cacheTimestamps.delete(cacheKey);
    refreshInProgress.delete(cacheKey);
    if (hadInFlight || cacheGeneration.has(cacheKey)) {
      // Bump (or preserve) the generation so any in-flight refresh —
      // including one invalidated by an earlier clear — drops its result.
      cacheGeneration.set(cacheKey, (cacheGeneration.get(cacheKey) ?? 0) + 1);
    }
    // If there's no in-flight refresh and no generation history, there's
    // nothing to invalidate; leave the key absent.
  } else {
    const inFlightKeys = new Set(refreshInProgress.keys());
    modelsCache.clear();
    cacheTimestamps.clear();
    refreshInProgress.clear();
    clearProviderModelCaches();
    // Bump generation for keys that had in-flight refreshes so any
    // running background refresh drops its stale result instead of
    // overwriting the cleared cache.
    for (const key of inFlightKeys) {
      cacheGeneration.set(key, (cacheGeneration.get(key) ?? 0) + 1);
    }
    // NOTE: We intentionally do NOT prune cacheGeneration here.
    // A prior global clear may have bumped a generation to cancel an
    // in-flight refresh; if a second clear arrives before that refresh
    // resolves, pruning would delete the bump and allow the stale
    // result to be written.  Keys are cleaned up by
    // triggerBackgroundRefresh's finally block once the refresh completes.
    // A full clear means global provider availability may have changed
    // (connect/disconnect/etc.), so the stranded-provider retry tracking
    // starts fresh — a re-connect gets a fresh probe attempt. This MUST stay
    // in the full-clear branch: session-scoped clears (`clearModelsCache(key)`)
    // only drop one session's cache entry and do not change which providers are
    // available, so resetting this global set there would let any model switch
    // re-probe every missing provider on the next `models.list`.
    refreshedMissingProviders.clear();
  }
}

/**
 * Has `models.list` already attempted a stranded-provider refresh for this
 * provider during the current cache's lifetime? See `refreshedMissingProviders`.
 */
export function hasRefreshBeenAttemptedFor(providerId: string): boolean {
  return refreshedMissingProviders.has(providerId);
}

/**
 * Record that `models.list` has probed these providers via the stranded-provider
 * check, so they are not re-probed (and re-refreshed) on every subsequent
 * `models.list` call within this cache's lifetime. See
 * `refreshedMissingProviders`.
 */
export function markRefreshAttemptedFor(providerIds: string[]): void {
  for (const id of providerIds) refreshedMissingProviders.add(id);
}

/**
 * Refresh models from all providers, preserving the existing cache on failure.
 * Clears provider-level caches first so each provider re-fetches from its API,
 * but only replaces the global cache if the fetch succeeds.
 *
 * If no providers return models and the cache was empty (e.g. after an explicit
 * clear), FALLBACK_MODELS is restored so the UI and model resolution paths
 * never see a permanently empty catalog.
 */
export async function refreshModels(signal?: AbortSignal): Promise<void> {
  const cacheKey = 'global';

  // Wait for any in-progress background refresh to finish so we don't race
  const inProgress = refreshInProgress.get(cacheKey);
  if (inProgress) {
    await inProgress;
    if (signal?.aborted) {
      return;
    }
  }

  // If another foreground refresh is already running, wait for it.
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
      // Only write if the cache wasn't cleared while we were loading.
      if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtStart) {
        return;
      }
      if (models.length > 0) {
        const mergedModels = mergeWithFallbackModels(models);
        // If the new result has fewer models than the previous cache, at least one
        // provider likely returned static fallback data instead of live API results
        // (e.g. OpenRouter returns FALLBACK_MODELS on HTTP errors). Keep the old,
        // richer cache rather than replacing it with degraded fallback metadata.
        // Compare merged-vs-merged so the fallback entries added by mergeWithFallbackModels
        // don't distort the comparison.
        if (previousModels && previousModels.length > mergedModels.length) {
          modelsCache.set(cacheKey, previousModels);
          cacheTimestamps.set(cacheKey, Date.now());
          return;
        }
        modelsCache.set(cacheKey, mergedModels);
        cacheTimestamps.set(cacheKey, Date.now());
      } else if (!previousModels || previousModels.length === 0) {
        // Cache was cleared or was already empty — restore fallback models
        // so the UI and model resolution paths always have a baseline catalog.
        const registry = getProviderRegistry();
        const filteredFallbacks = FALLBACK_MODELS.filter((m) => registry.has(m.provider));
        modelsCache.set(cacheKey, filteredFallbacks);
        cacheTimestamps.set(cacheKey, Date.now());
      }
    } finally {
      refreshInProgress.delete(cacheKey);
      // Prune generation tracking if the cache key is no longer referenced.
      if (!modelsCache.has(cacheKey) && !cacheTimestamps.has(cacheKey)) {
        cacheGeneration.delete(cacheKey);
      }
    }
  })();

  refreshInProgress.set(cacheKey, refreshPromise);
  await refreshPromise;
}

/**
 * Get current models cache (for testing)
 * @returns Map of cached models
 *
 * @public Exported for testing purposes
 */
export function getModelsCache(): Map<string, ModelInfo[]> {
  return new Map(modelsCache);
}

/**
 * Set models cache (for testing - allows reusing cached models)
 * @param cache Map of cached models to restore
 *
 * @public Exported for testing purposes
 */
export function setModelsCache(cache: Map<string, ModelInfo[]>, timestamp?: number): void {
  modelsCache.clear();
  cacheTimestamps.clear();
  const ts = timestamp ?? Date.now();
  for (const [key, models] of cache.entries()) {
    modelsCache.set(key, models);
    cacheTimestamps.set(key, ts);
  }
}

/**
 * Three-step search helper for a given model list.
 * 1. Exact ID match
 * 2. Alias field match
 * 3. Legacy model mapping
 */
export function findInModels(models: ModelInfo[], idOrAlias: string): ModelInfo | undefined {
  const normalized = idOrAlias.toLowerCase();

  // 1. Exact ID match (works for SDK's short IDs like 'opus', 'default')
  let found = models.find((m) => m.id === idOrAlias);

  // 2. Case-insensitive ID match for providers whose routing accepts aliases
  // after lowercasing (e.g. Kimi accepts `KIMI` and `Moonshot-v1-32k`).
  if (!found) {
    found = models.find((m) => m.id.toLowerCase() === normalized);
  }

  // 3. Alias field match
  if (!found) {
    found = models.find((m) => m.alias === idOrAlias);
  }

  // 4. Case-insensitive alias field match
  if (!found) {
    found = models.find((m) => m.alias.toLowerCase() === normalized);
  }

  // 5. Provider-accepted aliases. These are user/config spellings that should
  // pass validation and resolve metadata. Do NOT use sdkModelIds here: those are
  // model IDs reported by the provider's SDK (may differ from user-selectable IDs)
  // and must not become user-selectable/provider-accepted IDs.
  if (!found) {
    found = models.find((m) =>
      m.providerAliases?.some((alias) => alias.toLowerCase() === normalized)
    );
  }

  // 6. Provider-accepted alias prefixes. Used for open-ended alias families
  // such as Kimi's moonshot-* IDs. When multiple prefixes match, the longest
  // (most specific) wins — e.g. `moonshot-k3-256k` must outrank the broader
  // `moonshot-k3` so a 256K alias resolves to the 256K model, not the 1M entry.
  // Keep separate from sdkModelIds for the same reason as providerAliases.
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

  // 7. Legacy model mapping (maps old full IDs to SDK short IDs)
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

/**
 * Get model info by ID or alias, filtered to the specified provider.
 * All three parameters are required — no fallback to unfiltered search.
 * Returns null if no model matching both idOrAlias and providerId is found.
 *
 * @param idOrAlias - Model ID or alias to look up
 * @param cacheKey - Cache key to look up models
 * @param providerId - Provider ID to filter by (required)
 */
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

/**
 * Get model info by ID or alias without filtering by provider.
 * Use this ONLY for callers that genuinely lack provider context (e.g., legacy
 * config paths, manual test utilities). For all new code, prefer `getModelInfo`
 * with an explicit `providerId`.
 *
 * WARNING: If the same model ID exists in multiple providers (e.g., `claude-sonnet-4.6`
 * in both `anthropic` and `anthropic-copilot`), this function returns whichever entry
 * appears first in the cache — the result is ambiguous and provider-dependent.
 *
 * @param idOrAlias - Model ID or alias to look up
 * @param cacheKey - Cache key to look up models (defaults to 'global')
 */
export async function getModelInfoUnfiltered(
  idOrAlias: string,
  cacheKey: string = 'global'
): Promise<ModelInfo | null> {
  const availableModels = getAvailableModels(cacheKey);
  return findInModels(availableModels, idOrAlias) ?? null;
}

/**
 * Validate if a model ID or alias is valid for the specified provider.
 * All three parameters are required — validation is strict, no unfiltered fallback.
 *
 * @param idOrAlias - Model ID or alias to validate
 * @param cacheKey - Cache key to look up models
 * @param providerId - Provider ID to filter by (required)
 */
export async function isValidModel(
  idOrAlias: string,
  cacheKey: string,
  providerId: string
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

/**
 * Resolve a model alias to its actual ID, filtered to the specified provider.
 * All three parameters are required.
 * Returns the original idOrAlias if no match is found.
 *
 * @param idOrAlias - Model ID or alias to resolve
 * @param cacheKey - Cache key to look up models
 * @param providerId - Provider ID to filter by (required)
 */
export async function resolveModelAlias(
  idOrAlias: string,
  cacheKey: string,
  providerId: string
): Promise<string> {
  const modelInfo = await getModelInfo(idOrAlias, cacheKey, providerId);
  if (modelInfo) {
    return modelInfo.id;
  }
  // Return as-is if nothing found
  return idOrAlias;
}

/**
 * Resolve a model alias to its actual ID without filtering by provider.
 * Use this ONLY for callers that genuinely lack provider context.
 * For all new code, prefer `resolveModelAlias` with an explicit `providerId`.
 *
 * WARNING: Same ambiguity caveat as `getModelInfoUnfiltered` — if the same alias
 * resolves to different IDs in different providers, the result is non-deterministic.
 *
 * @param idOrAlias - Model ID or alias to resolve
 * @param cacheKey - Cache key to look up models (defaults to 'global')
 */
export async function resolveModelAliasUnfiltered(
  idOrAlias: string,
  cacheKey: string = 'global'
): Promise<string> {
  const modelInfo = await getModelInfoUnfiltered(idOrAlias, cacheKey);
  if (modelInfo) {
    return modelInfo.id;
  }
  // Return as-is if nothing found
  return idOrAlias;
}
