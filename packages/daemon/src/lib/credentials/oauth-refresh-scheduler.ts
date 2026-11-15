import type {
  Provider,
  ProviderCredentials,
  TokenRefreshOutcome,
  TokenRefreshResult,
} from '@hyperneo/shared/provider';
import { Logger } from '../logger.js';
import { getProviderRegistry, type ProviderRegistry } from '../providers/registry.js';
import { clearProviderFailure, getProviderFailure } from '../providers/provider-failure-store.js';
import type { ProviderRecoveryOutcome } from '../model-service.js';
import type { ProviderCredentialManager } from './provider-credential-manager.js';
import { decideRefreshDue } from './refresh-due-gate.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

export type RefreshNowOutcome = TokenRefreshOutcome | 'skipped';

export const REFRESH_DELAY_FIRST_MS = 5 * 60 * 1000;
export const REFRESH_DELAY_MAX_MS = 60 * 60 * 1000;

export interface ProviderRefreshClock {
  nextRefreshAt: number;
  attempt: number;
  lastOutcome: RefreshNowOutcome | 'none';
}

export function refreshDelayMs(attempt: number): number {
  const doublings = Math.max(0, attempt - 1);
  return Math.min(REFRESH_DELAY_FIRST_MS * 2 ** doublings, REFRESH_DELAY_MAX_MS);
}

export function backgroundRefreshAllowed(clock: ProviderRefreshClock, now: number): boolean {
  if (clock.lastOutcome === 'definitive') return false;
  return clock.lastOutcome !== 'transient' || now >= clock.nextRefreshAt;
}

const logger = new Logger('OAuthRefreshScheduler');

const idleClock = (): ProviderRefreshClock => ({
  nextRefreshAt: 0,
  attempt: 0,
  lastOutcome: 'none',
});

export interface OAuthRefreshSchedulerOptions {
  intervalMs?: number;
  refreshWindowMs?: number;
  maxRetries?: number;
  registry?: ProviderRegistry;
  now?: () => number;
  onProviderChanged?: (providerId: string) => void;
  recoverDormantProvider?: (providerId: string) => Promise<ProviderRecoveryOutcome>;
  setNeedsLogin?: (providerId: string, at: number) => void;
}

export class OAuthRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<unknown> | null = null;
  private readonly clocks = new Map<string, ProviderRefreshClock>();
  private readonly intervalMs: number;
  private readonly refreshWindowMs: number;
  private readonly maxRetries: number;
  private readonly registry: ProviderRegistry;
  private readonly now: () => number;
  private readonly onProviderChanged?: (providerId: string) => void;
  private readonly recoverDormantProvider?: (
    providerId: string
  ) => Promise<ProviderRecoveryOutcome>;
  private readonly setNeedsLogin?: (providerId: string, at: number) => void;

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
    this.recoverDormantProvider = options.recoverDormantProvider;
    this.setNeedsLogin = options.setNeedsLogin;
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

  tick(): Promise<void> {
    return this.inTurn(() => this.runTick());
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.activeTick ?? Promise.resolve();
    const tracked = prior.catch(() => {}).then(work);
    this.activeTick = tracked;
    return tracked.finally(() => {
      if (this.activeTick === tracked) {
        this.activeTick = null;
      }
    });
  }

  clock(providerId: string): ProviderRefreshClock {
    return this.clocks.get(providerId) ?? idleClock();
  }

  resetClock(providerId: string): void {
    this.clocks.delete(providerId);
  }

  refreshNow(providerId: string): Promise<RefreshNowOutcome> {
    const provider = this.registry.get(providerId);
    if (!provider) return Promise.resolve('skipped');
    return this.inTurn(async () => {
      const clock = this.clock(providerId);
      if (this.now() < clock.nextRefreshAt && clock.lastOutcome !== 'none')
        return clock.lastOutcome;
      return await this.refreshProviderIfNeeded(provider, true);
    });
  }

  private async runTick(): Promise<void> {
    await Promise.all(
      this.registry.getAll().map((provider) => this.refreshProviderIfNeeded(provider))
    );
  }

  private async refreshProviderIfNeeded(
    provider: Provider,
    force = false
  ): Promise<RefreshNowOutcome> {
    if (!provider.refreshToken) return 'skipped';
    const credentials = await this.credentialsForProvider(provider);
    if (!credentials || credentials.type !== 'oauth') return 'skipped';
    if (force && !credentials.refreshToken) return 'skipped';

    const due = decideRefreshDue({
      expiresAt: credentials.expiresAt,
      now: this.now(),
      refreshWindowMs: force ? Number.POSITIVE_INFINITY : this.refreshWindowMs,
      failureKind: getProviderFailure(provider.id)?.errorKind,
    });
    if ('reason' in due && !force) return 'skipped';

    const clock = this.clock(provider.id);
    if (!force && !backgroundRefreshAllowed(clock, this.now())) return 'skipped';

    let result: TokenRefreshResult;
    try {
      result = await provider.refreshToken();
    } catch {
      result = 'transient';
    }
    const outcome: TokenRefreshOutcome = typeof result === 'string' ? result : result.outcome;

    if (outcome === 'refreshed') {
      if ('value' in due && due.value === 'credential_failure') clearProviderFailure(provider.id);
      const nextCredentials = await this.credentialsFromProvider(provider, credentials);
      if (nextCredentials) {
        await this.credentialManager.storeOAuthTokens(provider.id, nextCredentials);
      }
      this.clocks.set(provider.id, {
        nextRefreshAt: this.now() + REFRESH_DELAY_FIRST_MS,
        attempt: 0,
        lastOutcome: 'refreshed',
      });
      this.credentialManager.markProviderHealth(provider.id, 'healthy');
      await this.recoverDormant(provider.id);
      this.onProviderChanged?.(provider.id);
      return 'refreshed';
    }

    const attempt = clock.attempt + 1;
    this.clocks.set(provider.id, {
      nextRefreshAt: this.now() + refreshDelayMs(attempt),
      attempt,
      lastOutcome: outcome,
    });
    const oauthError = typeof result === 'string' ? 'none' : result.oauthError;
    logger.warn(
      `OAuth refresh failed for ${provider.id}: outcome=${outcome} oauthError=${oauthError} attempt=${attempt}`
    );
    if (outcome === 'definitive') {
      this.setNeedsLogin?.(provider.id, this.now());
      this.credentialManager.markProviderHealth(provider.id, 'unhealthy');
      this.onProviderChanged?.(provider.id);
    } else if (attempt >= this.maxRetries) {
      this.credentialManager.markProviderHealth(provider.id, 'unhealthy');
      this.onProviderChanged?.(provider.id);
    }
    return outcome;
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
}
