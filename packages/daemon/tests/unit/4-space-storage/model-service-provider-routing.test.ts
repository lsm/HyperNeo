import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import type { Provider, ProviderCapabilities, ProviderSdkConfig } from '@hyperneo/shared/provider';
import {
  getModelInfo,
  resolveModelAlias,
  isValidModel,
  clearModelsCache,
  setModelsCache,
  getAvailableModels,
  initializeModels,
} from '../../../src/lib/model-service';
import {
  getProviderRegistry,
  resetProviderRegistry,
  inferProviderForModel,
} from '../../../src/lib/providers/registry';
import { initializeProviders, resetProviderFactory } from '../../../src/lib/providers/factory';

function makeStubProvider(id: string, models: ModelInfo[], available: boolean = true): Provider {
  const capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: false,
    maxContextWindow: 200000,
    functionCalling: true,
    vision: false,
  };
  const stub: Provider = {
    id,
    displayName: id,
    capabilities,
    isAvailable: async () => available,
    getModels: async () => models,
    ownsModel: (modelId: string) => models.some((m) => m.id === modelId),
    getModelForTier: () => undefined,
    buildSdkConfig: (): ProviderSdkConfig => ({ envVars: {}, isAnthropicCompatible: true }),
  };
  return stub;
}

const SHARED_MODEL_ID = 'claude-sonnet-4.6';

const anthropicModels: ModelInfo[] = [
  {
    id: SHARED_MODEL_ID,
    name: 'Claude Sonnet 4.6 (Anthropic)',
    alias: 'sonnet-4.6',
    family: 'sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    available: true,
  },
  {
    id: 'opus',
    name: 'Claude Opus',
    alias: 'opus',
    family: 'opus',
    provider: 'anthropic',
    contextWindow: 200000,
    available: true,
  },
];

const copilotModels: ModelInfo[] = [
  {
    id: SHARED_MODEL_ID,
    name: 'Claude Sonnet 4.6 (Copilot)',
    alias: 'sonnet-4.6',
    family: 'sonnet',
    provider: 'anthropic-copilot',
    contextWindow: 200000,
    available: true,
  },
];

const codexModels: ModelInfo[] = [
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    alias: 'codex',
    sdkModelIds: ['gpt-5.3-codex'],
    family: 'gpt',
    provider: 'anthropic-codex',
    contextWindow: 200000,
    available: true,
  },
];

const kimiModels: ModelInfo[] = [
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    alias: 'k3',
    providerAliases: ['k3', 'kimi-k3'],
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 1_048_576,
    available: true,
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    name: 'Kimi K2.7 Code Highspeed',
    alias: 'kimi-k2.7-code-highspeed',
    providerAliases: ['kimi-k2.7-code-highspeed'],
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 262_144,
    available: true,
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    alias: 'kimi',
    providerAliases: ['KIMI', 'kimi-k2.7-code'],
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 262_144,
    available: true,
  },
];

const allModels: ModelInfo[] = [
  ...anthropicModels,
  ...copilotModels,
  ...codexModels,
  ...kimiModels,
];

