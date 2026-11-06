import { describe, expect, it } from 'vitest';
import { selectSessionEngine } from '../../../../src/lib/agent/session-engine';

describe('selectSessionEngine', () => {
  it('selects the SDK when harness is absent', () => {
    expect(selectSessionEngine(undefined)).toBe('sdk');
  });

  it('selects supported harnesses and rejects unknown values', () => {
    expect(selectSessionEngine('sdk')).toBe('sdk');
    expect(selectSessionEngine('codex')).toBe('codex');
    expect(() => selectSessionEngine('unknown')).toThrow();
  });
});
