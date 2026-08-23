import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  computeIsRenderable,
  computeIsTerminal,
  extractParentToolUseId,
  extractReplacementEdges,
  extractSdkUuid,
} from '../../../../src/storage/repositories/sdk-message-repository';

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

describe('extractSdkUuid', () => {
  test('returns the string when present', () => {
    expect(extractSdkUuid(asMsg({ type: 'user', uuid: 'uuid-abc' }))).toBe('uuid-abc');
  });

  test('returns null when missing', () => {
    expect(extractSdkUuid(asMsg({ type: 'user' }))).toBeNull();
  });

  test('returns null when explicitly null', () => {
    expect(extractSdkUuid(asMsg({ type: 'user', uuid: null }))).toBeNull();
  });

  test('returns null for non-string values', () => {
    expect(extractSdkUuid(asMsg({ type: 'user', uuid: 42 }))).toBeNull();
  });

  test('returns null for empty strings — only non-empty strings are uuids', () => {
    expect(extractSdkUuid(asMsg({ type: 'user', uuid: '' }))).toBeNull();
  });
});

describe('extractReplacementEdges', () => {
  test('maps supersedes entries to superseded edges in array order', () => {
    expect(
      extractReplacementEdges(asMsg({ type: 'assistant', supersedes: ['old-1', 'old-2'] }))
    ).toEqual([
      { targetUuid: 'old-1', kind: 'superseded' },
      { targetUuid: 'old-2', kind: 'superseded' },
    ]);
  });

  test('skips non-string and empty-string entries', () => {
    expect(
      extractReplacementEdges(
        asMsg({ type: 'assistant', supersedes: ['', 42, null, {}, 'keep-me'] })
      )
    ).toEqual([{ targetUuid: 'keep-me', kind: 'superseded' }]);
  });

  test('dedupes repeated targets within a kind', () => {
    expect(
      extractReplacementEdges(asMsg({ type: 'assistant', supersedes: ['old-1', 'old-1'] }))
    ).toEqual([{ targetUuid: 'old-1', kind: 'superseded' }]);
  });

  test('keeps the same target under both kinds — dedupe is per (kind, uuid)', () => {
    expect(
      extractReplacementEdges(
        asMsg({
          type: 'system',
          subtype: 'model_refusal_fallback',
          supersedes: ['shared'],
          retracted_message_uuids: ['shared'],
        })
      )
    ).toEqual([
      { targetUuid: 'shared', kind: 'superseded' },
      { targetUuid: 'shared', kind: 'retracted' },
    ]);
  });

  test('reads retracted edges only for the model_refusal_fallback subtype', () => {
    expect(
      extractReplacementEdges(
        asMsg({
          type: 'system',
          subtype: 'model_refusal_fallback',
          retracted_message_uuids: ['gone-1'],
        })
      )
    ).toEqual([{ targetUuid: 'gone-1', kind: 'retracted' }]);
  });

  test('ignores retracted_message_uuids outside the refusal subtype', () => {
    expect(
      extractReplacementEdges(
        asMsg({
          type: 'system',
          subtype: 'other_subtype',
          retracted_message_uuids: ['gone-1'],
        })
      )
    ).toEqual([]);
    expect(
      extractReplacementEdges(asMsg({ type: 'system', retracted_message_uuids: ['gone-1'] }))
    ).toEqual([]);
  });

  test('supersedes has no subtype gate — a refusal carrier still supersedes', () => {
    expect(
      extractReplacementEdges(
        asMsg({ type: 'assistant', subtype: 'other_subtype', supersedes: ['old-1'] })
      )
    ).toEqual([{ targetUuid: 'old-1', kind: 'superseded' }]);
  });

  test('returns [] when neither field is an array', () => {
    expect(
      extractReplacementEdges(
        asMsg({ type: 'assistant', supersedes: 'single', retracted_message_uuids: 7 })
      )
    ).toEqual([]);
    expect(extractReplacementEdges(asMsg({ type: 'assistant' }))).toEqual([]);
  });
});
