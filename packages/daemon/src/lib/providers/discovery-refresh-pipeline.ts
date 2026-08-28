import type { ModelInfo, ProviderRecord } from '@hyperneo/shared';
import type { CuratedModel, Provider, ProviderCredentials } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ProviderRepository } from '../../storage/repositories/provider-repository.js';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.js';
import { getProviderRegistry } from './registry.js';

const MAX_JSON_FIELD_LEN = 64 * 1024;

export const DISCOVERY_REFRESH_TIMEOUT_MS = 30_000;

export function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Provider discovery timed out')), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isUnchangedSavedConfig(
  record: ProviderRecord | null,
  saved: { baseUrl?: string; configJson?: string }
): boolean {
  return (
    !!record &&
    record.isEnabled !== false &&
    record.baseUrl === saved.baseUrl &&
    record.configJson === saved.configJson
  );
}

export function credentialIdentity(credentials: ProviderCredentials | null | undefined): string {
  if (!credentials) return 'null';
  if (credentials.type === 'api_key') {
    return JSON.stringify({ type: 'api_key', apiKey: credentials.apiKey });
  }
  return JSON.stringify({
    type: 'oauth',
    refreshToken: credentials.refreshToken ?? null,
    ...(credentials.refreshToken === undefined ? { accessToken: credentials.accessToken } : {}),
  });
}

export async function isSupersededSavedConfigRefresh(
  provider: Provider,
  providerRepo: ProviderRepository,
  rowId: string,
  saved: { baseUrl?: string; configJson?: string },
  clearsAtStart: number,
  credentialsAtStart: string,
  getModelsCacheClearSequence: () => number
): Promise<boolean> {
  const credentialsNow = credentialIdentity(await provider.getCredentials?.());
  return (
    credentialsNow !== credentialsAtStart ||
    getModelsCacheClearSequence() !== clearsAtStart ||
    !isUnchangedSavedConfig(providerRepo.getProvider(rowId), saved)
  );
}

const PROVIDERS_WITH_FIXED_DISCOVERY_ENDPOINT = new Set([
  'anthropic',
  'deepseek',
  'glm',
  'openrouter',
]);

export function providerIgnoresSavedEndpoint(provider: Provider, savedBaseUrl?: string): boolean {
  if (!savedBaseUrl) return false;
  let withBaseUrl: string | undefined;
  let withoutBaseUrl: string | undefined;
  try {
    withBaseUrl = provider.getDiscoveryEndpointFingerprint?.(savedBaseUrl);
    withoutBaseUrl = provider.getDiscoveryEndpointFingerprint?.();
  } catch {
    return PROVIDERS_WITH_FIXED_DISCOVERY_ENDPOINT.has(provider.id);
  }
  if (withBaseUrl !== undefined && withoutBaseUrl !== undefined && withBaseUrl === withoutBaseUrl) {
    return true;
  }
  return PROVIDERS_WITH_FIXED_DISCOVERY_ENDPOINT.has(provider.id);
}

const LAST_GOOD_DISCOVERY_KEY = 'discoveredModels';
const LAST_GOOD_DISCOVERY_WRAPPER_RESERVE =
  `${JSON.stringify(LAST_GOOD_DISCOVERY_KEY)}:${JSON.stringify({ models: [], truncated: true })}`
    .length + 1;

interface LastGoodDiscoveredModels {
  models: CuratedModel[];
  truncated?: boolean;
  fingerprint?: string;
}

function lastGoodDiscoveryBudget(
  base: Record<string, unknown>,
  endpointFingerprint?: string
): number {
  const stripped = { ...base };
  delete stripped[LAST_GOOD_DISCOVERY_KEY];
  const prefixLength = Object.keys(stripped).length > 0 ? JSON.stringify(stripped).length + 1 : 1;
  const fingerprintReserve =
    endpointFingerprint === undefined
      ? 0
      : `,"fingerprint":${JSON.stringify(endpointFingerprint)}`.length;
  return Math.max(
    0,
    MAX_JSON_FIELD_LEN - prefixLength - LAST_GOOD_DISCOVERY_WRAPPER_RESERVE - fingerprintReserve
  );
}

