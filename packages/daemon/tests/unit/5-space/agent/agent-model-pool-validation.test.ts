import { describe, expect, test } from 'bun:test';
import { validateAgentModelPool } from '../../../../src/lib/space/agents/agent-validation';

const entry = (overrides: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5',
  maxConcurrent: 1,
  weight: 1,
  ...overrides,
});

describe('validateAgentModelPool thinkingLevel', () => {
  test('accepts an entry without a thinking level', async () => {
    expect(await validateAgentModelPool([entry()])).toBeNull();
  });

  test('accepts a null thinking level', async () => {
    expect(await validateAgentModelPool([entry({ thinkingLevel: null })])).toBeNull();
  });

  test.each(['off', 'think8k', 'think16k', 'think24k', 'think32k'])('accepts %s', async (level) => {
    expect(await validateAgentModelPool([entry({ thinkingLevel: level })])).toBeNull();
  });

  test('rejects an unknown thinking level', async () => {
    const error = await validateAgentModelPool([entry({ thinkingLevel: 'think99k' })]);
    expect(error).toBe(
      'Model pool entry for "claude-opus-5" has an invalid thinkingLevel: think99k'
    );
  });

  test('rejects a non-string thinking level', async () => {
    const error = await validateAgentModelPool([entry({ thinkingLevel: 16000 })]);
    expect(error).toBe('Model pool entry for "claude-opus-5" has an invalid thinkingLevel: 16000');
  });

  test('reports the offending entry when a later entry is invalid', async () => {
    const error = await validateAgentModelPool([
      entry({ thinkingLevel: 'off' }),
      entry({ model: 'claude-sonnet-5', thinkingLevel: 'auto' }),
    ]);
    expect(error).toBe('Model pool entry for "claude-sonnet-5" has an invalid thinkingLevel: auto');
  });

  test('still enforces the pre-existing entry rules', async () => {
    expect(await validateAgentModelPool([entry({ maxConcurrent: 0 })])).toContain('maxConcurrent');
    expect(await validateAgentModelPool([entry({ weight: 0 })])).toBe(
      'Model pool must have at least one entry with weight > 0'
    );
  });
});
