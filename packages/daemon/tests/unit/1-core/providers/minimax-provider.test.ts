import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MinimaxProvider } from '../../../../src/lib/providers/minimax-provider';
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';

describe('MinimaxProvider', () => {
  let provider: MinimaxProvider;
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
    delete process.env.MINIMAX_API_KEY;
    resetProviderFailureStore();
    provider = new MinimaxProvider();
  });

  afterEach(() => {
    resetProviderFailureStore();
    global.fetch = originalFetch;
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

  describe('getAuthStatus', () => {
    it('should surface a recorded credential failure as unauthenticated', async () => {
      process.env.MINIMAX_API_KEY = 'invalid-key';
      recordProviderFailure('minimax', new Error('MiniMax API key rejected (HTTP 401)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(false);
      expect(status.errorKind).toBe('credential');
      expect(status.error).toBe('MiniMax API key rejected (HTTP 401)');
    });

    it('should stay authenticated but degraded for a recorded transient failure', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      recordProviderFailure('minimax', new Error('MiniMax probe failed (HTTP 503)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(true);
      expect(status.errorKind).toBe('transient');
      expect(status.error).toBe('MiniMax probe failed (HTTP 503)');
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

  describe('listRemoteModels', () => {
    function installModelListFetch(responses: unknown[]): {
      fetchMock: ReturnType<typeof mock>;
      calls: Array<[RequestInfo | URL, RequestInit | undefined]>;
    } {
      const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
      const fetchMock = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push([url, init]);
        const body = responses.shift();
        return new Response(JSON.stringify(body), { status: 200 });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      return { fetchMock, calls };
    }

    it('uses MiniMax own OpenAI model-list endpoint and bearer auth', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      const { fetchMock, calls } = installModelListFetch([
        {
          object: 'list',
          data: [
            { id: 'MiniMax-M2.7', object: 'model' },
            { id: 'MiniMax-M3', object: 'model' },
            { id: 'ignored', object: 'other' },
          ],
        },
      ]);
      provider = new MinimaxProvider();

      const models = await provider.listRemoteModels();

      expect(models[0]).toEqual(MinimaxProvider.MODELS[2]);
      expect(models[1]).toMatchObject({
        id: 'MiniMax-M3',
        name: 'MiniMax-M3',
        provider: 'minimax',
        contextWindow: 200000,
        available: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = calls[0] ?? [];
      expect(url).toBe('https://api.minimax.io/v1/models');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' });
    });

    it('uses read-only baseUrl overrides without polluting the saved endpoint cache', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      const { calls } = installModelListFetch([
        { data: [{ id: 'MiniMax-M2.7', object: 'model' }] },
        { data: [{ id: 'MiniMax-M3', object: 'model' }] },
        { data: [{ id: 'MiniMax-M2.7-highspeed', object: 'model' }] },
      ]);
      provider = new MinimaxProvider();

      await provider.listRemoteModels();
      await provider.listRemoteModels({ baseUrl: 'https://proxy.example.com/openai' });
      const forced = await provider.listRemoteModels({ force: true });

      expect(calls.map((call) => call[0])).toEqual([
        'https://api.minimax.io/v1/models',
        'https://proxy.example.com/openai/v1/models',
        'https://api.minimax.io/v1/models',
      ]);
      expect(forced[0]).toEqual(MinimaxProvider.MODELS[3]);
    });

    it('caches successful discovery and force bypasses the cache', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      const { fetchMock } = installModelListFetch([
        { data: [{ id: 'MiniMax-M2.7', object: 'model' }] },
        { data: [{ id: 'MiniMax-M3', object: 'model' }] },
      ]);
      provider = new MinimaxProvider();

      const first = await provider.listRemoteModels();
      const cached = await provider.listRemoteModels();
      const forced = await provider.listRemoteModels({ force: true });

      expect(first).toEqual(cached);
      expect(forced[0]?.id).toBe('MiniMax-M3');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('propagates forced discovery failures instead of serving the cached list', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      let calls = 0;
      global.fetch = mock(async () => {
        calls++;
        return calls === 1
          ? new Response(JSON.stringify({ data: [{ id: 'MiniMax-M2.7' }] }), { status: 200 })
          : new Response('unavailable', { status: 502 });
      }) as unknown as typeof fetch;
      provider = new MinimaxProvider();

      await provider.listRemoteModels();

      await expect(provider.listRemoteModels({ force: true })).rejects.toThrow(
        'Endpoint returned HTTP 502'
      );
    });

    it('rejects discovery without credentials', async () => {
      await expect(provider.listRemoteModels()).rejects.toThrow('MiniMax API key not configured');
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

    it('should have provider-specific message and model-list base URLs', () => {
      expect(MinimaxProvider.BASE_URL).toBe('https://api.minimax.io/anthropic');
      expect(MinimaxProvider.MODEL_LIST_BASE_URL).toBe('https://api.minimax.io/v1');
    });
  });
});
