import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  _openAIChatBridgeTesting,
  type OpenAIChatBridgeServer,
} from '../../../../src/lib/providers/openai-chat-bridge/server';
import {
  createOpenAIResponsesBridgeServer,
  _openAIResponsesBridgeServerTesting,
  type OpenAIResponsesBridgeServer,
} from '../../../../src/lib/providers/openai-responses-bridge/server';
import {
  createAnthropicMessagesBridgeServer,
  type AnthropicMessagesBridgeServer,
} from '../../../../src/lib/providers/anthropic-messages-bridge/server';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

type SseEvent = { event: string; data: Record<string, unknown> };

function parseAnthropicSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let dataRaw = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) dataRaw += line.slice('data: '.length);
    }
    if (!event || !dataRaw) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataRaw);
    } catch {
      continue;
    }
    out.push({ event, data });
  }
  return out;
}

const eventTypes = (events: SseEvent[]): string[] => events.map((e) => e.event);

function deltasOfType(events: SseEvent[], type: string): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => (e.data as { delta?: Record<string, unknown> }).delta)
    .filter((d): d is Record<string, unknown> => !!d && (d as { type?: string }).type === type);
}

function blocksOfType(events: SseEvent[], type: string): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.event === 'content_block_start')
    .map((e) => (e.data as { content_block?: Record<string, unknown> }).content_block)
    .filter((b): b is Record<string, unknown> => !!b && (b as { type?: string }).type === type);
}

function expectAnthropicStreamWellFormed(events: SseEvent[]): void {
  const open = new Set<number>();
  const seen = new Set<number>();
  let starts = 0;
  for (const e of events) {
    if (e.event === 'message_start') {
      starts++;
    } else if (e.event === 'content_block_start') {
      expect(starts).toBe(1);
      expect(open.size).toBe(0);
      const idx = (e.data as { index: number }).index;
      expect(open.has(idx)).toBe(false);
      expect(seen.has(idx)).toBe(false);
      open.add(idx);
      seen.add(idx);
    } else if (e.event === 'content_block_stop') {
      const idx = (e.data as { index: number }).index;
      expect(open.has(idx)).toBe(true);
      open.delete(idx);
    } else if (e.event === 'content_block_delta') {
      expect(open.has((e.data as { index: number }).index)).toBe(true);
    } else if (e.event === 'error' || e.event === 'message_delta' || e.event === 'message_stop') {
      expect(starts).toBe(1);
      expect(open.size).toBe(0);
    }
  }
  expect(starts).toBe(1);
  expect(open.size).toBe(0);
}

function chatSseBody(chunks: unknown[], opts: { done?: boolean } = {}): string {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return opts.done === false ? body : `${body}data: [DONE]\n\n`;
}

type RespEvent = { type: string } & Record<string, unknown>;
function responsesSse(events: RespEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function makeUpstreamStream(parts: string | string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const arr = Array.isArray(parts) ? parts : [parts];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of arr) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
}

