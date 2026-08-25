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
  ...overrides,
});

const withFlags = (overrides: Partial<TurnEndFlags> = {}): TurnEndFlags => ({
  ...resetTurnEndFlags,
  ...overrides,
});

const same = (
  flags: TurnEndFlags
): { nextFlags: TurnEndFlags; afterEffectsFlags: TurnEndFlags } => ({
  nextFlags: flags,
  afterEffectsFlags: flags,
});

const base: TurnEndPlan = {
  idleFence: false,
  earlySetIdle: false,
  finishTurn: false,
  allowQueueReplay: false,
  setIdleSuppressed: false,
  resetThinkingTokens: false,
  cancelSuppressedTimer: false,
  clearSuppression: false,
  settleSuppressedWaiter: null,
  rearmSuppressedTimer: false,
  nextFlags: resetTurnEndFlags,
  afterEffectsFlags: resetTurnEndFlags,
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
    isLimitError: false,
    isLimitRecoveryEngaged: false,
    confirmsArmedClear: false,
    ...overrides,
  },
});

const session = (state: 'idle' | 'running' | 'requires_action'): TurnEndEvent => ({
  kind: 'sessionState',
  state,
});

const success = { ...resetTurnEndFlags, lastResultWasSuccess: true };
const failure = { ...resetTurnEndFlags, lastResultWasSuccess: false };

const armedForIdle = (overrides: Partial<TurnEndFlags> = {}): TurnEndFlags => ({
  ...resetTurnEndFlags,
  usesSessionStateChangedTurnEnd: true,
  ...overrides,
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
        ...same(success),
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
        ...same(success),
      },
    },
    {
      label: 'legacy error: fence and direct idle but no replay',
      event: result({ isSuccess: false }),
      expected: {
        idleFence: true,
        earlySetIdle: true,
        resetThinkingTokens: true,
        ...same(failure),
      },
    },
    {
      label: 'a non-idle session-state event arms the idle expectation',
      event: session('running'),
      expected: {
        ...same(
          withFlags({
            usesSessionStateChangedTurnEnd: true,
            expectsSessionStateIdleAfterResult: true,
          })
        ),
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
      expected: {
        finishTurn: true,
        allowQueueReplay: true,
        resetThinkingTokens: true,
        nextFlags: armedForIdle({
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: true,
        }),
        afterEffectsFlags: resetTurnEndFlags,
      },
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
      expected: {
        finishTurn: true,
        allowQueueReplay: false,
        resetThinkingTokens: true,
        nextFlags: armedForIdle({
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: true,
        }),
        afterEffectsFlags: resetTurnEndFlags,
      },
    },
    {
      label: 'a session-state idle after an error does not replay',
      flags: {
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: false,
      },
      event: session('idle'),
      expected: {
        finishTurn: true,
        allowQueueReplay: false,
        resetThinkingTokens: true,
        nextFlags: armedForIdle({
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: false,
        }),
        afterEffectsFlags: resetTurnEndFlags,
      },
    },
    {
      label: 'a suppressed success keeps suppression through awaited effects then clears it',
      flags: { suppressIdleOnNextResult: true },
      event: result({ confirmsArmedClear: true }),
      expected: {
        resetThinkingTokens: true,
        cancelSuppressedTimer: true,
        settleSuppressedWaiter: 'confirmed',
        nextFlags: {
          ...resetTurnEndFlags,
          lastResultWasSuccess: true,
          suppressIdleOnNextResult: true,
        },
        afterEffectsFlags: success,
      },
    },
    {
      label: 'a suppressed error with a clear in flight unwinds every flag',
      flags: { suppressIdleOnNextResult: true, clearMessageInFlight: true },
      event: result({ isSuccess: false, confirmsArmedClear: true }),
      expected: {
        resetThinkingTokens: true,
        cancelSuppressedTimer: true,
        clearSuppression: true,
        settleSuppressedWaiter: 'reset',
        nextFlags: {
          ...resetTurnEndFlags,
          lastResultWasSuccess: false,
          suppressIdleOnNextResult: true,
          clearMessageInFlight: true,
        },
        afterEffectsFlags: resetTurnEndFlags,
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
        cancelSuppressedTimer: true,
        rearmSuppressedTimer: true,
        nextFlags: {
          ...resetTurnEndFlags,
          lastResultWasSuccess: true,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          suppressIdleOnNextResult: true,
          clearMessageInFlight: true,
        },
        afterEffectsFlags: {
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
      expected: {
        finishTurn: true,
        allowQueueReplay: true,
        resetThinkingTokens: true,
        nextFlags: armedForIdle(),
        afterEffectsFlags: resetTurnEndFlags,
      },
    },
    {
      label: 'a nested result defers finish and replay to the idle event',
      event: result({ isTopLevel: false, isSuccess: true }),
      expected: { ...same(resetTurnEndFlags) },
    },
    {
      label: 'a pre-recovery limit error only resets thinking tokens',
      event: result({ isLimitError: true, isLimitRecoveryEngaged: null }),
      expected: {
        resetThinkingTokens: true,
        ...same(failure),
      },
    },
    {
      label: 'a detected limit error with declined recovery marks failure and skips replay',
      event: result({ isLimitError: true, isLimitRecoveryEngaged: false }),
      expected: {
        idleFence: true,
        earlySetIdle: true,
        finishTurn: true,
        allowQueueReplay: false,
        ...same(failure),
      },
    },
    {
      label: 'an engaged limit recovery skips turn-end action and replay',
      event: result({ isLimitError: true, isLimitRecoveryEngaged: true }),
      expected: {
        ...same(failure),
      },
    },
    {
      label: 'a suppressed idle event uses the suppressed setIdle transition',
      flags: { suppressIdleOnNextResult: true },
      event: session('idle'),
      expected: {
        setIdleSuppressed: true,
        resetThinkingTokens: true,
        nextFlags: armedForIdle({ suppressIdleOnNextResult: true }),
        afterEffectsFlags: withFlags({ suppressIdleOnNextResult: true }),
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
        nextFlags: armedForIdle({ clearAwaitingTrailingIdle: true }),
        afterEffectsFlags: resetTurnEndFlags,
      },
    },
    {
      label: 'a clear-awaiting idle with clear-in-flight also clears the sent flag',
      flags: { clearAwaitingTrailingIdle: true, clearMessageInFlight: true },
      event: session('idle'),
      expected: {
        setIdleSuppressed: true,
        resetThinkingTokens: true,
        settleSuppressedWaiter: 'confirmed',
        nextFlags: armedForIdle({ clearAwaitingTrailingIdle: true, clearMessageInFlight: true }),
        afterEffectsFlags: resetTurnEndFlags,
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
