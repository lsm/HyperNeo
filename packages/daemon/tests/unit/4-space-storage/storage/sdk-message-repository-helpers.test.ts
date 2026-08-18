import { describe, expect, test } from 'bun:test';
import {
  computeIsRenderable,
  computeIsTerminal,
  extractParentToolUseId,
} from '../../../../src/storage/repositories/sdk-message-repository';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const asMsg = (payload: Record<string, unknown>): SDKMessage => payload as unknown as SDKMessage;

describe('computeIsRenderable', () => {
  describe('user messages', () => {
    test('mixed-content user with text + tool_result is NOT renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'hi' },
                { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
              ],
            },
          })
        )
      ).toBe(0);
    });

    test('user with only tool_result blocks is NOT renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
            },
          })
        )
      ).toBe(0);
    });

    test('user with only text blocks IS renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'user',
            message: { content: [{ type: 'text', text: 'hello' }] },
          })
        )
      ).toBe(1);
    });

    test('user with empty content array IS renderable', () => {
      expect(computeIsRenderable(asMsg({ type: 'user', message: { content: [] } }))).toBe(1);
    });

    test('user with non-array content (string) IS renderable', () => {
      expect(computeIsRenderable(asMsg({ type: 'user', message: { content: 'plain' } }))).toBe(1);
    });
  });

  describe('assistant messages', () => {
    test('assistant with tool_use IS renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tu1', name: 'x', input: {} }],
            },
          })
        )
      ).toBe(1);
    });

    test('assistant with non-empty text IS renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'reply' }] },
          })
        )
      ).toBe(1);
    });

    test('assistant with whitespace-only text is NOT renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: { content: [{ type: 'text', text: '   \n\t  ' }] },
          })
        )
      ).toBe(0);
    });

    test('assistant with empty text is NOT renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: { content: [{ type: 'text', text: '' }] },
          })
        )
      ).toBe(0);
    });

    test('assistant with non-empty thinking IS renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: { content: [{ type: 'thinking', thinking: 'reasoning…' }] },
          })
        )
      ).toBe(1);
    });

    test('assistant with whitespace-only thinking is NOT renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: { content: [{ type: 'thinking', thinking: '   ' }] },
          })
        )
      ).toBe(0);
    });

    test('assistant with empty content array is NOT renderable', () => {
      expect(computeIsRenderable(asMsg({ type: 'assistant', message: { content: [] } }))).toBe(0);
    });

    test('assistant with non-array content IS renderable', () => {
      expect(
        computeIsRenderable(asMsg({ type: 'assistant', message: { content: 'unknown' } }))
      ).toBe(1);
    });

    test('assistant with text + thinking, both whitespace, is NOT renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: '  ' },
                { type: 'thinking', thinking: '\n' },
              ],
            },
          })
        )
      ).toBe(0);
    });

    test('assistant with text whitespace + thinking content IS renderable', () => {
      expect(
        computeIsRenderable(
          asMsg({
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: '  ' },
                { type: 'thinking', thinking: 'real reasoning' },
              ],
            },
          })
        )
      ).toBe(1);
    });
  });

  describe('other message types', () => {
    test('system messages are renderable by default', () => {
      expect(computeIsRenderable(asMsg({ type: 'system' }))).toBe(1);
    });

    test('result messages are renderable by default', () => {
      expect(computeIsRenderable(asMsg({ type: 'result', subtype: 'success' }))).toBe(1);
    });
  });
});

describe('computeIsTerminal', () => {
  test('result messages are terminal', () => {
    expect(computeIsTerminal(asMsg({ type: 'result' }))).toBe(1);
  });

  test('user messages are not terminal', () => {
    expect(computeIsTerminal(asMsg({ type: 'user' }))).toBe(0);
  });

  test('assistant messages are not terminal', () => {
    expect(computeIsTerminal(asMsg({ type: 'assistant' }))).toBe(0);
  });

  test('system messages are not terminal', () => {
    expect(computeIsTerminal(asMsg({ type: 'system' }))).toBe(0);
  });

  test('unknown types are not terminal', () => {
    expect(computeIsTerminal(asMsg({ type: 'partial_assistant' }))).toBe(0);
  });
});

describe('extractParentToolUseId', () => {
  test('returns the string when present', () => {
    expect(extractParentToolUseId(asMsg({ type: 'assistant', parent_tool_use_id: 'tu_abc' }))).toBe(
      'tu_abc'
    );
  });

  test('returns null when missing', () => {
    expect(extractParentToolUseId(asMsg({ type: 'assistant' }))).toBeNull();
  });

  test('returns null when explicitly null', () => {
    expect(
      extractParentToolUseId(asMsg({ type: 'assistant', parent_tool_use_id: null }))
    ).toBeNull();
  });

  test('returns null for non-string values', () => {
    expect(extractParentToolUseId(asMsg({ type: 'assistant', parent_tool_use_id: 42 }))).toBeNull();
  });

  test('returns null for empty/undefined message', () => {
    expect(extractParentToolUseId(asMsg({}))).toBeNull();
  });
});
