import type { Provider, ProviderCredentials } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import { getProviderRegistry, type ProviderRegistry } from '../providers/registry.js';
import { getProviderFailure } from '../providers/provider-failure-store.js';
import type { ProviderRecoveryOutcome } from '../model-service.js';
import type { ProviderCredentialManager } from './provider-credential-manager.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

type ProviderRefreshOutcome = 'refreshed' | 'exhausted';

async function defaultRefreshDiscoveredModels(outcome: ProviderRefreshOutcome): Promise<void> {
  const { clearModelsCache, refreshModels } = await import('../model-service.js');
  clearModelsCache();
  if (outcome === 'refreshed') {
    await refreshModels().catch(() => {});
  }
}

export interface OAuthRefreshSchedulerOptions {
  intervalMs?: number;
  refreshWindowMs?: number;
  maxRetries?: number;
  registry?: ProviderRegistry;
  now?: () => number;
  onProviderChanged?: (providerId: string, outcome: ProviderRefreshOutcome) => void | Promise<void>;
  recoverDormantProvider?: (providerId: string) => Promise<ProviderRecoveryOutcome>;
  onPreRecoveryInvalidate?: (providerId: string) => Promise<void> | void;
  refreshDiscoveredModels?: (outcome: ProviderRefreshOutcome) => void | Promise<void>;
}

interface PendingInvalidation {
  retries: number;
  credentialKey: string;
}

interface ScheduledTokenRefreshDeps {
  credentialManager: ProviderCredentialManager;
  maxRetries: number;
  refreshWindowMs: number;
  now: () => number;
  retryCounts: Map<string, number>;
  pendingInvalidations: Map<string, PendingInvalidation>;
  onPreRecoveryInvalidate?: (providerId: string) => Promise<void> | void;
  recoverDormantProvider?: (providerId: string) => Promise<ProviderRecoveryOutcome>;
  onProviderChanged?: (providerId: string, outcome: ProviderRefreshOutcome) => void | Promise<void>;
  refreshDiscoveredModels: (outcome: ProviderRefreshOutcome) => void | Promise<void>;
}

interface ScheduledTokenRefreshCtx {
  deps: ScheduledTokenRefreshDeps;
  provider: Provider;
  credentials: ProviderCredentials | null;
  retryKey: string;
  nextCredentials?: ProviderCredentials | null;
  refreshed: boolean;
  persistenceFailed: boolean;
  outcome?:
    | 'deferred-completed'
    | 'deferred-failed'
    | 'skipped'
    | 'rotation-failed'
    | 'persistence-failed'
    | 'invalidation-failed'
    | 'refreshed';
}

function credentialRetryKey(providerId: string, credentials: ProviderCredentials): string {
  if (credentials.type !== 'oauth') return providerId;
  return `${providerId}:${credentials.refreshToken ?? credentials.accessToken ?? ''}:${credentials.expiresAt ?? ''}`;
}

async function resolveCurrentCredentials(
  ctx: ScheduledTokenRefreshCtx
): Promise<ScheduledTokenRefreshCtx> {
  const stored = await ctx.deps.credentialManager.getCredentials(ctx.provider.id);
  if (stored) return { ...ctx, credentials: stored };
  if (!ctx.provider.getCredentials) return ctx;
  return { ...ctx, credentials: await ctx.provider.getCredentials() };
}

async function providerCredentialIdentity(
  ctx: ScheduledTokenRefreshCtx
): Promise<ProviderCredentials | null> {
  if (!ctx.provider.getCredentials) return ctx.credentials;
  try {
    return (await ctx.provider.getCredentials()) ?? ctx.credentials;
  } catch {
    return ctx.credentials;
  }
}

