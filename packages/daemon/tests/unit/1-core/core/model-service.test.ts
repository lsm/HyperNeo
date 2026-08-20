import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from 'bun:test';
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
  hasRefreshBeenAttemptedFor,
  markRefreshAttemptedFor,
} from '../../../../src/lib/model-service';
import type { ModelInfo } from '@hyperneo/shared';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function makeScopeRaceJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
  ).toString('base64url');
  return `${header}.${body}.`;
}

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
  });

  afterEach(() => {
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
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

    it('does not publish cached models after definitive credential rejection', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const rejectedModel = {
        id: 'rejected-cached-model',
        name: 'Rejected Cached Model',
        family: 'test',
        provider: 'rejected-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      getProviderRegistry().register({
        id: 'rejected-provider',
        refreshModels: async () => {
          throw Object.assign(new Error('credentials rejected'), { definitiveAuthFailure: true });
        },
        getCachedModels: () => [rejectedModel],
        getModels: async () => [rejectedModel],
        isAvailable: async () => true,
      } as ProviderLike);

      await initializeModels();

      expect(getModelsCache().get('global')).not.toContainEqual(rejectedModel);
    });

    it('keeps partially failed initialization stale for an automatic retry', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const healthyModel = {
        id: 'startup-healthy',
        name: 'Startup Healthy',
        family: 'test',
        provider: 'startup-healthy-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      const recoveredModel = {
        ...healthyModel,
        id: 'startup-recovered',
        name: 'Startup Recovered',
        provider: 'startup-failed-provider',
      };
      registry.register({
        id: 'startup-healthy-provider',
        getModels: async () => [healthyModel],
        isAvailable: async () => true,
      } as ProviderLike);
      registry.register({
        id: 'startup-failed-provider',
        getModels: async () => {
          throw new Error('offline');
        },
        isAvailable: async () => true,
      } as ProviderLike);

      await initializeModels();
      expect(getAvailableModels('global')).toContainEqual(healthyModel);

      registry.unregister('startup-failed-provider');
      registry.register({
        id: 'startup-failed-provider',
        getModels: async () => [recoveredModel],
        isAvailable: async () => true,
      } as ProviderLike);

      getAvailableModels('global');
      await expect.poll(() => getAvailableModels('global')).toContainEqual(recoveredModel);
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

    it('throttles automatic retries after a partial refresh failure', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const healthyModel = {
        id: 'cooldown-healthy',
        name: 'Cooldown Healthy',
        family: 'test',
        provider: 'cooldown-healthy-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      let failedCalls = 0;
      registry.register({
        id: 'cooldown-healthy-provider',
        getModels: async () => [healthyModel],
        isAvailable: async () => true,
      } as ProviderLike);
      registry.register({
        id: 'cooldown-failed-provider',
        getModels: async () => {
          failedCalls += 1;
          throw new Error('offline');
        },
        isAvailable: async () => true,
      } as ProviderLike);
      let now = 100_000;
      const dateSpy = spyOn(Date, 'now').mockImplementation(() => now);
      try {
        setModelsCache(new Map([['global', mockModels]]), now - 5 * 60 * 60 * 1000);

        getAvailableModels('global');
        await waitFor(() => failedCalls === 1);
        getAvailableModels('global');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(failedCalls).toBe(1);

        now += 30_000;
        getAvailableModels('global');
        await waitFor(() => failedCalls === 2);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it('installs and caches an empty catalog from a background refresh', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      let calls = 0;
      getProviderRegistry().register({
        id: 'background-empty-provider',
        getModels: async () => {
          calls += 1;
          return [];
        },
        isAvailable: async () => true,
      } as ProviderLike);
      setModelsCache(new Map([['global', mockModels]]), Date.now() - 5 * 60 * 60 * 1000);

      getAvailableModels('global');
      await waitFor(() => getModelsCache().get('global')?.length === 0);
      getAvailableModels('global');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(calls).toBe(1);
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
    it('throttles automatic retries after a foreground refresh failure', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const healthyModel = {
        id: 'foreground-cooldown-healthy',
        name: 'Foreground Cooldown Healthy',
        family: 'test',
        provider: 'foreground-healthy-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      let failedCalls = 0;
      registry.register({
        id: 'foreground-healthy-provider',
        getModels: async () => [healthyModel],
        isAvailable: async () => true,
      } as ProviderLike);
      registry.register({
        id: 'foreground-failed-provider',
        getModels: async () => {
          failedCalls += 1;
          throw new Error('offline');
        },
        isAvailable: async () => true,
      } as ProviderLike);
      let now = 100_000;
      const dateSpy = spyOn(Date, 'now').mockImplementation(() => now);
      try {
        setModelsCache(new Map([['global', mockModels]]));

        await refreshModels();
        expect(failedCalls).toBe(1);
        getAvailableModels('global');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(failedCalls).toBe(1);

        now += 30_000;
        getAvailableModels('global');
        await waitFor(() => failedCalls === 2);
      } finally {
        dateSpy.mockRestore();
      }
    });

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

    it('should accept empty catalogs when available providers return no models', async () => {
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

      expect(getModelsCache().get('global')).toEqual([]);
    });

    it('should accept a successful refresh with no models', async () => {
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

      expect(getModelsCache().get('global')).toEqual([]);
    });

    it('keeps the replacement catalog when a provider switches scope mid-refresh', async () => {
      const { AnthropicToCodexBridgeProvider } = await import(
        '../../../../src/lib/providers/anthropic-to-codex-bridge-provider'
      );
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-scope-race-'));
      const hyperneoDir = path.join(tmpRoot, 'hyperneo');
      mkdirSync(hyperneoDir, { recursive: true });
      const tokenA = makeScopeRaceJwt('acct-race-a');
      const tokenB = makeScopeRaceJwt('acct-race-b');
      writeFileSync(
        path.join(hyperneoDir, 'auth.json'),
        JSON.stringify({
          openai: {
            type: 'oauth',
            access: tokenA,
            refresh: 'refresh-a',
            accountId: 'acct-race-a',
          },
        }),
        { mode: 0o600 }
      );
      let resolveOld: ((response: Response) => void) | undefined;
      const oldResponse = new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
      const catalogFetch = mock()
        .mockImplementationOnce(
          async () =>
            new Response(JSON.stringify({ data: [{ id: 'gpt-race-a' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        )
        .mockImplementationOnce(async () => oldResponse)
        .mockImplementationOnce(
          async () =>
            new Response(JSON.stringify({ data: [{ id: 'gpt-race-replacement' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        ) as unknown as typeof fetch;
      const provider = new AnthropicToCodexBridgeProvider({}, hyperneoDir, tmpRoot, catalogFetch);
      try {
        getProviderRegistry().register(provider as unknown as ProviderLike);
        const { refreshModels } = await import('../../../../src/lib/model-service');
        await provider.getModels();
        setModelsCache(
          new Map([
            [
              'global',
              [
                {
                  id: 'gpt-race-a',
                  name: 'GPT Race A',
                  family: 'gpt',
                  provider: 'anthropic-codex',
                  contextWindow: 100000,
                },
              ],
            ],
          ])
        );

        const msRefresh = refreshModels();
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 2000;
          const check = () => {
            if (
              (catalogFetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length >= 2
            ) {
              resolve();
            } else if (Date.now() > deadline) {
              reject(new Error('second catalog fetch never started'));
            } else {
              setTimeout(check, 1);
            }
          };
          check();
        });
        provider.setCredentials({
          type: 'oauth',
          accessToken: tokenB,
          refreshToken: 'refresh-b',
          raw: { accountId: 'acct-race-b' },
        });
        resolveOld?.(new Response('unauthorized', { status: 401 }));
        await msRefresh;

        const models = getAvailableModels('global');
        expect(models.map((model) => model.id)).toContain('gpt-race-replacement');
        expect(models.map((model) => model.id)).not.toContain('gpt-race-a');
      } finally {
        provider.stopAllBridgeServers();
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('should retain models when every provider becomes unavailable', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      getProviderRegistry().register({
        id: 'logged-out-provider',
        getModels: async () => mockModels,
        isAvailable: async () => false,
      } as ProviderLike);
      setModelsCache(new Map([['global', mockModels]]));

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getModelsCache().get('global')).toEqual(mockModels);
    });

    it('should accept a successful provider catalog shrink', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const retained = {
        id: 'retained-model',
        name: 'Retained Model',
        family: 'test',
        provider: 'shrinking-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      const removed = {
        ...retained,
        id: 'removed-model',
        name: 'Removed Model',
      };
      registry.register({
        id: 'shrinking-provider',
        getModels: async () => [removed],
        refreshModels: async () => [retained],
        isAvailable: async () => true,
      } as ProviderLike);
      setModelsCache(new Map([['global', [retained, removed]]]));

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global')).toEqual([retained]);
    });

    it('should retain provider fallbacks on the first strict refresh failure', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const fallbackModel = {
        id: 'provider-fallback-model',
        name: 'Provider Fallback Model',
        family: 'test',
        provider: 'failed-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      const recoveredModel = {
        ...fallbackModel,
        id: 'provider-recovered-model',
        name: 'Provider Recovered Model',
      };
      let failRefresh = true;
      let getModelsCalls = 0;
      registry.register({
        id: 'failed-provider',
        getModels: async () => {
          getModelsCalls += 1;
          return failRefresh ? [fallbackModel] : [recoveredModel];
        },
        getCachedModels: () => [fallbackModel],
        refreshModels: async () => {
          if (failRefresh) throw new Error('offline');
          return [recoveredModel];
        },
        isAvailable: async () => true,
      } as ProviderLike);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getModelsCache().get('global')).toContainEqual(fallbackModel);
      expect(getModelsCalls).toBe(0);

      failRefresh = false;
      await refreshModels();
      expect(getAvailableModels('global')).toContainEqual(recoveredModel);
    });

    it('ignores catalog expiry from providers that become unavailable', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const healthyModel = {
        id: 'expiry-healthy-model',
        name: 'Expiry Healthy Model',
        family: 'test',
        provider: 'expiry-healthy-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      let loggedOut = false;
      let healthyCalls = 0;
      registry.register({
        id: 'expiry-healthy-provider',
        getModels: async () => {
          healthyCalls += 1;
          return [healthyModel];
        },
        isAvailable: async () => true,
      } as ProviderLike);
      registry.register({
        id: 'expiry-logged-out-provider',
        getModels: async () => [],
        refreshModels: async () => [],
        getModelCacheExpiresAt: () => Date.now() - 1000,
        isAvailable: async () => !loggedOut,
      } as ProviderLike);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();
      expect(getAvailableModels('global')).toEqual([healthyModel]);

      loggedOut = true;
      await refreshModels();

      expect(healthyCalls).toBe(2);
      getAvailableModels('global');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(healthyCalls).toBe(2);
      expect(getAvailableModels('global')).toEqual([healthyModel]);
    });

    it('refreshes in the background once a provider catalog expires', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const ttlModel = {
        id: 'ttl-model',
        name: 'TTL Model',
        family: 'test',
        provider: 'ttl-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      let refreshCalls = 0;
      let expiresAt = Date.now() + 60;
      registry.register({
        id: 'ttl-provider',
        getModels: async () => [ttlModel],
        refreshModels: async () => {
          refreshCalls += 1;
          expiresAt = Date.now() + 60;
          return [ttlModel];
        },
        getModelCacheExpiresAt: () => expiresAt,
        isAvailable: async () => true,
      } as ProviderLike);

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();
      expect(refreshCalls).toBe(1);
      expect(getAvailableModels('global')).toEqual([ttlModel]);

      await new Promise((resolve) => setTimeout(resolve, 80));
      getAvailableModels('global');
      await waitFor(() => refreshCalls === 2);
      expect(getAvailableModels('global')).toEqual([ttlModel]);

      getAvailableModels('global');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(refreshCalls).toBe(2);
    });

    it('should drop stale models when a provider credential scope changes', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const staleModel = {
        id: 'old-scope-model',
        name: 'Old Scope Model',
        family: 'test',
        provider: 'scope-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      const newScopeModel = {
        ...staleModel,
        id: 'new-scope-model',
        name: 'New Scope Model',
      };
      let catalogScope = 'scope-a';
      getProviderRegistry().register({
        id: 'scope-provider',
        getModelCatalogScope: () => catalogScope,
        refreshModels: async () => {
          catalogScope = 'scope-b';
          throw new Error('offline');
        },
        getCachedModels: () => [newScopeModel],
        isAvailable: async () => true,
      } as ProviderLike);
      setModelsCache(new Map([['global', [staleModel]]]));

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global')).toEqual([newScopeModel]);
    });

    it('should retry after every provider fails with a populated cache', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const staleModel = {
        id: 'all-failed-stale-model',
        name: 'All Failed Stale Model',
        family: 'test',
        provider: 'failed-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      const recoveredModel = {
        ...staleModel,
        id: 'all-failed-recovered-model',
        name: 'All Failed Recovered Model',
      };
      let failRefresh = true;
      registry.register({
        id: 'failed-provider',
        getModels: async () => {
          if (failRefresh) throw new Error('offline');
          return [recoveredModel];
        },
        isAvailable: async () => true,
      } as ProviderLike);
      setModelsCache(new Map([['global', [staleModel]]]));

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getModelsCache().get('global')).toEqual([staleModel]);

      failRefresh = false;
      await refreshModels();
      expect(getAvailableModels('global')).toEqual([recoveredModel]);
    });

    it('should preserve Anthropic models when SDK discovery fails', async () => {
      const { AnthropicProvider } = await import(
        '../../../../src/lib/providers/anthropic-provider'
      );
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const staleAnthropic = {
        id: 'claude-discovered-model',
        name: 'Claude Discovered Model',
        family: 'sonnet',
        provider: 'anthropic',
        contextWindow: 200000,
      } satisfies ModelInfo;
      const healthyModel = {
        id: 'healthy-model',
        name: 'Healthy Model',
        family: 'test',
        provider: 'healthy-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      const anthropic = new AnthropicProvider({ ANTHROPIC_API_KEY: 'test-key' });
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: () => ({
          interrupt: mock(async () => {}),
          supportedModels: mock(async () => {
            throw new Error('SDK unavailable');
          }),
        }),
      }));
      getProviderRegistry().register(anthropic);
      getProviderRegistry().register({
        id: 'healthy-provider',
        getModels: async () => [healthyModel],
        isAvailable: async () => true,
      } as Parameters<ReturnType<typeof getProviderRegistry>['register']>[0]);
      setModelsCache(new Map([['global', [staleAnthropic]]]));

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global')).toContainEqual(staleAnthropic);
      expect(getAvailableModels('global')).toContainEqual(healthyModel);
    });

    it('should retain only models from providers that fail during refresh', async () => {
      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];
      const registry = getProviderRegistry();
      const staleFailed = {
        id: 'stale-failed-model',
        name: 'Stale Failed Model',
        family: 'test',
        provider: 'failed-provider',
        contextWindow: 100000,
      } satisfies ModelInfo;
      const staleHealthy = {
        ...staleFailed,
        id: 'stale-healthy-model',
        name: 'Stale Healthy Model',
        provider: 'healthy-provider',
      };
      const currentHealthy = {
        ...staleHealthy,
        id: 'current-healthy-model',
        name: 'Current Healthy Model',
      };
      registry.register({
        id: 'failed-provider',
        getModels: async () => {
          throw new Error('offline');
        },
        isAvailable: async () => true,
      } as ProviderLike);
      registry.register({
        id: 'healthy-provider',
        getModels: async () => [currentHealthy],
        isAvailable: async () => true,
      } as ProviderLike);
      setModelsCache(new Map([['global', [staleFailed, staleHealthy]]]));

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      await waitFor(() => getModelsCache().get('global')?.[0]?.id === currentHealthy.id);
      expect(getModelsCache().get('global')).toEqual([currentHealthy, staleFailed]);

      const recoveredFailed = {
        ...staleFailed,
        id: 'recovered-failed-model',
        name: 'Recovered Failed Model',
      };
      registry.unregister('failed-provider');
      registry.register({
        id: 'failed-provider',
        getModels: async () => [recoveredFailed],
        isAvailable: async () => true,
      } as ProviderLike);

      await refreshModels();
      expect(getAvailableModels('global')).toEqual([currentHealthy, recoveredFailed]);
    });

    describe('getAvailableModels', () => {
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
        testCache.set(cacheKey, mockModels);
        setModelsCache(testCache, Date.now() - 5 * 60 * 60 * 1000);

        getAvailableModels(cacheKey);

        clearModelsCache('session-123');
        expect(getAvailableModels('session-123')).toEqual([]);

        await new Promise((resolve) => setTimeout(resolve, 500));

        const models = getAvailableModels(cacheKey);
        expect(models.length).toBeGreaterThan(0);
        expect(models.some((m) => m.id === 'bg-model-2')).toBe(true);
      });
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
});
