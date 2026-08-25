import { describe, expect, it } from 'bun:test';
import {
  resetTurnEndFlags,
  routeTurnEnd,
  type TurnEndContext,
  type TurnEndEvent,
  type TurnEndFlags,
  type TurnEndPlan,
  type TurnEndResultEvent,
} from '../../../../src/lib/agent/turn-end-routing';

const ctx = (overrides: Partial<TurnEndContext> = {}): TurnEndContext => ({
  queryMode: 'immediate',
  inRateLimitCooldown: false,
  limitRecoveryPending: false,
  ...overrides,
});

const withFlags = (overrides: Partial<TurnEndFlags> = {}): TurnEndFlags => ({
  ...resetTurnEndFlags,
  ...overrides,
});

const base: TurnEndPlan = {
  idleFence: false,
  earlySetIdle: false,
  finishTurn: false,
  allowQueueReplay: false,
  setIdleSuppressed: false,
  resetThinkingTokens: false,
  clearSuppression: false,
  settleSuppressedWaiter: null,
  rearmSuppressedTimer: false,
  nextFlags: resetTurnEndFlags,
};

type Row = {
  label: string;
  flags?: Partial<TurnEndFlags>;
  event: TurnEndEvent;
  ctx?: Partial<TurnEndContext>;
  expected: Partial<TurnEndPlan>;
};

const result = (overrides: Partial<TurnEndResultEvent> = {}): TurnEndEvent => ({
  kind: 'result',
  result: {
    isTopLevel: true,
    isSuccess: true,
    isLimitEngaged: false,
    confirmsArmedClear: false,
    ...overrides,
  },
});

const session = (state: 'idle' | 'running' | 'requires_action'): TurnEndEvent => ({
  kind: 'sessionState',
  state,
});

describe('routeTurnEnd', () => {
  const ROWS: Row[] = [
    {
      label: 'legacy success: fence, direct idle, finish, and replay',
      event: result(),
      expected: {
        idleFence: true,
        earlySetIdle: true,
        finishTurn: true,
        allowQueueReplay: true,
        resetThinkingTokens: true,
        nextFlags: { ...resetTurnEndFlags, lastResultWasSuccess: true },
      },
    },
    {
      label: 'manual mode blocks the replay gate on a legacy success',
      event: result(),
      ctx: { queryMode: 'manual' },
      expected: {
        idleFence: true,
        earlySetIdle: true,
        finishTurn: true,
        allowQueueReplay: false,
        resetThinkingTokens: true,
        nextFlags: { ...resetTurnEndFlags, lastResultWasSuccess: true },
      },
    },
    {
      label: 'legacy error: fence and direct idle but no replay',
      event: result({ isSuccess: false }),
      expected: {
        idleFence: true,
        earlySetIdle: true,
        resetThinkingTokens: true,
        nextFlags: { ...resetTurnEndFlags, lastResultWasSuccess: false },
      },
    },
    {
      label: 'a non-idle session-state event arms the idle expectation',
      event: session('running'),
      expected: {
        nextFlags: withFlags({
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        }),
      },
    },
    {
      label: 'a session-state idle event finishes the turn and replays on success',
      flags: {
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
      },
      event: session('idle'),
      expected: { finishTurn: true, allowQueueReplay: true, resetThinkingTokens: true },
    },
    {
      label: 'manual mode blocks replay on a session-state idle finish',
      flags: {
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
      },
      event: session('idle'),
      ctx: { queryMode: 'manual' },
      expected: { finishTurn: true, allowQueueReplay: false, resetThinkingTokens: true },
    },
    {
      label: 'a session-state idle after an error does not replay',
      flags: {
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: false,
      },
      event: session('idle'),
      expected: { finishTurn: true, allowQueueReplay: false, resetThinkingTokens: true },
    },
    {
      label: 'a suppressed success confirms and clears the suppression flags',
      flags: { suppressIdleOnNextResult: true },
      event: result({ confirmsArmedClear: true }),
      expected: {
        resetThinkingTokens: true,
        settleSuppressedWaiter: 'confirmed',
        nextFlags: { ...resetTurnEndFlags, lastResultWasSuccess: true },
      },
    },
    {
      label: 'a suppressed error with a clear in flight unwinds every flag',
      flags: { suppressIdleOnNextResult: true, clearMessageInFlight: true },
      event: result({ isSuccess: false, confirmsArmedClear: true }),
      expected: {
        resetThinkingTokens: true,
        clearSuppression: true,
        settleSuppressedWaiter: 'reset',
        nextFlags: resetTurnEndFlags,
      },
    },
    {
      label: 'a session-state success matching a clear rearms for the trailing idle',
      flags: {
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
      },
      event: result({ confirmsArmedClear: true }),
      expected: {
        resetThinkingTokens: true,
        rearmSuppressedTimer: true,
        nextFlags: {
          ...resetTurnEndFlags,
          lastResultWasSuccess: true,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          clearAwaitingTrailingIdle: true,
          clearMessageInFlight: true,
        },
      },
    },
    {
      label: 'an idle event with no prior result still finishes and replays',
      event: session('idle'),
      expected: { finishTurn: true, allowQueueReplay: true, resetThinkingTokens: true },
    },
    {
      label: 'a nested result defers finish and replay to the idle event',
      event: result({ isTopLevel: false, isSuccess: true }),
      expected: {},
    },
    {
      label: 'rate-limit cooldown and recovery pending block finishTurn',
      event: result(),
      ctx: { inRateLimitCooldown: true, limitRecoveryPending: true },
      expected: {
        idleFence: true,
        earlySetIdle: true,
        resetThinkingTokens: true,
        nextFlags: { ...resetTurnEndFlags, lastResultWasSuccess: true },
      },
    },
    {
      label: 'a suppressed idle event uses the suppressed setIdle transition',
      flags: { suppressIdleOnNextResult: true },
      event: session('idle'),
      expected: {
        setIdleSuppressed: true,
        resetThinkingTokens: true,
        nextFlags: withFlags({ suppressIdleOnNextResult: true }),
      },
    },
    {
      label: 'a clear-awaiting idle event confirms and resets every flag',
      flags: { clearAwaitingTrailingIdle: true },
      event: session('idle'),
      expected: {
        setIdleSuppressed: true,
        resetThinkingTokens: true,
        settleSuppressedWaiter: 'confirmed',
        nextFlags: resetTurnEndFlags,
      },
    },
  ];

  for (const row of ROWS) {
    it(row.label, () => {
      expect(routeTurnEnd(withFlags(row.flags), row.event, ctx(row.ctx))).toEqual({
        ...base,
        ...row.expected,
      });
    });
  }
});