async function replayChat(
  upstream: string | string[],
  opts: { model?: string; inputTokens?: number; modelContextWindow?: number } = {}
): Promise<string> {
  const upstreamResponse = new Response(makeUpstreamStream(upstream), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const outputStream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  await _openAIChatBridgeTesting.streamChatToAnthropic({
    upstreamResponse,
    controller,
    model: opts.model ?? 'test-model',
    inputTokens: opts.inputTokens ?? 10,
    modelContextWindow: opts.modelContextWindow,
  });
  return await new Response(outputStream).text();
}

async function replayResponses(
  upstream: string | string[],
  opts: {
    model?: string;
    estimatedInputTokens?: number;
    modelContextWindow?: number;
    onReasoningItems?: (items: unknown[]) => void;
  } = {}
): Promise<string> {
  const openAIResponse = new Response(makeUpstreamStream(upstream), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const outputStream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  await _openAIResponsesBridgeServerTesting.streamResponsesToAnthropic({
    openAIResponse,
    controller,
    model: opts.model ?? 'gpt-5.3-codex',
    estimatedInputTokens: opts.estimatedInputTokens ?? 10,
    modelContextWindow: opts.modelContextWindow,
    onReasoningItems: opts.onReasoningItems as never,
  });
  return await new Response(outputStream).text();
}

const servers: Array<
  OpenAIChatBridgeServer | OpenAIResponsesBridgeServer | AnthropicMessagesBridgeServer
> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

const MINIMAL_CODEX_SSE = responsesSse([
  { type: 'response.output_text.delta', delta: 'ok' },
  { type: 'response.completed', response: { id: 'resp_test', usage: {} } },
]);

describe('provider-bridge conformance replay — OpenAI Chat Completions bridge', () => {
  describe('SSE text deltas → ordered UI-visible message', () => {
    it('emits the canonical Anthropic event sequence for a text turn', async () => {
      const out = await replayChat(
        chatSseBody([
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
          { choices: [{ index: 0, delta: { content: ' world' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]),
        { inputTokens: 42, modelContextWindow: 200000 }
      );
      const events = parseAnthropicSse(out);
      expect(eventTypes(events)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);

      const start = events[0].data as {
        message: { model: string; usage: Record<string, unknown> };
      };
      expect(start.message.model).toBe('test-model');
      expect(start.message.usage.input_tokens).toBe(42);
      expect(start.message.usage.model_context_window).toBe(200000);

      const textDeltas = deltasOfType(events, 'text_delta').map((d) => d.text);
      expect(textDeltas).toEqual(['Hello', ' world']);

      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe('end_turn');
    });
  });

  describe('reasoning_content → thinking block', () => {
    it('maps delta.reasoning_content (DeepSeek/Qwen-style) to a thinking block emitted before text', async () => {
      const out = await replayChat(
        chatSseBody([
          { choices: [{ index: 0, delta: { reasoning_content: 'Hmm' } }] },
          { choices: [{ index: 0, delta: { reasoning_content: ' let me think' } }] },
          { choices: [{ index: 0, delta: { content: 'Answer' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ])
      );
      const events = parseAnthropicSse(out);

      const starts = events.filter((e) => e.event === 'content_block_start');
      expect(starts).toHaveLength(2);
      expect((starts[0].data as { index: number }).index).toBe(0);
      expect((starts[0].data as { content_block: { type: string } }).content_block.type).toBe(
        'thinking'
      );
      expect((starts[1].data as { index: number }).index).toBe(1);
      expect((starts[1].data as { content_block: { type: string } }).content_block.type).toBe(
        'text'
      );

      const thinkingBlock = blocksOfType(events, 'thinking')[0];
      expect(thinkingBlock).toEqual({ type: 'thinking', thinking: '' });

      const thinkingDeltas = deltasOfType(events, 'thinking_delta').map((d) => d.thinking);
      expect(thinkingDeltas).toEqual(['Hmm', ' let me think']);
      const firstThinking = events.findIndex(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data as { delta: { type: string } }).delta.type === 'thinking_delta'
      );
      const firstText = events.findIndex(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data as { delta: { type: string } }).delta.type === 'text_delta'
      );
      expect(firstThinking).toBeLessThan(firstText);
      expect(firstThinking).toBeGreaterThanOrEqual(0);

      expectAnthropicStreamWellFormed(events);
      const thinkingStopPos = events.findIndex(
        (e) => e.event === 'content_block_stop' && (e.data as { index: number }).index === 0
      );
      const textStartPos = events.findIndex(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block: { type: string } }).content_block.type === 'text'
      );
      expect(thinkingStopPos).toBeGreaterThanOrEqual(0);
      expect(thinkingStopPos).toBeLessThan(textStartPos);

      expect(out).not.toContain('signature');
      expect(out).not.toContain('redacted_thinking');
    });

    it('does NOT translate delta.reasoning (only reasoning_content is recognized)', async () => {
      const out = await replayChat(
        chatSseBody([{ choices: [{ index: 0, delta: { reasoning: 'ignored' } }] }])
      );
      const events = parseAnthropicSse(out);
      expect(blocksOfType(events, 'thinking')).toHaveLength(0);
      expect(deltasOfType(events, 'thinking_delta')).toHaveLength(0);
      expect(eventTypes(events)).toEqual(['message_start', 'message_delta', 'message_stop']);
    });
  });

  describe('streaming tool_calls → tool_use block', () => {
    it('accumulates argument fragments and emits exactly one input_json_delta at flush', async () => {
      const out = await replayChat(
        chatSseBody([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
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
                  tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"a"}' } }],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ])
      );
      const events = parseAnthropicSse(out);

      const toolBlocks = blocksOfType(events, 'tool_use');
      expect(toolBlocks).toEqual([{ type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }]);

      const jsonDeltas = deltasOfType(events, 'input_json_delta');
      expect(jsonDeltas).toHaveLength(1);
      expect(jsonDeltas[0].partial_json).toBe('{"q":"a"}');

      expectAnthropicStreamWellFormed(events);
      const toolStart = events.find(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block: { type: string } }).content_block.type === 'tool_use'
      )!.data as { index: number };
      const toolStopPos = events.findIndex(
        (e) =>
          e.event === 'content_block_stop' &&
          (e.data as { index: number }).index === toolStart.index
      );
      const msgDeltaPos = events.findIndex((e) => e.event === 'message_delta');
      expect(toolStopPos).toBeGreaterThanOrEqual(0);
      expect(toolStopPos).toBeLessThan(msgDeltaPos);

      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe('tool_use');
    });

    it('closes a preceding text block before opening a tool_use block (text then tool)', async () => {
      const out = await replayChat(
        chatSseBody([
          { choices: [{ index: 0, delta: { content: 'Let me search: ' } }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'search', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ])
      );
      const events = parseAnthropicSse(out);
      expectAnthropicStreamWellFormed(events);
      const starts = events.filter((e) => e.event === 'content_block_start');
      expect(starts).toHaveLength(2);
      expect((starts[0].data as { content_block: { type: string } }).content_block.type).toBe(
        'text'
      );
      expect((starts[1].data as { content_block: { type: string } }).content_block.type).toBe(
        'tool_use'
      );
      const textStopPos = events.findIndex(
        (e) => e.event === 'content_block_stop' && (e.data as { index: number }).index === 0
      );
      const toolStartPos = events.findIndex(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block: { type: string } }).content_block.type === 'tool_use'
      );
      expect(textStopPos).toBeGreaterThanOrEqual(0);
      expect(textStopPos).toBeLessThan(toolStartPos);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe('tool_use');
    });

    it('emits parallel tool_calls as sequential (non-overlapping) blocks', async () => {
      const out = await replayChat(
        chatSseBody([
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
        ])
      );
      const events = parseAnthropicSse(out);
      expectAnthropicStreamWellFormed(events);
      const toolBlocks = blocksOfType(events, 'tool_use');
      expect(toolBlocks).toHaveLength(2);
      expect(toolBlocks.map((b) => b.name).sort()).toEqual(['one', 'two']);
      expect(toolBlocks.map((b) => b.id).sort()).toEqual(['call_a', 'call_b']);
      const jsonDeltas = deltasOfType(events, 'input_json_delta');
      expect(jsonDeltas).toHaveLength(2);
      expect(jsonDeltas.map((d) => d.partial_json).sort()).toEqual(['{"x":1}', '{"y":2}']);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe('tool_use');
    });
  });

  describe('stop_reason mapping (finish_reason → stop_reason)', () => {
    for (const [finish, expected, label] of [
      ['stop', 'end_turn', 'stop → end_turn'],
      ['length', 'max_tokens', 'length → max_tokens'],
      ['content_filter', 'end_turn', 'content_filter falls through to end_turn'],
      [null, 'end_turn', 'absent finish_reason → end_turn'],
    ] as Array<[string | null, string, string]>) {
      it(`maps ${label}`, async () => {
        const chunks: unknown[] = [{ choices: [{ index: 0, delta: { content: 'x' } }] }];
        if (finish !== null)
          chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        const out = await replayChat(chatSseBody(chunks));
        const events = parseAnthropicSse(out);
        const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
          delta: { stop_reason: string };
        };
        expect(msgDelta.delta.stop_reason).toBe(expected);
      });
    }
  });

  describe('malformed / partial chunk resilience', () => {
    it('silently skips a malformed-JSON data frame and preserves surrounding deltas', async () => {
      const body =
        chatSseBody([{ choices: [{ index: 0, delta: { content: 'before' } }] }], { done: false }) +
        'data: {this is not json\n\n' +
        chatSseBody([{ choices: [{ index: 0, delta: { content: 'after' } }] }]);
      const out = await replayChat(body);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['before', 'after']);
      expect(events.some((e) => e.event === 'error')).toBe(false);
      expect(eventTypes(events).at(-1)).toBe('message_stop');
    });

    it('harvests usage (prompt + completion) from a choices-less chunk without emitting a delta', async () => {
      const out = await replayChat(
        chatSseBody([
          { choices: [], usage: { prompt_tokens: 99, completion_tokens: 7 } },
          { choices: [{ index: 0, delta: { content: 'hi' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]),
        { inputTokens: 10 }
      );
      const events = parseAnthropicSse(out);
      expect(blocksOfType(events, 'text')).toHaveLength(1);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(msgDelta.usage.input_tokens).toBe(99);
      expect(msgDelta.usage.output_tokens).toBe(7);
    });

    it('treats empty delta {} and delta:null as no-ops (only finish_reason is captured)', async () => {
      const out = await replayChat(
        chatSseBody([
          { choices: [{ index: 0, delta: {} }] },
          { choices: [{ index: 0, delta: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ])
      );
      const events = parseAnthropicSse(out);
      expect(eventTypes(events)).toEqual(['message_start', 'message_delta', 'message_stop']);
    });

    it('ignores [DONE] and `:` keep-alive comment frames without erroring', async () => {
      const body =
        ': keep-alive\n\n' + chatSseBody([{ choices: [{ index: 0, delta: { content: 'ok' } }] }]);
      const out = await replayChat(body);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['ok']);
      expect(events.some((e) => e.event === 'error')).toBe(false);
    });

    it('reassembles a single SSE frame split across two network reads', async () => {
      const full =
        'data: ' +
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'streamed' } }] }) +
        '\n\n' +
        'data: ' +
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        '\n\n';
      const splitAt = full.indexOf('streamed') + 4;
      const out = await replayChat([
        full.slice(0, splitAt),
        full.slice(splitAt) + 'data: [DONE]\n\n',
      ]);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['streamed']);
    });

    it('parses a final frame with no trailing blank-line terminator (flush path)', async () => {
      const body =
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'tail' } }] });
      const out = await replayChat(body);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['tail']);
    });

    it('fails fast with an error event when a 200 carries no SSE data frames', async () => {
      const out = await replayChat(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
      const events = parseAnthropicSse(out);
      expect(events.some((e) => e.event === 'error')).toBe(true);
      const err = events.find((e) => e.event === 'error')!.data as {
        error: { message: string };
      };
      expect(err.error.message).toContain('non-SSE');
      expect(events.some((e) => e.event === 'message_delta')).toBe(false);
      expect(eventTypes(events).at(-1)).toBe('message_stop');
    });

    it('closes an open text block before a mid-stream upstream error', async () => {
      const body =
        'data: ' +
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] }) +
        '\n\n' +
        'data: ' +
        JSON.stringify({ error: { message: 'boom', type: 'rate_limit_exceeded' } }) +
        '\n\n' +
        'data: [DONE]\n\n';
      const out = await replayChat(body);
      const events = parseAnthropicSse(out);
      expect(events.some((e) => e.event === 'error')).toBe(true);
      expect(events.some((e) => e.event === 'message_delta')).toBe(false);
      expectAnthropicStreamWellFormed(events);
      const textStopPos = events.findIndex(
        (e) => e.event === 'content_block_stop' && (e.data as { index: number }).index === 0
      );
      const errorPos = events.findIndex((e) => e.event === 'error');
      expect(textStopPos).toBeGreaterThanOrEqual(0);
      expect(textStopPos).toBeLessThan(errorPos);
    });

    it('drops an incomplete tool_call on a mid-stream error (no partial args)', async () => {
      const body =
        'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search', arguments: '{"q":"' },
                  },
                ],
              },
            },
          ],
        }) +
        '\n\n' +
        'data: ' +
        JSON.stringify({ error: { message: 'boom', type: 'rate_limit_exceeded' } }) +
        '\n\n' +
        'data: [DONE]\n\n';
      const out = await replayChat(body);
      const events = parseAnthropicSse(out);
      expect(events.some((e) => e.event === 'error')).toBe(true);
      expect(events.some((e) => e.event === 'message_delta')).toBe(false);
      expect(blocksOfType(events, 'tool_use')).toHaveLength(0);
      expect(deltasOfType(events, 'input_json_delta')).toHaveLength(0);
      expectAnthropicStreamWellFormed(events);
    });
  });

  describe('usage fallback heuristic', () => {
    it('estimates output_tokens as ceil(total_len/4), accumulating across deltas', async () => {
      const chars = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((c) => ({
        choices: [{ index: 0, delta: { content: c } }],
      }));
      const out = await replayChat(
        chatSseBody([...chars, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
      );
      const events = parseAnthropicSse(out);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        usage: { output_tokens: number };
      };
      expect(msgDelta.usage.output_tokens).toBe(2);
    });

    it('floors output_tokens at 1 for an empty turn', async () => {
      const out = await replayChat(chatSseBody([{ choices: [{ index: 0, delta: {} }] }]));
      const events = parseAnthropicSse(out);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        usage: { output_tokens: number };
      };
      expect(msgDelta.usage.output_tokens).toBe(1);
    });
  });

  describe('request translation (Anthropic → OpenAI Chat)', () => {
    it('maps thinking budgets to reasoning_effort only when thinkingSupported=true', () => {
      const body = {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' as const, budget_tokens: 8000 },
      };
      const withThinking = _openAIChatBridgeTesting.buildChatRequest(body, 'm', true, false, true);
      expect(withThinking.reasoning_effort).toBe('medium');

      const withoutFlag = _openAIChatBridgeTesting.buildChatRequest(body, 'm', true, false, false);
      expect(withoutFlag.reasoning_effort).toBeUndefined();
    });

    it('drops tools/tool_choice when toolUseSupported=false, forwards reasoning_effort', () => {
      const body = {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 't', description: '', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto' as const },
        thinking: { type: 'enabled' as const, budget_tokens: 8000 },
      };
      const req = _openAIChatBridgeTesting.buildChatRequest(body, 'm', false, false, true);
      expect(req.tools).toBeUndefined();
      expect(req.tool_choice).toBeUndefined();
      expect(req.reasoning_effort).toBe('medium');
    });

    it('omits stream_options unless streamUsageSupported=true', () => {
      const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
      const off = _openAIChatBridgeTesting.buildChatRequest(body, 'm', true, false, false, false);
      expect(off.stream_options).toBeUndefined();
      const on = _openAIChatBridgeTesting.buildChatRequest(body, 'm', true, false, false, true);
      expect(on.stream_options).toEqual({ include_usage: true });
    });
  });
});

