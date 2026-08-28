import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { findInModels } from '../../../../src/lib/model-service';
import {
  KIMI_REGION_ENDPOINTS,
  KimiProvider,
  resolveKimiRegion,
} from '../../../../src/lib/providers/kimi-provider';
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';

describe('KimiProvider', () => {
  let provider: KimiProvider;
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_REGION;
    delete process.env.KIMI_BASE_URL;
  });

  afterEach(async () => {
    await provider?.shutdown();
    global.fetch = originalFetch;
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
        maxContextWindow: 1_048_576,
        functionCalling: true,
        vision: true,
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
    function makeProbeOkProvider(): KimiProvider {
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      return new KimiProvider(process.env, undefined, fetchImpl);
    }

    it('should return Kimi models when API key is available', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = makeProbeOkProvider();

      const models = await provider.getModels();

      expect(models.map((m) => m.id)).toEqual([
        'kimi-k3[1m]',
        'k3-256k',
        'kimi-k2.7-code-highspeed',
        'kimi-for-coding',
      ]);
      expect(models.every((m) => m.provider === 'kimi')).toBe(true);
    });

    it('should return empty array when API key is not available', async () => {
      provider = makeProbeOkProvider();
      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('synthesizes curated discovered IDs into the visible model list', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = makeProbeOkProvider();
      provider.setCuratedModels([
        { id: 'kimi-k4', name: 'Kimi K4' },
        { id: 'kimi-k3' },
        { id: 'kimi-for-coding' },
        { id: 'gpt-4o' },
      ]);

      const models = await provider.getModels();

      expect(models.map((m) => m.id)).toEqual([
        'kimi-k3[1m]',
        'k3-256k',
        'kimi-k2.7-code-highspeed',
        'kimi-for-coding',
        'kimi-k4',
      ]);
      const synthesized = models.find((m) => m.id === 'kimi-k4');
      expect(synthesized).toMatchObject({
        name: 'Kimi K4',
        alias: 'kimi-k4',
        family: 'kimi',
        provider: 'kimi',
        contextWindow: 262_144,
        thinkingModes: 'on',
        available: true,
      });
      expect(provider.getCachedModels()?.map((m) => m.id)).toContain('kimi-k4');

      provider.setCuratedModels(undefined);
      expect(provider.getCachedModels()).toBeNull();
      expect(await provider.getModels()).toEqual(KimiProvider.MODELS);
    });

    it('probes the upstream Anthropic-compatible endpoint with the API key', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.kimi.com/coding/v1/messages');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers.authorization).toBe('Bearer test-key');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('kimi-for-coding');
      expect(body.max_tokens).toBe(16001);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('probes the provider-level global endpoint and model when configured', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);
      provider.setDefaultRegion('global');

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('kimi-k2.7-code');
      expect(body.max_tokens).toBe(16001);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('probes the KIMI_REGION env endpoint when no provider default is set', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_REGION = 'global';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('kimi-k2.7-code');
      expect(body.max_tokens).toBe(16001);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('probes the KIMI_BASE_URL env endpoint when set', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_BASE_URL = 'https://custom.example.com/anthropic';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://custom.example.com/anthropic/v1/messages');
    });

    it('probes custom base URLs with legacy IDs when region defaults to china', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_BASE_URL = 'https://kimi-proxy.example.com/anthropic';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('kimi-for-coding');
    });

    it('infers the global region from a known KIMI_BASE_URL without KIMI_REGION', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_BASE_URL = 'https://api.moonshot.ai/anthropic';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('kimi-k2.7-code');
      expect(body.max_tokens).toBe(16001);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('probes the modern Moonshot Open Platform China endpoint with kimi-k2.7-code', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_BASE_URL = 'https://api.moonshot.cn/anthropic';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.moonshot.cn/anthropic/v1/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('kimi-k2.7-code');
      expect(body.max_tokens).toBe(16001);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('throws when upstream rejects the API key (401)', async () => {
      process.env.KIMI_API_KEY = 'bad-key';
      const fetchImpl = mock(
        async () => new Response('unauthorized', { status: 401 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Kimi API key rejected (HTTP 401)');
    });

    it('throws when probe times out / network fails', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Kimi probe failed: ECONNREFUSED');
    });

    it('caches successful probe for 30s so repeated calls do not re-probe', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = new KimiProvider(process.env, undefined, fetchImpl);

      await provider.getModels();
      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
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

    it('uses the China OpenAI endpoint instead of the Anthropic probe endpoint by default', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const { fetchMock, calls } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
      ]);
      provider = new KimiProvider();

      const models = await provider.listRemoteModels();

      expect(models).toEqual([KimiProvider.MODELS[3]]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = calls[0] ?? [];
      expect(url).toBe('https://api.kimi.com/coding/v1/models');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' });
    });

    it('returns only endpoint discovery when discoveryOnly is set, even with curated models', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      installModelListFetch([{ data: [] }, { data: [] }]);
      provider = new KimiProvider();
      provider.setCuratedModels([{ id: 'kimi', name: 'Kimi' }]);

      const merged = await provider.listRemoteModels();
      const discoveryOnly = await provider.listRemoteModels({ force: true, discoveryOnly: true });

      expect(merged.map((model) => model.id)).toContain('kimi-for-coding');
      expect(discoveryOnly).toEqual([]);
    });

    it('uses the global OpenAI endpoint rather than appending models to the Anthropic base', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_REGION = 'global';
      const { calls } = installModelListFetch([
        { data: [{ id: 'kimi-k2.7-code', object: 'model' }] },
      ]);
      provider = new KimiProvider();

      const models = await provider.listRemoteModels();

      expect(models[0]).toMatchObject({
        id: 'kimi-for-coding',
        provider: 'kimi',
        contextWindow: 262_144,
        thinkingModes: 'on',
        available: true,
      });
      expect(calls[0]?.[0]).toBe('https://api.moonshot.ai/v1/models');
      expect(String(calls[0]?.[0])).not.toContain('/anthropic/');
    });

    it('preserves a custom environment base URL and uses the injected fetch', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_BASE_URL = 'https://proxy.example.com/kimi';
      const fetchMock = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'kimi-for-coding', object: 'model' }] }), {
            status: 200,
          })
      );
      provider = new KimiProvider(process.env, undefined, fetchMock as unknown as typeof fetch);

      const models = await provider.listRemoteModels();

      expect(models).toEqual([KimiProvider.MODELS[3]]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://proxy.example.com/kimi/v1/models');
    });

    it('maps known message-base overrides to listing endpoints without mutating the region', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      process.env.KIMI_REGION = 'china';
      const { calls } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
        { data: [{ id: 'kimi-k2.7-code', object: 'model' }] },
        { data: [{ id: 'kimi-k2.7-code', object: 'model' }] },
      ]);
      provider = new KimiProvider();
      provider.setDefaultRegion('global');

      await provider.listRemoteModels();
      await provider.listRemoteModels({ baseUrl: 'https://api.kimi.com/coding' });
      await provider.listRemoteModels({ baseUrl: 'https://api.moonshot.ai/anthropic' });
      await provider.listRemoteModels({ baseUrl: 'https://api.moonshot.cn/anthropic' });

      expect(calls.map((call) => call[0])).toEqual([
        'https://api.kimi.com/coding/v1/models',
        'https://api.kimi.com/coding/v1/models',
        'https://api.moonshot.ai/v1/models',
        'https://api.moonshot.cn/v1/models',
      ]);
      expect(provider.getDefaultRegion()).toBe('global');
    });

    it('matches supported prefix aliases and surfaces unknown Kimi-family IDs as themselves', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      installModelListFetch([
        {
          data: [
            { id: 'moonshot-k3-preview', object: 'model' },
            { id: 'moonshot-v1-32k', object: 'model' },
            { id: 'kimi-k4', object: 'model' },
            { id: 'gpt-4o', object: 'model' },
          ],
        },
      ]);
      provider = new KimiProvider();

      const models = await provider.listRemoteModels();

      expect(models).toHaveLength(3);
      expect(models[0]).toMatchObject({
        id: 'kimi-k3[1m]',
        contextWindow: 1_048_576,
        thinkingModes: 'granular',
      });
      expect(models[1]).toMatchObject({
        id: 'moonshot-v1-32k',
        name: 'moonshot-v1-32k',
        alias: 'moonshot-v1-32k',
        family: 'kimi',
        provider: 'kimi',
        contextWindow: 32_768,
        thinkingModes: 'off',
        available: true,
      });
      expect(models[2]).toMatchObject({
        id: 'kimi-k4',
        name: 'kimi-k4',
        alias: 'kimi-k4',
        family: 'kimi',
        provider: 'kimi',
        contextWindow: 262_144,
        thinkingModes: 'on',
        available: true,
      });
    });

    it('surfaces discovered K3-family variants as themselves with granular thinking', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      installModelListFetch([
        {
          data: [
            { id: 'k3-preview', object: 'model' },
            { id: 'kimi-k4[1m]', object: 'model' },
            { id: 'moonshot-k30', object: 'model' },
            { id: 'kimi-k2.7-code[1m]', object: 'model' },
          ],
        },
      ]);
      provider = new KimiProvider();

      const models = await provider.listRemoteModels();

      expect(models).toHaveLength(4);
      expect(models[0]).toMatchObject({
        id: 'k3-preview',
        contextWindow: 262_144,
        thinkingModes: 'granular',
      });
      expect(models[1]).toMatchObject({
        id: 'kimi-k4[1m]',
        contextWindow: 1_048_576,
        thinkingModes: 'on',
      });
      expect(models[2]).toMatchObject({
        id: 'moonshot-k30',
        contextWindow: 262_144,
        thinkingModes: 'on',
      });
      expect(models[3]).toMatchObject({
        id: 'kimi-k2.7-code[1m]',
        contextWindow: 1_048_576,
        thinkingModes: 'on',
      });
      expect(provider.getModelThinkingMode('k3-preview')).toBe('granular');
      expect(KimiProvider.isKimiK3OneMModel('k3-preview')).toBe(true);
    });

    it('preserves capacity-tagged K3 discovery IDs instead of collapsing them to the 1M entry', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      installModelListFetch([{ data: [{ id: 'moonshot-k3-128k', object: 'model' }] }]);
      provider = new KimiProvider();

      const models = await provider.listRemoteModels();

      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        id: 'moonshot-k3-128k',
        name: 'moonshot-k3-128k',
        family: 'kimi',
        provider: 'kimi',
        contextWindow: 131_072,
        thinkingModes: 'granular',
        available: true,
      });
    });

    it('disables thinking for small-capacity discovered models whose window cannot fit a budget', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      installModelListFetch([{ data: [{ id: 'moonshot-v1-8k', object: 'model' }] }]);
      provider = new KimiProvider();

      const models = await provider.listRemoteModels();

      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        id: 'moonshot-v1-8k',
        contextWindow: 8_192,
        thinkingModes: 'off',
      });
      expect(provider.getModelThinkingMode('moonshot-v1-8k')).toBe('off');
      expect(provider.getModelThinkingMode('moonshot-v1-32k')).toBe('off');
      expect(provider.getModelThinkingMode('moonshot-v1-128k')).toBeUndefined();
      expect(provider.getModelThinkingMode('kimi-for-coding')).toBe('on');
    });

    it('caches successful discovery and force bypasses the cache', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const { fetchMock } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
        { data: [{ id: 'kimi-k3', object: 'model' }] },
      ]);
      provider = new KimiProvider();

      const first = await provider.listRemoteModels();
      const cached = await provider.listRemoteModels();
      const forced = await provider.listRemoteModels({ force: true });

      expect(first).toEqual(cached);
      expect(forced[0]?.id).toBe('kimi-k3[1m]');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps curated synthesis across forced discovery refreshes', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const { fetchMock } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
      ]);
      provider = new KimiProvider();
      provider.setCuratedModels([{ id: 'kimi-k4', name: 'Kimi K4' }]);

      await provider.listRemoteModels();
      const forced = await provider.listRemoteModels({ force: true });

      expect(forced.map((m) => m.id)).toEqual(['kimi-for-coding', 'kimi-k4']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('propagates forced discovery failures instead of serving the cached list', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      let calls = 0;
      global.fetch = mock(async () => {
        calls++;
        return calls === 1
          ? new Response(JSON.stringify({ data: [{ id: 'kimi-for-coding' }] }), { status: 200 })
          : new Response('unavailable', { status: 503 });
      }) as unknown as typeof fetch;
      provider = new KimiProvider();

      await provider.listRemoteModels();

      await expect(provider.listRemoteModels({ force: true })).rejects.toThrow(
        'Endpoint returned HTTP 503'
      );
    });

    it('rejects discovery without credentials', async () => {
      provider = new KimiProvider();

      await expect(provider.listRemoteModels()).rejects.toThrow('Kimi API key not configured');
    });

    it('refetches against the new endpoint when the default region changes', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const { fetchMock, calls } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
        { data: [{ id: 'kimi-k2.7-code', object: 'model' }] },
      ]);
      provider = new KimiProvider();

      await provider.listRemoteModels();
      provider.setDefaultRegion('global');
      const models = await provider.listRemoteModels();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(calls[0]?.[0]).toBe('https://api.kimi.com/coding/v1/models');
      expect(calls[1]?.[0]).toBe('https://api.moonshot.ai/v1/models');
      expect(models).toEqual([KimiProvider.MODELS[3]]);
    });

    it('serves the cached list again when the region does not change', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const { fetchMock } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
      ]);
      provider = new KimiProvider();

      await provider.listRemoteModels();
      provider.setDefaultRegion('china');
      const models = await provider.listRemoteModels();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(models).toEqual([KimiProvider.MODELS[3]]);
    });

    it('keeps baseUrl override probes out of the discovery cache', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const { fetchMock } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
        { data: [{ id: 'kimi-k3', object: 'model' }] },
      ]);
      provider = new KimiProvider();

      await provider.listRemoteModels({ baseUrl: 'https://proxy.example.com/kimi' });
      const models = await provider.listRemoteModels();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(models[0]?.id).toBe('kimi-k3[1m]');
    });

    it('getModels merges the cached discovered list without an extra list fetch', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      const { fetchMock } = installModelListFetch([
        { data: [{ id: 'kimi-for-coding', object: 'model' }] },
        {},
      ]);
      provider = new KimiProvider();

      await provider.listRemoteModels();
      const models = await provider.getModels();

      expect(models).toEqual(KimiProvider.MODELS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('ownsModel', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should own kimi and moonshot model IDs', () => {
      expect(provider.ownsModel('kimi')).toBe(true);
      expect(provider.ownsModel('k3')).toBe(true);
      expect(provider.ownsModel('kimi-k3')).toBe(true);
      expect(provider.ownsModel('k3-256k')).toBe(true);
      expect(provider.ownsModel('kimi-k3-256k')).toBe(true);
      expect(provider.ownsModel('kimi-k2.7-code')).toBe(true);
      expect(provider.ownsModel('kimi-k2.7-code-highspeed')).toBe(true);
      expect(provider.ownsModel('kimi-for-coding-highspeed')).toBe(true);
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

  describe('discovered model routing acceptance', () => {
    beforeEach(() => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();
    });

    it('routes a discovered Kimi-family ID to itself instead of the region default', () => {
      expect(provider.ownsModel('kimi-k4')).toBe(true);

      const config = provider.buildSdkConfig('kimi-k4');

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k4');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k4');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k4');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k4');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
      expect(provider.translateModelIdForSdk('kimi-k4')).toBe('kimi-k4');
    });

    it('keeps discovered IDs on themselves in the global region', () => {
      const config = provider.buildSdkConfig('kimi-k4', { region: 'global' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k4');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k4');
    });

    it('honors the 1M suffix on discovered IDs while keeping 256K exceptions', () => {
      expect(KimiProvider.resolveContextWindow('k3-preview[1m]')).toBe(1_048_576);
      expect(KimiProvider.resolveContextWindow('kimi-k4[1m]')).toBe(1_048_576);
      expect(KimiProvider.resolveContextWindow('k3-preview')).toBe(262_144);
      expect(KimiProvider.resolveContextWindow('k3-256k[1m]')).toBe(262_144);
      expect(KimiProvider.resolveContextWindow('moonshot-k3-256k')).toBe(262_144);
      expect(KimiProvider.resolveContextWindow('kimi-k3')).toBe(1_048_576);

      const config = provider.buildSdkConfig('kimi-k4[1m]');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k4[1m]');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('derives smaller context windows from discovered capacity suffixes', () => {
      expect(KimiProvider.resolveContextWindow('moonshot-v1-8k')).toBe(8_192);
      expect(KimiProvider.resolveContextWindow('moonshot-v1-32k')).toBe(32_768);
      expect(KimiProvider.resolveContextWindow('moonshot-v1-128k')).toBe(131_072);
      expect(KimiProvider.resolveContextWindow('moonshot-v1-256k')).toBe(262_144);

      const config = provider.buildSdkConfig('moonshot-v1-32k');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('moonshot-v1-32k');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('32768');
    });

    it('routes capacity-tagged K3 discovery IDs to themselves, not the 1M flagship', () => {
      expect(provider.buildSdkConfig('moonshot-k3-128k').envVars.ANTHROPIC_MODEL).toBe(
        'moonshot-k3-128k'
      );
      expect(
        provider.buildSdkConfig('moonshot-k3-32k').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      ).toBe('32768');
      expect(provider.translateModelIdForSdk('moonshot-k3-128k')).toBe('moonshot-k3-128k');
      expect(provider.getModelThinkingMode('moonshot-k3-128k')).toBe('granular');

      expect(provider.translateModelIdForSdk('moonshot-k3')).toBe('kimi-k3[1m]');
      expect(provider.translateModelIdForSdk('moonshot-k3-preview')).toBe('kimi-k3[1m]');
      expect(provider.translateModelIdForSdk('moonshot-k3-256k-preview')).toBe('k3-256k');
      expect(KimiProvider.resolveContextWindow('k3-256k')).toBe(262_144);
    });

    it('preserves newly discovered moonshot IDs instead of routing them to K2.7', () => {
      expect(provider.ownsModel('moonshot-k4')).toBe(true);

      const config = provider.buildSdkConfig('moonshot-k4');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('moonshot-k4');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('moonshot-k4');
      expect(provider.translateModelIdForSdk('moonshot-k4')).toBe('moonshot-k4');
    });

    it('classifies only delimiter-bounded K3 variants as K3 family', () => {
      expect(KimiProvider.isKimiK3Model('k3-preview')).toBe(true);
      expect(KimiProvider.isKimiK3Model('kimi-k3-preview')).toBe(true);
      expect(KimiProvider.isKimiK3Model('moonshot-k3-preview')).toBe(true);
      expect(KimiProvider.isKimiK3Model('kimi-k30')).toBe(false);
      expect(KimiProvider.isKimiK3Model('k330')).toBe(false);
      expect(provider.getModelThinkingMode('kimi-k30')).toBeUndefined();
    });

    it('keeps boundary-crossing moonshot IDs and suffixed known IDs on themselves', () => {
      expect(provider.buildSdkConfig('moonshot-k30').envVars.ANTHROPIC_MODEL).toBe('moonshot-k30');
      expect(provider.translateModelIdForSdk('moonshot-k30')).toBe('moonshot-k30');
      expect(findInModels(KimiProvider.MODELS, 'moonshot-k30')).toBeUndefined();
      expect(findInModels(KimiProvider.MODELS, 'moonshot-k3[1m]')?.id).toBe('kimi-k3[1m]');
      expect(provider.getModelThinkingMode('moonshot-v1-128k')).toBeUndefined();

      const suffixed = provider.buildSdkConfig('kimi-k2.7-code[1m]');
      expect(suffixed.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code[1m]');
      expect(suffixed.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
      expect(provider.translateModelIdForSdk('kimi-k2.7-code[1m]')).toBe('kimi-k2.7-code[1m]');
    });

    it('keeps foreign and colon-tagged IDs on the region default', () => {
      expect(provider.ownsModel('gpt-4o')).toBe(false);
      expect(provider.ownsModel('abab6.5s-chat')).toBe(false);
      expect(provider.ownsModel('kimi-k4:latest')).toBe(false);
      expect(provider.ownsModel('moonshot-k4:latest')).toBe(false);
      expect(provider.ownsModel('moonshot-k3:latest')).toBe(false);

      const config = provider.buildSdkConfig('gpt-4o');
      const suffixedForeign = provider.buildSdkConfig('gpt-4o[1m]');
      const suffixedColonTagged = provider.buildSdkConfig('moonshot-k4:latest[1m]');

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(suffixedForeign.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(suffixedColonTagged.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(suffixedForeign.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
      expect(KimiProvider.resolveContextWindow('gpt-4o[1m]')).toBe(262_144);
      expect(KimiProvider.resolveContextWindow('moonshot-k4:latest[1m]')).toBe(262_144);
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
    it('should route directly to the native Anthropic-compatible endpoint', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-for-coding');

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
      expect(config.envVars.ANTHROPIC_API_KEY).toBeUndefined();
      expect(config.envVars.API_TIMEOUT_MS).toBe('3000000');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ENABLE_TOOL_SEARCH).toBe('false');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
      expect(config.envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(config.isAnthropicCompatible).toBe(true);
      expect(config.apiVersion).toBe('v1');
    });

    it('should normalize aliases to China model by default', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi');

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-for-coding');
    });

    it('should normalize mixed-case aliases to China model by default', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('Kimi');

      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
    });

    it('routes moonshot- prefixed discovered IDs to themselves by default', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('moonshot-v1-32k');

      expect(config.envVars.ANTHROPIC_MODEL).toBe('moonshot-v1-32k');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('moonshot-v1-32k');
    });

    it('should use session config API key and base URL overrides', () => {
      process.env.KIMI_API_KEY = 'env-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-for-coding', {
        apiKey: 'session-key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
      expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
    });

    it('should throw when no API key is configured', () => {
      provider = new KimiProvider();

      expect(() => provider.buildSdkConfig('kimi-for-coding')).toThrow(
        'Kimi API key not configured'
      );
    });
  });

  describe('region resolution', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('exposes china + global endpoints in KIMI_REGION_ENDPOINTS', () => {
      expect(KIMI_REGION_ENDPOINTS.china.anthropicBaseUrl).toBe('https://api.kimi.com/coding');
      expect(KIMI_REGION_ENDPOINTS.china.openAiBaseUrl).toBe('https://api.kimi.com/coding/v1');
      expect(KIMI_REGION_ENDPOINTS.china.modelId).toBe('kimi-for-coding');
      expect(KIMI_REGION_ENDPOINTS.global.anthropicBaseUrl).toBe(
        'https://api.moonshot.ai/anthropic'
      );
      expect(KIMI_REGION_ENDPOINTS.global.openAiBaseUrl).toBe('https://api.moonshot.ai/v1');
      expect(KIMI_REGION_ENDPOINTS.global.modelId).toBe('kimi-k2.7-code');
    });

    it('resolveKimiRegion returns the region for valid inputs', () => {
      expect(resolveKimiRegion('china')).toBe('china');
      expect(resolveKimiRegion('global')).toBe('global');
    });

    it('resolveKimiRegion is case-insensitive for hand-crafted payloads', () => {
      expect(resolveKimiRegion('CHINA')).toBe('china');
      expect(resolveKimiRegion('Global')).toBe('global');
      expect(resolveKimiRegion('  Global  ')).toBe('china');
    });

    it('resolveKimiRegion defaults to china for missing/invalid region', () => {
      expect(resolveKimiRegion(undefined)).toBe('china');
      expect(resolveKimiRegion(null)).toBe('china');
      expect(resolveKimiRegion('')).toBe('china');
      expect(resolveKimiRegion('us')).toBe('china');
      expect(resolveKimiRegion(42)).toBe('china');
    });

    it('static getBaseUrlForRegion returns the correct Anthropic-compatible URL', () => {
      expect(KimiProvider.getBaseUrlForRegion('china')).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.getBaseUrlForRegion('global')).toBe('https://api.moonshot.ai/anthropic');
      expect(KimiProvider.getBaseUrlForRegion()).toBe('https://api.kimi.com/coding');
    });

    it('static getOpenAiBaseUrlForRegion returns the correct OpenAI-compatible URL', () => {
      expect(KimiProvider.getOpenAiBaseUrlForRegion('china')).toBe(
        'https://api.kimi.com/coding/v1'
      );
      expect(KimiProvider.getOpenAiBaseUrlForRegion('global')).toBe('https://api.moonshot.ai/v1');
    });

    it('static getModelIdForRegion returns the correct region model ID', () => {
      expect(KimiProvider.getModelIdForRegion('china')).toBe('kimi-for-coding');
      expect(KimiProvider.getModelIdForRegion('global')).toBe('kimi-k2.7-code');
      expect(KimiProvider.getModelIdForRegion()).toBe('kimi-for-coding');
    });

    it('default provider region is china when unset', () => {
      expect(provider.getDefaultRegion()).toBe('china');
    });

    it('setDefaultRegion updates the provider-level default region', () => {
      provider.setDefaultRegion('global');
      expect(provider.getDefaultRegion()).toBe('global');
    });

    it('BASE_URL static stays on the China endpoint for backward compatibility', () => {
      expect(KimiProvider.BASE_URL).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.OPENAI_BASE_URL).toBe('https://api.kimi.com/coding/v1');
    });
  });

  describe('buildSdkConfig region routing', () => {
    it('routes to the China endpoint when no region is configured', () => {
      process.env.KIMI_API_KEY = 'test-key';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-for-coding');

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('routes to the Global endpoint when sessionConfig.region is global', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'global',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k2.7-code');
    });

    it('routes to the China endpoint when sessionConfig.region is china', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'china',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('falls back to provider-level default region when sessionConfig omits region', () => {
      provider = new KimiProvider();
      provider.setDefaultRegion('global');

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('per-session region overrides provider-level default region', () => {
      provider = new KimiProvider();
      provider.setDefaultRegion('global');

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key', region: 'china' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('uses legacy IDs for unknown custom base URLs when provider default is china', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        baseUrl: 'https://custom.example.com/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('uses modern IDs for unknown custom base URLs when region is global', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'global',
        baseUrl: 'https://custom.example.com/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('uses legacy IDs for unknown custom base URLs when region is china', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'china',
        baseUrl: 'https://custom.example.com/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('routes k3 alias to legacy ID on custom China base URLs', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('k3', {
        apiKey: 'key',
        region: 'china',
        baseUrl: 'https://kimi-proxy.example.com/anthropic',
      });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('routes k3 alias to modern ID on custom global base URLs', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('k3', {
        apiKey: 'key',
        region: 'global',
        baseUrl: 'https://kimi-proxy.example.com/anthropic',
      });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('KIMI_BASE_URL env var overrides region selection', () => {
      process.env.KIMI_BASE_URL = 'https://env.example.com/anthropic';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key', region: 'global' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://env.example.com/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('rejects OpenAI-compatible /v1 base URL overrides', () => {
      provider = new KimiProvider();

      expect(() =>
        provider.buildSdkConfig('kimi-k2.7-code', {
          apiKey: 'key',
          baseUrl: 'https://api.moonshot.ai/v1',
        })
      ).toThrow(/OpenAI-compatible \/v1 endpoint/);
    });

    it('KIMI_REGION env var sets the default region', () => {
      process.env.KIMI_REGION = 'global';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('invalid sessionConfig.region falls back to china (not global)', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'us' as unknown,
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });

    it('returns the selected native endpoint for each region', () => {
      provider = new KimiProvider();

      const chinaConfig = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'china',
      });
      const globalConfig = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'global',
      });

      expect(chinaConfig.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
      expect(chinaConfig.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
      expect(globalConfig.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(globalConfig.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('infers the global region from a global KIMI_BASE_URL override', () => {
      process.env.KIMI_BASE_URL = 'https://api.moonshot.ai/anthropic';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('infers the china region from a china KIMI_BASE_URL override', () => {
      process.env.KIMI_BASE_URL = 'https://api.moonshot.cn/anthropic';
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('uses modern Open Platform IDs when base URL is a modern endpoint', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code', {
        apiKey: 'key',
        region: 'china',
        baseUrl: 'https://api.moonshot.ai/anthropic',
      });

      expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
    });

    it('routes kimi-k3 to the Kimi Code fixed ID kimi-k3', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k3', { apiKey: 'key', region: 'global' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3');
      expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k3');
      expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k3');
      expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3');
      expect(config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('routes kimi-k2.7-code-highspeed to the Kimi Code fixed ID', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code-highspeed', {
        apiKey: 'key',
        region: 'global',
      });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code-highspeed');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
    });

    it('routes k3 alias to the modern Kimi Code fixed ID on global endpoints', async () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('k3', { apiKey: 'key', region: 'global' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('routes k3 alias to the legacy Kimi Code ID on the default China endpoint', async () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('k3', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('routes kimi-k2.7-code-highspeed to the legacy ID on the default China endpoint', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k2.7-code-highspeed', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding-highspeed');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
    });

    it('routes moonshot.cn overrides to modern Open Platform IDs', () => {
      provider = new KimiProvider();

      const k3Config = provider.buildSdkConfig('kimi-k3', {
        apiKey: 'key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });
      const highspeedConfig = provider.buildSdkConfig('kimi-k2.7-code-highspeed', {
        apiKey: 'key',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      });

      expect(k3Config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3');
      expect(highspeedConfig.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code-highspeed');
    });

    it('routes moonshot-k3 alias to the Kimi Code fixed ID kimi-k3', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('moonshot-k3', { apiKey: 'key', region: 'global' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('routes moonshot-k3-prefixed aliases to the Kimi Code fixed ID kimi-k3', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('moonshot-k3-preview', {
        apiKey: 'key',
        region: 'global',
      });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('routes legacy kimi alias to the region-specific K2.7 model', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi', { apiKey: 'key', region: 'global' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
    });

    it('preserves the [1m] suffix in upstream K3 IDs for explicit 1M selections', () => {
      provider = new KimiProvider();

      const k3Config = provider.buildSdkConfig('k3[1m]', { apiKey: 'key', region: 'global' });
      const kimiK3Config = provider.buildSdkConfig('kimi-k3[1m]', {
        apiKey: 'key',
        region: 'global',
      });

      expect(k3Config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3[1m]');
      expect(k3Config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k3[1m]');
      expect(k3Config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k3[1m]');
      expect(k3Config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3[1m]');
      expect(k3Config.envVars.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k3[1m]');
      expect(k3Config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
      expect(kimiK3Config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3[1m]');
      expect(kimiK3Config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('uses the bare K3 upstream ID when the 1M suffix is not selected', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('kimi-k3', { apiKey: 'key', region: 'global' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    });

    it('routes k3-256k to the legacy ID on the default China endpoint', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('k3-256k', { apiKey: 'key' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('k3-256k');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
    });

    it('routes k3-256k to the modern Open Platform ID on global endpoints', () => {
      provider = new KimiProvider();

      const config = provider.buildSdkConfig('k3-256k', { apiKey: 'key', region: 'global' });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-k3-256k');
      expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
    });

    it('never appends the [1m] suffix to the k3-256k upstream ID', () => {
      provider = new KimiProvider();

      const chinaConfig = provider.buildSdkConfig('k3-256k', { apiKey: 'key', region: 'china' });
      const globalConfig = provider.buildSdkConfig('kimi-k3-256k', {
        apiKey: 'key',
        region: 'global',
      });

      expect(chinaConfig.envVars.ANTHROPIC_MODEL).toBe('k3-256k');
      expect(globalConfig.envVars.ANTHROPIC_MODEL).toBe('kimi-k3-256k');
    });
  });

  describe('translateModelIdForSdk', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return canonical model ID to avoid settings.json overrides', () => {
      expect(provider.translateModelIdForSdk('kimi-k2.7-code')).toBe('kimi-k2.7-code');
      expect(provider.translateModelIdForSdk('kimi-for-coding')).toBe('kimi-for-coding');
      expect(provider.translateModelIdForSdk('moonshot-v1-32k')).toBe('moonshot-v1-32k');
      expect(provider.translateModelIdForSdk('moonshot-k4')).toBe('moonshot-k4');
      expect(provider.translateModelIdForSdk('moonshot-k3')).toBe('kimi-k3[1m]');
      expect(provider.translateModelIdForSdk('moonshot-k3-preview')).toBe('kimi-k3[1m]');
      expect(provider.translateModelIdForSdk('kimi')).toBe('kimi-for-coding');
      expect(provider.translateModelIdForSdk('k3')).toBe('kimi-k3[1m]');
      expect(provider.translateModelIdForSdk('kimi-k3')).toBe('kimi-k3[1m]');
      expect(provider.translateModelIdForSdk('k3-256k')).toBe('k3-256k');
      expect(provider.translateModelIdForSdk('kimi-k3-256k')).toBe('k3-256k');
      expect(provider.translateModelIdForSdk('moonshot-k3-256k-preview')).toBe('k3-256k');
      expect(provider.translateModelIdForSdk('kimi-k2.7-code-highspeed')).toBe(
        'kimi-k2.7-code-highspeed'
      );
      expect(provider.translateModelIdForSdk('k3[1m]')).toBe('kimi-k3[1m]');
      expect(provider.translateModelIdForSdk('kimi-k3[1m]')).toBe('kimi-k3[1m]');
    });
  });

  describe('static models', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should have correct static model definitions', () => {
      expect(KimiProvider.BASE_URL).toBe('https://api.kimi.com/coding');
      expect(KimiProvider.MODELS).toHaveLength(4);
      expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-k3[1m]')?.contextWindow).toBe(
        1_048_576
      );
      expect(KimiProvider.MODELS.find((m) => m.id === 'k3-256k')?.contextWindow).toBe(262_144);
      expect(
        KimiProvider.MODELS.find((m) => m.id === 'kimi-k2.7-code-highspeed')?.contextWindow
      ).toBe(262_144);
      expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-for-coding')?.contextWindow).toBe(
        262_144
      );
    });

    it('exposes a granular thinking picker for K3 models and binary for K2.7', () => {
      expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-k3[1m]')?.thinkingModes).toBe(
        'granular'
      );
      expect(KimiProvider.MODELS.find((m) => m.id === 'k3-256k')?.thinkingModes).toBe('granular');
      expect(
        KimiProvider.MODELS.find((m) => m.id === 'kimi-k2.7-code-highspeed')?.thinkingModes
      ).toBe('on');
      expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-for-coding')?.thinkingModes).toBe('on');
    });

    it('should mark every Kimi model with preferContextWindowMetadata', () => {
      expect(KimiProvider.MODELS.every((m) => m.preferContextWindowMetadata)).toBe(true);
    });

    it('keeps the coding model free of a broad moonshot- prefix so discovered IDs stay themselves', () => {
      const codingModel = KimiProvider.MODELS.find((m) => m.id === 'kimi-for-coding')!;
      const providerAliases = codingModel.providerAliases ?? [];
      expect(providerAliases).toContain('KIMI');
      expect(providerAliases).toContain('kimi-k2.7-code');
      expect(codingModel.providerAliasPrefixes ?? []).not.toContain('moonshot-');
    });

    it('should expose k3 alias on the K3 model', () => {
      const k3 = KimiProvider.MODELS.find((m) => m.id === 'kimi-k3[1m]')!;
      expect(k3.providerAliases).toContain('k3');
      expect(k3.providerAliasPrefixes).toContain('moonshot-k3');
    });

    it('registers the global k3-256k SDK id so the context bar matches it', () => {
      const k3_256k = KimiProvider.MODELS.find((m) => m.id === 'k3-256k')!;
      expect(k3_256k.sdkModelIds).toContain('kimi-k3-256k');
    });

    it('resolves moonshot alias prefixes by longest match so 256K aliases do not collapse to the 1M entry', () => {
      expect(findInModels(KimiProvider.MODELS, 'moonshot-k3-256k-preview')?.id).toBe('k3-256k');
      expect(findInModels(KimiProvider.MODELS, 'moonshot-k3-256k')?.id).toBe('k3-256k');
      expect(findInModels(KimiProvider.MODELS, 'moonshot-k3-preview')?.id).toBe('kimi-k3[1m]');
      expect(findInModels(KimiProvider.MODELS, 'moonshot-v1-32k')).toBeUndefined();
    });
  });

  describe('resolveKimiTitleThinkingConfig', () => {
    it('omits thinking for all Kimi K3 model IDs', () => {
      expect(KimiProvider.resolveKimiTitleThinkingConfig('kimi-k3')).toBeUndefined();
      expect(KimiProvider.resolveKimiTitleThinkingConfig('k3')).toBeUndefined();
      expect(KimiProvider.resolveKimiTitleThinkingConfig('k3-256k')).toBeUndefined();
      expect(KimiProvider.resolveKimiTitleThinkingConfig('moonshot-k3-preview')).toBeUndefined();
      expect(KimiProvider.resolveKimiTitleThinkingConfig('kimi-k3[1m]')).toBeUndefined();
      expect(KimiProvider.resolveKimiTitleThinkingConfig('k3[1m]')).toBeUndefined();
    });

    it('returns enabled thinking for all Kimi K2.7 model IDs', () => {
      expect(KimiProvider.resolveKimiTitleThinkingConfig('kimi-k2.7-code')).toEqual({
        type: 'enabled',
        budgetTokens: 16000,
      });
      expect(KimiProvider.resolveKimiTitleThinkingConfig('kimi-k2.7-code-highspeed')).toEqual({
        type: 'enabled',
        budgetTokens: 16000,
      });
      expect(KimiProvider.resolveKimiTitleThinkingConfig('kimi-for-coding')).toEqual({
        type: 'enabled',
        budgetTokens: 16000,
      });
      expect(KimiProvider.resolveKimiTitleThinkingConfig('moonshot-v1-32k')).toEqual({
        type: 'disabled',
      });
    });

    it('returns disabled thinking for non-Kimi models', () => {
      expect(KimiProvider.resolveKimiTitleThinkingConfig('claude-sonnet-4-5')).toEqual({
        type: 'disabled',
      });
      expect(KimiProvider.resolveKimiTitleThinkingConfig('glm-5')).toEqual({ type: 'disabled' });
    });
  });

  describe('getModelThinkingMode', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('returns granular for all Kimi K3 variants', () => {
      expect(provider.getModelThinkingMode('kimi-k3')).toBe('granular');
      expect(provider.getModelThinkingMode('kimi-k3[1m]')).toBe('granular');
      expect(provider.getModelThinkingMode('k3')).toBe('granular');
      expect(provider.getModelThinkingMode('k3-256k')).toBe('granular');
      expect(provider.getModelThinkingMode('kimi-k3-256k')).toBe('granular');
      expect(provider.getModelThinkingMode('moonshot-k3-preview')).toBe('granular');
    });

    it('returns on for Kimi K2.7 models', () => {
      expect(provider.getModelThinkingMode('kimi-for-coding')).toBe('on');
      expect(provider.getModelThinkingMode('kimi-k2.7-code')).toBe('on');
      expect(provider.getModelThinkingMode('kimi-k2.7-code-highspeed')).toBe('on');
      expect(provider.getModelThinkingMode('kimi-for-coding-highspeed')).toBe('on');
    });

    it('falls back to undefined for non-Kimi or unknown models', () => {
      expect(provider.getModelThinkingMode('claude-sonnet-4-5')).toBeUndefined();
      expect(provider.getModelThinkingMode('glm-5')).toBeUndefined();
    });
  });

  describe('isKimiK3OneMModel', () => {
    it('returns true only for the 1M K3 flagship, not the 256K variant', () => {
      expect(KimiProvider.isKimiK3OneMModel('kimi-k3')).toBe(true);
      expect(KimiProvider.isKimiK3OneMModel('kimi-k3[1m]')).toBe(true);
      expect(KimiProvider.isKimiK3OneMModel('k3')).toBe(true);
      expect(KimiProvider.isKimiK3OneMModel('moonshot-k3-preview')).toBe(true);
      expect(KimiProvider.isKimiK3OneMModel('k3-256k')).toBe(false);
      expect(KimiProvider.isKimiK3OneMModel('kimi-k3-256k')).toBe(false);
      expect(KimiProvider.isKimiK3OneMModel('moonshot-k3-256k-preview')).toBe(false);
    });
  });

  describe('getTitleGenerationModel', () => {
    beforeEach(() => {
      provider = new KimiProvider();
    });

    it('should return the default (legacy China) model', () => {
      expect(provider.getTitleGenerationModel()).toBe('kimi-for-coding');
    });

    it('title generation resolves the default model to the region-specific upstream ID', () => {
      provider.setDefaultRegion('global');
      const config = provider.buildSdkConfig(provider.getTitleGenerationModel(), {
        apiKey: 'key',
        region: 'china',
      });

      expect(config.envVars.ANTHROPIC_MODEL).toBe('kimi-for-coding');
    });
  });

  describe('getAuthStatus', () => {
    beforeEach(() => {
      resetProviderFailureStore();
      provider = new KimiProvider();
    });

    afterEach(() => {
      resetProviderFailureStore();
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

    it('should surface a recorded credential failure as unauthenticated', async () => {
      process.env.KIMI_API_KEY = 'invalid-key';
      recordProviderFailure('kimi', new Error('Kimi API key rejected (HTTP 401)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(false);
      expect(status.errorKind).toBe('credential');
      expect(status.error).toBe('Kimi API key rejected (HTTP 401)');
    });

    it('should stay authenticated but degraded for a recorded transient failure', async () => {
      process.env.KIMI_API_KEY = 'test-key';
      recordProviderFailure('kimi', new Error('Kimi probe timed out after 5000ms'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(true);
      expect(status.errorKind).toBe('transient');
      expect(status.error).toBe('Kimi probe timed out after 5000ms');
    });
  });

  describe('shutdown', () => {
    it('should resolve without error', async () => {
      provider = new KimiProvider();
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });
  });
});
