import { describe, expect, it } from 'bun:test';
import {
  OpencodeProvider,
  type OpencodeProviderOptions,
} from '../../../../src/lib/providers/opencode-provider';

const SESSION_ID = 'session-abc';

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function recordingFetch(payload: unknown, calls: FetchCall[] = []): typeof fetch {
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return impl;
}

function unreachableFetch(): typeof fetch {
  return (async () => {
    throw new Error('unexpected network call');
  }) as unknown as typeof fetch;
}

function makeProvider(
  env: NodeJS.ProcessEnv = {},
  fetchImpl: typeof fetch = unreachableFetch(),
  options: OpencodeProviderOptions = {}
): OpencodeProvider {
  return new OpencodeProvider(env, fetchImpl, options);
}

function fakeBridgeFactory(ports: number[], configs: unknown[] = []) {
  let next = 0;
  return (config: unknown) => {
    configs.push(config);
    const port = ports[next] ?? ports[ports.length - 1] ?? 0;
    next += 1;
    return { port, stop: () => {} };
  };
}

describe('OpencodeProvider', () => {
  it('identifies itself as the OpenCode Go gateway', () => {
    const provider = makeProvider();
    expect(provider.id).toBe('opencode');
    expect(provider.displayName).toBe('OpenCode Go');
  });

  it('offers granular thinking, since every Go model reasons', () => {
    const provider = makeProvider();
    expect(provider.capabilities.extendedThinking).toBe(true);
    expect(provider.capabilities.thinkingModes).toBe('granular');
    expect(OpencodeProvider.MODELS.every((model) => model.thinkingModes === 'granular')).toBe(true);
  });

  it('asks the bridge to forward reasoning effort', async () => {
    const configs: Array<{ thinkingSupported?: boolean }> = [];
    const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
      bridgeFactory: fakeBridgeFactory([41234], configs),
    });
    await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
    expect(configs[0]?.thinkingSupported).toBe(true);
  });

  it('reads the key from OPENCODE_API_KEY', () => {
    expect(makeProvider({ OPENCODE_API_KEY: 'go-key' }).getApiKey()).toBe('go-key');
  });

  it('reads the key from OPENCODE_GO_API_KEY', () => {
    expect(makeProvider({ OPENCODE_GO_API_KEY: 'go-key-2' }).getApiKey()).toBe('go-key-2');
  });

  it('prefers the environment over stored credentials', () => {
    const provider = makeProvider({ OPENCODE_API_KEY: 'env-key' });
    provider.setCredentials({ type: 'api_key', apiKey: 'stored-key' });
    expect(provider.getApiKey()).toBe('env-key');
  });

  it('falls back to stored credentials', () => {
    const provider = makeProvider();
    provider.setCredentials({ type: 'api_key', apiKey: 'stored-key' });
    expect(provider.getApiKey()).toBe('stored-key');
    expect(provider.isAvailable()).toBe(true);
  });

  it('names the env var in the auth error', async () => {
    const status = await makeProvider().getAuthStatus();
    expect(status.isAuthenticated).toBe(false);
    expect(status.error).toContain('OPENCODE_API_KEY');
  });

  describe('client headers', () => {
    it('sends a client user agent and the session id', () => {
      expect(OpencodeProvider.clientHeaders(SESSION_ID)).toEqual({
        'User-Agent': 'hyperneo/1.0',
        'x-opencode-session': SESSION_ID,
      });
    });

    it('falls back to a daemon session when no session id is known', () => {
      expect(OpencodeProvider.clientHeaders()).toEqual({
        'User-Agent': 'hyperneo/1.0',
        'x-opencode-session': OpencodeProvider.DISCOVERY_SESSION_ID,
      });
      expect(OpencodeProvider.clientHeaders('   ')).toEqual(OpencodeProvider.clientHeaders());
    });

    it('serializes the headers the way ANTHROPIC_CUSTOM_HEADERS expects', () => {
      expect(OpencodeProvider.customHeadersLine(SESSION_ID)).toBe(
        'User-Agent: hyperneo/1.0\nx-opencode-session: session-abc'
      );
    });
  });

  describe('ownsModel', () => {
    it('claims catalogued models', () => {
      const provider = makeProvider();
      expect(provider.ownsModel('glm-5.3')).toBe(true);
      expect(provider.ownsModel('minimax-m3')).toBe(true);
    });

    it('refuses models the gateway serves only on its responses endpoint', () => {
      const provider = makeProvider();
      expect(provider.ownsModel('grok-4.7')).toBe(false);
      expect(provider.ownsModel('gpt-6-luna')).toBe(false);
      expect(provider.ownsModel('muse-spark-1.2-contributor')).toBe(false);
    });

    it('refuses models it has never heard of', () => {
      expect(makeProvider().ownsModel('claude-sonnet-4-5')).toBe(false);
    });

    it('claims ids discovered from the gateway', async () => {
      const provider = makeProvider(
        { OPENCODE_API_KEY: 'go-key' },
        recordingFetch({
          data: [{ id: 'brand-new-model', name: 'Brand New' }],
        })
      );
      await provider.listRemoteModels({ force: true });
      expect(provider.ownsModel('brand-new-model')).toBe(true);
    });
  });

  describe('buildSdkConfig', () => {
    it('throws when no key is configured', () => {
      expect(() => makeProvider().buildSdkConfig('minimax-m3')).toThrow(
        'OpenCode Go API key not configured'
      );
    });

    it('points messages-family models at the gateway with the session header', () => {
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' });
      const config = provider.buildSdkConfig('minimax-m3', { sessionId: SESSION_ID });
      expect(config.isAnthropicCompatible).toBe(true);
      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://opencode.ai/zen/go');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('go-key');
      expect(config.envVars.ANTHROPIC_CUSTOM_HEADERS).toBe(
        'User-Agent: hyperneo/1.0\nx-opencode-session: session-abc'
      );
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('minimax-m3');
    });

    it('honours a session base URL override', () => {
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' });
      const config = provider.buildSdkConfig('qwen3.8-max', {
        sessionId: SESSION_ID,
        baseUrl: 'http://127.0.0.1:9999',
      });
      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999');
    });

    it('requires its bridge before a chat model can be used', () => {
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' });
      expect(() => provider.buildSdkConfig('glm-5.3', { sessionId: SESSION_ID })).toThrow(
        'bridge not started'
      );
    });

    it('routes chat models through the bridge and names the session in the auth token', async () => {
      const configs: Array<{ baseUrl: string }> = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: fakeBridgeFactory([41234], configs),
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
      const config = provider.buildSdkConfig('glm-5.3', { sessionId: SESSION_ID });
      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:41234');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe(`opencode:${SESSION_ID}`);
      expect(config.envVars.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(configs[0]?.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    });

    it('hands the bridge a per-session header resolver instead of per-session servers', async () => {
      const configs: Array<{
        sessionTokenPrefix?: string;
        sessionHeaders?: (sessionId: string) => Record<string, string>;
      }> = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: fakeBridgeFactory([41234], configs),
      });
      await provider.ensureBridgeStarted('glm-5.3');
      expect(configs[0]?.sessionTokenPrefix).toBe('opencode');
      expect(configs[0]?.sessionHeaders?.('session-nine')).toEqual({
        'User-Agent': 'hyperneo/1.0',
        'x-opencode-session': 'session-nine',
      });
    });

    it('shares one bridge across sessions of the same model', async () => {
      const configs: unknown[] = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: fakeBridgeFactory([41234, 41235], configs),
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: 'session-one' });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: 'session-two' });
      expect(configs).toHaveLength(1);
      expect(
        provider.buildSdkConfig('glm-5.3', { sessionId: 'session-two' }).envVars.ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41234');
    });

    it('starts a separate bridge per model', async () => {
      const configs: unknown[] = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: fakeBridgeFactory([41234, 41235], configs),
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
      await provider.ensureBridgeStarted('kimi-k3', { sessionId: SESSION_ID });
      expect(configs).toHaveLength(2);
      expect(
        provider.buildSdkConfig('kimi-k3', { sessionId: SESSION_ID }).envVars.ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41235');
    });

    it('awaits an in-flight bridge instead of returning early', async () => {
      let release: (() => void) | undefined;
      const configs: unknown[] = [];
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: (async (config: unknown) => {
          configs.push(config);
          await gate;
          return { port: 41234, stop: () => {} };
        }) as never,
      });

      const first = provider.ensureBridgeStarted('glm-5.3', { sessionId: 'session-one' });
      const second = provider.ensureBridgeStarted('glm-5.3', { sessionId: 'session-two' });
      release?.();
      await Promise.all([first, second]);

      expect(configs).toHaveLength(1);
      expect(
        provider.buildSdkConfig('glm-5.3', { sessionId: 'session-two' }).envVars.ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41234');
    });

    it('clears a failed bridge attempt so the next warmup retries', async () => {
      let attempts = 0;
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: (async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('bridge refused');
          return { port: 41234, stop: () => {} };
        }) as never,
      });

      await expect(
        provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID })
      ).rejects.toThrow('bridge refused');
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });

      expect(attempts).toBe(2);
      expect(
        provider.buildSdkConfig('glm-5.3', { sessionId: SESSION_ID }).envVars.ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41234');
    });

    it('reuses one bridge for repeated warmups of the same model', async () => {
      const configs: unknown[] = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: fakeBridgeFactory([41234], configs),
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
      expect(configs).toHaveLength(1);
    });

    it('does not start a bridge for messages-family models', async () => {
      const configs: unknown[] = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: fakeBridgeFactory([41234], configs),
      });
      await provider.ensureBridgeStarted('minimax-m3', { sessionId: SESSION_ID });
      expect(configs).toHaveLength(0);
    });

    it('reports a model tier and a title model from the catalogue', () => {
      const provider = makeProvider();
      expect(provider.getModelForTier('sonnet')).toBe('glm-5.3');
      expect(provider.getTitleGenerationModel()).toBe('glm-5.3-flash');
    });
  });

  describe('context windows', () => {
    it('carries the window the gateway catalog publishes', () => {
      const provider = makeProvider();
      const byId = new Map(OpencodeProvider.MODELS.map((model) => [model.id, model]));
      expect(byId.get('deepseek-v4-pro')?.contextWindow).toBe(1_000_000);
      expect(byId.get('deepseek-v4-flash')?.contextWindow).toBe(1_000_000);
      expect(byId.get('glm-5.3')?.contextWindow).toBe(1_000_000);
      expect(byId.get('kimi-k3')?.contextWindow).toBe(1_048_576);
      expect(byId.get('minimax-m3')?.contextWindow).toBe(1_000_000);
      expect(byId.get('minimax-m2.7')?.contextWindow).toBe(204_800);
      expect(byId.get('hy3')?.contextWindow).toBe(256_000);
      expect(byId.get('space-bunny-free')?.contextWindow).toBe(1_048_576);
      expect(provider.contextWindowFor('deepseek-v4-pro')).toBe(1_000_000);
    });

    it('falls back to the baked catalogue when the catalog is unreachable', async () => {
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch());
      const metadata = await provider.modelMetadata('kimi-k3');
      expect(metadata.contextWindow).toBe(1_048_576);
      expect(metadata.wire).toBe('openai-chat');
    });

    it('reads windows and wire from the live catalog when it is reachable', async () => {
      const catalog = {
        'opencode-go': {
          models: {
            'glm-5.3': { name: 'GLM-5.3', limit: { context: 999 }, release_date: '2026-01-01' },
            'brand-new': {
              name: 'Brand New',
              limit: { context: 424_242 },
              provider: { npm: '@ai-sdk/anthropic' },
            },
            'brand-new-responses': {
              name: 'Brand New Responses',
              limit: { context: 111 },
              provider: { npm: '@ai-sdk/openai' },
            },
          },
        },
      };
      const provider = makeProvider(
        {
          OPENCODE_API_KEY: 'go-key',
          OPENCODE_MODELS_URL: 'https://catalog.test/api.json',
        },
        recordingFetch(catalog)
      );

      const metadata = await provider.modelMetadata('glm-5.3');
      expect(metadata.contextWindow).toBe(999);
      expect(provider.usesAnthropicMessages('brand-new')).toBe(true);
      expect(provider.contextWindowFor('brand-new')).toBe(424_242);
      expect(provider.supportsModelId('brand-new-responses')).toBe(false);

      const models = await provider.getModels();
      expect(models.find((model) => model.id === 'glm-5.3')?.contextWindow).toBe(999);
    });
  });

  describe('discovery', () => {
    it('returns nothing without a key', async () => {
      expect(await makeProvider().getModels()).toEqual([]);
    });

    it('sends the client headers on the model list request', async () => {
      const calls: FetchCall[] = [];
      const provider = makeProvider(
        { OPENCODE_API_KEY: 'go-key' },
        recordingFetch({ data: [{ id: 'glm-5.3', name: 'GLM-5.3' }] }, calls)
      );
      await provider.listRemoteModels({ force: true });
      const listCall = calls.find((call) => call.url.endsWith('/models'));
      expect(listCall?.url).toBe('https://opencode.ai/zen/go/v1/models');
      expect(listCall?.headers).toEqual({
        Authorization: 'Bearer go-key',
        'User-Agent': 'hyperneo/1.0',
        'x-opencode-session': OpencodeProvider.DISCOVERY_SESSION_ID,
      });
    });

    it('drops models the gateway serves only on its responses endpoint', async () => {
      const provider = makeProvider(
        { OPENCODE_API_KEY: 'go-key' },
        recordingFetch({
          data: [
            { id: 'glm-5.3', name: 'GLM-5.3' },
            { id: 'grok-4.7', name: 'Grok 4.7' },
            { id: 'hy3', name: 'Hy3' },
          ],
        })
      );
      const models = await provider.listRemoteModels({ force: true });
      expect(models.map((model) => model.id)).toEqual(['glm-5.3', 'hy3']);
    });

    it('keeps the catalogue when the probe fails', async () => {
      const failing = (async () =>
        new Response('nope', { status: 500 })) as unknown as typeof fetch;
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, failing);
      const models = await provider.getModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((model) => model.provider === 'opencode')).toBe(true);
    });
  });

  describe('session-scoped keys', () => {
    it('starts the bridge with the session key and keeps it separate from the provider key', async () => {
      const keys: Array<string | undefined> = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'provider-key' }, unreachableFetch(), {
        bridgeFactory: ((config: { apiKey?: string }) => {
          keys.push(config.apiKey);
          return { port: 41234 + keys.length, stop: () => {} };
        }) as never,
      });

      await provider.ensureBridgeStarted('glm-5.3', {
        sessionId: SESSION_ID,
        apiKey: 'session-key',
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });

      expect(keys).toEqual(['session-key', 'provider-key']);
      expect(
        provider.buildSdkConfig('glm-5.3', { sessionId: SESSION_ID, apiKey: 'session-key' }).envVars
          .ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41235');
      expect(
        provider.buildSdkConfig('glm-5.3', { sessionId: SESSION_ID }).envVars.ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41236');
    });
  });

  describe('session-scoped base URLs', () => {
    it('starts the bridge at the session base URL and keeps it separate', async () => {
      const baseUrls: string[] = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: ((config: { baseUrl: string }) => {
          baseUrls.push(config.baseUrl);
          return { port: 41234 + baseUrls.length, stop: () => {} };
        }) as never,
      });

      await provider.ensureBridgeStarted('glm-5.3', {
        sessionId: SESSION_ID,
        baseUrl: 'http://127.0.0.1:9080/go/v1',
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });

      expect(baseUrls).toEqual(['http://127.0.0.1:9080/go/v1', 'https://opencode.ai/zen/go/v1']);
      expect(
        provider.buildSdkConfig('glm-5.3', {
          sessionId: SESSION_ID,
          baseUrl: 'http://127.0.0.1:9080/go/v1',
        }).envVars.ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41235');
    });
  });

  describe('credentials', () => {
    it('does not cache a bridge whose credentials changed mid-build', async () => {
      let release: (() => void) | undefined;
      const stopped: number[] = [];
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: (async () => {
          await gate;
          return { port: 41234, stop: () => stopped.push(41234) };
        }) as never,
      });

      const warming = provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
      provider.setCredentials({ type: 'api_key', apiKey: 'rotated-key' });
      release?.();

      await expect(warming).rejects.toThrow('credentials changed');
      expect(stopped).toEqual([41234]);
      expect(() => provider.buildSdkConfig('glm-5.3', { sessionId: SESSION_ID })).toThrow(
        'bridge not started'
      );
    });

    it('drops warmed bridges so a rotated key reaches the next one', async () => {
      const stopped: number[] = [];
      const keys: Array<string | undefined> = [];
      let port = 41234;
      const provider = makeProvider({}, unreachableFetch(), {
        bridgeFactory: ((config: { apiKey?: string }) => {
          const assigned = port++;
          keys.push(config.apiKey);
          return { port: assigned, stop: () => stopped.push(assigned) };
        }) as never,
      });
      provider.setCredentials({ type: 'api_key', apiKey: 'first-key' });
      await provider.ensureBridgeStarted('glm-5.3');

      provider.setCredentials({ type: 'api_key', apiKey: 'second-key' });

      expect(stopped).toEqual([41234]);
      await provider.ensureBridgeStarted('glm-5.3');
      expect(keys).toEqual(['first-key', 'second-key']);
      expect(
        provider.buildSdkConfig('glm-5.3', { sessionId: SESSION_ID }).envVars.ANTHROPIC_BASE_URL
      ).toBe('http://127.0.0.1:41235');
    });

    it('keeps bridges when the same credentials are set again', async () => {
      const configs: unknown[] = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: fakeBridgeFactory([41234], configs),
      });
      await provider.ensureBridgeStarted('glm-5.3');
      provider.setCredentials({ type: 'api_key', apiKey: 'go-key' });
      expect(configs).toHaveLength(1);
    });
  });

  describe('shutdown', () => {
    it('stops the bridges it started', async () => {
      const stopped: number[] = [];
      let port = 41234;
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: (() => {
          const assigned = port++;
          return { port: assigned, stop: () => stopped.push(assigned) };
        }) as never,
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
      await provider.ensureBridgeStarted('kimi-k3', { sessionId: SESSION_ID });
      await provider.shutdown();
      expect(stopped.sort()).toEqual([41234, 41235]);
    });
  });
});
