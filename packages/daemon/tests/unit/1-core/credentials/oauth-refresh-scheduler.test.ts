import { describe, expect, it } from 'bun:test';
import type { Provider, TokenRefreshOutcome } from '@hyperneo/shared/provider';
import { ProviderRegistry } from '../../../../src/lib/providers/registry';
import {
  OAuthRefreshScheduler,
  refreshDelayMs,
} from '../../../../src/lib/credentials/oauth-refresh-scheduler';
import {
  clearProviderFailureRecords,
  recordClassifiedProviderFailure,
} from '../../../../src/lib/providers/provider-failure-store';

class FakeCredentialManager {
  credentials = new Map<string, unknown>();
  health = new Map<string, string>();
  stored: Array<{ providerId: string; credentials: unknown }> = [];

  async getCredentials(providerId: string): Promise<unknown> {
    return this.credentials.get(providerId) ?? null;
  }

  async storeOAuthTokens(providerId: string, credentials: unknown): Promise<void> {
    this.stored.push({ providerId, credentials });
    this.credentials.set(providerId, credentials);
  }

  markProviderHealth(providerId: string, health: string): void {
    this.health.set(providerId, health);
  }
}

function createProvider(refreshResult: TokenRefreshOutcome | Error): Provider {
  let credentials = {
    type: 'oauth' as const,
    accessToken: 'new-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60_000,
  };
  return {
    id: 'oauth-provider',
    displayName: 'OAuth Provider',
    capabilities: {
      streaming: true,
      extendedThinking: false,
      thinkingModes: 'off',
      maxContextWindow: 1,
      functionCalling: false,
      vision: false,
    },
    isAvailable: () => true,
    getModels: async () => [],
    ownsModel: () => false,
    getModelForTier: () => undefined,
    buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
    refreshToken: async () => {
      if (refreshResult instanceof Error) throw refreshResult;
      if (refreshResult === 'refreshed') {
        credentials = { ...credentials, accessToken: 'new-token', expiresAt: Date.now() + 60_000 };
      }
      return refreshResult;
    },
    getCredentials: () => credentials,
  };
}

