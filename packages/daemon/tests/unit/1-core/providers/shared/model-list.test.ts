import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  buildModelListUrl,
  extractAzureDeploymentModel,
  fetchRemoteModelList,
  normalizeModelList,
  type RemoteModelListEntry,
} from '../../../../../src/lib/providers/shared/model-list';

describe('extractAzureDeploymentModel', () => {
  it('derives the model id from an Azure deployment URL', () => {
    expect(
      extractAzureDeploymentModel(
        'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview'
      )
    ).toEqual({ id: 'gpt-4o' });
  });

  it('derives the model id without the chat suffix', () => {
    expect(
      extractAzureDeploymentModel(
        'https://my-resource.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-08-01-preview'
      )
    ).toEqual({ id: 'gpt-4o' });
  });

  it('returns null for non-Azure base URLs', () => {
    expect(extractAzureDeploymentModel('https://api.openai.com/v1')).toBeNull();
  });
});

describe('buildModelListUrl', () => {
  it('appends /v1/models to a bare base URL', () => {
    expect(buildModelListUrl('https://api.example.com', 'openai-chat')).toBe(
      'https://api.example.com/v1/models'
    );
  });

  it('does not double-append /v1 when baseUrl already ends in /v1', () => {
    expect(buildModelListUrl('http://localhost:1234/v1', 'openai-chat')).toBe(
      'http://localhost:1234/v1/models'
    );
  });

  it('strips /v1/models from baseUrl before appending', () => {
    expect(buildModelListUrl('http://localhost:1234/v1/models', 'openai-chat')).toBe(
      'http://localhost:1234/v1/models'
    );
  });

  it('strips /chat/completions from baseUrl before appending', () => {
    expect(buildModelListUrl('http://localhost:1234/v1/chat/completions', 'openai-chat')).toBe(
      'http://localhost:1234/v1/models'
    );
  });

  it('strips /v1/messages and /v1/messages/count_tokens for anthropic-messages', () => {
    expect(
      buildModelListUrl('https://api.anthropic.com/v1/messages/count_tokens', 'anthropic-messages')
    ).toBe('https://api.anthropic.com/v1/models');
    expect(buildModelListUrl('https://api.anthropic.com/v1/messages', 'anthropic-messages')).toBe(
      'https://api.anthropic.com/v1/models'
    );
  });

  it('appends /api/tags for ollama-native', () => {
    expect(buildModelListUrl('http://localhost:11434', 'ollama-native')).toBe(
      'http://localhost:11434/api/tags'
    );
  });

  it('strips /api/chat and /api/tags from ollama baseUrl before appending', () => {
    expect(buildModelListUrl('http://localhost:11434/api/chat', 'ollama-native')).toBe(
      'http://localhost:11434/api/tags'
    );
    expect(buildModelListUrl('http://localhost:11434/api/tags', 'ollama-native')).toBe(
      'http://localhost:11434/api/tags'
    );
  });
});

describe('normalizeModelList', () => {
  it('normalizes the OpenAI /v1/models shape', () => {
    const result = normalizeModelList('openai-chat', {
      data: [
        { id: 'gpt-4', object: 'model' },
        { id: 'gpt-3.5-turbo' },
        { id: 'not-a-model', object: 'listing' },
        { object: 'model' },
        { id: '', object: 'model' },
      ],
    });
    expect(result).toEqual([{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }]);
  });

  it('normalizes the Anthropic /v1/models shape with display names', () => {
    const result = normalizeModelList('anthropic-messages', {
      data: [
        { id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5' },
        { id: 'claude-opus-5', object: 'model' },
        { id: 'no-type-or-object' },
        { id: 'skipped', type: 'other' },
        { type: 'model' },
      ],
    });
    expect(result).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { id: 'claude-opus-5' },
      { id: 'no-type-or-object' },
    ]);
  });

  it('normalizes the Ollama /api/tags shape', () => {
    const result = normalizeModelList('ollama-native', {
      models: [{ name: 'llama2' }, { model: 'codellama:7b' }, { name: '', model: '' }, {}],
    });
    expect(result).toEqual([{ id: 'llama2' }, { id: 'codellama:7b' }]);
  });

  it('returns an empty list for missing payloads', () => {
    expect(normalizeModelList('openai-chat', undefined)).toEqual([]);
    expect(normalizeModelList('ollama-native', {})).toEqual([]);
  });
});

