import { afterEach, describe, expect, it } from 'bun:test';
import {
  disableBuiltInProvidersWithoutEnabledRecord,
  initializeProviders,
  registerBuiltInProvider,
  resetProviderFactory,
} from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { syncProviderToRegistry } from '../../../../src/lib/providers/provider-sync';

afterEach(() => {
  resetProviderFactory();
  resetProviderRegistry();
});

describe('removed session provider', () => {
  it('does not register a removed provider when restoring its stored record', async () => {
    resetProviderFactory();
    resetProviderRegistry();
    disableBuiltInProvidersWithoutEnabledRecord([]);
    initializeProviders();
    await syncProviderToRegistry({
      id: 'old-provider',
      providerId: 'acp',
      displayName: 'Old provider',
      kind: 'built_in',
      authType: 'none',
      isEnabled: true,
      isDefault: false,
      sortOrder: 0,
      healthStatus: 'unknown',
      createdAt: 0,
      updatedAt: 0,
    });
    const registry = getProviderRegistry();
    expect(registry.has('acp')).toBe(false);
    expect(await registry.validateProviderSwitch('acp')).toEqual({
      valid: false,
      error: 'Unknown provider: acp',
    });
    await registerBuiltInProvider(registry, 'acp');
    expect(registry.has('acp')).toBe(false);
  });
});
