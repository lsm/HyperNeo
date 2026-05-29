/**
 * Unit tests for Kimi Provider
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider';

describe('KimiProvider', () => {
  let provider: KimiProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    provider = new KimiProvider();
  });

  afterEach(async () => {
    await provider.shutdown();
    process.env = originalEnv;
  });

  describe('basic properties', () => {
    it('should have correct ID and display name', () => {
      expect(provider.id).toBe('kimi');
      expect(provider.displayName).toBe('Kimi (Moonshot AI)');
    });

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        streaming: true,
        extendedThinking: true,
        maxContextWindow: 262144,
        functionCalling: true,
        vision: false,
        thinkingModes: 'on',
      });
    });
  });

  describe('isAvailable', () => {
    it('should return true when KIMI_API_KEY is set', () => {
      process.env.KIMI_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return true when MOONSHOT_API_KEY is set', () => {
      process.env.MOONSHOT_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should prefer KIMI_API_KEY over MOONSHOT_API_KEY', () => {
      process.env.KIMI_API_KEY = 'kimi-key';
      process.env.MOONSHOT_API_KEY = 'moonshot-key';
      expect(provider.getApiKey()).toBe('kimi-key');
    });

    it('should prefer env API keys over stored credentials', () => {
      provider.setCredentials({ type: 'api_key', apiKey: 'stored-key' });
      process.env.KIMI_API_KEY = 'env-key';

      expect(provider.getApiKey()).toBe('env-key');
    });

    it('should return false when no API key is set', () => {
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getModels', () => {
    it('should return Kimi models when API key is available', async () => {
      process.env.KIMI_API_KEY = 'test-key';

      const models = await provider.getModels();

      expect(models.map((m) => m.id)).toEqual(['kimi-for-coding']);
      expect(models.every((m) => m.provider === 'kimi')).toBe(true);
    });

    it('should return empty array when API key is not available', async () => {
      const models = await provider.getModels();
      expect(models).toEqual([]);
    });
  });

  describe('ownsModel', () => {
    it('should own kimi and moonshot model IDs', () => {
      expect(provider.ownsModel('kimi')).toBe(true);
      expect(provider.ownsModel('kimi-for-coding')).toBe(true);
      expect(provider.ownsModel('Kimi')).toBe(true);
      expect(provider.ownsModel('Kimi-For-Coding')).toBe(true);
      expect(provider.ownsModel('moonshot-v1-32k')).toBe(true);
    });

    it('should not own other provider models', () => {
      expect(provider.ownsModel('default')).toBe(false);
      expect(provider.ownsModel('glm-5')).toBe(false);
      expect(provider.ownsModel('claude-sonnet-4-5')).toBe(false);
    });
  });

  describe('getModelForTier', () => {
    it('should map all tiers to default Kimi model', () => {
      expect(provider.getModelForTier('haiku')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('sonnet')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('opus')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('default')).toBe('kimi-for-coding');
    });
  });

  describe('buildSdkConfig', () => {
    it('should build direct-connect config for kimi-for-coding', () => {
      process.env.KIMI_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('kimi-for-coding');

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
      expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
      expect(config.envVars.API_TIMEOUT_MS).toBe('3000000');
      expect(config.envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(config.isAnthropicCompatible).toBe(true);
      expect(config.apiVersion).toBe('v1');
    });

    it('should normalize aliases to kimi-for-coding', () => {
      process.env.KIMI_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('kimi');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
    });

    it('should normalize mixed-case aliases to kimi-for-coding', () => {
      process.env.KIMI_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('Kimi');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
    });

    it('should normalize moonshot- prefixed model IDs to kimi-for-coding', () => {
      process.env.KIMI_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('moonshot-v1-32k');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
    });

    it('should use session config API key and base URL overrides', () => {
      process.env.KIMI_API_KEY = 'env-key';

      const config = provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'session-key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
    });

    it('should throw when no API key is configured', () => {
      expect(() => provider.buildSdkConfig('kimi-for-coding')).toThrow(
        'Kimi API key not configured'
      );
    });
  });

  describe('translateModelIdForSdk', () => {
    it('should translate Kimi models to default', () => {
      expect(provider.translateModelIdForSdk('kimi-for-coding')).toBe('default');
    });
  });

  describe('static models', () => {
    it('should have correct static model definitions', () => {
      expect(KimiProvider.BASE_URL).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.MODELS).toHaveLength(1);
      expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-for-coding')?.contextWindow).toBe(
        262144
      );
    });
  });

  describe('getTitleGenerationModel', () => {
    it('should return kimi-for-coding', () => {
      expect(provider.getTitleGenerationModel()).toBe('kimi-for-coding');
    });
  });

  describe('getAuthStatus', () => {
    it('should return authenticated when API key is set', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const status = await provider.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.method).toBe('api_key');
      expect(status.error).toBeUndefined();
    });

    it('should return not authenticated when no API key', async () => {
      const status = await provider.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.error).toContain('KIMI_API_KEY');
    });
  });

  describe('shutdown', () => {
    it('should resolve without error', async () => {
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });
  });
});
