import { describe, expect, it } from 'bun:test';
import {
  formatAnthropicPrompt,
  extractSystemText,
  extractToolResultIds,
  extractToolResultContent,
  extractToolResultIsError,
} from '../../../../../src/lib/providers/anthropic-copilot/prompt';

describe('formatAnthropicPrompt', () => {
  it('formats a single user string message', () => {
    const result = formatAnthropicPrompt([{ role: 'user', content: 'hello' }]);
    expect(result).toBe('[User]: hello');
  });

  it('formats a single assistant string message', () => {
    const result = formatAnthropicPrompt([{ role: 'assistant', content: 'hi there' }]);
    expect(result).toBe('[Assistant]: hi there');
  });

  it('formats multi-turn conversation', () => {
    const result = formatAnthropicPrompt([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow up' },
    ]);
    expect(result).toBe('[User]: first\n\n[Assistant]: reply\n\n[User]: follow up');
  });

  it('formats text content blocks', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'user',
        content: [{ type: 'text', text: 'block content' }],
      },
    ]);
    expect(result).toBe('[User]: block content');
  });

  it('skips empty text blocks', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'real' },
        ],
      },
    ]);
    expect(result).toBe('[User]: real');
  });

  it('skips thinking blocks', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal thought' },
          { type: 'text', text: 'visible' },
        ],
      },
    ]);
    expect(result).toBe('[Assistant]: visible');
  });

  it('formats tool_use blocks inline', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
      },
    ]);
    expect(result).toContain('[Assistant called tool bash with args:');
    expect(result).toContain('"command":"ls"');
  });

  it('formats tool_result blocks inline — string content', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt' }],
      },
    ]);
    expect(result).toBe('[Tool result for tu_1]: file.txt');
  });

  it('formats tool_result blocks inline — text-block array content', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
    ]);
    expect(result).toBe('[Tool result for tu_1]: line1\nline2');
  });

  it('formats tool_result with no content as empty string', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1' }],
      },
    ]);
    expect(result).toBe('[Tool result for tu_1]: ');
  });

  it('formats tool_result with is_error=true using error prefix', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'timeout', is_error: true }],
      },
    ]);
    expect(result).toBe('[Tool error for tu_1]: timeout');
  });

  it('formats tool_result with is_error=false using result prefix', () => {
    const result = formatAnthropicPrompt([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false }],
      },
    ]);
    expect(result).toBe('[Tool result for tu_1]: ok');
  });

  it('returns empty string for empty messages array', () => {
    expect(formatAnthropicPrompt([])).toBe('');
  });
});

describe('extractSystemText', () => {
  it('returns undefined for undefined input', () => {
    expect(extractSystemText(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractSystemText('')).toBeUndefined();
  });

  it('returns the string as-is', () => {
    expect(extractSystemText('be concise')).toBe('be concise');
  });

  it('joins text blocks with double newline', () => {
    expect(
      extractSystemText([
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ])
    ).toBe('line one\n\nline two');
  });

  it('returns undefined for all-empty text blocks', () => {
    expect(extractSystemText([{ type: 'text', text: '' }])).toBeUndefined();
  });
});

describe('extractToolResultIds', () => {
  it('returns empty array when no tool_result blocks', () => {
    expect(extractToolResultIds([{ role: 'user', content: 'hi' }])).toEqual([]);
  });

  it('extracts tool_use_id from tool_result blocks in user messages', () => {
    const ids = extractToolResultIds([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_abc' }],
      },
    ]);
    expect(ids).toEqual(['tu_abc']);
  });

  it('ignores assistant messages', () => {
    const ids = extractToolResultIds([
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1' } as never],
      },
    ]);
    expect(ids).toEqual([]);
  });

  it('extracts multiple ids from multiple blocks', () => {
    const ids = extractToolResultIds([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1' },
          { type: 'tool_result', tool_use_id: 'tu_2' },
        ],
      },
    ]);
    expect(ids).toEqual(['tu_1', 'tu_2']);
  });
});

describe('extractToolResultContent', () => {
  it('returns undefined when id not found', () => {
    expect(
      extractToolResultContent(
        [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_other' }] }],
        'tu_1'
      )
    ).toBeUndefined();
  });

  it('extracts string content', () => {
    expect(
      extractToolResultContent(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'output' }],
          },
        ],
        'tu_1'
      )
    ).toBe('output');
  });

  it('extracts text-block array content', () => {
    expect(
      extractToolResultContent(
        [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'text', text: 'result' }],
              },
            ],
          },
        ],
        'tu_1'
      )
    ).toBe('result');
  });
});

describe('extractToolResultIsError', () => {
  it('returns false when id not found', () => {
    expect(extractToolResultIsError([], 'tu_1')).toBe(false);
  });

  it('returns false when is_error is absent', () => {
    expect(
      extractToolResultIsError(
        [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] }],
        'tu_1'
      )
    ).toBe(false);
  });

  it('returns true when is_error=true', () => {
    expect(
      extractToolResultIsError(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true }],
          },
        ],
        'tu_1'
      )
    ).toBe(true);
  });

  it('returns false when is_error=false', () => {
    expect(
      extractToolResultIsError(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false }],
          },
        ],
        'tu_1'
      )
    ).toBe(false);
  });
});
