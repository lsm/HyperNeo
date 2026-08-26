import { describe, expect, test } from 'bun:test';
import {
  contextBudgetThreshold,
  decideContextBudgetCompaction,
  gateBelowThreshold,
  gateCooldown,
  gateCompactFinal,
  gateCompacting,
  gateNoWindow,
  gatePercentDisabled,
  scaledAutoCompactWindow,
  type ContextBudgetCtx,
} from '../../../../src/lib/agent/context-budget-decision';

const WINDOW = 256_000;

function baseInput(overrides: Partial<Omit<ContextBudgetCtx, 'decision'>> = {}) {
  return {
    totalUsed: 0,
    configuredWindow: WINDOW,
    autoCompactPercent: undefined,
    sdkAutoCompactEnabled: undefined,
    sdkAutoCompactThreshold: undefined,
    cooldownActive: false,
    compactingActive: false,
    ...overrides,
  };
}

describe('decideContextBudgetCompaction', () => {
  test('no valid window short-circuits every downstream arm', () => {
    for (const configuredWindow of [undefined, 0, -1, Number.NaN]) {
      expect(
        decideContextBudgetCompaction(baseInput({ configuredWindow, totalUsed: 999_999 }))
      ).toEqual({ action: 'none', reason: 'no_window' });
    }
  });

  test('percent 100 disables the daemon backstop entirely', () => {
    expect(
      decideContextBudgetCompaction(baseInput({ autoCompactPercent: 100, totalUsed: 999_999 }))
    ).toEqual({ action: 'none', reason: 'percent_disabled' });
  });

  test('cooldown suppresses an over-threshold trigger', () => {
    expect(
      decideContextBudgetCompaction(baseInput({ totalUsed: 240_000, cooldownActive: true }))
    ).toEqual({ action: 'none', reason: 'cooldown_active' });
  });

  test('an in-flight compaction suppresses the backstop', () => {
    expect(
      decideContextBudgetCompaction(baseInput({ totalUsed: 240_000, compactingActive: true }))
    ).toEqual({ action: 'none', reason: 'compaction_in_progress' });
  });

  test('below the default 90% threshold stays quiet', () => {
    expect(decideContextBudgetCompaction(baseInput({ totalUsed: 230_399 }))).toEqual({
      action: 'none',
      reason: 'below_threshold',
    });
  });

  test('at the exact default threshold with unknown SDK state compacts', () => {
    expect(decideContextBudgetCompaction(baseInput({ totalUsed: 230_400 }))).toEqual({
      action: 'compact',
      reason: 'over_threshold_sdk_unknown',
    });
  });

  test('a custom percent scales the threshold', () => {
    const input = { autoCompactPercent: 70 };
    expect(decideContextBudgetCompaction(baseInput({ ...input, totalUsed: 179_199 }))).toEqual({
      action: 'none',
      reason: 'below_threshold',
    });
    expect(decideContextBudgetCompaction(baseInput({ ...input, totalUsed: 179_200 }))).toEqual({
      action: 'compact',
      reason: 'over_threshold_sdk_unknown',
    });
  });

  test('out-of-range percents clamp before computing the threshold', () => {
    const low = { autoCompactPercent: 3 };
    expect(contextBudgetThreshold(WINDOW, low.autoCompactPercent)).toBe(25_600);
    expect(decideContextBudgetCompaction(baseInput({ ...low, totalUsed: 25_599 }))).toEqual({
      action: 'none',
      reason: 'below_threshold',
    });
    expect(decideContextBudgetCompaction(baseInput({ ...low, totalUsed: 25_600 }))).toEqual({
      action: 'compact',
      reason: 'over_threshold_sdk_unknown',
    });
    expect(
      decideContextBudgetCompaction(baseInput({ autoCompactPercent: 120, totalUsed: 999_999 }))
    ).toEqual({ action: 'none', reason: 'percent_disabled' });
  });

  test('an SDK threshold at or below ours with usage past ours fires the backstop (SDK missed)', () => {
    expect(
      decideContextBudgetCompaction(
        baseInput({
          totalUsed: 240_000,
          sdkAutoCompactEnabled: true,
          sdkAutoCompactThreshold: 230_400,
        })
      )
    ).toEqual({ action: 'compact', reason: 'over_threshold_sdk_missed' });
    expect(
      decideContextBudgetCompaction(
        baseInput({
          totalUsed: 240_000,
          sdkAutoCompactEnabled: true,
          sdkAutoCompactThreshold: 200_000,
        })
      )
    ).toEqual({ action: 'compact', reason: 'over_threshold_sdk_missed' });
  });

  test('an SDK threshold later than ours but already crossed by usage is treated as missed', () => {
    expect(
      decideContextBudgetCompaction(
        baseInput({
          totalUsed: 240_000,
          sdkAutoCompactEnabled: true,
          sdkAutoCompactThreshold: 230_401,
        })
      )
    ).toEqual({ action: 'compact', reason: 'over_threshold_sdk_missed' });
  });

  test('an SDK threshold beyond current usage lets the daemon act first', () => {
    expect(
      decideContextBudgetCompaction(
        baseInput({
          totalUsed: 240_000,
          sdkAutoCompactEnabled: true,
          sdkAutoCompactThreshold: 250_000,
        })
      )
    ).toEqual({ action: 'compact', reason: 'over_threshold_sdk_later' });
  });

  test('SDK auto-compact explicitly disabled hands the net to the daemon', () => {
    expect(
      decideContextBudgetCompaction(baseInput({ totalUsed: 240_000, sdkAutoCompactEnabled: false }))
    ).toEqual({ action: 'compact', reason: 'over_threshold_sdk_disabled' });
  });

  test('SDK enabled with unknown threshold still compacts (the swe-1-7 incident shape)', () => {
    expect(
      decideContextBudgetCompaction(baseInput({ totalUsed: 240_000, sdkAutoCompactEnabled: true }))
    ).toEqual({ action: 'compact', reason: 'over_threshold_sdk_unknown' });
  });

  test('first terminal wins: cooldown beats compacting and both beat compaction', () => {
    expect(
      decideContextBudgetCompaction(
        baseInput({ totalUsed: 240_000, cooldownActive: true, compactingActive: true })
      )
    ).toEqual({ action: 'none', reason: 'cooldown_active' });
    expect(
      decideContextBudgetCompaction(
        baseInput({
          totalUsed: 240_000,
          compactingActive: true,
          sdkAutoCompactEnabled: false,
        })
      )
    ).toEqual({ action: 'none', reason: 'compaction_in_progress' });
  });
});

