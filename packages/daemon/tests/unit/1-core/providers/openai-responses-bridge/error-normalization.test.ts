import { afterEach, describe, expect, it } from 'bun:test';
import {
  createOpenAIResponsesBridgeServer,
  type OpenAIResponsesBridgeServer,
} from '../../../../../src/lib/providers/openai-responses-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

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

describe.skipIf(!isBun)(
  'openai-responses-bridge: body-embedded / mid-stream error normalization',
  () => {
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

    it('classifies a flat RFC 7807 problem-detail error frame (status/detail)', async () => {
      const sse = 'event: error\n' + 'data: {"status":429,"detail":"Too Many Requests"}\n\n';
      server = makeServer(
        async () =>
          new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(200);
      const events = await readSSEEvents(res.body);
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('rate_limit_error');
    });

    it('classifies a flat error frame whose data type differs from the SSE event name', async () => {
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

    it('classifies a flat error frame with a numeric code (e.g. {"code":429})', async () => {
      const sse = 'event: error\n' + 'data: {"code":429}\n\n';
      server = makeServer(
        async () =>
          new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      );

      const res = await postMessages(server.port);
      expect(res.status).toBe(200);
      const events = await readSSEEvents(res.body);
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent?.data as { error: { type: string } }).error.type).toBe('rate_limit_error');
    });

    it('detects a data-only transient frame (no event line, known error type)', async () => {
      const sse = 'data: {"type":"server_error","message":"the engine is overloaded"}\n\n';
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
      let call = 0;
      server = makeServer(async () => {
        call += 1;
        if (call === 1) {
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
        return new Response(
          JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      });

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
      let call = 0;
      server = makeServer(async () => {
        call += 1;
        if (call === 1) {
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
        return new Response(
          JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const first = await postMessages(server.port);
      await readSSEEvents(first.body);

      const res = await postMessages(server.port);
      expect(res.status).toBe(429);
      expect(res.headers.get('x-should-retry')).toBe('true');
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe('rate_limit_error');
    });
  }
);
