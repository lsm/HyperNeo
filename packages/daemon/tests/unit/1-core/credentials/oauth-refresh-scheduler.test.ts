import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Provider } from '@hyperneo/shared/provider';
import { ProviderRegistry } from '../../../../src/lib/providers/registry';
import { OAuthRefreshScheduler } from '../../../../src/lib/credentials/oauth-refresh-scheduler';
import {
  clearProviderFailureRecords,
  recordClassifiedProviderFailure,
} from '../../../../src/lib/providers/provider-failure-store';

const clearModelsCache = mock(() => {});
const refreshModels = mock(async () => {});

let originalModelService: typeof import('../../../../src/lib/model-service') | undefined;
if (typeof Bun !== 'undefined') {
  originalModelService = require('../../../../src/lib/model-service');
}
mock.module('../../../../src/lib/model-service', () => ({
  clearModelsCache,
  refreshModels,
}));

afterAll(() => {
  if (originalModelService) {
    mock.module('../../../../src/lib/model-service', () => originalModelService);
  }
});

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

function createProvider(refreshResult: boolean | Error, id = 'oauth-provider'): Provider {
  let credentials = {
    type: 'oauth' as const,
    accessToken: 'new-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60_000,
  };
  return {
    id,
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
  beforeEach(() => {
    clearModelsCache.mockClear();
    refreshModels.mockClear();
    refreshModels.mockImplementation(async () => {});
  });

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
    expect(manager.stored).toHaveLength(0);
    expect(manager.health.has('oauth-provider')).toBe(false);
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
    expect(manager.stored).toHaveLength(0);
    expect(manager.health.has('oauth-provider')).toBe(false);

    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(events).toEqual(['recovered:oauth-provider', 'changed:oauth-provider:refreshed']);
    expect(manager.stored).toHaveLength(1);
    const rotated = manager.stored[0].credentials as { expiresAt: number };
    expect(rotated.expiresAt).toBeGreaterThan(10_000);
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

    expect(invalidationAttempts).toBe(3);
    expect(events).toEqual(['changed:oauth-provider:exhausted']);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('keeps retrying the durable strip across ticks until both strip and persistence land', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const originalStore = manager.storeOAuthTokens.bind(manager);
    let storeFails = true;
    manager.storeOAuthTokens = async (providerId: string, credentials: unknown) => {
      if (storeFails) throw new Error('credential store failed');
      await originalStore(providerId, credentials);
    };
    const events: string[] = [];
    let invalidationAttempts = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
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
    expect(events).toEqual(['changed:oauth-provider:exhausted']);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    expect(manager.stored).toHaveLength(0);

    storeFails = false;
    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(events).toEqual([
      'changed:oauth-provider:exhausted',
      'recovered:oauth-provider',
      'changed:oauth-provider:refreshed',
    ]);
    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
  });

  it('keeps retrying persistence after repeated store failures without exhausting the rotation budget', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const originalStore = manager.storeOAuthTokens.bind(manager);
    let storeFails = true;
    manager.storeOAuthTokens = async (providerId: string, credentials: unknown) => {
      if (storeFails) throw new Error('credential store failed');
      await originalStore(providerId, credentials);
    };
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(manager.stored).toHaveLength(0);
    expect(manager.health.has('oauth-provider')).toBe(false);

    storeFails = false;
    await scheduler.tick();

    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
  });

  it('does not rotate again in the tick that completes a deferred invalidation', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    let refreshCalls = 0;
    const baseRefresh = provider.refreshToken!;
    provider.refreshToken = async () => {
      const result = await baseRefresh();
      refreshCalls += 1;
      return result;
    };
    registry.register(provider);
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const originalStore = manager.storeOAuthTokens.bind(manager);
    let storeFails = true;
    manager.storeOAuthTokens = async (providerId: string, credentials: unknown) => {
      if (storeFails) throw new Error('credential store failed');
      await originalStore(providerId, credentials);
    };
    let invalidationAttempts = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onPreRecoveryInvalidate: async () => {
        invalidationAttempts += 1;
        if (invalidationAttempts === 1) throw new Error('durable strip failed');
      },
      recoverDormantProvider: async () => 'recovered',
      onProviderChanged: () => {},
    });

    await scheduler.tick();
    expect(refreshCalls).toBe(1);
    expect(invalidationAttempts).toBe(1);
    expect(manager.stored).toHaveLength(0);

    storeFails = false;
    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
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

  it('marks the provider unhealthy when persistence and invalidation both fail with a recorded failure', async () => {
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
    recordClassifiedProviderFailure('oauth-provider', {
      errorKind: 'transient',
      message: 'Endpoint returned HTTP 503',
    });
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onPreRecoveryInvalidate: async () => {
        throw new Error('durable strip failed');
      },
    });
    try {
      await scheduler.tick();

      expect(manager.stored).toHaveLength(0);
      expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    } finally {
      clearProviderFailureRecords();
    }
  });

  it('retries token persistence on pending-invalidation ticks after the store heals', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const originalStore = manager.storeOAuthTokens.bind(manager);
    let storeFails = true;
    manager.storeOAuthTokens = async (providerId: string, credentials: unknown) => {
      if (storeFails) throw new Error('credential store failed');
      await originalStore(providerId, credentials);
    };
    let invalidationAttempts = 0;
    let stripFails = true;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onPreRecoveryInvalidate: async () => {
        invalidationAttempts += 1;
        if (stripFails) throw new Error('durable strip failed');
      },
    });

    await scheduler.tick();
    expect(manager.stored).toHaveLength(0);
    expect(invalidationAttempts).toBe(1);

    storeFails = false;
    stripFails = false;
    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(manager.stored).toHaveLength(1);
    const persisted = manager.stored[0].credentials as { accessToken: string };
    expect(persisted.accessToken).toBe('new-token');
  });

  it('marks the provider unhealthy when a recorded-failure rotation is not persisted because the strip failed', async () => {
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
      onPreRecoveryInvalidate: async () => {
        throw new Error('durable strip failed');
      },
    });
    try {
      await scheduler.tick();

      expect(manager.stored).toHaveLength(0);
      expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    } finally {
      clearProviderFailureRecords();
    }
  });

  it('keeps an exhausted provider unhealthy when deferred persistence succeeds past the cap', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const originalStore = manager.storeOAuthTokens.bind(manager);
    manager.storeOAuthTokens = async (providerId: string, credentials: unknown) => {
      await originalStore(providerId, credentials);
      manager.markProviderHealth(providerId, 'healthy');
    };
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 2,
      onPreRecoveryInvalidate: async () => {
        throw new Error('durable strip failed');
      },
    });

    await scheduler.tick();
    await scheduler.tick();
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');

    await scheduler.tick();

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('discards the deferred invalidation when the provider logs out', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    let refreshCalls = 0;
    const baseRefresh = provider.refreshToken!;
    provider.refreshToken = async () => {
      const result = await baseRefresh();
      refreshCalls += 1;
      return result;
    };
    registry.register(provider);
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
    let invalidationAttempts = 0;
    const events: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
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
    expect(invalidationAttempts).toBe(1);
    expect(refreshCalls).toBe(1);

    manager.credentials.delete('oauth-provider');
    provider.getCredentials = () => null;
    await scheduler.tick();

    expect(invalidationAttempts).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(events).toEqual([]);
    expect(manager.health.has('oauth-provider')).toBe(false);
  });

  it('discards the deferred invalidation when credentials are replaced and refreshes the new identity', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    let refreshCalls = 0;
    const baseRefresh = provider.refreshToken!;
    provider.refreshToken = async () => {
      const result = await baseRefresh();
      refreshCalls += 1;
      return result;
    };
    registry.register(provider);
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
    let invalidationAttempts = 0;
    let stripFails = true;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onPreRecoveryInvalidate: async () => {
        invalidationAttempts += 1;
        if (stripFails) throw new Error('durable strip failed');
      },
    });

    await scheduler.tick();
    expect(invalidationAttempts).toBe(1);
    expect(refreshCalls).toBe(1);

    stripFails = false;
    provider.getCredentials = () => ({
      type: 'oauth',
      accessToken: 'replacement-token',
      refreshToken: 'replacement-refresh-token',
      expiresAt: 1_000,
    });
    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(refreshCalls).toBe(2);
    expect(manager.stored).toHaveLength(0);
  });

  it('persists the recovered token after rotation failures exhaust the stale stored key budget', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    const baseRefresh = provider.refreshToken!;
    let rotateSucceeds = true;
    provider.refreshToken = async () => {
      if (!rotateSucceeds) return false;
      return await baseRefresh();
    };
    registry.register(provider);
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const originalStore = manager.storeOAuthTokens.bind(manager);
    let storeFails = true;
    manager.storeOAuthTokens = async (providerId: string, credentials: unknown) => {
      if (storeFails) throw new Error('credential store failed');
      await originalStore(providerId, credentials);
    };
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 2,
    });

    await scheduler.tick();
    storeFails = false;
    rotateSucceeds = false;
    await scheduler.tick();
    await scheduler.tick();
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    expect(manager.stored).toHaveLength(0);

    rotateSucceeds = true;
    await scheduler.tick();

    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
  });

  it('emits exhaustion only once when stale-key rotation failures exceed the cap', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    const baseRefresh = provider.refreshToken!;
    let rotateSucceeds = true;
    provider.refreshToken = async () => {
      if (!rotateSucceeds) return false;
      return await baseRefresh();
    };
    registry.register(provider);
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
    const exhausted: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 2,
      onProviderChanged: (providerId, outcome) => {
        if (outcome === 'exhausted') exhausted.push(providerId);
      },
    });

    await scheduler.tick();
    rotateSucceeds = false;
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(exhausted).toEqual(['oauth-provider']);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('preserves the invalidation retry count when persistence fails after a successful strip', async () => {
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
    const exhausted: string[] = [];
    let invalidationAttempts = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
      onPreRecoveryInvalidate: async () => {
        invalidationAttempts += 1;
        if (invalidationAttempts === 1) throw new Error('durable strip failed');
      },
      onProviderChanged: (providerId, outcome) => {
        if (outcome === 'exhausted') exhausted.push(providerId);
      },
    });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(invalidationAttempts).toBe(3);
    expect(exhausted).toEqual(['oauth-provider']);
    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
  });

  it('cancels deferred recovery when credentials vanish during the awaited strip', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    let refreshCalls = 0;
    const baseRefresh = provider.refreshToken!;
    provider.refreshToken = async () => {
      const result = await baseRefresh();
      refreshCalls += 1;
      return result;
    };
    registry.register(provider);
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    const originalStore = manager.storeOAuthTokens.bind(manager);
    let storeFails = true;
    manager.storeOAuthTokens = async (providerId: string, credentials: unknown) => {
      if (storeFails) throw new Error('credential store failed');
      await originalStore(providerId, credentials);
    };
    const events: string[] = [];
    let invalidationAttempts = 0;
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onPreRecoveryInvalidate: async () => {
        invalidationAttempts += 1;
        if (invalidationAttempts === 1) throw new Error('durable strip failed');
        manager.credentials.delete('oauth-provider');
        provider.getCredentials = () => null;
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

    storeFails = false;
    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(manager.stored).toHaveLength(0);
    expect(events).toEqual([]);
    expect(manager.health.has('oauth-provider')).toBe(false);

    await scheduler.tick();
    expect(events).toEqual([]);
  });

  it('cancels persistence when credentials vanish during the post-rotation strip', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    registry.register(provider);
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
        manager.credentials.delete('oauth-provider');
        provider.getCredentials = () => null;
      },
      recoverDormantProvider: async (providerId) => {
        events.push(`recovered:${providerId}`);
        return 'recovered';
      },
      onProviderChanged: (providerId, outcome) => {
        events.push(`changed:${providerId}:${outcome}`);
      },
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(manager.stored).toHaveLength(0);
    expect(events).toEqual([]);
    expect(manager.health.has('oauth-provider')).toBe(false);
  });

  it('completes rotation for a provider without getCredentials using the stored identity', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    delete (provider as { getCredentials?: unknown }).getCredentials;
    registry.register(provider);
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
      onProviderChanged: (providerId, outcome) => {
        changed.push(`${providerId}:${outcome}`);
      },
    });

    await scheduler.tick();

    expect(manager.stored).toHaveLength(1);
    expect(manager.stored[0].credentials).toEqual({
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    expect(manager.health.get('oauth-provider')).toBe('healthy');
    expect(changed).toEqual(['oauth-provider:refreshed']);
  });

  it('clears the discovery cache when token persistence is deferred', async () => {
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
    const changed: string[] = [];
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      onProviderChanged: (providerId, outcome) => {
        changed.push(`${providerId}:${outcome}`);
      },
    });

    await scheduler.tick();

    expect(clearModelsCache).toHaveBeenCalledTimes(1);
    expect(refreshModels).not.toHaveBeenCalled();
    expect(changed).toEqual([]);
  });

  it('retains the deferred invalidation when the credential read is unreadable', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    registry.register(provider);
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
    let invalidationAttempts = 0;
    let readsFail = false;
    const originalGetCredentials = provider.getCredentials!.bind(provider);
    provider.getCredentials = async () => {
      if (readsFail) throw new Error('keychain unreadable');
      return await originalGetCredentials();
    };
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
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
    expect(invalidationAttempts).toBe(1);

    readsFail = true;
    await scheduler.tick();

    expect(invalidationAttempts).toBe(1);
    expect(events).toEqual([]);
    expect(manager.health.has('oauth-provider')).toBe(false);

    readsFail = false;
    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(events).toEqual([]);
  });

  it('completes deferred recovery for a provider without getCredentials using the stored identity', async () => {
    const registry = new ProviderRegistry();
    const provider = createProvider(true);
    delete (provider as { getCredentials?: unknown }).getCredentials;
    registry.register(provider);
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
    expect(manager.stored).toHaveLength(0);

    await scheduler.tick();

    expect(invalidationAttempts).toBe(2);
    expect(events).toEqual(['recovered:oauth-provider', 'changed:oauth-provider:refreshed']);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
  });

  it('serializes the exhausted clear behind an in-flight successful discovery refresh', async () => {
    const registry = new ProviderRegistry();
    const providerA = createProvider(true, 'oauth-provider-a');
    const providerB = createProvider(false, 'oauth-provider-b');
    registry.register(providerA);
    registry.register(providerB);
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider-a', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    manager.credentials.set('oauth-provider-b', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    let releaseDiscovery: (() => void) | null = null;
    refreshModels.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDiscovery = () => resolve();
        })
    );
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
    });

    const tickPromise = scheduler.tick();
    for (let i = 0; i < 50 && !releaseDiscovery; i++) {
      await Promise.resolve();
    }
    expect(releaseDiscovery).not.toBeNull();

    releaseDiscovery!();
    await tickPromise;

    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(manager.health.get('oauth-provider-b')).toBe('unhealthy');
    expect(manager.stored).toHaveLength(1);
  });

  it('stop drains a default discovery refresh still in flight', async () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider(true));
    const manager = new FakeCredentialManager();
    manager.credentials.set('oauth-provider', {
      type: 'oauth',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_000,
    });
    let releaseDiscovery: (() => void) | null = null;
    refreshModels.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDiscovery = () => resolve();
        })
    );
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
    });
    try {
      const ticked = scheduler.tick();
      for (let i = 0; i < 50 && !releaseDiscovery; i++) {
        await Promise.resolve();
      }
      expect(releaseDiscovery).not.toBeNull();

      let stopResolved = false;
      const stopped = scheduler.stop().then(() => {
        stopResolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopResolved).toBe(false);

      releaseDiscovery?.();
      await stopped;
      await ticked;

      expect(stopResolved).toBe(true);
      expect(manager.stored).toHaveLength(1);
    } finally {
      refreshModels.mockRestore();
    }
  });

  it('refreshes discovered models on rotation before notifying providers', async () => {
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
      refreshDiscoveredModels: (outcome) => {
        events.push(`discovery:${outcome}`);
      },
      onProviderChanged: (providerId, outcome) => {
        events.push(`changed:${providerId}:${outcome}`);
      },
    });

    await scheduler.tick();

    expect(events).toEqual(['discovery:refreshed', 'changed:oauth-provider:refreshed']);
  });

  it('completes the rotation when the discovery refresh itself throws', async () => {
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
      refreshDiscoveredModels: async () => {
        throw new Error('discovery refresh exploded');
      },
      onProviderChanged: (providerId, outcome) => {
        changed.push(`${providerId}:${outcome}`);
      },
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(manager.stored).toHaveLength(1);
    expect(manager.health.get('oauth-provider')).toBe('healthy');
    expect(changed).toEqual(['oauth-provider:refreshed']);
  });

  it('runs the default discovery refresh through model-service on rotation', async () => {
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

    await scheduler.tick();

    expect(clearModelsCache).toHaveBeenCalledTimes(1);
    expect(refreshModels).toHaveBeenCalledTimes(1);
  });

  it('clears the cache without re-discovering when retries exhaust the provider by default', async () => {
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

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
    expect(clearModelsCache).toHaveBeenCalledTimes(1);
    expect(refreshModels).not.toHaveBeenCalled();
  });
});