describe('gate pass-through identity', () => {
  const undecided = baseInput({ totalUsed: 240_000 }) as ContextBudgetCtx;
  const ctx = { ...undecided, decision: null };

  function expectIdentity(gate: (input: ContextBudgetCtx) => ContextBudgetCtx): void {
    const returned = gate(ctx);
    expect(returned).toBe(ctx);
    expect(ctx.decision).toBeNull();
  }

  test('each pass-through gate returns the identical ctx object', () => {
    expectIdentity(gateNoWindow);
    expectIdentity(gatePercentDisabled);
    expectIdentity(gateCooldown);
    expectIdentity(gateCompacting);
    expectIdentity(gateBelowThreshold);
  });

  test('the final gate always decides', () => {
    const decided = gateCompactFinal(ctx);
    expect(decided.decision).not.toBeNull();
    expect(decided).not.toBe(ctx);
  });
});

describe('scaledAutoCompactWindow', () => {
  test('invalid windows return undefined', () => {
    for (const window of [undefined, null, 0, -5, Number.NaN]) {
      expect(scaledAutoCompactWindow(window)).toBeUndefined();
    }
  });

  test('scales by the resolved percent', () => {
    expect(scaledAutoCompactWindow(262_144)).toBe(235_929);
    expect(scaledAutoCompactWindow(262_144, 70)).toBe(183_500);
  });

  test('percent 100 is identity', () => {
    expect(scaledAutoCompactWindow(262_144, 100)).toBe(262_144);
  });

  test('junk percents clamp first', () => {
    expect(scaledAutoCompactWindow(100_000, 2)).toBe(10_000);
    expect(scaledAutoCompactWindow(100_000, 250)).toBe(100_000);
  });
});
