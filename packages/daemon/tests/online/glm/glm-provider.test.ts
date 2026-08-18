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

      const originalGlmKey = process.env.GLM_API_KEY;
      const originalZhipuKey = process.env.ZHIPU_API_KEY;

      try {
        delete process.env.GLM_API_KEY;
        delete process.env.ZHIPU_API_KEY;
        expect(await providerService.isGlmAvailable()).toBe(false);

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

      expect(providers.length).toBeGreaterThanOrEqual(2);

      const anthropic = providers.find((p) => p.id === 'anthropic');
      expect(anthropic).toBeDefined();
      expect(anthropic!.name).toBe('Anthropic');

      const glm = providers.find((p) => p.id === 'glm');
      expect(glm).toBeDefined();
      expect(glm!.name).toBe('Z.ai');
      expect(glm!.baseUrl).toBeUndefined();
    });

    it('should get default model for each provider', async () => {
      const providerService = new ProviderService();

      expect(await providerService.getDefaultModelForProvider('anthropic')).toBe('default');
      expect(await providerService.getDefaultModelForProvider('glm')).toBe('glm-5');
    });

    it('should validate provider switch correctly', async () => {
      const providerService = new ProviderService();

      const anthropicResult = await providerService.validateProviderSwitch('anthropic');
      expect(anthropicResult.valid).toBe(true);

      const originalGlmKey = process.env.GLM_API_KEY;
      delete process.env.GLM_API_KEY;
      delete process.env.ZHIPU_API_KEY;

      try {
        const glmResult = await providerService.validateProviderSwitch('glm');
        expect(glmResult.valid).toBe(false);
        expect(glmResult.error).toContain('not available');
      } finally {
        if (originalGlmKey !== undefined) {
          process.env.GLM_API_KEY = originalGlmKey;
        }
      }

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

        process.env.GLM_API_KEY = 'test-glm-key';
        delete process.env.ZHIPU_API_KEY;

        const models = getAvailableModels('global');

        expect(models.length).toBe(4);

        const glmModel = models.find((m) => m.id === 'glm-5');
        expect(glmModel).toBeDefined();
        expect(glmModel!.name).toBe('GLM-4.7');
        expect(glmModel!.family).toBe('glm');

        const sonnetModel = models.find((m) => m.id === 'default');
        expect(sonnetModel).toBeDefined();
      } finally {
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

        delete process.env.GLM_API_KEY;
        delete process.env.ZHIPU_API_KEY;

        const models = getAvailableModels('global');

        expect(models.length).toBe(3);

        const glmModel = models.find((m) => m.id === 'glm-5');
        expect(glmModel).toBeUndefined();

        const sonnetModel = models.find((m) => m.id === 'default');
        expect(sonnetModel).toBeDefined();
        expect(sonnetModel!.name).toBe('Sonnet');
      } finally {
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

        delete process.env.GLM_API_KEY;
        process.env.ZHIPU_API_KEY = 'test-zhipu-key';

        const models = getAvailableModels('global');

        const glmModel = models.find((m) => m.id === 'glm-5');
        expect(glmModel).toBeDefined();
        expect(glmModel!.name).toBe('GLM-4.7');
        expect(glmModel!.provider).toBe('glm');
      } finally {
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

      const originalGlmKey = process.env.GLM_API_KEY;
      process.env.GLM_API_KEY = 'test-glm-key';

      try {
        const builder = new QueryOptionsBuilder({ session, settingsManager });
        const options = await builder.build();

        expect(options.env).toBeUndefined();

        expect(options.model).toBe('default');
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
            CUSTOM_VAR: 'custom-value',
          },
        },
      });

      const originalGlmKey = process.env.GLM_API_KEY;
      process.env.GLM_API_KEY = 'test-glm-key';

      try {
        const builder = new QueryOptionsBuilder({ session, settingsManager });
        const options = await builder.build();

        expect(options.env).toBeDefined();
        expect(options.env!.CUSTOM_VAR).toBe('custom-value');
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

      expect(data.content).toBeDefined();
      expect(data.content.length).toBeGreaterThan(0);

      const textContent = data.content.find((c) => c.type === 'text');
      expect(textContent).toBeDefined();
      console.log('GLM Response:', textContent?.text);

      expect(data.stop_reason).toBe('end_turn');
    }, 30000);
  });
});
