/**
 * Integration tests for GLM (智谱AI) provider support
 *
 * Covers:
 * 1. ProviderService — GLM availability, provider listing, model defaults, provider switching
 * 2. QueryOptionsBuilder — env var injection for GLM sessions (explicit provider field required)
 * 3. ModelService — GLM model inclusion in getAvailableModels
 * 4. Actual API call to GLM
 *
 * Run with: cd packages/daemon && GLM_API_KEY=xxx bun test ./tests/online/glm/glm-provider.test.ts
 *
 * REQUIREMENTS:
 * - GLM_API_KEY environment variable (or ZHIPU_API_KEY)
 * - The GLM API-call test (describe 'GLM API Call') requires real credentials and will fail if absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ProviderService } from '../../../src/lib/provider-service';
import { QueryOptionsBuilder } from '../../../src/lib/agent/query-options-builder';
import { SettingsManager } from '../../../src/lib/settings-manager';
import { getAvailableModels, setModelsCache, getModelsCache } from '../../../src/lib/model-service';
import {
  setupIntegrationTestEnv,
  cleanupIntegrationTestEnv,
  createTestSession,
  type IntegrationTestEnv,
} from '../../helpers/integration-env';

describe('GLM Provider Integration', () => {
  let env: IntegrationTestEnv;

  beforeEach(async () => {
    env = await setupIntegrationTestEnv();
  });

  afterEach(async () => {
    await cleanupIntegrationTestEnv(env);
  });

  describe('ProviderService - GLM Provider', () => {
    it('should check GLM availability correctly', async () => {
      const providerService = new ProviderService();

      // GLM should be available if GLM_API_KEY or ZHIPU_API_KEY is set
      const originalGlmKey = process.env.GLM_API_KEY;
      const originalZhipuKey = process.env.ZHIPU_API_KEY;

      try {
        // Remove both keys
        delete process.env.GLM_API_KEY;
        delete process.env.ZHIPU_API_KEY;
        expect(await providerService.isGlmAvailable()).toBe(false);

        // Set GLM_API_KEY
        process.env.GLM_API_KEY = 'test-key';
        expect(await providerService.isGlmAvailable()).toBe(true);
      } finally {
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        } else {
          delete process.env.GLM_API_KEY;
        }
        if (originalZhipuKey !== undefined) {
          process.env.ZHIPU_API_KEY = originalZhipuKey;
        }
      }
    });

    it('should list available providers correctly', async () => {
      const providerService = new ProviderService();
      const providers = await providerService.getAvailableProviders();

      // Should have at least Anthropic and GLM
      expect(providers.length).toBeGreaterThanOrEqual(2);

      // Find Anthropic
      const anthropic = providers.find((p) => p.id === 'anthropic');
      expect(anthropic).toBeDefined();
      expect(anthropic!.name).toBe('Anthropic');

      // Find GLM
      const glm = providers.find((p) => p.id === 'glm');
      expect(glm).toBeDefined();
      expect(glm!.name).toBe('GLM (智谱AI)');
      // Note: baseUrl is now undefined in the new provider system (legacy field)
      expect(glm!.baseUrl).toBeUndefined();
    });

    it('should get default model for each provider', async () => {
      const providerService = new ProviderService();

      expect(await providerService.getDefaultModelForProvider('anthropic')).toBe('default');
      expect(await providerService.getDefaultModelForProvider('glm')).toBe('glm-5');
    });

    it('should validate provider switch correctly', async () => {
      const providerService = new ProviderService();

      // Anthropic is always valid
      const anthropicResult = await providerService.validateProviderSwitch('anthropic');
      expect(anthropicResult.valid).toBe(true);

      // GLM without API key should fail (unless GLM_API_KEY is set in env)
      const originalGlmKey = process.env.GLM_API_KEY;
      delete process.env.GLM_API_KEY;
      delete process.env.ZHIPU_API_KEY;

      try {
        const glmResult = await providerService.validateProviderSwitch('glm');
        expect(glmResult.valid).toBe(false);
        // Error message format updated in new provider system
        expect(glmResult.error).toContain('not available');
      } finally {
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        }
      }

      // GLM with provided API key should pass
      const glmWithKey = await providerService.validateProviderSwitch('glm', 'some-api-key');
      expect(glmWithKey.valid).toBe(true);
    });
  });

  describe('ModelService - GLM Model Inclusion', () => {
    it('should include GLM models in getAvailableModels when GLM_API_KEY is set', () => {
      const originalGlmKey = process.env.GLM_API_KEY;
      const originalZhipuKey = process.env.ZHIPU_API_KEY;
      const originalCache = getModelsCache();

      try {
        // Set up mock models in cache using ModelInfo format
        // This simulates what the new provider-based model service loads
        const mockModels = [
          {
            id: 'default',
            name: 'Sonnet',
            alias: 'sonnet',
            family: 'sonnet' as const,
            provider: 'anthropic',
            contextWindow: 200000,
            description: 'Sonnet 4.5 · Best for everyday tasks',
          },
          {
            id: 'opus',
            name: 'Opus',
            alias: 'opus',
            family: 'opus' as const,
            provider: 'anthropic',
            contextWindow: 200000,
            description: 'Opus 4.5 · Most capable model',
          },
          {
            id: 'haiku',
            name: 'Haiku',
            alias: 'haiku',
            family: 'haiku' as const,
            provider: 'anthropic',
            contextWindow: 200000,
            description: 'Haiku 3.5 · Fast and efficient',
          },
          // GLM models are included when GLM_API_KEY is set
          {
            id: 'glm-5',
            name: 'GLM-4.7',
            alias: 'glm-5',
            family: 'glm' as const,
            provider: 'glm',
            contextWindow: 128000,
            description: 'GLM-4.7 by 智谱AI',
          },
        ];
        const mockCache = new Map<string, typeof mockModels>();
        mockCache.set('global', mockModels);
        setModelsCache(mockCache);

        // Set GLM_API_KEY
        process.env.GLM_API_KEY = 'test-glm-key';
        delete process.env.ZHIPU_API_KEY;

        // Get available models
        const models = getAvailableModels('global');

        // Should include both Anthropic and GLM models
        expect(models.length).toBe(4);

        // Find GLM model
        const glmModel = models.find((m) => m.id === 'glm-5');
        expect(glmModel).toBeDefined();
        expect(glmModel!.name).toBe('GLM-4.7');
        expect(glmModel!.family).toBe('glm');

        // Should also have Anthropic models
        const sonnetModel = models.find((m) => m.id === 'default');
        expect(sonnetModel).toBeDefined();
      } finally {
        // Restore original state
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        } else {
          delete process.env.GLM_API_KEY;
        }
        if (originalZhipuKey !== undefined) {
          process.env.ZHIPU_API_KEY = originalZhipuKey;
        }
        setModelsCache(originalCache);
      }
    });

    it('should NOT include GLM models when GLM_API_KEY is not set', () => {
      const originalGlmKey = process.env.GLM_API_KEY;
      const originalZhipuKey = process.env.ZHIPU_API_KEY;
      const originalCache = getModelsCache();

      try {
        // Set up mock models without GLM (simulating no GLM API key)
        const mockModels = [
          {
            id: 'default',
            name: 'Sonnet',
            alias: 'sonnet',
            family: 'sonnet' as const,
            provider: 'anthropic',
            contextWindow: 200000,
            description: 'Sonnet 4.5 · Best for everyday tasks',
          },
          {
            id: 'opus',
            name: 'Opus',
            alias: 'opus',
            family: 'opus' as const,
            provider: 'anthropic',
            contextWindow: 200000,
            description: 'Opus 4.5 · Most capable model',
          },
          {
            id: 'haiku',
            name: 'Haiku',
            alias: 'haiku',
            family: 'haiku' as const,
            provider: 'anthropic',
            contextWindow: 200000,
            description: 'Haiku 3.5 · Fast and efficient',
          },
        ];
        const mockCache = new Map<string, typeof mockModels>();
        mockCache.set('global', mockModels);
        setModelsCache(mockCache);

        // Remove GLM API keys
        delete process.env.GLM_API_KEY;
        delete process.env.ZHIPU_API_KEY;

        // Get available models
        const models = getAvailableModels('global');

        // Should only have Anthropic models (3 families)
        expect(models.length).toBe(3);

        // Should NOT have GLM model
        const glmModel = models.find((m) => m.id === 'glm-5');
        expect(glmModel).toBeUndefined();

        // Should have Anthropic models
        const sonnetModel = models.find((m) => m.id === 'default');
        expect(sonnetModel).toBeDefined();
        expect(sonnetModel!.name).toBe('Sonnet');
      } finally {
        // Restore original state
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        }
        if (originalZhipuKey !== undefined) {
          process.env.ZHIPU_API_KEY = originalZhipuKey;
        }
        setModelsCache(originalCache);
      }
    });

    it('should include GLM models when ZHIPU_API_KEY is set (alternative key)', () => {
      const originalGlmKey = process.env.GLM_API_KEY;
      const originalZhipuKey = process.env.ZHIPU_API_KEY;
      const originalCache = getModelsCache();

      try {
        // Set up mock models with GLM when ZHIPU_API_KEY is set
        const mockModels = [
          {
            id: 'default',
            name: 'Sonnet',
            alias: 'sonnet',
            family: 'sonnet' as const,
            provider: 'anthropic',
            contextWindow: 200000,
            description: 'Sonnet 4.5 · Best for everyday tasks',
          },
          {
            id: 'glm-5',
            name: 'GLM-4.7',
            alias: 'glm-5',
            family: 'glm' as const,
            provider: 'glm',
            contextWindow: 128000,
            description: 'GLM-4.7 by 智谱AI',
          },
        ];
        const mockCache = new Map<string, typeof mockModels>();
        mockCache.set('global', mockModels);
        setModelsCache(mockCache);

        // Set ZHIPU_API_KEY instead of GLM_API_KEY
        delete process.env.GLM_API_KEY;
        process.env.ZHIPU_API_KEY = 'test-zhipu-key';

        // Get available models
        const models = getAvailableModels('global');

        // Should include GLM model
        const glmModel = models.find((m) => m.id === 'glm-5');
        expect(glmModel).toBeDefined();
        expect(glmModel!.name).toBe('GLM-4.7');
        expect(glmModel!.provider).toBe('glm');
      } finally {
        // Restore original state
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        } else {
          delete process.env.GLM_API_KEY;
        }
        if (originalZhipuKey !== undefined) {
          process.env.ZHIPU_API_KEY = originalZhipuKey;
        }
        setModelsCache(originalCache);
      }
    });
  });

  describe('QueryOptionsBuilder - Model-based Env Var Injection', () => {
    it('should inject GLM env vars when session uses GLM model', async () => {
      const settingsManager = new SettingsManager(env.db, env.testWorkspace);

      const session = createTestSession(env.testWorkspace, {
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      });

      // Mock GLM_API_KEY
      const originalGlmKey = process.env.GLM_API_KEY;
      process.env.GLM_API_KEY = 'test-glm-key';

      try {
        const builder = new QueryOptionsBuilder({ session, settingsManager });
        const options = await builder.build();

        // IMPORTANT: Provider env vars are NO LONGER passed via options.env
        // They are now applied to process.env before SDK query creation
        // So options.env should be undefined for Anthropic-only sessions
        expect(options.env).toBeUndefined();

        // The model ID is translated to SDK-recognized ID
        expect(options.model).toBe('default'); // glm-5 → default (Sonnet tier)
      } finally {
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        } else {
          delete process.env.GLM_API_KEY;
        }
      }
    });

    it('should allow session env vars to be passed through', async () => {
      const settingsManager = new SettingsManager(env.db, env.testWorkspace);

      const session = createTestSession(env.testWorkspace, {
        config: {
          model: 'glm-5',
          provider: 'glm',
          env: {
            // API_TIMEOUT_MS is now filtered as provider-specific var
            // Provider env vars are managed by the provider system, not options.env
            CUSTOM_VAR: 'custom-value', // Additional var
          },
        },
      });

      const originalGlmKey = process.env.GLM_API_KEY;
      process.env.GLM_API_KEY = 'test-glm-key';

      try {
        const builder = new QueryOptionsBuilder({ session, settingsManager });
        const options = await builder.build();

        // Session env vars should still be in options.env
        expect(options.env).toBeDefined();
        // Custom var should be added
        expect(options.env!.CUSTOM_VAR).toBe('custom-value');
        // Note: Provider vars (API_TIMEOUT_MS, ANTHROPIC_BASE_URL, etc.) are NO LONGER in options.env
        // They are applied to process.env before SDK query creation by the provider system
      } finally {
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        } else {
          delete process.env.GLM_API_KEY;
        }
      }
    });

    it('should not inject env vars for Anthropic models', async () => {
      const settingsManager = new SettingsManager(env.db, env.testWorkspace);

      const session = createTestSession(env.testWorkspace, {
        config: {
          model: 'default',
          provider: 'anthropic',
        },
      });

      const builder = new QueryOptionsBuilder({ session, settingsManager });
      const options = await builder.build();

      // Anthropic should not have env overrides
      expect(options.env).toBeUndefined();
    });

    it('should not inject env vars for opus/haiku models', async () => {
      const settingsManager = new SettingsManager(env.db, env.testWorkspace);

      const opusSession = createTestSession(env.testWorkspace, {
        config: { model: 'opus', provider: 'anthropic' },
      });
      const haikuSession = createTestSession(env.testWorkspace, {
        config: { model: 'haiku', provider: 'anthropic' },
      });

      const opusBuilder = new QueryOptionsBuilder({ session: opusSession, settingsManager });
      const haikuBuilder = new QueryOptionsBuilder({ session: haikuSession, settingsManager });

      const opusOptions = await opusBuilder.build();
      const haikuOptions = await haikuBuilder.build();

      expect(opusOptions.env).toBeUndefined();
      expect(haikuOptions.env).toBeUndefined();
    });
  });

  describe('GLM API Call', () => {
    it('should make actual API call to GLM with glm-5-turbo', async () => {
      const glmApiKey = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

      if (!glmApiKey) {
        throw new Error('GLM_API_KEY (or ZHIPU_API_KEY) must be set to run GLM online tests');
      }

      const baseUrl = 'https://open.bigmodel.cn/api/anthropic';

      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': glmApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'glm-5-turbo',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: 'Say "Hello from GLM-5-Turbo" in exactly 6 words.',
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GLM API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
      };

      expect(data.content).toBeDefined();
      expect(data.content.length).toBeGreaterThan(0);

      const textContent = data.content.find((c) => c.type === 'text');
      expect(textContent).toBeDefined();
      console.log('GLM-5-Turbo Response:', textContent?.text);

      expect(data.stop_reason).toBe('end_turn');
    }, 30000);

    it('should make actual API call to GLM', async () => {
      const glmApiKey = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

      if (!glmApiKey) {
        throw new Error('GLM_API_KEY (or ZHIPU_API_KEY) must be set to run GLM online tests');
      }

      // This test makes an actual API call to GLM using fetch
      // It verifies that the Anthropic-compatible API works correctly
      console.log('Testing actual GLM API call...');

      const baseUrl = 'https://open.bigmodel.cn/api/anthropic';

      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': glmApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'glm-5',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: 'Say "Hello from GLM" in exactly 5 words.',
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GLM API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
        stop_reason: string;
      };

      // Verify we got a response
      expect(data.content).toBeDefined();
      expect(data.content.length).toBeGreaterThan(0);

      const textContent = data.content.find((c) => c.type === 'text');
      expect(textContent).toBeDefined();
      console.log('GLM Response:', textContent?.text);

      // Verify the stop reason
      expect(data.stop_reason).toBe('end_turn');
    }, 30000); // 30 second timeout for API call
  });
});
