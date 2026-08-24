import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { OllamaProvider } from '../../../../src/lib/providers/ollama-provider';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

describe('OllamaProvider', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_CLOUD_API_KEY;
    delete process.env.OLLAMA_CLOUD_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exposes local and cloud identities', async () => {
    const fetchMock = mock(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
    );
    const local = new OllamaProvider({ kind: 'local', fetchImpl: fetchMock as typeof fetch });
    const cloud = new OllamaProvider({ kind: 'cloud' });

    expect(local.id).toBe('ollama');
    expect(local.displayName).toBe('Ollama (Local)');
    expect(await local.isAvailable()).toBe(true);
    expect(cloud.id).toBe('ollama-cloud');
    expect(cloud.displayName).toBe('Ollama Cloud');
    expect(await cloud.isAvailable()).toBe(false);
    expect(local.capabilities.streaming).toBe(true);
    expect(local.capabilities.functionCalling).toBe(true);
    expect(local.capabilities.vision).toBe(false);
  });

  it('does not mark local Ollama available when the daemon is unreachable', async () => {
    const fetchMock = mock(async () => {
      throw new Error('connection refused');
    });
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(await provider.isAvailable()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/tags', {
      headers: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it('reports local Ollama unavailable when the availability probe times out', async () => {
    const fetchMock = mock(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(await provider.isAvailable()).toBe(false);
  });

  it('loads models from /api/tags for local Ollama', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.test/';
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'llama3.2:latest',
                model: 'llama3.2:latest',
                modified_at: '2026-04-20T00:00:00Z',
                details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
              },
            ],
          }),
          { status: 200 }
        )
    );
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    const models = await provider.getModels();
    const cachedModels = await provider.getModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://ollama.test/api/tags', { headers: undefined });
    expect(cachedModels).toBe(models);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'llama3.2:latest',
      provider: 'ollama',
      family: 'llama',
      releaseDate: '2026-04-20',
    });
  });

  it('bypasses the Ollama model cache for forced remote discovery', async () => {
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          models: [{ name: `llama3.2:${callCount}`, model: `llama3.2:${callCount}` }],
        }),
        { status: 200 }
      );
    });
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    await provider.getModels();
    const cachedModels = await provider.listRemoteModels();
    const forcedModels = await provider.listRemoteModels({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cachedModels[0].id).toBe('llama3.2:1');
    expect(forcedModels[0].id).toBe('llama3.2:2');
    expect(await provider.getModels()).toBe(forcedModels);
  });

  it('propagates Ollama remote discovery failures instead of returning fallback models', async () => {
    let fail = false;
    const fetchMock = mock(async () => {
      if (fail) throw new Error('connection refused');
      return new Response(
        JSON.stringify({ models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] }),
        { status: 200 }
      );
    });
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    await provider.getModels();
    fail = true;

    await expect(provider.listRemoteModels({ force: true })).rejects.toThrow('connection refused');
  });

  it('propagates Ollama remote discovery HTTP failures', async () => {
    const fetchMock = mock(async () => new Response('Bad gateway', { status: 502 }));
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(provider.listRemoteModels({ force: true })).rejects.toThrow(
      'Ollama model listing returned HTTP 502'
    );
  });

  it('uses a base URL override without replacing the configured endpoint cache', async () => {
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          models: [{ name: `llama3.2:${callCount}`, model: `llama3.2:${callCount}` }],
        }),
        { status: 200 }
      );
    });
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    const configuredModels = await provider.getModels();
    const overrideModels = await provider.listRemoteModels({
      baseUrl: 'https://ollama.example.test/',
    });
    const configuredModelsAgain = await provider.getModels();

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://ollama.example.test/api/tags', {
      headers: undefined,
    });
    expect(overrideModels[0].id).toBe('llama3.2:2');
    expect(configuredModelsAgain).toBe(configuredModels);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not replace configured auth status from a base URL override probe', async () => {
    process.env.OLLAMA_API_KEY = 'local-key';
    const fetchMock = mock(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('https://ollama.example.test')) {
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response(
        JSON.stringify({ models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] }),
        { status: 200 }
      );
    });
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    await provider.getModels();
    await expect(
      provider.listRemoteModels({ baseUrl: 'https://ollama.example.test/' })
    ).rejects.toThrow('Ollama API key was rejected');

    expect((await provider.getAuthStatus()).error).toBeUndefined();
  });

  it('uses bearer auth and cloud base URL for Ollama Cloud model listing', async () => {
    process.env.OLLAMA_CLOUD_API_KEY = 'ollama-key';
    const fetchMock = mock(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
    );
    const provider = new OllamaProvider({
      kind: 'cloud',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    await provider.getModels();

    expect(fetchMock).toHaveBeenCalledWith('https://ollama.com/api/tags', {
      headers: { Authorization: 'Bearer ollama-key' },
    });
  });

  it('surfaces local auth failures with the local API key env var', async () => {
    process.env.OLLAMA_API_KEY = 'bad-local-key';
    const fetchMock = mock(async () => new Response('Unauthorized', { status: 401 }));
    const provider = new OllamaProvider({
      kind: 'local',
      env: process.env,
      fetchImpl: fetchMock as typeof fetch,
    });

    const models = await provider.getModels();
    const status = await provider.getAuthStatus();

    expect(models).toEqual([]);
    expect(status.error).toContain('OLLAMA_API_KEY');
  });

  it('routes Ollama shorthands and cloud-tagged gpt-oss models to the matching provider', () => {
    const local = new OllamaProvider({ kind: 'local' });
    const cloud = new OllamaProvider({ kind: 'cloud' });

    expect(local.ownsModel('ollama')).toBe(true);
    expect(cloud.ownsModel('ollama')).toBe(false);
    expect(local.ownsModel('ollama-cloud')).toBe(false);
    expect(cloud.ownsModel('ollama-cloud')).toBe(true);
    expect(local.ownsModel('gpt-oss:20b')).toBe(true);
    expect(cloud.ownsModel('gpt-oss:20b')).toBe(false);
    expect(local.ownsModel('gpt-oss:120b')).toBe(false);
    expect(cloud.ownsModel('gpt-oss:120b')).toBe(true);
    expect(local.ownsModel('gpt-oss:120b-cloud')).toBe(false);
    expect(cloud.ownsModel('gpt-oss:120b-cloud')).toBe(true);
    expect(local.ownsModel('qwen3.5:cloud')).toBe(false);
    expect(cloud.ownsModel('qwen3.5:cloud')).toBe(true);
    expect(local.ownsModel('qwen3:32b')).toBe(true);
    expect(cloud.ownsModel('qwen3:32b')).toBe(false);
    expect(local.ownsModel('qwen3-coder:480b')).toBe(false);
    expect(cloud.ownsModel('qwen3-coder:480b')).toBe(true);
    expect(cloud.ownsModel('other-provider-cloud')).toBe(false);
  });

  it.skipIf(!isBun)('builds Anthropic-compatible routing through a local bridge', () => {
    const provider = new OllamaProvider({ kind: 'local' });

    const config = provider.buildSdkConfig('llama3.2:latest', {
      baseUrl: 'http://ollama.test',
    });

    expect(config.isAnthropicCompatible).toBe(true);
    expect(config.envVars.ANTHROPIC_BASE_URL).toStartWith('http://127.0.0.1:');
    expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('ollama-bridge');
    expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
    expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('llama3.2:latest');
    void provider.shutdown();
  });

  it.skipIf(!isBun)('keeps distinct bridges for different session override upstreams', () => {
    const provider = new OllamaProvider({ kind: 'local' });

    const first = provider.buildSdkConfig('llama3.2:latest', {
      baseUrl: 'http://ollama-one.test',
    });
    const second = provider.buildSdkConfig('llama3.2:latest', {
      baseUrl: 'http://ollama-two.test',
    });
    const firstAgain = provider.buildSdkConfig('llama3.2:latest', {
      baseUrl: 'http://ollama-one.test',
    });

    expect(first.envVars.ANTHROPIC_BASE_URL).not.toBe(second.envVars.ANTHROPIC_BASE_URL);
    expect(firstAgain.envVars.ANTHROPIC_BASE_URL).toBe(first.envVars.ANTHROPIC_BASE_URL);
    void provider.shutdown();
  });

  it('requires an API key for cloud SDK routing', () => {
    const provider = new OllamaProvider({ kind: 'cloud' });

    expect(() => provider.buildSdkConfig('gpt-oss:120b-cloud')).toThrow(
      'Ollama Cloud API key not configured'
    );
  });

  it.skipIf(!isBun)('uses session overrides for cloud API key and base URL', () => {
    const provider = new OllamaProvider({ kind: 'cloud' });

    const config = provider.buildSdkConfig('gpt-oss:120b-cloud', {
      apiKey: 'session-key',
      baseUrl: 'https://example.test',
    });

    expect(config.envVars.ANTHROPIC_BASE_URL).toStartWith('http://127.0.0.1:');
    expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-oss:120b-cloud');
    void provider.shutdown();
  });
});
