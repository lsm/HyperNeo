import { afterEach, describe, expect, it } from 'bun:test';
import {
  createOpenAIChatBridgeServer,
  type OpenAIChatBridgeServer,
} from '../../../../../src/lib/providers/openai-chat-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

async function makeServer(upstream: typeof fetch): OpenAIChatBridgeServer {
  return await createOpenAIChatBridgeServer({
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

describe.skipIf(!isBun)(
  'openai-chat-bridge: body-embedded / mid-stream error normalization',
  () => {
    let server: OpenAIChatBridgeServer | undefined;

    afterEach(() => {
      server?.stop();
      server = undefined;
    });

    it('normalizes a 200-with-body rate-limit error to retryable', async () => {
      server = await makeServer(
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
      server = await makeServer(
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
      server = await makeServer(
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
      const sse =
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"error":{"message":"rate limit exceeded","type":"rate_limit_exceeded"}}\n\n';
      server = await makeServer(
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
      server = await makeServer(
        async () =>
          new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      );

      const res = await postMessages(server.port);
      const events = await readSSEEventTypes(res.body);
      const errorEvent = events.find((e) => e.event === 'error');
      expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('api_error');
    });

    it('classifies a flat SSE error payload (event: error, top-level fields)', async () => {
      const sse =
        'event: error\n' + 'data: {"type":"server_error","message":"the engine is overloaded"}\n\n';
      server = await makeServer(
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
      const sse =
        'data: {"type":"ping"}\n\n' +
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
      server = await makeServer(
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
      const sse = 'event: error\n' + 'data: {"type":"server_error"}\n\n';
      server = await makeServer(
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
      const sse = 'event: error\n' + 'data: {"status":429,"detail":"Too Many Requests"}\n\n';
      server = await makeServer(
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
      server = await makeServer(
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
      const sse =
        'data: {"choices":[{"delta":{"content":"The server is overloaded but this is normal text"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
      server = await makeServer(
        async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/plain' } })
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(200);
      const events = await readSSEEventTypes(res.body);
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeUndefined();
      const stop = events.find((e) => e.event === 'message_delta');
      expect((stop?.data as { delta?: { stop_reason?: string } }).delta?.stop_reason).toBe(
        'end_turn'
      );
    });
  }
);
