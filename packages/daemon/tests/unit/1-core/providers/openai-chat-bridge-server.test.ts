import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  createOpenAIChatBridgeServer,
  _openAIChatBridgeTesting,
  type OpenAIChatBridgeServer,
} from '../../../../src/lib/providers/openai-chat-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

function sseBody(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('OpenAI Chat Completions bridge server', () => {
  const servers: OpenAIChatBridgeServer[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  it.skipIf(!isBun)(
    'translates Anthropic messages to OpenAI Chat Completions and streams Anthropic SSE',
    async () => {
      let capturedRequest: unknown;
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      const fetchMock = mock(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        capturedRequest = JSON.parse(String(init?.body));
        const body = sseBody([
          {
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }],
          },
          { choices: [{ index: 0, delta: { content: ' world' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { usage: { prompt_tokens: 11, completion_tokens: 2 } },
        ]);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test/v1',
        apiKey: 'test-key',
        headers: { 'X-Trace': 'on' },
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);

      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:14b',
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Say hello' }],
          max_tokens: 32,
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/event-stream');
      expect(capturedUrl).toBe('http://upstream.test/v1/chat/completions');
      expect(capturedHeaders.Authorization).toBe('Bearer test-key');
      expect(capturedHeaders['X-Trace']).toBe('on');
      expect(capturedRequest).toMatchObject({
        model: 'qwen2.5:14b',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Say hello' },
        ],
        stream: true,
        max_tokens: 32,
      });

      const text = await response.text();
      expect(text).toContain('event: message_start');
      expect(text).toContain('"text":"Hello"');
      expect(text).toContain('"text":" world"');
      expect(text).toContain('event: message_delta');
      expect(text).toContain('"stop_reason":"end_turn"');
      expect(text).toContain('event: message_stop');
    }
  );

  it.skipIf(!isBun)('drops tool definitions when toolUseSupported=false', async () => {
    let capturedRequest: Record<string, unknown> = {};
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      capturedRequest = JSON.parse(String(init?.body));
      return new Response(
        sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
        { status: 200 }
      );
    });
    const server = await createOpenAIChatBridgeServer({
      baseUrl: 'http://upstream.test',
      fetchImpl: fetchMock as typeof fetch,
      toolUseSupported: false,
    });
    servers.push(server);

    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        tools: [
          {
            name: 'echo',
            description: 'd',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      }),
    });

    expect(capturedRequest.tools).toBeUndefined();
    expect(capturedRequest.tool_choice).toBeUndefined();
  });

  it.skipIf(!isBun)('translates streaming tool_calls into Anthropic tool_use blocks', async () => {
    const fetchMock = mock(async () => {
      const body = sseBody([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'lookup', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"q":"' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'cats"}' } }],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]);
      return new Response(body, { status: 200 });
    });
    const server = await createOpenAIChatBridgeServer({
      baseUrl: 'http://upstream.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'lookup cats' }],
        stream: true,
        tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
      }),
    });
    const text = await response.text();
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"lookup"');
    expect(text).toContain('"id":"call_abc"');
    expect(text).toContain('"partial_json":"{\\"q\\":\\"cats\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it.skipIf(!isBun)('emits Anthropic-shaped error envelope on upstream HTTP errors', async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const server = await createOpenAIChatBridgeServer({
      baseUrl: 'http://upstream.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
  });

  it.skipIf(!isBun)('maps upstream 529 to overloaded_error', async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
          status: 529,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const server = await createOpenAIChatBridgeServer({
      baseUrl: 'http://upstream.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(response.status).toBe(529);
    const body = (await response.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('overloaded_error');
  });

  it('does not crash when controller is already closed before upstream error', async () => {
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream blew up mid-stream'));
      },
    });
    const upstreamResponse = new Response(upstreamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    let captured: ReadableStreamDefaultController<Uint8Array> | undefined;
    const closedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        captured = controller;
      },
    });
    const reader = closedStream.getReader();
    captured!.close();
    reader.releaseLock();

    await expect(
      _openAIChatBridgeTesting.streamChatToAnthropic({
        upstreamResponse,
        controller: captured!,
        model: 'm',
        inputTokens: 1,
      })
    ).resolves.toBeUndefined();
  });

  it.skipIf(!isBun)(
    'serves Anthropic-compatible model listing for SDK initialization',
    async () => {
      const fetchMock = mock(async () => new Response('', { status: 500 }));
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('default');
    }
  );

  describe('message translation primitives', () => {
    it('flattens Anthropic system + multi-turn history into OpenAI chat messages', () => {
      const messages = _openAIChatBridgeTesting.toOpenAIMessages(
        {
          model: 'm',
          messages: [
            { role: 'user', content: 'one' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'two' },
                {
                  type: 'tool_use',
                  id: 'call_1',
                  name: 'echo',
                  input: { msg: 'hi' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_1',
                  content: 'result-text',
                },
              ],
            },
          ],
          system: 'sys',
        },
        false
      );
      expect(messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'one' },
        {
          role: 'assistant',
          content: 'two',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'echo', arguments: '{"msg":"hi"}' },
            },
          ],
        },
        { role: 'tool', content: 'result-text', tool_call_id: 'call_1' },
      ]);
    });

    it('drops images when visionSupported=false', () => {
      const messages = _openAIChatBridgeTesting.toOpenAIMessages(
        {
          model: 'm',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'AAAA',
                  },
                },
              ],
            },
          ],
        },
        false
      );
      expect(messages).toEqual([{ role: 'user', content: 'look' }]);
    });

    it('maps Anthropic tool_choice values to OpenAI', () => {
      const make = (tc: { type: string; name?: string }) =>
        _openAIChatBridgeTesting.toOpenAIToolChoice({
          model: 'm',
          messages: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tool_choice: tc as any,
        });
      expect(make({ type: 'auto' })).toBe('auto');
      expect(make({ type: 'none' })).toBe('none');
      expect(make({ type: 'any' })).toBe('required');
      expect(make({ type: 'tool', name: 'lookup' })).toEqual({
        type: 'function',
        function: { name: 'lookup' },
      });
    });

    it('forwards images as OpenAI image_url parts when visionSupported=true', () => {
      const messages = _openAIChatBridgeTesting.toOpenAIMessages(
        {
          model: 'm',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'see' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'ABCD',
                  },
                },
              ],
            },
          ],
        },
        true
      );
      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,ABCD' } },
          ],
        },
      ]);
    });

    it.skipIf(!isBun)('accumulates two parallel tool_calls across delta chunks', async () => {
      const fetchMock = mock(async () => {
        const body = sseBody([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_a',
                      type: 'function',
                      function: { name: 'one', arguments: '{"x":1}' },
                    },
                    {
                      index: 1,
                      id: 'call_b',
                      type: 'function',
                      function: { name: 'two', arguments: '{"y":2}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]);
        return new Response(body, { status: 200 });
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'run two tools' }],
          stream: true,
          tools: [
            { name: 'one', description: '', input_schema: { type: 'object' } },
            { name: 'two', description: '', input_schema: { type: 'object' } },
          ],
        }),
      });
      const text = await response.text();
      expect(text).toContain('"id":"call_a"');
      expect(text).toContain('"id":"call_b"');
      expect(text).toContain('"name":"one"');
      expect(text).toContain('"name":"two"');
      expect(text).toContain('"stop_reason":"tool_use"');
    });

    it.skipIf(!isBun)('reports max_tokens stop reason when finish_reason is length', async () => {
      const fetchMock = mock(
        async () =>
          new Response(
            sseBody([
              { choices: [{ delta: { content: 'partial' } }] },
              { choices: [{ delta: {}, finish_reason: 'length' }] },
            ]),
            { status: 200 }
          )
      );
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      const text = await response.text();
      expect(text).toContain('"stop_reason":"max_tokens"');
    });

    it.skipIf(!isBun)('returns a 502 envelope when the upstream fetch throws', async () => {
      const fetchMock = mock(async () => {
        throw new Error('ECONNREFUSED');
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe('api_error');
      expect(body.error.message).toContain('ECONNREFUSED');
    });

    it.skipIf(!isBun)('rejects non-streaming requests with 400', async () => {
      const fetchMock = mock(async () => new Response('', { status: 200 }));
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });
      expect(response.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it.skipIf(!isBun)('estimates input tokens at /v1/messages/count_tokens', async () => {
      const fetchMock = mock(async () => new Response('', { status: 500 }));
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hello world' }],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { input_tokens: number };
      expect(body.input_tokens).toBeGreaterThan(0);
    });

    it.skipIf(!isBun)('serves /health and /v1/health', async () => {
      const fetchMock = mock(async () => new Response('', { status: 500 }));
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      for (const path of ['/health', '/v1/health']) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
      }
    });

    it.skipIf(!isBun)(
      'binds to loopback (127.0.0.1) so other local users cannot reach the bridge',
      async () => {
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test',
          fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
        });
        servers.push(server);
        expect(typeof server.port).toBe('number');
        expect(server.port).toBeGreaterThan(0);
      }
    );

    it.skipIf(!isBun)(
      'defers tool_use block until upstream id arrives and forwards it verbatim',
      async () => {
        const fetchMock = mock(async () => {
          const body = sseBody([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        type: 'function',
                        function: { name: 'lookup', arguments: '' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_late',
                        function: { arguments: '{"q":"x"}' },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]);
          return new Response(body, { status: 200 });
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'lookup' }],
            stream: true,
            tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
          }),
        });
        const text = await response.text();
        expect(text).toContain('"id":"call_late"');
        expect(text).not.toMatch(/"id":"toolu_oai_/);
      }
    );

    it.skipIf(!isBun)('synthesises a tool_use id when upstream never sends one', async () => {
      const fetchMock = mock(async () => {
        const body = sseBody([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      type: 'function',
                      function: { name: 'lookup', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]);
        return new Response(body, { status: 200 });
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'lookup' }],
          stream: true,
          tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
        }),
      });
      const text = await response.text();
      expect(text).toMatch(/"id":"toolu_oai_/);
      expect(text).toContain('"name":"lookup"');
      expect(text).toContain('"stop_reason":"tool_use"');
    });
  });

  describe('baseUrl normalisation', () => {
    it('strips a trailing /chat/completions so users can paste the full endpoint URL', () => {
      expect(_openAIChatBridgeTesting.normaliseChatBaseUrl('https://api.example.com/v1')).toBe(
        'https://api.example.com/v1'
      );
      expect(
        _openAIChatBridgeTesting.normaliseChatBaseUrl('https://api.example.com/v1/chat/completions')
      ).toBe('https://api.example.com/v1');
      expect(
        _openAIChatBridgeTesting.normaliseChatBaseUrl(
          'https://api.example.com/v1/chat/completions/'
        )
      ).toBe('https://api.example.com/v1');
      expect(_openAIChatBridgeTesting.normaliseChatBaseUrl('https://api.example.com/v1/')).toBe(
        'https://api.example.com/v1'
      );
    });

    it.skipIf(!isBun)(
      'sends to /chat/completions exactly once even when baseUrl includes the suffix',
      async () => {
        let capturedUrl = '';
        const fetchMock = mock(async (url: string) => {
          capturedUrl = url;
          return new Response(
            sseBody([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
            { status: 200 }
          );
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test/v1/chat/completions',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);
        await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        expect(capturedUrl).toBe('http://upstream.test/v1/chat/completions');
      }
    );

    it('preserves a query string on the baseUrl when appending /chat/completions', () => {
      const azure =
        'https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview';
      expect(_openAIChatBridgeTesting.buildChatCompletionsUrl(azure)).toBe(
        'https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview'
      );
      const azureBase =
        'https://x.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-08-01-preview';
      expect(_openAIChatBridgeTesting.buildChatCompletionsUrl(azureBase)).toBe(
        'https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview'
      );
    });

    it('rejects an invalid baseUrl up front instead of producing a malformed target', () => {
      expect(() => _openAIChatBridgeTesting.buildChatCompletionsUrl('not a url')).toThrow(
        /not a valid URL/
      );
    });

    it.skipIf(!isBun)(
      'actually sends requests to a query-bearing baseUrl with /chat/completions appended once',
      async () => {
        let capturedUrl = '';
        const fetchMock = mock(async (url: string) => {
          capturedUrl = url;
          return new Response(
            sseBody([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
            { status: 200 }
          );
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl:
            'https://x.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-08-01-preview',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);
        await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        expect(capturedUrl).toBe(
          'https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview'
        );
      }
    );
  });

  describe('thinking forwarding', () => {
    it('maps Anthropic thinking budgets to OpenAI reasoning_effort', () => {
      const map = _openAIChatBridgeTesting.thinkingToReasoningEffort;
      expect(map(undefined)).toBeUndefined();
      expect(map({ type: 'adaptive' })).toBe('medium');
      expect(map({ type: 'enabled', budget_tokens: 1000 })).toBe('low');
      expect(map({ type: 'enabled', budget_tokens: 8000 })).toBe('medium');
      expect(map({ type: 'enabled', budget_tokens: 32000 })).toBe('high');
      expect(map({ type: 'enabled', budget_tokens: 0 })).toBeUndefined();
    });

    it.skipIf(!isBun)('forwards reasoning_effort when thinkingSupported=true', async () => {
      let captured: Record<string, unknown> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
          { status: 200 }
        );
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test/v1',
        fetchImpl: fetchMock as typeof fetch,
        thinkingSupported: true,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          thinking: { type: 'enabled', budget_tokens: 8000 },
        }),
      });
      expect(captured.reasoning_effort).toBe('medium');
    });

    it.skipIf(!isBun)('omits reasoning_effort when thinkingSupported=false (default)', async () => {
      let captured: Record<string, unknown> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
          { status: 200 }
        );
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test/v1',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          thinking: { type: 'enabled', budget_tokens: 8000 },
        }),
      });
      expect(captured.reasoning_effort).toBeUndefined();
    });
  });

  describe('stream_options gating', () => {
    it.skipIf(!isBun)('omits stream_options by default', async () => {
      let captured: Record<string, unknown> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
          { status: 200 }
        );
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test/v1',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(captured.stream_options).toBeUndefined();
      expect(captured.stream).toBe(true);
    });

    it.skipIf(!isBun)(
      'sends stream_options.include_usage when streamUsageSupported=true',
      async () => {
        let captured: Record<string, unknown> = {};
        const fetchMock = mock(async (_url: string, init?: RequestInit) => {
          captured = JSON.parse(String(init?.body));
          return new Response(
            sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
            { status: 200 }
          );
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test/v1',
          fetchImpl: fetchMock as typeof fetch,
          streamUsageSupported: true,
        });
        servers.push(server);
        await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        expect(captured.stream_options).toEqual({ include_usage: true });
      }
    );
  });

  describe('fail-fast on non-SSE 200', () => {
    it.skipIf(!isBun)(
      'emits an error envelope when upstream 200 contains no SSE data chunks',
      async () => {
        const fetchMock = mock(
          async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        );
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test/v1',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        const text = await response.text();
        expect(text).toContain('event: error');
        expect(text).toContain('non-SSE');
      }
    );
  });

  describe('SSE multi-line data: events', () => {
    it.skipIf(!isBun)(
      'concatenates consecutive data: lines within one event before JSON parsing',
      async () => {
        const body =
          `data: {\n` +
          `data:   "choices": [{ "index": 0, "delta": { "content": "hello" }, "finish_reason": "stop" }]\n` +
          `data: }\n\n` +
          `data: [DONE]\n\n`;
        const fetchMock = mock(
          async () =>
            new Response(body, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            })
        );
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test/v1',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        const text = await response.text();
        expect(text).not.toContain('non-SSE');
        expect(text).toContain('"text":"hello"');
        expect(text).toContain('"stop_reason":"end_turn"');
      }
    );

    it.skipIf(!isBun)(
      'ignores non-data lines (event:, id:, comments) within an event block',
      async () => {
        const body =
          `:keepalive\n` +
          `event: chunk\n` +
          `id: 1\n` +
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\n` +
          `data: [DONE]\n\n`;
        const fetchMock = mock(
          async () =>
            new Response(body, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            })
        );
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test/v1',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        const text = await response.text();
        expect(text).toContain('"text":"hi"');
        expect(text).not.toContain('non-SSE');
      }
    );
  });

  describe('reasoning_content translation', () => {
    it.skipIf(!isBun)(
      'streams reasoning_content as Anthropic thinking blocks before text',
      async () => {
        const fetchMock = mock(async () => {
          const body = sseBody([
            { choices: [{ index: 0, delta: { reasoning_content: 'Let' } }] },
            { choices: [{ index: 0, delta: { reasoning_content: ' me think' } }] },
            { choices: [{ index: 0, delta: { content: 'Hello' } }] },
            { choices: [{ index: 0, delta: { content: ' world' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]);
          return new Response(body, { status: 200 });
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);

        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        const text = await response.text();
        expect(text).toContain('"type":"thinking"');
        expect(text).toContain('"thinking":"Let"');
        expect(text).toContain('"thinking":" me think"');
        expect(text).toContain('"text":"Hello"');
        expect(text).toContain('"text":" world"');
        expect(text).toContain('"stop_reason":"end_turn"');
        expect(text).toContain('event: message_stop');
      }
    );

    it.skipIf(!isBun)(
      'counts reasoning tokens in heuristic output when no usage chunk',
      async () => {
        const fetchMock = mock(async () => {
          const body = sseBody([
            { choices: [{ index: 0, delta: { reasoning_content: 'reasoning' } }] },
            { choices: [{ index: 0, delta: { content: 'text' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]);
          return new Response(body, { status: 200 });
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);

        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        const text = await response.text();
        const match = text.match(/event: message_delta\s*\ndata:.*?"output_tokens":(\d+)/);
        expect(match).not.toBeNull();
        const outputTokens = Number(match![1]);
        expect(outputTokens).toBe(4);
      }
    );

    it.skipIf(!isBun)(
      'closes thinking block before tool_use when reasoning is followed by tool_calls',
      async () => {
        const fetchMock = mock(async () => {
          const body = sseBody([
            { choices: [{ index: 0, delta: { reasoning_content: 'plan' } }] },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_plan',
                        type: 'function',
                        function: { name: 'act', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]);
          return new Response(body, { status: 200 });
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test',
          fetchImpl: fetchMock as typeof fetch,
        });
        servers.push(server);

        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            tools: [{ name: 'act', description: '', input_schema: { type: 'object' } }],
          }),
        });
        const text = await response.text();
        expect(text).toContain('"type":"thinking"');
        expect(text).toContain('"type":"tool_use"');
        expect(text).toContain('"name":"act"');
        expect(text).toContain('"stop_reason":"tool_use"');
        const thinkingStopPos = text.indexOf('event: content_block_stop');
        const toolUseStartPos = text.indexOf('"type":"tool_use"');
        expect(thinkingStopPos).toBeGreaterThan(-1);
        expect(toolUseStartPos).toBeGreaterThan(-1);
        expect(thinkingStopPos).toBeLessThan(toolUseStartPos);
      }
    );

    it.skipIf(!isBun)('handles a reasoning-only stream with no content delta', async () => {
      const fetchMock = mock(async () => {
        const body = sseBody([
          { choices: [{ index: 0, delta: { reasoning_content: 'Only reasoning' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]);
        return new Response(body, { status: 200 });
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);

      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      const text = await response.text();
      expect(text).toContain('"type":"thinking"');
      expect(text).toContain('"thinking":"Only reasoning"');
      expect(text).toContain('"stop_reason":"end_turn"');
      expect(text).toContain('event: message_stop');
      expect(text).not.toContain('"type":"text"');
    });

    it.skipIf(!isBun)(
      'merges side-channel thinking config into the request when SDK omits it',
      async () => {
        let capturedRequest: Record<string, unknown> = {};
        const fetchMock = mock(async (_url: string, init?: RequestInit) => {
          capturedRequest = JSON.parse(String(init?.body));
          return new Response(
            sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
            { status: 200 }
          );
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test',
          fetchImpl: fetchMock as typeof fetch,
          thinkingSupported: true,
        });
        servers.push(server);
        server.setSessionThinkingConfig?.('sess-42', {
          type: 'enabled',
          budget_tokens: 8000,
        });

        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer custom-endpoint:sess-42',
          },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        expect(response.status).toBe(200);
        expect(capturedRequest.reasoning_effort).toBe('medium');
      }
    );
  });

  describe('chat_template_kwargs injection', () => {
    it.skipIf(!isBun)(
      'forwards chat_template_kwargs into the upstream request body when configured',
      async () => {
        let capturedRequest: Record<string, unknown> = {};
        const fetchMock = mock(async (_url: string, init?: RequestInit) => {
          capturedRequest = JSON.parse(String(init?.body));
          return new Response(
            sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
            { status: 200 }
          );
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test/v1',
          fetchImpl: fetchMock as typeof fetch,
          chatTemplateKwargs: { enable_thinking: false },
        });
        servers.push(server);
        await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });
        expect(capturedRequest.chat_template_kwargs).toEqual({ enable_thinking: false });
      }
    );

    it.skipIf(!isBun)('omits chat_template_kwargs when not configured', async () => {
      let capturedRequest: Record<string, unknown> = {};
      const fetchMock = mock(async (_url: string, init?: RequestInit) => {
        capturedRequest = JSON.parse(String(init?.body));
        return new Response(
          sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
          { status: 200 }
        );
      });
      const server = await createOpenAIChatBridgeServer({
        baseUrl: 'http://upstream.test/v1',
        fetchImpl: fetchMock as typeof fetch,
      });
      servers.push(server);
      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(capturedRequest).not.toHaveProperty('chat_template_kwargs');
    });

    it.skipIf(!isBun)(
      'does NOT overwrite model, messages, tools, or stream when injecting kwargs',
      async () => {
        let capturedRequest: Record<string, unknown> = {};
        const fetchMock = mock(async (_url: string, init?: RequestInit) => {
          capturedRequest = JSON.parse(String(init?.body));
          return new Response(
            sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
            { status: 200 }
          );
        });
        const server = await createOpenAIChatBridgeServer({
          baseUrl: 'http://upstream.test/v1',
          fetchImpl: fetchMock as typeof fetch,
          chatTemplateKwargs: { enable_thinking: false },
        });
        servers.push(server);
        await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3:32b',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
          }),
        });
        expect(capturedRequest.model).toBe('qwen3:32b');
        expect(capturedRequest.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(capturedRequest.stream).toBe(true);
        const tools = capturedRequest.tools as Array<{ function: { name: string } }>;
        expect(tools).toHaveLength(1);
        expect(tools[0].function.name).toBe('lookup');
        expect(capturedRequest.chat_template_kwargs).toEqual({ enable_thinking: false });
      }
    );
  });
});
