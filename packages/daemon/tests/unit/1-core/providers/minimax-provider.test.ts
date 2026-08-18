import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MinimaxProvider } from '../../../../src/lib/providers/minimax-provider';

describe('MinimaxProvider', () => {
  let provider: MinimaxProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.MINIMAX_API_KEY;
    provider = new MinimaxProvider();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('basic properties', () => {
    it('should have correct ID', () => {
      expect(provider.id).toBe('minimax');
    });

    it('should have correct display name', () => {
      expect(provider.displayName).toBe('MiniMax');
    });

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        streaming: true,
        extendedThinking: false,
        maxContextWindow: 200000,
        functionCalling: true,
        vision: true,
        thinkingModes: 'off',
      });
    });
  });

  describe('isAvailable', () => {
    it('should return true when MINIMAX_API_KEY is set', () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when no API key is set', () => {
      delete process.env.MINIMAX_API_KEY;
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getModels', () => {
    function makeProbeOkProvider(): MinimaxProvider {
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      return new MinimaxProvider(process.env, fetchImpl);
    }

    it('should return MiniMax models when API key is available', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      provider = makeProbeOkProvider();

      const models = await provider.getModels();

      expect(models).toHaveLength(4);
      expect(models.map((m) => m.id)).toEqual([
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
      ]);
    });

    it('should return empty array when API key is not available', async () => {
      delete process.env.MINIMAX_API_KEY;
      provider = makeProbeOkProvider();

      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('should include provider field in models', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      provider = makeProbeOkProvider();

      const models = await provider.getModels();

      for (const model of models) {
        expect(model.provider).toBe('minimax');
      }
    });

    it('probes the upstream Anthropic-compatible endpoint with the API key', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new MinimaxProvider(process.env, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.minimax.io/anthropic/v1/messages');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers['authorization']).toBe('Bearer test-key');
    });

    it('throws when upstream rejects the API key (403)', async () => {
      process.env.MINIMAX_API_KEY = 'bad-key';
      const fetchImpl = mock(
        async () => new Response('forbidden', { status: 403 })
      ) as unknown as typeof fetch;
      provider = new MinimaxProvider(process.env, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('MiniMax API key rejected (HTTP 403)');
    });

    it('throws when probe fails at the network layer', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      const fetchImpl = mock(async () => {
        throw new Error('ETIMEDOUT');
      }) as unknown as typeof fetch;
      provider = new MinimaxProvider(process.env, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('MiniMax probe failed: ETIMEDOUT');
    });

    it('caches successful probe for 30s so repeated calls do not re-probe', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new MinimaxProvider(process.env, fetchImpl);

      await provider.getModels();
      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('ownsModel', () => {
    it('should own minimax- prefixed models', () => {
      expect(provider.ownsModel('MiniMax-M2.5')).toBe(true);
      expect(provider.ownsModel('MiniMax-M2.5-highspeed')).toBe(true);
      expect(provider.ownsModel('MiniMax-M2.7')).toBe(true);
      expect(provider.ownsModel('MiniMax-M2.7-highspeed')).toBe(true);
      expect(provider.ownsModel('minimax-m2.5')).toBe(true);
    });

    it('should not own other provider models', () => {
      expect(provider.ownsModel('default')).toBe(false);
      expect(provider.ownsModel('opus')).toBe(false);
      expect(provider.ownsModel('glm-5')).toBe(false);
    });
  });

  describe('getModelForTier', () => {
    it('should map all tiers to MiniMax-M2.7', () => {
      expect(provider.getModelForTier('haiku')).toBe('MiniMax-M2.7');
      expect(provider.getModelForTier('sonnet')).toBe('MiniMax-M2.7');
      expect(provider.getModelForTier('opus')).toBe('MiniMax-M2.7');
      expect(provider.getModelForTier('default')).toBe('MiniMax-M2.7');
    });
  });

  describe('buildSdkConfig', () => {
    it('should build correct config for MiniMax-M2.5', () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('MiniMax-M2.5');

      expect(config.envVars).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_API_KEY: '',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.5',
      });
      expect(config.isAnthropicCompatible).toBe(true);
    });

    it('should route to MiniMax-M2.7 when that model is selected', () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('MiniMax-M2.7');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7');
    });

    it('should route to MiniMax-M2.7-highspeed when that model is selected', () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('MiniMax-M2.7-highspeed');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7-highspeed');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7-highspeed');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7-highspeed');
    });

    it('should route to MiniMax-M2.5-highspeed when that model is selected', () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('MiniMax-M2.5-highspeed');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5-highspeed');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.5-highspeed');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.5-highspeed');
    });

    it('should fall back to MiniMax-M2.7 for unrecognised model IDs', () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('unknown-model');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7');
    });

    it('should use session config API key override', () => {
      process.env.MINIMAX_API_KEY = 'env-key';

      const config = provider.buildSdkConfig('MiniMax-M2.5', {
        apiKey: 'session-key',
      });

      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
    });

    it('should use session config baseUrl override', () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('MiniMax-M2.5', {
        baseUrl: 'https://custom.example.com',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com');
    });

    it('should throw when no API key is configured', () => {
      delete process.env.MINIMAX_API_KEY;

      expect(() => provider.buildSdkConfig('MiniMax-M2.5')).toThrow(
        'MiniMax API key not configured'
      );
    });
  });

  describe('translateModelIdForSdk', () => {
    it('should translate MiniMax-M2.7 to default', () => {
      expect(provider.translateModelIdForSdk('MiniMax-M2.7')).toBe('default');
    });
  });

  describe('getTitleGenerationModel', () => {
    it('should return MiniMax-M2.7 for title generation', () => {
      expect(provider.getTitleGenerationModel()).toBe('MiniMax-M2.7');
    });
  });

  describe('static models', () => {
    it('should have static models defined', () => {
      expect(MinimaxProvider.MODELS).toHaveLength(4);
      expect(MinimaxProvider.MODELS.map((m) => m.id)).toEqual([
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
      ]);
    });

    it('should have MiniMax-M2.7 with correct properties', () => {
      const model = MinimaxProvider.MODELS.find((m) => m.id === 'MiniMax-M2.7');
      expect(model).toBeDefined();
      expect(model?.alias).toBe('minimax-m27');
      expect(model?.family).toBe('minimax');
      expect(model?.provider).toBe('minimax');
      expect(model?.contextWindow).toBe(200000);
      expect(model?.available).toBe(true);
    });

    it('should have MiniMax-M2.7-highspeed with correct properties', () => {
      const model = MinimaxProvider.MODELS.find((m) => m.id === 'MiniMax-M2.7-highspeed');
      expect(model).toBeDefined();
      expect(model?.alias).toBe('minimax-m27-fast');
      expect(model?.family).toBe('minimax');
      expect(model?.provider).toBe('minimax');
      expect(model?.contextWindow).toBe(200000);
      expect(model?.available).toBe(true);
    });

    it('should have correct base URL', () => {
      expect(MinimaxProvider.BASE_URL).toBe('https://api.minimax.io/anthropic');
    });
  });
});
