import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { OpenRouterProvider } from '../../../../src/lib/providers/openrouter-provider';

describe('OpenRouterProvider', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('has expected identity and capabilities', () => {
    const provider = new OpenRouterProvider();

    expect(provider.id).toBe('openrouter');
    expect(provider.displayName).toBe('OpenRouter');
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.functionCalling).toBe(true);
    expect(OpenRouterProvider.BASE_URL).toBe('https://openrouter.ai/api');
  });

  it('requires OPENROUTER_API_KEY with OpenRouter key shape', async () => {
    const provider = new OpenRouterProvider();

    expect(provider.isAvailable()).toBe(false);
    expect(() => provider.buildSdkConfig('anthropic/claude-sonnet-4.6')).toThrow(
      'OpenRouter API key not configured'
    );

    process.env.OPENROUTER_API_KEY = 'not-openrouter';
    expect(provider.isAvailable()).toBe(false);
    expect((await provider.getAuthStatus()).error).toContain('expected sk-or-');
  });

  it('builds Claude Code Anthropic-compatible routing env vars', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const provider = new OpenRouterProvider();

    const config = provider.buildSdkConfig('anthropic/claude-sonnet-4.6');

    expect(config.envVars).toEqual({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-test',
      ANTHROPIC_API_KEY: '',
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-sonnet-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-sonnet-4.6',
    });
    expect(config.isAnthropicCompatible).toBe(true);
    expect(provider.translateModelIdForSdk('anthropic/claude-sonnet-4.6')).toBe('default');
  });

  it('uses session config overrides for key and base URL', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    const provider = new OpenRouterProvider();

    const config = provider.buildSdkConfig('openrouter/auto', {
      apiKey: 'sk-or-session',
      baseUrl: 'https://example.test/api',
    });

    expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-session');
    expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://example.test/api');
    expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('openrouter/auto');
  });

  it('maps tiers to OpenRouter Claude model names', () => {
    const provider = new OpenRouterProvider();

    expect(provider.getModelForTier('default')).toBe('anthropic/claude-sonnet-4.6');
    expect(provider.getModelForTier('sonnet')).toBe('anthropic/claude-sonnet-4.6');
    expect(provider.getModelForTier('opus')).toBe('anthropic/claude-opus-4.7');
    expect(provider.getModelForTier('haiku')).toBe('anthropic/claude-haiku-4.5');
  });

  it('loads and maps models from OpenRouter model listing API', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'anthropic/claude-sonnet-4.6',
              name: 'Claude Sonnet 4.6',
              description: 'A Claude model',
              context_length: 200000,
              created: 1770000000,
            },
            {
              id: 'openai/gpt-5.4',
              name: 'GPT-5.4',
              context_length: 400000,
            },
          ],
        }),
        { status: 200 }
      );
    });
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(fetchMock).toHaveBeenCalledWith(OpenRouterProvider.MODELS_URL, {
      headers: { Authorization: 'Bearer sk-or-test' },
    });
    expect(models.map((model) => model.id)).toEqual([
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4',
    ]);
    expect(models[0].provider).toBe('openrouter');
    expect(models[0].family).toBe('sonnet');
    expect(models[1].family).toBe('gpt');
  });

  it('bypasses the OpenRouter model cache for forced remote discovery', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_ALLOWED_MODELS = 'openrouter/auto, xai/grok-4.3';
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          data: [
            { id: 'openrouter/auto', name: `OpenRouter Auto ${callCount}` },
            { id: 'xai/grok-4.3', name: `Grok ${callCount}` },
            { id: 'anthropic/claude-sonnet-4.6', name: 'Filtered' },
          ],
        }),
        { status: 200 }
      );
    });
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    await provider.getModels();
    const cachedModels = await provider.listRemoteModels();
    const forcedModels = await provider.listRemoteModels({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cachedModels.map((model) => model.name)).toEqual(['OpenRouter Auto 1', 'Grok 1']);
    expect(forcedModels.map((model) => model.name)).toEqual(['OpenRouter Auto 2', 'Grok 2']);
    expect(await provider.getModels()).toBe(forcedModels);
  });

  it('propagates OpenRouter remote discovery failures instead of returning fallback models', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    let fail = false;
    const fetchMock = mock(async () => {
      if (fail) return new Response('Bad gateway', { status: 502 });
      return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-4.6' }] }), {
        status: 200,
      });
    });
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    await provider.getModels();
    fail = true;

    await expect(provider.listRemoteModels({ force: true })).rejects.toThrow(
      'OpenRouter model listing returned HTTP 502'
    );
  });

  it('returns all API models without capping when using models/user endpoint', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const data = [
      ...Array.from({ length: 35 }, (_, index) => ({
        id: `anthropic/claude-test-${index}`,
        name: `Claude Test ${index}`,
      })),
      { id: 'random-lab/experimental-1', name: 'Experimental 1' },
      { id: 'small-provider/experimental-2', name: 'Experimental 2' },
    ];
    const fetchMock = mock(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(models).toHaveLength(37);
    expect(models.filter((model) => model.id.startsWith('anthropic/'))).toHaveLength(35);
    expect(models.some((model) => model.id === 'random-lab/experimental-1')).toBe(true);
    expect(models.some((model) => model.id === 'small-provider/experimental-2')).toBe(true);
  });

  it('filters system models and keeps popular provider families in curated API models', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const data = [
      { id: 'openrouter/auto', name: 'OpenRouter Auto' },
      { id: 'xai/grok-4', name: 'Grok 4' },
      { id: 'cohere/command-a', name: 'Command A' },
      { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
      { id: '~anthropic/claude-sonnet-latest', name: 'Claude Sonnet Latest' },
      { id: 'random-lab/experimental-1', name: 'Experimental 1' },
    ];
    const fetchMock = mock(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(models.map((model) => model.id)).toEqual([
      'xai/grok-4',
      'cohere/command-a',
      'qwen/qwen3-coder',
      'random-lab/experimental-1',
    ]);
  });

  it('excludes all system models with ~ and openrouter/ prefixes from results', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const data = [
      { id: '~anthropic/claude-sonnet-latest', name: 'Claude Sonnet Latest' },
      { id: '~openai/gpt-latest', name: 'GPT Latest' },
      { id: 'openrouter/auto', name: 'Auto Router' },
      { id: 'openrouter/free', name: 'Free Router' },
      { id: 'openrouter/pareto-code', name: 'Pareto Code Router' },
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
    ];
    const fetchMock = mock(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(models.map((model) => model.id)).toEqual(['anthropic/claude-sonnet-4.6']);
  });

  it('returns all models from API response without curation fallback', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const data = Array.from({ length: 35 }, (_, index) => ({
      id: `community/model-${index}`,
      name: `Community Model ${index}`,
    }));
    const fetchMock = mock(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(models).toHaveLength(35);
    expect(models[0].id).toBe('community/model-0');
    expect(models.at(-1)?.id).toBe('community/model-34');
  });

  it('allows openrouter/ models when explicitly listed in allowlist', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_ALLOWED_MODELS = 'openrouter/auto, xai/grok-4.3';
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'openrouter/auto', name: 'OpenRouter Auto' },
              { id: 'xai/grok-4.3', name: 'Grok 4.3' },
              { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
            ],
          }),
          { status: 200 }
        )
    );
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(models.map((model) => model.id)).toEqual(['openrouter/auto', 'xai/grok-4.3']);
  });

  it('filters OpenRouter models to configured account allowlist', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_ALLOWED_MODELS = 'xai/grok-4.3, deepseek/deepseek-v4-pro';
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'xai/grok-4.3', name: 'Grok 4.3' },
              { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
              { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
            ],
          }),
          { status: 200 }
        )
    );
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(models.map((model) => model.id)).toEqual(['xai/grok-4.3', 'deepseek/deepseek-v4-pro']);
  });

  it('parses UI-driven provider-prefixed OpenRouter allowlist', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS =
      'openrouter:xai/grok-4.3\nanthropic:claude-sonnet-4.6\nopenrouter:qwen/qwen3.6-max-preview';
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'xai/grok-4.3', name: 'Grok 4.3' },
              { id: 'qwen/qwen3.6-max-preview', name: 'Qwen3.6 Max Preview' },
              { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
            ],
          }),
          { status: 200 }
        )
    );
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();

    expect(models.map((model) => model.id)).toEqual(['xai/grok-4.3', 'qwen/qwen3.6-max-preview']);
  });

  it('uses and caches configured account allowlist when OpenRouter model metadata cannot be fetched', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_ALLOWED_MODELS = 'qwen/qwen3.6-max-preview\ngoogle/gemma-4-31b:free';
    const fetchMock = mock(async () => new Response('Bad gateway', { status: 502 }));
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();
    const cachedModels = await provider.getModels();

    expect(models.map((model) => model.id)).toEqual([
      'qwen/qwen3.6-max-preview',
      'google/gemma-4-31b:free',
    ]);
    expect(cachedModels).toBe(models);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(models.every((model) => model.provider === 'openrouter')).toBe(true);
  });

  it('rejects SDK config for OpenRouter models outside the configured allowlist', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_ALLOWED_MODELS = 'xai/grok-4.3';
    const provider = new OpenRouterProvider();

    expect(() => provider.buildSdkConfig('anthropic/claude-sonnet-4.6')).toThrow(
      "OpenRouter model 'anthropic/claude-sonnet-4.6' is not in the configured allowlist"
    );
    expect(provider.buildSdkConfig('xai/grok-4.3').envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      'xai/grok-4.3'
    );
  });

  it('surfaces rejected API keys through auth status and hides models', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const fetchMock = mock(async () => new Response('Unauthorized', { status: 401 }));
    const provider = new OpenRouterProvider(process.env, fetchMock as unknown as typeof fetch);

    const models = await provider.getModels();
    const authStatus = await provider.getAuthStatus();

    expect(models).toEqual([]);
    expect(authStatus.isAuthenticated).toBe(false);
    expect(authStatus.error).toContain('rejected by OpenRouter');
  });

  it('FALLBACK_MODELS have correct context windows per model family', () => {
    const byAlias = Object.fromEntries(
      OpenRouterProvider.FALLBACK_MODELS.map((m) => [m.alias, m.contextWindow])
    );
    expect(byAlias['openrouter-auto']).toBe(1_000_000);
    expect(byAlias['openrouter-sonnet']).toBe(200_000);
    expect(byAlias['openrouter-opus']).toBe(200_000);
    expect(byAlias['openrouter-haiku']).toBe(200_000);
  });

  it('capabilities.maxContextWindow is 1M for unknown models with large contexts', () => {
    const provider = new OpenRouterProvider();
    expect(provider.capabilities.maxContextWindow).toBe(1_000_000);
  });

  it('discards discovery results that cross a credential change', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = mock(
      (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;
    const provider = new OpenRouterProvider(process.env, fetchMock);

    const discovery = provider.listRemoteModels({ force: true });
    while (!resolveFetch) {
      await Promise.resolve();
    }

    provider.setCredentials({ type: 'api_key', apiKey: 'sk-or-replacement' });
    resolveFetch(
      new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-4.6' }] }), {
        status: 200,
      })
    );

    await expect(discovery).rejects.toThrow('credentials changed during model discovery');
    expect((provider as unknown as Record<string, unknown>)['modelCache']).toBeNull();
  });
});
