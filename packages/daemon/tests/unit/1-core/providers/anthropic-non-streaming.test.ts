import { describe, expect, test } from 'bun:test';
import {
  anthropicErrorStatus,
  assembleAnthropicMessage,
} from '../../../../src/lib/providers/anthropic-non-streaming';

const sse = (events: object[]) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');

describe('assembleAnthropicMessage', () => {
  test('builds text, thinking and tool_use blocks with the final stop reason and usage', () => {
    const assembled = assembleAnthropicMessage(
      sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'm',
            content: [],
            usage: { input_tokens: 9 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Plan.' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi ' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there' } },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 't1', name: 'run', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '"ls"}' },
        },
        { type: 'content_block_stop', index: 2 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ])
    );
    expect(assembled).toEqual({
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 5 },
        content: [
          { type: 'thinking', thinking: 'Plan.', signature: 'sig' },
          { type: 'text', text: 'Hi there' },
          { type: 'tool_use', id: 't1', name: 'run', input: { cmd: 'ls' } },
        ],
      },
    });
  });

  test('keeps an empty input when truncated tool arguments are not valid JSON', () => {
    const assembled = assembleAnthropicMessage(
      sse([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'run', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"cmd":"l' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      ])
    );
    expect(assembled).toMatchObject({
      message: { content: [{ type: 'tool_use', id: 't1', input: {} }], stop_reason: 'max_tokens' },
    });
  });

  test('returns the error of a stream that failed', () => {
    expect(
      assembleAnthropicMessage(
        sse([{ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }])
      )
    ).toEqual({ error: { type: 'overloaded_error', message: 'busy' } });
  });
});

describe('anthropicErrorStatus', () => {
  test.each([
    [{ type: 'overloaded_error' }, 529],
    [{ type: 'rate_limit_error' }, 429],
    [{ type: 'invalid_request_error' }, 400],
    [{ type: 'api_error' }, 500],
    [null, 500],
  ])('%j answers %d', (error, status) => {
    expect(anthropicErrorStatus(error)).toBe(status);
  });
});
