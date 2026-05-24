import { describe, expect, test } from 'bun:test';
import { getThinkingOptionsForProvider } from '../../src/types.ts';

describe('getThinkingOptionsForProvider', () => {
  test('returns granular options for anthropic provider by default', () => {
    const options = getThinkingOptionsForProvider('anthropic');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Think 8k' },
      { value: 'think16k', label: 'Think 16k' },
      { value: 'think24k', label: 'Think 24k' },
      { value: 'think32k', label: 'Think 32k' },
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

  test('defaults to granular for unknown providers', () => {
    const options = getThinkingOptionsForProvider('unknown-provider');
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Think 8k' },
      { value: 'think16k', label: 'Think 16k' },
      { value: 'think24k', label: 'Think 24k' },
      { value: 'think32k', label: 'Think 32k' },
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
      { value: 'think8k', label: 'Think 8k' },
      { value: 'think16k', label: 'Think 16k' },
      { value: 'think24k', label: 'Think 24k' },
      { value: 'think32k', label: 'Think 32k' },
    ]);
  });

  test('handles undefined provider', () => {
    const options = getThinkingOptionsForProvider(undefined);
    expect(options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'think8k', label: 'Think 8k' },
      { value: 'think16k', label: 'Think 16k' },
      { value: 'think24k', label: 'Think 24k' },
      { value: 'think32k', label: 'Think 32k' },
    ]);
  });
});
