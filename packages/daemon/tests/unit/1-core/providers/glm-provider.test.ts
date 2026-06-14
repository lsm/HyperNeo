/**
 * Unit tests for GLM Provider
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GlmProvider } from '../../../../src/lib/providers/glm-provider';

describe('GlmProvider', () => {
  let provider: GlmProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original env
    originalEnv = { ...process.env };
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    provider = new GlmProvider();
  });

  afterEach(() => {
    // Restore env
    process.env = originalEnv;
  });

  describe('basic properties', () => {
    it('should have correct ID', () => {
      expect(provider.id).toBe('glm');
    });

    it('should have correct display name', () => {
      expect(provider.displayName).toBe('GLM (智谱AI)');
    });

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        streaming: true,
        extendedThinking: true,
        maxContextWindow: 1_000_000,
        functionCalling: true,
        vision: true,
        thinkingModes: 'granular',
      });
    });
  });

  describe('isAvailable', () => {
    it('should return true when GLM_API_KEY is set', () => {
      process.env.GLM_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return true when ZHIPU_API_KEY is set', () => {
      process.env.ZHIPU_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should prefer GLM_API_KEY over ZHIPU_API_KEY', () => {
      process.env.GLM_API_KEY = 'glm-key';
      process.env.ZHIPU_API_KEY = 'zhipu-key';
      expect(provider.getApiKey()).toBe('glm-key');
    });

    it('should return false when no API key is set', () => {
      delete process.env.GLM_API_KEY;
      delete process.env.ZHIPU_API_KEY;
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getModels', () => {
    it('should return GLM models when API key is available', async () => {
      process.env.GLM_API_KEY = 'test-key';

      const models = await provider.getModels();

      expect(models).toHaveLength(6);
      expect(models.map((m) => m.id)).toEqual([
        'glm-5',
        'glm-5.1',
        'glm-5.2[1m]',
        'glm-5-turbo',
        'glm-5v-turbo',
        'glm-4.7',
      ]);
    });

    it('should return empty array when API key is not available', async () => {
      delete process.env.GLM_API_KEY;
      delete process.env.ZHIPU_API_KEY;

      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('should include provider field in models', async () => {
      process.env.GLM_API_KEY = 'test-key';

      const models = await provider.getModels();

      for (const model of models) {
        expect(model.provider).toBe('glm');
      }
    });
  });

  describe('ownsModel', () => {
    it('should own glm- prefixed models', () => {
      expect(provider.ownsModel('glm-5')).toBe(true);
      expect(provider.ownsModel('glm-5-turbo')).toBe(true);
      expect(provider.ownsModel('glm-5v-turbo')).toBe(true);
      expect(provider.ownsModel('glm-4.7')).toBe(true);
      expect(provider.ownsModel('GLM-4')).toBe(true); // case insensitive
    });

    it('should not own other provider models', () => {
      expect(provider.ownsModel('default')).toBe(false);
      expect(provider.ownsModel('opus')).toBe(false);
      expect(provider.ownsModel('claude-sonnet-4-5')).toBe(false);
    });
  });

  describe('getModelForTier', () => {
    it('should map all tiers to glm-5-turbo', () => {
      expect(provider.getModelForTier('haiku')).toBe('glm-5-turbo');
      expect(provider.getModelForTier('sonnet')).toBe('glm-5-turbo');
      expect(provider.getModelForTier('opus')).toBe('glm-5-turbo');
      expect(provider.getModelForTier('default')).toBe('glm-5-turbo');
    });
  });

  describe('buildSdkConfig', () => {
    it('should build correct config for glm-5', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5');

      expect(config.envVars).toEqual({
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
      });
      expect(config.isAnthropicCompatible).toBe(true);
    });

    it('should fall back to glm-5-turbo for non-GLM model IDs', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('default');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5-turbo');
    });

    it('should route all sdk tiers to the selected model', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-4.7');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.7');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.7');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4.7');
    });

    it('should route glm-5.2 to the 1M SDK model id', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5.2');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.2[1m]');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2[1m]');
    });

    it('should set CLAUDE_CODE_AUTO_COMPACT_WINDOW per model context window', () => {
      process.env.GLM_API_KEY = 'test-key';

      // glm-5.2[1m] has a 1M context window — env var must reflect it so the
      // SDK's auto-compact threshold matches the real capacity (otherwise the
      // SDK would cap to its 200k fallback for unknown models).
      expect(provider.buildSdkConfig('glm-5.2').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        '1000000'
      );
      expect(provider.buildSdkConfig('glm-5').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        '200000'
      );
      expect(provider.buildSdkConfig('glm-5.1').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        '200000'
      );
      expect(provider.buildSdkConfig('glm-5-turbo').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        '200000'
      );
      expect(provider.buildSdkConfig('glm-5v-turbo').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        '200000'
      );
      expect(provider.buildSdkConfig('glm-4.7').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        '200000'
      );
    });

    it('should route uppercase model IDs through the same lookup as lowercase', () => {
      // Regression: without normalising case, "GLM-5.2" bypassed the
      // glm-5.2 → [1m] shortcut, fell through to verbatim routing, missed
      // the context-window lookup, and silently fell back to 200k.
      process.env.GLM_API_KEY = 'test-key';

      const upperConfig = provider.buildSdkConfig('GLM-5.2');
      const lowerConfig = provider.buildSdkConfig('glm-5.2');
      expect(upperConfig.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        lowerConfig.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL
      );
      expect(upperConfig.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
      expect(upperConfig.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        lowerConfig.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      );
      expect(upperConfig.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    });

    it('should build correct config for glm-5-turbo', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5-turbo');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5-turbo');
      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
      expect(config.isAnthropicCompatible).toBe(true);
    });

    it('should build correct config for glm-5v-turbo', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5v-turbo');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5v-turbo');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5v-turbo');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5v-turbo');
      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
      expect(config.isAnthropicCompatible).toBe(true);
    });

    it('should use session config API key override', () => {
      process.env.GLM_API_KEY = 'env-key';

      const config = provider.buildSdkConfig('glm-5', {
        apiKey: 'session-key',
      });

      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
    });

    it('should use session config baseUrl override', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5', {
        baseUrl: 'https://custom.example.com',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com');
    });

    it('should throw when no API key is configured', () => {
      delete process.env.GLM_API_KEY;
      delete process.env.ZHIPU_API_KEY;

      expect(() => provider.buildSdkConfig('glm-5')).toThrow('GLM API key not configured');
    });
  });

  describe('translateModelIdForSdk', () => {
    it('should translate glm-5 to default', () => {
      expect(provider.translateModelIdForSdk('glm-5')).toBe('default');
    });

    it('should translate glm-5-turbo to default', () => {
      expect(provider.translateModelIdForSdk('glm-5-turbo')).toBe('default');
    });

    it('should translate glm-5v-turbo to default', () => {
      expect(provider.translateModelIdForSdk('glm-5v-turbo')).toBe('default');
    });

    it('should translate other GLM models to default', () => {
      expect(provider.translateModelIdForSdk('glm-4')).toBe('default');
    });
  });

  describe('getTitleGenerationModel', () => {
    it('should return glm-5-turbo for title generation', () => {
      expect(provider.getTitleGenerationModel()).toBe('glm-5-turbo');
    });
  });

  describe('static models', () => {
    it('should have static models defined', () => {
      expect(GlmProvider.MODELS).toHaveLength(6);
      expect(GlmProvider.MODELS.map((m) => m.id)).toEqual([
        'glm-5',
        'glm-5.1',
        'glm-5.2[1m]',
        'glm-5-turbo',
        'glm-5v-turbo',
        'glm-4.7',
      ]);
    });

    it('should have correct glm-5.2 model definition', () => {
      const model = GlmProvider.MODELS.find((m) => m.id === 'glm-5.2[1m]');
      expect(model).toBeDefined();
      expect(model).toEqual({
        id: 'glm-5.2[1m]',
        name: 'GLM-5.2',
        alias: 'glm-5.2',
        family: 'glm',
        provider: 'glm',
        contextWindow: 1_000_000,
        preferContextWindowMetadata: true,
        description: 'GLM-5.2 · 1M context window, recommended thinking mode "max"',
        releaseDate: '2026-06-10',
        available: true,
      });
    });

    it('should mark every GLM model with preferContextWindowMetadata', () => {
      // GLM IDs are unknown to the SDK's PP() helper. The context-fetcher must
      // trust this metadata for the context bar instead of falling back to the
      // SDK's reported capacity (which is the generic 200k fallback for unknown
      // IDs and doesn't reflect the real GLM window).
      for (const model of GlmProvider.MODELS) {
        expect(model.preferContextWindowMetadata).toBe(true);
      }
    });

    it('should have correct glm-5-turbo model definition', () => {
      const turbo = GlmProvider.MODELS.find((m) => m.id === 'glm-5-turbo');
      expect(turbo).toBeDefined();
      expect(turbo!.name).toBe('GLM-5-Turbo');
      expect(turbo!.alias).toBe('glm-5-turbo');
      expect(turbo!.family).toBe('glm');
      expect(turbo!.provider).toBe('glm');
      expect(turbo!.contextWindow).toBe(200000);
      expect(turbo!.available).toBe(true);
    });

    it('should have correct glm-5v-turbo model definition', () => {
      const vision = GlmProvider.MODELS.find((m) => m.id === 'glm-5v-turbo');
      expect(vision).toBeDefined();
      expect(vision!.name).toBe('GLM-5V-Turbo');
      expect(vision!.alias).toBe('glm-5v-turbo');
      expect(vision!.family).toBe('glm');
      expect(vision!.provider).toBe('glm');
      expect(vision!.contextWindow).toBe(200000);
      expect(vision!.available).toBe(true);
      expect(vision!.description).toBe(
        'GLM-5V-Turbo · Vision-capable turbo model optimized for multimodal agent tasks'
      );
      expect(vision!.releaseDate).toBe('2026-05-01');
    });

    it('should have correct base URL', () => {
      expect(GlmProvider.BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    });
  });
});
