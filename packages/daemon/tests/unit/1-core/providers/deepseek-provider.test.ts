import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DeepSeekProvider } from '../../../../src/lib/providers/deepseek-provider';
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';

describe('DeepSeekProvider', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    global.fetch = originalFetch;
  });

  it('exposes the current V4 Anthropic-format models', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const fetchImpl = mock(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    const provider = new DeepSeekProvider(process.env, fetchImpl);

    expect(await provider.getModels()).toEqual(DeepSeekProvider.MODELS);
    expect(DeepSeekProvider.MODELS.map((model) => model.id)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
    expect(DeepSeekProvider.MODELS.every((model) => model.contextWindow === 1_000_000)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/anthropic/v1/messages');
  });

  it('builds Claude Agent SDK routing through the Anthropic endpoint', () => {
    const provider = new DeepSeekProvider({ DEEPSEEK_API_KEY: 'test-key' });
    const config = provider.buildSdkConfig('deepseek-v4-flash');

    expect(config.isAnthropicCompatible).toBe(true);
    expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
    expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
    expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-flash');
    expect(provider.translateModelIdForSdk('deepseek-v4-flash')).toBe('claude-sonnet-4-6[1m]');
    expect(provider.translateModelIdForSdk('deepseek-v4-pro')).toBe('claude-opus-4-6[1m]');
    expect(provider.translateModelIdForSdk('deepseek-pro')).toBe('claude-opus-4-6[1m]');

    const aliasConfig = provider.buildSdkConfig('DEEPSEEK-FLASH');
    expect(aliasConfig.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-flash');
  });

  it('supports stored credentials and rejects missing credentials', async () => {
    const provider = new DeepSeekProvider({});
    expect(provider.isAvailable()).toBe(false);
    expect(await provider.getModels()).toEqual([]);
    expect(() => provider.buildSdkConfig('deepseek-v4-pro')).toThrow(
      'DeepSeek API key not configured'
    );

    provider.setCredentials({ type: 'api_key', apiKey: 'stored-key' });
    expect(provider.isAvailable()).toBe(true);
  });

  it('maps opus to Pro and other Claude tiers to Flash', () => {
    const provider = new DeepSeekProvider({});
    expect(provider.getModelForTier('opus')).toBe('deepseek-v4-pro');
    expect(provider.getModelForTier('sonnet')).toBe('deepseek-v4-flash');
    expect(provider.getModelForTier('haiku')).toBe('deepseek-v4-flash');
    expect(provider.getTitleGenerationModel()).toBe('deepseek-v4-flash');
  });

  it('does not claim colon-tagged Ollama models', () => {
    const provider = new DeepSeekProvider({});
    expect(provider.ownsModel('deepseek-v4-pro')).toBe(true);
    expect(provider.ownsModel('deepseek-pro')).toBe(true);
    expect(provider.ownsModel('deepseek-r1:latest')).toBe(false);
  });

  it('falls back to the default model for IDs outside the DeepSeek family', () => {
    const provider = new DeepSeekProvider({ DEEPSEEK_API_KEY: 'test-key' });

    expect(provider.ownsModel('glm-5')).toBe(false);

    const config = provider.buildSdkConfig('glm-5');
    expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(DeepSeekProvider.DEFAULT_MODEL);
    expect(provider.translateModelIdForSdk('glm-5')).toBe('claude-sonnet-4-6[1m]');
  });

  describe('listRemoteModels', () => {
    function installModelListFetch(respond: (call: number) => Response | Promise<Response>) {
      let call = 0;
      const fetchImpl = mock(
        async (_url: RequestInfo | URL, _init?: RequestInit) => await respond(++call)
      );
      global.fetch = fetchImpl as unknown as typeof fetch;
      return fetchImpl;
    }

    it('fetches the declared OpenAI-compatible URL with bearer auth and normalizes models', async () => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      const fetchImpl = installModelListFetch(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'deepseek-pro', object: 'model' },
                { id: 'deepseek-v5', object: 'model' },
                { id: 'deepseek-r1:latest', object: 'model' },
                { id: 'glm-5', object: 'model' },
              ],
            }),
            { status: 200 }
          )
      );
      const provider = new DeepSeekProvider(process.env);

      const models = await provider.listRemoteModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(url)).toBe('https://api.deepseek.com/models');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' });
      expect(models).toEqual([
        DeepSeekProvider.MODELS[0],
        {
          id: 'deepseek-v5',
          name: 'deepseek-v5',
          alias: 'deepseek-v5',
          family: 'deepseek',
          provider: 'deepseek',
          contextWindow: 128_000,
          preferContextWindowMetadata: true,
          thinkingModes: 'granular',
          description: 'deepseek-v5 via DeepSeek',
          releaseDate: '',
          available: true,
        },
      ]);
      expect(provider.ownsModel('deepseek-v5')).toBe(true);
      const config = provider.buildSdkConfig('deepseek-v5');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v5');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('128000');
      expect(provider.translateModelIdForSdk('deepseek-v5')).toBe('deepseek-v5');
    });

    it('serves its cache unless force is true and stores the forced result', async () => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      const fetchImpl = installModelListFetch(
        async (call) =>
          new Response(
            JSON.stringify({ data: [{ id: `deepseek-v${call + 4}`, object: 'model' }] }),
            { status: 200 }
          )
      );
      const provider = new DeepSeekProvider(process.env);

      expect((await provider.listRemoteModels())[0]?.id).toBe('deepseek-v5');
      expect((await provider.listRemoteModels())[0]?.id).toBe('deepseek-v5');
      expect((await provider.listRemoteModels({ force: true }))[0]?.id).toBe('deepseek-v6');
      expect((await provider.listRemoteModels())[0]?.id).toBe('deepseek-v6');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('clears the discovery cache when credentials change', async () => {
      const provider = new DeepSeekProvider({});
      provider.setCredentials({ type: 'api_key', apiKey: 'first-key' });
      const fetchImpl = installModelListFetch(
        async (call) =>
          new Response(
            JSON.stringify({ data: [{ id: `deepseek-v${call + 4}`, object: 'model' }] }),
            { status: 200 }
          )
      );

      expect((await provider.listRemoteModels())[0]?.id).toBe('deepseek-v5');
      provider.setCredentials({ type: 'api_key', apiKey: 'second-key' });
      expect((await provider.listRemoteModels())[0]?.id).toBe('deepseek-v6');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.headers).toEqual({
        Authorization: 'Bearer second-key',
      });
    });

    it('propagates forced refresh failures without returning cached models', async () => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      const fetchImpl = installModelListFetch(async (call) =>
        call === 1
          ? new Response(JSON.stringify({ data: [{ id: 'deepseek-cached', object: 'model' }] }), {
              status: 200,
            })
          : new Response('unavailable', { status: 503 })
      );
      const provider = new DeepSeekProvider(process.env);

      expect((await provider.listRemoteModels())[0]?.id).toBe('deepseek-cached');
      await expect(provider.listRemoteModels({ force: true })).rejects.toThrow(
        'Endpoint returned HTTP 503'
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('requires credentials', async () => {
      const provider = new DeepSeekProvider({});

      await expect(provider.listRemoteModels()).rejects.toThrow('DeepSeek API key not configured');
    });
  });

  describe('getAuthStatus', () => {
    beforeEach(() => {
      resetProviderFailureStore();
    });

    afterEach(() => {
      resetProviderFailureStore();
    });

    it('surfaces a recorded credential failure as unauthenticated', async () => {
      const provider = new DeepSeekProvider({ DEEPSEEK_API_KEY: 'invalid-key' });
      recordProviderFailure('deepseek', new Error('DeepSeek API key rejected (HTTP 401)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(false);
      expect(status.errorKind).toBe('credential');
      expect(status.error).toBe('DeepSeek API key rejected (HTTP 401)');
    });

    it('stays authenticated but degraded for a recorded transient failure', async () => {
      const provider = new DeepSeekProvider({ DEEPSEEK_API_KEY: 'test-key' });
      recordProviderFailure('deepseek', new Error('DeepSeek probe failed (HTTP 503)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(true);
      expect(status.errorKind).toBe('transient');
      expect(status.error).toBe('DeepSeek probe failed (HTTP 503)');
    });
  });
});
