import { afterEach, describe, expect, it } from 'bun:test';
import {
  _openAIResponsesBridgeServerTesting,
  anthropicMessagesToResponsesInput,
  createOpenAIResponsesBridgeServer,
  type OpenAIResponsesBridgeServer,
} from '../../../../../src/lib/providers/openai-responses-bridge/server';

const models = [
  {
    id: 'gpt-5.3-codex',
    display_name: 'GPT-5.3 Codex',
    created_at: '2025-12-01T00:00:00Z',
    context_window: 272000,
  },
];

function sse(events: Array<{ event: string; data: object }>): Response {
  return new Response(
    events
      .map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
}

async function readSSEEvents(
  body: ReadableStream<Uint8Array> | null
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  if (!body) return [];
  const text = await new Response(body).text();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) continue;
    events.push({
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
    });
  }
  return events;
}

function textDeltaEvents(
  events: Array<{ event: string; data: Record<string, unknown> }>
): string[] {
  return events
    .filter((event) => event.event === 'content_block_delta')
    .map((event) => event.data.delta as { text?: string })
    .map((delta) => delta.text ?? '')
    .filter(Boolean);
}

function messageStartEvent(
  events: Array<{ event: string; data: Record<string, unknown> }>
): Record<string, unknown> | undefined {
  return events.find((event) => event.event === 'message_start')?.data;
}

function messageDeltaEvent(
  events: Array<{ event: string; data: Record<string, unknown> }>
): Record<string, unknown> | undefined {
  return events.find((event) => event.event === 'message_delta')?.data;
}