describe('OAuthRefreshScheduler', () => {
  it('refreshNow waits its turn behind a running tick, then reuses that refresh', async () => {
    const manager = new FakeCredentialManager();
    const registry = new ProviderRegistry();
    let running = 0;
    let overlapped = false;
    const provider = {
      ...createProvider('refreshed'),
      refreshToken: async () => {
        running += 1;
        overlapped ||= running > 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return 'refreshed' as const;
      },
    };
    registry.register(provider);
    manager.credentials.set(provider.id, {
      type: 'oauth',
      accessToken: 'old',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1,
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, { registry });
    await Promise.all([scheduler.tick(), scheduler.refreshNow(provider.id)]);
    expect(overlapped).toBe(false);
    expect(manager.stored).toHaveLength(1);
    expect(scheduler.clock(provider.id).lastOutcome).toBe('refreshed');
  });

  it('runs an initial tick when started', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });
    try {
      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(manager.stored).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });

  it('refreshes provider-owned OAuth credentials when store has no row', async () => {
    const registry = new ProviderRegistry();
    let credentials = {
      type: 'oauth' as const,
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    };
    const provider = createProvider('refreshed');
    provider.refreshToken = async () => {
      credentials = { ...credentials, accessToken: 'new-token', expiresAt: Date.now() + 60_000 };
      return 'refreshed';
    };
    provider.getCredentials = () => credentials;
    registry.register(provider);
    const manager = new FakeCredentialManager();
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });

    await scheduler.tick();

    expect(manager.stored).toEqual([
      {
        providerId: 'oauth-provider',
        credentials: {
          type: 'oauth',
          accessToken: 'new-token',
          refreshToken: 'refresh-token',
          expiresAt: expect.any(Number),
        },
      },
    ]);
  });

  it('refreshes OAuth credentials that expire inside refresh window', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const observed: Array<{ providerId: string; stored: number; health?: string }> = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onProviderChanged: (providerId) => {
        observed.push({
          providerId,
          stored: manager.stored.length,
          health: manager.health.get(providerId),
        });
      },
    });

    await scheduler.tick();

    expect(manager.stored).toEqual([
      {
        providerId: 'oauth-provider',
        credentials: {
          type: 'oauth',
          accessToken: 'new-token',
          refreshToken: 'refresh-token',
          expiresAt: expect.any(Number),
        },
      },
    ]);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
    expect(observed).toEqual([{ providerId: 'oauth-provider', stored: 1, health: 'healthy' }]);
  });

  it('marks provider unhealthy after max refresh retries', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('definitive'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const changed: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 2,
      onProviderChanged: (providerId) => {
        changed.push(providerId);
      },
    });

    await scheduler.tick();
    expect(changed).toEqual([]);
    expect(manager.health.has('oauth-provider')).toBe(false);
    await scheduler.tick();

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    expect(changed).toEqual(['oauth-provider']);
  });

  it('counts thrown refresh attempts as failures', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(new Error('network')));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const changed: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
      onProviderChanged: (providerId) => {
        changed.push(providerId);
      },
    });

    await scheduler.tick();

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    expect(changed).toEqual(['oauth-provider']);
  });

  it('tracks retry counts per token expiry', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('definitive'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
    });

    await scheduler.tick();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'new-token',
      refreshToken: 'new-refresh-token',
      expiresAt: 2_000,
    });
    await scheduler.tick();

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('runs dormancy recovery after a successful refresh and before the change event', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const order: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      recoverDormantProvider: async (providerId) => {
        await Promise.resolve();
        order.push(`recovered:${providerId}`);
        return 'recovered';
      },
      onProviderChanged: (providerId) => {
        order.push(`changed:${providerId}`);
      },
    });

    await scheduler.tick();

    expect(order).toEqual(['recovered:oauth-provider', 'changed:oauth-provider']);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
  });

  it('marks the provider unhealthy when recovery reports a failed probe', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const changed: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      recoverDormantProvider: async () => 'failed',
      onProviderChanged: (providerId) => {
        changed.push(providerId);
      },
    });

    await scheduler.tick();

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    expect(changed).toEqual(['oauth-provider']);
  });

  it('swallows dormancy recovery failures so the refresh still completes', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const changed: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      recoverDormantProvider: async () => {
        throw new Error('recovery exploded');
      },
      onProviderChanged: (providerId) => {
        changed.push(providerId);
      },
    });

    await scheduler.tick();

    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
    expect(changed).toEqual(['oauth-provider']);
  });

  it('does not run dormancy recovery when the refresh fails', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('definitive'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const recovered: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
      recoverDormantProvider: async (providerId) => {
        recovered.push(providerId);
        return 'no-op';
      },
    });

    await scheduler.tick();

    expect(recovered).toEqual([]);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('drains an in-flight tick before stop resolves', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    let releaseRecovery: (() => void) | null = null;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      recoverDormantProvider: () =>
        new Promise((resolve) => {
          releaseRecovery = () => resolve('recovered');
        }),
    });
    scheduler.start();

    for (let i = 0; i < 50 && !releaseRecovery; i++) {
      await Promise.resolve();
    }
    expect(releaseRecovery).not.toBeNull();

    let stopResolved = false;
    const stopped = scheduler.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopResolved).toBe(false);

    releaseRecovery?.();
    await stopped;

    expect(stopResolved).toBe(true);
    expect(manager.stored).toHaveLength(1);
  });

  it('serializes overlapping ticks and drains all of them on stop', async () => {
    const registry = new ProviderRegistry();
    const credentials = {
      type: 'oauth' as const,
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    };
    const provider = createProvider('refreshed');
    provider.getCredentials = () => credentials;
    registry.register(provider);
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', credentials);
    const gates: Array<() => void> = [];
    let recoveryRuns = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      recoverDormantProvider: () =>
        new Promise((resolve) => {
          recoveryRuns++;
          gates.push(() => resolve('recovered'));
        }),
    });

    const first = scheduler.tick();
    for (let i = 0; i < 50 && recoveryRuns < 1; i++) {
      await Promise.resolve();
    }
    expect(recoveryRuns).toBe(1);

    const second = scheduler.tick();
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    expect(recoveryRuns).toBe(1);

    let stopResolved = false;
    const stopped = scheduler.stop().then(() => {
      stopResolved = true;
    });
    gates[0]?.();
    await first;
    for (let i = 0; i < 50 && recoveryRuns < 2; i++) {
      await Promise.resolve();
    }
    expect(recoveryRuns).toBe(2);
    expect(stopResolved).toBe(false);

    gates[1]?.();
    await second;
    await stopped;

    expect(stopResolved).toBe(true);
  });

  it('stop waits for a failing tick without propagating its rejection', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    manager.storeOAuthTokens = async () => {
      throw new Error('credential store failed');
    };
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });

    await expect(scheduler.tick()).rejects.toThrow('credential store failed');

    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('retains unhealthy on a no-op recovery when a failure is still recorded', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    recordClassifiedProviderFailure('oauth-provider', {
      errorKind: 'transient',
      message: 'Endpoint returned HTTP 503',
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      recoverDormantProvider: async () => 'no-op',
    });
    try {
      await scheduler.tick();

      expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    } finally {
      clearProviderFailureRecords();
    }
  });
  it('refreshes a pasted credential with no expiry once a credential failure is recorded', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'pasted-token',
      refreshToken: 'refresh-token',
    });
    recordClassifiedProviderFailure('oauth-provider', {
      errorKind: 'credential',
      message: 'OAuth access token has been revoked',
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });
    try {
      await scheduler.tick();

      expect(manager.stored).toHaveLength(1);
      expect(manager.health.get('oauth-provider')).toBe('healthy');
    } finally {
      clearProviderFailureRecords();
    }
  });

  it('leaves a pasted credential alone while no failure is recorded', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'pasted-token',
      refreshToken: 'refresh-token',
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });

    await scheduler.tick();

    expect(manager.stored).toEqual([]);
  });

  it('does not refresh a pasted credential on a transient failure', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('refreshed'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'pasted-token',
      refreshToken: 'refresh-token',
    });
    recordClassifiedProviderFailure('oauth-provider', {
      errorKind: 'transient',
      message: 'Endpoint returned HTTP 503',
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });
    try {
      await scheduler.tick();

      expect(manager.stored).toEqual([]);
    } finally {
      clearProviderFailureRecords();
    }
  });

  it('stops retrying a revoked pasted credential after maxRetries', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('definitive'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'pasted-token',
      refreshToken: 'refresh-token',
    });
    recordClassifiedProviderFailure('oauth-provider', {
      errorKind: 'credential',
      message: 'OAuth access token has been revoked',
    });
    let attempts = 0;
    const provider = registry.getAll()[0];
    provider.refreshToken = async () => {
      attempts++;
      return 'definitive';
    };
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 2,
    });
    try {
      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();

      expect(attempts).toBe(2);
      expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    } finally {
      clearProviderFailureRecords();
    }
  });

  describe('refreshNow outcomes', () => {
    function expiredOauthCredentials() {
      return {
        type: 'oauth' as const,
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        expiresAt: 1_000,
      };
    }

    function expiredScheduler(provider: Provider) {
      const registry = new ProviderRegistry();
      registry.register(provider);
      const manager = new FakeCredentialManager();
      manager.credentials.set('oauth-provider', expiredOauthCredentials());
      return new OAuthRefreshScheduler(manager as never, {
        registry,
        now: () => 0,
        refreshWindowMs: 10_000,
      });
    }

    it('returns refreshed after a successful refresh', async () => {
      const scheduler = expiredScheduler(createProvider('refreshed'));
      expect(await scheduler.refreshNow('oauth-provider')).toBe('refreshed');
    });

    it('returns transient when the provider reports a transient failure', async () => {
      const scheduler = expiredScheduler(createProvider('transient'));
      expect(await scheduler.refreshNow('oauth-provider')).toBe('transient');
    });

    it('returns transient when the provider throws', async () => {
      const scheduler = expiredScheduler(createProvider(new Error('network down')));
      expect(await scheduler.refreshNow('oauth-provider')).toBe('transient');
    });

    it('returns definitive when the provider reports a definitive failure', async () => {
      const scheduler = expiredScheduler(createProvider('definitive'));
      expect(await scheduler.refreshNow('oauth-provider')).toBe('definitive');
    });

    it('returns skipped for an unknown provider', async () => {
      const scheduler = expiredScheduler(createProvider('refreshed'));
      expect(await scheduler.refreshNow('missing-provider')).toBe('skipped');
    });

    it('returns skipped when stored credentials are not OAuth', async () => {
      const provider = createProvider('refreshed');
      const registry = new ProviderRegistry();
      registry.register(provider);
      const manager = new FakeCredentialManager();
      manager.credentials.set('oauth-provider', { type: 'api_key', apiKey: 'sk' });
      const scheduler = new OAuthRefreshScheduler(manager as never, {
        registry,
        now: () => 0,
      });
      expect(await scheduler.refreshNow('oauth-provider')).toBe('skipped');
    });

    it('returns skipped when OAuth credentials have no refresh token', async () => {
      const provider = createProvider('refreshed');
      const registry = new ProviderRegistry();
      registry.register(provider);
      const manager = new FakeCredentialManager();
      manager.credentials.set('oauth-provider', {
        type: 'oauth',
        accessToken: 'access-only',
        expiresAt: 1_000,
      });
      const scheduler = new OAuthRefreshScheduler(manager as never, {
        registry,
        now: () => 0,
      });
      expect(await scheduler.refreshNow('oauth-provider')).toBe('skipped');
    });

    it('still calls the provider and counts failures for access-only credentials on tick', async () => {
      const provider = createProvider('transient');
      let attempts = 0;
      provider.refreshToken = async () => {
        attempts++;
        return 'transient';
      };
      const registry = new ProviderRegistry();
      registry.register(provider);
      const manager = new FakeCredentialManager();
      manager.credentials.set('oauth-provider', {
        type: 'oauth',
        accessToken: 'access-only',
        expiresAt: 1_000,
      });
      const changed: string[] = [];
      const scheduler = new OAuthRefreshScheduler(manager as never, {
        registry,
        now: () => 0,
        refreshWindowMs: 10_000,
        maxRetries: 1,
        onProviderChanged: (providerId) => {
          changed.push(providerId);
        },
      });

      await scheduler.tick();

      expect(attempts).toBe(1);
      expect(manager.health.get('oauth-provider')).toBe('unhealthy');
      expect(changed).toEqual(['oauth-provider']);
    });
  });
});

