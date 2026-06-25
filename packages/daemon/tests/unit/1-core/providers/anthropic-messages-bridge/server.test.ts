import { afterEach, describe, expect, it } from 'bun:test';
import {
  createAnthropicMessagesBridgeServer,
  type AnthropicMessagesBridgeServer,
} from '../../../../../src/lib/providers/anthropic-messages-bridge/server';

/**
 * Acceptance test for task #676: a GLM overloaded error returned in the body
 * (200-with-body or non-2xx-with-body) is normalized to a retryable Anthropic
 * type (overloaded_error / rate_limit_error) with a status the Claude Agent SDK
 * retries (429 / 529) and an `x-should-retry: true` header.
 *
 * GLM (open.bigmodel.cn) frequently returns 200 with a JSON error body instead
 * of an SSE stream — there is no HTTP status for the SDK to retry on, so the
 * error would otherwise surface as terminal.
 */

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

describe('anthropic-messages-bridge: body-embedded upstream error normalization', () => {
  let server: AnthropicMessagesBridgeServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it('normalizes a 200-with-body GLM overloaded error to retryable overloaded_error', async () => {
    // GLM returns 200 OK with a JSON error body (application/json), not an SSE
    // stream. Without normalization the SDK sees a 200 "success".
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
    // GLM returns 400 but the body carries code 1305 — the status would map to
    // invalid_request_error (non-retryable) without body inspection.
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
    // Not a recognized transient error → not reclassified. The buffered body is
    // returned to the SDK unchanged so it isn't silently swallowed.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(raw);
  });

  it('normalizes a count_tokens 200-with-body GLM overload too', async () => {
    // GLM can return the same overload body from /v1/messages/count_tokens; the
    // normalization must not be gated to /v1/messages only.
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
});
