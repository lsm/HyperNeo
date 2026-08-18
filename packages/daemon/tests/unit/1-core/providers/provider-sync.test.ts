import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resetProviderRegistry, getProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { removeProviderFromRegistry } from '../../../../src/lib/providers/provider-sync';
import type { Provider } from '@hyperneo/shared/provider';

function createMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'test-provider',
    displayName: 'Test Provider',
    isAvailable: mock(async () => true),
    getAuthStatus: mock(async () => ({ isAuthenticated: true })),
    logout: mock(async () => {}),
    shutdown: mock(async () => {}),
    ...overrides,
  } as Provider;
}

describe('removeProviderFromRegistry', () => {
  beforeEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });
  afterEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });

  it('calls logout before shutdown before unregister', async () => {
    const registry = getProviderRegistry();
    const provider = createMockProvider({ id: 'test-provider' });
    registry.register(provider);

    const callOrder: string[] = [];
    provider.logout = mock(async () => {
      callOrder.push('logout');
    });
    provider.shutdown = mock(async () => {
      callOrder.push('shutdown');
    });

    await removeProviderFromRegistry('test-provider');

    expect(callOrder).toEqual(['logout', 'shutdown']);
    expect(registry.has('test-provider')).toBe(false);
  });

  it('skips logout when provider has no logout method', async () => {
    const registry = getProviderRegistry();
    const provider = createMockProvider({
      id: 'test-provider',
      logout: undefined,
    });
    registry.register(provider);

    await removeProviderFromRegistry('test-provider');

    expect(provider.shutdown).toHaveBeenCalled();
    expect(registry.has('test-provider')).toBe(false);
  });

  it('is a no-op when provider is not in registry', async () => {
    const registry = getProviderRegistry();
    expect(registry.has('missing')).toBe(false);

    await removeProviderFromRegistry('missing');
  });

  it('continues shutdown and unregister even when logout throws', async () => {
    const registry = getProviderRegistry();
    const provider = createMockProvider({ id: 'test-provider' });
    registry.register(provider);

    provider.logout = mock(async () => {
      throw new Error('logout failed');
    });

    await removeProviderFromRegistry('test-provider');

    expect(provider.shutdown).toHaveBeenCalled();
    expect(registry.has('test-provider')).toBe(false);
  });
});
