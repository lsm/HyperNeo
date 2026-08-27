import { describe, expect, it } from 'bun:test';
import type { Provider } from '@hyperneo/shared/provider';
import { ProviderRegistry } from '../../../../src/lib/providers/registry';
import { OAuthRefreshScheduler } from '../../../../src/lib/credentials/oauth-refresh-scheduler';
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

function createProvider(refreshResult: boolean | Error): Provider {
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
      if (refreshResult) {
        credentials = { ...credentials, accessToken: 'new-token', expiresAt: Date.now() + 60_000 };
      }
      return refreshResult;
    },
    getCredentials: () => credentials,
  };
}

describe('OAuthRefreshScheduler', () => {
  it('runs an initial tick when started', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
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
    const provider = createProvider(true);
    provider.refreshToken = async () => {
      credentials = { ...credentials, accessToken: 'new-token', expiresAt: Date.now() + 60_000 };
      return true;
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
    registry.register(createProvider(true));
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
    registry.register(createProvider(false));
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
    registry.register(createProvider(false));
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
    registry.register(createProvider(true));
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
    registry.register(createProvider(true));
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
    registry.register(createProvider(true));
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
    registry.register(createProvider(false));
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
    registry.register(createProvider(true));
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
    const provider = createProvider(true);
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

  it('completes the tick and stop drains it when token persistence fails', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    let storeAttempts = 0;
    manager.storeOAuthTokens = async () => {
      storeAttempts += 1;
      throw new Error('credential store failed');
    };
    let invalidated = false;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onProviderChanged: () => {
        invalidated = true;
      },
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(storeAttempts).toBeGreaterThanOrEqual(1);
    expect(invalidated).toBe(false);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('skips dormancy recovery when the pre-recovery invalidation fails', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const events: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onPreRecoveryInvalidate: async () => {
        events.push('invalidated');
        throw new Error('durable strip failed');
      },
      recoverDormantProvider: async (providerId) => {
        events.push(`recovered:${providerId}`);
        return 'recovered';
      },
      onProviderChanged: (providerId) => {
        events.push(`changed:${providerId}`);
      },
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(events).toEqual(['invalidated']);
    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
  });

  it('marks the provider exhausted when pre-recovery invalidation keeps failing', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const events: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
      onPreRecoveryInvalidate: async () => {
        throw new Error('durable strip failed');
      },
      recoverDormantProvider: async () => {
        events.push('recovered');
        return 'recovered';
      },
      onProviderChanged: (providerId, outcome) => {
        events.push(`changed:${providerId}:${outcome}`);
      },
    });

    await scheduler.tick();

    expect(events).toEqual(['changed:oauth-provider:exhausted']);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('still completes the failed-persistence cycle when the pre-recovery hook rejects', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
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
    const events: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
      onPreRecoveryInvalidate: async () => {
        throw new Error('durable strip failed');
      },
      recoverDormantProvider: async () => {
        events.push('recovered');
        return 'recovered';
      },
      onProviderChanged: (providerId, outcome) => {
        events.push(`changed:${providerId}:${outcome}`);
      },
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(events).toEqual(['changed:oauth-provider:exhausted']);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('retries a failed pre-recovery invalidation on later ticks against the stored credential', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const events: string[] = [];
    let invalidationAttempts = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onPreRecoveryInvalidate: async () => {
        invalidationAttempts += 1;
        if (invalidationAttempts === 1) throw new Error('durable strip failed');
      },
      recoverDormantProvider: async (providerId) => {
        events.push(`recovered:${providerId}`);
        return 'recovered';
      },
      onProviderChanged: (providerId, outcome) => {
        events.push(`changed:${providerId}:${outcome}`);
      },
    });

    await scheduler.tick();

    expect(invalidationAttempts).toBe(1);
    expect(events).toEqual([]);
    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
    const rotated = manager.stored[0].credentials as { expiresAt: number };
    expect(rotated.expiresAt).toBeGreaterThan(10_000);

    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(events).toEqual([]);
    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
  });

  it('stops retrying invalidation after exhausting attempts and marks the provider unhealthy', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const events: string[] = [];
    let invalidationAttempts = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 2,
      onPreRecoveryInvalidate: async () => {
        invalidationAttempts += 1;
        throw new Error('durable strip failed');
      },
      recoverDormantProvider: async (providerId) => {
        events.push(`recovered:${providerId}`);
        return 'recovered';
      },
      onProviderChanged: (providerId, outcome) => {
        events.push(`changed:${providerId}:${outcome}`);
      },
    });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(events).toEqual(['changed:oauth-provider:exhausted']);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('retains unhealthy on a no-op recovery when a failure is still recorded', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
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
});