describe('openai-responses-bridge server', () => {
  let server: OpenAIResponsesBridgeServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it('translates Anthropic tool_use/tool_result blocks into Responses function items', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'codex' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"codex"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ]);
  });

  it('translates Anthropic image blocks into Responses input_image items', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
          },
          { type: 'text', text: 'What is in this image?' },
        ],
      },
    ]);

    // Source order is preserved: image first, then text
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/jpeg;base64,abc123' },
          { type: 'input_text', text: 'What is in this image?' },
        ],
      },
    ]);
  });

  it('handles image-only user messages without text', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'pngdata' },
          },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,pngdata' }],
      },
    ]);
  });

  it('handles multiple images in a single user message', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these:' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'img1' },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/webp', data: 'img2' },
          },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Compare these:' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,img1' },
          { type: 'input_image', image_url: 'data:image/webp;base64,img2' },
        ],
      },
    ]);
  });

  it('preserves interleaved text/image order in user messages', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Before' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'img1' },
          },
          { type: 'text', text: 'Between' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'img2' },
          },
          { type: 'text', text: 'After' },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Before' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,img1' },
          { type: 'input_text', text: 'Between' },
          { type: 'input_image', image_url: 'data:image/png;base64,img2' },
          { type: 'input_text', text: 'After' },
        ],
      },
    ]);
  });

  it('translates URL-based image blocks to input_image with direct URL', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/cat.jpg' },
          },
          { type: 'text', text: 'What is this?' },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'https://example.com/cat.jpg' },
          { type: 'input_text', text: 'What is this?' },
        ],
      },
    ]);
  });

  it('handles images mixed with tool_results in user messages', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'took screenshot' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'screendata' },
          },
          { type: 'text', text: 'What do you see?' },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'screenshot',
        arguments: '{}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'took screenshot' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,screendata' },
          { type: 'input_text', text: 'What do you see?' },
        ],
      },
    ]);
  });

  it('preserves non-text blocks in tool_result content as structured output', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'Screenshot taken.' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'screendata' },
              },
            ],
          },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'screenshot',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'Screenshot taken.' },
          { type: 'input_image', image_url: 'data:image/png;base64,screendata' },
        ],
      },
    ]);
  });

  it('flattens text-only tool_result content to a string', () => {
    const input = anthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'Line 1' },
              { type: 'text', text: 'Line 2' },
            ],
          },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Line 1\nLine 2',
      },
    ]);
  });

  it('throws on unsupported image source types', () => {
    expect(() =>
      anthropicMessagesToResponsesInput([
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'file', media_type: 'image/png', data: 'filedata' } as unknown as {
                type: 'base64';
                media_type: string;
                data: string;
              },
            },
          ],
        },
      ])
    ).toThrow('Unsupported image source type: file');
  });

  it('throws on unsupported user content block types', () => {
    expect(() =>
      anthropicMessagesToResponsesInput([
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'pdfdata' },
            } as unknown as { type: 'text'; text: string },
          ],
        },
      ])
    ).toThrow('Unsupported user content block type: document');
  });

  it('streams OpenAI text deltas as Anthropic text SSE', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.created',
            data: { type: 'response.created', response: { id: 'resp_1' } },
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'hel' },
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'lo' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 9, output_tokens: 2 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'Say hello.' }],
        tools: [
          {
            name: 'lookup',
            description: 'Look up data',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.model).toBe('gpt-5.3-codex');
    expect(capturedBody?.instructions).toBe('Be concise.');
    expect(capturedBody?.max_output_tokens).toBe(128);
    expect(capturedBody?.store).toBe(false);
    expect(capturedBody?.stream).toBe(true);
    expect(capturedBody?.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up data',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    const events = await readSSEEvents(resp.body);
    expect(textDeltaEvents(events).join('')).toBe('hello');
    expect(messageDeltaEvent(events)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    });
  });

  it('resolves Anthropic SDK model aliases to real Codex IDs before sending upstream', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      modelAliases: {
        'claude-opus-4-1-20250805': 'gpt-5.5',
        'claude-sonnet-4-20250514': 'gpt-5.4-mini',
      },
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.model).toBe('gpt-5.5');
  });

  it('uses per-session model override when setSessionModelConfig is called', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      modelAliases: {
        'claude-opus-4-1-20250805': 'gpt-5.5',
      },
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            },
          },
        ]);
      },
    });

    server.setSessionModelConfig?.('session-a', 'claude-opus-4-1-20250805', 'gpt-5.3-codex');

    const resp = await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.model).toBe('gpt-5.3-codex');
  });

  it('applies session override only when incoming model matches alias', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      modelAliases: {
        'claude-opus-4-1-20250805': 'gpt-5.5',
        'claude-sonnet-4-20250514': 'gpt-5.4-mini',
      },
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            },
          },
        ]);
      },
    });

    // Primary model override: gpt-5.3-codex (alias: claude-opus-4-1-20250805)
    server.setSessionModelConfig?.('session-a', 'claude-opus-4-1-20250805', 'gpt-5.3-codex');

    // Haiku call with different alias — should NOT be overridden to gpt-5.3-codex
    const resp = await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(resp.status).toBe(200);
    // Resolves through modelAliases to gpt-5.4-mini, NOT overridden to gpt-5.3-codex
    expect(capturedBody?.model).toBe('gpt-5.4-mini');
  });

  it('preserves primary model override when fallback is also registered', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      modelAliases: {
        'claude-opus-4-1-20250805': 'gpt-5.5',
        'claude-sonnet-4-20250514': 'gpt-5.4-mini',
      },
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            },
          },
        ]);
      },
    });

    // Primary model registration
    server.setSessionModelConfig?.('session-a', 'claude-opus-4-1-20250805', 'gpt-5.3-codex');
    // Fallback model registration (same session, different alias)
    server.setSessionModelConfig?.('session-a', 'claude-sonnet-4-20250514', 'gpt-5.1-codex-mini');

    // Primary request — should still resolve to gpt-5.3-codex
    await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'primary' }],
      }),
    });
    expect(capturedBody?.model).toBe('gpt-5.3-codex');

    // Fallback request — should resolve to gpt-5.1-codex-mini
    await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'fallback' }],
      }),
    });
    expect(capturedBody?.model).toBe('gpt-5.1-codex-mini');
  });

  it('uses last-registered model when same-tier models share alias (last-wins)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      modelAliases: {
        'claude-opus-4-1-20250805': 'gpt-5.5',
      },
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            },
          },
        ]);
      },
    });

    // Primary model registration
    server.setSessionModelConfig?.('session-a', 'claude-opus-4-1-20250805', 'gpt-5.3-codex');
    // Model switch: user switches to gpt-5.4 (same alias tier)
    server.setSessionModelConfig?.('session-a', 'claude-opus-4-1-20250805', 'gpt-5.4');

    // Request should use the latest registration (gpt-5.4)
    await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'switched' }],
      }),
    });
    expect(capturedBody?.model).toBe('gpt-5.4');
  });

  it('forwards image attachments to the OpenAI Responses API', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'A cat.' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 100, output_tokens: 2 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
              },
              { type: 'text', text: 'What is in this image?' },
            ],
          },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    const input = capturedBody?.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/jpeg;base64,abc123' },
          { type: 'input_text', text: 'What is in this image?' },
        ],
      },
    ]);
    const events = await readSSEEvents(resp.body);
    expect(textDeltaEvents(events).join('')).toBe('A cat.');
  });

  it('streams OpenAI function calls as Anthropic tool_use blocks', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.created',
            data: { type: 'response.created', response: { id: 'resp_2' } },
          },
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              item: {
                type: 'function_call',
                call_id: 'call_abc',
                name: 'lookup',
                arguments: '',
              },
            },
          },
          {
            event: 'response.function_call_arguments.done',
            data: {
              type: 'response.function_call_arguments.done',
              call_id: 'call_abc',
              name: 'lookup',
              arguments: '{"q":"weather"}',
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 10, output_tokens: 4 }, output: [] },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    const start = events.find((event) => event.event === 'content_block_start');
    expect(start?.data).toMatchObject({
      content_block: { type: 'tool_use', id: 'call_abc', name: 'lookup' },
    });
    const delta = events.find((event) => event.event === 'content_block_delta');
    expect(delta?.data).toMatchObject({
      delta: { type: 'input_json_delta', partial_json: '{"q":"weather"}' },
    });
    expect(messageDeltaEvent(events)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    });
  });

  it('continues tool_result turns with previous_response_id', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedBodies.push(body);
        if (capturedBodies.length === 1) {
          return sse([
            {
              event: 'response.function_call_arguments.done',
              data: {
                type: 'response.function_call_arguments.done',
                call_id: 'call_abc',
                name: 'lookup',
                arguments: '{"q":"weather"}',
              },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_tool',
                  usage: { input_tokens: 10, output_tokens: 4 },
                  output: [],
                },
              },
            },
          ]);
        }
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'done' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_done',
                usage: { input_tokens: 2, output_tokens: 1 },
                output: [],
              },
            },
          },
        ]);
      },
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

    const continuationPayload = {
      model: 'gpt-5.3-codex',
      max_tokens: 128,
      system: 'Follow the system guidance. '.repeat(100),
      messages: [
        { role: 'user', content: 'Use the tool. '.repeat(1000) },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_abc',
              name: 'lookup',
              input: { q: 'weather' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_abc', content: 'found' },
            { type: 'text', text: 'Summarize this briefly.' },
          ],
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Search the local index. '.repeat(50),
          input_schema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'Detailed lookup query. '.repeat(50) },
            },
          },
        },
      ],
    };
    const continuationBody = JSON.stringify(continuationPayload);
    const countResp = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: continuationBody,
    });
    const count = (await countResp.json()) as { input_tokens: number };
    expect(count.input_tokens).toBeGreaterThan(500);
    expect(count.input_tokens).toBeLessThan(1500);

    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: continuationBody,
    });
    const events = await readSSEEvents(second.body);

    expect(events.find((event) => event.event === 'content_block_delta')?.data).toMatchObject({
      delta: { text: 'done' },
    });
    const messageStart = messageStartEvent(events);
    const messageStartMessage = messageStart?.message as
      | { usage?: { input_tokens?: number } }
      | undefined;
    expect(messageStartMessage?.usage?.input_tokens).toBeGreaterThan(500);
    expect(messageStartMessage?.usage?.input_tokens).toBeLessThan(1500);
    expect(capturedBodies[0]?.store).toBe(false);
    expect(capturedBodies[1]?.store).toBe(false);
    expect(capturedBodies[1]?.previous_response_id).toBe('resp_tool');
    expect(capturedBodies[1]?.input).toEqual([
      { type: 'function_call_output', call_id: 'call_abc', output: 'found' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Summarize this briefly.' }],
      },
    ]);

    const third = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: continuationBody,
    });
    await readSSEEvents(third.body);

    expect(capturedBodies[2]?.previous_response_id).toBeUndefined();
  });

  it('can route continuation mappings with session-scoped URLs instead of auth headers', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedBodies.push(body);
        if (capturedBodies.length === 1) {
          return sse([
            {
              event: 'response.function_call_arguments.done',
              data: {
                type: 'response.function_call_arguments.done',
                call_id: 'call_shared',
                name: 'lookup',
                arguments: '{"q":"weather"}',
              },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_session_a',
                  usage: { input_tokens: 10, output_tokens: 4 },
                  output: [],
                },
              },
            },
          ]);
        }
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_done',
                usage: { input_tokens: 2, output_tokens: 0 },
                output: [],
              },
            },
          },
        ]);
      },
    });

    const sessionAUrl = server.baseUrlForSession?.('session-a') ?? '';
    const sessionBUrl = server.baseUrlForSession?.('session-b') ?? '';
    expect(sessionAUrl).toContain('/_neokai/session/session-a');

    const first = await fetch(`${sessionAUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer real-sdk-oauth-token',
      },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
    });
    await readSSEEvents(first.body);

    const continuationBody = JSON.stringify({
      model: 'gpt-5.3-codex',
      max_tokens: 128,
      messages: [
        { role: 'user', content: 'Use the tool.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_shared',
              name: 'lookup',
              input: { q: 'weather' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_shared', content: 'found' }],
        },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    });

    const second = await fetch(`${sessionBUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer real-sdk-oauth-token',
      },
      body: continuationBody,
    });
    await readSSEEvents(second.body);

    const third = await fetch(`${sessionAUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer real-sdk-oauth-token',
      },
      body: continuationBody,
    });
    await readSSEEvents(third.body);

    expect(capturedBodies[1]?.previous_response_id).toBeUndefined();
    expect(capturedBodies[2]?.previous_response_id).toBe('resp_session_a');
  });

  it('keeps continuation mappings isolated by bridge session', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedBodies.push(body);
        if (capturedBodies.length === 1) {
          return sse([
            {
              event: 'response.function_call_arguments.done',
              data: {
                type: 'response.function_call_arguments.done',
                call_id: 'call_shared',
                name: 'lookup',
                arguments: '{"q":"weather"}',
              },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_session_a',
                  usage: { input_tokens: 10, output_tokens: 4 },
                  output: [],
                },
              },
            },
          ]);
        }
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_done',
                usage: { input_tokens: 2, output_tokens: 0 },
                output: [],
              },
            },
          },
        ]);
      },
    });

    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer codex-bridge-session-a',
      },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
    });
    await readSSEEvents(first.body);

    const continuationBody = JSON.stringify({
      model: 'gpt-5.3-codex',
      max_tokens: 128,
      messages: [
        { role: 'user', content: 'Use the tool.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_shared',
              name: 'lookup',
              input: { q: 'weather' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_shared', content: 'found' }],
        },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    });
    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer codex-bridge-session-b',
      },
      body: continuationBody,
    });
    await readSSEEvents(second.body);

    const third = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer codex-bridge-session-a',
      },
      body: continuationBody,
    });
    await readSSEEvents(third.body);

    expect(capturedBodies[1]?.previous_response_id).toBeUndefined();
    const fallbackInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
    expect(fallbackInput.some((item) => item.type === 'function_call')).toBe(true);
    expect(fallbackInput.some((item) => item.type === 'function_call_output')).toBe(true);
    expect(capturedBodies[2]?.previous_response_id).toBe('resp_session_a');
  });

  it('evicts stale tool_result continuations after the TTL', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      continuationTtlMs: 10,
      fetchImpl: async (_url, init) => {
        capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (capturedBodies.length === 1) {
          return sse([
            {
              event: 'response.function_call_arguments.done',
              data: {
                type: 'response.function_call_arguments.done',
                call_id: 'call_expired',
                name: 'lookup',
                arguments: '{}',
              },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_expired',
                  usage: { input_tokens: 10, output_tokens: 4 },
                  output: [],
                },
              },
            },
          ]);
        }
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_done',
                usage: { input_tokens: 2, output_tokens: 0 },
                output: [],
              },
            },
          },
        ]);
      },
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
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'user', content: 'Use the tool.' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_expired', name: 'lookup', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_expired', content: 'found' }],
          },
        ],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
    });
    await readSSEEvents(second.body);

    expect(capturedBodies[1]?.previous_response_id).toBeUndefined();
    const fallbackInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
    expect(fallbackInput.some((item) => item.type === 'function_call')).toBe(true);
    expect(fallbackInput.some((item) => item.type === 'function_call_output')).toBe(true);
  });

  it('maps OpenAI incomplete responses to Anthropic max_tokens stop reason', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'partial' },
          },
          {
            event: 'response.incomplete',
            data: {
              type: 'response.incomplete',
              response: { usage: { input_tokens: 3, output_tokens: 1 } },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Say something.' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    expect(textDeltaEvents(events).join('')).toBe('partial');
    expect(messageDeltaEvent(events)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
    });
  });

  it('normalizes OpenAI prompt/completion token usage fields', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'hello' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { prompt_tokens: 11, completion_tokens: 2 }, output: [] },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    expect(messageDeltaEvent(events)).toMatchObject({
      type: 'message_delta',
      usage: { input_tokens: 11, output_tokens: 2 },
    });
  });

  it('returns an Anthropic 502 error when the upstream request fails', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(resp.status).toBe(502);
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toBe('network down');
  });

  it('skips malformed upstream SSE blocks and preserves valid partial trailing data', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        new Response(
          [
            'event: response.output_text.delta',
            'data: not-json',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"ok"}',
          ].join('\n'),
          { headers: { 'Content-Type': 'text/event-stream' } }
        ),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    expect(resp.status).toBe(200);
    expect(textDeltaEvents(events).join('')).toBe('ok');
    expect(messageDeltaEvent(events)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    });
  });

  it('maps upstream streaming failures to Anthropic SSE errors', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'partial' },
          },
          {
            event: 'response.failed',
            data: {
              type: 'response.failed',
              response: {
                id: 'resp_failed',
                error: { message: 'stream failed upstream' },
              },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    expect(resp.status).toBe(200);
    expect(textDeltaEvents(events).join('')).toBe('partial');
    expect(events.find((event) => event.event === 'error')?.data).toMatchObject({
      type: 'error',
      error: { type: 'api_error', message: 'stream failed upstream' },
    });
    expect(events.at(-1)?.event).toBe('message_stop');
    expect(messageDeltaEvent(events)).toBeUndefined();
  });

  it('maps upstream streaming error events to Anthropic SSE errors', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        sse([
          {
            event: 'error',
            data: {
              type: 'error',
              error: { message: 'invalid stream request' },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    expect(resp.status).toBe(200);
    expect(events.find((event) => event.event === 'error')?.data).toMatchObject({
      type: 'error',
      error: { type: 'api_error', message: 'invalid stream request' },
    });
    expect(events.at(-1)?.event).toBe('message_stop');
    expect(messageDeltaEvent(events)).toBeUndefined();
  });

  it('returns 400 for unsupported user content blocks', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'should not reach upstream' } }), {
          status: 500,
        }),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'pdfdata',
                },
              } as unknown as { type: 'text'; text: string },
            ],
          },
        ],
      }),
    });

    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(resp.status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Unsupported user content block type: document');
  });

  it('returns 400 for unsupported image source types', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'should not reach upstream' } }), {
          status: 500,
        }),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'file', media_type: 'image/png', data: 'filedata' } as unknown as {
                  type: 'base64';
                  media_type: string;
                  data: string;
                },
              },
            ],
          },
        ],
      }),
    });

    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(resp.status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Unsupported image source type: file');
  });

  it('maps upstream 429 responses to Anthropic rate_limit_error', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(resp.status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toBe('slow down');
  });

  it('uses Codex ChatGPT OAuth endpoint and account header for OAuth auth', async () => {
    let capturedUrl = '';
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: {
        source: 'chatgpt_oauth',
        apiKey: 'oauth-token',
        accountId: 'acct_123',
        isFedrampAccount: true,
      },
      models,
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            },
          },
        ]);
      },
    });

    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(capturedUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(capturedHeaders?.get('authorization')).toBe('Bearer oauth-token');
    expect(capturedHeaders?.get('chatgpt-account-id')).toBe('acct_123');
    expect(capturedHeaders?.get('x-openai-fedramp')).toBe('true');
    expect(capturedBody?.store).toBe(false);
    expect(capturedBody?.max_output_tokens).toBeUndefined();
  });

  it('refreshes ChatGPT OAuth auth once after an upstream 401 and reuses it', async () => {
    const seenAuthHeaders: string[] = [];
    server = createOpenAIResponsesBridgeServer({
      auth: {
        source: 'chatgpt_oauth',
        apiKey: 'expired-token',
        accountId: 'acct_old',
        refreshAuthTokens: async () => ({
          accessToken: 'fresh-token',
          accountId: 'acct_new',
        }),
      },
      models,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        seenAuthHeaders.push(
          `${headers.get('authorization')}:${headers.get('chatgpt-account-id')}`
        );
        if (seenAuthHeaders.length === 1) {
          return new Response(JSON.stringify({ error: { message: 'expired' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            },
          },
        ]);
      },
    });

    const body = JSON.stringify({
      model: 'gpt-5.3-codex',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const secondResp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(resp.status).toBe(200);
    expect(secondResp.status).toBe(200);
    expect(seenAuthHeaders).toEqual([
      'Bearer expired-token:acct_old',
      'Bearer fresh-token:acct_new',
      'Bearer fresh-token:acct_new',
    ]);
  });

  it('uses a fresh stream controller for SDK retry requests', async () => {
    let upstreamRequests = 0;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () => {
        upstreamRequests += 1;
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: `try-${upstreamRequests}` },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    };

    const firstResp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, request);
    const firstReader = firstResp.body?.getReader();
    expect(firstReader).toBeDefined();
    await firstReader?.read();
    await firstReader?.cancel('simulate startup timeout abort before SDK retry');

    const retryResp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, request);
    const retryEvents = await readSSEEvents(retryResp.body);

    expect(firstResp.status).toBe(200);
    expect(retryResp.status).toBe(200);
    expect(upstreamRequests).toBe(2);
    expect(textDeltaEvents(retryEvents).join('')).toBe('try-2');
    expect(messageDeltaEvent(retryEvents)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    });
  });

  it('does not throw when the SSE stream controller is already closed', async () => {
    let capturedController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        capturedController = controller;
        controller.close();
      },
    });
    await new Response(stream).arrayBuffer();
    expect(capturedController).toBeDefined();

    await expect(
      _openAIResponsesBridgeServerTesting.streamResponsesToAnthropic({
        openAIResponse: sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'late' },
          },
        ]),
        controller: capturedController as ReadableStreamDefaultController<Uint8Array>,
        model: 'gpt-5.3-codex',
        estimatedInputTokens: 1,
      })
    ).resolves.toBeUndefined();
  });

  it('closes cleanly when the OpenAI stream errors after starting', async () => {
    const openAIStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'hello',
            })}\n\n`
          )
        );
        setTimeout(() => controller.error(new Error('upstream exploded')), 0);
      },
    });
    const anthropicStream = new ReadableStream<Uint8Array>({
      start(controller) {
        void _openAIResponsesBridgeServerTesting.streamResponsesToAnthropic({
          openAIResponse: new Response(openAIStream),
          controller,
          model: 'gpt-5.3-codex',
          estimatedInputTokens: 1,
        });
      },
    });

    const events = await readSSEEvents(anthropicStream);

    expect(textDeltaEvents(events).join('')).toBe('hello');
    expect(events.find((event) => event.event === 'error')?.data).toMatchObject({
      type: 'error',
      error: { type: 'api_error' },
    });
    expect(events.at(-1)?.event).toBe('message_stop');
  });

  it('reports model_context_window from config models for non-Codex models', async () => {
    // Simulates a bridge configured with a non-Codex model (e.g. OpenRouter
    // model with 1M context). The context window should come from the config
    // models list, not from the Codex-only getModelContextWindow() lookup.
    const nonCodexModels = [
      {
        id: 'deepseek/deepseek-chat-pro-v4',
        display_name: 'DeepSeek V4 Pro',
        created_at: '2026-01-01T00:00:00Z',
        context_window: 1_000_000,
      },
    ];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: nonCodexModels,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'hello' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat-pro-v4',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    const start = messageStartEvent(events);
    const startMessage = start?.message as
      | { usage?: { model_context_window?: number } }
      | undefined;
    expect(startMessage?.usage?.model_context_window).toBe(1_000_000);

    const delta = messageDeltaEvent(events);
    const deltaUsage = delta?.usage as { model_context_window?: number } | undefined;
    expect(deltaUsage?.model_context_window).toBe(1_000_000);
  });

  it('falls back to Codex context window for Codex models in config', async () => {
    // When the model is a known Codex model AND is in config.models,
    // the config value takes precedence (they should match, but this
    // verifies the config-based lookup path works for Codex too).
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: [
        {
          id: 'gpt-5.3-codex',
          display_name: 'GPT-5.3 Codex',
          created_at: '2025-12-01T00:00:00Z',
          context_window: 272000,
        },
      ],
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'hi' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    const start = messageStartEvent(events);
    const startMessage = start?.message as
      | { usage?: { model_context_window?: number } }
      | undefined;
    expect(startMessage?.usage?.model_context_window).toBe(272000);
  });

  it('includes config model in GET /v1/models response with correct context_window', async () => {
    const nonCodexModels = [
      {
        id: 'deepseek/deepseek-chat-pro-v4',
        display_name: 'DeepSeek V4 Pro',
        created_at: '2026-01-01T00:00:00Z',
        context_window: 1_000_000,
      },
    ];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: nonCodexModels,
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
    const body = (await resp.json()) as {
      data: Array<{ id: string; context_window: number; max_context_window: number }>;
    };

    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('deepseek/deepseek-chat-pro-v4');
    expect(body.data[0].context_window).toBe(1_000_000);
    expect(body.data[0].max_context_window).toBe(1_000_000);
  });

  it('falls back to Codex-only context window when model is NOT in config.models', async () => {
    // Bridge is configured with only gpt-5.3-codex, but the request uses
    // gpt-5.4-mini which is a known Codex model but NOT in this bridge's
    // config.models. The fallback to getCodexModelContextWindow() should
    // return the correct value (128000 for gpt-5.4-mini).
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: [
        {
          id: 'gpt-5.3-codex',
          display_name: 'GPT-5.3 Codex',
          created_at: '2025-12-01T00:00:00Z',
          context_window: 272000,
        },
      ],
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'hi' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    const start = messageStartEvent(events);
    const startMessage = start?.message as
      | { usage?: { model_context_window?: number } }
      | undefined;
    // gpt-5.4-mini is NOT in config.models but IS a known Codex model,
    // so resolveContextWindow falls back to getCodexModelContextWindow('gpt-5.4-mini') = 128000
    expect(startMessage?.usage?.model_context_window).toBe(128000);
  });

  it('propagates the original 401 when ChatGPT OAuth refresh is unavailable', async () => {
    let refreshAttempts = 0;
    server = createOpenAIResponsesBridgeServer({
      auth: {
        source: 'chatgpt_oauth',
        apiKey: 'expired-token',
        accountId: 'acct_old',
        refreshAuthTokens: async () => {
          refreshAttempts += 1;
          return null;
        },
      },
      models,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'expired' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(refreshAttempts).toBe(1);
    expect(resp.status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toBe('expired');
  });

  it('maps thinking budget_tokens to OpenAI reasoning.effort', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(capturedBody?.include).toEqual([
      'reasoning.encrypted_content',
      'reasoning.summary_text',
    ]);
  });

  it('maps think32k to xhigh on frontier models that support it', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        thinking: { type: 'enabled', budget_tokens: 32000 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('omits reasoning.summary_text from include for ChatGPT OAuth endpoint', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'chatgpt_oauth', apiKey: 'chatgpt-token', accountId: 'acc_123' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(capturedBody?.include).toEqual(['reasoning.encrypted_content']);
  });

  it('caps think32k to high on models that do not support xhigh', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: [
        {
          id: 'gpt-5.1-codex-mini',
          display_name: 'GPT-5.1 Codex Mini',
          created_at: '2026-01-01T00:00:00Z',
          context_window: 128000,
        },
      ],
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.1-codex-mini',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        thinking: { type: 'enabled', budget_tokens: 32000 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });
  it('omits reasoning when thinking is off', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'No thinking please.' }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toBeUndefined();
    expect(capturedBody?.include).toBeUndefined();
  });

  it('streams OpenAI reasoning events as Anthropic thinking SSE', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.reasoning_summary_part.added',
            data: { type: 'response.reasoning_summary_part.added' },
          },
          {
            event: 'response.reasoning_summary_text.delta',
            data: { type: 'response.reasoning_summary_text.delta', delta: 'Let me' },
          },
          {
            event: 'response.reasoning_summary_text.delta',
            data: { type: 'response.reasoning_summary_text.delta', delta: ' think...' },
          },
          {
            event: 'response.reasoning_summary_part.done',
            data: { type: 'response.reasoning_summary_part.done' },
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Hello!' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 3 }, output: [] },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Say hello.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });

    const events = await readSSEEvents(resp.body);
    const thinkingStart = events.find(
      (e) =>
        e.event === 'content_block_start' &&
        (e.data.content_block as { type: string })?.type === 'thinking'
    );
    expect(thinkingStart).toBeDefined();

    const thinkingDeltas = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data.delta as { thinking?: string }).thinking)
      .filter(Boolean);
    expect(thinkingDeltas.join('')).toBe('Let me think...');

    const textDeltas = textDeltaEvents(events);
    expect(textDeltas.join('')).toBe('Hello!');

    expect(messageDeltaEvent(events)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    });
  });

  it('passes encrypted reasoning content through on multi-turn', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedBodies.push(body);
        if (capturedBodies.length === 1) {
          return sse([
            {
              event: 'response.output_text.delta',
              data: { type: 'response.output_text.delta', delta: 'First response.' },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_reasoning',
                  usage: { input_tokens: 5, output_tokens: 3 },
                  output: [
                    {
                      type: 'reasoning',
                      encrypted_content: 'enc_abc123',
                    },
                  ],
                },
              },
            },
          ]);
        }
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Second response.' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 3 }, output: [] },
            },
          },
        ]);
      },
    });

    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'First.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(first.body);

    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'user', content: 'First.' },
          { role: 'assistant', content: 'First response.' },
          { role: 'user', content: 'Second.' },
        ],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    const events = await readSSEEvents(second.body);

    // Second request should include reasoning item in input
    const secondInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
    expect(
      secondInput.some(
        (item) => item.type === 'reasoning' && item.encrypted_content === 'enc_abc123'
      )
    ).toBe(true);
    // previous_response_id should not be used when reasoning items are present
    expect(capturedBodies[1]?.previous_response_id).toBeUndefined();
    expect(textDeltaEvents(events).join('')).toBe('Second response.');
  });

  it('reports reasoning_tokens in message_delta usage', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'hello' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                usage: {
                  input_tokens: 5,
                  output_tokens: 10,
                  output_tokens_details: { reasoning_tokens: 7 },
                },
                output: [],
              },
            },
          },
        ]),
    });

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const events = await readSSEEvents(resp.body);
    expect(messageDeltaEvent(events)).toMatchObject({
      type: 'message_delta',
      usage: { output_tokens: 10, thinking_tokens: 7 },
    });
  });

  it('clears cached reasoning when response has no reasoning items', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_req, init) => {
        const body = JSON.parse((init?.body as string) ?? '{}');
        capturedBodies.push(body);
        requestCount++;
        if (requestCount === 1) {
          return sse([
            {
              event: 'response.output_text.delta',
              data: { type: 'response.output_text.delta', delta: 'First.' },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_first',
                  usage: { input_tokens: 5, output_tokens: 1 },
                  output: [{ type: 'reasoning', encrypted_content: 'enc_first' }],
                },
              },
            },
          ]);
        }
        // Second and third requests: no reasoning items returned
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Later.' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: `resp_${requestCount}`,
                usage: { input_tokens: 5, output_tokens: 1 },
                output: [],
              },
            },
          },
        ]);
      },
    });

    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'First.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(first.body);

    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'assistant', content: 'First response.' },
          { role: 'user', content: 'Second.' },
        ],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(second.body);

    const third = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'assistant', content: 'First response.' },
          { role: 'user', content: 'Second.' },
          { role: 'assistant', content: 'Second response.' },
          { role: 'user', content: 'Third.' },
        ],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(third.body);

    // Second request should include the cached reasoning from first turn
    const secondInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
    expect(
      secondInput.some(
        (item) => item.type === 'reasoning' && item.encrypted_content === 'enc_first'
      )
    ).toBe(true);

    // Third request should NOT contain any reasoning items because second response had none
    const thirdInput = capturedBodies[2]?.input as Array<Record<string, unknown>>;
    expect(thirdInput.some((item) => item.type === 'reasoning')).toBe(false);
  });

  it('includes encrypted reasoning in request when reusing cached reasoning without thinking config', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_req, init) => {
        const body = JSON.parse((init?.body as string) ?? '{}');
        capturedBodies.push(body);
        requestCount++;
        if (requestCount === 1) {
          return sse([
            {
              event: 'response.output_text.delta',
              data: { type: 'response.output_text.delta', delta: 'First.' },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_first',
                  usage: { input_tokens: 5, output_tokens: 1 },
                  output: [{ type: 'reasoning', encrypted_content: 'enc_first' }],
                },
              },
            },
          ]);
        }
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Second.' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_second',
                usage: { input_tokens: 5, output_tokens: 1 },
                output: [{ type: 'reasoning', encrypted_content: 'enc_second' }],
              },
            },
          },
        ]);
      },
    });

    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'First.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(first.body);

    // Second turn WITHOUT thinking field — should still include reasoning and encrypted_content
    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'assistant', content: 'First response.' },
          { role: 'user', content: 'Second.' },
        ],
        // no thinking field
      }),
    });
    await readSSEEvents(second.body);

    // Second request should include the cached reasoning item
    const secondBody = capturedBodies[1];
    expect(secondBody?.reasoning).toBeUndefined();
    expect(secondBody?.include).toEqual(['reasoning.encrypted_content', 'reasoning.summary_text']);
    const secondInput = secondBody?.input as Array<Record<string, unknown>>;
    expect(
      secondInput.some(
        (item) => item.type === 'reasoning' && item.encrypted_content === 'enc_first'
      )
    ).toBe(true);
  });

  it('includes injected reasoning items in count_tokens and message_start estimates', async () => {
    let requestCount = 0;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () => {
        requestCount++;
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Hello.' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: `resp_${requestCount}`,
                usage: { input_tokens: 5, output_tokens: 1 },
                output: [{ type: 'reasoning', encrypted_content: 'a'.repeat(100) }],
              },
            },
          },
        ]);
      },
    });

    // First turn to populate reasoning cache
    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Hello.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(first.body);

    // count_tokens for second turn
    const countResp = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'assistant', content: 'Hello.' },
          { role: 'user', content: 'Again.' },
        ],
      }),
    });
    const count = (await countResp.json()) as { input_tokens: number };

    // Actual second turn
    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'assistant', content: 'Hello.' },
          { role: 'user', content: 'Again.' },
        ],
      }),
    });
    const events = await readSSEEvents(second.body);
    const messageStart = messageStartEvent(events);
    const messageStartMessage = messageStart?.message as
      | { usage?: { input_tokens?: number } }
      | undefined;

    // The estimates should match and should account for the ~100-char reasoning item
    expect(count.input_tokens).toBe(messageStartMessage?.usage?.input_tokens);
    expect(count.input_tokens).toBeGreaterThan(20);
  });

  it('evicts stale reasoning items after the TTL', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      continuationTtlMs: 10,
      fetchImpl: async (_req, init) => {
        const body = JSON.parse((init?.body as string) ?? '{}');
        capturedBodies.push(body);
        if (capturedBodies.length === 1) {
          return sse([
            {
              event: 'response.output_text.delta',
              data: { type: 'response.output_text.delta', delta: 'First.' },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_first',
                  usage: { input_tokens: 5, output_tokens: 1 },
                  output: [{ type: 'reasoning', encrypted_content: 'enc_first' }],
                },
              },
            },
          ]);
        }
        return sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Second.' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_second',
                usage: { input_tokens: 5, output_tokens: 1 },
                output: [],
              },
            },
          },
        ]);
      },
    });

    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'First.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(first.body);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [
          { role: 'assistant', content: 'First response.' },
          { role: 'user', content: 'Second.' },
        ],
        // no thinking field — reasoning items should not appear if evicted
      }),
    });
    await readSSEEvents(second.body);

    // Reasoning items should have been evicted, so second request has no reasoning
    // item in input and does not request encrypted_content inclusion.
    expect(capturedBodies[1]?.include).toBeUndefined();
    const secondInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
    expect(secondInput.some((item) => item.type === 'reasoning')).toBe(false);
  });

  it('clears reasoning item timers on server stop', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      continuationTtlMs: 60000,
      fetchImpl: async () =>
        sse([
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'First.' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_first',
                usage: { input_tokens: 5, output_tokens: 1 },
                output: [{ type: 'reasoning', encrypted_content: 'enc_first' }],
              },
            },
          },
        ]),
    });

    const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'First.' }],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    await readSSEEvents(first.body);

    // stop() should clear the timer without throwing or leaking
    expect(() => server?.stop()).not.toThrow();
  });

  it('merges session thinking config when the request omits thinking', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    server.setSessionThinkingConfig?.('session-a', {
      type: 'enabled',
      budget_tokens: 31999,
    });

    const resp = await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        // no thinking field
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('does not override request thinking when session config is also present', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    server.setSessionThinkingConfig?.('session-b', {
      type: 'enabled',
      budget_tokens: 32000,
    });

    const resp = await fetch(`${server.baseUrlForSession?.('session-b')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think lightly.' }],
        thinking: { type: 'enabled', budget_tokens: 8000 },
      }),
    });

    expect(resp.status).toBe(200);
    // Request-level 8k tokens should win over session-level 32k tokens
    expect(capturedBody?.reasoning).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('overrides non-enabled SDK thinking payload with session enabled config', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    server.setSessionThinkingConfig?.('session-adaptive', {
      type: 'enabled',
      budget_tokens: 16000,
    });

    const resp = await fetch(`${server.baseUrlForSession?.('session-adaptive')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think adaptively.' }],
        // The SDK can send {type:'adaptive'} internally; the bridge should
        // override it with the session's explicit enabled config so reasoning
        // is forwarded to OpenAI.
        thinking: { type: 'adaptive' },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('clears session thinking config when undefined is passed', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            },
          },
        ]);
      },
    });

    server.setSessionThinkingConfig?.('session-c', {
      type: 'enabled',
      budget_tokens: 16000,
    });
    server.setSessionThinkingConfig?.('session-c', undefined);

    const resp = await fetch(`${server.baseUrlForSession?.('session-c')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'No thinking.' }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toBeUndefined();
  });
});