async function resumeDeferredInvalidation(
  ctx: ScheduledTokenRefreshCtx
): Promise<ScheduledTokenRefreshCtx> {
  const { deps, provider } = ctx;
  const entry = deps.pendingInvalidations.get(provider.id);
  if (!entry) return ctx;
  const identity = await providerCredentialIdentity(ctx);
  if (!identity || credentialRetryKey(provider.id, identity) !== entry.credentialKey) {
    deps.pendingInvalidations.delete(provider.id);
    return ctx;
  }
  if (!(await runPreRecoveryInvalidation(deps, provider.id))) {
    markUnhealthyWhenFailureRecorded(deps, provider.id);
    await recordPendingInvalidationFailure(deps, provider.id, entry.credentialKey);
    return { ...ctx, outcome: 'deferred-failed' };
  }
  const stillOwned = await providerCredentialIdentity(ctx);
  if (
    !stillOwned ||
    stillOwned.type !== 'oauth' ||
    credentialRetryKey(provider.id, stillOwned) !== entry.credentialKey
  ) {
    deps.pendingInvalidations.delete(provider.id);
    return { ...ctx, outcome: 'deferred-failed' };
  }
  if (!(await persistDeferredTokens(provider, deps))) {
    markUnhealthyWhenFailureRecorded(deps, provider.id);
    await recordPendingInvalidationFailure(deps, provider.id, entry.credentialKey);
    return { ...ctx, outcome: 'deferred-failed' };
  }
  deps.pendingInvalidations.delete(provider.id);
  deps.credentialManager.markProviderHealth(provider.id, 'healthy');
  await recoverDormant(deps, provider.id);
  await emitProviderChanged(deps, provider.id, 'refreshed');
  return { ...ctx, outcome: 'deferred-completed' };
}

async function gateRefreshDue(ctx: ScheduledTokenRefreshCtx): Promise<ScheduledTokenRefreshCtx> {
  const { credentials, deps, provider } = ctx;
  if (!credentials || credentials.type !== 'oauth') return { ...ctx, outcome: 'skipped' };
  const expiresAt = credentials.expiresAt;
  if (typeof expiresAt !== 'number') return { ...ctx, outcome: 'skipped' };
  if (expiresAt - deps.now() > deps.refreshWindowMs) return { ...ctx, outcome: 'skipped' };
  const retryKey = credentialRetryKey(provider.id, credentials);
  if ((deps.retryCounts.get(retryKey) ?? 0) >= deps.maxRetries) {
    const owned = await providerCredentialIdentity(ctx);
    if (!owned || credentialRetryKey(provider.id, owned) === retryKey) {
      return { ...ctx, outcome: 'skipped' };
    }
  }
  return { ...ctx, retryKey };
}

async function rotateToken(ctx: ScheduledTokenRefreshCtx): Promise<ScheduledTokenRefreshCtx> {
  let refreshed = false;
  try {
    refreshed = await ctx.provider.refreshToken!();
  } catch {
    refreshed = false;
  }
  return { ...ctx, refreshed };
}

async function failExhaustedRotation(
  ctx: ScheduledTokenRefreshCtx
): Promise<ScheduledTokenRefreshCtx> {
  if (ctx.refreshed) return ctx;
  await recordFailedRefresh(ctx.deps, ctx.provider.id, ctx.retryKey);
  return { ...ctx, outcome: 'rotation-failed' };
}

async function invalidateBeforePersist(
  ctx: ScheduledTokenRefreshCtx
): Promise<ScheduledTokenRefreshCtx> {
  const { deps, provider } = ctx;
  let nextCredentials: ProviderCredentials | null = null;
  if (provider.getCredentials) {
    try {
      nextCredentials = (await provider.getCredentials()) ?? null;
    } catch {
      nextCredentials = null;
    }
  }
  if (!(await runPreRecoveryInvalidation(deps, provider.id))) {
    markUnhealthyWhenFailureRecorded(deps, provider.id);
    await recordPendingInvalidationFailure(
      deps,
      provider.id,
      credentialRetryKey(provider.id, nextCredentials ?? ctx.credentials!)
    );
    return { ...ctx, nextCredentials, outcome: 'invalidation-failed' };
  }
  return { ...ctx, nextCredentials };
}