describe('Model Service — provider routing', () => {
  beforeEach(() => {
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
  });

  describe('getModelInfo — collision disambiguation', () => {
    beforeEach(() => {
      const cache = new Map<string, ModelInfo[]>();
      cache.set('global', allModels);
      setModelsCache(cache);
    });

    it('returns anthropic entry when providerId is anthropic', async () => {
      const model = await getModelInfo(SHARED_MODEL_ID, 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.provider).toBe('anthropic');
      expect(model?.name).toBe('Claude Sonnet 4.6 (Anthropic)');
    });

    it('returns anthropic-copilot entry when providerId is anthropic-copilot', async () => {
      const model = await getModelInfo(SHARED_MODEL_ID, 'global', 'anthropic-copilot');
      expect(model).not.toBeNull();
      expect(model?.provider).toBe('anthropic-copilot');
      expect(model?.name).toBe('Claude Sonnet 4.6 (Copilot)');
    });

    it('returns null for anthropic-copilot when requesting a model only in anthropic', async () => {
      const model = await getModelInfo('opus', 'global', 'anthropic-copilot');
      expect(model).toBeNull();
    });

    it('returns anthropic-codex entry for gpt-5.3-codex', async () => {
      const model = await getModelInfo('gpt-5.3-codex', 'global', 'anthropic-codex');
      expect(model).not.toBeNull();
      expect(model?.provider).toBe('anthropic-codex');
    });

    it('does not treat Codex SDK model IDs as provider-accepted aliases', async () => {
      const model = await getModelInfo('gpt-5.3-codex', 'global', 'anthropic-codex');
      expect(model).not.toBeNull();
    });

    it('resolves Kimi provider aliases case-insensitively to canonical metadata', async () => {
      const byUpperAlias = await getModelInfo('KIMI', 'global', 'kimi');
      const byMoonshotAlias = await getModelInfo('Moonshot-v1-32k', 'global', 'kimi');
      const byUnlistedMoonshotAlias = await getModelInfo('moonshot-v1-256k', 'global', 'kimi');

      expect(byUpperAlias?.id).toBe('kimi-for-coding');
      expect(byUpperAlias?.contextWindow).toBe(262144);
      expect(byMoonshotAlias).toBeNull();
      expect(byUnlistedMoonshotAlias).toBeNull();
    });

    it('returns null when Kimi alias is requested for a different provider', async () => {
      const model = await getModelInfo('Moonshot-v1-32k', 'global', 'anthropic-codex');
      expect(model).toBeNull();
    });

    it('returns null when providerId is anthropic but model only exists in anthropic-codex', async () => {
      const model = await getModelInfo('gpt-5.3-codex', 'global', 'anthropic');
      expect(model).toBeNull();
    });

    it('returns null for an entirely unknown model regardless of provider', async () => {
      const model = await getModelInfo('no-such-model-xyz', 'global', 'anthropic');
      expect(model).toBeNull();
    });
  });

  describe('resolveModelAlias — provider-aware', () => {
    beforeEach(() => {
      const cache = new Map<string, ModelInfo[]>();
      cache.set('global', allModels);
      setModelsCache(cache);
    });

    it('resolves alias sonnet-4.6 to model ID for anthropic', async () => {
      const resolved = await resolveModelAlias('sonnet-4.6', 'global', 'anthropic');
      expect(resolved).toBe(SHARED_MODEL_ID);
    });

    it('resolves alias sonnet-4.6 to model ID for anthropic-copilot', async () => {
      const resolved = await resolveModelAlias('sonnet-4.6', 'global', 'anthropic-copilot');
      expect(resolved).toBe(SHARED_MODEL_ID);
    });

    it('resolves codex alias to gpt-5.3-codex for anthropic-codex', async () => {
      const resolved = await resolveModelAlias('codex', 'global', 'anthropic-codex');
      expect(resolved).toBe('gpt-5.3-codex');
    });

    it('does not resolve Codex SDK-only IDs as user-selectable aliases', async () => {
      const resolved = await resolveModelAlias('claude-opus-4-7', 'global', 'anthropic-codex');
      expect(resolved).toBe('claude-opus-4-7');
    });

    it('resolves Kimi provider aliases to canonical model ID', async () => {
      expect(await resolveModelAlias('KIMI', 'global', 'kimi')).toBe('kimi-for-coding');
      expect(await resolveModelAlias('Moonshot-v1-32k', 'global', 'kimi')).toBe('Moonshot-v1-32k');
      expect(await resolveModelAlias('moonshot-v1-256k', 'global', 'kimi')).toBe(
        'moonshot-v1-256k'
      );
    });

    it('returns alias as-is when no matching model found for the specified provider', async () => {
      const resolved = await resolveModelAlias('codex', 'global', 'anthropic');
      expect(resolved).toBe('codex');
    });

    it('resolves legacy model ID scoped to anthropic', async () => {
      const modelsWithSonnet: ModelInfo[] = [
        ...allModels,
        {
          id: 'sonnet',
          name: 'Sonnet (Anthropic)',
          alias: 'sonnet',
          family: 'sonnet',
          provider: 'anthropic',
          contextWindow: 200000,
          available: true,
        },
      ];
      const cache = new Map<string, ModelInfo[]>();
      cache.set('global', modelsWithSonnet);
      setModelsCache(cache);

      const resolved = await resolveModelAlias('claude-sonnet-4-5-20250929', 'global', 'anthropic');
      expect(resolved).toBe('sonnet');
    });

    it('returns legacy model ID as-is when provider has no matching target', async () => {
      const resolved = await resolveModelAlias(
        'claude-sonnet-4-5-20250929',
        'global',
        'anthropic-codex'
      );
      expect(resolved).toBe('claude-sonnet-4-5-20250929');
    });
  });

  describe('isValidModel — provider-scoped validation', () => {
    beforeEach(() => {
      const cache = new Map<string, ModelInfo[]>();
      cache.set('global', allModels);
      setModelsCache(cache);
    });

    it('validates claude-sonnet-4.6 as valid for anthropic', async () => {
      expect(await isValidModel(SHARED_MODEL_ID, 'global', 'anthropic')).toBe(true);
    });

    it('validates claude-sonnet-4.6 as valid for anthropic-copilot', async () => {
      expect(await isValidModel(SHARED_MODEL_ID, 'global', 'anthropic-copilot')).toBe(true);
    });

    it('rejects gpt-5.3-codex as invalid for anthropic', async () => {
      expect(await isValidModel('gpt-5.3-codex', 'global', 'anthropic')).toBe(false);
    });

    it('validates gpt-5.3-codex as valid for anthropic-codex', async () => {
      expect(await isValidModel('gpt-5.3-codex', 'global', 'anthropic-codex')).toBe(true);
    });

    it('rejects Codex SDK-only IDs for anthropic-codex validation', async () => {
      expect(await isValidModel('claude-opus-4-7', 'global', 'anthropic-codex')).toBe(false);
    });

    it('validates Kimi provider aliases case-insensitively', async () => {
      expect(await isValidModel('KIMI', 'global', 'kimi')).toBe(true);
      expect(await isValidModel('Moonshot-v1-32k', 'global', 'kimi')).toBe(false);
      expect(await isValidModel('moonshot-v1-256k', 'global', 'kimi')).toBe(false);
    });

    it('validates discovered IDs only through the provider slice, never an ownsModel bypass', async () => {
      const discoveryProvider: Provider = {
        ...makeStubProvider('discovery-kimi', []),
        listRemoteModels: async () => [],
        ownsModel: (modelId: string) => modelId.startsWith('kimi-') && !modelId.includes(':'),
      };
      getProviderRegistry().register(discoveryProvider);

      expect(await isValidModel('kimi-k4', 'global', 'discovery-kimi')).toBe(false);
      expect(await isValidModel('invalid-model-id', 'global', 'anthropic')).toBe(false);

      const cache = new Map<string, ModelInfo[]>();
      cache.set('global', [
        ...allModels,
        {
          id: 'kimi-k4',
          name: 'Kimi K4',
          alias: 'kimi-k4',
          family: 'kimi',
          provider: 'discovery-kimi',
          contextWindow: 262_144,
          available: true,
        },
      ]);
      setModelsCache(cache);
      expect(await isValidModel('kimi-k4', 'global', 'discovery-kimi')).toBe(true);
    });

    it('rejects Kimi provider aliases for other providers', async () => {
      expect(await isValidModel('Moonshot-v1-32k', 'global', 'anthropic-codex')).toBe(false);
    });

    it('rejects unknown model for any provider', async () => {
      expect(await isValidModel('nonexistent-model', 'global', 'anthropic')).toBe(false);
      expect(await isValidModel('nonexistent-model', 'global', 'anthropic-copilot')).toBe(false);
      expect(await isValidModel('nonexistent-model', 'global', 'anthropic-codex')).toBe(false);
    });
  });

  describe('initializeModels — global cache contains models from all providers', () => {
    const STUB_A = 'stub-provider-alpha';
    const STUB_B = 'stub-provider-beta';
    const STUB_C = 'stub-provider-gamma';
    const STUB_SHARED_ID = 'shared-model-stub-xyz';

    const stubModelsA: ModelInfo[] = [
      {
        id: STUB_SHARED_ID,
        name: 'Shared Model (A)',
        alias: 'shared-a',
        family: 'test',
        provider: STUB_A,
        contextWindow: 100000,
        available: true,
      },
    ];

    const stubModelsB: ModelInfo[] = [
      {
        id: STUB_SHARED_ID,
        name: 'Shared Model (B)',
        alias: 'shared-b',
        family: 'test',
        provider: STUB_B,
        contextWindow: 100000,
        available: true,
      },
    ];

    const stubModelsC: ModelInfo[] = [
      {
        id: 'unique-model-stub-xyz',
        name: 'Unique Model (C)',
        alias: 'unique-c',
        family: 'test',
        provider: STUB_C,
        contextWindow: 100000,
        available: true,
      },
    ];

    it('populates cache with models from all registered stub providers', async () => {
      initializeProviders();
      const registry = getProviderRegistry();
      registry.register(makeStubProvider(STUB_A, stubModelsA, true));
      registry.register(makeStubProvider(STUB_B, stubModelsB, true));
      registry.register(makeStubProvider(STUB_C, stubModelsC, true));

      await initializeModels();

      const entryA = await getModelInfo(STUB_SHARED_ID, 'global', STUB_A);
      const entryB = await getModelInfo(STUB_SHARED_ID, 'global', STUB_B);
      const entryC = await getModelInfo('unique-model-stub-xyz', 'global', STUB_C);

      expect(entryA).not.toBeNull();
      expect(entryA?.provider).toBe(STUB_A);

      expect(entryB).not.toBeNull();
      expect(entryB?.provider).toBe(STUB_B);

      expect(entryC).not.toBeNull();
      expect(entryC?.provider).toBe(STUB_C);
    });

    it('keeps both provider entries when two providers share the same model ID', async () => {
      initializeProviders();
      const registry = getProviderRegistry();
      registry.register(makeStubProvider(STUB_A, stubModelsA, true));
      registry.register(makeStubProvider(STUB_B, stubModelsB, true));

      await initializeModels();

      const models = getAvailableModels('global');
      const entriesForSharedId = models.filter((m) => m.id === STUB_SHARED_ID);

      expect(entriesForSharedId.length).toBeGreaterThanOrEqual(2);
      const providers = entriesForSharedId.map((m) => m.provider);
      expect(providers).toContain(STUB_A);
      expect(providers).toContain(STUB_B);
    });

    it('skips unavailable providers when populating cache', async () => {
      initializeProviders();
      const registry = getProviderRegistry();
      registry.register(makeStubProvider(STUB_A, stubModelsA, true));
      registry.register(makeStubProvider(STUB_B, stubModelsB, false));

      await initializeModels();

      const entryB = await getModelInfo(STUB_SHARED_ID, 'global', STUB_B);
      expect(entryB).toBeNull();

      const entryA = await getModelInfo(STUB_SHARED_ID, 'global', STUB_A);
      expect(entryA).not.toBeNull();
    });

    it('uses fallback models when all stub providers are unavailable', async () => {
      initializeProviders();
      const registry = getProviderRegistry();
      registry.register(makeStubProvider(STUB_A, stubModelsA, false));
      registry.register(makeStubProvider(STUB_B, stubModelsB, false));

      await initializeModels();

      const fallback = await getModelInfo('sonnet', 'global', 'anthropic');
      expect(fallback).not.toBeNull();
    });
  });

  describe('inferProviderForModel — Kimi catalogue IDs', () => {
    it('routes kimi-k3 and aliases to the kimi provider', () => {
      expect(inferProviderForModel('kimi-k3')).toBe('kimi');
      expect(inferProviderForModel('k3')).toBe('kimi');
      expect(inferProviderForModel('Kimi-K3')).toBe('kimi');
      expect(inferProviderForModel('k3-256k')).toBe('kimi');
    });

    it('routes kimi-k2.7-code and highspeed variant to the kimi provider', () => {
      expect(inferProviderForModel('kimi-k2.7-code')).toBe('kimi');
      expect(inferProviderForModel('kimi-k2.7-code-highspeed')).toBe('kimi');
    });

    it('still routes legacy kimi/moonshot aliases to the kimi provider', () => {
      expect(inferProviderForModel('kimi')).toBe('kimi');
      expect(inferProviderForModel('kimi-for-coding')).toBe('kimi');
      expect(inferProviderForModel('moonshot-v1-32k')).toBe('kimi');
    });
  });
});