function buildLastGoodDiscoveredModels(
  providerId: string,
  discovered: ReadonlyArray<{ id: string; name?: string }>,
  budget: number
): LastGoodDiscoveredModels {
  const registry = getProviderRegistry();
  const byId = new Map<string, CuratedModel>();
  for (const curated of registry.getCuratedModels(providerId) ?? []) {
    if (!byId.has(curated.id)) {
      byId.set(curated.id, {
        id: curated.id,
        ...(curated.name === undefined ? {} : { name: curated.name }),
      });
    }
  }
  const curatedCount = byId.size;
  for (const model of discovered) {
    const seeded = byId.get(model.id);
    if (seeded) {
      if (seeded.name === undefined && model.name !== undefined) seeded.name = model.name;
      continue;
    }
    byId.set(model.id, { id: model.id, ...(model.name === undefined ? {} : { name: model.name }) });
  }
  const models: CuratedModel[] = [];
  let used = 2;
  let index = 0;
  let truncated = false;
  for (const entry of byId.values()) {
    let candidate = entry;
    let cost = JSON.stringify(entry).length + (models.length === 0 ? 0 : 1);
    if (used + cost > budget && entry.name !== undefined) {
      const bare: CuratedModel = { id: entry.id };
      const bareCost = JSON.stringify(bare).length + (models.length === 0 ? 0 : 1);
      if (used + bareCost <= budget) {
        candidate = bare;
        cost = bareCost;
      }
    }
    if (used + cost > budget) {
      if (index < curatedCount) {
        throw new Error('Provider config has no capacity to retain all curated models');
      }
      truncated = true;
      break;
    }
    models.push(candidate);
    used += cost;
    index++;
  }
  return { models, ...(truncated ? { truncated: true } : {}) };
}

function persistLastGoodDiscoveredModels(
  providerRepo: ProviderRepository,
  record: ProviderRecord,
  discovered: ReadonlyArray<{ id: string; name?: string }>,
  endpointFingerprint?: string
): boolean {
  let base: Record<string, unknown> = {};
  if (record.configJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.configJson);
    } catch {
      throw new Error(
        'Saved provider config is not valid JSON; refresh rejected to avoid overwriting it'
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'Saved provider config is not a JSON object; refresh rejected to avoid overwriting it'
      );
    }
    base = parsed as Record<string, unknown>;
  }
  const budget = lastGoodDiscoveryBudget(base, endpointFingerprint);
  if (budget < 2) {
    throw new Error('Provider config has no capacity to persist discovery results');
  }
  const lastGood = buildLastGoodDiscoveredModels(record.providerId, discovered, budget);
  base[LAST_GOOD_DISCOVERY_KEY] = {
    ...lastGood,
    ...(endpointFingerprint === undefined ? {} : { fingerprint: endpointFingerprint }),
  };
  providerRepo.updateProvider(record.id, { configJson: JSON.stringify(base) });
  return lastGood.truncated === true;
}

export function stripPersistedDiscovery(configJson: string | undefined): string | undefined {
  if (!configJson) return configJson;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return configJson;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return configJson;
  if (!(LAST_GOOD_DISCOVERY_KEY in parsed)) return configJson;
  delete parsed[LAST_GOOD_DISCOVERY_KEY];
  return JSON.stringify(parsed);
}

export type SavedConfigDiscoveryRefreshOutcome =
  | { success: false; reason: 'superseded' }
  | {
      success: true;
      truncated?: boolean;
      models: Array<{ id: string; name?: string }>;
    };

export interface CommitSavedConfigDiscoveryRefreshDeps {
  providerRepo: ProviderRepository;
  provider: Provider;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  getModelsCacheClearSequence(): number;
  getCurrentCacheLoad(cacheKey?: string): Promise<void> | undefined;
  getModelsCache(): Map<string, ModelInfo[]>;
  restoreProviderModelsSlice(providerId: string, slice: ModelInfo[], cacheKey?: string): void;
  applyDiscoveredProviderModels(
    providerId: string,
    models: ModelInfo[],
    cacheKey?: string,
    persistedDiscovered?: ReadonlyArray<{ id: string; name?: string }>
  ): { applied: boolean; models: ModelInfo[] };
  releaseAppliedProviderSlice(providerId: string, cacheKey?: string): void;
  getPendingProviderSlice(providerId: string, cacheKey?: string): ModelInfo[] | undefined;
  restoreProviderPendingSlice(
    providerId: string,
    slice: ModelInfo[] | undefined,
    cacheKey?: string
  ): void;
  schedulePendingSliceRelease(providerId: string, cacheKey?: string): void;
  markProviderRefreshSucceeded(providerId: string): boolean;
  mergeDiscoveredWithStatic(providerId: string, discovered: ReadonlyArray<ModelInfo>): ModelInfo[];
  markModelsCacheSliceProtected(cacheKey?: string): void;
  seedProviderCatalogModels(provider: Provider, models: ModelInfo[]): void;
}

