import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  buildUpstreamUrl,
  createAnthropicMessagesBridgeServer,
  type AnthropicMessagesBridgeServer,
} from '../../../../src/lib/providers/anthropic-messages-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

describe('AnthropicMessagesBridge', () => {
  const servers: AnthropicMessagesBridgeServer[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
  });

  describe('buildUpstreamUrl', () => {
    it('appends /v1/messages without duplicating when user already pasted it', () => {
      expect(buildUpstreamUrl('https://api.example.com', '/v1/messages')).toBe(
        'https://api.example.com/v1/messages'
      );
      expect(buildUpstreamUrl('https://api.example.com/v1/messages', '/v1/messages')).toBe(
        'https://api.example.com/v1/messages'
      );
      expect(buildUpstreamUrl('https://api.example.com/v1/messages/', '/v1/messages')).toBe(
        'https://api.example.com/v1/messages'
      );
    });

    it('preserves query strings (e.g. Bedrock-style ?profile=...)', () => {
      expect(buildUpstreamUrl('https://api.example.com/?profile=prod', '/v1/messages')).toBe(
        'https://api.example.com/v1/messages?profile=prod'
      );
    });

    it('rejects invalid URLs at parse time', () => {
      expect(() => buildUpstreamUrl('not a url', '/v1/messages')).toThrow(/not a valid URL/);
    });
  });

  describe.skipIf(!isBun)('header forwarding', () => {
    it('attaches both x-api-key and Authorization when apiKey is configured', async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response('data: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(capturedHeaders['x-api-key']).toBe('sk-test-key');
      expect(capturedHeaders.authorization).toBe('Bearer sk-test-key');
    });

    it('lets user-supplied headers override the auth defaults', async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response('data: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key',
        headers: { 'x-api-key': 'override-key', 'x-custom-tenant': 'acme' },
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(capturedHeaders['x-api-key']).toBe('override-key');
      expect(capturedHeaders['x-custom-tenant']).toBe('acme');
    });

    it('forwards the SDK anthropic-version header when present', async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response('data: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2024-10-01' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(capturedHeaders['anthropic-version']).toBe('2024-10-01');
    });

    it('forwards every anthropic-* request header (anthropic-beta, etc.)', async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response('data: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2024-10-01',
          'anthropic-beta': 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(capturedHeaders['anthropic-version']).toBe('2024-10-01');
      expect(capturedHeaders['anthropic-beta']).toBe(
        'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11'
      );
      expect(capturedHeaders['anthropic-dangerous-direct-browser-access']).toBe('true');
    });

    it('lets configured headers override forwarded anthropic-* headers', async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response('data: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        headers: { 'anthropic-version': 'pinned-by-integrator' },
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2024-10-01' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(capturedHeaders['anthropic-version']).toBe('pinned-by-integrator');
    });
  });

  describe.skipIf(!isBun)('body + response pass-through', () => {
    it('forwards request body bytes verbatim', async () => {
      let capturedBody = '';
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        capturedBody =
          typeof init?.body === 'string'
            ? init.body
            : new TextDecoder().decode(init?.body as ArrayBuffer);
        return new Response('data: ok\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const requestBody = JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        unknown_extra: { preserve_this: true },
      });
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      expect(capturedBody).toBe(requestBody);
    });

    it('proxies upstream SSE response bytes 1:1', async () => {
      const upstreamSse =
        'event: message_start\ndata: {"type":"message_start"}\n\n' +
        'event: content_block_delta\ndata: {"type":"text_delta","text":"hello"}\n\n';
      const fetchMock = mock(async () => {
        return new Response(upstreamSse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(response.headers.get('content-type')).toContain('event-stream');
      expect(await response.text()).toBe(upstreamSse);
    });
  });

  describe.skipIf(!isBun)('error envelope normalisation', () => {
    it('maps upstream non-2xx into an Anthropic-format error body', async () => {
      const fetchMock = mock(async () => new Response('upstream blew up', { status: 500 }));
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(response.status).toBe(500);
      const payload = (await response.json()) as {
        type: string;
        error: { type: string; message: string };
      };
      expect(payload.type).toBe('error');
      expect(payload.error.type).toBe('api_error');
      expect(payload.error.message).toContain('upstream blew up');
    });

    it('maps 401 to authentication_error', async () => {
      const fetchMock = mock(async () => new Response('forbidden', { status: 401 }));
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      const payload = (await response.json()) as { error: { type: string } };
      expect(payload.error.type).toBe('authentication_error');
    });

    it('maps 529 to overloaded_error', async () => {
      const fetchMock = mock(async () => new Response('overloaded', { status: 529 }));
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [], stream: true }),
      });
      expect(response.status).toBe(529);
      const payload = (await response.json()) as { error: { type: string } };
      expect(payload.error.type).toBe('overloaded_error');
    });
  });

  describe.skipIf(!isBun)('/v1/models with model metadata', () => {
    it('returns enriched model metadata when models are configured', async () => {
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key',
        models: [
          {
            id: 'kimi-for-coding',
            display_name: 'Kimi For Coding',
            context_window: 262144,
          },
        ],
      });
      servers.push(server);

      const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        data: Array<Record<string, unknown>>;
        has_more: boolean;
      };
      expect(payload.has_more).toBe(false);
      expect(payload.data).toHaveLength(1);
      expect(payload.data[0]).toEqual({
        id: 'kimi-for-coding',
        type: 'model',
        display_name: 'Kimi For Coding',
        context_window: 262144,
        max_context_window: 262144,
        model_context_window: 262144,
        max_input_tokens: 262144,
        max_tokens: 16384,
      });
    });

    it('returns the default stub when no models are configured', async () => {
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
      });
      servers.push(server);

      const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };
      expect(payload.data).toEqual([
        { id: 'default', type: 'model', display_name: 'Custom Anthropic Endpoint' },
      ]);
    });

    it('supports multiple models', async () => {
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        models: [
          { id: 'model-a', display_name: 'Model A', context_window: 200000 },
          { id: 'model-b', display_name: 'Model B', context_window: 500000 },
        ],
      });
      servers.push(server);

      const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      const payload = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };
      expect(payload.data).toHaveLength(2);
      expect(payload.data[0].context_window).toBe(200000);
      expect(payload.data[1].context_window).toBe(500000);
    });

    it('respects custom max_tokens', async () => {
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        models: [
          { id: 'custom', display_name: 'Custom', context_window: 128000, max_tokens: 8192 },
        ],
      });
      servers.push(server);

      const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      const payload = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };
      expect(payload.data[0].max_tokens).toBe(8192);
    });
  });

  describe.skipIf(!isBun)('count_tokens forwarding', () => {
    it('forwards /v1/messages/count_tokens to the upstream count endpoint', async () => {
      let capturedUrl = '';
      const fetchMock = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });
      expect(capturedUrl).toBe('https://api.example.com/v1/messages/count_tokens');
      expect(((await response.json()) as { input_tokens: number }).input_tokens).toBe(42);
    });

    it('does not duplicate /v1/messages when baseUrl already includes it', async () => {
      let capturedUrl = '';
      const fetchMock = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ input_tokens: 7 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com/v1/messages',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });
      expect(capturedUrl).toBe('https://api.example.com/v1/messages/count_tokens');
    });

    it('does not duplicate when baseUrl includes a trailing slash after /v1/messages', async () => {
      let capturedUrl = '';
      const fetchMock = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ input_tokens: 7 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://api.example.com/v1/messages/',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });
      expect(capturedUrl).toBe('https://api.example.com/v1/messages/count_tokens');
    });
  });
});
