import type { Provider, ProviderCredentials } from '@hyperneo/shared/provider';
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
    refreshModels().catch(() => {});
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

export class OAuthRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<void> | null = null;
  private readonly retryCounts = new Map<string, number>();
  private readonly pendingInvalidationRetries = new Map<string, number>();
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
    if (await this.retryPendingInvalidation(provider)) return;
    const credentials = await this.credentialsForProvider(provider);
    if (!credentials || credentials.type !== 'oauth') return;

    const expiresAt = credentials.expiresAt;
    if (typeof expiresAt !== 'number') return;
    if (expiresAt - this.now() > this.refreshWindowMs) return;

    const retryKey = this.retryKey(provider.id, credentials);
    if ((this.retryCounts.get(retryKey) ?? 0) >= this.maxRetries) return;

    let refreshed = false;
    try {
      refreshed = await provider.refreshToken();
    } catch {
      refreshed = false;
    }

    if (refreshed) {
      const nextCredentials = await this.credentialsFromProvider(provider, credentials);
      let persistenceFailed = false;
      try {
        if (nextCredentials) {
          await this.credentialManager.storeOAuthTokens(provider.id, nextCredentials);
        }
      } catch {
        persistenceFailed = true;
      }
      if (persistenceFailed) {
        if (!(await this.runPreRecoveryInvalidation(provider.id))) {
          await this.recordPendingInvalidationFailure(provider.id);
        }
        return;
      }
      this.retryCounts.delete(retryKey);
      if (!(await this.runPreRecoveryInvalidation(provider.id))) {
        this.markUnhealthyWhenFailureRecorded(provider.id);
        await this.recordPendingInvalidationFailure(provider.id);
        return;
      }
      this.credentialManager.markProviderHealth(provider.id, 'healthy');
      await this.recoverDormant(provider.id);
      await this.emitProviderChanged(provider.id, 'refreshed');
      return;
    }

    await this.recordFailedRefresh(provider.id, retryKey);
  }

  private async retryPendingInvalidation(provider: Provider): Promise<boolean> {
    if (!this.pendingInvalidationRetries.has(provider.id)) return false;
    if (!(await this.runPreRecoveryInvalidation(provider.id))) {
      await this.retryPendingTokenPersistence(provider);
      this.markUnhealthyWhenFailureRecorded(provider.id);
      await this.recordPendingInvalidationFailure(provider.id);
      return true;
    }
    this.credentialManager.markProviderHealth(provider.id, 'healthy');
    await this.recoverDormant(provider.id);
    await this.emitProviderChanged(provider.id, 'refreshed');
    return true;
  }

  private async retryPendingTokenPersistence(provider: Provider): Promise<void> {
    if (!provider.getCredentials) return;
    let credentials: ProviderCredentials | null;
    try {
      credentials = await provider.getCredentials();
    } catch {
      return;
    }
    if (!credentials || credentials.type !== 'oauth') return;
    try {
      await this.credentialManager.storeOAuthTokens(provider.id, credentials);
    } catch {}
  }

  private markUnhealthyWhenFailureRecorded(providerId: string): void {
    if (!getProviderFailure(providerId)) return;
    this.credentialManager.markProviderHealth(providerId, 'unhealthy');
  }

  private async runPreRecoveryInvalidation(providerId: string): Promise<boolean> {
    const onPreRecovery = this.onPreRecoveryInvalidate;
    if (!onPreRecovery) return true;
    try {
      await onPreRecovery(providerId);
      this.pendingInvalidationRetries.delete(providerId);
      return true;
    } catch {
      return false;
    }
  }

  private bumpPendingInvalidationRetries(providerId: string): number {
    const retries = (this.pendingInvalidationRetries.get(providerId) ?? 0) + 1;
    this.pendingInvalidationRetries.set(providerId, retries);
    return retries;
  }

  private async recordPendingInvalidationFailure(providerId: string): Promise<void> {
    const retries = this.bumpPendingInvalidationRetries(providerId);
    if (retries > this.maxRetries) return;
    if (retries === this.maxRetries) {
      this.credentialManager.markProviderHealth(providerId, 'unhealthy');
      await this.emitProviderChanged(providerId, 'exhausted');
    }
  }

  private async recordFailedRefresh(providerId: string, retryKey: string): Promise<void> {
    const retries = (this.retryCounts.get(retryKey) ?? 0) + 1;
    this.retryCounts.set(retryKey, retries);
    if (retries >= this.maxRetries) {
      this.credentialManager.markProviderHealth(providerId, 'unhealthy');
      await this.emitProviderChanged(providerId, 'exhausted');
    }
  }

  private async emitProviderChanged(
    providerId: string,
    outcome: ProviderRefreshOutcome
  ): Promise<void> {
    try {
      await this.refreshDiscoveredModels(outcome);
    } catch {}
    await this.onProviderChanged?.(providerId, outcome);
  }

  private async recoverDormant(providerId: string): Promise<void> {
    if (!this.recoverDormantProvider) return;
    try {
      const outcome = await this.recoverDormantProvider(providerId);
      if (outcome === 'failed') {
        this.credentialManager.markProviderHealth(providerId, 'unhealthy');
      } else if (outcome === 'no-op' && getProviderFailure(providerId)) {
        this.credentialManager.markProviderHealth(providerId, 'unhealthy');
      }
    } catch {}
  }

  private async credentialsForProvider(provider: Provider): Promise<ProviderCredentials | null> {
    const stored = await this.credentialManager.getCredentials(provider.id);
    if (stored) return stored;
    if (!provider.getCredentials) return null;
    return await provider.getCredentials();
  }

  private async credentialsFromProvider(
    provider: Provider,
    fallback: ProviderCredentials
  ): Promise<ProviderCredentials> {
    if (!provider.getCredentials) return fallback;
    return (await provider.getCredentials()) ?? fallback;
  }

  private retryKey(providerId: string, credentials: ProviderCredentials): string {
    if (credentials.type !== 'oauth') return providerId;
    return `${providerId}:${credentials.refreshToken ?? credentials.accessToken ?? ''}:${credentials.expiresAt ?? ''}`;
  }
}
