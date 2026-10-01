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
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
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

  describe('shutdown', () => {
    it('stops the bridges it started', async () => {
      const stopped: number[] = [];
      const provider = makeProvider({ OPENCODE_API_KEY: 'go-key' }, unreachableFetch(), {
        bridgeFactory: ((config: { modelContextWindow?: number }) => {
          const port = config.modelContextWindow === 200_000 ? 41234 : 41235;
          return { port, stop: () => stopped.push(port) };
        }) as never,
      });
      await provider.ensureBridgeStarted('glm-5.3', { sessionId: SESSION_ID });
      await provider.ensureBridgeStarted('kimi-k3', { sessionId: SESSION_ID });
      await provider.shutdown();
      expect(stopped.sort()).toEqual([41234, 41235]);
    });
  });
});
