/**
 * Provider bridge CONFORMANCE REPLAY suite (Task #756).
 *
 * Several high-priority fixes addressed "bridge drift" — upstream provider
 * semantics (SSE deltas, reasoning_content, thinking blocks, OAuth-gated
 * request shapes) being lost or distorted before reaching the UI. The per-
 * bridge unit tests pin individual branches with coarse substring assertions;
 * this suite consolidates synthetic provider payloads into a single REPLAY
 * and asserts the two things those tests do NOT:
 *
 *  1. RESPONSE-SIDE SEMANTICS — every provider chunk shape funnels through the
 *     ONE canonical stream transform (`streamChatToAnthropic` /
 *     `streamResponsesToAnthropic`) and produces the exact ordered Anthropic
 *     event sequence + block structure the SDK/UI consumes. Covers SSE deltas,
 *     reasoning_content → thinking, reasoning events → thinking blocks, tool
 *     calls, the stop_reason matrix, usage normalization, and malformed/partial
 *     chunk resilience.
 *
 *  2. REQUEST-SIDE / OAUTH-GATED VARIANTS — the same Anthropic request, replayed
 *     through the bridge server under each auth variant (api_key vs
 *     chatgpt_oauth), produces the contract-correct upstream request: base URL
 *     routing, ChatGPT-Account-ID / Fedramp headers, the `include` array
 *     (summary_text admitted for the standard API, dropped for the ChatGPT
 *     Codex backend), reasoning.effort bands, and refresh-on-401.
 *
 * Bridges under test: OpenAI Chat Completions (custom-endpoint default +
 * OpenAI/OpenRouter/GLM-compatible), OpenAI Responses (Codex backend), and the
 * Anthropic-Messages pass-through (custom-endpoint anthropic-messages type).
 *
 * The replay drives the stream transforms directly with synthetic upstream
 * `Response` bodies — no `Bun.serve`, no real network, no real model behaviour
 * — so it is fully deterministic. The OAuth-gated and pass-through sections go
 * through the real bridge server with a mocked upstream `fetch` (the only layer
 * where auth routing lives).
 */

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

// ---------------------------------------------------------------------------
// OUTPUT parser — there is no shared Anthropic-SSE parser in the daemon, so we
// split the bridge output back into structured events to assert exact shapes.
// Every emitted frame has the form `event: NAME\ndata: {json}\n\n`.
// ---------------------------------------------------------------------------

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

/** `content_block_delta` payloads whose inner `delta.type` matches. */
function deltasOfType(events: SseEvent[], type: string): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => (e.data as { delta?: Record<string, unknown> }).delta)
    .filter((d): d is Record<string, unknown> => !!d && (d as { type?: string }).type === type);
}

/** `content_block_start` blocks whose `content_block.type` matches. */
function blocksOfType(events: SseEvent[], type: string): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.event === 'content_block_start')
    .map((e) => (e.data as { content_block?: Record<string, unknown> }).content_block)
    .filter((b): b is Record<string, unknown> => !!b && (b as { type?: string }).type === type);
}

// ---------------------------------------------------------------------------
// INPUT encoders — synthetic provider SSE bodies.
// ---------------------------------------------------------------------------

/** OpenAI Chat Completions: `data: {chunk}\n\n` frames, terminated with [DONE]. */
function chatSseBody(chunks: unknown[], opts: { done?: boolean } = {}): string {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return opts.done === false ? body : `${body}data: [DONE]\n\n`;
}

