import { afterEach, describe, expect, it } from 'bun:test';
import {
  createAnthropicMessagesBridgeServer,
  type AnthropicMessagesBridgeServer,
} from '../../../../../src/lib/providers/anthropic-messages-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

type FetchImpl = typeof fetch;

function makeServer(upstream: FetchImpl): AnthropicMessagesBridgeServer {
  return createAnthropicMessagesBridgeServer({
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'test-key',
    fetchImpl: upstream,
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
