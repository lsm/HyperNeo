import { describe, expect, it } from 'vitest';
import { isOxapHarness, OXAP_HARNESSES } from '@hyperneo/shared/types/oxap-harnesses';
import { codexSessionRefusal, selectSessionEngine } from '../../../../src/lib/agent/session-engine';

describe('selectSessionEngine', () => {
  it('selects the SDK when harness is absent', () => {
    expect(selectSessionEngine(undefined)).toBe('sdk');
  });

  it('selects supported harnesses and rejects unknown values', () => {
    expect(selectSessionEngine('sdk')).toBe('sdk');
    expect(selectSessionEngine('oxap-codex')).toBe('oxap-codex');
    expect(() => selectSessionEngine('unknown')).toThrow();
    expect(() => selectSessionEngine('codex')).toThrow();
  });
});

describe('isOxapHarness', () => {
  it('is true for every OXAP_HARNESSES id and false for the SDK and unknown values', () => {
    for (const id of Object.keys(OXAP_HARNESSES)) expect(isOxapHarness(id)).toBe(true);
    expect(isOxapHarness('oxap-codex')).toBe(true);
    for (const other of ['sdk', 'codex', undefined, 'toString']) {
      expect(isOxapHarness(other)).toBe(false);
    }
  });
});

describe('codexSessionRefusal', () => {
  it('refuses Neo root sessions while allowing an ordinary unattended-free session', () => {
    const config = { harness: 'oxap-codex' } as const;
    expect(codexSessionRefusal(config, false, true)).toMatch(/Neo/);
    expect(codexSessionRefusal(config, false, false)).toBeUndefined();
  });
});
