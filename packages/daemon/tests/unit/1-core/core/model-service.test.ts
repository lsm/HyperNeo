import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  getAvailableModels,
  getModelInfo,
  getModelInfoUnfiltered,
  isValidModel,
  resolveModelAlias,
  resolveModelAliasUnfiltered,
  clearModelsCache,
  getModelsCache,
  setModelsCache,
  updateProviderModelsInCache,
  getSupportedModelsFromQuery,
  initializeModels,
  getSessionModelInfo,
  hasRefreshBeenAttemptedFor,
  markRefreshAttemptedFor,
} from '../../../../src/lib/model-service';
import type { ModelInfo } from '@hyperneo/shared';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import {
  getProviderFailure,
  resetProviderFailureStore,
  subscribeProviderFailureChanges,
  type ProviderFailureChange,
} from '../../../../src/lib/providers/provider-failure-store';
import { MinimaxProvider } from '../../../../src/lib/providers/minimax-provider';
import { COPILOT_ANTHROPIC_MODELS } from '../../../../src/lib/providers/anthropic-copilot/models';
import { GlmProvider } from '../../../../src/lib/providers/glm-provider';

describe('Model Service', () => {
  const mockModels: ModelInfo[] = [
    {
      id: 'sonnet',
      name: 'Sonnet 4.5',
      alias: 'sonnet',
      family: 'sonnet',
      provider: 'anthropic',
      contextWindow: 200000,
      description: 'Sonnet 4.5 · Best for everyday tasks',
      releaseDate: '2024-09-29',
      available: true,
    },
    {
      id: 'opus',
      name: 'Opus 4.5',
      alias: 'opus',
      family: 'opus',
      provider: 'anthropic',
      contextWindow: 200000,
      description: 'Opus 4.5 · Highest capability',
      releaseDate: '2025-11-24',
      available: true,
    },
    {
      id: 'haiku',
      name: 'Haiku 4.5',
      alias: 'haiku',
      family: 'haiku',
      provider: 'anthropic',
      contextWindow: 200000,
      description: 'Haiku 4.5 · Fast and efficient',
      releaseDate: '2025-10-15',
      available: true,
    },
  ];

  beforeEach(() => {
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
    resetProviderFailureStore();
  });

  afterEach(() => {
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
    resetProviderFailureStore();
  });

  describe('stranded-provider retry tracking', () => {
    it('reports and marks refresh attempts', () => {
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(false);
      markRefreshAttemptedFor(['glm', 'kimi']);
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);
      expect(hasRefreshBeenAttemptedFor('kimi')).toBe(true);
      expect(hasRefreshBeenAttemptedFor('minimax')).toBe(false);
    });

    it('clearModelsCache resets the tracking', () => {
      markRefreshAttemptedFor(['glm']);
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);
      clearModelsCache();
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(false);
    });

    it('a session-scoped clear does NOT reset the tracking', () => {
      markRefreshAttemptedFor(['glm']);
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);
      clearModelsCache('session-123');
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);
    });
  });

  describe('cache management', () => {
    it('should start with empty cache', () => {
      const cache = getModelsCache();
      expect(cache.size).toBe(0);
    });

    it('should set and restore cache', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);

      setModelsCache(testCache);

      const restoredCache = getModelsCache();
      expect(restoredCache.size).toBe(1);
      expect(restoredCache.get('global')).toEqual(mockModels);
    });

    it('should clear specific cache key', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      testCache.set('session-1', mockModels);
      setModelsCache(testCache);

      clearModelsCache('global');

      const cache = getModelsCache();
      expect(cache.has('global')).toBe(false);
      expect(cache.has('session-1')).toBe(true);
    });

    it('should clear all cache when no key specified', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      testCache.set('session-1', mockModels);
      setModelsCache(testCache);

      clearModelsCache();

      const cache = getModelsCache();
      expect(cache.size).toBe(0);
    });
  });

  describe('updateProviderModelsInCache', () => {
    const acpModels: ModelInfo[] = [
      {
        id: 'acp-default',
        name: 'ACP Default',
        alias: 'acp',
        family: 'acp',
        provider: 'acp',
        contextWindow: 200000,
        description: 'ACP-compatible agent default model',
        releaseDate: '2026-01-01',
        available: true,
      },
    ];

    function seedCache(entries: Record<string, ModelInfo[]>, timestamp?: number) {
      setModelsCache(new Map(Object.entries(entries)), timestamp);
    }

    it('replaces the provider slice while preserving other providers', () => {
      seedCache({
        global: [...mockModels, { ...acpModels[0], id: 'stale-acp-model', contextWindow: 1000 }],
      });

      const applied = updateProviderModelsInCache('acp', acpModels);

      expect(applied).toBe(true);
      const models = getAvailableModels('global');
      expect(models.filter((m) => m.provider === 'acp')).toEqual(acpModels);
      expect(models.filter((m) => m.provider === 'anthropic')).toEqual(mockModels);
    });

    it('appends the provider models when the cached entry has no slice for the provider', () => {
      seedCache({ global: mockModels });

      const applied = updateProviderModelsInCache('acp', acpModels);

      expect(applied).toBe(true);
      expect(getAvailableModels('global')).toEqual([...mockModels, ...acpModels]);
    });

    it('removes the provider slice when the replacement list is empty', () => {
      seedCache({ global: [...mockModels, ...acpModels] });

      const applied = updateProviderModelsInCache('acp', []);

      expect(applied).toBe(true);
      expect(getAvailableModels('global')).toEqual(mockModels);
    });

    it('does not create a missing cache entry', () => {
      const applied = updateProviderModelsInCache('acp', acpModels);

      expect(applied).toBe(false);
      expect(getModelsCache().size).toBe(0);
      expect(getAvailableModels('global')).toEqual([]);
    });

    it('retains a provider slice stashed while the cache is missing and merges it into the next refresh', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id: 'empty-provider',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);

      expect(updateProviderModelsInCache('acp', acpModels)).toBe(false);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global')).toEqual(acpModels);
    });

    it('replaces the rebuilt provider slice with a retained one on the next refresh', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id: 'acp',
        getModels: async () => [{ ...acpModels[0], id: 'acp-default' }],
        isAvailable: async () => true,
      } as ProviderLike);

      expect(updateProviderModelsInCache('acp', acpModels)).toBe(false);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global')).toEqual(acpModels);
    });

    it('drops retained provider slices when the cache is cleared', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id: 'empty-provider',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);

      expect(updateProviderModelsInCache('acp', acpModels)).toBe(false);
      clearModelsCache();

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global')).toEqual([]);
    });

    it('keeps a retained provider slice across repeated rebuilds until superseded', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const providerModel: ModelInfo = { ...acpModels[0], id: 'acp-from-provider' };
      getProviderRegistry().register({
        id: 'acp',
        getModels: async () => [providerModel],
        isAvailable: async () => true,
      } as ProviderLike);

      expect(updateProviderModelsInCache('acp', acpModels)).toBe(false);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();
      await refreshModels();

      expect(getAvailableModels('global')).toEqual(acpModels);

      const supersedingModels: ModelInfo[] = [{ ...acpModels[0], id: 'newer-acp-model' }];
      expect(updateProviderModelsInCache('acp', supersedingModels)).toBe(true);

      await refreshModels();

      expect(getAvailableModels('global')).toEqual(supersedingModels);
    });

    it('skips the post-refresh re-apply when the cache is cleared mid-refresh', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id: 'slow-reapply-provider',
        getModels: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return [{ ...acpModels[0], id: 'acp-default', provider: 'slow-reapply-provider' }];
        },
        isAvailable: async () => true,
      } as ProviderLike);

      seedCache({ global: mockModels });

      const { refreshModels } = await import('../../../../src/lib/model-service');
      const refreshPromise = refreshModels();

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(updateProviderModelsInCache('acp', acpModels)).toBe(true);
      clearModelsCache();

      await refreshPromise;

      expect(getModelsCache().has('global')).toBe(false);
    });

    it('leaves other cache keys untouched', () => {
      seedCache(
        {
          global: [...mockModels, ...acpModels],
          'session-123': [...mockModels, ...acpModels],
        },
        Date.now() - 60 * 60 * 1000
      );

      const applied = updateProviderModelsInCache('acp', []);

      expect(applied).toBe(true);
      expect(getAvailableModels('global')).toEqual(mockModels);
      expect(getAvailableModels('session-123')).toEqual([...mockModels, ...acpModels]);
    });

    it('supports an explicit cache key', () => {
      seedCache(
        {
          'session-123': [...mockModels, ...acpModels],
        },
        Date.now() - 60 * 60 * 1000
      );

      const applied = updateProviderModelsInCache('acp', [], 'session-123');

      expect(applied).toBe(true);
      expect(getAvailableModels('session-123')).toEqual(mockModels);
      expect(getModelsCache().has('global')).toBe(false);
    });

    it('re-applies the provider slice after an in-flight refresh rebuilds the entry', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'slow-splice-provider',
        getModels: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return [
            'slow-splice-model-1',
            'slow-splice-model-2',
            'slow-splice-model-3',
            'slow-splice-model-4',
          ].map((id) => ({
            id,
            name: 'Slow Splice Model',
            family: 'test',
            provider: 'slow-splice-provider',
            contextWindow: 100000,
            description: 'Slow splice model',
            releaseDate: '2026-01-01',
            available: true,
          }));
        },
        isAvailable: async () => true,
      } as ProviderLike);

      seedCache({ global: mockModels });

      const { refreshModels } = await import('../../../../src/lib/model-service');
      const refreshPromise = refreshModels();

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(updateProviderModelsInCache('acp', acpModels)).toBe(true);

      await refreshPromise;

      const models = getAvailableModels('global');
      expect(models.filter((m) => m.provider === 'acp')).toEqual(acpModels);
      expect(models.filter((m) => m.provider === 'slow-splice-provider').length).toBe(4);
    });

    it('keeps a stale entry stale so the next read re-triggers a background refresh', async () => {
      const getModels = mock(async () => [
        {
          id: 'fresh-model',
          name: 'Fresh Model',
          family: 'test',
          provider: 'fresh-provider',
          contextWindow: 100000,
          description: 'Fresh model',
          releaseDate: '2026-01-01',
          available: true,
        },
      ]);
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id: 'fresh-provider',
        getModels,
        isAvailable: async () => true,
      } as ProviderLike);

      seedCache({ global: mockModels }, Date.now() - 5 * 60 * 60 * 1000);

      expect(updateProviderModelsInCache('acp', acpModels)).toBe(true);

      getAvailableModels('global');

      const deadline = Date.now() + 3_000;
      let loadTriggered = false;
      while (Date.now() < deadline) {
        if (getModels.mock.calls.length > 0) {
          loadTriggered = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const registryState = getProviderRegistry()
        .getAll()
        .map((provider) => provider.id)
        .join(',');
      expect(
        loadTriggered,
        `stale entry should trigger a provider load on read; registry=[${registryState}]`
      ).toBe(true);
    });
  });

  describe('model curation', () => {
    it('filters cached and fallback models to the configured provider subset', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      getProviderRegistry().setCuratedModels('anthropic', [{ id: 'sonnet' }]);
      setModelsCache(new Map([['global', mockModels]]));

      expect(getAvailableModels('global').map((model) => model.id)).toEqual(['sonnet']);
      expect(await getModelInfo('sonnet', 'global', 'anthropic')).not.toBeNull();
      expect(await getModelInfo('opus', 'global', 'anthropic')).toBeNull();
      expect(await isValidModel('opus', 'global', 'anthropic')).toBe(false);
    });

    it('treats an empty curation as no visible models', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic',
        getModels: async () => [],
        isAvailable: async () => true,
      } as unknown as Parameters<typeof registry.register>[0]);
      registry.setCuratedModels('anthropic', []);
      setModelsCache(new Map([['global', mockModels]]));

      expect(getAvailableModels('global')).toEqual([]);
      expect(await getModelInfo('sonnet', 'global', 'anthropic')).toBeNull();
      expect(await isValidModel('sonnet', 'global', 'anthropic', 'session-key')).toBe(false);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global')).toEqual([]);
    });

    it('preserves current cache, lookup, and validation behavior when curation is absent', async () => {
      setModelsCache(new Map([['global', mockModels]]));

      expect(getAvailableModels('global')).toEqual(mockModels);
      expect(await getModelInfo('opus', 'global', 'anthropic')).toMatchObject({ id: 'opus' });
      expect(await isValidModel('opus', 'global', 'anthropic')).toBe(true);
    });

    it('filters provider-slice updates before they reach the global cache', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const visibleModel: ModelInfo = {
        id: 'acp-default',
        name: 'ACP Default',
        alias: 'acp',
        family: 'acp',
        provider: 'acp',
        contextWindow: 200000,
        description: 'ACP-compatible agent default model',
        releaseDate: '2026-01-01',
        available: true,
      };
      getProviderRegistry().setCuratedModels('acp', [{ id: visibleModel.id }]);
      setModelsCache(new Map([['global', mockModels]]));

      expect(
        updateProviderModelsInCache('acp', [
          visibleModel,
          { ...visibleModel, id: 'curated-out-acp-model' },
        ])
      ).toBe(true);

      expect(getAvailableModels('global').filter((model) => model.provider === 'acp')).toEqual([
        visibleModel,
      ]);
    });
  });

  describe('getAvailableModels', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should return empty array when cache is empty', () => {
      clearModelsCache();
      const models = getAvailableModels();
      expect(models).toEqual([]);
    });

    it('should return models from cache', () => {
      const models = getAvailableModels();
      expect(models.length).toBeGreaterThan(0);
    });

    it('should return models with correct structure', () => {
      const models = getAvailableModels();

      const sonnet = models.find((m) => m.id === 'sonnet');
      expect(sonnet).toBeDefined();
      expect(sonnet?.name).toBe('Sonnet 4.5');
      expect(sonnet?.family).toBe('sonnet');
      expect(sonnet?.provider).toBe('anthropic');
    });

    it('should support different cache keys', () => {
      const sessionModels = [mockModels[0]];
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      testCache.set('session-123', sessionModels);
      setModelsCache(testCache);

      const globalModels = getAvailableModels('global');
      const sessionSpecificModels = getAvailableModels('session-123');

      expect(globalModels.length).toBe(3);
      expect(sessionSpecificModels.length).toBe(1);
    });
  });

  describe('getModelInfo', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should find model by exact ID', async () => {
      const model = await getModelInfo('sonnet', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
    });

    it('should find model by alias', async () => {
      const model = await getModelInfo('opus', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('opus');
    });

    it('does not resolve curated-out static aliases', async () => {
      clearModelsCache();
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      getProviderRegistry().setCuratedModels('deepseek', [{ id: 'deepseek-v4-flash' }]);

      expect(await getModelInfo('deepseek-pro', 'global', 'deepseek')).toBeNull();
      expect(await getModelInfo('deepseek-flash', 'global', 'deepseek')).toMatchObject({
        id: 'deepseek-v4-flash',
      });
    });

    it('should return null for unknown model', async () => {
      const model = await getModelInfo('unknown-model', 'global', 'anthropic');
      expect(model).toBeNull();
    });

    it('should resolve Codex static metadata when provider cache is unavailable', async () => {
      clearModelsCache();

      const model = await getModelInfo('gpt-5.6-sol', 'global', 'anthropic-codex');

      expect(model).not.toBeNull();
      expect(model?.provider).toBe('anthropic-codex');
      expect(model?.contextWindow).toBe(1050000);
      expect(model?.preferContextWindowMetadata).toBe(true);
    });

    it('should resolve Codex aliases from static metadata', async () => {
      clearModelsCache();

      const model = await getModelInfo('codex-latest', 'global', 'anthropic-codex');

      expect(model).not.toBeNull();
      expect(model?.id).toBe('gpt-5.6-sol');
      expect(model?.contextWindow).toBe(1050000);
    });

    it('should overlay Codex metadata for matching Copilot OpenAI models', async () => {
      setModelsCache(
        new Map([
          [
            'global',
            [
              {
                id: 'gpt-5.5',
                name: 'GPT-5.5 (Copilot API)',
                alias: 'copilot-gpt-5-5',
                family: 'gpt',
                provider: 'anthropic-copilot',
                contextWindow: 200000,
                description: 'GPT-5.5 via GitHub Copilot',
                releaseDate: '2026-04-01',
                available: true,
              },
              {
                id: 'gpt-5.4-mini',
                name: 'GPT-5.4 Mini (Copilot API)',
                alias: 'copilot-gpt-5-4-mini',
                family: 'gpt',
                provider: 'anthropic-copilot',
                contextWindow: 200000,
                description: 'GPT-5.4 Mini via GitHub Copilot',
                releaseDate: '2026-01-01',
                available: true,
              },
              {
                id: 'gpt-5.1-codex-mini',
                name: 'GPT-5.1 Codex Mini (Copilot API)',
                alias: 'copilot-gpt-5-1-codex-mini',
                family: 'gpt',
                provider: 'anthropic-copilot',
                contextWindow: 200000,
                description: 'GPT-5.1 Codex Mini via GitHub Copilot',
                releaseDate: '2025-12-01',
                available: true,
              },
              {
                id: 'gpt-5.1-mini',
                name: 'GPT-5.1 Mini (Copilot API)',
                alias: 'copilot-gpt-5-1-mini',
                family: 'gpt',
                provider: 'anthropic-copilot',
                contextWindow: 200000,
                description: 'GPT-5.1 Mini via GitHub Copilot',
                releaseDate: '2025-12-01',
                available: true,
              },
            ],
          ],
        ])
      );

      const full = await getModelInfo('gpt-5.5', 'global', 'anthropic-copilot');
      const mini = await getModelInfo('gpt-5.4-mini', 'global', 'anthropic-copilot');
      const legacyMini = await getModelInfo('gpt-5.1-codex-mini', 'global', 'anthropic-copilot');
      const legacyAliasMini = await getModelInfo('gpt-5.1-mini', 'global', 'anthropic-copilot');

      expect(full?.contextWindow).toBe(272000);
      expect(full?.preferContextWindowMetadata).toBe(true);
      expect(mini?.id).toBe('gpt-5.4-mini');
      expect(mini?.contextWindow).toBe(128000);
      expect(mini?.preferContextWindowMetadata).toBe(true);
      expect(legacyMini?.contextWindow).toBe(128000);
      expect(legacyMini?.preferContextWindowMetadata).toBe(true);
      expect(legacyAliasMini?.contextWindow).toBe(128000);
      expect(legacyAliasMini?.preferContextWindowMetadata).toBe(true);
    });

    it('should not resolve unknown Codex models to fallback metadata', async () => {
      clearModelsCache();

      const model = await getModelInfo('gpt-unknown', 'global', 'anthropic-codex');

      expect(model).toBeNull();
    });

    it('should handle legacy model IDs', async () => {
      const model = await getModelInfo('claude-sonnet-4-5-20250929', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
    });

    it('should handle legacy opus model ID', async () => {
      const model = await getModelInfo('claude-opus-4-5-20251101', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('opus');
    });

    it('should handle legacy haiku model ID', async () => {
      const model = await getModelInfo('claude-haiku-4-5-20251001', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('haiku');
    });

    it('should return null when provider does not match (no fallback)', async () => {
      const model = await getModelInfo('sonnet', 'global', 'glm');
      expect(model).toBeNull();
    });
  });

  describe('isValidModel', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should return true for valid model ID', async () => {
      const isValid = await isValidModel('sonnet', 'global', 'anthropic');
      expect(isValid).toBe(true);
    });

    it('should return true for valid alias', async () => {
      const isValid = await isValidModel('opus', 'global', 'anthropic');
      expect(isValid).toBe(true);
    });

    it('should return false for invalid model', async () => {
      const isValid = await isValidModel('invalid-model', 'global', 'anthropic');
      expect(isValid).toBe(false);
    });

    it('should return true for legacy model IDs', async () => {
      const isValid = await isValidModel('claude-sonnet-4-5-20250929', 'global', 'anthropic');
      expect(isValid).toBe(true);
    });

    it('should not validate Codex static metadata when the provider is unavailable', async () => {
      clearModelsCache();

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic-codex',
        getModels: async () => [],
        isAvailable: async () => false,
      } as ProviderLike);

      const modelInfo = await getModelInfo('gpt-5.6-sol', 'global', 'anthropic-codex');
      expect(modelInfo?.contextWindow).toBe(1050000);
      expect(await isValidModel('gpt-5.6-sol', 'global', 'anthropic-codex')).toBe(false);
    });

    it('should validate Codex static metadata only when the provider is available', async () => {
      clearModelsCache();

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic-codex',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);

      expect(await isValidModel('gpt-5.6-sol', 'global', 'anthropic-codex')).toBe(true);
      expect(await isValidModel('gpt-unknown', 'global', 'anthropic-codex')).toBe(false);
    });

    it('validates DeepSeek static metadata with a session-scoped API key', async () => {
      clearModelsCache();

      expect(await isValidModel('deepseek-pro', 'global', 'deepseek')).toBe(false);
      expect(await isValidModel('deepseek-pro', 'global', 'deepseek', 'session-key')).toBe(true);
      expect(await isValidModel('unknown-deepseek', 'global', 'deepseek', 'session-key')).toBe(
        false
      );
    });

    it('does not let a session-scoped API key bypass curation', async () => {
      clearModelsCache();
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      getProviderRegistry().setCuratedModels('deepseek', [{ id: 'deepseek-v4-flash' }]);

      expect(await isValidModel('deepseek-pro', 'global', 'deepseek', 'session-key')).toBe(false);
      expect(await isValidModel('deepseek-flash', 'global', 'deepseek', 'session-key')).toBe(true);
    });
  });

  describe('static model metadata seam', () => {
    it('serves every MinimaxProvider.MODELS entry from the static seam', async () => {
      clearModelsCache();

      expect(MinimaxProvider.MODELS).toHaveLength(4);

      for (const entry of MinimaxProvider.MODELS) {
        const model = await getModelInfo(entry.id, 'global', 'minimax');
        expect(model).not.toBeNull();
        expect(model?.id).toBe(entry.id);
        expect(model?.provider).toBe('minimax');
        expect(model?.contextWindow).toBe(entry.contextWindow);
      }
    });

    it('resolves Minimax aliases to static metadata', async () => {
      clearModelsCache();

      expect(await getModelInfo('minimax', 'global', 'minimax')).toMatchObject({
        id: 'MiniMax-M2.5',
      });
      expect(await getModelInfo('minimax-fast', 'global', 'minimax')).toMatchObject({
        id: 'MiniMax-M2.5-highspeed',
      });
      expect(await getModelInfo('minimax-m27', 'global', 'minimax')).toMatchObject({
        id: 'MiniMax-M2.7',
      });
      expect(await getModelInfo('minimax-m27-fast', 'global', 'minimax')).toMatchObject({
        id: 'MiniMax-M2.7-highspeed',
      });
    });

    it('does not resolve Minimax static metadata for other providers', async () => {
      clearModelsCache();

      expect(await getModelInfo('MiniMax-M2.7', 'global', 'glm')).toBeNull();
      expect(await getModelInfo('MiniMax-M2.7', 'global', 'anthropic-copilot')).toBeNull();
    });

    it('serves every COPILOT_ANTHROPIC_MODELS entry from the static seam', async () => {
      clearModelsCache();

      expect(COPILOT_ANTHROPIC_MODELS).toHaveLength(7);

      for (const entry of COPILOT_ANTHROPIC_MODELS) {
        const model = await getModelInfo(entry.id, 'global', 'anthropic-copilot');
        expect(model).not.toBeNull();
        expect(model?.id).toBe(entry.id);
        expect(model?.provider).toBe('anthropic-copilot');
        expect(model?.contextWindow).toBe(entry.contextWindow);
      }
    });

    it('resolves Copilot aliases to static metadata', async () => {
      clearModelsCache();

      expect(
        await getModelInfo('copilot-anthropic-opus', 'global', 'anthropic-copilot')
      ).toMatchObject({
        id: 'claude-opus-4.6',
        contextWindow: 200000,
      });
      expect(
        await getModelInfo('copilot-anthropic-codex', 'global', 'anthropic-copilot')
      ).toMatchObject({
        id: 'gpt-5.3-codex',
        contextWindow: 272000,
      });
      expect(
        await getModelInfo('copilot-anthropic-mini', 'global', 'anthropic-copilot')
      ).toMatchObject({
        id: 'gpt-5-mini',
        contextWindow: 128000,
      });
    });

    it('does not leak Copilot static metadata to anthropic-only requests', async () => {
      clearModelsCache();

      expect(await getModelInfo('claude-opus-4.6', 'global', 'anthropic')).toBeNull();
      expect(await getModelInfo('gpt-5.5', 'global', 'anthropic')).toBeNull();
    });

    it('overlays Codex context-window preferences on Copilot static hits', async () => {
      clearModelsCache();

      for (const id of ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5']) {
        const model = await getModelInfo(id, 'global', 'anthropic-copilot');
        expect(model?.contextWindow).toBe(272000);
        expect(model?.preferContextWindowMetadata).toBe(true);
      }
    });

    it('returns non-Codex Copilot static metadata without the overlay', async () => {
      clearModelsCache();

      const claude = await getModelInfo('claude-sonnet-4.6', 'global', 'anthropic-copilot');
      expect(claude?.contextWindow).toBe(200000);
      expect(claude?.preferContextWindowMetadata).toBeUndefined();

      const gemini = await getModelInfo('gemini-3.1-pro-preview', 'global', 'anthropic-copilot');
      expect(gemini?.contextWindow).toBe(128000);
      expect(gemini?.preferContextWindowMetadata).toBeUndefined();
    });

    it('gates Minimax static validation on provider availability', async () => {
      clearModelsCache();

      expect(await isValidModel('MiniMax-M2.7', 'global', 'minimax')).toBe(false);
      expect(await isValidModel('MiniMax-M2.7', 'global', 'minimax', 'session-key')).toBe(true);
      expect(await isValidModel('unknown-minimax', 'global', 'minimax', 'session-key')).toBe(false);

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'minimax',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);
      expect(await isValidModel('MiniMax-M2.7', 'global', 'minimax')).toBe(true);
    });

    it('gates Copilot static validation on provider availability', async () => {
      clearModelsCache();

      expect(await isValidModel('claude-sonnet-4.6', 'global', 'anthropic-copilot')).toBe(false);
      expect(
        await isValidModel('claude-sonnet-4.6', 'global', 'anthropic-copilot', 'session-key')
      ).toBe(false);
      expect(
        await isValidModel('unknown-copilot-model', 'global', 'anthropic-copilot', 'session-key')
      ).toBe(false);

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic-copilot',
        getModels: async () => [],
        isAvailable: async () => false,
      } as ProviderLike);
      expect(await isValidModel('claude-sonnet-4.6', 'global', 'anthropic-copilot')).toBe(false);
    });

    it('validates Copilot static metadata when the provider is available', async () => {
      clearModelsCache();

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic-copilot',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);
      expect(await isValidModel('claude-sonnet-4.6', 'global', 'anthropic-copilot')).toBe(true);
      expect(await isValidModel('copilot-anthropic-opus', 'global', 'anthropic-copilot')).toBe(
        true
      );
      expect(await isValidModel('unknown-copilot-model', 'global', 'anthropic-copilot')).toBe(
        false
      );
    });
  });

  describe('resolveModelAlias', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should resolve existing model ID', async () => {
      const resolved = await resolveModelAlias('sonnet', 'global', 'anthropic');
      expect(resolved).toBe('sonnet');
    });

    it('should resolve alias to model ID', async () => {
      const resolved = await resolveModelAlias('opus', 'global', 'anthropic');
      expect(resolved).toBe('opus');
    });

    it('should return input as-is for unknown model', async () => {
      const resolved = await resolveModelAlias('custom-model-id', 'global', 'anthropic');
      expect(resolved).toBe('custom-model-id');
    });

    it('should resolve legacy model ID', async () => {
      const resolved = await resolveModelAlias('claude-sonnet-4-5-20250929', 'global', 'anthropic');
      expect(resolved).toBe('sonnet');
    });
  });

  describe('getSupportedModelsFromQuery', () => {
    it('should return cached models if available', async () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('test-key', mockModels);
      setModelsCache(testCache);

      const models = await getSupportedModelsFromQuery(null, 'test-key');
      expect(models).toEqual(mockModels);
    });

    it('should return empty array if no cache and no query', async () => {
      const models = await getSupportedModelsFromQuery(null, 'new-key');
      expect(models).toEqual([]);
    });

    it('should get models from query object when available', async () => {
      const mockQuery = {
        supportedModels: mock(async () => [
          { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet · Test' },
        ]),
      };

      const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'query-key');

      expect(models.length).toBe(1);
      expect(models[0].id).toBe('sonnet');
      expect(models[0].provider).toBe('anthropic');
    });

    it('should cache models from query', async () => {
      const mockQuery = {
        supportedModels: mock(async () => [
          { value: 'haiku', displayName: 'Haiku', description: 'Haiku · Test' },
        ]),
      };

      await getSupportedModelsFromQuery(mockQuery as unknown, 'cache-test-key');

      const cache = getModelsCache();
      expect(cache.get('cache-test-key')).toBeDefined();
      expect(cache.get('cache-test-key')?.length).toBe(1);
    });

    it('should handle query errors gracefully', async () => {
      const mockQuery = {
        supportedModels: mock(async () => {
          throw new Error('Query error');
        }),
      };

      const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'error-key');
      expect(models).toEqual([]);
    });
  });

  describe('model properties', () => {
    it('should include provider field', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      const models = getAvailableModels();
      expect(models[0].provider).toBe('anthropic');
    });

    it('should include contextWindow', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      const models = getAvailableModels();
      expect(models[0].contextWindow).toBe(200000);
    });

    it('should have correct family for each model', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      const models = getAvailableModels();

      const sonnetModel = models.find((m) => m.id === 'sonnet');
      expect(sonnetModel?.family).toBe('sonnet');

      const opusModel = models.find((m) => m.id === 'opus');
      expect(opusModel?.family).toBe('opus');

      const haikuModel = models.find((m) => m.id === 'haiku');
      expect(haikuModel?.family).toBe('haiku');
    });
  });

  describe('initializeModels', () => {
    it('should skip initialization when already initialized', async () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      await expect(initializeModels()).resolves.toBeUndefined();

      const cache = getModelsCache();
      expect(cache.get('global')).toEqual(mockModels);
    });
  });

  describe('background refresh behavior', () => {
    it('should return cached models while refresh is in progress', async () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      const models1 = getAvailableModels('global');
      const models2 = getAvailableModels('global');

      expect(models1).toEqual(models2);
      expect(models1.length).toBe(3);
    });
  });

  describe('provider loading', () => {
    it('should return empty array when no providers are available', () => {
      resetProviderRegistry();
      resetProviderFactory();
      clearModelsCache();

      const models = getAvailableModels('no-providers-key');
      expect(models).toEqual([]);
    });

    it('should handle provider errors gracefully during model loading', async () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      const models = getAvailableModels('global');
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('cache key isolation', () => {
    it('should maintain separate caches for different keys', () => {
      const globalModels = mockModels;
      const sessionModels = [mockModels[0]];

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', globalModels);
      testCache.set('session-abc', sessionModels);
      setModelsCache(testCache);

      expect(getAvailableModels('global').length).toBe(3);
      expect(getAvailableModels('session-abc').length).toBe(1);
      expect(getAvailableModels('nonexistent-key').length).toBe(0);
    });

    it('should clear cache for specific key without affecting others', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('key-a', mockModels);
      testCache.set('key-b', mockModels);
      testCache.set('key-c', mockModels);
      setModelsCache(testCache);

      clearModelsCache('key-b');

      const cache = getModelsCache();
      expect(cache.has('key-a')).toBe(true);
      expect(cache.has('key-b')).toBe(false);
      expect(cache.has('key-c')).toBe(true);
    });
  });

  describe('setModelsCache with timestamp', () => {
    it('should accept custom timestamp', () => {
      const customTimestamp = Date.now() - 10000;
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);

      setModelsCache(testCache, customTimestamp);

      const cache = getModelsCache();
      expect(cache.size).toBe(1);
    });

    it('should use current time when timestamp not provided', () => {
      const beforeTime = Date.now();
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);

      setModelsCache(testCache);

      const afterTime = Date.now();
      expect(getAvailableModels('global').length).toBe(3);
    });
  });

  describe('additional legacy model IDs', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should handle claude-sonnet-4-20241022 legacy ID', async () => {
      const model = await getModelInfo('claude-sonnet-4-20241022', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
    });

    it('should handle claude-3-5-sonnet-20241022 legacy ID', async () => {
      const model = await getModelInfo('claude-3-5-sonnet-20241022', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
    });

    it('should handle claude-opus-4-20250514 legacy ID', async () => {
      const model = await getModelInfo('claude-opus-4-20250514', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('opus');
    });

    it('should handle claude-3-5-haiku-20241022 legacy ID', async () => {
      const model = await getModelInfo('claude-3-5-haiku-20241022', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('haiku');
    });

    it('should resolve all legacy model IDs via resolveModelAlias', async () => {
      const legacyIds = [
        { id: 'claude-sonnet-4-5-20250929', expected: 'sonnet' },
        { id: 'claude-sonnet-4-20241022', expected: 'sonnet' },
        { id: 'claude-3-5-sonnet-20241022', expected: 'sonnet' },
        { id: 'claude-opus-4-5-20251101', expected: 'opus' },
        { id: 'claude-opus-4-20250514', expected: 'opus' },
        { id: 'claude-haiku-4-5-20251001', expected: 'haiku' },
        { id: 'claude-3-5-haiku-20241022', expected: 'haiku' },
      ];

      for (const { id, expected } of legacyIds) {
        const resolved = await resolveModelAlias(id, 'global', 'anthropic');
        expect(resolved).toBe(expected);
      }
    });
  });

  describe('default model alias', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should resolve "default" alias to sonnet', async () => {
      const resolved = await resolveModelAlias('default', 'global', 'anthropic');
      expect(resolved).toBe('sonnet');
    });

    it('should validate "default" as a valid model', async () => {
      const isValid = await isValidModel('default', 'global', 'anthropic');
      expect(isValid).toBe(true);
    });

    it('should get model info for "default"', async () => {
      const model = await getModelInfo('default', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
    });
  });

  describe('getSessionModelInfo', () => {
    it('should resolve model metadata using the session provider', async () => {
      clearModelsCache();

      const model = await getSessionModelInfo({
        config: {
          model: 'gpt-5.6-sol',
          provider: 'anthropic-codex',
        },
      } as any);

      expect(model?.id).toBe('gpt-5.6-sol');
      expect(model?.contextWindow).toBe(1050000);
    });

    it('should return null when the session provider is missing', async () => {
      const model = await getSessionModelInfo({
        config: {
          model: 'gpt-5.5',
        },
      } as any);

      expect(model).toBeNull();
    });
  });

  describe('cache with empty models array', () => {
    it('should return empty array when cache has empty array', () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', []);
      setModelsCache(testCache);

      const models = getAvailableModels('global');
      expect(models).toEqual([]);
    });
  });

  describe('getModelInfo with cache key', () => {
    it('should use specific cache key when provided', async () => {
      const customModels: ModelInfo[] = [
        {
          id: 'custom-model',
          name: 'Custom Model',
          alias: 'custom',
          family: 'custom',
          provider: 'custom',
          contextWindow: 100000,
          description: 'Custom model for testing',
        },
      ];

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      testCache.set('custom-cache', customModels);
      setModelsCache(testCache);

      const globalModel = await getModelInfo('sonnet', 'global', 'anthropic');
      expect(globalModel).not.toBeNull();

      const customModel = await getModelInfo('custom-model', 'custom-cache', 'custom');
      expect(customModel).not.toBeNull();
      expect(customModel?.id).toBe('custom-model');

      const notFound = await getModelInfo('custom-model', 'global', 'custom');
      expect(notFound).toBeNull();
    });
  });

  describe('isValidModel with cache key', () => {
    it('should validate against specific cache key', async () => {
      const customModels: ModelInfo[] = [
        {
          id: 'custom-only',
          name: 'Custom Only',
          alias: 'customonly',
          family: 'custom',
          provider: 'custom',
          contextWindow: 100000,
          description: 'Only in custom cache',
        },
      ];

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      testCache.set('custom-cache', customModels);
      setModelsCache(testCache);

      expect(await isValidModel('custom-only', 'custom-cache', 'custom')).toBe(true);

      expect(await isValidModel('custom-only', 'global', 'custom')).toBe(false);
    });
  });

  describe('resolveModelAlias with cache key', () => {
    it('should resolve using specific cache key', async () => {
      const customModels: ModelInfo[] = [
        {
          id: 'custom-alias-model',
          name: 'Custom Alias Model',
          alias: 'my-custom-alias',
          family: 'custom',
          provider: 'custom',
          contextWindow: 100000,
          description: 'Has custom alias',
        },
      ];

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      testCache.set('custom-cache', customModels);
      setModelsCache(testCache);

      const resolved = await resolveModelAlias('my-custom-alias', 'custom-cache', 'custom');
      expect(resolved).toBe('custom-alias-model');

      const notResolved = await resolveModelAlias('my-custom-alias', 'global', 'anthropic');
      expect(notResolved).toBe('my-custom-alias');
    });
  });

  describe('provider-filtered model resolution', () => {
    const sharedModels: ModelInfo[] = [
      {
        id: 'claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6 (Anthropic)',
        alias: 'sonnet-4.6',
        family: 'sonnet',
        provider: 'anthropic',
        contextWindow: 200000,
        description: 'Anthropic Sonnet',
        available: true,
      },
      {
        id: 'claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6 (Copilot)',
        alias: 'sonnet-4.6',
        family: 'sonnet',
        provider: 'anthropic-copilot',
        contextWindow: 200000,
        description: 'Copilot Sonnet',
        available: true,
      },
      {
        id: 'haiku',
        name: 'Haiku (Anthropic)',
        alias: 'haiku',
        family: 'haiku',
        provider: 'anthropic',
        contextWindow: 200000,
        available: true,
      },
    ];

    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', sharedModels);
      setModelsCache(testCache);
    });

    it('should return provider-specific model when providerId matches anthropic-copilot', async () => {
      const model = await getModelInfo('claude-sonnet-4.6', 'global', 'anthropic-copilot');
      expect(model).not.toBeNull();
      expect(model?.provider).toBe('anthropic-copilot');
      expect(model?.name).toBe('Claude Sonnet 4.6 (Copilot)');
    });

    it('should return anthropic model when providerId is anthropic', async () => {
      const model = await getModelInfo('claude-sonnet-4.6', 'global', 'anthropic');
      expect(model).not.toBeNull();
      expect(model?.provider).toBe('anthropic');
      expect(model?.name).toBe('Claude Sonnet 4.6 (Anthropic)');
    });

    it('should return null when provider does not have the model (no fallback)', async () => {
      const model = await getModelInfo('claude-sonnet-4.6', 'global', 'glm');
      expect(model).toBeNull();
    });

    it('should resolve alias with provider filter', async () => {
      const resolved = await resolveModelAlias('claude-sonnet-4.6', 'global', 'anthropic-copilot');
      expect(resolved).toBe('claude-sonnet-4.6');
    });

    it('should find model by alias with provider filter', async () => {
      const model = await getModelInfo('sonnet-4.6', 'global', 'anthropic-copilot');
      expect(model).not.toBeNull();
      expect(model?.provider).toBe('anthropic-copilot');
    });

    it('should return null when model not found for the specified provider', async () => {
      const model = await getModelInfo('nonexistent-model', 'global', 'anthropic-copilot');
      expect(model).toBeNull();
    });

    it('should return null for model unique to one provider when wrong provider is requested', async () => {
      const model = await getModelInfo('haiku', 'global', 'anthropic-copilot');
      expect(model).toBeNull();
    });

    it('should resolve legacy model ID to provider-specific entry when providerId is set', async () => {
      const modelsWithCopilotSonnet: ModelInfo[] = [
        ...sharedModels,
        {
          id: 'sonnet',
          name: 'Sonnet (Copilot)',
          alias: 'sonnet',
          family: 'sonnet',
          provider: 'anthropic-copilot',
          contextWindow: 200000,
          available: true,
        },
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
      cache.set('global', modelsWithCopilotSonnet);
      setModelsCache(cache);

      const model = await getModelInfo('claude-sonnet-4-5-20250929', 'global', 'anthropic-copilot');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
      expect(model?.provider).toBe('anthropic-copilot');
    });
  });

  describe('getModelInfoUnfiltered', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should return a result without requiring provider', async () => {
      const model = await getModelInfoUnfiltered('sonnet');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
      expect(model?.provider).toBe('anthropic');
    });

    it('should find model by alias without provider filter', async () => {
      const model = await getModelInfoUnfiltered('opus');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('opus');
    });

    it('should return null for unknown model', async () => {
      const model = await getModelInfoUnfiltered('nonexistent-model-xyz');
      expect(model).toBeNull();
    });

    it('should handle legacy model IDs without provider', async () => {
      const model = await getModelInfoUnfiltered('claude-sonnet-4-5-20250929');
      expect(model).not.toBeNull();
      expect(model?.id).toBe('sonnet');
    });
  });

  describe('resolveModelAliasUnfiltered', () => {
    beforeEach(() => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);
    });

    it('should resolve correctly without provider', async () => {
      const resolved = await resolveModelAliasUnfiltered('sonnet');
      expect(resolved).toBe('sonnet');
    });

    it('should resolve alias to model ID without provider', async () => {
      const resolved = await resolveModelAliasUnfiltered('opus');
      expect(resolved).toBe('opus');
    });

    it('should return input as-is for unknown model', async () => {
      const resolved = await resolveModelAliasUnfiltered('unknown-id-xyz');
      expect(resolved).toBe('unknown-id-xyz');
    });

    it('should handle legacy model IDs without provider', async () => {
      const resolved = await resolveModelAliasUnfiltered('claude-sonnet-4-5-20250929');
      expect(resolved).toBe('sonnet');
    });
  });

  describe('ModelInfo optional fields', () => {
    it('should handle models with minimal fields', async () => {
      const minimalModels: ModelInfo[] = [
        {
          id: 'minimal',
          name: 'Minimal Model',
          family: 'minimal',
          provider: 'test',
          contextWindow: 1000,
        },
      ];

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', minimalModels);
      setModelsCache(testCache);

      const models = getAvailableModels('global');
      expect(models.length).toBe(1);
      expect(models[0].id).toBe('minimal');
      expect(models[0].alias).toBeUndefined();
      expect(models[0].description).toBeUndefined();
      expect(models[0].releaseDate).toBeUndefined();
      expect(models[0].available).toBeUndefined();
    });
  });

  describe('getSupportedModelsFromQuery edge cases', () => {
    it('should return empty array when query has no supportedModels method', async () => {
      const mockQuery = {};

      const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'no-method-key');
      expect(models).toEqual([]);
    });

    it('should return empty array when supportedModels returns empty array', async () => {
      const mockQuery = {
        supportedModels: mock(async () => []),
      };

      const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'empty-result-key');
      expect(models).toEqual([]);
    });

    it('should handle query returning null', async () => {
      const mockQuery = {
        supportedModels: mock(async () => null),
      };

      const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'null-result-key');
      expect(models).toEqual([]);
    });
  });

  describe('refreshModels', () => {
    it('should preserve both provider entries for shared model IDs after refresh', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const { refreshModels } = await import('../../../../src/lib/model-service');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

      const registry = getProviderRegistry();
      const sharedId = 'shared-model-xyz';

      registry.register({
        id: 'test-provider-a',
        getModels: async () => [
          {
            id: sharedId,
            name: 'Shared (A)',
            family: 'test',
            provider: 'test-provider-a',
            contextWindow: 100000,
          },
        ],
        isAvailable: async () => true,
      } as ProviderLike);

      registry.register({
        id: 'test-provider-b',
        getModels: async () => [
          {
            id: sharedId,
            name: 'Shared (B)',
            family: 'test',
            provider: 'test-provider-b',
            contextWindow: 100000,
          },
        ],
        isAvailable: async () => true,
      } as ProviderLike);

      await refreshModels();

      const entryA = await getModelInfo(sharedId, 'global', 'test-provider-a');
      const entryB = await getModelInfo(sharedId, 'global', 'test-provider-b');

      expect(entryA).not.toBeNull();
      expect(entryA?.provider).toBe('test-provider-a');

      expect(entryB).not.toBeNull();
      expect(entryB?.provider).toBe('test-provider-b');
    });

    it('should restore FALLBACK_MODELS when cache is empty and no providers are available', async () => {
      clearModelsCache();
      expect(getAvailableModels('global')).toEqual([]);

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);
      registry.register({
        id: 'empty-provider',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      const models = getAvailableModels('global');
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'sonnet')).toBe(true);
      expect(models.some((m) => m.id === 'opus')).toBe(true);
      expect(models.some((m) => m.id === 'haiku')).toBe(true);
    });

    it('should preserve existing cache when refresh returns no models', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'empty-provider',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      const models = getAvailableModels('global');
      expect(models).toEqual(mockModels);
    });

    it('should cancel in-flight background refresh when clearModelsCache is called', async () => {
      const cacheKey = 'bg-cancel-test';

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'test-provider-bg',
        getModels: async () => [
          {
            id: 'bg-model',
            name: 'BG Model',
            family: 'test',
            provider: 'test-provider-bg',
            contextWindow: 100000,
          },
        ],
        isAvailable: async () => true,
      } as ProviderLike);

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set(cacheKey, mockModels);
      setModelsCache(testCache, Date.now() - 5 * 60 * 60 * 1000);

      getAvailableModels(cacheKey);

      clearModelsCache();
      expect(getAvailableModels(cacheKey)).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(getAvailableModels(cacheKey)).toEqual([]);
    });

    it('should NOT cancel global background refresh on session-scoped clearModelsCache', async () => {
      const cacheKey = 'bg-session-test';

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'test-provider-bg2',
        getModels: async () => [
          {
            id: 'bg-model-2',
            name: 'BG Model 2',
            family: 'test',
            provider: 'test-provider-bg2',
            contextWindow: 100000,
          },
        ],
        isAvailable: async () => true,
      } as ProviderLike);

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set(cacheKey, [mockModels[0]]);
      setModelsCache(testCache, Date.now() - 5 * 60 * 60 * 1000);

      getAvailableModels(cacheKey);

      clearModelsCache('session-123');
      expect(getAvailableModels('session-123')).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 500));

      const models = getAvailableModels(cacheKey);
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'bg-model-2')).toBe(true);
    });

    it('should retain previous models when background refresh returns fewer models', async () => {
      const cacheKey = 'bg-shrink-test';

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const getModels = mock(async () => [
        {
          id: 'bg-model-3',
          name: 'BG Model 3',
          family: 'test',
          provider: 'test-provider-bg3',
          contextWindow: 100000,
        },
      ]);
      registry.register({
        id: 'test-provider-bg3',
        getModels,
        isAvailable: async () => true,
      } as ProviderLike);

      const testCache = new Map<string, ModelInfo[]>();
      testCache.set(cacheKey, mockModels);
      setModelsCache(testCache, Date.now() - 5 * 60 * 60 * 1000);

      getAvailableModels(cacheKey);

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(getModels).toHaveBeenCalled();
      const models = getAvailableModels(cacheKey);
      expect(models).toEqual(mockModels);
      expect(models.some((m) => m.id === 'bg-model-3')).toBe(false);
    });

    it('should drop stale result when clearModelsCache is called during foreground refresh', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      registry.register({
        id: 'slow-foreground-provider',
        getModels: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return [
            {
              id: 'stale-model',
              name: 'Stale Model',
              family: 'test',
              provider: 'slow-foreground-provider',
              contextWindow: 100000,
            },
          ];
        },
        isAvailable: async () => true,
      } as ProviderLike);

      clearModelsCache();

      const { refreshModels } = await import('../../../../src/lib/model-service');
      const refreshPromise = refreshModels();

      await new Promise((resolve) => setTimeout(resolve, 50));

      clearModelsCache();

      await refreshPromise;

      expect(getAvailableModels('global')).toEqual([]);
    });
  });

  describe('per-provider failure recording', () => {
    interface MockProviderBehavior {
      available?: boolean;
      models?: ModelInfo[];
      error?: Error;
      rejectDelayMs?: number;
      onFirstProbe?: () => void;
      unregisterDuringGetModels?: boolean;
    }

    async function registerProvider(id: string, behavior: MockProviderBehavior): Promise<void> {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id,
        getModels: async () => {
          if (behavior.rejectDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, behavior.rejectDelayMs));
          }
          if (behavior.unregisterDuringGetModels) {
            getProviderRegistry().unregister(id);
          }
          if (behavior.error) throw behavior.error;
          return behavior.models ?? [];
        },
        isAvailable: async () => {
          behavior.onFirstProbe?.();
          return behavior.available ?? true;
        },
      } as ProviderLike);
    }

    async function refreshProviderModels(): Promise<void> {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();
    }

    it('records a credential failure when getModels rejects with a 401 probe error', async () => {
      await registerProvider('glm', {
        error: new Error('Z.ai API key rejected (HTTP 401)'),
        models: mockModels,
      });

      await refreshProviderModels();

      const failure = getProviderFailure('glm');
      expect(failure?.errorKind).toBe('credential');
      expect(failure?.message).toBe('Z.ai API key rejected (HTTP 401)');
      expect(failure?.firstRecordedAt).toBeGreaterThan(0);
    });

    it('records a transient failure when getModels rejects with a 5xx probe error', async () => {
      await registerProvider('glm', {
        error: new Error('Z.ai probe failed (HTTP 503)'),
        models: mockModels,
      });

      await refreshProviderModels();

      expect(getProviderFailure('glm')?.errorKind).toBe('transient');
    });

    it('records a failure when isAvailable itself rejects', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id: 'broken-provider',
        getModels: async () => [],
        isAvailable: async () => {
          throw new Error('Codex probe timed out after 8000ms');
        },
      } as ProviderLike);

      await refreshProviderModels();

      expect(getProviderFailure('broken-provider')?.errorKind).toBe('transient');
    });

    it('does not record a failure for an unavailable provider', async () => {
      await registerProvider('glm', { available: false, models: mockModels });

      await refreshProviderModels();

      expect(getProviderFailure('glm')).toBeUndefined();
    });

    it('records failures even while the provider has models in the cache', async () => {
      await registerProvider('glm', {
        error: new Error('Z.ai probe failed (HTTP 503)'),
        models: mockModels,
      });
      const glmModels: ModelInfo[] = mockModels.map((m) => ({ ...m, provider: 'glm' }));
      setModelsCache(new Map([['global', glmModels]]));

      await refreshProviderModels();

      expect(getAvailableModels('global').some((m) => m.provider === 'glm')).toBe(true);
      expect(getProviderFailure('glm')?.errorKind).toBe('transient');
    });

    it('clears a previously recorded failure once the provider succeeds', async () => {
      await registerProvider('glm', {
        error: new Error('Z.ai probe failed (HTTP 503)'),
        models: mockModels,
      });
      await refreshProviderModels();
      expect(getProviderFailure('glm')).toBeDefined();

      resetProviderRegistry();
      await registerProvider('glm', { models: mockModels });
      await refreshProviderModels();

      expect(getProviderFailure('glm')).toBeUndefined();
    });

    it('propagates a recorded probe rejection into the provider auth status', async () => {
      const fetchImpl = mock(
        async () => new Response('unauthorized', { status: 401 })
      ) as unknown as typeof fetch;
      const glm = new GlmProvider({ GLM_API_KEY: 'invalid-key' }, fetchImpl);
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      getProviderRegistry().register(glm);

      await refreshProviderModels();

      expect(getProviderFailure('glm')?.errorKind).toBe('credential');

      const status = await glm.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.errorKind).toBe('credential');
      expect(status.error).toBe('Z.ai API key rejected (HTTP 401)');
    });

    it('notifies failure-change listeners once per transition during refreshes', async () => {
      const changes: ProviderFailureChange[] = [];
      subscribeProviderFailureChanges((change) => changes.push(change));

      await registerProvider('glm', {
        error: new Error('Z.ai probe failed (HTTP 503)'),
        models: mockModels,
      });
      await refreshProviderModels();
      await refreshProviderModels();

      expect(changes).toHaveLength(1);
      expect(changes[0]?.providerId).toBe('glm');

      resetProviderRegistry();
      await registerProvider('glm', { models: mockModels });
      await refreshProviderModels();

      expect(changes).toHaveLength(2);
      expect(changes[1]).toEqual({ providerId: 'glm', record: null });
    });

    it('does not apply failure writes from a superseded refresh generation', async () => {
      await registerProvider('glm', {
        error: new Error('Z.ai API key rejected (HTTP 401)'),
        models: mockModels,
        rejectDelayMs: 150,
      });

      const { refreshModels } = await import('../../../../src/lib/model-service');
      const supersededRefresh = refreshModels();
      await new Promise((resolve) => setTimeout(resolve, 25));
      clearModelsCache();
      await supersededRefresh;

      expect(getProviderFailure('glm')).toBeUndefined();
    });

    it('does not apply failure writes from a superseded initialization', async () => {
      const { initializeProviders } = await import('../../../../src/lib/providers/factory');
      initializeProviders();
      let signalFirstProbe: () => void = () => {};
      const firstProbeStarted = new Promise<void>((resolve) => {
        signalFirstProbe = resolve;
      });
      await registerProvider('stub-failing-provider', {
        error: new Error('Z.ai API key rejected (HTTP 401)'),
        models: mockModels,
        rejectDelayMs: 150,
        onFirstProbe: signalFirstProbe,
      });

      const { initializeModels } = await import('../../../../src/lib/model-service');
      const initialization = initializeModels();
      await firstProbeStarted;
      clearModelsCache();
      await initialization;

      expect(getProviderFailure('stub-failing-provider')).toBeUndefined();
    });

    it('preserves replacement refresh state when a superseded initialization settles', async () => {
      const { initializeProviders } = await import('../../../../src/lib/providers/factory');
      initializeProviders();
      let signalFirstProbe: () => void = () => {};
      const firstProbeStarted = new Promise<void>((resolve) => {
        signalFirstProbe = resolve;
      });
      await registerProvider('stub-failing-provider', {
        error: new Error('Z.ai API key rejected (HTTP 401)'),
        models: mockModels,
        rejectDelayMs: 150,
        onFirstProbe: signalFirstProbe,
      });

      const { initializeModels, refreshModels } = await import('../../../../src/lib/model-service');
      const initialization = initializeModels();
      await firstProbeStarted;
      clearModelsCache();
      const replacement = refreshModels();
      await initialization;
      await replacement;

      expect(getProviderFailure('stub-failing-provider')?.errorKind).toBe('credential');
    });

    it('drops failure records for providers no longer in the registry', async () => {
      await registerProvider('glm', {
        error: new Error('Z.ai probe failed (HTTP 503)'),
        models: mockModels,
      });
      await refreshProviderModels();
      expect(getProviderFailure('glm')).toBeDefined();

      resetProviderRegistry();
      await registerProvider('kimi', { models: mockModels });
      await refreshProviderModels();

      expect(getProviderFailure('glm')).toBeUndefined();
    });

    it('does not record failures for providers unregistered during the load', async () => {
      await registerProvider('glm', {
        error: new Error('Z.ai probe failed (HTTP 503)'),
        models: mockModels,
        unregisterDuringGetModels: true,
      });
      await registerProvider('kimi', { models: mockModels });

      await refreshProviderModels();

      expect(getProviderFailure('glm')).toBeUndefined();
      expect(getProviderFailure('kimi')).toBeUndefined();
    });
  });

  describe('probe-based provider failures (fallback)', () => {
    it('serves a provider via the static fallback when its getModels probe rejects', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const { refreshModels } = await import('../../../../src/lib/model-service');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic',
        getModels: async () => [mockModels[0]],
        isAvailable: async () => true,
      } as ProviderLike);

      const rejectingFetch = (async () =>
        new Response(null, { status: 401 })) as unknown as typeof fetch;
      registry.register(new GlmProvider({ GLM_API_KEY: 'glm-key' }, rejectingFetch));

      await refreshModels();

      const models = getAvailableModels('global');
      expect(models.some((m) => m.provider === 'anthropic')).toBe(true);
      expect(models.filter((m) => m.provider === 'glm').map((m) => m.id)).toEqual(
        GlmProvider.MODELS.map((m) => m.id)
      );
    });

    it('keeps the provider listed via fallback and still refreshes once the probe succeeds', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const { refreshModels } = await import('../../../../src/lib/model-service');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

      let upstreamAccepts = false;
      const mutableFetch = (async () =>
        new Response(null, { status: upstreamAccepts ? 200 : 401 })) as unknown as typeof fetch;

      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic',
        getModels: async () => [mockModels[0]],
        isAvailable: async () => true,
      } as ProviderLike);
      registry.register(new GlmProvider({ GLM_API_KEY: 'glm-key' }, mutableFetch));

      await refreshModels();
      expect(getAvailableModels('global').some((m) => m.provider === 'glm')).toBe(true);

      upstreamAccepts = true;
      await refreshModels();

      const models = getAvailableModels('global');
      expect(models.some((m) => m.provider === 'glm' && m.id === 'glm-5')).toBe(true);
    });

    it('treats an empty getModels result from an available provider as a failed fetch', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const { refreshModels } = await import('../../../../src/lib/model-service');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

      const registry = getProviderRegistry();
      registry.register({
        id: 'glm',
        getModels: async () => [],
        isAvailable: async () => true,
      } as ProviderLike);

      await refreshModels();

      const models = getAvailableModels('global');
      expect(models.some((m) => m.provider === 'glm' && m.id === 'glm-5')).toBe(true);
    });

    it('falls back to static metadata when isAvailable throws', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const { refreshModels } = await import('../../../../src/lib/model-service');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic-codex',
        getModels: async () => {
          throw new Error('unreachable');
        },
        isAvailable: async () => {
          throw new Error('saveCredentials: EACCES read-only auth dir');
        },
      } as ProviderLike);

      await refreshModels();

      const models = getAvailableModels('global');
      expect(models.some((m) => m.provider === 'anthropic-codex' && m.id === 'gpt-5.5')).toBe(true);
    });

    it('prefers getCachedModels over static metadata in the fallback', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const { refreshModels } = await import('../../../../src/lib/model-service');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

      const cachedMarker: ModelInfo = {
        id: 'glm-cached-marker',
        name: 'GLM Cached Marker',
        alias: 'glm-cached',
        family: 'glm',
        provider: 'glm',
        contextWindow: 100000,
        description: 'Curated ACP-style cached entry',
        releaseDate: '2026-01-01',
        available: true,
      };

      const registry = getProviderRegistry();
      registry.register({
        id: 'glm',
        getModels: async () => {
          throw new Error('Z.ai API key rejected (HTTP 401)');
        },
        isAvailable: async () => true,
        getCachedModels: () => [cachedMarker],
      } as ProviderLike);

      await refreshModels();

      const models = getAvailableModels('global');
      expect(models.some((m) => m.id === 'glm-cached-marker')).toBe(true);
      expect(models.some((m) => m.provider === 'glm' && m.id === 'glm-5')).toBe(false);
    });

    it('does not serve fallback models for a provider that reports itself unavailable', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const { refreshModels } = await import('../../../../src/lib/model-service');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

      const registry = getProviderRegistry();
      registry.register({
        id: 'glm',
        getModels: async () => {
          throw new Error('getModels must not run when unavailable');
        },
        isAvailable: async () => false,
      } as ProviderLike);

      await refreshModels();

      expect(getAvailableModels('global').some((m) => m.provider === 'glm')).toBe(false);
    });
  });
});
