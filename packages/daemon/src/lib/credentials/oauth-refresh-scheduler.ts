import type { Provider, ProviderCredentials } from '@neokai/shared/provider';
import { getProviderRegistry, type ProviderRegistry } from '../providers/registry.js';
import type { ProviderCredentialManager } from './provider-credential-manager.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

export interface OAuthRefreshSchedulerOptions {
  intervalMs?: number;
  refreshWindowMs?: number;
  maxRetries?: number;
  registry?: ProviderRegistry;
  now?: () => number;
}

export class OAuthRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly retryCounts = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly refreshWindowMs: number;
  private readonly maxRetries: number;
  private readonly registry: ProviderRegistry;
  private readonly now: () => number;

  constructor(
    private readonly credentialManager: ProviderCredentialManager,
    options: OAuthRefreshSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.registry = options.registry ?? getProviderRegistry();
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    for (const provider of this.registry.getAll()) {
      await this.refreshProviderIfNeeded(provider);
    }
  }

  private async refreshProviderIfNeeded(provider: Provider): Promise<void> {
    if (!provider.refreshToken) return;
    const credentials = await this.credentialManager.getCredentials(provider.id);
    if (!credentials || credentials.type !== 'oauth') return;

    const expiresAt = credentials.expiresAt;
    if (typeof expiresAt !== 'number') return;
    if (expiresAt - this.now() > this.refreshWindowMs) return;
    if ((this.retryCounts.get(provider.id) ?? 0) >= this.maxRetries) return;

    const refreshed = await provider.refreshToken();
    if (refreshed) {
      this.retryCounts.delete(provider.id);
      const nextCredentials = await this.credentialsFromProvider(provider, credentials);
      if (nextCredentials) {
        await this.credentialManager.storeOAuthTokens(provider.id, nextCredentials);
      }
      this.credentialManager.markProviderHealth(provider.id, 'healthy');
      return;
    }

    const retries = (this.retryCounts.get(provider.id) ?? 0) + 1;
    this.retryCounts.set(provider.id, retries);
    if (retries >= this.maxRetries) {
      this.credentialManager.markProviderHealth(provider.id, 'unhealthy');
    }
  }

  private async credentialsFromProvider(
    provider: Provider,
    fallback: ProviderCredentials
  ): Promise<ProviderCredentials> {
    if (!provider.getCredentials) return fallback;
    return (await provider.getCredentials()) ?? fallback;
  }
}
