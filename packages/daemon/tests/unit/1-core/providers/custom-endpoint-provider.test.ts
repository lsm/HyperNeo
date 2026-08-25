import { describe, expect, it, mock } from 'bun:test';
import {
  CustomEndpointProvider,
  customProviderIdFor,
  isCustomEndpointProviderId,
  resolveModelCapabilities,
} from '../../../../src/lib/providers/custom-endpoint-provider';
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';
import type { CustomEndpointConfig } from '@hyperneo/shared';
import type {
  OpenAIChatBridgeConfig,
  OpenAIChatBridgeServer,
} from '../../../../src/lib/providers/openai-chat-bridge/server';

function makeFakeBridge(): {
  factory: (config: OpenAIChatBridgeConfig) => OpenAIChatBridgeServer;
  configs: OpenAIChatBridgeConfig[];
  stoppedPorts: number[];
  thinkingConfigs: Array<{ sessionId: string; thinking: unknown }>;
} {
  const configs: OpenAIChatBridgeConfig[] = [];
  const stoppedPorts: number[] = [];
  const thinkingConfigs: Array<{ sessionId: string; thinking: unknown }> = [];
  let nextPort = 40000;
  const factory = (config: OpenAIChatBridgeConfig): OpenAIChatBridgeServer => {
    configs.push(config);
    const port = nextPort++;
    return {
      port,
      setSessionThinkingConfig: (sessionId: string, thinking: unknown) => {
        thinkingConfigs.push({ sessionId, thinking });
      },
      stop: () => stoppedPorts.push(port),
    };
  };
  return { factory, configs, stoppedPorts, thinkingConfigs };
}

const baseConfig: CustomEndpointConfig = {
  id: 'lmstudio',
  name: 'LM Studio Local',
  baseUrl: 'http://localhost:1234/v1',
  models: [
    {
      id: 'qwen2.5-7b',
      capabilities: { toolUse: true, vision: false, maxContextTokens: 32000 },
    },
    {
      id: 'qwen2.5-vl-7b',
      capabilities: { toolUse: false, vision: true, maxContextTokens: 32000 },
    },
  ],
  defaultModelId: 'qwen2.5-7b',
};

