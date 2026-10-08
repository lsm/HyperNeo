import { describe, expect, it } from 'bun:test';
import type { CopilotClient } from '@github/copilot-sdk';
import {
  createReasoningSupport,
  fitReasoningEffort,
  reasoningEffortForLevel,
} from '../../../../../src/lib/providers/anthropic-copilot/reasoning-effort';

describe('reasoningEffortForLevel', () => {
  it('maps each HyperNeo thinking level to an effort, and nothing without a level', () => {
    expect(
      ['off', 'think8k', 'think16k', 'think24k', 'think32k'].map(reasoningEffortForLevel)
    ).toEqual(['low', 'low', 'medium', 'high', 'xhigh']);
    expect(reasoningEffortForLevel(undefined)).toBeUndefined();
  });
});

describe('fitReasoningEffort', () => {
  it('uses the highest supported effort at or below the request, else the lowest', () => {
    expect(fitReasoningEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
    expect(fitReasoningEffort('medium', ['high', 'low'])).toBe('low');
    expect(fitReasoningEffort('low', ['medium', 'high'])).toBe('medium');
    expect(fitReasoningEffort('high', [])).toBeUndefined();
    expect(fitReasoningEffort(undefined, ['low'])).toBeUndefined();
  });
});

describe('createReasoningSupport', () => {
  it('lists models once per window and reports none for models without reasoning', async () => {
    let listings = 0;
    let now = 0;
    const client = {
      listModels: async () => {
        listings++;
        return [
          {
            id: 'gpt-5.5',
            capabilities: { supports: { reasoningEffort: true } },
            supportedReasoningEfforts: ['low', 'high'],
          },
          { id: 'gemini', capabilities: { supports: { reasoningEffort: false } } },
        ];
      },
    } as unknown as CopilotClient;
    const support = createReasoningSupport(client, () => now);
    expect(await support('gpt-5.5')).toEqual(['low', 'high']);
    expect(await support('gemini')).toEqual([]);
    expect(listings).toBe(1);
    now += 11 * 60_000;
    await support('gpt-5.5');
    expect(listings).toBe(2);
  });
});
