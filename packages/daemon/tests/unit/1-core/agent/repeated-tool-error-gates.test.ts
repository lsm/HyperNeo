import { describe, expect, it } from 'bun:test';
import {
  buildRecoveryMessage,
  buildRepeatedToolErrorEvidence,
  classifyToolResultContent,
  decideConsecutiveError,
  extractToolResultError,
  isToolResultBlock,
  normalizeErrorText,
  type ErrorObservationState,
} from '../../../../src/lib/agent/repeated-tool-error-gates';

function makeState(overrides: Partial<ErrorObservationState> = {}): ErrorObservationState {
  return { lastError: null, consecutiveCount: 0, ...overrides };
}

describe('normalizeErrorText', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normalizeErrorText('  File   NOT\nfound ', 160)).toBe('file not found');
  });

  it('truncates to the fingerprint length', () => {
    expect(normalizeErrorText('a'.repeat(200), 160)).toBe('a'.repeat(160));
  });

  it('keeps text at exactly the fingerprint length unchanged', () => {
    expect(normalizeErrorText('a'.repeat(160), 160)).toBe('a'.repeat(160));
  });
});

describe('isToolResultBlock', () => {
  it('accepts only objects with type tool_result', () => {
    expect(isToolResultBlock({ type: 'tool_result' })).toBe(true);
    expect(isToolResultBlock({ type: 'tool_use' })).toBe(false);
    expect(isToolResultBlock(null)).toBe(false);
    expect(isToolResultBlock('tool_result')).toBe(false);
  });
});

describe('extractToolResultError', () => {
  const names = new Map([['tool-1', 'Read']]);

  it('returns null for non-tool_result blocks', () => {
    expect(extractToolResultError({ type: 'text', text: 'hi' }, names)).toBeNull();
  });

  it('returns null when is_error is not exactly true', () => {
    expect(
      extractToolResultError({ type: 'tool_result', tool_use_id: 'tool-1', content: 'x' }, names)
    ).toBeNull();
    expect(
      extractToolResultError(
        { type: 'tool_result', tool_use_id: 'tool-1', is_error: 1, content: 'x' },
        names
      )
    ).toBeNull();
  });

  it('returns null without a string tool_use_id', () => {
    expect(
      extractToolResultError({ type: 'tool_result', is_error: true, content: 'x' }, names)
    ).toBeNull();
  });

  it('returns null when the error text is empty', () => {
    expect(
      extractToolResultError(
        { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: '' },
        names
      )
    ).toBeNull();
    expect(
      extractToolResultError(
        { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: [] },
        names
      )
    ).toBeNull();
  });

  it('resolves the tool name from the lookup map and falls back to unknown', () => {
    expect(
      extractToolResultError(
        { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'boom' },
        names
      )
    ).toEqual({ toolUseId: 'tool-1', toolName: 'Read', errorText: 'boom' });
    expect(
      extractToolResultError(
        { type: 'tool_result', tool_use_id: 'tool-9', is_error: true, content: 'boom' },
        names
      )
    ).toEqual({ toolUseId: 'tool-9', toolName: 'unknown', errorText: 'boom' });
  });

  it('joins structured content blocks and stringifies non-string content', () => {
    expect(
      extractToolResultError(
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          is_error: true,
          content: [{ type: 'text', text: 'file not found' }, 'extra', { type: 'image' }],
        },
        names
      )?.errorText
    ).toBe('file not found extra');
    expect(
      extractToolResultError(
        { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: { code: 42 } },
        names
      )?.errorText
    ).toBe('{"code":42}');
  });
});

describe('classifyToolResultContent', () => {
  const names = new Map([['tool-1', 'Read']]);

  it('resets on string content', () => {
    expect(classifyToolResultContent('plain text', names, 160)).toEqual({ kind: 'reset' });
  });

  it('ignores content that is neither a string nor an array', () => {
    expect(classifyToolResultContent(undefined, names, 160)).toEqual({ kind: 'ignore' });
    expect(classifyToolResultContent({ role: 'user' }, names, 160)).toEqual({ kind: 'ignore' });
  });

  it('resets on an empty array or one without error tool results', () => {
    expect(classifyToolResultContent([], names, 160)).toEqual({ kind: 'reset' });
    expect(classifyToolResultContent([{ type: 'text', text: 'hi' }], names, 160)).toEqual({
      kind: 'reset',
    });
  });

  it('resets when any successful tool result is present alongside errors', () => {
    expect(
      classifyToolResultContent(
        [
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'boom' },
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: false, content: 'ok' },
        ],
        names,
        160
      )
    ).toEqual({ kind: 'reset' });
  });

  it('resets on malformed error blocks that carry no extractable error', () => {
    expect(
      classifyToolResultContent(
        [{ type: 'tool_result', is_error: true, content: 'boom' }],
        names,
        160
      )
    ).toEqual({ kind: 'reset' });
  });

  it('keeps same-fingerprint errors from different tools separate', () => {
    const names = new Map([
      ['tool-1', 'Read'],
      ['tool-2', 'Glob'],
    ]);
    expect(
      classifyToolResultContent(
        [
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'boom' },
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'boom' },
        ],
        names,
        160
      )
    ).toEqual({
      kind: 'errors',
      errors: [
        { toolUseId: 'tool-1', toolName: 'Read', errorText: 'boom', fingerprint: 'boom' },
        { toolUseId: 'tool-2', toolName: 'Glob', errorText: 'boom', fingerprint: 'boom' },
      ],
    });
  });

  it('returns deduped errors with normalized fingerprints', () => {
    const dedupeNames = new Map([
      ['tool-1', 'Read'],
      ['tool-2', 'Read'],
    ]);
    const result = classifyToolResultContent(
      [
        { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'Boom A' },
        { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'boom  a' },
        { type: 'tool_result', tool_use_id: 'tool-3', is_error: true, content: 'boom b' },
      ],
      dedupeNames,
      160
    );

    expect(result).toEqual({
      kind: 'errors',
      errors: [
        { toolUseId: 'tool-1', toolName: 'Read', errorText: 'Boom A', fingerprint: 'boom a' },
        { toolUseId: 'tool-3', toolName: 'unknown', errorText: 'boom b', fingerprint: 'boom b' },
      ],
    });
  });
});

