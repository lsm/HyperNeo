/**
 * Model Service — Provider-Routing Unit Tests
 *
 * Focused tests for:
 * - getModelInfo disambiguation when multiple providers share a model ID
 * - resolveModelAlias with explicit providerId
 * - Global cache populated from all available providers via initializeModels
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import type { ModelInfo } from '@neokai/shared';
import type { Provider, ProviderCapabilities, ProviderSdkConfig } from '@neokai/shared/provider';
import {
  getModelInfo,
  resolveModelAlias,
  isValidModel,
  clearModelsCache,
  setModelsCache,
  getAvailableModels,
  initializeModels,
} from '../../../src/lib/model-service';
import { getProviderRegistry, resetProviderRegistry } from '../../../src/lib/providers/registry';
import { initializeProviders, resetProviderFactory } from '../../../src/lib/providers/factory';

// ---------------------------------------------------------------------------
// Minimal provider stub — implements the full Provider interface structurally
// ---------------------------------------------------------------------------
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

// Shared model IDs that appear in more than one provider
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
    family: 'gpt',
    provider: 'anthropic-codex',
    contextWindow: 200000,
    available: true,
  },
];

// All models from all three providers in one flat list (simulates populated cache)
const allModels: ModelInfo[] = [...anthropicModels, ...copilotModels, ...codexModels];

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

  // -------------------------------------------------------------------------
  // getModelInfo with providerId disambiguation
  // -------------------------------------------------------------------------
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

    it('returns null when providerId is anthropic but model only exists in anthropic-codex', async () => {
      const model = await getModelInfo('gpt-5.3-codex', 'global', 'anthropic');
      expect(model).toBeNull();
    });

    it('returns null for an entirely unknown model regardless of provider', async () => {
      const model = await getModelInfo('no-such-model-xyz', 'global', 'anthropic');
      expect(model).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveModelAlias with providerId
  // -------------------------------------------------------------------------
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

    it('returns alias as-is when no matching model found for the specified provider', async () => {
      // codex alias does not exist in the anthropic provider
      const resolved = await resolveModelAlias('codex', 'global', 'anthropic');
      expect(resolved).toBe('codex');
    });

    it('resolves legacy model ID scoped to anthropic', async () => {
      // Add a sonnet entry for anthropic so legacy mapping resolves correctly
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

      // LEGACY_MODEL_MAPPINGS: 'claude-sonnet-4-5-20250929' → 'sonnet'
      const resolved = await resolveModelAlias('claude-sonnet-4-5-20250929', 'global', 'anthropic');
      expect(resolved).toBe('sonnet');
    });

    it('returns legacy model ID as-is when provider has no matching target', async () => {
      // anthropic-codex has no 'sonnet' model — legacy mapping finds no match
      const resolved = await resolveModelAlias(
        'claude-sonnet-4-5-20250929',
        'global',
        'anthropic-codex'
      );
      // Falls back to the original input since there's no 'sonnet' in codex
      expect(resolved).toBe('claude-sonnet-4-5-20250929');
    });
  });

  // -------------------------------------------------------------------------
  // isValidModel with providerId
  // -------------------------------------------------------------------------
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

    it('rejects unknown model for any provider', async () => {
      expect(await isValidModel('nonexistent-model', 'global', 'anthropic')).toBe(false);
      expect(await isValidModel('nonexistent-model', 'global', 'anthropic-copilot')).toBe(false);
      expect(await isValidModel('nonexistent-model', 'global', 'anthropic-codex')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Global cache populated from all available providers via initializeModels
  // -------------------------------------------------------------------------
  // Strategy: call initializeProviders() first so the 5 built-in providers are
  // registered and initialized=true. Then add stub providers. When initializeModels()
  // runs it calls initializeProviders() again, but because initialized=true and
  // registry.size > 0, it returns early without touching the registry.
  // All 5 real providers are unavailable in the test environment (no credentials),
  // so only stub models make it into the cache — giving us deterministic assertions.
  // -------------------------------------------------------------------------
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
      // Register real providers first (all unavailable); then add stubs.
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

      // Both provider entries must survive the merge — no last-writer-wins
      expect(entriesForSharedId.length).toBeGreaterThanOrEqual(2);
      const providers = entriesForSharedId.map((m) => m.provider);
      expect(providers).toContain(STUB_A);
      expect(providers).toContain(STUB_B);
    });

    it('skips unavailable providers when populating cache', async () => {
      initializeProviders();
      const registry = getProviderRegistry();
      registry.register(makeStubProvider(STUB_A, stubModelsA, true));
      registry.register(makeStubProvider(STUB_B, stubModelsB, false)); // unavailable

      await initializeModels();

      // STUB_B was unavailable — its models must not appear
      const entryB = await getModelInfo(STUB_SHARED_ID, 'global', STUB_B);
      expect(entryB).toBeNull();

      // But STUB_A models are still present
      const entryA = await getModelInfo(STUB_SHARED_ID, 'global', STUB_A);
      expect(entryA).not.toBeNull();
    });

    it('uses fallback models when all stub providers are unavailable', async () => {
      initializeProviders();
      const registry = getProviderRegistry();
      registry.register(makeStubProvider(STUB_A, stubModelsA, false));
      registry.register(makeStubProvider(STUB_B, stubModelsB, false));

      await initializeModels();

      // FALLBACK_MODELS always include 'sonnet' for 'anthropic'
      const fallback = await getModelInfo('sonnet', 'global', 'anthropic');
      expect(fallback).not.toBeNull();
    });
  });
});