describe('refresh clock', () => {
  it('doubles the wait after each transient outcome, capped at an hour', () => {
    expect(refreshDelayMs(1)).toBe(5 * 60_000);
    expect(refreshDelayMs(2)).toBe(10 * 60_000);
    expect(refreshDelayMs(3)).toBe(20 * 60_000);
    expect(refreshDelayMs(4)).toBe(40 * 60_000);
    expect(refreshDelayMs(5)).toBe(60 * 60_000);
    expect(refreshDelayMs(20)).toBe(60 * 60_000);
  });

  it('records the wait and attempt per provider after a transient failure', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('transient'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    let now = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => now,
      refreshWindowMs: 10_000,
    });

    expect(await scheduler.refreshNow('oauth-provider')).toBe('transient');
    expect(scheduler.clock('oauth-provider')).toEqual({
      nextRefreshAt: 5 * 60_000,
      attempt: 1,
      lastOutcome: 'transient',
    });

    now += 5 * 60_000;
    expect(await scheduler.refreshNow('oauth-provider')).toBe('transient');
    expect(scheduler.clock('oauth-provider')).toMatchObject({
      nextRefreshAt: now + 10 * 60_000,
      attempt: 2,
    });
  });

  it('keeps the last outcome while the clock has not come round', async () => {
    const registry = new ProviderRegistry();
    let refreshes = 0;
    const provider = createProvider('transient');
    provider.refreshToken = async () => {
      refreshes += 1;
      return 'transient';
    };
    registry.register(provider);
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });

    await scheduler.refreshNow('oauth-provider');
    await scheduler.refreshNow('oauth-provider');

    expect(refreshes).toBe(1);
  });

  it('refreshes on a 401 even when no expiry is known and no failure was recorded', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider('refreshed');
    provider.getCredentials = () => ({
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
    });
    registry.register(provider);
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });

    expect(await scheduler.refreshNow('oauth-provider')).toBe('refreshed');
  });

  it('a credential write resets the provider refresh clock', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('transient'));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });

    await scheduler.refreshNow('oauth-provider');
    scheduler.resetClock('oauth-provider');

    expect(scheduler.clock('oauth-provider')).toEqual({
      nextRefreshAt: 0,
      attempt: 0,
      lastOutcome: 'none',
    });
  });
});