/** OpenAI Responses: typed `event: TYPE\ndata: {json}\n\n` frames. */
type RespEvent = { type: string } & Record<string, unknown>;
function responsesSse(events: RespEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** Build an upstream ReadableStream from one or more byte chunks. Passing an
 *  array lets a test split a single SSE frame across reads (partial-chunk). */
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

// ---------------------------------------------------------------------------
// Stream drivers — feed a synthetic upstream Response through the canonical
// transform and return the Anthropic SSE text written to the output stream.
// Both transforms close their controller in a finally block, so the output is
// fully drained by `new Response(stream).text()` once the promise resolves.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Bridge-server lifecycle (OAuth-gated + pass-through sections bind real ports).
// ---------------------------------------------------------------------------

const servers: Array<
  OpenAIChatBridgeServer | OpenAIResponsesBridgeServer | AnthropicMessagesBridgeServer
> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

// Helper: a minimal valid Codex SSE response the mocked upstream can return so
// the bridge completes its SSE pipe cleanly. The OAuth tests only assert on the
// captured upstream REQUEST, not this body.
const MINIMAL_CODEX_SSE = responsesSse([
  { type: 'response.completed', response: { id: 'resp_test', usage: {} } },
]);

// ===========================================================================
// A. OpenAI Chat Completions bridge (custom-endpoint default type)
// ===========================================================================

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

      // message_start carries the model, input_tokens, and context window.
      const start = events[0].data as {
        message: { model: string; usage: Record<string, unknown> };
      };
      expect(start.message.model).toBe('test-model');
      expect(start.message.usage.input_tokens).toBe(42);
      expect(start.message.usage.model_context_window).toBe(200000);

      // Text deltas preserve order and content.
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

      // Strict ordering: thinking block (index 0) opens, deltas, closes, THEN
      // text block (index 1) opens, delta, closes.
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

      // Thinking block has no signature (the bridge emits a bare thinking type).
      const thinkingBlock = blocksOfType(events, 'thinking')[0];
      expect(thinkingBlock).toEqual({ type: 'thinking', thinking: '' });

      // thinking_delta preserves concatenated content + order before text_delta.
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

      // The thinking block is CLOSED before the text block OPENS — the bridge
      // runs closeThinkingBlock() before emitting the text content_block_start.
      // Pin the stop-before-next-start ordering, not just the block indices.
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

      // signature_delta / redacted_thinking are never emitted by this bridge.
      expect(out).not.toContain('signature');
      expect(out).not.toContain('redacted_thinking');
    });

    it('does NOT translate delta.reasoning (only reasoning_content is recognized)', async () => {
      // A chunk carrying only the non-standard `reasoning` field must produce no
      // thinking events — the bridge reads reasoning_content exclusively.
      const out = await replayChat(
        chatSseBody([{ choices: [{ index: 0, delta: { reasoning: 'ignored' } }] }])
      );
      const events = parseAnthropicSse(out);
      expect(blocksOfType(events, 'thinking')).toHaveLength(0);
      expect(deltasOfType(events, 'thinking_delta')).toHaveLength(0);
      // Still a well-formed (empty) turn.
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

      // Arguments streamed across 2 fragments collapse to ONE delta carrying
      // the fully-concatenated JSON — never partial_json per fragment.
      const jsonDeltas = deltasOfType(events, 'input_json_delta');
      expect(jsonDeltas).toHaveLength(1);
      expect(jsonDeltas[0].partial_json).toBe('{"q":"a"}');

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
      // Hand-build the body so the middle frame is genuinely unparseable JSON.
      const body =
        chatSseBody([{ choices: [{ index: 0, delta: { content: 'before' } }] }], { done: false }) +
        'data: {this is not json\n\n' +
        chatSseBody([{ choices: [{ index: 0, delta: { content: 'after' } }] }]);
      const out = await replayChat(body);
      const events = parseAnthropicSse(out);
      // Both real deltas survive; the bad frame produced no error and no crash.
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['before', 'after']);
      expect(events.some((e) => e.event === 'error')).toBe(false);
      expect(eventTypes(events).at(-1)).toBe('message_stop');
    });

    it('harvests usage from a choices-less chunk without emitting a delta', async () => {
      const out = await replayChat(
        chatSseBody([
          { choices: [], usage: { prompt_tokens: 99 } },
          { choices: [{ index: 0, delta: { content: 'hi' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]),
        { inputTokens: 10 }
      );
      const events = parseAnthropicSse(out);
      // The usage chunk contributed no content block, only the harvested count.
      expect(blocksOfType(events, 'text')).toHaveLength(1);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        usage: { input_tokens: number };
      };
      expect(msgDelta.usage.input_tokens).toBe(99);
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
      // The same `data:{...}\n\n` frame, but split mid-object across two reads.
      const full = chatSseBody(
        [
          { choices: [{ index: 0, delta: { content: 'streamed' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ],
        { done: false }
      );
      const splitAt = Math.floor(full.length / 2);
      const out = await replayChat([
        full.slice(0, splitAt),
        full.slice(splitAt) + 'data: [DONE]\n\n',
      ]);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['streamed']);
    });

    it('parses a final frame with no trailing blank-line terminator (flush path)', async () => {
      // No trailing \n\n and no [DONE] — the parser must still flush the tail.
      const body =
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'tail' } }] });
      const out = await replayChat(body);
      const events = parseAnthropicSse(out);
      expect(deltasOfType(events, 'text_delta').map((d) => d.text)).toEqual(['tail']);
    });

    it('fails fast with an error event when a 200 carries no SSE data frames', async () => {
      // A non-streaming endpoint returning one-shot JSON must NOT be surfaced
      // as an empty end_turn success.
      const out = await replayChat(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
      const events = parseAnthropicSse(out);
      expect(events.some((e) => e.event === 'error')).toBe(true);
      const err = events.find((e) => e.event === 'error')!.data as {
        error: { message: string };
      };
      expect(err.error.message).toContain('non-SSE');
      expect(eventTypes(events).at(-1)).toBe('message_stop');
    });
  });

  describe('usage fallback heuristic', () => {
    it('estimates output_tokens as ceil(len/4) when the upstream sends no usage', async () => {
      // 8 chars → 2 tokens.
      const out = await replayChat(
        chatSseBody([
          { choices: [{ index: 0, delta: { content: 'abcdefgh' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ])
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
      const withThinking = _openAIChatBridgeTesting.buildChatRequest(
        body,
        'm',
        true, // toolUseSupported
        false, // visionSupported
        true // thinkingSupported
      );
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
      // toolUseSupported=false is independent of thinking — the mapped effort is
      // still forwarded so reasoning survives even on tool-less endpoints.
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

// ===========================================================================
// B. OpenAI Responses bridge (Codex backend) — response-side streaming
// ===========================================================================

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

      // Real usage from response.completed wins over the estimate.
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

    it('emits message_start/message_delta/message_stop for an empty stream (just [DONE])', async () => {
      const out = await replayResponses('data: [DONE]\n\n');
      const events = parseAnthropicSse(out);
      expect(eventTypes(events)).toEqual(['message_start', 'message_delta', 'message_stop']);
      const msgDelta = events.find((e) => e.event === 'message_delta')!.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe('end_turn');
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
      // summary_part.added opens the thinking block (index 0); summary_text.done
      // closes it before the text block (index 1) opens.
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

      // No signature / redacted_thinking is ever produced (conformance contract).
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

    it('opens then closes an empty thinking block when summary_part.added has no delta', async () => {
      const out = await replayResponses(
        responsesSse([
          { type: 'response.reasoning_summary_part.added' },
          { type: 'response.reasoning_summary_part.done' },
          { type: 'response.completed', response: { id: 'r', usage: {} } },
        ])
      );
      const events = parseAnthropicSse(out);
      const thinkingStart = events.find(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data as { content_block: { type: string } }).content_block.type === 'thinking'
      )!.data as { index: number };
      expect(blocksOfType(events, 'thinking')).toHaveLength(1);
      expect(deltasOfType(events, 'thinking_delta')).toHaveLength(0);
      // The opened block is closed with a matching content_block_stop at the
      // same index — not just opened and left dangling.
      const stopIndexes = events
        .filter((e) => e.event === 'content_block_stop')
        .map((e) => (e.data as { index: number }).index);
      expect(stopIndexes).toContain(thinkingStart.index);
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
      // Exactly one tool_use block despite the call appearing twice upstream.
      expect(blocksOfType(events, 'tool_use')).toHaveLength(1);
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
      // Unlike the Chat bridge (accumulate total length, then ÷4 once), the
      // Responses heuristic rounds PER delta: each delta contributes
      // max(1, ceil(len/4)). So 5 single-char deltas sum to 5, not ceil(5/4)=2
      // — pin the real per-delta total so a switch to accumulate-then-divide
      // would be caught.
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
      // The Responses parser (readOpenAIStream) buffers a partial block across
      // reads independently of the Chat parser — pin that a frame split
      // mid-object is reassembled, not dropped or double-emitted.
      const full = responsesSse([
        { type: 'response.output_text.delta', delta: 'streamed' },
        { type: 'response.completed', response: { id: 'r', usage: {} } },
      ]);
      const splitAt = Math.floor(full.length / 2);
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
      // An errored turn emits NO message_delta (no stop_reason) — just error + stop.
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

// ===========================================================================
// C. Codex OAuth-gated request variants (bridge-server level)
// ===========================================================================

describe('provider-bridge conformance replay — Codex OAuth-gated request variants', () => {
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
  };

  /** Run one Anthropic request through the bridge server with a capturing
   *  upstream fetch, returning the captured upstream URL/headers/body. */
  async function captureUpstreamRequest(
    auth: Record<string, unknown>,
    body: Record<string, unknown>
  ): Promise<CapturedRequest> {
    const captured: CapturedRequest = { url: '', headers: {}, body: {} };
    const fetchImpl = async (url: string, init?: RequestInit) => {
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
    await res.text(); // drain the SSE pipe so the bridge finishes cleanly.
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
    // Standard API path keeps max_output_tokens / parallel_tool_calls.
    expect(caps.body.max_output_tokens).toBe(1024);
    expect(caps.body.parallel_tool_calls).toBe(false);
  });

  it('chatgpt_oauth: routes to the Codex backend, sends ChatGPT-Account-ID, drops summary_text', async () => {
    const caps = await captureUpstreamRequest(
      { apiKey: 'tok', source: 'chatgpt_oauth', accountId: 'acct-1' },
      thinkingBody(16000)
    );
    expect(caps.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(caps.headers.Authorization).toBe('Bearer tok');
    // The gateway header is case-sensitive (capital `ID`).
    expect(caps.headers['ChatGPT-Account-ID']).toBe('acct-1');
    expect(caps.body.include).toContain('reasoning.encrypted_content');
    // The Codex backend rejects summary_text — it must be omitted.
    expect(caps.body.include).not.toContain('reasoning.summary_text');
    // And it rejects max_output_tokens / parallel_tool_calls.
    expect(caps.body.max_output_tokens).toBeUndefined();
    expect(caps.body.parallel_tool_calls).toBeUndefined();
  });

  it('chatgpt_oauth FedRAMP account adds the X-OpenAI-Fedramp header', async () => {
    const caps = await captureUpstreamRequest(
      { apiKey: 'tok', source: 'chatgpt_oauth', accountId: 'acct-1', isFedrampAccount: true },
      thinkingBody(8000)
    );
    expect(caps.headers['X-OpenAI-Fedramp']).toBe('true');
  });

  it('omits the include array entirely when thinking is disabled', async () => {
    const caps = await captureUpstreamRequest(
      { apiKey: 'sk-test', source: 'api_key' },
      { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'hi' }] }
    );
    expect(caps.body.include).toBeUndefined();
    expect(caps.body.reasoning).toBeUndefined();
  });

  describe('reasoning.effort bands (budget_tokens → effort)', () => {
    for (const [budget, expected, model] of [
      [4000, 'low', 'gpt-5.3-codex'],
      [12000, 'medium', 'gpt-5.3-codex'],
      [20000, 'high', 'gpt-5.3-codex'],
      [32000, 'xhigh', 'gpt-5.3-codex'],
      [32000, 'high', 'gpt-4o'], // non-xhigh model caps to high
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
      });
    }
  });

  it('refreshes the OAuth token and retries the upstream on a 401', async () => {
    let calls = 0;
    const captured: CapturedRequest = { url: '', headers: {}, body: {} };
    const refreshAuthTokens = mock(async () => {
      return { accessToken: 'tok-refreshed', accountId: 'acct-1' };
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

    expect(calls).toBe(2); // first 401, then retried
    expect(refreshAuthTokens).toHaveBeenCalledTimes(1);
    // The retried request carried the refreshed token.
    expect(captured.headers.Authorization).toBe('Bearer tok-refreshed');
  });
});

// ===========================================================================
// D. Anthropic-Messages pass-through bridge (custom-endpoint anthropic-messages)
// ===========================================================================

describe('provider-bridge conformance replay — Anthropic-Messages pass-through bridge', () => {
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
    // Byte-for-byte fidelity: the pass-through must not re-frame or alter the
    // upstream stream (a JSON round-trip would drop unknown fields).
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
        // A non-default version proves the bridge forwards the SDK's value
        // verbatim rather than silently pinning its own default.
        'anthropic-version': '2024-10-22',
      },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(capturedHeaders['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(capturedHeaders['anthropic-version']).toBe('2024-10-22');
    // User-supplied apiKey is attached as both Bearer and x-api-key.
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
    // A 200 carrying an overload body must be reclassified so the SDK retries.
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
    // A baseUrl already ending in /v1/messages must not double-append, and the
    // upstream is hit exactly once (no retry/duplicate dispatch).
    expect(capturedUrl).toBe('https://upstream.test/v1/messages/count_tokens');
    expect(calls).toBe(1);
  });
});
