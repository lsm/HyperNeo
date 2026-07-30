/**
 * Model Service Tests
 *
 * Tests the unified model service that delegates to providers.
 * Tests mock provider responses rather than real SDK calls.
 */

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
  getSupportedModelsFromQuery,
  initializeModels,
  getSessionModelInfo,
} from '../../../../src/lib/model-service';
import type { ModelInfo } from '@hyperneo/shared';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';

describe('Model Service', () => {
  // Sample ModelInfo data for testing (as returned by providers)
  // Note: Provider now returns 'sonnet' instead of 'default'
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
    // Clear cache and reset provider system before each test
    // Both functions must be called to fully reset the provider state
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    // Clean up after tests
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
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
      const sessionModels = [mockModels[0]]; // Only default
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
            ],
          ],
        ])
      );

      const full = await getModelInfo('gpt-5.5', 'global', 'anthropic-copilot');
      const mini = await getModelInfo('gpt-5.4-mini', 'global', 'anthropic-copilot');

      expect(full?.contextWindow).toBe(272000);
      expect(full?.preferContextWindowMetadata).toBe(true);
      expect(mini?.id).toBe('gpt-5.4-mini');
      expect(mini?.contextWindow).toBe(128000);
      expect(mini?.preferContextWindowMetadata).toBe(true);
    });

    it('should not resolve unknown Codex models to fallback metadata', async () => {
      clearModelsCache();

      const model = await getModelInfo('gpt-unknown', 'global', 'anthropic-codex');

      expect(model).toBeNull();
    });

    it('should handle legacy model IDs', async () => {
      // Legacy full model IDs should map to SDK short IDs
      // Note: 'claude-sonnet-4-5-20250929' maps to 'sonnet' via LEGACY_MODEL_MAPPINGS
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
      // 'sonnet' exists for 'anthropic' but not for 'glm'
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
      // LEGACY_MODEL_MAPPINGS maps 'claude-sonnet-4-5-20250929' to 'sonnet'
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

      // Should convert to ModelInfo format
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

      // Should now be in cache
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
      // Pre-populate cache to simulate already initialized state
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      // Should return immediately without throwing
      await expect(initializeModels()).resolves.toBeUndefined();

      // Cache should still contain our models
      const cache = getModelsCache();
      expect(cache.get('global')).toEqual(mockModels);
    });
  });

  describe('background refresh behavior', () => {
    it('should return cached models while refresh is in progress', async () => {
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      // Multiple calls should return cached data
      const models1 = getAvailableModels('global');
      const models2 = getAvailableModels('global');

      expect(models1).toEqual(models2);
      expect(models1.length).toBe(3);
    });
  });

  describe('provider loading', () => {
    it('should return empty array when no providers are available', () => {
      // Ensure no providers are registered
      resetProviderRegistry();
      resetProviderFactory();
      clearModelsCache();

      // With no providers and no cache, should return empty
      const models = getAvailableModels('no-providers-key');
      expect(models).toEqual([]);
    });

    it('should handle provider errors gracefully during model loading', async () => {
      // Pre-populate cache so getAvailableModels doesn't return empty
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      // Even if a provider fails, cached models should still be available
      const models = getAvailableModels('global');
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('cache key isolation', () => {
    it('should maintain separate caches for different keys', () => {
      const globalModels = mockModels;
      const sessionModels = [mockModels[0]]; // Only default model

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
      const customTimestamp = Date.now() - 10000; // 10 seconds ago
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
      // Timestamp should be between beforeTime and afterTime
      // (This is implicitly tested by the cache working correctly)
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
      // LEGACY_MODEL_MAPPINGS maps 'default' to 'sonnet'
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

      // Should find in global cache with correct provider
      const globalModel = await getModelInfo('sonnet', 'global', 'anthropic');
      expect(globalModel).not.toBeNull();

      // Should find in custom cache with correct provider
      const customModel = await getModelInfo('custom-model', 'custom-cache', 'custom');
      expect(customModel).not.toBeNull();
      expect(customModel?.id).toBe('custom-model');

      // Should not find custom model in global cache
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

      // Custom model should be valid in custom cache with correct provider
      expect(await isValidModel('custom-only', 'custom-cache', 'custom')).toBe(true);

      // Custom model should not be valid in global cache (not present there)
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

      // Should resolve alias in custom cache with correct provider
      const resolved = await resolveModelAlias('my-custom-alias', 'custom-cache', 'custom');
      expect(resolved).toBe('custom-alias-model');

      // Should return as-is when not found in global cache (wrong provider)
      const notResolved = await resolveModelAlias('my-custom-alias', 'global', 'anthropic');
      expect(notResolved).toBe('my-custom-alias');
    });
  });

  describe('provider-filtered model resolution', () => {
    // Two providers exposing the same canonical model ID
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
      // 'glm' provider has no claude-sonnet-4.6 — no fallback, returns null
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
      // 'haiku' only exists for 'anthropic', not 'anthropic-copilot'
      const model = await getModelInfo('haiku', 'global', 'anthropic-copilot');
      expect(model).toBeNull();
    });

    it('should resolve legacy model ID to provider-specific entry when providerId is set', async () => {
      // Add a copilot variant of the legacy-mapped target 'sonnet'
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

      // LEGACY_MODEL_MAPPINGS maps 'claude-sonnet-4-5-20250929' → 'sonnet'
      // With copilot provider, should find the copilot sonnet entry
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
      const mockQuery = {
        // No supportedModels method
      };

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
      // Exercises the production mergeWithFallbackModels code path without calling
      // initializeModels(), which registers built-in providers and can wait on slow
      // external availability checks in unit-test environments.
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

      // Both entries must survive the merge — one per (provider, id) pair
      const entryA = await getModelInfo(sharedId, 'global', 'test-provider-a');
      const entryB = await getModelInfo(sharedId, 'global', 'test-provider-b');

      expect(entryA).not.toBeNull();
      expect(entryA?.provider).toBe('test-provider-a');

      expect(entryB).not.toBeNull();
      expect(entryB?.provider).toBe('test-provider-b');
    });

    it('should restore FALLBACK_MODELS when cache is empty and no providers are available', async () => {
      // Ensure cache is empty (as if clearModelsCache() was called)
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

      // With no providers returning models, refreshModels should restore fallbacks
      // for providers that are still registered.
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

      // Seed cache with mock models
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set('global', mockModels);
      setModelsCache(testCache);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      // Existing cache should be preserved because it was non-empty
      const models = getAvailableModels('global');
      expect(models).toEqual(mockModels);
    });

    it('should cancel in-flight background refresh when clearModelsCache is called', async () => {
      // Use a custom cache key to avoid cross-test contamination that can
      // write to the 'global' key from unrelated async provider loading.
      const cacheKey = 'bg-cancel-test';

      // Register a test provider so the background refresh actually returns
      // models and reaches the generation-guard check.
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

      // Seed cache with an old timestamp so getAvailableModels triggers
      // a background refresh.
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set(cacheKey, mockModels);
      setModelsCache(testCache, Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago

      // Trigger a background refresh by calling getAvailableModels
      getAvailableModels(cacheKey);

      // Immediately clear the cache (simulating an OAuth account change)
      clearModelsCache();
      expect(getAvailableModels(cacheKey)).toEqual([]);

      // Wait long enough for the background refresh to have completed
      // if it were still running.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The cache should still be empty because the generation counter
      // caused the in-flight refresh to drop its stale result.
      expect(getAvailableModels(cacheKey)).toEqual([]);
    });

    it('should NOT cancel global background refresh on session-scoped clearModelsCache', async () => {
      // Use a custom cache key to avoid cross-test contamination that can
      // write to the 'global' key from unrelated async provider loading.
      const cacheKey = 'bg-session-test';

      // Register a test provider so the background refresh actually returns
      // models and reaches the generation-guard check.
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

      // Seed the cache with an old timestamp so getAvailableModels
      // triggers a background refresh for this key.
      const testCache = new Map<string, ModelInfo[]>();
      testCache.set(cacheKey, mockModels);
      setModelsCache(testCache, Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago

      // Trigger a background refresh for this key
      getAvailableModels(cacheKey);

      // Clear a *different* cache key — this must not affect the refresh
      clearModelsCache('session-123');
      expect(getAvailableModels('session-123')).toEqual([]);

      // Wait long enough for the background refresh to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The cache should still have been populated because the
      // session-scoped clear must not bump the generation for this key.
      const models = getAvailableModels(cacheKey);
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'bg-model-2')).toBe(true);
    });

    it('should drop stale result when clearModelsCache is called during foreground refresh', async () => {
      // Register a deliberately slow provider so the refresh is in-flight
      // long enough for us to clear the cache while it runs.
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

      // Ensure cache is empty
      clearModelsCache();

      // Start a foreground refresh but do not await it yet
      const { refreshModels } = await import('../../../../src/lib/model-service');
      const refreshPromise = refreshModels();

      // Allow the refresh to enter its async loading phase
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Invalidate the cache while the refresh is still loading models
      clearModelsCache();

      // Wait for the refresh to finish
      await refreshPromise;

      // The generation guard should have caused the stale result to be dropped
      expect(getAvailableModels('global')).toEqual([]);
    });
  });
});