describe('provider-bridge conformance replay — OpenAI Responses (Codex) bridge', () => {
  describe('text deltas → ordered UI-visible message', () => {
    it('emits the canonical Anthropic event sequence with normalized usage', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.output_text.delta', delta: 'Hello' },
          { type: 'response.output_text.delta', delta: ' world' },
          {
            type: 'response.completed',
            response: { id: 'resp_1', usage: { input_tokens: 5, output_tokens: 7 } },
          },
        ]),
        { estimatedInputTokens: 10, modelContextWindow: 272000 }
      );
      const events = parseAnthropicSse(out);
      expect(eventTypes(events)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['Hello', ' world']);

      const start = events[0].data as { message: { usage: { model_context_window: number } } };
      expect(start.message.usage.model_context_window).toBe(272000);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(msgDelta.delta.stop_reason).toBe('end_turn');
      expect(msgDelta.usage.input_tokens).toBe(5);
      expect(msgDelta.usage.output_tokens).toBe(7);
    });

    it('surfaces a retryable overloaded_error for an empty stream (just [DONE])', async () => {
      const out = await replayResponses('data: [DONE]\n\n');
      const events = parseAnthropicSse(out);
      expect(eventTypes(events)).toEqual(['message_start', 'error', 'message_stop']);
      const err = events.find((e) => e.event === 'error')!.data as {
        error: { type: string };
      };
      expect(err.error.type).toBe('overloaded_error');
    });
  });

  describe('reasoning events → thinking blocks', () => {
    it('maps reasoning_summary_part + reasoning_summary_text to a thinking block before text', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.reasoning_summary_part.added' },
          { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
          { type: 'response.reasoning_summary_text.done' },
          { type: 'response.output_text.delta', delta: 'Answer' },
          { type: 'response.completed', response: { id: 'r', usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);

      const starts = events.filter((e) => e.event === 'content_block_start');
      expect(starts).toHaveLength(2);
      expect(
        (starts[0].data as { content_block: { type: string }; index: number }).content_block.type
      ).toBe('thinking');
      expect((starts[0].data as { index: number }).index).toBe(0);
      expect(
        (starts[1].data as { content_block: { type: string }; index: number }).content_block.type
      ).toBe('text');
      expect((starts[1].data as { index: number }).index).toBe(1);

      expect(deltasOfType(events, 'thinking_delta').map((d) => d.thinking)).toEqual(['Thinking']);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['Answer']);

      expectAnthropicStreamWellFormed(events);
      const thinkingStopPos = events.findIndex(
        (e) => e.event === 'content_block_stop' && (e.data as { index: number }).index === 0
      );
      const textStartPos = events.findIndex(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block: { type: string } }).content_block.type === 'text'
      );
      expect(thinkingStopPos).toBeGreaterThanOrEqual(0);
      expect(thinkingStopPos).toBeLessThan(textStartPos);

      expect(out).not.toContain('signature');
      expect(out).not.toContain('redacted_thinking');
    });

    it('also maps the non-summary reasoning_text.delta / reasoning_text.done variants', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.reasoning_text.delta', delta: 'plain reasoning' },
          { type: 'response.reasoning_text.done' },
          { type: 'response.completed', response: { id: 'r', usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'thinking_delta').map((d) => d.thinking)).toEqual([
        'plain reasoning',
      ]);
    });

    it('does not open a thinking block when summary_part.added has no delta', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.reasoning_summary_part.added' },
          { type: 'response.reasoning_summary_part.done' },
          { type: 'response.completed', response: { id: 'r', usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);
      expect(blocksOfType(events, 'thinking')).toHaveLength(0);
      expect(deltasOfType(events, 'thinking_delta')).toHaveLength(0);
      expect(eventTypes(events)).toEqual(['message_start', 'error', 'message_stop']);
      const err = events.find((e) => e.event === 'error')!.data as {
        error: { type: string };
      };
      expect(err.error.type).toBe('overloaded_error');
    });
  });

  describe('function_call → tool_use', () => {
    it('emits a tool_use block with a single input_json_delta from arguments.done', async () => {
      const out = await replayResponses(
        responsesSse([
          {
            type: 'response.function_call_arguments.done',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{"q":"a"}',
          },
          { type: 'response.completed', response: { id: 'r', usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);
      expect(blocksOfType(events, 'tool_use')).toEqual([
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
      ]);
      expect(deltasOfType(events, 'input_json_delta')).toHaveLength(1);
      expect(deltasOfType(events, 'input_json_delta')[0].partial_json).toBe('{"q":"a"}');
      expectAnthropicStreamWellFormed(events);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe('tool_use');
    });

    it('dedupes a function_call seen in arguments.done and again in response.completed', async () => {
      const out = await replayResponses(
        responsesSse([
          {
            type: 'response.function_call_arguments.done',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{}',
          },
          {
            type: 'response.completed',
            response: {
              id: 'r',
              output: [
                { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
              ],
              usage: {},
            },
          },
        ])
      );
      const events = parseAnthropicSse(out);
      expect(blocksOfType(events, 'tool_use')).toHaveLength(1);
      expect(deltasOfType(events, 'input_json_delta')).toHaveLength(1);
      expectAnthropicStreamWellFormed(events);
    });

    it('assigns monotonically increasing block indices across multiple tool calls', async () => {
      const out = await replayResponses(
        responsesSse([
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'call_a', name: 'one', arguments: '{}' },
          },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'call_b', name: 'two', arguments: '{}' },
          },
          { type: 'response.completed', response: { id: 'r', usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);
      const toolStarts = events.filter(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block: { type: string } }).content_block.type === 'tool_use'
      );
      expect(toolStarts).toHaveLength(2);
      expect((toolStarts[0].data as { index: number }).index).toBe(0);
      expect((toolStarts[1].data as { index: number }).index).toBe(1);
      expectAnthropicStreamWellFormed(events);
    });
  });

  describe('stop_reason mapping', () => {
    it('maps response.incomplete to max_tokens', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.output_text.delta', delta: 'partial' },
          { type: 'response.incomplete', response: { usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);
      expectAnthropicStreamWellFormed(events);
      const textStopPos = events.findIndex(
        (e) => e.event === 'content_block_stop' && (e.data as { index: number }).index === 0
      );
      const msgDeltaPos = events.findIndex((e) => e.event === 'message_delta');
      expect(textStopPos).toBeGreaterThanOrEqual(0);
      expect(textStopPos).toBeLessThan(msgDeltaPos);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe('max_tokens');
    });
  });

  describe('usage normalization & reasoning tokens', () => {
    it('reads reasoning_tokens from output_tokens_details and aliases prompt/completion_tokens', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.output_text.delta', delta: 'ok' },
          {
            type: 'response.completed',
            response: {
              id: 'r',
              usage: {
                prompt_tokens: 13,
                completion_tokens: 9,
                output_tokens_details: { reasoning_tokens: 4 },
              },
            },
          },
        ])
      );
      const events = parseAnthropicSse(out);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        usage: { input_tokens: number; output_tokens: number; thinking_tokens: number };
      };
      expect(msgDelta.usage.input_tokens).toBe(13);
      expect(msgDelta.usage.output_tokens).toBe(9);
      expect(msgDelta.usage.thinking_tokens).toBe(4);
    });

    it('estimates output_tokens per-delta (max(1, ceil(len/4)) each) when usage is absent', async () => {
      const deltas = ['a', 'b', 'c', 'd', 'e'].map((d) => ({
        type: 'response.output_text.delta',
        delta: d,
      }));
      const out = await replayResponses(
        responsesSse([...deltas, { type: 'response.completed', response: { id: 'r', usage: {} } }])
      );
      const events = parseAnthropicSse(out);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        usage: { output_tokens: number };
      };
      expect(msgDelta.usage.output_tokens).toBe(5);
    });
  });

  describe('encrypted reasoning round-trip', () => {
    it('propagates reasoning.encrypted_content from response.completed via onReasoningItems', async () => {
      let captured: unknown[] = [];
      await replayResponses(
        responsesSse([
          { type: 'response.output_text.delta', delta: 'answer' },
          {
            type: 'response.completed',
            response: {
              id: 'r',
              output: [{ type: 'reasoning', encrypted_content: 'ENC_SECRET_123' }],
              usage: {},
            },
          },
        ]),
        { onReasoningItems: (items) => void (captured = items) }
      );
      expect(captured).toEqual([{ type: 'reasoning', encrypted_content: 'ENC_SECRET_123' }]);
    });
  });

  describe('malformed / partial chunk resilience', () => {
    it('silently drops unknown event types and preserves surrounding deltas', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.output_item.added', item: { type: 'message' } },
          { type: 'response.output_text.delta', delta: 'kept' },
          { type: 'response.completed', response: { id: 'r', usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['kept']);
      expect(events.some((e) => e.event === 'error')).toBe(false);
    });

    it('skips a malformed-JSON data frame and a `:` keep-alive comment', async () => {
      const body =
        ': ping\n\n' +
        'event: response.output_text.delta\n' +
        'data: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }) +
        '\n\n' +
        'event: response.completed\n' +
        'data: {bad json\n\n' +
        'data: [DONE]\n\n';
      const out = await replayResponses(body);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['ok']);
      expect(events.some((e) => e.event === 'error')).toBe(false);
    });

    it('parses a final frame with no trailing blank-line terminator (flush path)', async () => {
      const body =
        'event: response.output_text.delta\ndata: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: 'tail' });
      const out = await replayResponses(body);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['tail']);
    });

    it('reassembles a single SSE frame split across two network reads', async () => {
      const full = responsesSse([
        { type: 'response.output_text.delta', delta: 'streamed' },
        { type: 'response.completed', response: { id: 'r', usage: {} } },
      ]);
      const splitAt = full.indexOf('streamed') + 4;
      const out = await replayResponses([full.slice(0, splitAt), full.slice(splitAt)]);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['streamed']);
    });
  });

  describe('mid-stream error frames', () => {
    it('surfaces a response.failed frame as an error event with no message_delta', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.output_text.delta', delta: 'partial' },
          { type: 'response.failed', response: { error: { message: 'boom' } } },
        ])
      );
      const events = parseAnthropicSse(out);
      expect(events.some((e) => e.event === 'error')).toBe(true);
      const err = events.find((e) => e.event === 'error')!.data as {
        error: { message: string };
      };
      expect(err.error.message).toContain('boom');
      expectAnthropicStreamWellFormed(events);
      const textStopPos = events.findIndex(
        (e) => e.event === 'content_block_stop' && (e.data as { index: number }).index === 0
      );
      const errorPos = events.findIndex((e) => e.event === 'error');
      expect(textStopPos).toBeGreaterThanOrEqual(0);
      expect(textStopPos).toBeLessThan(errorPos);
      expect(events.some((e) => e.event === 'message_delta')).toBe(false);
      expect(eventTypes(events).at(-1)).toBe('message_stop');
    });

    it('classifies a transient mid-stream error (rate limit) to rate_limit_error', async () => {
      const out = await replayResponses(
        responsesSse([{ type: 'error', code: '429', message: 'Too Many Requests' }])
      );
      const events = parseAnthropicSse(out);
      const err = events.find((e) => e.event === 'error')!.data as {
        error: { type: string };
      };
      expect(err.error.type).toBe('rate_limit_error');
    });
  });
});