export interface CommitSavedConfigDiscoveryRefreshCtx {
  deps: CommitSavedConfigDiscoveryRefreshDeps;
  providerId: string;
  rowId: string;
  savedConfig: { baseUrl?: string; configJson?: string };
  discoveryBaseUrl: string | undefined;
  originalConfigJson: string | undefined;
  credentialsAtStart: string;
  clearsAtStart: number;
  discovered: ModelInfo[];
  persistedDiscovered: ReadonlyArray<{ id: string; name?: string }>;
  currentRecord?: ProviderRecord | null;
  persistedConfig?: { baseUrl?: string; configJson?: string };
  normalizedDiscovered?: ModelInfo[];
  appliedSlice?: ModelInfo[];
  previousSlice?: ModelInfo[];
  previousOverlay?: ModelInfo[];
  truncated?: boolean;
  recoveredFailure?: boolean;
  outcome?: SavedConfigDiscoveryRefreshOutcome;
}

export async function revalidateSavedConfigUnderLock(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): Promise<CommitSavedConfigDiscoveryRefreshCtx> {
  const currentRecord = ctx.deps.providerRepo.getProvider(ctx.rowId);
  if (
    await isSupersededSavedConfigRefresh(
      ctx.deps.provider,
      ctx.deps.providerRepo,
      ctx.rowId,
      ctx.savedConfig,
      ctx.clearsAtStart,
      ctx.credentialsAtStart,
      ctx.deps.getModelsCacheClearSequence
    )
  ) {
    ctx.deps.provider.clearModelCache?.();
    return { ...ctx, currentRecord, outcome: { success: false, reason: 'superseded' } };
  }
  return { ...ctx, currentRecord };
}

export function persistLastGoodSlice(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  let truncated = false;
  try {
    truncated = persistLastGoodDiscoveredModels(
      ctx.deps.providerRepo,
      ctx.currentRecord!,
      ctx.discovered,
      ctx.deps.provider.getDiscoveryEndpointFingerprint?.(ctx.discoveryBaseUrl)
    );
  } catch (persistError) {
    ctx.deps.provider.clearModelCache?.();
    throw persistError;
  }
  return {
    ...ctx,
    truncated,
    persistedConfig: {
      baseUrl: ctx.savedConfig.baseUrl,
      configJson: ctx.deps.providerRepo.getProvider(ctx.rowId)?.configJson,
    },
  };
}

export async function applyDiscoveredSliceToLiveCache(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): Promise<CommitSavedConfigDiscoveryRefreshCtx> {
  const normalizedDiscovered = ctx.deps.mergeDiscoveredWithStatic(ctx.providerId, ctx.discovered);
  const previousSlice = (ctx.deps.getModelsCache().get('global') ?? []).filter(
    (model) => model.provider === ctx.providerId
  );
  const previousOverlay = ctx.deps.getPendingProviderSlice(ctx.providerId);
  const firstApply = ctx.deps.applyDiscoveredProviderModels(
    ctx.providerId,
    normalizedDiscovered,
    'global',
    ctx.persistedDiscovered
  );
  if (firstApply.applied) {
    if (ctx.discoveryBaseUrl === undefined) {
      ctx.deps.releaseAppliedProviderSlice(ctx.providerId);
    } else {
      ctx.deps.markModelsCacheSliceProtected('global');
    }
    return {
      ...ctx,
      normalizedDiscovered,
      appliedSlice: firstApply.models,
      previousSlice,
      previousOverlay,
    };
  }
  const inFlight = ctx.deps.getCurrentCacheLoad();
  if (!inFlight) {
    if (ctx.discoveryBaseUrl === undefined) {
      ctx.deps.schedulePendingSliceRelease(ctx.providerId);
    }
    return { ...ctx, normalizedDiscovered, previousSlice, previousOverlay };
  }
  await raceWithTimeout(
    inFlight.catch(() => {}),
    DISCOVERY_REFRESH_TIMEOUT_MS
  ).catch(() => {});
  const supersededDuringWait = await isSupersededSavedConfigRefresh(
    ctx.deps.provider,
    ctx.deps.providerRepo,
    ctx.rowId,
    ctx.persistedConfig!,
    ctx.clearsAtStart,
    ctx.credentialsAtStart,
    ctx.deps.getModelsCacheClearSequence
  );
  const currentRow = ctx.deps.providerRepo.getProvider(ctx.rowId);
  if (supersededDuringWait) {
    ctx.deps.restoreProviderPendingSlice(ctx.providerId, previousOverlay);
    ctx.deps.restoreProviderModelsSlice(ctx.providerId, previousSlice);
    if (currentRow && currentRow.configJson === ctx.persistedConfig!.configJson) {
      ctx.deps.providerRepo.updateProvider(ctx.rowId, { configJson: ctx.originalConfigJson });
    }
    ctx.deps.provider.clearModelCache?.();
    return {
      ...ctx,
      normalizedDiscovered,
      previousOverlay,
      outcome: { success: false, reason: 'superseded' },
    };
  }
  const retryPreviousSlice = (ctx.deps.getModelsCache().get('global') ?? []).filter(
    (model) => model.provider === ctx.providerId
  );
  const retryApply = ctx.deps.applyDiscoveredProviderModels(
    ctx.providerId,
    normalizedDiscovered,
    'global',
    ctx.persistedDiscovered
  );
  if (retryApply.applied) {
    if (ctx.discoveryBaseUrl === undefined) {
      ctx.deps.releaseAppliedProviderSlice(ctx.providerId);
    } else {
      ctx.deps.markModelsCacheSliceProtected('global');
    }
  } else if (ctx.discoveryBaseUrl === undefined) {
    ctx.deps.schedulePendingSliceRelease(ctx.providerId);
  }
  return {
    ...ctx,
    normalizedDiscovered,
    appliedSlice: retryApply.models,
    previousSlice: retryPreviousSlice,
    previousOverlay,
  };
}