describe('decideConsecutiveError', () => {
  const base = {
    toolName: 'Read',
    fingerprint: 'boom',
    lastInterventionAt: undefined,
    threshold: 2,
    interventionCooldownMs: 60_000,
    now: 1_000_000,
  };

  it('starts a new streak at 1 below the threshold', () => {
    expect(decideConsecutiveError({ ...base, state: makeState() })).toEqual({
      action: 'count',
      lastError: { toolName: 'Read', fingerprint: 'boom' },
      consecutiveCount: 1,
    });
  });

  it('increments the streak for the same tool and fingerprint', () => {
    const state = makeState({
      lastError: { toolName: 'Read', fingerprint: 'boom' },
      consecutiveCount: 1,
    });
    expect(decideConsecutiveError({ ...base, state, threshold: 3 })).toEqual({
      action: 'count',
      lastError: { toolName: 'Read', fingerprint: 'boom' },
      consecutiveCount: 2,
    });
  });

  it('restarts the streak at 1 for a different tool name', () => {
    const state = makeState({
      lastError: { toolName: 'Glob', fingerprint: 'boom' },
      consecutiveCount: 5,
    });
    expect(decideConsecutiveError({ ...base, state, threshold: 10 })).toEqual({
      action: 'count',
      lastError: { toolName: 'Read', fingerprint: 'boom' },
      consecutiveCount: 1,
    });
  });

  it('intervenes once the streak reaches the threshold', () => {
    const state = makeState({
      lastError: { toolName: 'Read', fingerprint: 'boom' },
      consecutiveCount: 1,
    });
    expect(decideConsecutiveError({ ...base, state })).toEqual({
      action: 'intervene',
      consecutiveCount: 2,
    });
  });

  it('intervenes on the first error when the threshold is 1', () => {
    expect(decideConsecutiveError({ ...base, state: makeState(), threshold: 1 })).toEqual({
      action: 'intervene',
      consecutiveCount: 1,
    });
  });

  it('resets instead of counting while the key is inside its intervention cooldown', () => {
    expect(
      decideConsecutiveError({ ...base, state: makeState(), lastInterventionAt: 999_000 })
    ).toEqual({ action: 'cooldown_reset' });
  });

  it('counts again once the cooldown boundary is reached', () => {
    const decision = decideConsecutiveError({
      ...base,
      state: makeState(),
      lastInterventionAt: 940_000,
    });
    expect(decision).toEqual({
      action: 'count',
      lastError: { toolName: 'Read', fingerprint: 'boom' },
      consecutiveCount: 1,
    });
  });
});

describe('buildRepeatedToolErrorEvidence', () => {
  it('builds the evidence payload with summary and metadata', () => {
    expect(
      buildRepeatedToolErrorEvidence({
        scopeId: 'scope-1',
        toolName: 'Read',
        fingerprint: 'boom',
        count: 2,
      })
    ).toEqual({
      scopeId: 'scope-1',
      summary: 'Repeated tool error: Read failed 2 consecutive times with the same error',
      metadata: { tool: 'Read', error: 'boom', count: 2 },
    });
  });
});

describe('buildRecoveryMessage', () => {
  it('describes the tool, count, and error with remediation guidance', () => {
    expect(buildRecoveryMessage('Read', 'file not found', 2)).toBe(
      '⚠️ Repeated tool error detected: `Read` failed 2 consecutive times with the same error.\n\nError: file not found\n\nStop retrying this operation. Re-validate the arguments, try an alternative path, or ask the operator for help.'
    );
  });

  it('truncates error text past 200 characters with an ellipsis', () => {
    const message = buildRecoveryMessage('Read', 'x'.repeat(250), 3);
    expect(message).toContain(`Error: ${'x'.repeat(200)}…`);
    expect(message).not.toContain('x'.repeat(201));
  });

  it('keeps error text of exactly 200 characters untruncated', () => {
    const message = buildRecoveryMessage('Read', 'x'.repeat(200), 2);
    expect(message).toContain(`Error: ${'x'.repeat(200)}\n`);
    expect(message).not.toContain('…');
  });
});
