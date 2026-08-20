import { afterEach, describe, expect, it } from 'bun:test';
import {
  type AnthropicMessagesBridgeServer,
  createAnthropicMessagesBridgeServer,
} from '../../../../../src/lib/providers/anthropic-messages-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

type FetchImpl = typeof fetch;

function makeServer(
  upstream: FetchImpl,
  thinkingSupported?: boolean
): AnthropicMessagesBridgeServer {
  return createAnthropicMessagesBridgeServer({
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'test-key',
    fetchImpl: upstream,
    thinkingSupported,
  });
}

async function postMessages(
  port: number,
  body: object = {
    model: 'glm-5',
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
}

async function postCountTokens(port: number): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe.skipIf(!isBun)(
  'anthropic-messages-bridge: body-embedded upstream error normalization',
  () => {
    let server: AnthropicMessagesBridgeServer | undefined;

    afterEach(() => {
      server?.stop();
      server = undefined;
    });

    it('normalizes a 200-with-body GLM overloaded error to retryable overloaded_error', async () => {
      server = makeServer(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: '1303', message: '访问量过大，请稍后再试' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(529);
      expect(res.headers.get('x-should-retry')).toBe('true');
      const json = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(json.type).toBe('error');
      expect(json.error.type).toBe('overloaded_error');
      expect(json.error.message).toContain('访问量过大');
    });

    it('normalizes a 200-with-body GLM rate-limit code to rate_limit_error', async () => {
      server = makeServer(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: '1305', message: '触发分钟级限流，请稍后再试' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(429);
      expect(res.headers.get('x-should-retry')).toBe('true');
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe('rate_limit_error');
    });

    it('reclassifies a non-2xx GLM body carrying an overload code to retryable', async () => {
      server = makeServer(
        async () =>
          new Response(JSON.stringify({ error: { code: '1305', message: '访问量过大' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(429);
      expect(res.headers.get('x-should-retry')).toBe('true');
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe('rate_limit_error');
    });

    it('falls back to status-based mapping for non-transient error bodies', async () => {
      server = makeServer(
        async () =>
          new Response(JSON.stringify({ error: { code: '1301', message: 'invalid argument' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(400);
      expect(res.headers.get('x-should-retry')).toBeNull();
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe('invalid_request_error');
    });

    it('recognizes an Anthropic-shaped rate_limit_error body (even on a hard 4xx)', async () => {
      server = makeServer(
        async () =>
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message: 'rate limit exceeded' },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(429);
      expect(res.headers.get('x-should-retry')).toBe('true');
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe('rate_limit_error');
    });

    it('passes a normal 200 SSE stream through byte-for-byte (regression)', async () => {
      const sseBody =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      server = makeServer(
        async () =>
          new Response(sseBody, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toBe(sseBody);
    });

    it('re-wraps a non-transient 200-with-body unchanged (does not hide unknown errors)', async () => {
      const raw = JSON.stringify({ some: 'unexpected', body: true });
      server = makeServer(
        async () =>
          new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(raw);
    });

    it('normalizes a count_tokens 200-with-body GLM overload too', async () => {
      server = makeServer(
        async () =>
          new Response(JSON.stringify({ error: { code: '1305', message: '访问量过大' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      );

      const res = await postCountTokens(server.port);
      expect(res.status).toBe(429);
      expect(res.headers.get('x-should-retry')).toBe('true');
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe('rate_limit_error');
    });

    it('passes a normal count_tokens JSON response through unchanged', async () => {
      const raw = JSON.stringify({ input_tokens: 42 });
      server = makeServer(
        async () =>
          new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const res = await postCountTokens(server.port);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(raw);
    });
  }
);

describe.skipIf(!isBun)('anthropic-messages-bridge: session thinking enforcement', () => {
  let server: AnthropicMessagesBridgeServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  async function postWithSession(
    port: number,
    sessionId: string | undefined,
    body: object | string,
    path = '/v1/messages'
  ): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (sessionId) headers.Authorization = `Bearer custom-endpoint:${sessionId}`;
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('rewrites an adaptive thinking body to the session-configured enabled budget', async () => {
    let upstreamThinking: unknown = 'not-captured';
    server = makeServer(async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as {
        thinking?: unknown;
      };
      upstreamThinking = body.thinking ?? null;
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    server.setSessionThinkingConfig?.('sess-1', { type: 'enabled', budget_tokens: 31999 });

    const res = await postWithSession(server.port, 'sess-1', {
      model: 'swe-1-7',
      max_tokens: 32000,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(upstreamThinking).toEqual({ type: 'enabled', budget_tokens: 31999 });
  });

  it('leaves enabled thinking unchanged when the model does not support it', async () => {
    let upstreamThinking: unknown = 'not-captured';
    server = makeServer(async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as {
        thinking?: unknown;
      };
      upstreamThinking = body.thinking ?? null;
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }, false);
    server.setSessionThinkingConfig?.('sess-unsupported', {
      type: 'enabled',
      budget_tokens: 31999,
    });

    const res = await postWithSession(server.port, 'sess-unsupported', {
      model: 'swe-1-7',
      max_tokens: 32000,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(upstreamThinking).toEqual({ type: 'adaptive' });
  });

  it('strips thinking entirely for a session configured as off', async () => {
    let upstreamHadThinking: boolean | null = null;
    server = makeServer(async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as {
        thinking?: unknown;
      };
      upstreamHadThinking = 'thinking' in body;
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    server.setSessionThinkingConfig?.('sess-off', undefined);

    const res = await postWithSession(server.port, 'sess-off', {
      model: 'swe-1-7',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(upstreamHadThinking).toBe(false);
  });

  it('leaves unknown sessions untouched (no rewrite without an explicit config)', async () => {
    let upstreamThinking: unknown = 'not-captured';
    server = makeServer(async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as {
        thinking?: unknown;
      };
      upstreamThinking = body.thinking ?? null;
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await postWithSession(server.port, 'never-configured', {
      model: 'swe-1-7',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(upstreamThinking).toEqual({ type: 'adaptive' });
  });

  it('leaves short-output requests unchanged when their max tokens cannot fit the budget', async () => {
    let upstreamThinking: unknown = 'not-captured';
    server = makeServer(async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as {
        thinking?: unknown;
      };
      upstreamThinking = body.thinking ?? null;
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    server.setSessionThinkingConfig?.('sess-short', {
      type: 'enabled',
      budget_tokens: 31999,
    });

    const res = await postWithSession(server.port, 'sess-short', {
      model: 'swe-1-7',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(upstreamThinking).toEqual({ type: 'adaptive' });
  });

  it('leaves count-token request bodies unchanged', async () => {
    let upstreamBody: unknown;
    server = makeServer(async (_url, init) => {
      upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer));
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    server.setSessionThinkingConfig?.('sess-count', {
      type: 'enabled',
      budget_tokens: 31999,
    });
    const body = {
      model: 'swe-1-7',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    };

    const res = await postWithSession(server.port, 'sess-count', body, '/v1/messages/count_tokens');

    expect(res.status).toBe(200);
    await res.text();
    expect(upstreamBody).toEqual(body);
  });

  it('returns an Anthropic bad-request envelope for malformed configured-session JSON', async () => {
    let upstreamCalled = false;
    server = makeServer(async () => {
      upstreamCalled = true;
      return new Response('{}');
    });
    server.setSessionThinkingConfig?.('sess-invalid', {
      type: 'enabled',
      budget_tokens: 31999,
    });

    const res = await postWithSession(server.port, 'sess-invalid', '{');

    expect(res.status).toBe(400);
    expect(upstreamCalled).toBe(false);
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Bad Request: invalid JSON' },
    });
  });
});
