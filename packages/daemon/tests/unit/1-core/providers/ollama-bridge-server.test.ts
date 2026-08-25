import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  createOllamaAnthropicBridgeServer,
  type OllamaBridgeServer,
} from '../../../../src/lib/providers/ollama-bridge-server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

describe.skipIf(!isBun)('Ollama Anthropic bridge server', () => {
  const servers: OllamaBridgeServer[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  it('translates Anthropic messages to Ollama /api/chat and streams Anthropic SSE', async () => {
    let capturedRequest: unknown;
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      capturedRequest = JSON.parse(String(init?.body));
      const body = [
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Hello' },
          done: false,
        }),
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: ' there' },
          done: false,
        }),
        JSON.stringify({ model: 'llama3.2', done: true, prompt_eval_count: 9, eval_count: 2 }),
      ].join('\n');
      return new Response(body, { status: 200 });
    });
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      apiKey: 'cloud-key',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 32,
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(fetchMock).toHaveBeenCalledWith('http://ollama.test/api/chat', expect.any(Object));
    expect(capturedRequest).toEqual({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Say hello' },
      ],
      stream: true,
      options: { num_predict: 32 },
    });
    const text = await response.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain('"text":" there"');
    expect(text).toContain('event: message_stop');
  });

  it('serves Anthropic-compatible model listing for SDK initialization', async () => {
    const fetchMock = mock(async () => new Response('', { status: 500 }));
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      data: [{ id: 'default', type: 'model', display_name: 'Ollama' }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes tool schemas and tool blocks in token counting', async () => {
    const fetchMock = mock(async () => new Response('', { status: 500 }));
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const plainResponse = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'weather?' }],
      }),
    });
    const toolResponse = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: { city: 'London' },
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Rainy' }],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get current weather',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        ],
      }),
    });

    const plainBody = await plainResponse.json();
    const toolBody = await toolResponse.json();

    expect(plainResponse.status).toBe(200);
    expect(toolResponse.status).toBe(200);
    expect(toolBody.input_tokens).toBeGreaterThan(plainBody.input_tokens);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps Ollama length stop reason to Anthropic max_tokens', async () => {
    const fetchMock = mock(async () => {
      const body = [
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Partial' },
          done: false,
        }),
        JSON.stringify({
          model: 'llama3.2',
          done: true,
          done_reason: 'length',
          prompt_eval_count: 10,
          eval_count: 3,
        }),
      ].join('\n');
      return new Response(body, { status: 200 });
    });
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'short answer' }],
        max_tokens: 1,
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"stop_reason":"max_tokens"');
  });

  it('translates Ollama tool calls to Anthropic tool_use SSE', async () => {
    const fetchMock = mock(async () => {
      const body = [
        JSON.stringify({
          model: 'llama3.2',
          message: {
            role: 'assistant',
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'London' } } }],
          },
          done: false,
        }),
        JSON.stringify({ model: 'llama3.2', done: true, prompt_eval_count: 10, eval_count: 3 }),
      ].join('\n');
      return new Response(body, { status: 200 });
    });
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"get_weather"');
    expect(text).toContain('"partial_json":"{\\"city\\":\\"London\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('preserves tool-call history when building Ollama requests', async () => {
    let capturedRequest: unknown;
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      capturedRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: 'llama3.2', done: true }), { status: 200 });
    });
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: { city: 'London' },
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Rainy' }],
          },
        ],
      }),
    });

    expect(capturedRequest).toMatchObject({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'London' } } }],
        },
        { role: 'tool', content: 'Rainy', tool_name: 'get_weather' },
      ],
    });
  });

  it('preserves tool-result ordering before supplemental user text', async () => {
    let capturedRequest: unknown;
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      capturedRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: 'llama3.2', done: true }), { status: 200 });
    });
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: { city: 'London' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Rainy' },
              { type: 'text', text: 'Please summarize the result.' },
            ],
          },
        ],
      }),
    });

    expect(capturedRequest).toMatchObject({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'London' } } }],
        },
        { role: 'tool', content: 'Rainy', tool_name: 'get_weather' },
        { role: 'user', content: 'Please summarize the result.' },
      ],
    });
  });

  it('rejects image blocks before forwarding to Ollama', async () => {
    const fetchMock = mock(async () => new Response('', { status: 500 }));
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' },
              },
            ],
          },
        ],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('image content blocks');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects image blocks nested in Ollama tool results', async () => {
    const fetchMock = mock(async () => new Response('', { status: 500 }));
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'http://ollama.test',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'screenshot:' },
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'abc' },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('image content blocks');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream rate limits to Anthropic rate_limit_error', async () => {
    const fetchMock = mock(async () => new Response('Too Many Requests', { status: 429 }));
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'https://ollama.com',
      apiKey: 'cloud-key',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oss:120b-cloud',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toContain('Too Many Requests');
  });

  it('maps upstream 529 to Anthropic overloaded_error', async () => {
    const fetchMock = mock(async () => new Response('Overloaded', { status: 529 }));
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'https://ollama.com',
      apiKey: 'cloud-key',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oss:120b-cloud',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(529);
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toContain('Overloaded');
  });

  it('maps upstream failures to Anthropic JSON errors', async () => {
    const fetchMock = mock(async () => new Response('Unauthorized', { status: 401 }));
    const server = await createOllamaAnthropicBridgeServer({
      baseUrl: 'https://ollama.com',
      apiKey: 'bad-key',
      fetchImpl: fetchMock as typeof fetch,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oss:120b-cloud',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('Unauthorized');
  });
});
