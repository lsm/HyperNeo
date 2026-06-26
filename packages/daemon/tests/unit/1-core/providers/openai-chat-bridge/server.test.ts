import { afterEach, describe, expect, it } from 'bun:test';
import {
  createOpenAIChatBridgeServer,
  type OpenAIChatBridgeServer,
} from '../../../../../src/lib/providers/openai-chat-bridge/server';

/**
 * Task #676: the OpenAI chat bridge (custom endpoints) normalizes body-embedded
 * and mid-stream provider errors to retryable Anthropic types. OpenAI-compatible
 * proxies sometimes return 200 with a JSON error body, or a mid-stream `error`
 * chunk — both would otherwise surface as a terminal api_error.
 */

function makeServer(upstream: typeof fetch): OpenAIChatBridgeServer {
  return createOpenAIChatBridgeServer({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    fetchImpl: upstream,
    toolUseSupported: false,
    visionSupported: false,
    thinkingSupported: false,
  });
}

async function postMessages(port: number): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'custom-model',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

async function readSSEEventTypes(
  body: ReadableStream<Uint8Array> | null
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  if (!body) return [];
  const text = await new Response(body).text();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!eventLine || !dataLine) continue;
    events.push({
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
    });
  }
  return events;
}

describe('openai-chat-bridge: body-embedded / mid-stream error normalization', () => {
  let server: OpenAIChatBridgeServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it('normalizes a 200-with-body rate-limit error to retryable', async () => {
    server = makeServer(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'rate_limit_exceeded', message: 'Too Many Requests' },
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

  it('reclassifies a 5xx overload body to overloaded_error', async () => {
    server = makeServer(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'server_error', message: 'engine overloaded, try again later' },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(529);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('overloaded_error');
  });

  it('recognizes non-canonical JSON content-types (application/problem+json, case-insensitive)', async () => {
    // The gate must match the JSON media-type family case-insensitively,
    // including RFC 7807 problem+json — otherwise these error bodies bypass
    // normalization and the streamer emits an empty end_turn.
    server = makeServer(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'rate_limit_exceeded', message: 'Too Many Requests' },
          }),
          { status: 200, headers: { 'Content-Type': 'Application/Problem+JSON; charset=utf-8' } }
        )
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('rate_limit_error');
  });

  it('classifies a mid-stream rate-limit chunk to rate_limit_error SSE (not api_error)', async () => {
    // Upstream returns a valid SSE stream that emits an `error` chunk mid-stream.
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"error":{"message":"rate limit exceeded","type":"rate_limit_exceeded"}}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEventTypes(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('rate_limit_error');
  });

  it('leaves a non-transient mid-stream chunk as api_error', async () => {
    const sse = 'data: {"error":{"message":"invalid model","type":"invalid_request_error"}}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    const events = await readSSEEventTypes(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('api_error');
  });

  it('classifies a flat SSE error payload (event: error, top-level fields)', async () => {
    // readChatStream drops the `event:` line; a flat payload like
    // data: {"type":"server_error","message":"overloaded"} has no `error`
    // wrapper and no choices, so it must be detected via the top-level fields
    // (otherwise the bridge ends with a normal end_turn and hides the error).
    const sse =
      'event: error\n' + 'data: {"type":"server_error","message":"the engine is overloaded"}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEventTypes(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('overloaded_error');
  });

  it('ignores type-only heartbeat frames (e.g. {"type":"ping"}) and streams normally', async () => {
    // A bare top-level `type` with no message/code is a heartbeat/metadata
    // frame, not an error — it must not abort the stream.
    const sse =
      'data: {"type":"ping"}\n\n' +
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEventTypes(res.body);
    expect(events.find((e) => e.event === 'error')).toBeUndefined();
    const stop = events.find((e) => e.event === 'message_delta');
    expect((stop?.data as { delta?: { stop_reason?: string } }).delta?.stop_reason).toBe(
      'end_turn'
    );
  });

  it('admits a type-only flat error frame with a known transient type', async () => {
    // A flat `event: error` block whose data is just {"type":"server_error"}
    // (no message/code) is still a retryable error and must be surfaced, not
    // ignored like a heartbeat.
    const sse = 'event: error\n' + 'data: {"type":"server_error"}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEventTypes(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('overloaded_error');
  });

  it('admits a flat RFC 7807 problem-detail error frame (status/detail)', async () => {
    // readChatStream discards `event: error`; a frame like
    // {"status":429,"detail":"Too Many Requests"} has no message/code/known-type,
    // so status→code and detail→message must be mapped before the guard.
    const sse = 'event: error\n' + 'data: {"status":429,"detail":"Too Many Requests"}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEventTypes(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('rate_limit_error');
  });

  it('admits a flat error frame with a numeric code (e.g. {"code":429})', async () => {
    const sse = 'event: error\n' + 'data: {"code":429}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEventTypes(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('rate_limit_error');
  });

  it('streams a mislabeled-content-type SSE response without buffering or misclassifying it', async () => {
    // A proxy that streams valid SSE but sends Content-Type text/plain (or none)
    // must flow straight through to the streamer — NOT be buffered and matched
    // against the overload substring (which would misclassify a valid stream
    // whose content happens to mention "overloaded" as a retryable error).
    const sse =
      'data: {"choices":[{"delta":{"content":"The server is overloaded but this is normal text"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    server = makeServer(
      async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEventTypes(res.body);
    // It streamed normally: a text delta was emitted (not an error event).
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeUndefined();
    const stop = events.find((e) => e.event === 'message_delta');
    expect((stop?.data as { delta?: { stop_reason?: string } }).delta?.stop_reason).toBe(
      'end_turn'
    );
  });
});
