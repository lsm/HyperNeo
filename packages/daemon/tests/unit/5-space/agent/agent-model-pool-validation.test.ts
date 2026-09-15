import { afterEach, describe, expect, test } from 'bun:test';
import { validateAgentModelPool } from '../../../../src/lib/agents/validation';
import { clearModelsCache, setModelsCache } from '../../../../src/lib/model-service';
import { getProviderRegistry } from '../../../../src/lib/providers/registry';
import type { ModelInfo } from '@hyperneo/shared';

const sharedModel: ModelInfo = {
  id: 'shared-model',
  name: 'Shared Model',
  alias: 'shared-model',
  family: 'shared',
  provider: 'anthropic',
  contextWindow: 200000,
  description: '',
  releaseDate: '',
  available: true,
};

afterEach(() => {
  clearModelsCache();
});

const entry = (overrides: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5',
  maxConcurrent: 1,
  weight: 1,
  ...overrides,
});

describe('validateAgentModelPool thinkingLevel', () => {
  test('accepts an entry without a thinking level', async () => {
    expect(await validateAgentModelPool([entry()])).toBeNull();
  });

  test('accepts a null thinking level', async () => {
    expect(await validateAgentModelPool([entry({ thinkingLevel: null })])).toBeNull();
  });

  test.each(['off', 'think8k', 'think16k', 'think24k', 'think32k'])('accepts %s', async (level) => {
    expect(await validateAgentModelPool([entry({ thinkingLevel: level })])).toBeNull();
  });

  test('rejects an unknown thinking level', async () => {
    const error = await validateAgentModelPool([entry({ thinkingLevel: 'think99k' })]);
    expect(error).toBe(
      'Model pool entry for "claude-opus-5" has an invalid thinkingLevel: think99k'
    );
  });

  test('rejects a non-string thinking level', async () => {
    const error = await validateAgentModelPool([entry({ thinkingLevel: 16000 })]);
    expect(error).toBe('Model pool entry for "claude-opus-5" has an invalid thinkingLevel: 16000');
  });

  test('reports the offending entry when a later entry is invalid', async () => {
    const error = await validateAgentModelPool([
      entry({ thinkingLevel: 'off' }),
      entry({ model: 'claude-sonnet-5', thinkingLevel: 'auto' }),
    ]);
    expect(error).toBe('Model pool entry for "claude-sonnet-5" has an invalid thinkingLevel: auto');
  });

  test('still enforces the pre-existing entry rules', async () => {
    expect(await validateAgentModelPool([entry({ maxConcurrent: 0 })])).toContain('maxConcurrent');
    expect(await validateAgentModelPool([entry({ weight: 0 })])).toBe(
      'Model pool must have at least one entry with weight > 0'
    );
  });
});

describe('validateAgentModelPool provider-qualified duplicates', () => {
  test('accepts the same model id on different providers', async () => {
    expect(
      await validateAgentModelPool([
        entry({ provider: 'openai' }),
        entry({ provider: 'custom:endpoint-2' }),
      ])
    ).toBeNull();
  });

  test('rejects the same model id on the same provider', async () => {
    const error = await validateAgentModelPool([
      entry({ provider: 'openai' }),
      entry({ provider: 'openai' }),
    ]);
    expect(error).toBe(
      'Model pool contains duplicate entries for "claude-opus-5" on provider "openai"'
    );
  });

  test('rejects duplicate providerless entries by model id', async () => {
    const error = await validateAgentModelPool([entry(), entry()]);
    expect(error).toBe('Model pool contains duplicate entries for "claude-opus-5"');
  });

  test('validates each entry model against its own provider', async () => {
    setModelsCache(new Map([['global', [sharedModel]]]));

    const valid = await validateAgentModelPool([
      entry({ model: 'shared-model', provider: 'anthropic' }),
    ]);
    expect(valid).toBeNull();

    const error = await validateAgentModelPool([entry({ model: 'shared-model', provider: 'glm' })]);
    expect(error).toBe('Unrecognized model "shared-model" for provider "glm"');
  });

  test('accepts a padded provider against a warm catalog the same as a cold one', async () => {
    setModelsCache(new Map([['global', [sharedModel]]]));

    expect(
      await validateAgentModelPool([entry({ model: 'shared-model', provider: ' anthropic ' })])
    ).toBeNull();
  });

  test('treats a whitespace-only provider as providerless against a warm catalog', async () => {
    setModelsCache(new Map([['global', [sharedModel]]]));

    expect(
      await validateAgentModelPool([entry({ model: 'shared-model', provider: '   ' })])
    ).toBeNull();
  });
});

describe('validateAgentModelPool cold-catalog provider validation', () => {
  const stubId = 'cold-cache-stub';
  type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

  function registerStub(): void {
    getProviderRegistry().register({
      id: stubId,
      ownsModel: (model: string) => model === 'stub-owned-model',
      getModels: async () => [],
      isAvailable: async () => true,
    } as ProviderLike);
  }

  afterEach(() => {
    getProviderRegistry().unregister(stubId);
    clearModelsCache();
  });

  test('rejects a model the registered provider does not own even when the catalog is cold', async () => {
    clearModelsCache();
    registerStub();

    const error = await validateAgentModelPool([entry({ model: 'gpt-5.4', provider: stubId })]);
    expect(error).toBe('Unrecognized model "gpt-5.4" for provider "cold-cache-stub"');
  });

  test('accepts a cold catalog when the registered provider owns the model', async () => {
    clearModelsCache();
    registerStub();

    expect(
      await validateAgentModelPool([entry({ model: 'stub-owned-model', provider: stubId })])
    ).toBeNull();
  });

  test('unregistered providers keep the cold-catalog pass-through', async () => {
    clearModelsCache();

    expect(
      await validateAgentModelPool([entry({ model: 'claude-opus-5', provider: 'not-registered' })])
    ).toBeNull();
  });
});
