import type { ModelInfo, ProviderRecord, Session } from '@hyperneo/shared';
import type {
  Provider,
  ProviderFailureErrorKind,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import type { QueryLike } from './agent/query-like.ts';
import type { ProviderRepository } from '../storage/repositories/provider-repository.ts';
import { decisionRun } from './space/runtime/decision-pipeline.ts';
import { COPILOT_ANTHROPIC_MODELS } from './providers/anthropic-copilot/models.js';
import { getCodexBridgeModelInfos, resolveCodexBridgeModelId } from './providers/codex-models.js';
import { DeepSeekProvider } from './providers/deepseek-provider.js';
import { initializeProviders, waitForOptionalProviderRegistration } from './providers/factory.js';
import { GlmProvider } from './providers/glm-provider.js';
import { KimiProvider } from './providers/kimi-provider.js';
import { MinimaxProvider } from './providers/minimax-provider.js';
import {
  classifyProviderFailure,
  clearProviderFailure,
  getAllProviderFailures,
  getProviderFailure,
  recordClassifiedProviderFailure,
  removeProviderFailure,
} from './providers/provider-failure-store.js';
import { getProviderRegistry } from './providers/registry.js';
import { mergeDiscoveredModels } from './providers/shared/discovery-cache.js';

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

export function mergeDiscoveredWithStatic(
  providerId: string,
  discovered: ReadonlyArray<ModelInfo>
): ModelInfo[] {
  const staticModels = STATIC_MODEL_METADATA.filter((model) => model.provider === providerId);
  return mergeDiscoveredModels(staticModels, discovered);
}

const refreshInProgress = new Map<string, Promise<void>>();

const cacheGeneration = new Map<string, number>();

let cacheClearSequence = 0;

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

const pendingSliceReleases = new Map<string, number>();

const pendingSliceEpochs = new Map<string, number>();

let providerRepositoryRef: ProviderRepository | null = null;

export function setProviderRepository(repo: ProviderRepository | null): void {
  providerRepositoryRef = repo;
}

function pendingSliceKey(cacheKey: string, providerId: string): string {
  return `${cacheKey}:${providerId}`;
}

export function mergePendingProviderSlices(
  cacheKey: string,
  models: ModelInfo[],
  loadSeq?: number,
  loadedProviderIds?: ReadonlySet<string>
): ModelInfo[] {
  let merged = models;
  const released: string[] = [];
  for (const [key, slice] of pendingProviderSlices) {
    if (!key.startsWith(`${cacheKey}:`)) continue;
    const providerId = key.slice(cacheKey.length + 1);
    const releaseAfterSeq = pendingSliceReleases.get(key);
    const providerLoaded =
      loadedProviderIds?.has(providerId) && models.some((model) => model.provider === providerId);
    if (
      releaseAfterSeq !== undefined &&
      loadSeq !== undefined &&
      loadSeq > releaseAfterSeq &&
      providerLoaded
    ) {
      released.push(key);
      continue;
    }
    merged = [...merged.filter((model) => model.provider !== providerId), ...slice];
  }
  for (const key of released) {
    pendingSliceReleases.delete(key);
    pendingProviderSlices.delete(key);
  }
  return merged;
}

export interface ModelsDiscoveryOwner {
  isLive(): boolean;
}

export async function getSupportedModelsFromQuery(
  queryObject: QueryLike | null,
  cacheKey: string = 'global',
  owner?: ModelsDiscoveryOwner
): Promise<ModelInfo[]> {
  if (modelsCache.has(cacheKey)) {
    return modelsCache.get(cacheKey)!;
  }

  if (queryObject && typeof queryObject.supportedModels === 'function') {
    try {
      const { getAnthropicModelsFromQuery } = await import('./providers/anthropic-provider.js');
      const models = await getAnthropicModelsFromQuery(queryObject);
      if (models.length > 0) {
        if (owner && !owner.isLive()) return [];
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
  unavailableProviders?: ReadonlySet<string>,
  loadSeq?: number,
  loadedProviderIds?: ReadonlySet<string>
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
      modelsCache.set(
        cacheKey,
        mergePendingProviderSlices(cacheKey, mergedModels, loadSeq, loadedProviderIds)
      );
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
  modelsCache.set(
    cacheKey,
    mergePendingProviderSlices(cacheKey, filteredFallbacks, loadSeq, loadedProviderIds)
  );
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
          current.supersededProviderIds,
          true,
          undefined,
          current.loadSeq,
          new Set(current.loadedProviderIds)
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

type PersistedDiscoveredEntry = {
  id: string;
  name?: string;
  contextWindow?: number;
  preferContextWindowMetadata?: boolean;
  description?: string;
  releaseDate?: string;
  available?: boolean;
  thinkingModes?: 'off' | 'on' | 'granular';
};

function buildPersistedModel(provider: Provider, entry: PersistedDiscoveredEntry): ModelInfo {
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    alias: '',
    family: provider.id,
    provider: provider.id,
    contextWindow: entry.contextWindow ?? 128000,
    preferContextWindowMetadata: entry.preferContextWindowMetadata,
    description: entry.description ?? `${entry.name ?? entry.id} via ${provider.id}`,
    releaseDate: entry.releaseDate ?? '',
    available: entry.available ?? true,
    thinkingModes: entry.thinkingModes,
  };
}

export function fallbackModelsFor(
  provider: Provider,
  persistedDiscovered: ReadonlyArray<PersistedDiscoveredEntry> = []
): ModelInfo[] {
  const cached = provider.getCachedModels?.();
  const staticSlice = STATIC_MODEL_METADATA.filter((model) => model.provider === provider.id);
  const base = cached && cached.length > 0 ? cached : staticSlice;
  if (persistedDiscovered.length === 0) return base;
  const knownIds = new Set(base.map((model) => model.id));
  const persistedSlice = persistedDiscovered
    .filter((entry) => !knownIds.has(entry.id))
    .map((entry) => buildPersistedModel(provider, entry));
  return [...base, ...persistedSlice];
}

function readPersistedDiscoveredEntry(
  entry: Record<string, unknown>
): PersistedDiscoveredEntry | null {
  const id = entry.id;
  if (typeof id !== 'string') return null;
  const parsed: PersistedDiscoveredEntry = { id };
  const name = entry.name;
  if (typeof name === 'string') parsed.name = name;
  const contextWindow = entry.contextWindow;
  if (typeof contextWindow === 'number') parsed.contextWindow = contextWindow;
  const preferContextWindowMetadata = entry.preferContextWindowMetadata;
  if (typeof preferContextWindowMetadata === 'boolean') {
    parsed.preferContextWindowMetadata = preferContextWindowMetadata;
  }
  const description = entry.description;
  if (typeof description === 'string') parsed.description = description;
  const releaseDate = entry.releaseDate;
  if (typeof releaseDate === 'string') parsed.releaseDate = releaseDate;
  const available = entry.available;
  if (typeof available === 'boolean') parsed.available = available;
  const thinkingModes = entry.thinkingModes;
  if (thinkingModes === 'off' || thinkingModes === 'on' || thinkingModes === 'granular') {
    parsed.thinkingModes = thinkingModes;
  }
  return parsed;
}

export function extractPersistedDiscoveredWrapper(configJson: string | undefined): {
  models: Array<PersistedDiscoveredEntry>;
  fingerprint?: string;
} | null {
  if (!configJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const discovered = obj.discoveredModels;
  if (!discovered || typeof discovered !== 'object' || Array.isArray(discovered)) return null;
  const models = (discovered as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  const entries = models.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const parsedEntry = readPersistedDiscoveredEntry(entry as Record<string, unknown>);
    return parsedEntry ? [parsedEntry] : [];
  });
  const fingerprint = (discovered as { fingerprint?: unknown }).fingerprint;
  return {
    models: entries,
    ...(typeof fingerprint === 'string' ? { fingerprint } : {}),
  };
}

interface PersistedDiscoveryCtx {
  provider: Provider;
  providerRepository: ProviderRepository | null;
  record?: ProviderRecord | null;
  wrapper?: ReturnType<typeof extractPersistedDiscoveredWrapper>;
  endpointFingerprint?: string;
  decision: PersistedDiscoveredEntry[] | null;
}

function loadRecordGate(ctx: PersistedDiscoveryCtx): PersistedDiscoveryCtx {
  if (!ctx.providerRepository) return { ...ctx, decision: [] };
  try {
    const record = ctx.providerRepository.getProviderByProviderId(ctx.provider.id);
    return { ...ctx, record };
  } catch {
    return { ...ctx, decision: [] };
  }
}

function extractWrapperGate(ctx: PersistedDiscoveryCtx): PersistedDiscoveryCtx {
  const wrapper = extractPersistedDiscoveredWrapper(ctx.record?.configJson);
  if (!wrapper) return { ...ctx, decision: [] };
  return { ...ctx, wrapper };
}

function validateFingerprintGate(ctx: PersistedDiscoveryCtx): PersistedDiscoveryCtx {
  let endpointFingerprint: string | undefined;
  try {
    endpointFingerprint = ctx.provider.getDiscoveryEndpointFingerprint?.(ctx.record?.baseUrl);
  } catch {
    return { ...ctx, decision: [] };
  }
  if (endpointFingerprint !== undefined && ctx.wrapper!.fingerprint !== endpointFingerprint) {
    return { ...ctx, decision: [] };
  }
  return { ...ctx, endpointFingerprint };
}

function finalizePersistedDiscoveryGate(ctx: PersistedDiscoveryCtx): PersistedDiscoveryCtx {
  return { ...ctx, decision: ctx.wrapper!.models };
}

const runPersistedDiscovery = decisionRun<PersistedDiscoveryCtx>('persisted-discovery', [
  loadRecordGate,
  extractWrapperGate,
  validateFingerprintGate,
  finalizePersistedDiscoveryGate,
]);

export function endpointMatchingPersistedDiscovered(
  provider: Provider
): Array<PersistedDiscoveredEntry> {
  const ctx = runPersistedDiscovery({ provider, providerRepository: providerRepositoryRef });
  return ctx.decision ?? [];
}

const PROVIDER_CATALOG_CACHE_TTL_MS = 10_000;

export { bumpProviderCatalogEpoch, getProviderCatalogEpoch } from './providers/catalog-epoch.js';

import { bumpProviderCatalogEpoch, getProviderCatalogEpoch } from './providers/catalog-epoch.js';

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
    cached.epoch === getProviderCatalogEpoch() &&
    Date.now() - cached.at < PROVIDER_CATALOG_CACHE_TTL_MS
  ) {
    return cached.models;
  }
  return null;
}

const scopedCatalogStamps = new Map<string, string>();

const scopedDiscoveryInFlight = new Map<string, number>();

const scopedDiscoverySeq = new Map<string, number>();

function peekSessionCatalogModels(cacheKey: string): ModelInfo[] | null {
  const cached = modelsCache.get(cacheKey);
  const at = cacheTimestamps.get(cacheKey);
  if (!cached || at === undefined || Date.now() - at >= PROVIDER_CATALOG_CACHE_TTL_MS) {
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
  const dropScopedCatalog = () => {
    modelsCache.delete(sessionCacheKey);
    cacheTimestamps.delete(sessionCacheKey);
    scopedCatalogStamps.delete(sessionCacheKey);
  };
  const provider = getProviderRegistry().get(providerId);
  if (!provider?.getModelsForSessionConfig) {
    dropScopedCatalog();
    return;
  }
  scopedDiscoveryInFlight.set(
    sessionCacheKey,
    (scopedDiscoveryInFlight.get(sessionCacheKey) ?? 0) + 1
  );
  const seq = (scopedDiscoverySeq.get(sessionCacheKey) ?? 0) + 1;
  scopedDiscoverySeq.set(sessionCacheKey, seq);
  if (!cacheGeneration.has(sessionCacheKey)) {
    cacheGeneration.set(sessionCacheKey, 0);
  }
  const generationAtStart = cacheGeneration.get(sessionCacheKey) ?? 0;
  try {
    const models = await provider.getModelsForSessionConfig(sessionConfig);
    if (
      scopedDiscoverySeq.get(sessionCacheKey) !== seq ||
      (cacheGeneration.get(sessionCacheKey) ?? 0) !== generationAtStart
    ) {
      return;
    }
    modelsCache.set(sessionCacheKey, models);
    cacheTimestamps.set(sessionCacheKey, Date.now());
    scopedCatalogStamps.set(sessionCacheKey, stamp);
  } catch {
    if (scopedDiscoverySeq.get(sessionCacheKey) === seq) {
      dropScopedCatalog();
    }
  } finally {
    const remaining = (scopedDiscoveryInFlight.get(sessionCacheKey) ?? 1) - 1;
    if (remaining <= 0) {
      scopedDiscoveryInFlight.delete(sessionCacheKey);
      scopedDiscoverySeq.delete(sessionCacheKey);
      cacheGeneration.delete(sessionCacheKey);
    } else {
      scopedDiscoveryInFlight.set(sessionCacheKey, remaining);
    }
  }
}

const PROVIDER_CATALOG_DISCOVERY_TIMEOUT_MS = 5_000;

const providerCatalogCache = new WeakMap<
  Provider,
  {
    models: ModelInfo[];
    at: number;
    curatedStamp: string | undefined;
    epoch: number;
    discovered: boolean;
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
    cached.epoch === getProviderCatalogEpoch() &&
    Date.now() - cached.at < PROVIDER_CATALOG_CACHE_TTL_MS
  ) {
    return Promise.resolve(cached.models);
  }
  const inflightKey = `${curatedStamp ?? ''}|${getProviderCatalogEpoch()}`;
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
  let discovered = false;
  for (let attempt = 0; ; attempt += 1) {
    const curatedNow = getProviderRegistry().getCuratedModels(providerId);
    const curatedStamp =
      curatedNow === undefined ? undefined : curatedNow.map((model) => model.id).join(',');
    const cached = providerCatalogCache.get(provider);
    if (
      cached &&
      cached.curatedStamp === curatedStamp &&
      cached.epoch === getProviderCatalogEpoch() &&
      Date.now() - cached.at < PROVIDER_CATALOG_CACHE_TTL_MS
    ) {
      return cached.models;
    }
    const epochAtFetch = getProviderCatalogEpoch();
    try {
      provider.clearModelCache?.();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fetched = await Promise.race([
        provider.getModels().finally(() => {
          if (timedOut) provider.clearModelCache?.();
        }),
        new Promise<ModelInfo[]>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('provider catalog discovery timed out'));
          }, PROVIDER_CATALOG_DISCOVERY_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (fetched.length > 0 || provider.hasCuratedModelList?.()) {
        models = fetched;
        discovered = true;
      } else {
        const attested = provider.getCachedModels?.();
        models =
          curatedNow !== undefined && curatedNow.length === 0
            ? fetched
            : attested && attested.length > 0
              ? attested
              : fallbackModelsFor(provider);
        discovered = Boolean(attested && attested.length > 0);
      }
    } catch {
      const attested = provider.getCachedModels?.();
      if (attested && attested.length > 0) {
        models = attested;
        discovered = true;
      } else {
        models = fallbackModelsFor(provider);
        discovered = false;
      }
    }
    if (getProviderCatalogEpoch() === epochAtFetch) {
      if (models.length > 0) {
        providerCatalogCache.set(provider, {
          models,
          at: Date.now(),
          curatedStamp,
          epoch: epochAtFetch,
          discovered,
        });
      }
      return models;
    }
    if (attempt >= 2) {
      return models;
    }
  }
}

function isProviderCatalogDiscovered(providerId: string, provider: Provider): boolean {
  const curatedNow = getProviderRegistry().getCuratedModels(providerId);
  const curatedStamp =
    curatedNow === undefined ? undefined : curatedNow.map((model) => model.id).join(',');
  const cached = providerCatalogCache.get(provider);
  return Boolean(
    cached &&
      cached.discovered &&
      cached.curatedStamp === curatedStamp &&
      cached.epoch === getProviderCatalogEpoch() &&
      Date.now() - cached.at < PROVIDER_CATALOG_CACHE_TTL_MS
  );
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

function replaceProviderModelsInCache(
  providerId: string,
  models: ModelInfo[],
  loadSeq: number,
  loaded: boolean
): void {
  const cacheKey = 'global';
  const key = pendingSliceKey(cacheKey, providerId);
  const pending = pendingProviderSlices.get(key);
  const releaseAfterSeq = pendingSliceReleases.get(key);
  const usePending =
    pending !== undefined &&
    (releaseAfterSeq === undefined || loadSeq <= releaseAfterSeq || models.length === 0 || !loaded);
  const slice = usePending ? pending : models;
  if (!usePending && pending !== undefined) {
    pendingProviderSlices.delete(key);
    pendingSliceReleases.delete(key);
  }
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
  replaceProviderModelsInCache(providerId, result.models, probeSeq, result.status === 'loaded');
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
  replaceProviderModelsInCache(providerId, result.models, probeSeq, result.status === 'loaded');
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

  const inProgress = refreshInProgress.get(cacheKey);
  if (inProgress) {
    await inProgress.catch(() => {});
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
          mergeWithFallbackModels(result.models),
          result.loadSeq,
          new Set(result.loadedProviderIds)
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
  if (!cacheKey || cacheKey === 'global') {
    cacheClearSequence += 1;
  }
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
    const releaseKeys = [...pendingSliceReleases.keys()];
    for (const key of releaseKeys) {
      if (key.startsWith(`${cacheKey}:`)) pendingSliceReleases.delete(key);
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
    pendingSliceReleases.clear();
    scopedCatalogStamps.clear();
    for (const key of inFlightKeys) {
      cacheGeneration.set(key, (cacheGeneration.get(key) ?? 0) + 1);
    }
    for (const key of scopedDiscoveryInFlight.keys()) {
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
          new Set(current.unavailableProviderIds),
          current.loadSeq,
          new Set(current.loadedProviderIds)
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
      forceRemote ? new Set(current.unavailableProviderIds) : undefined,
      current.loadSeq,
      new Set(current.loadedProviderIds)
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
  const sliceKey = pendingSliceKey(cacheKey, providerId);
  if (!cachedModels) {
    pendingProviderSlices.set(sliceKey, models);
    return false;
  }

  pendingProviderSlices.set(sliceKey, models);
  modelsCache.set(cacheKey, [
    ...cachedModels.filter((model) => model.provider !== providerId),
    ...models,
  ]);
  const generationAtUpdate = cacheGeneration.get(cacheKey) ?? 0;
  const epochAtUpdate = pendingSliceEpochs.get(sliceKey) ?? 0;
  const inFlight = refreshInProgress.get(cacheKey);
  if (inFlight) {
    inFlight
      .then(() => {
        if ((cacheGeneration.get(cacheKey) ?? 0) !== generationAtUpdate) return;
        if ((pendingSliceEpochs.get(sliceKey) ?? 0) !== epochAtUpdate) return;
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

export function restoreProviderModelsSlice(
  providerId: string,
  slice: ModelInfo[],
  cacheKey: string = 'global'
): void {
  const sliceKey = pendingSliceKey(cacheKey, providerId);
  pendingSliceEpochs.set(sliceKey, (pendingSliceEpochs.get(sliceKey) ?? 0) + 1);
  const current = modelsCache.get(cacheKey);
  if (!current) return;
  modelsCache.set(cacheKey, [
    ...current.filter((model) => model.provider !== providerId),
    ...slice,
  ]);
}

export function getModelsCacheClearSequence(): number {
  return cacheClearSequence;
}

export function getCurrentCacheLoad(cacheKey: string = 'global'): Promise<void> | undefined {
  return refreshInProgress.get(cacheKey);
}

export function applyDiscoveredProviderModels(
  providerId: string,
  models: ModelInfo[],
  cacheKey: string = 'global',
  persistedDiscovered: ReadonlyArray<{ id: string; name?: string }> = []
): { applied: boolean; models: ModelInfo[] } {
  const curatedIds = getCuratedModelIds(providerId);
  let enriched = models;
  if (curatedIds !== undefined) {
    const present = new Set(models.map((model) => model.id));
    const missing = [...curatedIds].filter((id) => !present.has(id));
    if (missing.length > 0) {
      const currentSlice = (modelsCache.get(cacheKey) ?? []).filter(
        (model) => model.provider === providerId
      );
      const byId = new Map(currentSlice.map((model) => [model.id, model]));
      const persistedById = new Map(
        persistedDiscovered.filter((entry) => entry.id).map((entry) => [entry.id, entry])
      );
      const seeded: ModelInfo[] = [];
      const seededIds = new Set<string>();
      const staticProviderModels = STATIC_MODEL_METADATA.filter(
        (model) => model.provider === providerId
      );
      for (const id of missing) {
        const canonical = findInModels(staticProviderModels, id);
        if (canonical && (present.has(canonical.id) || seededIds.has(canonical.id))) continue;
        const found = canonical ?? byId.get(id) ?? persistedById.get(id);
        if (found) {
          if ('family' in found) {
            seeded.push(found as ModelInfo);
            seededIds.add(found.id);
          } else {
            const base: ModelInfo = {
              id: found.id,
              name: found.name ?? found.id,
              alias: found.id,
              family: providerId,
              provider: providerId,
              contextWindow: 128000,
              preferContextWindowMetadata: true,
              description: `${found.name ?? found.id} via ${providerId}`,
              releaseDate: '',
              available: true,
            };
            seeded.push(base);
            seededIds.add(base.id);
          }
        }
      }
      if (seeded.length > 0) enriched = [...seeded, ...models];
    }
  }
  const appliedModels = filterProviderModels(providerId, enriched);
  const applied = updateProviderModelsInCache(providerId, appliedModels, cacheKey);
  return { applied, models: appliedModels };
}

export function markModelsCacheSliceProtected(cacheKey: string = 'global'): void {
  cacheTimestamps.set(cacheKey, Date.now());
}

export function seedProviderCatalogModels(provider: Provider, models: ModelInfo[]): void {
  const curatedNow = getProviderRegistry().getCuratedModels(provider.id);
  providerCatalogCache.set(provider, {
    models,
    at: Date.now(),
    curatedStamp:
      curatedNow === undefined ? undefined : curatedNow.map((model) => model.id).join(','),
    epoch: getProviderCatalogEpoch(),
    discovered: true,
  });
}

export function markProviderRefreshSucceeded(providerId: string): boolean {
  providerAppliedSeq.set(providerId, ++modelLoadSequence);
  clearProviderRetry(providerId);
  const recoveredFailure = clearProviderFailure(providerId);
  bumpProviderCatalogEpoch(providerId);
  return recoveredFailure;
}

export function releaseAppliedProviderSlice(providerId: string, cacheKey: string = 'global'): void {
  pendingSliceReleases.delete(pendingSliceKey(cacheKey, providerId));
  pendingProviderSlices.delete(pendingSliceKey(cacheKey, providerId));
}

export function getPendingProviderSlice(
  providerId: string,
  cacheKey: string = 'global'
): ModelInfo[] | undefined {
  return pendingProviderSlices.get(pendingSliceKey(cacheKey, providerId));
}

export function restoreProviderPendingSlice(
  providerId: string,
  slice: ModelInfo[] | undefined,
  cacheKey: string = 'global'
): void {
  const key = pendingSliceKey(cacheKey, providerId);
  pendingSliceEpochs.set(key, (pendingSliceEpochs.get(key) ?? 0) + 1);
  if (slice === undefined) {
    pendingProviderSlices.delete(key);
    pendingSliceReleases.delete(key);
    return;
  }
  pendingProviderSlices.set(key, slice);
  pendingSliceReleases.delete(key);
}

export function schedulePendingSliceRelease(providerId: string, cacheKey: string = 'global'): void {
  pendingSliceReleases.set(pendingSliceKey(cacheKey, providerId), modelLoadSequence);
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
  let liveDiscovered = preloadedModels !== undefined;
  if (preloadedModels === undefined) {
    const provider = getProviderRegistry().get(providerId);
    if (provider) {
      const cachedCatalog = peekProviderCatalogModels(providerId, provider);
      if (cachedCatalog) {
        liveModels = cachedCatalog;
        liveDiscovered = isProviderCatalogDiscovered(providerId, provider);
      } else {
        try {
          if (await provider.isAvailable()) {
            liveModels = await getProviderCatalogModels(providerId, provider);
            liveDiscovered = isProviderCatalogDiscovered(providerId, provider);
          }
        } catch {
          liveModels = fallbackModelsFor(provider);
          liveDiscovered = false;
        }
      }
    }
  }

  if (!liveDiscovered) {
    return cachedId;
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
