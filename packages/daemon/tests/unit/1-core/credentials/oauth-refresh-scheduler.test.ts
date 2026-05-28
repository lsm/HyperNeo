import { describe, expect, it } from 'bun:test';
import type { Provider } from '@neokai/shared/provider';
import { ProviderRegistry } from '../../../../src/lib/providers/registry';
import { OAuthRefreshScheduler } from '../../../../src/lib/credentials/oauth-refresh-scheduler';

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
      return refreshResult;
    },
    getCredentials: () => ({
      type: 'oauth',
      accessToken: 'new-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
    }),
  };
}

describe('OAuthRefreshScheduler', () => {
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
    expect(manager.health.get('oauth-provider')).toBe('healthy');
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
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 2,
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
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
    const scheduler = new OAuthRefreshScheduler(manager as never, {
      registry,
      now: () => 0,
      refreshWindowMs: 10_000,
      maxRetries: 1,
    });

    await scheduler.tick();

    expect(manager.health.get('oauth-provider')).toBe('unhealthy');
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
});
