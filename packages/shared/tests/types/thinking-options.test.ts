import { describe, expect, test } from 'bun:test';
import {
  THINKING_LEVEL_TOKENS,
  effortForThinkingLevel,
  normalizeThinkingLevel,
  THINKING_OPTIONS,
} from '../../src/types.ts';

describe('THINKING_OPTIONS', () => {
  test('lists every level for every model, from Off to Ultra', () => {
    expect(THINKING_OPTIONS).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Low' },
      { value: 'think16k', label: 'Medium' },
      { value: 'think24k', label: 'High' },
      { value: 'think32k', label: 'Extra High' },
      { value: 'think48k', label: 'Max' },
      { value: 'think64k', label: 'Ultra' },
    ]);
  });
});

describe('normalizeThinkingLevel', () => {
  test('keeps every current level, including the new top tiers', () => {
    for (const level of [
      'off',
      'think8k',
      'think16k',
      'think24k',
      'think32k',
      'think48k',
      'think64k',
    ] as const)
      expect(normalizeThinkingLevel(level)).toBe(level);
  });

  test('maps legacy and unknown values to off', () => {
    expect(normalizeThinkingLevel('auto')).toBe('off');
    expect(normalizeThinkingLevel('think128k')).toBe('off');
    expect(normalizeThinkingLevel(undefined)).toBe('off');
  });

  test('gives the top tiers larger budgets than Extra High', () => {
    expect(THINKING_LEVEL_TOKENS.think48k).toBe(48000);
    expect(THINKING_LEVEL_TOKENS.think64k).toBe(63999);
  });
});

describe('effortForThinkingLevel', () => {
  test('maps each level to its effort and steps down to the nearest supported one', () => {
    const all = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    expect(effortForThinkingLevel('off', all)).toBeUndefined();
    expect(effortForThinkingLevel('think8k', all)).toBe('low');
    expect(effortForThinkingLevel('think32k', all)).toBe('xhigh');
    expect(effortForThinkingLevel('think64k', all)).toBe('max');
    expect(effortForThinkingLevel('think32k', ['low', 'medium', 'high'])).toBe('high');
  });
});
