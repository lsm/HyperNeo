export type TurnEndFlags = {
  suppressIdleOnNextResult: boolean;
  usesSessionStateChangedTurnEnd: boolean;
  expectsSessionStateIdleAfterResult: boolean;
  lastResultWasSuccess: boolean | null;
  clearAwaitingTrailingIdle: boolean;
  clearMessageInFlight: boolean;
};

export const resetTurnEndFlags: TurnEndFlags = {
  suppressIdleOnNextResult: false,
  usesSessionStateChangedTurnEnd: false,
  expectsSessionStateIdleAfterResult: false,
  lastResultWasSuccess: null,
  clearAwaitingTrailingIdle: false,
  clearMessageInFlight: false,
};

export type TurnEndResultEvent = {
  isTopLevel: boolean;
  isSuccess: boolean;
  isLimitError: boolean;
  isLimitRecoveryEngaged: boolean | null;
  confirmsArmedClear: boolean;
};

export type TurnEndEvent =
  | { kind: 'result'; result: TurnEndResultEvent }
  | { kind: 'sessionState'; state: 'idle' | 'running' | 'requires_action' };

export type TurnEndPlan = {
  idleFence: boolean;
  earlySetIdle: boolean;
  finishTurn: boolean;
  allowQueueReplay: boolean;
  setIdleSuppressed: boolean;
  resetThinkingTokens: boolean;
  cancelSuppressedTimer: boolean;
  clearSuppression: boolean;
  settleSuppressedWaiter: 'confirmed' | 'reset' | null;
  rearmSuppressedTimer: boolean;
  nextFlags: TurnEndFlags;
  afterEffectsFlags: TurnEndFlags;
};

export type TurnEndContext = {
  queryMode: 'immediate' | 'manual';
};

function canReplay(
  lastResultWasSuccess: boolean | null,
  queryMode: 'immediate' | 'manual'
): boolean {
  return lastResultWasSuccess !== false && queryMode !== 'manual';
}

function makePlan(
  nextFlags: TurnEndFlags,
  plan: Partial<Omit<TurnEndPlan, 'nextFlags' | 'afterEffectsFlags'>> = {},
  afterEffectsFlags?: TurnEndFlags
): TurnEndPlan {
  return {
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
    ...plan,
    nextFlags,
    afterEffectsFlags: afterEffectsFlags ?? nextFlags,
  };
}

export function routeTurnEnd(
  flags: TurnEndFlags,
  event: TurnEndEvent,
  ctx: TurnEndContext
): TurnEndPlan {
  if (event.kind === 'sessionState') {
    if (event.state !== 'idle') {
      return makePlan({
        ...flags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
      });
    }
    const next = { ...flags, usesSessionStateChangedTurnEnd: true };
    if (next.clearAwaitingTrailingIdle) {
      return makePlan(
        next,
        {
          setIdleSuppressed: true,
          resetThinkingTokens: true,
          settleSuppressedWaiter: 'confirmed',
        },
        resetTurnEndFlags
      );
    }
    if (next.suppressIdleOnNextResult) {
      const kept = {
        ...resetTurnEndFlags,
        suppressIdleOnNextResult: next.suppressIdleOnNextResult,
        clearMessageInFlight: next.clearMessageInFlight,
      };
      return makePlan(next, { setIdleSuppressed: true, resetThinkingTokens: true }, kept);
    }
    const replay = canReplay(next.lastResultWasSuccess, ctx.queryMode);
    return makePlan(
      next,
      { finishTurn: true, allowQueueReplay: replay, resetThinkingTokens: true },
      { ...resetTurnEndFlags }
    );
  }
  const { isTopLevel, isSuccess, isLimitError, isLimitRecoveryEngaged, confirmsArmedClear } =
    event.result;
  const settlesArmedClearError = confirmsArmedClear && !isSuccess;
  const isRecoveryFinal = isLimitRecoveryEngaged !== null;
  const lastResultWasSuccess = isTopLevel ? isSuccess && !isLimitError : flags.lastResultWasSuccess;
  const nextFlags = { ...flags, lastResultWasSuccess };
  const plan: Partial<Omit<TurnEndPlan, 'nextFlags' | 'afterEffectsFlags'>> = {
    resetThinkingTokens: isTopLevel && (!isRecoveryFinal || !isLimitError),
    cancelSuppressedTimer: confirmsArmedClear,
  };
  const canBeginIdle =
    isTopLevel && isLimitRecoveryEngaged === false && !flags.suppressIdleOnNextResult;
  if (canBeginIdle) {
    plan.idleFence = true;
    if (!flags.usesSessionStateChangedTurnEnd && !settlesArmedClearError) {
      plan.earlySetIdle = true;
    }
  }
  if (isLimitRecoveryEngaged) {
    return makePlan(nextFlags, plan);
  }
  if (settlesArmedClearError) {
    return makePlan(
      nextFlags,
      { ...plan, clearSuppression: true, settleSuppressedWaiter: 'reset' },
      resetTurnEndFlags
    );
  }
  if (confirmsArmedClear) {
    const after = { ...nextFlags, suppressIdleOnNextResult: false };
    if (nextFlags.usesSessionStateChangedTurnEnd && nextFlags.expectsSessionStateIdleAfterResult) {
      after.clearAwaitingTrailingIdle = true;
      plan.rearmSuppressedTimer = true;
    } else {
      after.clearMessageInFlight = false;
      plan.settleSuppressedWaiter = 'confirmed';
    }
    return makePlan(nextFlags, plan, after);
  }
  if (
    isTopLevel &&
    isSuccess &&
    !flags.suppressIdleOnNextResult &&
    !flags.usesSessionStateChangedTurnEnd &&
    !flags.expectsSessionStateIdleAfterResult &&
    isLimitRecoveryEngaged === false
  ) {
    plan.finishTurn = true;
    plan.allowQueueReplay = canReplay(nextFlags.lastResultWasSuccess, ctx.queryMode);
  }
  return makePlan(nextFlags, plan);
}