async function persistRotatedTokens(
  ctx: ScheduledTokenRefreshCtx
): Promise<ScheduledTokenRefreshCtx> {
  let nextCredentials = ctx.nextCredentials;
  if (nextCredentials === null || nextCredentials === undefined) {
    if (!ctx.provider.getCredentials) nextCredentials = ctx.credentials;
    else nextCredentials = (await ctx.provider.getCredentials()) ?? ctx.credentials;
  }
  let persistenceFailed = false;
  try {
    if (nextCredentials) {
      await ctx.deps.credentialManager.storeOAuthTokens(ctx.provider.id, nextCredentials);
    }
  } catch {
    persistenceFailed = true;
  }
  return { ...ctx, nextCredentials, persistenceFailed };
}

async function failOverOnPersistenceFailure(
  ctx: ScheduledTokenRefreshCtx
): Promise<ScheduledTokenRefreshCtx> {
  if (!ctx.persistenceFailed) return ctx;
  return { ...ctx, outcome: 'persistence-failed' };
}

async function completeRefreshedRotation(
  ctx: ScheduledTokenRefreshCtx
): Promise<ScheduledTokenRefreshCtx> {
  const { deps, provider } = ctx;
  deps.retryCounts.delete(ctx.retryKey);
  deps.credentialManager.markProviderHealth(provider.id, 'healthy');
  await recoverDormant(deps, provider.id);
  await emitProviderChanged(deps, provider.id, 'refreshed');
  return { ...ctx, outcome: 'refreshed' };
}

async function runPreRecoveryInvalidation(
  deps: ScheduledTokenRefreshDeps,
  providerId: string
): Promise<boolean> {
  const onPreRecovery = deps.onPreRecoveryInvalidate;
  if (!onPreRecovery) return true;
  try {
    await onPreRecovery(providerId);
    return true;
  } catch {
    return false;
  }
}

async function persistDeferredTokens(
  provider: Provider,
  deps: ScheduledTokenRefreshDeps
): Promise<boolean> {
  if (!provider.getCredentials) return false;
  let credentials: ProviderCredentials | null;
  try {
    credentials = await provider.getCredentials();
  } catch {
    return false;
  }
  if (!credentials || credentials.type !== 'oauth') return false;
  try {
    await deps.credentialManager.storeOAuthTokens(provider.id, credentials);
    return true;
  } catch {
    return false;
  }
}

function markUnhealthyWhenFailureRecorded(
  deps: ScheduledTokenRefreshDeps,
  providerId: string
): void {
  if (!getProviderFailure(providerId)) return;
  deps.credentialManager.markProviderHealth(providerId, 'unhealthy');
}

async function recordPendingInvalidationFailure(
  deps: ScheduledTokenRefreshDeps,
  providerId: string,
  credentialKey: string
): Promise<void> {
  const retries = (deps.pendingInvalidations.get(providerId)?.retries ?? 0) + 1;
  deps.pendingInvalidations.set(providerId, { retries, credentialKey });
  if (retries === deps.maxRetries) {
    deps.credentialManager.markProviderHealth(providerId, 'unhealthy');
    await emitProviderChanged(deps, providerId, 'exhausted');
    return;
  }
  if (retries > deps.maxRetries) {
    deps.credentialManager.markProviderHealth(providerId, 'unhealthy');
  }
}

async function recordFailedRefresh(
  deps: ScheduledTokenRefreshDeps,
  providerId: string,
  retryKey: string
): Promise<void> {
  const retries = (deps.retryCounts.get(retryKey) ?? 0) + 1;
  deps.retryCounts.set(retryKey, retries);
  if (retries === deps.maxRetries) {
    deps.credentialManager.markProviderHealth(providerId, 'unhealthy');
    await emitProviderChanged(deps, providerId, 'exhausted');
    return;
  }
  if (retries > deps.maxRetries) {
    deps.credentialManager.markProviderHealth(providerId, 'unhealthy');
  }
}

async function recoverDormant(deps: ScheduledTokenRefreshDeps, providerId: string): Promise<void> {
  if (!deps.recoverDormantProvider) return;
  try {
    const outcome = await deps.recoverDormantProvider(providerId);
    if (outcome === 'failed') {
      deps.credentialManager.markProviderHealth(providerId, 'unhealthy');
    } else if (outcome === 'no-op' && getProviderFailure(providerId)) {
      deps.credentialManager.markProviderHealth(providerId, 'unhealthy');
    }
  } catch {}
}

