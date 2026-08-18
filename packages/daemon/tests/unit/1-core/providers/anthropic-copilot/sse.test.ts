import { describe, expect, it } from 'bun:test';
import type { ServerResponse } from 'node:http';
import { AnthropicStreamWriter } from '../../../../../src/lib/providers/anthropic-copilot/sse';

function makeRes(): { written: string[]; state: { ended: boolean }; res: ServerResponse } {
  const written: string[] = [];
  const state = { ended: false };
  const res = {
    writeHead: (_status: number, _headers: unknown) => {},
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      state.ended = true;
    },
  } as unknown as ServerResponse;
  return { written, state, res };
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

describe('AnthropicStreamWriter', () => {
  describe('start()', () => {
    it('emits message_start with correct model', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'claude-sonnet-4.6');
      const events = parseEvents(written);
      const start = events.find((e) => e.type === 'message_start');
      expect(start).toBeDefined();
      const msg = (start!.data as Record<string, unknown>)['message'] as Record<string, unknown>;
      expect(msg['model']).toBe('claude-sonnet-4.6');
      expect(msg['role']).toBe('assistant');
    });

    it('message_start id uses messageId', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'claude-sonnet-4.6');
      const events = parseEvents(written);
      const start = events.find((e) => e.type === 'message_start');
      const msg = (start!.data as Record<string, unknown>)['message'] as Record<string, unknown>;
      expect(msg['id']).toBe(writer.messageId);
    });
  });

  describe('flushDeltas()', () => {
    it('emits content_block_start before first delta', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.flushDeltas(res, ['hello']);
      const events = parseEvents(written);
      const types = events.map((e) => e.type);
      expect(types).toContain('content_block_start');
      expect(types).toContain('content_block_delta');
    });

    it('does not emit block_start twice for consecutive flush calls', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.flushDeltas(res, ['a']);
      writer.flushDeltas(res, ['b']);
      const events = parseEvents(written);
      const starts = events.filter((e) => e.type === 'content_block_start');
      expect(starts.length).toBe(1);
    });

    it('is a no-op for empty array', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      const before = written.length;
      writer.flushDeltas(res, []);
      expect(written.length).toBe(before);
    });
  });

  describe('sendCompleted()', () => {
    it('emits content_block_stop and message_stop with end_turn', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.flushDeltas(res, ['text']);
      writer.sendCompleted(res);
      const events = parseEvents(written);
      const types = events.map((e) => e.type);
      expect(types).toContain('content_block_stop');
      expect(types).toContain('message_stop');
      const delta = events.find((e) => e.type === 'message_delta');
      expect((delta!.data as Record<string, unknown>)['delta']).toMatchObject({
        stop_reason: 'end_turn',
      });
    });

    it('does not emit an empty text block when no text was flushed', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendCompleted(res);
      const events = parseEvents(written);
      const types = events.map((e) => e.type);
      expect(types).not.toContain('content_block_start');
      expect(types).not.toContain('content_block_stop');
      expect(types).toContain('message_delta');
      expect(types).toContain('message_stop');
    });
  });

  describe('sendFailed()', () => {
    it('emits error SSE event with default api_error type', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendFailed(res);
      const events = parseEvents(written);
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      const data = errorEvent!.data as Record<string, unknown>;
      expect(data['type']).toBe('error');
      const err = data['error'] as Record<string, unknown>;
      expect(err['type']).toBe('api_error');
      expect(err['message']).toBe('Internal server error');
    });

    it('forwards custom errorType and message', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendFailed(res, 'authentication_error', 'Token expired');
      const events = parseEvents(written);
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      const err = (errorEvent!.data as Record<string, unknown>)['error'] as Record<string, unknown>;
      expect(err['type']).toBe('authentication_error');
      expect(err['message']).toBe('Token expired');
    });

    it('closes open text block before emitting error event', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.flushDeltas(res, ['partial text']);
      writer.sendFailed(res, 'api_error', 'Session error');
      const events = parseEvents(written);
      const types = events.map((e) => e.type);
      const stopIdx = types.lastIndexOf('content_block_stop');
      const errorIdx = types.indexOf('error');
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(errorIdx).toBeGreaterThan(stopIdx);
    });

    it('emits error event without a preceding text block when no deltas were flushed', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendFailed(res);
      const events = parseEvents(written);
      const types = events.map((e) => e.type);
      expect(types).not.toContain('content_block_stop');
      expect(types).toContain('error');
    });

    it('does NOT emit message_stop after error event', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendFailed(res);
      const events = parseEvents(written);
      expect(events.some((e) => e.type === 'message_stop')).toBe(false);
    });
  });

  describe('sendToolUse()', () => {
    it('emits tool_use content_block_start with correct id/name', () => {
      const { written, state, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendToolUse(res, 'tc_1', 'bash', { command: 'ls' });
      const events = parseEvents(written);
      const start = events.find(
        (e) =>
          e.type === 'content_block_start' &&
          (e.data as Record<string, unknown>)['content_block'] !== undefined &&
          ((e.data as Record<string, unknown>)['content_block'] as Record<string, unknown>)[
            'type'
          ] === 'tool_use'
      );
      expect(start).toBeDefined();
      const cb = (start!.data as Record<string, unknown>)['content_block'] as Record<
        string,
        unknown
      >;
      expect(cb['id']).toBe('tc_1');
      expect(cb['name']).toBe('bash');
      expect(state.ended).toBe(true);
    });

    it('stop_reason is tool_use', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendToolUse(res, 'tc_1', 'bash', {});
      const events = parseEvents(written);
      const delta = events.find((e) => e.type === 'message_delta');
      expect(
        ((delta!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
          'stop_reason'
        ]
      ).toBe('tool_use');
    });

    it('closes open text block before tool_use block', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.flushDeltas(res, ['some text']);
      writer.sendToolUse(res, 'tc_1', 'read_file', { path: 'x.ts' });
      const events = parseEvents(written);
      const stopIndices = events
        .map((e, i) => (e.type === 'content_block_stop' ? i : -1))
        .filter((i) => i >= 0);
      expect(stopIndices.length).toBe(2);
    });

    it('emits input_json_delta with stringified input', () => {
      const { written, res } = makeRes();
      const writer = new AnthropicStreamWriter();
      writer.start(res, 'model');
      writer.sendToolUse(res, 'tc_1', 'bash', { command: 'pwd' });
      const events = parseEvents(written);
      const delta = events.find(
        (e) =>
          e.type === 'content_block_delta' &&
          ((e.data as Record<string, unknown>)['delta'] as Record<string, unknown>)['type'] ===
            'input_json_delta'
      );
      expect(delta).toBeDefined();
      const partialJson = (
        (delta!.data as Record<string, unknown>)['delta'] as Record<string, unknown>
      )['partial_json'];
      expect(JSON.parse(partialJson as string)).toEqual({ command: 'pwd' });
    });
  });
});