describe.skipIf(!isBun)(
  'provider-bridge conformance replay — Codex OAuth-gated request variants',
  () => {
    const CODEX_MODEL = {
      id: 'gpt-5.3-codex',
      display_name: 'Codex',
      created_at: '',
      context_window: 272000,
    };

    type CapturedRequest = {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
      calls: number;
    };

    async function captureUpstreamRequest(
      auth: Record<string, unknown>,
      body: Record<string, unknown>
    ): Promise<CapturedRequest> {
      const captured: CapturedRequest = { url: '', headers: {}, body: {}, calls: 0 };
      const fetchImpl = async (url: string, init?: RequestInit) => {
        captured.calls++;
        captured.url = String(url);
        captured.headers = (init?.headers as Record<string, string>) ?? {};
        captured.body = JSON.parse(String(init?.body));
        return new Response(MINIMAL_CODEX_SSE, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };
      const server = createOpenAIResponsesBridgeServer({
        auth: auth as never,
        models: [CODEX_MODEL],
        fetchImpl: fetchImpl as typeof fetch,
      });
      servers.push(server);
      const res = await fetch(`http://127.0.0.1:${server.port}/_hyperneo/session/s1/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream: true, max_tokens: 1024, ...body }),
      });
      await res.text();
      return captured;
    }

    const thinkingBody = (budget: number) => ({
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: budget },
    });

    it('api_key auth: routes to api.openai.com, Bearer auth, and admits reasoning.summary_text', async () => {
      const caps = await captureUpstreamRequest(
        { apiKey: 'sk-test', source: 'api_key' },
        thinkingBody(16000)
      );
      expect(caps.url).toBe('https://api.openai.com/v1/responses');
      expect(caps.headers.Authorization).toBe('Bearer sk-test');
      expect(caps.headers['ChatGPT-Account-ID']).toBeUndefined();
      expect(caps.body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
      expect(caps.body.include).toContain('reasoning.encrypted_content');
      expect(caps.body.include).toContain('reasoning.summary_text');
      expect(caps.body.max_output_tokens).toBe(1024);
      expect(caps.body.parallel_tool_calls).toBe(false);
      expect(caps.calls).toBe(1);
    });

    it('chatgpt_oauth: routes to the Codex backend, sends ChatGPT-Account-ID, drops summary_text', async () => {
      const caps = await captureUpstreamRequest(
        { apiKey: 'tok', source: 'chatgpt_oauth', accountId: 'acct-1' },
        thinkingBody(16000)
      );
      expect(caps.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(caps.headers.Authorization).toBe('Bearer tok');
      expect(caps.headers['ChatGPT-Account-ID']).toBe('acct-1');
      expect(caps.body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
      expect(caps.body.include).toContain('reasoning.encrypted_content');
      expect(caps.body.include).not.toContain('reasoning.summary_text');
      expect(caps.body.max_output_tokens).toBeUndefined();
      expect(caps.body.parallel_tool_calls).toBeUndefined();
      expect(caps.headers['X-OpenAI-Fedramp']).toBeUndefined();
      expect(caps.calls).toBe(1);
    });

    it('chatgpt_oauth FedRAMP account adds the X-OpenAI-Fedramp header', async () => {
      const caps = await captureUpstreamRequest(
        { apiKey: 'tok', source: 'chatgpt_oauth', accountId: 'acct-1', isFedrampAccount: true },
        thinkingBody(8000)
      );
      expect(caps.headers['X-OpenAI-Fedramp']).toBe('true');
      expect(caps.calls).toBe(1);
    });

    it('omits the include array entirely when thinking is disabled', async () => {
      const caps = await captureUpstreamRequest(
        { apiKey: 'sk-test', source: 'api_key' },
        {
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'disabled' },
        }
      );
      expect(caps.body.include).toBeUndefined();
      expect(caps.body.reasoning).toBeUndefined();
      expect(caps.calls).toBe(1);
    });

    describe('reasoning.effort bands (budget_tokens → effort)', () => {
      for (const [budget, expected, model] of [
        [4000, 'low', 'gpt-5.3-codex'],
        [12000, 'medium', 'gpt-5.3-codex'],
        [20000, 'high', 'gpt-5.3-codex'],
        [24000, 'high', 'gpt-5.3-codex'],
        [32000, 'xhigh', 'gpt-5.3-codex'],
        [32000, 'high', 'gpt-4o'],
      ] as Array<[number, string, string]>) {
        it(`budget_tokens=${budget} on ${model} → effort=${expected}`, async () => {
          const caps = await captureUpstreamRequest(
            { apiKey: 'sk-test', source: 'api_key' },
            {
              model,
              messages: [{ role: 'user', content: 'hi' }],
              thinking: { type: 'enabled', budget_tokens: budget },
            }
          );
          expect((caps.body.reasoning as { effort: string }).effort).toBe(expected);
          expect(caps.calls).toBe(1);
        });
      }
    });

    it('refreshes the OAuth token and retries the upstream on a 401', async () => {
      let calls = 0;
      const captured: CapturedRequest = { url: '', headers: {}, body: {} };
      const refreshAuthTokens = mock(async () => {
        return { accessToken: 'tok-refreshed', accountId: 'acct-2' };
      });
      const fetchImpl = async (url: string, init?: RequestInit) => {
        calls++;
        if (calls === 1) return new Response('unauthorized', { status: 401 });
        captured.url = String(url);
        captured.headers = (init?.headers as Record<string, string>) ?? {};
        captured.body = JSON.parse(String(init?.body));
        return new Response(MINIMAL_CODEX_SSE, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };
      const server = createOpenAIResponsesBridgeServer({
        auth: {
          apiKey: 'tok-old',
          source: 'chatgpt_oauth',
          accountId: 'acct-1',
          refreshAuthTokens: refreshAuthTokens as never,
        },
        models: [CODEX_MODEL],
        fetchImpl: fetchImpl as typeof fetch,
      });
      servers.push(server);

      const res = await fetch(`http://127.0.0.1:${server.port}/_hyperneo/session/s1/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      await res.text();

      expect(calls).toBe(2);
      expect(refreshAuthTokens).toHaveBeenCalledTimes(1);
      expect(captured.headers.Authorization).toBe('Bearer tok-refreshed');
      expect(captured.headers['ChatGPT-Account-ID']).toBe('acct-2');
    });
  }
);

describe.skipIf(!isBun)(
  'provider-bridge conformance replay — Anthropic-Messages pass-through bridge',
  () => {
    it('forwards upstream Anthropic SSE bytes verbatim', async () => {
      const upstreamSse =
        'event: message_start\n' +
        'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
        'event: content_block_delta\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'event: message_stop\n' +
        'data: {"type":"message_stop"}\n\n';
      const fetchImpl = async () =>
        new Response(upstreamSse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://upstream.test',
        apiKey: 'k',
        fetchImpl: fetchImpl as typeof fetch,
      });
      servers.push(server);

      const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      const text = await res.text();
      expect(text).toBe(upstreamSse);
    });

    it('forwards every anthropic-* request header to the upstream', async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchImpl = async (_url: string, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://upstream.test',
        apiKey: 'k',
        fetchImpl: fetchImpl as typeof fetch,
      });
      servers.push(server);

      await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'interleaved-thinking-2025-05-14',
          'anthropic-version': '2024-10-22',
          'anthropic-dangerous-direct-access': 'true',
        },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(capturedHeaders['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
      expect(capturedHeaders['anthropic-version']).toBe('2024-10-22');
      expect(capturedHeaders['anthropic-dangerous-direct-access']).toBe('true');
      expect(capturedHeaders.Authorization).toBe('Bearer k');
      expect(capturedHeaders['x-api-key']).toBe('k');
    });

    it('normalizes a 200-with-JSON rate-limit body to a retryable 429', async () => {
      const fetchImpl = async () =>
        new Response(
          JSON.stringify({
            error: { type: 'rate_limit_exceeded', message: 'Too many requests' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://upstream.test',
        fetchImpl: fetchImpl as typeof fetch,
      });
      servers.push(server);

      const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('x-should-retry')).toBe('true');
      const body = (await res.json()) as { type: string; error: { type: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('rate_limit_error');
    });

    it('routes count_tokens to /v1/messages/count_tokens exactly once', async () => {
      let calls = 0;
      let capturedUrl = '';
      const fetchImpl = async (url: string) => {
        calls++;
        capturedUrl = url;
        return new Response(JSON.stringify({ input_tokens: 5 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const server = createAnthropicMessagesBridgeServer({
        baseUrl: 'https://upstream.test/v1/messages',
        fetchImpl: fetchImpl as typeof fetch,
      });
      servers.push(server);

      await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(capturedUrl).toBe('https://upstream.test/v1/messages/count_tokens');
      expect(calls).toBe(1);
    });
  }
);
