import { describe, expect, test } from 'bun:test';
import { capMessageOutput } from '../../../../src/lib/rpc-handlers/message-output-cap';

const big = 'x'.repeat(40);

describe('capMessageOutput', () => {
  test('trims tool output and marks how long it was', () => {
    const message = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: big },
          { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: big }] },
        ],
      },
      tool_use_result: { stdout: big, exitCode: 0 },
    };
    expect(capMessageOutput(message, 10) as unknown).toEqual({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'x'.repeat(10),
            output_capped: { chars: 40 },
          },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: 'x'.repeat(10) }],
            output_capped: { chars: 40 },
          },
        ],
      },
      tool_use_result: { stdout: 'x'.repeat(10), exitCode: 0 },
      output_capped: true,
    });
  });

  test('drops oversized image data instead of sending a broken image', () => {
    const message = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
            ],
          },
        ],
      },
    };
    const capped = capMessageOutput(message, 10) as typeof message;
    expect(capped.message.content[0].content as unknown).toEqual([
      { type: 'image', image_capped: { chars: 40 } },
    ]);
  });

  test('leaves tool inputs whole so Write and Edit cards render correctly', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { content: big } }],
      },
    };
    expect(capMessageOutput(message, 10)).toBe(message);
  });

  test('empties oversized Read image data instead of corrupting it', () => {
    const message = {
      type: 'user',
      message: { content: [] },
      tool_use_result: { type: 'image', file: { base64: big, type: 'image/png' } },
    };
    expect(capMessageOutput(message, 10).tool_use_result as unknown).toEqual({
      type: 'image',
      file: { base64: '', type: 'image/png' },
      image_capped: { chars: 40 },
    });
  });

  test('returns small messages untouched', () => {
    const message = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: big }] },
    };
    expect(capMessageOutput(message, 10)).toBe(message);
  });
});
