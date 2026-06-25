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

  it('classifies a response.failed event whose error is under response.error', async () => {
    // response.failed carries the failure under event.response.error (not
    // event.error). The bridge must read that shape to classify the transient.
    const sse =
      'event: response.failed\n' +
      'data: {"type":"response.failed","response":{"error":{"type":"server_error","message":"overloaded"}}}\n\n';
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

  it('classifies a flat error event with top-level code/message', async () => {
    // Some upstreams emit an `error` event with code/message at the top level
    // (not nested under event.error). The bridge must read those fields too,
    // classify the transient, and preserve the provider message.
    const sse =
      'event: error\n' +
      'data: {"type":"error","code":"server_error","message":"the engine is overloaded"}\n\n';
    server = makeServer(
      async () =>
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const res = await postMessages(server.port);
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res.body);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: { type: string; message: string } }).error.type).toBe(
      'overloaded_error'
    );
    expect((errorEvent?.data as { error: { message: string } }).error.message).toContain(
      'the engine is overloaded'
    );
  });

  it('classifies a flat error frame whose data type differs from the SSE event name', async () => {
    // parseSSEBlock lets the payload `type` overwrite the SSE `event:` name, so
    // a flat `event: error` block like data: {"type":"server_error",...} has
    // event.type = "server_error" (not "error"). The bridge must still detect
    // it as an error frame via the preserved SSE event name.
    const sse =
      'event: error\n' + 'data: {"type":"server_error","message":"the engine is overloaded"}\n\n';
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

  it('normalizes a 200-with-body rate-limit error before streaming', async () => {
    // A Responses-compatible proxy returns 200 with a JSON error body instead
    // of an SSE stream. Without normalization the streamer would emit a
    // successful empty end_turn.
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

  it('normalizes a transient body on a tool-continuation 400 before falling back', async () => {
    // Continuation requests hit a dedicated 400 branch that returns immediately
    // unless the body mentions previous_response_id. A structured transient 400
    // (e.g. rate_limit_exceeded) must still be normalized before the
    // invalid_request fallback so the SDK retries.
    let call = 0;
    server = makeServer(async () => {
      call += 1;
      if (call === 1) {
        // First turn: emit a function call + response.completed so the bridge
        // stores a continuation (call_abc -> resp_tool).
        return new Response(
          [
            'event: response.function_call_arguments.done',
            'data: {"type":"response.function_call_arguments.done","call_id":"call_abc","name":"lookup","arguments":"{\\"q\\":\\"weather\\"}"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_tool","usage":{"input_tokens":10,"output_tokens":4},"output":[]}}',
            '',
            '',
          ].join('\n'),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      // Continuation turn: upstream returns 400 with a transient body (no
      // previous_response_id mention).
      return new Response(
        JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // First request: primes the continuation.
    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
    });
    await readSSEEvents(first.body);

    // Continuation request: assistant tool_use + user tool_result for call_abc.
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'user', content: 'Use the tool.' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_abc', name: 'lookup', input: { q: 'weather' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'found' }],
          },
        ],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('x-should-retry')).toBe('true');
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('rate_limit_error');
  });

  it('normalizes a transient 400 on a replayed-reasoning request before self-healing', async () => {
    // A 400 with replayed reasoning present must be inspected for a transient
    // body BEFORE the bridge self-heals by stripping reasoning — otherwise a
    // rate-limit 400 is masked by a reasoning-stripped retry and the SDK never
    // sees the retryable signal.
    let call = 0;
    server = makeServer(async () => {
      call += 1;
      if (call === 1) {
        // First turn: emit reasoning so the bridge caches it for the session.
        return new Response(
          [
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":5,"output_tokens":2},"output":[{"type":"reasoning","encrypted_content":"ENC_BLOB"}]}}',
            '',
            '',
          ].join('\n'),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      // Second turn: the bridge replays the cached reasoning item; upstream
      // returns a rate-limit 400. Must be normalized, not reasoning-stripped.
      return new Response(
        JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Turn 1: primes the per-session reasoning cache.
    const first = await postMessages(server.port);
    await readSSEEvents(first.body);

    // Turn 2: replayed reasoning + rate-limit 400 -> normalized to 429.
    const res = await postMessages(server.port);
    expect(res.status).toBe(429);
    expect(res.headers.get('x-should-retry')).toBe('true');
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('rate_limit_error');
  });
});
