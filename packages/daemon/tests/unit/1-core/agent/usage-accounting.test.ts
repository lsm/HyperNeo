import { describe, it, expect } from 'bun:test';
import {
  recordResultUsage,
  commitPendingCost,
  type UsageAccountingState,
} from '../../../../src/lib/agent/usage-accounting';

const zeroState: UsageAccountingState = {
  messageCount: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
  toolCallCount: 0,
  lastSdkCost: 0,
  costBaseline: 0,
};

const buildResult = (input: number, output: number, cost: number) => ({
  usage: { input_tokens: input, output_tokens: output },
  total_cost_usd: cost,
});

describe('recordResultUsage', () => {
  it('accumulates tokens and cost from the first result', () => {
    expect(recordResultUsage(zeroState, buildResult(10, 5, 1.25))).toEqual({
      ...zeroState,
      messageCount: 1,
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      totalCost: 1.25,
      lastSdkCost: 1.25,
    });
  });

  it('continues accumulating while the reported cost rises', () => {
    const first = recordResultUsage(zeroState, buildResult(10, 5, 1.25));
    expect(recordResultUsage(first, buildResult(2, 3, 2.5))).toEqual({
      ...first,
      messageCount: 2,
      totalTokens: 20,
      inputTokens: 12,
      outputTokens: 8,
      totalCost: 2.5,
      lastSdkCost: 2.5,
    });
  });

  it('adds the previous cost to the baseline when the reported cost drops', () => {
    const first = recordResultUsage(zeroState, buildResult(10, 5, 2.5));
    expect(recordResultUsage(first, buildResult(1, 1, 1))).toEqual({
      ...first,
      messageCount: 2,
      totalTokens: 17,
      inputTokens: 11,
      outputTokens: 6,
      costBaseline: 2.5,
      totalCost: 3.5,
      lastSdkCost: 1,
    });
  });

  it('preserves tool call count and defaults missing values', () => {
    const state = { ...zeroState, toolCallCount: 7 };
    expect(recordResultUsage(state, { usage: {} })).toEqual({
      ...state,
      messageCount: 1,
      lastSdkCost: 0,
      totalCost: 0,
    });
  });
});

describe('commitPendingCost', () => {
  it('moves the last SDK cost into the baseline and clears it', () => {
    const state = { ...zeroState, costBaseline: 1, lastSdkCost: 2.5, totalCost: 3.5 };
    expect(commitPendingCost(state)).toEqual({
      ...state,
      costBaseline: 3.5,
      lastSdkCost: 0,
      totalCost: 3.5,
    });
  });

  it('leaves the state unchanged when there is no pending cost', () => {
    const state = { ...zeroState, costBaseline: 1, lastSdkCost: 0, totalCost: 1 };
    expect(commitPendingCost(state)).toBe(state);
  });
});
