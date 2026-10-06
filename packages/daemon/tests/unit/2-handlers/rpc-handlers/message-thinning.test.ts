import { describe, expect, test } from 'bun:test';
import { thinMessage } from '../../../../src/lib/rpc-handlers/message-thinning';

describe('thinMessage', () => {
  test('drops tool output, keeping the error line and the result link', () => {
    const thinned = thinMessage({
      type: 'user',
      tool_use_result: { stdout: 'x'.repeat(10_000) },
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'ok', content: 'x'.repeat(10_000) },
          {
            type: 'tool_result',
            tool_use_id: 'bad',
            is_error: true,
            content: [{ type: 'text', text: '\nexit 1: no pull request found\nstack...' }],
          },
        ],
      },
    });
    expect(thinned).toEqual({
      type: 'user',
      thinned: true,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'ok',
            is_error: undefined,
            content: '',
            output_thinned: true,
          },
          {
            type: 'tool_result',
            tool_use_id: 'bad',
            is_error: true,
            content: 'exit 1: no pull request found',
            output_thinned: true,
          },
        ],
      },
    });
  });

  test('keeps whole inputs for todos and questions, and plain text as is', () => {
    const todo = {
      type: 'tool_use',
      id: 't',
      name: 'TodoWrite',
      input: { todos: [{ content: 'a' }] },
    };
    const text = { type: 'text', text: 'Done.' };
    expect(thinMessage({ type: 'assistant', message: { content: [todo, text] } }).message).toEqual({
      content: [todo, text],
    });
  });

  test('keeps the first string field for unknown tools and drops non-string values', () => {
    const thinned = thinMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'n',
            name: 'NewTool',
            input: { target: 'api', query: { big: 'x'.repeat(9000) } },
          },
        ],
      },
    });
    expect((thinned.message as { content: Array<{ input: unknown }> }).content[0].input).toEqual({
      target: 'api',
    });
  });

  test('cuts long summary fields and leaves messages without content alone', () => {
    const thinned = thinMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'b',
            name: 'Bash',
            input: { command: 'y'.repeat(900), timeout: 5 },
          },
        ],
      },
    });
    expect((thinned.message as { content: Array<{ input: unknown }> }).content[0].input).toEqual({
      command: 'y'.repeat(500),
    });
    expect(thinMessage({ type: 'result', subtype: 'success' })).toEqual({
      type: 'result',
      subtype: 'success',
      thinned: true,
    });
  });
});
