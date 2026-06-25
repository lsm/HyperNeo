import { afterEach, describe, expect, it } from 'bun:test';
import {
  createOpenAIResponsesBridgeServer,
  type OpenAIResponsesBridgeServer,
} from '../../../../../src/lib/providers/openai-responses-bridge/server';

/**
 * Task #676: the OpenAI responses bridge (Codex / OpenRouter) normalizes
 * body-embedded and mid-stream provider errors to retryable Anthropic types.
 */

function makeServer(upstream: typeof fetch): OpenAIResponsesBridgeServer {
  return createOpenAIResponsesBridgeServer({
    auth: { apiKey: 'test-key', source: 'api_key' },
    models: [
      {
        id: 'gpt-5.3-codex',
        display_name: 'GPT-5.3 Codex',
        created_at: '2025-12-01T00:00:00Z',
        context_window: 272000,
      },
    ],
    fetchImpl: upstream,
  });
}

async function postMessages(port: number): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.3-codex',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

async function readSSEEvents(
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

describe('openai-responses-bridge: body-embedded / mid-stream error normalization', () => {
  let server: OpenAIResponsesBridgeServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it('reclassifies a 5xx server_error body to overloaded_error (retryable)', async () => {
    server = makeServer(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'server_error', message: 'OpenAI is overloaded' },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(529);
    expect(res.headers.get('x-should-retry')).toBe('true');
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('overloaded_error');
  });

  it('reclassifies a 4xx body with rate_limit_exceeded type to rate_limit_error', async () => {
    server = makeServer(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'rate_limit_exceeded', message: 'slow down' },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('rate_limit_error');
  });

  it('classifies a mid-stream error event to overloaded_error SSE (not api_error)', async () => {
    // Upstream returns a valid SSE stream that emits an `error` event mid-stream
    // with a server_error body.
    const sse =
      'event: error\n' +
      'data: {"type":"error","error":{"type":"server_error","message":"overloaded"}}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('overloaded_error');
  });

  it('leaves a non-transient mid-stream error as api_error', async () => {
    const sse =
      'event: error\n' +
      'data: {"type":"error","error":{"message":"bad request","code":"invalid_model"}}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    const events = await readSSEEvents(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('api_error');
  });
});
