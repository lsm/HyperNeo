import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resetProviderRegistry, getProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import {
  parseAcpConfig,
  removeProviderFromRegistry,
  syncProviderToRegistry,
} from '../../../../src/lib/providers/provider-sync';
import { AcpProvider } from '../../../../src/lib/providers/acp-provider';
import type { ProviderRecord } from '@hyperneo/shared';
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

describe('ACP provider sync', () => {
  beforeEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });

  afterEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });

  it('parses valid command and model configuration', () => {
    expect(
      parseAcpConfig(
        JSON.stringify({
          command: 'devin acp',
          models: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b', name: 42 },
            null,
            { name: 'missing id' },
          ],
        })
      )
    ).toEqual({
      command: 'devin acp',
      models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b' }],
    });
  });

  it('falls back to empty configuration for malformed JSON', () => {
    expect(parseAcpConfig('{invalid')).toEqual({});
  });

  it('applies persisted ACP command and models to the registered provider', async () => {
    const provider = new AcpProvider({}, async () => {});
    getProviderRegistry().register(provider);
    const record = {
      id: 'acp-record',
      providerId: 'acp',
      displayName: 'ACP Agent',
      kind: 'built_in',
      authType: 'none',
      isEnabled: true,
      isDefault: false,
      sortOrder: 0,
      configJson: JSON.stringify({ command: 'devin acp', models: [{ id: 'model-a' }] }),
      healthStatus: 'unknown',
      createdAt: 1,
      updatedAt: 1,
    } satisfies ProviderRecord;

    await syncProviderToRegistry(record);

    expect(provider.getAcpCommand()).toBe('devin acp');
    expect(provider.getCachedModels()?.map((model) => model.id)).toEqual(['model-a']);
  });
});

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

  it('skips logout but still shuts down and unregisters when preserveCredentials is set', async () => {
    const registry = getProviderRegistry();
    const provider = createMockProvider({ id: 'test-provider' });
    registry.register(provider);

    await removeProviderFromRegistry('test-provider', { preserveCredentials: true });

    expect(provider.logout).not.toHaveBeenCalled();
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
