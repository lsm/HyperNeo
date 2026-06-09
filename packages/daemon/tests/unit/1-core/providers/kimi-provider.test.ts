/**
 * Unit tests for Kimi Provider
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider';
import type {
  AnthropicMessagesBridgeServer,
  AnthropicMessagesBridgeConfig,
} from '../../../../src/lib/providers/anthropic-messages-bridge/server';

/**
 * Fake bridge factory that records calls and returns a stub server.
 * Avoids binding real TCP ports in unit tests.
 */
function createFakeBridgeFactory() {
  const calls: AnthropicMessagesBridgeConfig[] = [];
  let portCounter = 42000;
  const servers: { port: number; stop: () => void }[] = [];

  const factory = (config: AnthropicMessagesBridgeConfig): AnthropicMessagesBridgeServer => {
    calls.push(config);
    const port = portCounter++;
    const server = { port, stop: mock(() => {}) };
    servers.push(server);
    return server;
  };

  return { factory, calls, servers };
}

describe('KimiProvider', () => {
  let provider: KimiProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(async () => {
    await provider.shutdown();
    process.env = originalEnv;
  });

  describe('basic properties', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

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
    beforeEach(() => {
      provider = new KimiProvider();
    });

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
    beforeEach(() => {
      provider = new KimiProvider();
    });

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
    beforeEach(() => {
      provider = new KimiProvider();
    });

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
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should map all tiers to default Kimi model', () => {
      expect(provider.getModelForTier('haiku')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('sonnet')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('opus')).toBe('kimi-for-coding');
      expect(provider.getModelForTier('default')).toBe('kimi-for-coding');
    });
  });

  describe('buildSdkConfig', () => {
    it('should start bridge and route through it', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      const config = provider.buildSdkConfig('kimi-for-coding');

      // Bridge was started with correct config
      expect(calls).toHaveLength(1);
      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
      expect(calls[0].apiKey).toBe('test-key');
      expect(calls[0].models).toEqual([
        {
          id: 'kimi-for-coding',
          display_name: 'Kimi For Coding',
          context_window: 262144,
          max_tokens: 32768,
        },
      ]);

      // SDK routes through the bridge
      expect(config.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Follow Codex pattern: ANTHROPIC_API_KEY sentinel, no ANTHROPIC_AUTH_TOKEN
      expect(config.envVars.ANTHROPIC_API_KEY).toBe('kimi-bridge');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(config.envVars.API_TIMEOUT_MS).toBe('3000000');
      expect(config.envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(config.isAnthropicCompatible).toBe(true);
      expect(config.apiVersion).toBe('v1');
    });

    it('should reuse the same bridge for identical credentials', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding');
      provider.buildSdkConfig('kimi-for-coding');

      // Only one bridge started
      expect(calls).toHaveLength(1);
    });

    it('should create separate bridges for different API keys', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-a' });
      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-b' });

      expect(calls).toHaveLength(2);
      expect(calls[0].apiKey).toBe('key-a');
      expect(calls[1].apiKey).toBe('key-b');
    });

    it('should create separate bridges for different base URLs', () => {
      const { factory, calls } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        baseUrl: 'https://api.kimi.com/coding',
      });
      provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(calls).toHaveLength(2);
      expect(calls[0].baseUrl).toBe('https://api.kimi.com/coding');
      expect(calls[1].baseUrl).toBe('https://api.moonshot.cn/anthropic');
    });

    it('should normalize aliases to kimi-for-coding', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      const config = provider.buildSdkConfig('kimi');

      expect(calls[0].models![0].id).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
    });

    it('should normalize mixed-case aliases to kimi-for-coding', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('Kimi');

      expect(calls[0].models![0].id).toBe('kimi-for-coding');
    });

    it('should normalize moonshot- prefixed model IDs to kimi-for-coding', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('moonshot-v1-32k');

      expect(calls[0].models![0].id).toBe('kimi-for-coding');
    });

    it('should use session config API key and base URL overrides', () => {
      const { factory, calls } = createFakeBridgeFactory();
      process.env.KIMI_API_KEY = 'env-key';
      provider = new KimiProvider(process.env, factory);

      const config = provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'session-key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(calls[0].baseUrl).toBe('https://api.moonshot.cn/anthropic');
      expect(calls[0].apiKey).toBe('session-key');
      // Auth is handled by the bridge, not passed through env vars
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it('should throw when no API key is configured', () => {
      const { factory } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      expect(() => provider.buildSdkConfig('kimi-for-coding')).toThrow(
        'Kimi API key not configured'
      );
    });
  });

  describe('translateModelIdForSdk', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should translate Kimi models to default', () => {
      expect(provider.translateModelIdForSdk('kimi-for-coding')).toBe('default');
    });
  });

  describe('static models', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should have correct static model definitions', () => {
      expect(KimiProvider.BASE_URL).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.MODELS).toHaveLength(1);
      expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-for-coding')?.contextWindow).toBe(
        262144
      );
    });
  });

  describe('getTitleGenerationModel', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return kimi-for-coding', () => {
      expect(provider.getTitleGenerationModel()).toBe('kimi-for-coding');
    });
  });

  describe('getAuthStatus', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

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
    it('should stop all bridge servers on shutdown', async () => {
      const { factory, servers } = createFakeBridgeFactory();
      provider = new KimiProvider(process.env, factory);

      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-a' });
      provider.buildSdkConfig('kimi-for-coding', { apiKey: 'key-b' });
      expect(servers).toHaveLength(2);

      await provider.shutdown();
      expect(servers[0].stop).toHaveBeenCalled();
      expect(servers[1].stop).toHaveBeenCalled();
    });

    it('should resolve without error when no bridge was started', async () => {
      provider = new KimiProvider();
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });
  });
});
