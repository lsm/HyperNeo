import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  configureLogger,
  getLoggerConfig,
  subscribeToStructuredLogs,
  LogLevel,
} from '@hyperneo/shared';
import { isRetryableProviderError } from '@hyperneo/shared/provider/error-taxonomy';
import {
  _openAIResponsesBridgeServerTesting,
  anthropicMessagesToResponsesInput,
  createOpenAIResponsesBridgeServer,
  type OpenAIResponsesBridgeServer,
} from '../../../../../src/lib/providers/openai-responses-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

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

  it('stringifies non-text tool_result content to a string (Codex rejects arrays)', () => {
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
        // function_call_output.output must be a string on the Responses API;
        // the ChatGPT Codex backend hard-rejects arrays with "Unsupported
        // content type". Images become descriptive placeholders.
        output: 'Screenshot taken.\n[image: image/png]',
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

  it('stringifies is_error tool_result content with images to a string', () => {
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
            is_error: true,
            content: [
              { type: 'text', text: 'Capture failed.' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'screendata' },
              },
            ],
          } as unknown as { type: 'tool_result'; tool_use_id: string; content: string },
        ],
      },
    ]);

    // is_error tool results are stringified too — no array output that Codex
    // would reject.
    const fnOutput = input.find((i) => i.type === 'function_call_output') as {
      type: 'function_call_output';
      output: unknown;
    };
    expect(typeof fnOutput.output).toBe('string');
    expect(fnOutput.output).toBe('[Tool error]\nCapture failed.\n[image: image/png]');
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

  it.skipIf(!isBun)('streams OpenAI text deltas as Anthropic text SSE', async () => {
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

  it.skipIf(!isBun)(
    'forwards real Codex model IDs directly (no alias resolution needed)',
    async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        modelAliases: {}, // Codex no longer uses Anthropic aliases
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
          model: 'gpt-5.5',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      expect(resp.status).toBe(200);
      expect(capturedBody?.model).toBe('gpt-5.5');
    }
  );

  it.skipIf(!isBun)(
    'uses per-session model override when setSessionModelConfig is called',
    async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        modelAliases: {}, // Codex now uses identity mapping
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

      server.setSessionModelConfig?.('session-a', 'gpt-5.5', 'gpt-5.3-codex');

      const resp = await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      expect(resp.status).toBe(200);
      expect(capturedBody?.model).toBe('gpt-5.3-codex');
    }
  );

  it.skipIf(!isBun)('applies session override only when incoming model matches alias', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      modelAliases: {}, // Codex now uses identity mapping
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

    // Primary model override: gpt-5.3-codex (SDK now sends real IDs)
    server.setSessionModelConfig?.('session-a', 'gpt-5.5', 'gpt-5.3-codex');

    // Haiku call with different alias — should NOT be overridden to gpt-5.3-codex
    const resp = await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(resp.status).toBe(200);
    // Resolves through modelAliases to gpt-5.4-mini, NOT overridden to gpt-5.3-codex
    expect(capturedBody?.model).toBe('gpt-5.4-mini');
  });

  it.skipIf(!isBun)(
    'preserves primary model override when fallback is also registered',
    async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        modelAliases: {}, // Codex now uses identity mapping
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
      server.setSessionModelConfig?.('session-a', 'gpt-5.6-sol', 'gpt-5.6-sol');
      // Fallback model registration (same session, different alias)
      server.setSessionModelConfig?.('session-a', 'gpt-5.6-luna', 'gpt-5.6-luna');

      // Primary request — should still resolve to gpt-5.6-sol
      await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'primary' }],
        }),
      });
      expect(capturedBody?.model).toBe('gpt-5.6-sol');

      // Fallback request — should resolve to gpt-5.6-luna
      await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'fallback' }],
        }),
      });
      expect(capturedBody?.model).toBe('gpt-5.6-luna');
    }
  );

  it.skipIf(!isBun)(
    'uses last-registered model when same-tier models share alias (last-wins)',
    async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        modelAliases: {
          'claude-opus-4-7': 'gpt-5.5',
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
      server.setSessionModelConfig?.('session-a', 'gpt-5.5', 'gpt-5.3-codex');
      // Model switch: user switches to gpt-5.4 (same alias tier)
      server.setSessionModelConfig?.('session-a', 'gpt-5.5', 'gpt-5.4');

      // Request should use the latest registration (gpt-5.4)
      await fetch(`${server.baseUrlForSession?.('session-a')}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'switched' }],
        }),
      });
      expect(capturedBody?.model).toBe('gpt-5.4');
    }
  );

  it.skipIf(!isBun)('forwards image attachments to the OpenAI Responses API', async () => {
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

  it.skipIf(!isBun)('streams OpenAI function calls as Anthropic tool_use blocks', async () => {
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

  it.skipIf(!isBun)('continues tool_result turns with previous_response_id', async () => {
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

  it.skipIf(!isBun)(
    'can route continuation mappings with session-scoped URLs instead of auth headers',
    async () => {
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
      expect(sessionAUrl).toContain('/_hyperneo/session/session-a');

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
    }
  );

  it.skipIf(!isBun)('keeps continuation mappings isolated by bridge session', async () => {
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

  it.skipIf(!isBun)('evicts stale tool_result continuations after the TTL', async () => {
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

  it.skipIf(!isBun)(
    'maps OpenAI incomplete responses to Anthropic max_tokens stop reason',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('normalizes OpenAI prompt/completion token usage fields', async () => {
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

  it.skipIf(!isBun)('returns an Anthropic 502 error when the upstream request fails', async () => {
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

  it.skipIf(!isBun)(
    'skips malformed upstream SSE blocks and preserves valid partial trailing data',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('maps upstream streaming failures to Anthropic SSE errors', async () => {
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

  it.skipIf(!isBun)('maps upstream streaming error events to Anthropic SSE errors', async () => {
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

  it.skipIf(!isBun)(
    'surfaces a retryable overloaded_error for an empty upstream 200 SSE stream',
    async () => {
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        // 200 + text/event-stream with ZERO data events — the overload/aborted
        // shape that previously produced an empty end_turn and killed compaction.
        fetchImpl: async () =>
          new Response('', { headers: { 'Content-Type': 'text/event-stream' } }),
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
      // HTTP 200 is committed before the body is read, so the retryable error
      // surfaces as an in-stream SSE event rather than a non-200 status.
      expect(resp.status).toBe(200);
      expect(events.find((event) => event.event === 'error')?.data).toMatchObject({
        type: 'error',
        error: { type: 'overloaded_error' },
      });
      expect(events.at(-1)?.event).toBe('message_stop');
      // No empty end_turn was emitted.
      expect(messageDeltaEvent(events)).toBeUndefined();
      expect(textDeltaEvents(events)).toEqual([]);
    }
  );

  it.skipIf(!isBun)(
    'surfaces a retryable overloaded_error when a 200 stream yields only non-content events',
    async () => {
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        fetchImpl: async () =>
          sse([
            {
              event: 'response.created',
              data: { type: 'response.created', response: { id: 'resp_1' } },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                // Completed but with empty output — no text / reasoning / tool_use.
                response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
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
      const errorData = events.find((event) => event.event === 'error')?.data as
        | { error?: { type?: string } }
        | undefined;
      expect(errorData?.error?.type).toBe('overloaded_error');
      expect(events.at(-1)?.event).toBe('message_stop');
      expect(messageDeltaEvent(events)).toBeUndefined();

      // The SDK surfaces an in-stream error event as JSON.stringify(body)
      // (core/error.js makeMessage), so the 'overloaded_error' type reaches the
      // query-runner's retry detector. Verify that retry contract end-to-end:
      // the surfaced string is recognised as retryable, so the turn (compaction)
      // self-heals instead of failing.
      expect(isRetryableProviderError(JSON.stringify(errorData))).toBe(true);
    }
  );

  it.skipIf(!isBun)('returns 400 for unsupported user content blocks', async () => {
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

  it.skipIf(!isBun)('returns 400 for unsupported image source types', async () => {
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

  it.skipIf(!isBun)('maps upstream 429 responses to Anthropic rate_limit_error', async () => {
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

  it.skipIf(!isBun)('maps upstream 529 responses to Anthropic overloaded_error', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
          status: 529,
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
    expect(resp.status).toBe(529);
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toBe('overloaded');
  });

  describe('4xx request diagnostics', () => {
    let logEvents: Array<{ level: string; message: string }>;
    let unsubscribe: () => void;
    let originalConfig: ReturnType<typeof getLoggerConfig>;

    beforeEach(() => {
      originalConfig = getLoggerConfig();
      configureLogger({
        level: LogLevel.WARN,
        filter: ['kai:daemon:openai-responses-bridge-server'],
      });
      logEvents = [];
      unsubscribe = subscribeToStructuredLogs((event) => {
        logEvents.push({ level: event.level, message: event.message });
      });
    });

    afterEach(() => {
      unsubscribe();
      configureLogger(originalConfig);
    });

    it.skipIf(!isBun)(
      'logs the translated request body summary when upstream returns 400 "Unsupported content type"',
      async () => {
        server = createOpenAIResponsesBridgeServer({
          auth: { source: 'api_key', apiKey: 'sk-test' },
          models,
          fetchImpl: async () =>
            new Response('{"detail":"Unsupported content type"}', {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }),
        });

        const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.3-codex',
            max_tokens: 128,
            messages: [
              { role: 'user', content: 'First.' },
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
            ],
          }),
        });
        await resp.text();

        expect(resp.status).toBe(400);
        // A single warn line capturing the upstream rejection + request body summary.
        const rejectionLogs = logEvents.filter((e) =>
          e.message.includes('upstream rejected request (HTTP 400)')
        );
        expect(rejectionLogs.length).toBe(1);
        const summaryJson = rejectionLogs[0]!.message.slice(
          rejectionLogs[0]!.message.indexOf('requestBodySummary=') + 'requestBodySummary='.length
        );
        const summary = JSON.parse(summaryJson) as Record<string, unknown>;
        // Item types are reported as a histogram (counts per type), not an array,
        // so a long session can't balloon the log line.
        expect(summary.inputItemTypeCounts).toEqual({
          message: 2,
          function_call: 1,
          function_call_output: 1,
        });
        // Shapes most likely to trigger "Unsupported content type" are captured.
        const input = summary.input as Array<Record<string, unknown>>;
        const fnOutput = input.find((i) => i.type === 'function_call_output');
        expect(fnOutput?.outputType).toBe('string');
        const fnCall = input.find((i) => i.type === 'function_call');
        expect(fnCall?.hasStatus).toBe(true);
      }
    );

    it.skipIf(!isBun)('captures reasoning encrypted_content shape in the 4xx summary', async () => {
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        fetchImpl: async (_url, init) => {
          const reqBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const input = reqBody.input as Array<Record<string, unknown>>;
          // First request: succeed and return encrypted reasoning to be cached.
          if (!input.some((i) => i.type === 'reasoning')) {
            return sse([
              {
                event: 'response.output_text.delta',
                data: { type: 'response.output_text.delta', delta: 'ok' },
              },
              {
                event: 'response.completed',
                data: {
                  type: 'response.completed',
                  response: {
                    id: 'resp_1',
                    usage: { input_tokens: 5, output_tokens: 1 },
                    output: [{ type: 'reasoning', encrypted_content: 'enc_xyz' }],
                  },
                },
              },
            ]);
          }
          // Second request (carries replayed reasoning): rejected by upstream.
          return new Response('{"detail":"Unsupported content type"}', {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      // First turn to populate the reasoning cache.
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

      // Second turn replays the reasoning item; upstream rejects with 400.
      const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          max_tokens: 128,
          messages: [
            { role: 'user', content: 'First.' },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'Second.' },
          ],
          thinking: { type: 'enabled', budget_tokens: 16000 },
        }),
      });
      await second.text();

      const rejectionLogs = logEvents.filter((e) =>
        e.message.includes('upstream rejected request (HTTP 400)')
      );
      expect(rejectionLogs.length).toBe(1);
      const summaryJson = rejectionLogs[0]!.message.slice(
        rejectionLogs[0]!.message.indexOf('requestBodySummary=') + 'requestBodySummary='.length
      );
      const summary = JSON.parse(summaryJson) as Record<string, unknown>;
      expect(summary.inputItemTypeCounts).toHaveProperty('reasoning');
      const reasoning = (summary.input as Array<Record<string, unknown>>).find(
        (i) => i.type === 'reasoning'
      );
      // encrypted_content length is captured (not the payload itself).
      expect(reasoning?.encryptedContentLength).toBe('enc_xyz'.length);
    });

    it.skipIf(!isBun)(
      'does not log request body summary for 5xx (server-side errors)',
      async () => {
        server = createOpenAIResponsesBridgeServer({
          auth: { source: 'api_key', apiKey: 'sk-test' },
          models,
          fetchImpl: async () =>
            new Response('{"error":{"message":"internal"}}', {
              status: 503,
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
        await resp.text();

        expect(resp.status).toBe(503);
        // 5xx is server-side — no request-body summary is logged.
        expect(logEvents.some((e) => e.message.includes('requestBodySummary='))).toBe(false);
      }
    );

    describe('summarizeResponsesRequestFor4xx (direct)', () => {
      const { summarizeResponsesRequestFor4xx } = _openAIResponsesBridgeServerTesting;
      type Body = Parameters<typeof summarizeResponsesRequestFor4xx>[0];

      it('reports item and content-block types as histograms, not arrays', () => {
        const body: Body = {
          model: 'gpt-5.3-codex',
          store: false,
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'a' },
                { type: 'input_text', text: 'b' },
              ],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'c', annotations: [] }],
            },
            { type: 'function_call', call_id: 'c1', name: 'foo', arguments: '{}' },
            { type: 'function_call_output', call_id: 'c1', output: '{}' },
            { type: 'reasoning', encrypted_content: 'enc' },
          ],
        };

        const summary = summarizeResponsesRequestFor4xx(body);

        // Top-level input item types collapse to a histogram.
        expect(summary.inputItemTypeCounts).toEqual({
          message: 2,
          function_call: 1,
          function_call_output: 1,
          reasoning: 1,
        });
        expect(Array.isArray(summary.inputItemTypeCounts)).toBe(false);
        expect(summary).not.toHaveProperty('inputItemTypes');

        // Per-message content blocks are a histogram too.
        const messages = (summary.input as Array<Record<string, unknown>>).filter(
          (i) => i.type === 'message'
        );
        expect(messages[0]).not.toHaveProperty('contentBlockTypes');
        expect(messages[0]?.contentBlockTypeCounts).toEqual({ input_text: 2 });
      });

      it('keeps the histogram compact for a large input (1000+ items)', () => {
        const input: Body['input'] = [];
        for (let i = 0; i < 600; i++) {
          input.push({ type: 'function_call', call_id: `c${i}`, name: 'tool', arguments: '{}' });
          input.push({ type: 'function_call_output', call_id: `c${i}`, output: '{}' });
        }
        const body: Body = { model: 'gpt-5.3-codex', store: false, stream: true, input };

        const summary = summarizeResponsesRequestFor4xx(body);

        expect(summary.inputItemCount).toBe(1200);
        // 1200 input items collapse to a 2-key histogram — the old code would
        // have emitted a 1200-entry inputItemTypes array here.
        expect(summary.inputItemTypeCounts).toEqual({
          function_call: 600,
          function_call_output: 600,
        });
        expect(JSON.stringify(summary.inputItemTypeCounts).length).toBeLessThan(100);
      });
    });

    describe('logUpstream4xx (direct)', () => {
      const { logUpstream4xx } = _openAIResponsesBridgeServerTesting;
      type Body = Parameters<
        (typeof _openAIResponsesBridgeServerTesting)['summarizeResponsesRequestFor4xx']
      >[0];

      const minimalBody: Body = {
        model: 'gpt-5.3-codex',
        store: false,
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      };

      it('logs a short line (no request body summary) for 429 rate limits', () => {
        logUpstream4xx(429, minimalBody, 'usage_limit_reached');
        expect(logEvents.length).toBe(1);
        expect(logEvents[0]!.message).toContain('upstream rejected (HTTP 429)');
        expect(logEvents[0]!.message).not.toContain('requestBodySummary=');
      });

      it('logs a short line for 401/403 auth errors (no request body summary)', () => {
        logUpstream4xx(401, minimalBody, 'unauthorized');
        logUpstream4xx(403, minimalBody, 'forbidden');
        expect(logEvents.length).toBe(2);
        for (const evt of logEvents) {
          expect(evt.message).not.toContain('requestBodySummary=');
        }
        expect(logEvents[0]!.message).toContain('HTTP 401');
        expect(logEvents[1]!.message).toContain('HTTP 403');
      });

      it('logs the full request body summary for 400, capped at 1000 chars', () => {
        // 50 function_call items make the untruncated summary well over 1000 chars.
        const input: Body['input'] = [];
        for (let i = 0; i < 50; i++) {
          input.push({ type: 'function_call', call_id: `c${i}`, name: 'tool', arguments: '{}' });
        }
        const body: Body = { model: 'gpt-5.3-codex', store: false, stream: true, input };

        logUpstream4xx(400, body, 'Unsupported content type');

        expect(logEvents.length).toBe(1);
        const msg = logEvents[0]!.message;
        expect(msg).toContain('upstream rejected request (HTTP 400)');
        expect(msg).toContain('requestBodySummary=');
        // 50 function_call items would otherwise produce a multi-KB line; the
        // whole log line is capped (the structured logger bounds every message
        // at 1000 chars, and the summary itself is sliced before formatting).
        expect(msg.length).toBe(1000);
      });

      it('does not log for 5xx (server-side errors)', () => {
        logUpstream4xx(500, minimalBody, 'internal');
        logUpstream4xx(503, minimalBody, 'unavailable');
        expect(logEvents.length).toBe(0);
      });
    });
  });

  it.skipIf(!isBun)(
    'self-heals: retries without reasoning on a 400 and completes the turn',
    async () => {
      const capturedInputs: Array<Record<string, unknown>[]> = [];
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models,
        fetchImpl: async (_url, init) => {
          const reqBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const input = reqBody.input as Array<Record<string, unknown>>;
          capturedInputs.push(input);
          // Any request carrying a replayed reasoning item is rejected — this
          // simulates the stale encrypted_content trigger (candidate 1).
          if (input.some((i) => i.type === 'reasoning')) {
            return new Response('{"detail":"Unsupported content type"}', {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // Requests without reasoning succeed (including the self-healing retry).
          // The first turn returns reasoning in its output so it gets cached for
          // the session; the retry returns plain text.
          const isFirstTurn =
            input.length === 1 && (input[0] as Record<string, unknown>)?.type === 'message';
          return sse([
            ...(isFirstTurn
              ? [
                  {
                    event: 'response.completed',
                    data: {
                      type: 'response.completed',
                      response: {
                        id: 'resp_1',
                        usage: { input_tokens: 5, output_tokens: 1 },
                        output: [{ type: 'reasoning', encrypted_content: 'enc_cached' }],
                      },
                    },
                  },
                ]
              : [
                  {
                    event: 'response.output_text.delta',
                    data: { type: 'response.output_text.delta', delta: 'recovered' },
                  },
                  {
                    event: 'response.completed',
                    data: {
                      type: 'response.completed',
                      response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
                    },
                  },
                ]),
          ]);
        },
      });

      // First turn: returns reasoning, which gets cached for the session.
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

      // Second turn replays the cached reasoning; upstream 400s, then the bridge
      // retries once without reasoning.
      const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          max_tokens: 128,
          messages: [
            { role: 'user', content: 'First.' },
            { role: 'assistant', content: 'recovered' },
            { role: 'user', content: 'Second.' },
          ],
          thinking: { type: 'enabled', budget_tokens: 16000 },
        }),
      });
      const events = await readSSEEvents(second.body);

      // The turn completes (does not surface the terminal 400 to the SDK).
      expect(second.status).toBe(200);
      expect(textDeltaEvents(events).join('')).toBe('recovered');

      // Two upstream calls for the second turn: first WITH reasoning (rejected),
      // then the retry WITHOUT reasoning.
      expect(capturedInputs.length).toBe(3);
      expect(capturedInputs[1]!.some((i) => i.type === 'reasoning')).toBe(true);
      expect(capturedInputs[2]!.some((i) => i.type === 'reasoning')).toBe(false);
    }
  );

  it.skipIf(!isBun)('surfaces the 400 when the reasoning-strip retry also fails', async () => {
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models,
      fetchImpl: async (_url, init) => {
        const reqBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const input = reqBody.input as Array<Record<string, unknown>>;
        // First turn succeeds and returns reasoning.
        if (!input.some((i) => i.type === 'reasoning') && input.length === 1) {
          return sse([
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  id: 'resp_1',
                  usage: { input_tokens: 5, output_tokens: 1 },
                  output: [{ type: 'reasoning', encrypted_content: 'enc_bad' }],
                },
              },
            },
          ]);
        }
        // Every multi-message request 400s — even the retry without reasoning.
        return new Response('{"detail":"Unsupported content type"}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
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
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'Second.' },
        ],
        thinking: { type: 'enabled', budget_tokens: 16000 },
      }),
    });
    const body = (await second.json()) as { error: { type: string; message: string } };

    // When the retry also fails, the 400 surfaces to the SDK as before.
    expect(second.status).toBe(400);
    expect(body.error.message).toContain('Unsupported content type');
  });

  it.skipIf(!isBun)(
    'uses Codex ChatGPT OAuth endpoint and account header for OAuth auth',
    async () => {
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
    }
  );

  it.skipIf(!isBun)(
    'refreshes ChatGPT OAuth auth once after an upstream 401 and reuses it',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('uses a fresh stream controller for SDK retry requests', async () => {
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

  it('emits a retryable overloaded_error for an empty upstream stream (direct)', async () => {
    const openAIStream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 200 body with no SSE data events at all (the empty 200 shape).
        controller.close();
      },
    });
    const anthropicStream = new ReadableStream<Uint8Array>({
      start(controller) {
        void _openAIResponsesBridgeServerTesting.streamResponsesToAnthropic({
          openAIResponse: new Response(openAIStream, {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
          controller,
          model: 'gpt-5.3-codex',
          estimatedInputTokens: 1,
        });
      },
    });

    const events = await readSSEEvents(anthropicStream);
    expect(events.find((event) => event.event === 'error')?.data).toMatchObject({
      type: 'error',
      error: { type: 'overloaded_error' },
    });
    expect(events.at(-1)?.event).toBe('message_stop');
    expect(messageDeltaEvent(events)).toBeUndefined();
  });

  it('still emits end_turn (not overloaded_error) when content is produced (direct)', async () => {
    const openAIStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const write = (event: string, data: unknown): void =>
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        write('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: 'hello',
        });
        write('response.completed', {
          type: 'response.completed',
          response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
        });
        controller.close();
      },
    });
    const anthropicStream = new ReadableStream<Uint8Array>({
      start(controller) {
        void _openAIResponsesBridgeServerTesting.streamResponsesToAnthropic({
          openAIResponse: new Response(openAIStream, {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
          controller,
          model: 'gpt-5.3-codex',
          estimatedInputTokens: 1,
        });
      },
    });

    const events = await readSSEEvents(anthropicStream);
    expect(textDeltaEvents(events).join('')).toBe('hello');
    expect(messageDeltaEvent(events)).toMatchObject({
      delta: { stop_reason: 'end_turn' },
    });
    expect(events.find((event) => event.event === 'error')).toBeUndefined();
  });

  it.skipIf(!isBun)(
    'allows high-token Codex requests through the bridge before the real 272k limit',
    async () => {
      const cumulativeTokenCounts = [50_000, 100_000, 150_000, 190_000, 231_000, 250_000];
      const capturedModels: string[] = [];
      const returnedInputTokens: number[] = [];
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models: [
          {
            id: 'gpt-5.5',
            display_name: 'GPT-5.5',
            created_at: '2026-04-01T00:00:00Z',
            context_window: 272000,
          },
          {
            id: 'gpt-5.4-mini',
            display_name: 'GPT-5.4 Mini',
            created_at: '2026-01-01T00:00:00Z',
            context_window: 128000,
          },
        ],
        modelAliases: {},
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          const inputTokens = cumulativeTokenCounts[capturedModels.length];
          capturedModels.push(body.model ?? '');
          returnedInputTokens.push(inputTokens);
          return sse([
            {
              event: 'response.output_text.delta',
              data: { type: 'response.output_text.delta', delta: 'ok' },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: { usage: { input_tokens: inputTokens, output_tokens: 1 }, output: [] },
              },
            },
          ]);
        },
      });

      const modelsResp = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(modelsResp.status).toBe(200);
      const modelsBody = (await modelsResp.json()) as {
        data: Array<{ id: string; context_window: number }>;
      };
      const contextById = new Map(modelsBody.data.map((model) => [model.id, model.context_window]));
      expect(contextById.get('gpt-5.5')).toBe(272000);
      expect(contextById.get('gpt-5.4-mini')).toBe(128000);

      const sdkWouldReject = (tokensUsed: number, modelId: string) => {
        const contextWindow = contextById.get(modelId);
        expect(contextWindow).toBeDefined();
        return tokensUsed >= contextWindow!;
      };
      const shouldCompact = (tokensUsed: number, contextWindow: number) =>
        tokensUsed >= Math.floor(contextWindow * 0.85);

      // Simulate the SDK prompt-size guard against bridge-reported context windows.
      // Codex now uses real model IDs, so the SDK sees the correct 272k/128k windows.
      expect(sdkWouldReject(180000, 'gpt-5.5')).toBe(false);
      expect(sdkWouldReject(200000, 'gpt-5.5')).toBe(false);
      expect(sdkWouldReject(230000, 'gpt-5.5')).toBe(false);
      expect(sdkWouldReject(250000, 'gpt-5.5')).toBe(false);
      expect(sdkWouldReject(272000, 'gpt-5.5')).toBe(true);

      expect(shouldCompact(231199, 272000)).toBe(false);
      expect(shouldCompact(231200, 272000)).toBe(true);
      expect(sdkWouldReject(231200, 'gpt-5.5')).toBe(false);
      expect(272000 - 231200).toBe(40800);

      expect(sdkWouldReject(120000, 'gpt-5.4-mini')).toBe(false);
      expect(sdkWouldReject(128000, 'gpt-5.4-mini')).toBe(true);
      expect(shouldCompact(108799, 128000)).toBe(false);
      expect(shouldCompact(108800, 128000)).toBe(true);

      const contextWindows: number[] = [];
      for (const tokenCount of cumulativeTokenCounts) {
        const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.5',
            max_tokens: 128,
            messages: [{ role: 'user', content: `turn at ${tokenCount} tokens` }],
          }),
        });
        expect(resp.status).toBe(200);
        const events = await readSSEEvents(resp.body);
        expect(events.find((event) => event.event === 'error')).toBeUndefined();
        const start = messageStartEvent(events)?.message as
          | { usage?: { model_context_window?: number } }
          | undefined;
        const delta = messageDeltaEvent(events) as
          | { usage?: { input_tokens?: number; model_context_window?: number } }
          | undefined;
        expect(delta?.usage?.input_tokens).toBe(tokenCount);
        contextWindows.push(start?.usage?.model_context_window ?? 0);
      }

      expect(capturedModels).toEqual(cumulativeTokenCounts.map(() => 'gpt-5.5'));
      expect(returnedInputTokens).toEqual(cumulativeTokenCounts);
      expect(contextWindows).toEqual(cumulativeTokenCounts.map(() => 272000));
    }
  );

  it.skipIf(!isBun)(
    'reports model_context_window from config models for non-Codex models',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('falls back to Codex context window for Codex models in config', async () => {
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

  it.skipIf(!isBun)(
    'includes config model in GET /v1/models response with correct context_window',
    async () => {
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
    }
  );

  it.skipIf(!isBun)(
    'advertises real Codex context windows and forwards correct model upstream',
    async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server = createOpenAIResponsesBridgeServer({
        auth: { source: 'api_key', apiKey: 'sk-test' },
        models: [
          {
            id: 'gpt-5.5',
            display_name: 'GPT-5.5',
            created_at: '2026-04-01T00:00:00Z',
            context_window: 272000,
          },
        ],
        modelAliases: {},
        fetchImpl: async (_url, init) => {
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sse([
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
          ]);
        },
      });

      const modelsResp = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      const modelsBody = (await modelsResp.json()) as {
        data: Array<{ id: string; context_window: number }>;
      };
      const contextById = new Map(modelsBody.data.map((model) => [model.id, model.context_window]));
      expect(contextById.get('gpt-5.5')).toBe(272000);

      const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      const events = await readSSEEvents(resp.body);
      const start = messageStartEvent(events);
      const startMessage = start?.message as
        | { usage?: { model_context_window?: number } }
        | undefined;
      expect(capturedBody?.model).toBe('gpt-5.5');
      expect(startMessage?.usage?.model_context_window).toBe(272000);
    }
  );

  it.skipIf(!isBun)(
    'falls back to Codex-only context window when model is NOT in config.models',
    async () => {
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
    }
  );

  it.skipIf(!isBun)(
    'propagates the original 401 when ChatGPT OAuth refresh is unavailable',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('maps thinking budget_tokens to OpenAI reasoning.effort', async () => {
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

  it.skipIf(!isBun)('maps think32k to xhigh on GPT-5.6 models that support it', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: [
        {
          id: 'gpt-5.6-sol',
          display_name: 'GPT-5.6 Sol',
          created_at: '2026-07-09T00:00:00Z',
          context_window: 1050000,
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
        model: 'gpt-5.6-sol',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        thinking: { type: 'enabled', budget_tokens: 32000 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it.skipIf(!isBun)('maps think32k to xhigh on GPT-5.6 Terra', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: [
        {
          id: 'gpt-5.6-terra',
          display_name: 'GPT-5.6 Terra',
          created_at: '2026-07-09T00:00:00Z',
          context_window: 1050000,
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
        model: 'gpt-5.6-terra',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        thinking: { type: 'enabled', budget_tokens: 32000 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it.skipIf(!isBun)(
    'omits reasoning.summary_text from include for ChatGPT OAuth endpoint',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('maps think32k to xhigh on GPT-5.6 Luna', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server = createOpenAIResponsesBridgeServer({
      auth: { source: 'api_key', apiKey: 'sk-test' },
      models: [
        {
          id: 'gpt-5.6-luna',
          display_name: 'GPT-5.6 Luna',
          created_at: '2026-07-09T00:00:00Z',
          context_window: 1050000,
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
        model: 'gpt-5.6-luna',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Think deeply.' }],
        thinking: { type: 'enabled', budget_tokens: 32000 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(capturedBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });
  it.skipIf(!isBun)('omits reasoning when thinking is off', async () => {
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

  it.skipIf(!isBun)('streams OpenAI reasoning events as Anthropic thinking SSE', async () => {
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

  it.skipIf(!isBun)('passes encrypted reasoning content through on multi-turn', async () => {
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

  it.skipIf(!isBun)('reports reasoning_tokens in message_delta usage', async () => {
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

  it.skipIf(!isBun)('clears cached reasoning when response has no reasoning items', async () => {
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

  it.skipIf(!isBun)(
    'includes encrypted reasoning in request when reusing cached reasoning without thinking config',
    async () => {
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
      expect(secondBody?.include).toEqual([
        'reasoning.encrypted_content',
        'reasoning.summary_text',
      ]);
      const secondInput = secondBody?.input as Array<Record<string, unknown>>;
      expect(
        secondInput.some(
          (item) => item.type === 'reasoning' && item.encrypted_content === 'enc_first'
        )
      ).toBe(true);
    }
  );

  it.skipIf(!isBun)(
    'includes injected reasoning items in count_tokens and message_start estimates',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('evicts stale reasoning items after the TTL', async () => {
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

  it.skipIf(!isBun)('clears reasoning item timers on server stop', async () => {
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

  it.skipIf(!isBun)('merges session thinking config when the request omits thinking', async () => {
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

  it.skipIf(!isBun)(
    'does not override request thinking when session config is also present',
    async () => {
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
    }
  );

  it.skipIf(!isBun)(
    'overrides non-enabled SDK thinking payload with session enabled config',
    async () => {
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
    }
  );

  it.skipIf(!isBun)('clears session thinking config when undefined is passed', async () => {
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
