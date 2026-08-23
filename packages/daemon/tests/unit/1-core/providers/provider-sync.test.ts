import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resetProviderRegistry, getProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import {
  parseProviderConfig,
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

describe('provider config sync', () => {
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
      parseProviderConfig(
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

  it('keeps an explicitly empty models list distinct from absent models', () => {
    expect(parseProviderConfig(JSON.stringify({ command: 'devin acp', models: [] }))).toEqual({
      command: 'devin acp',
      models: [],
    });
    expect(parseProviderConfig(JSON.stringify({ command: 'devin acp' }))).toEqual({
      command: 'devin acp',
    });
    expect(parseProviderConfig(JSON.stringify({ command: 'devin acp', models: null }))).toEqual({
      command: 'devin acp',
    });
    expect(parseProviderConfig(undefined)).toEqual({});
  });

  it('treats a nonempty models array with no valid entries as absent', () => {
    expect(parseProviderConfig(JSON.stringify({ models: [null] }))).toEqual({});
    expect(parseProviderConfig(JSON.stringify({ models: [{ name: 'missing id' }] }))).toEqual({});
  });

  it('falls back to empty configuration for malformed JSON', () => {
    expect(parseProviderConfig('{invalid')).toEqual({});
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

  it('applies an empty models curation as no visible models', async () => {
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
      configJson: JSON.stringify({ command: 'devin acp', models: [] }),
      healthStatus: 'unknown',
      createdAt: 1,
      updatedAt: 1,
    } satisfies ProviderRecord;

    await syncProviderToRegistry(record);

    expect(provider.getCachedModels()).toEqual([]);
  });

  it('applies parsed model curation to any provider exposing setCuratedModels', async () => {
    const setCuratedModels = mock(() => {});
    const provider = createMockProvider({ id: 'glm', setCuratedModels });
    getProviderRegistry().register(provider);
    const recordFor = (configJson: string | undefined) =>
      ({
        id: 'glm-record',
        providerId: 'glm',
        displayName: 'Z.ai',
        kind: 'built_in',
        authType: 'api_key',
        isEnabled: true,
        isDefault: false,
        sortOrder: 0,
        configJson,
        healthStatus: 'unknown',
        createdAt: 1,
        updatedAt: 1,
      }) satisfies ProviderRecord;

    await syncProviderToRegistry(recordFor(JSON.stringify({ models: [{ id: 'glm-5' }] })));
    expect(setCuratedModels).toHaveBeenCalledTimes(1);
    expect(setCuratedModels).toHaveBeenCalledWith([{ id: 'glm-5' }]);

    await syncProviderToRegistry(recordFor(JSON.stringify({ models: [] })));
    expect(setCuratedModels).toHaveBeenCalledWith([]);

    await syncProviderToRegistry(recordFor(undefined));
    expect(setCuratedModels).toHaveBeenCalledWith(undefined);
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
