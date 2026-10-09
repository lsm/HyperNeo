import { describe, expect, test } from 'bun:test';
import {
  THINKING_LEVEL_TOKENS,
  effortForThinkingLevel,
  getThinkingLevelsForModel,
  getThinkingOptionsForProvider,
  normalizeThinkingLevel,
} from '../../src/types.ts';

describe('getThinkingOptionsForProvider', () => {
  test('returns granular options for anthropic provider by default', () => {
    const options = getThinkingOptionsForProvider('anthropic');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Low' },
      { value: 'think16k', label: 'Medium' },
      { value: 'think24k', label: 'High' },
      { value: 'think32k', label: 'Extra High' },
      { value: 'think48k', label: 'Max' },
      { value: 'think64k', label: 'Ultra' },
    ]);
  });

  test('returns on/off options for kimi provider by default', () => {
    const options = getThinkingOptionsForProvider('kimi');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think32k', label: 'On' },
    ]);
  });

  test('returns empty array for providers that do not support thinking', () => {
    const options = getThinkingOptionsForProvider('minimax');
    expect(options).toEqual([]);
  });

  test('returns granular options for opencode by default', () => {
    const options = getThinkingOptionsForProvider('opencode');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Low' },
      { value: 'think16k', label: 'Medium' },
      { value: 'think24k', label: 'High' },
      { value: 'think32k', label: 'Extra High' },
      { value: 'think48k', label: 'Max' },
      { value: 'think64k', label: 'Ultra' },
    ]);
  });

  test('defaults to granular for unknown providers', () => {
    const options = getThinkingOptionsForProvider('unknown-provider');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Low' },
      { value: 'think16k', label: 'Medium' },
      { value: 'think24k', label: 'High' },
      { value: 'think32k', label: 'Extra High' },
      { value: 'think48k', label: 'Max' },
      { value: 'think64k', label: 'Ultra' },
    ]);
  });

  test('explicit off mode overrides provider default', () => {
    const options = getThinkingOptionsForProvider('anthropic', 'off');
    expect(options).toEqual([]);
  });

  test('explicit on mode overrides provider default', () => {
    const options = getThinkingOptionsForProvider('minimax', 'on');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think32k', label: 'On' },
    ]);
  });

  test('explicit granular mode overrides provider default', () => {
    const options = getThinkingOptionsForProvider('kimi', 'granular');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Low' },
      { value: 'think16k', label: 'Medium' },
      { value: 'think24k', label: 'High' },
      { value: 'think32k', label: 'Extra High' },
      { value: 'think48k', label: 'Max' },
      { value: 'think64k', label: 'Ultra' },
    ]);
  });

  test('handles undefined provider', () => {
    const options = getThinkingOptionsForProvider(undefined);
    expect(options).toEqual([
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

describe('getThinkingLevelsForModel', () => {
  test('lists only levels whose effort the model supports and drops Ultra', () => {
    expect(
      getThinkingLevelsForModel('anthropic', 'granular', ['low', 'medium', 'high', 'xhigh', 'max'])
    ).toEqual(['off', 'think8k', 'think16k', 'think24k', 'think32k', 'think48k']);
    expect(getThinkingLevelsForModel('anthropic', 'granular', ['low', 'medium', 'high'])).toEqual([
      'off',
      'think8k',
      'think16k',
      'think24k',
    ]);
    expect(getThinkingLevelsForModel('anthropic', 'granular', undefined)).toHaveLength(7);
    expect(getThinkingLevelsForModel('anthropic', 'on', ['low'])).toEqual(['off', 'think32k']);
  });
});