export async function revalidateBeforeCommittingSuccess(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): Promise<CommitSavedConfigDiscoveryRefreshCtx> {
  if (
    !(await isSupersededSavedConfigRefresh(
      ctx.deps.provider,
      ctx.deps.providerRepo,
      ctx.rowId,
      ctx.persistedConfig!,
      ctx.clearsAtStart,
      ctx.credentialsAtStart,
      ctx.deps.getModelsCacheClearSequence
    ))
  ) {
    return ctx;
  }
  const currentRow = ctx.deps.providerRepo.getProvider(ctx.rowId);
  ctx.deps.restoreProviderPendingSlice(ctx.providerId, ctx.previousOverlay);
  ctx.deps.restoreProviderModelsSlice(ctx.providerId, ctx.previousSlice ?? []);
  if (currentRow && currentRow.configJson === ctx.persistedConfig!.configJson) {
    ctx.deps.providerRepo.updateProvider(ctx.rowId, { configJson: ctx.originalConfigJson });
  }
  ctx.deps.provider.clearModelCache?.();
  return { ...ctx, outcome: { success: false, reason: 'superseded' } };
}

export function markRefreshSucceededAndHealthy(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  const recoveredFailure = ctx.deps.markProviderRefreshSucceeded(ctx.providerId);
  ctx.deps.seedProviderCatalogModels(
    ctx.deps.provider,
    ctx.appliedSlice ?? ctx.normalizedDiscovered ?? ctx.discovered
  );
  ctx.deps.providerRepo.updateProvider(ctx.rowId, {
    healthStatus: 'healthy',
    lastHealthCheckAt: Date.now(),
  });
  return { ...ctx, recoveredFailure };
}

export function publishProvidersChangedWhenCoherent(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  if (!ctx.recoveredFailure) notifyProvidersChanged(ctx.deps.internalEventBus);
  return ctx;
}

export function assembleRefreshResult(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  return {
    ...ctx,
    outcome: {
      success: true,
      ...(ctx.truncated ? { truncated: true } : {}),
      models: ctx.discovered.map(({ id, name }) => ({
        id,
        ...(name === undefined ? {} : { name }),
      })),
    },
  };
}

function notifyProvidersChanged(internalEventBus: InternalEventBus<DaemonInternalEventMap>): void {
  internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
}

export const runCommitSavedConfigDiscoveryRefresh = (
  superpipe<{
    hasOutcome: (ctx: CommitSavedConfigDiscoveryRefreshCtx) => boolean;
  }>({
    hasOutcome: (ctx: CommitSavedConfigDiscoveryRefreshCtx): boolean => ctx.outcome !== undefined,
  })('commit-saved-config-discovery-refresh') as PipelineAPI
)
  .input(['ctx'])
  .pipe(revalidateSavedConfigUnderLock, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(persistLastGoodSlice, 'ctx', 'ctx')
  .pipe(applyDiscoveredSliceToLiveCache, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(revalidateBeforeCommittingSuccess, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(markRefreshSucceededAndHealthy, 'ctx', 'ctx')
  .pipe(publishProvidersChangedWhenCoherent, 'ctx', 'ctx')
  .pipe(assembleRefreshResult, 'ctx', 'ctx')
  .endAsync('ctx') as unknown as (
  ctx: CommitSavedConfigDiscoveryRefreshCtx
) => Promise<CommitSavedConfigDiscoveryRefreshCtx>;