async function emitProviderChanged(
  deps: ScheduledTokenRefreshDeps,
  providerId: string,
  outcome: ProviderRefreshOutcome
): Promise<void> {
  try {
    await deps.refreshDiscoveredModels(outcome);
  } catch {}
  await deps.onProviderChanged?.(providerId, outcome);
}

const runScheduledTokenRefresh = (
  superpipe<{
    settled: (ctx: ScheduledTokenRefreshCtx) => boolean;
  }>({
    settled: (ctx: ScheduledTokenRefreshCtx): boolean => ctx.outcome !== undefined,
  })('scheduled-oauth-token-refresh') as PipelineAPI
)
  .input(['ctx'])
  .pipe(resolveCurrentCredentials, 'ctx', 'ctx')
  .pipe(resumeDeferredInvalidation, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(gateRefreshDue, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(rotateToken, 'ctx', 'ctx')
  .pipe(failExhaustedRotation, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(invalidateBeforePersist, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(persistRotatedTokens, 'ctx', 'ctx')
  .pipe(failOverOnPersistenceFailure, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(completeRefreshedRotation, 'ctx', 'ctx')
  .endAsync('ctx') as unknown as (
  ctx: ScheduledTokenRefreshCtx
) => Promise<ScheduledTokenRefreshCtx>;

export class OAuthRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<void> | null = null;
  private readonly retryCounts = new Map<string, number>();
  private readonly pendingInvalidations = new Map<string, PendingInvalidation>();
  private readonly intervalMs: number;
  private readonly refreshWindowMs: number;
  private readonly maxRetries: number;
  private readonly registry: ProviderRegistry;
  private readonly now: () => number;
  private readonly onProviderChanged?: (
    providerId: string,
    outcome: ProviderRefreshOutcome
  ) => void | Promise<void>;
  private readonly onPreRecoveryInvalidate?: (providerId: string) => Promise<void> | void;
  private readonly refreshDiscoveredModels: (
    outcome: ProviderRefreshOutcome
  ) => void | Promise<void>;
  private readonly recoverDormantProvider?: (
    providerId: string
  ) => Promise<ProviderRecoveryOutcome>;

  constructor(
    private readonly credentialManager: ProviderCredentialManager,
    options: OAuthRefreshSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.registry = options.registry ?? getProviderRegistry();
    this.now = options.now ?? Date.now;
    this.onProviderChanged = options.onProviderChanged;
    this.onPreRecoveryInvalidate = options.onPreRecoveryInvalidate;
    this.refreshDiscoveredModels =
      options.refreshDiscoveredModels ?? defaultRefreshDiscoveredModels;
    this.recoverDormantProvider = options.recoverDormantProvider;
  }

  start(): void {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const tick = this.activeTick;
    if (tick) {
      await tick.catch(() => {});
    }
  }

  async tick(): Promise<void> {
    const prior = this.activeTick ?? Promise.resolve();
    const promise = prior.catch(() => {}).then(() => this.runTick());
    this.activeTick = promise;
    try {
      await promise;
    } finally {
      if (this.activeTick === promise) {
        this.activeTick = null;
      }
    }
  }

  private async runTick(): Promise<void> {
    await Promise.all(
      this.registry.getAll().map((provider) => this.refreshProviderIfNeeded(provider))
    );
  }

  private async refreshProviderIfNeeded(provider: Provider): Promise<void> {
    if (!provider.refreshToken) return;
    await runScheduledTokenRefresh({
      deps: {
        credentialManager: this.credentialManager,
        maxRetries: this.maxRetries,
        refreshWindowMs: this.refreshWindowMs,
        now: this.now,
        retryCounts: this.retryCounts,
        pendingInvalidations: this.pendingInvalidations,
        onPreRecoveryInvalidate: this.onPreRecoveryInvalidate,
        recoverDormantProvider: this.recoverDormantProvider,
        onProviderChanged: this.onProviderChanged,
        refreshDiscoveredModels: this.refreshDiscoveredModels,
      },
      provider,
      credentials: null,
      retryKey: '',
      refreshed: false,
      persistenceFailed: false,
    });
  }
}
