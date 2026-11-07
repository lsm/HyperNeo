import { describe, expect, it } from 'vitest';
import { codexSessionRefusal, selectSessionEngine } from '../../../../src/lib/agent/session-engine';

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

describe('codexSessionRefusal', () => {
  it('refuses Neo root sessions while allowing an ordinary unattended-free session', () => {
    const config = { harness: 'codex' } as const;
    expect(codexSessionRefusal(config, false, true)).toMatch(/Neo/);
    expect(codexSessionRefusal(config, false, false)).toBeUndefined();
  });
});
