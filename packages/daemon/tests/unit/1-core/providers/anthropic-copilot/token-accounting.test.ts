/**
 * Unit tests for heuristic token accounting in the anthropic-copilot bridge.
 *
 * The Copilot SDK does not expose real token counts, so we use a 4-chars-per-token
 * heuristic.  These tests verify the formula and its integration with SSE events.
 */

import { describe, expect, it } from 'bun:test';
import type { ServerResponse } from 'node:http';
import {
  estimateTokens,
  AnthropicStreamWriter,
} from '../../../../../src/lib/providers/anthropic-copilot/sse';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes(): { written: string[]; res: ServerResponse } {
  const written: string[] = [];
  const res = {
    writeHead: (_status: number, _headers: unknown) => {},
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {},
  } as unknown as ServerResponse;
  return { written, res };
}

function parseEvents(written: string[]): Array<{ type: string; data: unknown }> {
  const events: Array<{ type: string; data: unknown }> = [];
  let currentType = '';
  for (const chunk of written) {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) {
        currentType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        events.push({ type: currentType, data: JSON.parse(line.slice(6)) });
        currentType = '';
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// estimateTokens()
// ---------------------------------------------------------------------------

describe('estimateTokens()', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens(0)).toBe(0);
  });

  it('returns 1 for 1-4 chars', () => {
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
  });

  it('returns 2 for 5-8 chars', () => {
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(8)).toBe(2);
  });

  it('applies ceil for non-divisible lengths', () => {
    // 7 chars → ceil(7/4) = 2
    expect(estimateTokens(7)).toBe(2);
    // 9 chars → ceil(9/4) = 3
    expect(estimateTokens(9)).toBe(3);
  });

  it('exact multiple of 4 → no rounding', () => {
    expect(estimateTokens(12)).toBe(3);
    expect(estimateTokens(400)).toBe(100);
  });

  it('known inputs produce expected values', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateTokens('hello world'.length)).toBe(3);
    // 100-char string → ceil(100/4) = 25
    expect(estimateTokens(100)).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// message_start: input_tokens estimate
// ---------------------------------------------------------------------------

describe('message_start input_tokens', () => {
  it('is 0 when no inputTokens are provided', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model');
    const events = parseEvents(written);
    const start = events.find((e) => e.type === 'message_start');
    const usage = ((start!.data as Record<string, unknown>)['message'] as Record<string, unknown>)[
      'usage'
    ] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(0);
  });

  it('includes cache token fields for SDK 0.2.84+ compatibility', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model', 10);
    const events = parseEvents(written);
    const start = events.find((e) => e.type === 'message_start');
    const usage = ((start!.data as Record<string, unknown>)['message'] as Record<string, unknown>)[
      'usage'
    ] as Record<string, unknown>;
    // SDK 0.2.84+ expects these fields to be present (not undefined)
    expect(usage['cache_creation_input_tokens']).toBe(0);
    expect(usage['cache_read_input_tokens']).toBe(0);
  });

  it('is non-zero for a non-empty inputTokens value', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    // 40-char input → ceil(40/4) = 10
    writer.start(res, 'model', estimateTokens(40));
    const events = parseEvents(written);
    const start = events.find((e) => e.type === 'message_start');
    const usage = ((start!.data as Record<string, unknown>)['message'] as Record<string, unknown>)[
      'usage'
    ] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(10);
  });

  it('reflects exact formula: ceil(charCount / 4)', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    // "system: do stuff\nuser: hello" = 29 chars → ceil(29/4) = 8
    const inputText = 'system: do stuff\nuser: hello';
    writer.start(res, 'model', estimateTokens(inputText.length));
    const events = parseEvents(written);
    const start = events.find((e) => e.type === 'message_start');
    const usage = ((start!.data as Record<string, unknown>)['message'] as Record<string, unknown>)[
      'usage'
    ] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(Math.ceil(inputText.length / 4));
  });
});

// ---------------------------------------------------------------------------
// message_delta: output_tokens estimate
// ---------------------------------------------------------------------------

describe('message_delta output_tokens', () => {
  it('is 0 when no text was flushed', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model');
    writer.sendCompleted(res);
    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    expect(usage['output_tokens']).toBe(0);
  });

  it('is non-zero after text deltas are flushed', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model');
    writer.flushDeltas(res, ['hello world']); // 11 chars
    writer.sendCompleted(res);
    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    // ceil(11/4) = 3
    expect(usage['output_tokens']).toBe(3);
  });

  it('accumulates across multiple flushDeltas calls', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model');
    // 4 chars + 8 chars = 12 chars total → ceil(12/4) = 3
    writer.flushDeltas(res, ['abcd']);
    writer.flushDeltas(res, ['efghijkl']);
    writer.sendCompleted(res);
    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    expect(usage['output_tokens']).toBe(3);
  });

  it('accumulates across multiple deltas in a single flush', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model');
    // ['abc', 'de'] = 3 + 2 = 5 chars → ceil(5/4) = 2
    writer.flushDeltas(res, ['abc', 'de']);
    writer.sendCompleted(res);
    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    expect(usage['output_tokens']).toBe(2);
  });

  it('reflects exact formula: ceil(totalOutputChars / 4)', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model');
    const outputText = 'The answer is 42, and the universe is vast.'; // 43 chars
    writer.flushDeltas(res, [outputText]);
    writer.sendCompleted(res);
    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    expect(usage['output_tokens']).toBe(Math.ceil(outputText.length / 4));
  });

  it('output_tokens is correct in tool_use epilogue too', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model');
    // Emit some text before tool call
    writer.flushDeltas(res, ['thinking...']); // 11 chars
    writer.sendToolUse(res, 'tc_1', 'bash', { command: 'ls' });
    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    // ceil(11/4) = 3
    expect(usage['output_tokens']).toBe(3);
  });

  it('message_delta preserves the best known input_tokens value', () => {
    const { written, res } = makeRes();
    const writer = new AnthropicStreamWriter();
    writer.start(res, 'model', 12);
    writer.updateInputTokens(345);
    writer.flushDeltas(res, ['hello']);
    writer.sendCompleted(res);
    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(345);
  });
});