describe('CustomEndpointProvider', () => {
  it('exposes a `custom:<id>` provider id', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    expect(p.id).toBe('custom:lmstudio');
    expect(p.displayName).toBe('LM Studio Local');
    expect(customProviderIdFor('lmstudio')).toBe('custom:lmstudio');
    expect(isCustomEndpointProviderId(p.id)).toBe(true);
    expect(isCustomEndpointProviderId('anthropic')).toBe(false);
  });

  it('rejects configs that are missing required fields', async () => {
    expect(
      () =>
        new CustomEndpointProvider(
          { ...baseConfig, id: '' },
          {
            bridgeFactory: makeFakeBridge().factory,
          }
        )
    ).toThrow(/endpoint id is required/);
    expect(
      () =>
        new CustomEndpointProvider(
          { ...baseConfig, baseUrl: '' },
          {
            bridgeFactory: makeFakeBridge().factory,
          }
        )
    ).toThrow(/baseUrl is required/);
    expect(
      () =>
        new CustomEndpointProvider(
          { ...baseConfig, models: [] },
          {
            bridgeFactory: makeFakeBridge().factory,
          }
        )
    ).toThrow(/at least one model is required/);
  });

  it('reports aggregated capabilities across models', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    expect(p.capabilities.functionCalling).toBe(true);
    expect(p.capabilities.vision).toBe(true);
    expect(p.capabilities.streaming).toBe(true);
    expect(p.capabilities.maxContextWindow).toBe(32000);
  });

  it('lists models with provider id, family, and context window', async () => {
    const fetchImpl = mock(
      async () => new Response('[]', { status: 200 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(baseConfig, {
      bridgeFactory: makeFakeBridge().factory,
      bridgeFetchImpl: fetchImpl,
    });
    const models = await p.getModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'qwen2.5-7b',
      provider: 'custom:lmstudio',
      family: 'lmstudio',
      contextWindow: 32000,
    });
  });

  it('returns configured models from getCachedModels without probing', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('probe must not run');
    }) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(baseConfig, {
      bridgeFactory: makeFakeBridge().factory,
      bridgeFetchImpl: fetchImpl,
    });

    const models = p.getCachedModels();

    expect(models?.map((m) => m.id)).toEqual(['qwen2.5-7b', 'qwen2.5-vl-7b']);
    expect(models?.[0]).toMatchObject({
      id: 'qwen2.5-7b',
      name: 'qwen2.5-7b',
      provider: 'custom:lmstudio',
      family: 'lmstudio',
      contextWindow: 32000,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('matches between getCachedModels and a healthy getModels listing', async () => {
    const fetchImpl = mock(
      async () => new Response('[]', { status: 200 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(baseConfig, {
      bridgeFactory: makeFakeBridge().factory,
      bridgeFetchImpl: fetchImpl,
    });

    expect(p.getCachedModels()).toEqual(await p.getModels());
  });

  it('probes the configured endpoint before returning the model list', async () => {
    const fetchImpl = mock(
      async () => new Response('[]', { status: 200 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(baseConfig, {
      bridgeFactory: makeFakeBridge().factory,
      bridgeFetchImpl: fetchImpl,
    });
    await p.getModels();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
    expect(url).toBe('http://localhost:1234/v1/models');
    expect(init?.method).toBe('GET');
  });

  it('throws when endpoint rejects the API key (401)', async () => {
    const fetchImpl = mock(
      async () => new Response('unauthorized', { status: 401 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(
      { ...baseConfig, apiKey: 'bad-key' },
      { bridgeFactory: makeFakeBridge().factory, bridgeFetchImpl: fetchImpl }
    );

    expect(p.getModels()).rejects.toThrow("Custom endpoint 'lmstudio' API key rejected (HTTP 401)");
  });

  it('throws when probe fails at the network layer', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(baseConfig, {
      bridgeFactory: makeFakeBridge().factory,
      bridgeFetchImpl: fetchImpl,
    });

    expect(p.getModels()).rejects.toThrow("Custom endpoint 'lmstudio' probe failed: ECONNREFUSED");
  });

  it('uses /v1/models probe path for anthropic-messages type', async () => {
    const fetchImpl = mock(
      async () => new Response('[]', { status: 200 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(
      { ...baseConfig, type: 'anthropic-messages' },
      { bridgeFactory: makeFakeBridge().factory, bridgeFetchImpl: fetchImpl }
    );
    await p.getModels();

    const [url] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
    expect(url).toBe('http://localhost:1234/v1/v1/models');
  });

  it('sends x-api-key (not just Bearer) for anthropic-messages probes', async () => {
    const fetchImpl = mock(
      async () => new Response('[]', { status: 200 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(
      { ...baseConfig, type: 'anthropic-messages', apiKey: 'anthropic-key' },
      { bridgeFactory: makeFakeBridge().factory, bridgeFetchImpl: fetchImpl }
    );
    await p.getModels();

    const [, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(headers['authorization']).toBe('Bearer anthropic-key');
  });

  it('does not send x-api-key for openai-chat probes', async () => {
    const fetchImpl = mock(
      async () => new Response('[]', { status: 200 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(
      { ...baseConfig, type: 'openai-chat', apiKey: 'openai-key' },
      { bridgeFactory: makeFakeBridge().factory, bridgeFetchImpl: fetchImpl }
    );
    await p.getModels();

    const [, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBe('Bearer openai-key');
  });

  it('uses /api/tags probe path for ollama-native type', async () => {
    const fetchImpl = mock(
      async () => new Response('[]', { status: 200 })
    ) as unknown as typeof fetch;
    const p = new CustomEndpointProvider(
      { ...baseConfig, type: 'ollama-native' },
      { bridgeFactory: makeFakeBridge().factory, bridgeFetchImpl: fetchImpl }
    );
    await p.getModels();

    const [url] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
    expect(url).toBe('http://localhost:1234/v1/api/tags');
  });

  it('owns its own model ids and nothing else', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    expect(p.ownsModel('qwen2.5-7b')).toBe(true);
    expect(p.ownsModel('qwen2.5-vl-7b')).toBe(true);
    expect(p.ownsModel('claude-sonnet-4-5')).toBe(false);
  });

  it('returns defaultModelId for getModelForTier when set', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    expect(p.getModelForTier('default')).toBe('qwen2.5-7b');
    expect(p.getModelForTier('sonnet')).toBe('qwen2.5-7b');
  });

  it('builds SDK config that routes through the bridge with model capabilities', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
    await p.ensureBridgeStarted('qwen2.5-7b');
    const cfg = p.buildSdkConfig('qwen2.5-7b');
    expect(cfg.isAnthropicCompatible).toBe(true);
    expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen2.5-7b');
    expect(fake.configs).toHaveLength(1);
    expect(fake.configs[0]).toMatchObject({
      baseUrl: 'http://localhost:1234/v1',
      toolUseSupported: true,
      visionSupported: false,
      thinkingSupported: false,
      modelContextWindow: 32000,
    });
  });

  it('forwards per-model capability flags into the bridge', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
    await p.ensureBridgeStarted('qwen2.5-vl-7b');
    p.buildSdkConfig('qwen2.5-vl-7b');
    expect(fake.configs[0]).toMatchObject({
      toolUseSupported: false,
      visionSupported: true,
    });
  });

  it('forwards thinkingSupported when the model declares thinking=true', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(
      {
        ...baseConfig,
        models: [
          {
            id: 'reasoner',
            capabilities: { toolUse: true, vision: false, thinking: true },
          },
        ],
        defaultModelId: 'reasoner',
      },
      { bridgeFactory: fake.factory }
    );
    await p.ensureBridgeStarted('reasoner');
    p.buildSdkConfig('reasoner');
    expect(fake.configs[0]).toMatchObject({ thinkingSupported: true });
  });

  it('defaults streamUsageSupported to false (strict OpenAI-compatible backends)', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
    await p.ensureBridgeStarted('qwen2.5-7b');
    p.buildSdkConfig('qwen2.5-7b');
    expect(fake.configs[0].streamUsageSupported).toBe(false);
  });

  it('forwards streamUsageSupported=true when the model opts in', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(
      {
        ...baseConfig,
        models: [
          {
            id: 'openai-compatible',
            capabilities: { toolUse: true, streamUsage: true },
          },
        ],
        defaultModelId: 'openai-compatible',
      },
      { bridgeFactory: fake.factory }
    );
    await p.ensureBridgeStarted('openai-compatible');
    p.buildSdkConfig('openai-compatible');
    expect(fake.configs[0].streamUsageSupported).toBe(true);
  });

  it('reuses the bridge for the same (baseUrl, apiKey, model) tuple', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
    await p.ensureBridgeStarted('qwen2.5-7b');
    const first = p.buildSdkConfig('qwen2.5-7b');
    await p.ensureBridgeStarted('qwen2.5-7b');
    const second = p.buildSdkConfig('qwen2.5-7b');
    expect(first.envVars.ANTHROPIC_BASE_URL).toBe(second.envVars.ANTHROPIC_BASE_URL);
    expect(fake.configs).toHaveLength(1);
  });

  it('uses providerModelId override for the upstream model string', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(
      {
        ...baseConfig,
        models: [
          {
            id: 'fast',
            providerModelId: 'qwen2.5-coder:14b',
            capabilities: { toolUse: true },
          },
        ],
        defaultModelId: 'fast',
      },
      { bridgeFactory: fake.factory }
    );
    await p.ensureBridgeStarted('fast');
    const cfg = p.buildSdkConfig('fast');
    expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen2.5-coder:14b');
  });

  it('shutdown stops every active bridge', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
    await p.ensureBridgeStarted('qwen2.5-7b');
    p.buildSdkConfig('qwen2.5-7b');
    await p.ensureBridgeStarted('qwen2.5-vl-7b');
    p.buildSdkConfig('qwen2.5-vl-7b');
    expect(fake.configs).toHaveLength(2);
    await p.shutdown();
    expect(fake.stoppedPorts).toHaveLength(2);
  });

  it('stops a bridge that finishes starting after shutdown', async () => {
    const stoppedPorts: number[] = [];
    let resolveFactory: (bridge: OpenAIChatBridgeServer) => void = () => {};
    const factory = (): Promise<OpenAIChatBridgeServer> =>
      new Promise((resolve) => {
        resolveFactory = resolve;
      });
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: factory });
    const ensurePromise = p.ensureBridgeStarted('qwen2.5-7b');
    await p.shutdown();
    resolveFactory({
      port: 49999,
      stop: () => stoppedPorts.push(49999),
    });
    await ensurePromise;
    expect(stoppedPorts).toEqual([49999]);
    expect(() => p.buildSdkConfig('qwen2.5-7b')).toThrow(/bridge not started/);
  });

  it('resolveModelCapabilities fills in defaults', async () => {
    const caps = resolveModelCapabilities({ id: 'x' });
    expect(caps).toEqual({
      streaming: true,
      toolUse: true,
      vision: false,
      thinking: false,
      caching: false,
      maxContextTokens: 128000,
      streamUsage: false,
    });
  });

  it('isAvailable returns true when baseUrl is set', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    expect(await p.isAvailable()).toBe(true);
  });

  it('getAuthStatus reports authenticated with api_key method', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    const status = await p.getAuthStatus();
    expect(status.isAuthenticated).toBe(true);
    expect(status.method).toBe('api_key');
  });

  it('getAuthStatus surfaces a recorded credential failure as unauthenticated', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    recordProviderFailure(p.id, new Error('LM Studio Local API key rejected (HTTP 401)'));

    const status = await p.getAuthStatus();

    expect(status.isAuthenticated).toBe(false);
    expect(status.errorKind).toBe('credential');
    expect(status.error).toBe('LM Studio Local API key rejected (HTTP 401)');
    resetProviderFailureStore();
  });

  it('translateModelIdForSdk always returns "default" (SDK tier alias)', async () => {
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
    expect(p.translateModelIdForSdk('qwen2.5-7b')).toBe('default');
    expect(p.translateModelIdForSdk('anything')).toBe('default');
  });

  describe('getModelThinkingMode', () => {
    it('returns "off" for a model that declares thinking=false', async () => {
      const p = new CustomEndpointProvider(baseConfig, {
        bridgeFactory: makeFakeBridge().factory,
      });
      expect(p.getModelThinkingMode('qwen2.5-7b')).toBe('off');
    });

    it('returns "on" for a model that declares thinking=true', async () => {
      const p = new CustomEndpointProvider(
        {
          ...baseConfig,
          models: [
            {
              id: 'reasoner',
              capabilities: { toolUse: true, vision: false, thinking: true },
            },
          ],
          defaultModelId: 'reasoner',
        },
        { bridgeFactory: makeFakeBridge().factory }
      );
      expect(p.getModelThinkingMode('reasoner')).toBe('on');
    });

    it('returns undefined for an unknown model id (defers to provider aggregate)', async () => {
      const p = new CustomEndpointProvider(baseConfig, {
        bridgeFactory: makeFakeBridge().factory,
      });
      expect(p.getModelThinkingMode('does-not-exist')).toBeUndefined();
    });

    it('returns "off" for non-thinking models even when a sibling model supports thinking', async () => {
      const p = new CustomEndpointProvider(
        {
          ...baseConfig,
          models: [
            { id: 'plain', capabilities: { toolUse: true, thinking: false } },
            { id: 'reasoner', capabilities: { toolUse: true, thinking: true } },
          ],
          defaultModelId: 'plain',
        },
        { bridgeFactory: makeFakeBridge().factory }
      );
      expect(p.capabilities.extendedThinking).toBe(true);
      expect(p.getModelThinkingMode('plain')).toBe('off');
      expect(p.getModelThinkingMode('reasoner')).toBe('on');
    });
  });

  it('forwards custom headers into the bridge', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(
      {
        ...baseConfig,
        headers: { 'X-Org': 'acme', Authorization: 'Bearer override' },
      },
      { bridgeFactory: fake.factory }
    );
    await p.ensureBridgeStarted('qwen2.5-7b');
    p.buildSdkConfig('qwen2.5-7b');
    expect(fake.configs[0].headers).toEqual({
      'X-Org': 'acme',
      Authorization: 'Bearer override',
    });
  });

  it('falls back to the first model when modelId is unknown', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(
      {
        ...baseConfig,
        defaultModelId: undefined,
      },
      { bridgeFactory: fake.factory }
    );
    await p.ensureBridgeStarted('not-a-real-model');
    const cfg = p.buildSdkConfig('not-a-real-model');
    expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen2.5-7b');
  });

  it('honours sessionConfig overrides for baseUrl and apiKey', async () => {
    const fake = makeFakeBridge();
    const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
    await p.ensureBridgeStarted('qwen2.5-7b', {
      baseUrl: 'http://override.test/v1',
      apiKey: 'session-key',
    });
    p.buildSdkConfig('qwen2.5-7b', {
      baseUrl: 'http://override.test/v1',
      apiKey: 'session-key',
    });
    expect(fake.configs[0]).toMatchObject({
      baseUrl: 'http://override.test/v1',
      apiKey: 'session-key',
    });
  });

  describe('endpoint type matrix', () => {
    it('defaults to openai-chat when type is omitted (legacy configs)', async () => {
      const fake = makeFakeBridge();
      const p = new CustomEndpointProvider(baseConfig, {
        bridgeFactories: { 'openai-chat': fake.factory },
      });
      expect(p.getType()).toBe('openai-chat');
      await p.ensureBridgeStarted('qwen2.5-7b');
      p.buildSdkConfig('qwen2.5-7b');
      expect(fake.configs).toHaveLength(1);
      expect(fake.configs[0]).toMatchObject({
        baseUrl: 'http://localhost:1234/v1',
        toolUseSupported: true,
      });
    });

    it('routes anthropic-messages endpoints through the anthropic bridge factory', async () => {
      const anthropicConfigs: Array<{
        baseUrl: string;
        apiKey?: string;
        thinkingSupported?: boolean;
      }> = [];
      const openaiFake = makeFakeBridge();
      const p = new CustomEndpointProvider(
        {
          ...baseConfig,
          id: 'self-hosted-claude',
          type: 'anthropic-messages',
          baseUrl: 'https://claude.example.com',
          models: [
            {
              id: 'claude-sonnet-proxied',
              capabilities: { thinking: false },
            },
          ],
          defaultModelId: 'claude-sonnet-proxied',
        },
        {
          bridgeFactories: {
            'anthropic-messages': (config) => {
              anthropicConfigs.push({
                baseUrl: config.baseUrl,
                apiKey: config.apiKey,
                thinkingSupported: config.thinkingSupported,
              });
              return { port: 40500, stop: () => {} };
            },
            'openai-chat': openaiFake.factory,
          },
        }
      );
      await p.ensureBridgeStarted('claude-sonnet-proxied');
      p.buildSdkConfig('claude-sonnet-proxied');
      expect(anthropicConfigs).toHaveLength(1);
      expect(openaiFake.configs).toHaveLength(0);
      expect(anthropicConfigs[0]).toMatchObject({
        baseUrl: 'https://claude.example.com',
        thinkingSupported: false,
      });
    });

    it('routes ollama-native endpoints through the ollama bridge factory with num_ctx', async () => {
      const ollamaConfigs: Array<{
        baseUrl: string;
        toolUseSupported?: boolean;
        modelContextWindow?: number;
        hostname?: string;
      }> = [];
      const p = new CustomEndpointProvider(
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama-native',
          baseUrl: 'http://localhost:11434',
          models: [
            {
              id: 'qwen2.5-coder:14b',
              capabilities: { toolUse: true, maxContextTokens: 32768 },
            },
          ],
        },
        {
          bridgeFactories: {
            'ollama-native': (config) => {
              ollamaConfigs.push({
                baseUrl: config.baseUrl,
                toolUseSupported: config.toolUseSupported,
                modelContextWindow: config.modelContextWindow,
                hostname: config.hostname,
              });
              return { port: 40600, stop: () => {} };
            },
          },
        }
      );
      await p.ensureBridgeStarted('qwen2.5-coder:14b');
      p.buildSdkConfig('qwen2.5-coder:14b');
      expect(ollamaConfigs).toHaveLength(1);
      expect(ollamaConfigs[0]).toMatchObject({
        baseUrl: 'http://localhost:11434',
        toolUseSupported: true,
        modelContextWindow: 32768,
        hostname: '127.0.0.1',
      });
    });

    it('applies per-type capability defaults (ollama disables caching/thinking)', async () => {
      const ollama = new CustomEndpointProvider(
        {
          id: 'ollama-default-caps',
          name: 'Ollama caps',
          type: 'ollama-native',
          baseUrl: 'http://localhost:11434',
          models: [{ id: 'llama3.2' }],
        },
        {
          bridgeFactories: {
            'ollama-native': () => ({ port: 40700, stop: () => {} }),
          },
        }
      );
      const ollamaCaps = resolveModelCapabilities(ollama.getConfig().models[0], ollama.getType());
      expect(ollamaCaps.caching).toBe(false);
      expect(ollamaCaps.thinking).toBe(false);

      const anthropic = new CustomEndpointProvider(
        {
          id: 'claude-default-caps',
          name: 'Anthropic caps',
          type: 'anthropic-messages',
          baseUrl: 'https://claude.example.com',
          models: [{ id: 'sonnet' }],
        },
        {
          bridgeFactories: {
            'anthropic-messages': () => ({ port: 40800, stop: () => {} }),
          },
        }
      );
      const anthropicCaps = resolveModelCapabilities(
        anthropic.getConfig().models[0],
        anthropic.getType()
      );
      expect(anthropicCaps.caching).toBe(true);
      expect(anthropicCaps.thinking).toBe(true);
      expect(anthropicCaps.vision).toBe(true);
    });
  });

  describe('setSessionThinkingConfig side-channel', () => {
    it('embeds sessionId into ANTHROPIC_AUTH_TOKEN so the bridge can identify the session', async () => {
      const fake = makeFakeBridge();
      const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
      await p.ensureBridgeStarted('qwen2.5-7b', { sessionId: 'sess-abc' });
      const cfg = p.buildSdkConfig('qwen2.5-7b', { sessionId: 'sess-abc' });
      expect(cfg.envVars.ANTHROPIC_AUTH_TOKEN).toBe('custom-endpoint:sess-abc');
    });

    it('forwards setSessionThinkingConfig to every chat bridge', async () => {
      const fake = makeFakeBridge();
      const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
      await p.ensureBridgeStarted('qwen2.5-7b');
      p.buildSdkConfig('qwen2.5-7b');
      await p.ensureBridgeStarted('qwen2.5-vl-7b');
      p.buildSdkConfig('qwen2.5-vl-7b');
      p.setSessionThinkingConfig('sess-1', 'think8k');
      expect(fake.thinkingConfigs).toHaveLength(2);
      expect(fake.thinkingConfigs[0]).toMatchObject({
        sessionId: 'sess-1',
        thinking: { type: 'enabled', budget_tokens: 8000 },
      });
      expect(fake.thinkingConfigs[1]).toMatchObject({
        sessionId: 'sess-1',
        thinking: { type: 'enabled', budget_tokens: 8000 },
      });
    });

    it('sends undefined thinking when level is off or unknown', async () => {
      const fake = makeFakeBridge();
      const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
      await p.ensureBridgeStarted('qwen2.5-7b');
      p.buildSdkConfig('qwen2.5-7b');
      p.setSessionThinkingConfig('sess-1', 'off');
      expect(fake.thinkingConfigs[0]).toMatchObject({
        sessionId: 'sess-1',
        thinking: undefined,
      });
    });
  });

  describe('chatTemplateKwargs', () => {
    it('forwards chatTemplateKwargs into the bridge config when declared on a model', async () => {
      const fake = makeFakeBridge();
      const p = new CustomEndpointProvider(
        {
          ...baseConfig,
          models: [
            {
              id: 'qwen3',
              capabilities: { toolUse: true, chatTemplateKwargs: { enable_thinking: false } },
            },
          ],
          defaultModelId: 'qwen3',
        },
        { bridgeFactory: fake.factory }
      );
      await p.ensureBridgeStarted('qwen3');
      p.buildSdkConfig('qwen3');
      expect(fake.configs[0].chatTemplateKwargs).toEqual({ enable_thinking: false });
    });

    it('produces distinct bridge instances for models that differ only in chatTemplateKwargs', async () => {
      const fake = makeFakeBridge();
      const p = new CustomEndpointProvider(
        {
          id: 'qwen3-shop',
          name: 'Qwen3 Shop',
          baseUrl: 'http://localhost:1234/v1',
          models: [
            {
              id: 'qwen3-thinking',
              capabilities: { toolUse: true, chatTemplateKwargs: { enable_thinking: true } },
            },
            {
              id: 'qwen3-fast',
              capabilities: { toolUse: true, chatTemplateKwargs: { enable_thinking: false } },
            },
          ],
          defaultModelId: 'qwen3-thinking',
        },
        { bridgeFactory: fake.factory }
      );
      await p.ensureBridgeStarted('qwen3-thinking');
      const a = p.buildSdkConfig('qwen3-thinking');
      await p.ensureBridgeStarted('qwen3-fast');
      const b = p.buildSdkConfig('qwen3-fast');
      expect(a.envVars.ANTHROPIC_BASE_URL).not.toBe(b.envVars.ANTHROPIC_BASE_URL);
      expect(fake.configs).toHaveLength(2);
      expect(fake.configs[0].chatTemplateKwargs).toEqual({ enable_thinking: true });
      expect(fake.configs[1].chatTemplateKwargs).toEqual({ enable_thinking: false });
    });

    it('omits chatTemplateKwargs from the bridge config when the model does not declare it', async () => {
      const fake = makeFakeBridge();
      const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
      await p.ensureBridgeStarted('qwen2.5-7b');
      p.buildSdkConfig('qwen2.5-7b');
      expect(fake.configs[0].chatTemplateKwargs).toBeUndefined();
    });
  });
});
