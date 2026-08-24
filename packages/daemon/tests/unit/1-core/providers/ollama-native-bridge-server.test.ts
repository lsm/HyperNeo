import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  createOllamaNativeBridgeServer,
  type OllamaNativeBridgeServer,
} from '../../../../src/lib/providers/ollama-native-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

function ndjson(chunks: Record<string, unknown>[]): string {
  return chunks.map((c) => JSON.stringify(c)).join('\n');
}

describe.skipIf(!isBun)('OllamaNativeBridge — custom-endpoint surface', () => {
  const servers: OllamaNativeBridgeServer[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
  });

  it('forwards user-supplied headers on every /api/chat request', async () => {
    let captured: Record<string, string> = {};
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      captured = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]), {
        status: 200,
      });
    });
    const server = await createOllamaNativeBridgeServer({
      baseUrl: 'http://ollama.test',
      headers: { 'x-api-key': 'reverse-proxy-secret', 'x-tenant': 'acme' },
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);
    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(captured['x-api-key']).toBe('reverse-proxy-secret');
    expect(captured['x-tenant']).toBe('acme');
  });

  it('forwards modelContextWindow as options.num_ctx so Ollama allocates the full KV cache', async () => {
    let body: { options?: { num_ctx?: number } } = {};
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]), {
        status: 200,
      });
    });
    const server = await createOllamaNativeBridgeServer({
      baseUrl: 'http://ollama.test',
      modelContextWindow: 32768,
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);
    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(body.options?.num_ctx).toBe(32768);
  });

  it('strips tools[] from the upstream body when toolUseSupported=false', async () => {
    let body: { tools?: unknown } = {};
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]), {
        status: 200,
      });
    });
    const server = await createOllamaNativeBridgeServer({
      baseUrl: 'http://ollama.test',
      toolUseSupported: false,
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);
    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'lookup', description: 'x', input_schema: { type: 'object' } }],
        stream: true,
      }),
    });
    expect(body.tools).toBeUndefined();
  });

  it('preserves tools[] when toolUseSupported=true (or omitted)', async () => {
    let body: { tools?: unknown[] } = {};
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]), {
        status: 200,
      });
    });
    const server = await createOllamaNativeBridgeServer({
      baseUrl: 'http://ollama.test',
      toolUseSupported: true,
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);
    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'lookup', description: 'x', input_schema: { type: 'object' } }],
        stream: true,
      }),
    });
    expect(body.tools).toHaveLength(1);
  });

  it('translates Ollama tool_calls in NDJSON chunks to Anthropic tool_use SSE', async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          ndjson([
            {
              model: 'llama3.2',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'lookup', arguments: { query: 'pi' } } }],
              },
              done: false,
            },
            { done: true, prompt_eval_count: 5, eval_count: 3 },
          ]),
          { status: 200 }
        )
    );
    const server = await createOllamaNativeBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'compute' }],
        stream: true,
      }),
    });
    const text = await response.text();
    expect(text).toContain('"name":"lookup"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('binds to 127.0.0.1 when hostname is passed (loopback isolation)', async () => {
    const fetchMock = mock(
      async () =>
        new Response(ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]), {
          status: 200,
        })
    );
    const server = await createOllamaNativeBridgeServer({
      baseUrl: 'http://ollama.test',
      hostname: '127.0.0.1',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
  });

  describe('baseUrl normalization', () => {
    it('strips a trailing /api/chat when the user pasted the full endpoint', async () => {
      let capturedUrl = '';
      const fetchMock = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]), {
          status: 200,
        });
      });
      const server = await createOllamaNativeBridgeServer({
        baseUrl: 'http://ollama.test/api/chat',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(capturedUrl).toBe('http://ollama.test/api/chat');
    });

    it('strips /api/chat plus a trailing slash', async () => {
      let capturedUrl = '';
      const fetchMock = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]), {
          status: 200,
        });
      });
      const server = await createOllamaNativeBridgeServer({
        baseUrl: 'http://ollama.test/api/chat/',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(capturedUrl).toBe('http://ollama.test/api/chat');
    });
  });
});