describe('fetchRemoteModelList', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function installFetch(
    respond: (url: string, init?: RequestInit) => Promise<unknown>
  ): Array<{ url: string; init?: RequestInit }> {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init });
      return respond(target, init);
    }) as unknown as typeof fetch;
    return calls;
  }

  const okResponse = (body: unknown) => ({ ok: true, json: async () => body });

  it('uses an injected fetch implementation', async () => {
    const fetchImpl = mock(async () => okResponse({ data: [{ id: 'glm-4.7', object: 'model' }] }));

    const models = await fetchRemoteModelList({
      url: 'https://api.example.com/v1/models',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(models).toEqual([{ id: 'glm-4.7' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches the provider-declared URL with the declared headers and normalizes the list', async () => {
    const calls = installFetch(async () =>
      okResponse({
        data: [
          { id: 'glm-4.7', object: 'model' },
          { id: 'not-a-model', object: 'listing' },
        ],
      })
    );

    const models = await fetchRemoteModelList({
      url: 'https://api.example.com/paas/v4/models',
      headers: { Authorization: 'Bearer sk-test' },
    });

    expect(models).toEqual([{ id: 'glm-4.7' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/paas/v4/models');
    expect(calls[0].init?.headers).toEqual({ Authorization: 'Bearer sk-test' });
  });

  it('normalizes the anthropic-messages shape with display names', async () => {
    installFetch(async () =>
      okResponse({ data: [{ id: 'kimi-k2', type: 'model', display_name: 'Kimi K2' }] })
    );

    const models = await fetchRemoteModelList({
      url: 'https://api.example.com/v1/models',
      type: 'anthropic-messages',
    });

    expect(models).toEqual([{ id: 'kimi-k2', name: 'Kimi K2' }]);
  });

  it('propagates HTTP failures instead of returning a fallback list', async () => {
    const cache = new Map<string, RemoteModelListEntry>();
    installFetch(async () => ({ ok: false, status: 502 }));

    await expect(
      fetchRemoteModelList({ url: 'https://api.example.com/v1/models', cache })
    ).rejects.toThrow('Endpoint returned HTTP 502');
    expect(cache.size).toBe(0);
  });

  it('propagates network failures', async () => {
    installFetch(async () => {
      throw new Error('connection refused');
    });

    await expect(
      fetchRemoteModelList({ url: 'https://api.example.com/v1/models' })
    ).rejects.toThrow('connection refused');
  });

  it('converts aborts into timeout errors', async () => {
    installFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    await expect(
      fetchRemoteModelList({ url: 'https://api.example.com/v1/models', timeoutMs: 50 })
    ).rejects.toThrow('Request timed out');
  });

  it('serves a fresh cache entry without refetching', async () => {
    let callCount = 0;
    installFetch(async () => {
      callCount++;
      return okResponse({ data: [{ id: `m${callCount}`, object: 'model' }] });
    });
    const cache = new Map<string, RemoteModelListEntry>();

    const first = await fetchRemoteModelList({ url: 'https://api.example.com/v1/models', cache });
    const second = await fetchRemoteModelList({ url: 'https://api.example.com/v1/models', cache });

    expect(callCount).toBe(1);
    expect(second).toEqual(first);
    expect(second).toEqual([{ id: 'm1' }]);
  });

  it('bypasses the cache when force is true and persists the refreshed entry', async () => {
    let callCount = 0;
    installFetch(async () => {
      callCount++;
      return okResponse({ data: [{ id: `m${callCount}`, object: 'model' }] });
    });
    const cache = new Map<string, RemoteModelListEntry>();
    const params = { url: 'https://api.example.com/v1/models', cache };

    await fetchRemoteModelList(params);
    const forced = await fetchRemoteModelList({ ...params, force: true });
    expect(callCount).toBe(2);
    expect(forced).toEqual([{ id: 'm2' }]);

    const afterForce = await fetchRemoteModelList(params);
    expect(callCount).toBe(2);
    expect(afterForce).toEqual([{ id: 'm2' }]);
  });

  it('refetches when the cached entry is older than the TTL', async () => {
    let callCount = 0;
    installFetch(async () => {
      callCount++;
      return okResponse({ data: [{ id: `m${callCount}`, object: 'model' }] });
    });
    const cache = new Map<string, RemoteModelListEntry>();
    const params = { url: 'https://api.example.com/v1/models', cache, cacheTtlMs: 30_000 };

    await fetchRemoteModelList(params);
    const key = cache.keys().next().value as string;
    const entry = cache.get(key) as RemoteModelListEntry;
    cache.set(key, { ...entry, fetchedAt: Date.now() - 60_000 });

    const refreshed = await fetchRemoteModelList(params);
    expect(callCount).toBe(2);
    expect(refreshed).toEqual([{ id: 'm2' }]);
  });

  it('separates cache entries by URL and headers', async () => {
    let callCount = 0;
    installFetch(async () => {
      callCount++;
      return okResponse({ data: [{ id: `m${callCount}`, object: 'model' }] });
    });
    const cache = new Map<string, RemoteModelListEntry>();

    const first = await fetchRemoteModelList({
      url: 'https://api.example.com/v1/models',
      headers: { Authorization: 'Bearer key-a' },
      cache,
    });
    const second = await fetchRemoteModelList({
      url: 'https://api.example.com/v1/models',
      headers: { Authorization: 'Bearer key-b' },
      cache,
    });

    expect(callCount).toBe(2);
    expect(first).toEqual([{ id: 'm1' }]);
    expect(second).toEqual([{ id: 'm2' }]);

    const firstAgain = await fetchRemoteModelList({
      url: 'https://api.example.com/v1/models',
      headers: { Authorization: 'Bearer key-a' },
      cache,
    });
    expect(callCount).toBe(2);
    expect(firstAgain).toEqual([{ id: 'm1' }]);
  });

  it('fetches on every call when no cache is provided', async () => {
    let callCount = 0;
    installFetch(async () => {
      callCount++;
      return okResponse({ data: [{ id: `m${callCount}`, object: 'model' }] });
    });

    await fetchRemoteModelList({ url: 'https://api.example.com/v1/models' });
    await fetchRemoteModelList({ url: 'https://api.example.com/v1/models' });

    expect(callCount).toBe(2);
  });
});
