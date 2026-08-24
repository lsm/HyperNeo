import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { GlmProvider } from '../../../../src/lib/providers/glm-provider';
import { PROVIDER_DISCOVERY_CACHE_TTL_MS } from '../../../../src/lib/providers/shared/discovery-cache';
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';

describe('GlmProvider', () => {
  const originalFetch = global.fetch;
  let provider: GlmProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    resetProviderFailureStore();
    provider = new GlmProvider();
  });

  afterEach(() => {
    resetProviderFailureStore();
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  describe('basic properties', () => {
    it('should have correct ID', () => {
      expect(provider.id).toBe('glm');
    });

    it('should have correct display name', () => {
      expect(provider.displayName).toBe('Z.ai');
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

  describe('getAuthStatus', () => {
    it('reports plain key presence when no failure is recorded', async () => {
      process.env.GLM_API_KEY = 'test-key';

      const status = await provider.getAuthStatus();

      expect(status).toEqual({
        isAuthenticated: true,
        method: 'api_key',
        error: undefined,
      });
    });

    it('reports a credential failure as unauthenticated with the failure message', async () => {
      process.env.GLM_API_KEY = 'invalid-key';
      recordProviderFailure('glm', new Error('Z.ai API key rejected (HTTP 401)'));

      const status = await provider.getAuthStatus();

      expect(status).toEqual({
        isAuthenticated: false,
        method: 'api_key',
        error: 'Z.ai API key rejected (HTTP 401)',
        errorKind: 'credential',
      });
    });

    it('reports a transient failure as authenticated but degraded', async () => {
      process.env.GLM_API_KEY = 'test-key';
      recordProviderFailure('glm', new Error('Z.ai probe timed out after 5000ms'));

      const status = await provider.getAuthStatus();

      expect(status).toEqual({
        isAuthenticated: true,
        method: 'api_key',
        error: 'Z.ai probe timed out after 5000ms',
        errorKind: 'transient',
      });
    });

    it('propagates a live probe rejection into the auth status', async () => {
      process.env.GLM_API_KEY = 'invalid-key';
      const fetchImpl = mock(
        async () => new Response('unauthorized', { status: 401 })
      ) as unknown as typeof fetch;
      provider = new GlmProvider(process.env, fetchImpl);

      await expect(provider.getModels()).rejects.toThrow('Z.ai API key rejected (HTTP 401)');
      recordProviderFailure('glm', new Error('Z.ai API key rejected (HTTP 401)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(false);
      expect(status.errorKind).toBe('credential');
      expect(status.error).toBe('Z.ai API key rejected (HTTP 401)');
    });
  });

  describe('getModels', () => {
    function makeProbeOkProvider(): GlmProvider {
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      return new GlmProvider(process.env, fetchImpl);
    }

    it('should return GLM models when API key is available', async () => {
      process.env.GLM_API_KEY = 'test-key';
      provider = makeProbeOkProvider();

      const models = await provider.getModels();

      expect(models).toHaveLength(7);
      expect(models.map((m) => m.id)).toEqual([
        'glm-5',
        'glm-5.1',
        'glm-5.2[1m]',
        'glm-5.3[1m]',
        'glm-5-turbo',
        'glm-5v-turbo',
        'glm-4.7',
      ]);
    });

    it('should return empty array when API key is not available', async () => {
      delete process.env.GLM_API_KEY;
      delete process.env.ZHIPU_API_KEY;
      provider = makeProbeOkProvider();

      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('should include provider field in models', async () => {
      process.env.GLM_API_KEY = 'test-key';
      provider = makeProbeOkProvider();

      const models = await provider.getModels();

      for (const model of models) {
        expect(model.provider).toBe('glm');
      }
    });

    it('probes the upstream Anthropic-compatible endpoint with the API key', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new GlmProvider(process.env, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers['authorization']).toBe('Bearer test-key');
    });

    it('throws when upstream rejects the API key (401)', async () => {
      process.env.GLM_API_KEY = 'bad-key';
      const fetchImpl = mock(
        async () => new Response('unauthorized', { status: 401 })
      ) as unknown as typeof fetch;
      provider = new GlmProvider(process.env, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Z.ai API key rejected (HTTP 401)');
    });

    it('throws when probe fails at the network layer', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = mock(async () => {
        throw new Error('ENOTFOUND');
      }) as unknown as typeof fetch;
      provider = new GlmProvider(process.env, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Z.ai probe failed: ENOTFOUND');
    });

    it('caches successful probe for 30s so repeated calls do not re-probe', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new GlmProvider(process.env, fetchImpl);

      await provider.getModels();
      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('listRemoteModels', () => {
    function installModelListFetch(respond: (call: number) => Response | Promise<Response>) {
      let call = 0;
      const fetchImpl = mock(
        async (_url: RequestInfo | URL, _init?: RequestInit) => await respond(++call)
      );
      provider = new GlmProvider(process.env, fetchImpl as unknown as typeof fetch);
      return fetchImpl;
    }

    it('fetches the declared OpenAI-compatible URL with bearer auth and normalizes models', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = installModelListFetch(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'glm-5.2', object: 'model' },
                { id: 'glm-new', object: 'model' },
                { id: 'deepseek-chat', object: 'model' },
              ],
            }),
            { status: 200 }
          )
      );

      const models = await provider.listRemoteModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(url)).toBe('https://open.bigmodel.cn/api/paas/v4/models');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' });
      expect(models).toEqual([
        { ...GlmProvider.MODELS[2], id: 'glm-5.2' },
        {
          id: 'glm-new',
          name: 'glm-new',
          alias: 'glm-new',
          family: 'glm',
          provider: 'glm',
          contextWindow: 128_000,
          preferContextWindowMetadata: true,
          thinkingModes: 'granular',
          description: 'glm-new via Z.ai',
          releaseDate: '',
          available: true,
        },
      ]);
      expect(provider.ownsModel('glm-new')).toBe(true);
      const config = provider.buildSdkConfig('glm-new');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-new');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('128000');
    });

    it('serves its cache unless force is true and stores the forced result', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = installModelListFetch(
        async (call) =>
          new Response(JSON.stringify({ data: [{ id: `glm-${call}`, object: 'model' }] }), {
            status: 200,
          })
      );

      expect((await provider.listRemoteModels())[0]?.id).toBe('glm-1');
      expect((await provider.listRemoteModels())[0]?.id).toBe('glm-1');
      expect((await provider.listRemoteModels({ force: true }))[0]?.id).toBe('glm-2');
      expect((await provider.listRemoteModels())[0]?.id).toBe('glm-2');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('clears the discovery cache when credentials change', async () => {
      const fetchImpl = installModelListFetch(
        async (call) =>
          new Response(JSON.stringify({ data: [{ id: `glm-${call}`, object: 'model' }] }), {
            status: 200,
          })
      );
      provider.setCredentials({ type: 'api_key', apiKey: 'first-key' });

      expect((await provider.listRemoteModels())[0]?.id).toBe('glm-1');
      provider.setCredentials({ type: 'api_key', apiKey: 'second-key' });
      expect((await provider.listRemoteModels())[0]?.id).toBe('glm-2');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.headers).toEqual({
        Authorization: 'Bearer second-key',
      });
    });

    it('refetches once the discovery cache TTL expires', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = installModelListFetch(
        async (call) =>
          new Response(JSON.stringify({ data: [{ id: `glm-${call}`, object: 'model' }] }), {
            status: 200,
          })
      );
      const realNow = Date.now;
      let now = 1_000_000;
      Date.now = () => now;
      try {
        expect((await provider.listRemoteModels())[0]?.id).toBe('glm-1');
        now += PROVIDER_DISCOVERY_CACHE_TTL_MS - 1;
        expect((await provider.listRemoteModels())[0]?.id).toBe('glm-1');
        now += 1;
        expect((await provider.listRemoteModels())[0]?.id).toBe('glm-2');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        Date.now = realNow;
      }
    });

    it('propagates forced refresh failures without returning cached models', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = installModelListFetch(async (call) =>
        call === 1
          ? new Response(JSON.stringify({ data: [{ id: 'glm-cached', object: 'model' }] }), {
              status: 200,
            })
          : new Response('unavailable', { status: 503 })
      );

      expect((await provider.listRemoteModels())[0]?.id).toBe('glm-cached');
      await expect(provider.listRemoteModels({ force: true })).rejects.toThrow(
        'Endpoint returned HTTP 503'
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('requires credentials', async () => {
      await expect(provider.listRemoteModels()).rejects.toThrow('Z.ai API key not configured');
    });

    it('getModels merges cached discovered models after the static list', async () => {
      process.env.GLM_API_KEY = 'test-key';
      const fetchImpl = mock(async (url: RequestInfo | URL) =>
        String(url).endsWith('/models')
          ? new Response(
              JSON.stringify({
                data: [
                  { id: 'glm-5.2', object: 'model' },
                  { id: 'glm-new', object: 'model' },
                ],
              }),
              { status: 200 }
            )
          : new Response('{}', { status: 200 })
      );
      global.fetch = fetchImpl as unknown as typeof fetch;
      provider = new GlmProvider(process.env, fetchImpl as unknown as typeof fetch);

      await provider.listRemoteModels();
      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual([
        ...GlmProvider.MODELS.map((model) => model.id),
        'glm-new',
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('ownsModel', () => {
    it('should own glm- prefixed models', () => {
      expect(provider.ownsModel('glm-5')).toBe(true);
      expect(provider.ownsModel('glm-5-turbo')).toBe(true);
      expect(provider.ownsModel('glm-5v-turbo')).toBe(true);
      expect(provider.ownsModel('glm-4.7')).toBe(true);
      expect(provider.ownsModel('GLM-4')).toBe(true);
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

    it('should route glm-5.3 to the 1M SDK model id', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5.3');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3[1m]');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3[1m]');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3[1m]');
    });

    it('should set CLAUDE_CODE_AUTO_COMPACT_WINDOW per model context window', () => {
      process.env.GLM_API_KEY = 'test-key';

      expect(provider.buildSdkConfig('glm-5.2').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
        '1000000'
      );
      expect(provider.buildSdkConfig('glm-5.3').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
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
    });

    it('should handle double [1m] suffix by stripping all trailing suffixes', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5.2[1m][1m]');

      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    });

    it('should handle triple [1m] suffix by stripping all trailing suffixes', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5.2[1m][1m][1m]');

      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    });

    it('should ignore [1m] suffix for non-1M GLM models', () => {
      process.env.GLM_API_KEY = 'test-key';

      const config = provider.buildSdkConfig('glm-5.1[1m]');

      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.1');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.1');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.1');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
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

      expect(() => provider.buildSdkConfig('glm-5')).toThrow('Z.ai API key not configured');
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
      expect(GlmProvider.MODELS).toHaveLength(7);
      expect(GlmProvider.MODELS.map((m) => m.id)).toEqual([
        'glm-5',
        'glm-5.1',
        'glm-5.2[1m]',
        'glm-5.3[1m]',
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
