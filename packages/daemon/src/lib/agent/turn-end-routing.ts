export type TurnEndFlags = {
  suppressIdleOnTurnEnd: boolean;
  usesSessionStateChangedTurnEnd: boolean;
  lastResultWasSuccess: boolean | null;
  clearAwaitingTrailingIdle: boolean;
  clearMessageInFlight: boolean;
};

export const resetTurnEndFlags: TurnEndFlags = {
  suppressIdleOnTurnEnd: false,
  usesSessionStateChangedTurnEnd: false,
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
  fallbackSetIdle: boolean;
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
    fallbackSetIdle: false,
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
    if (next.suppressIdleOnTurnEnd) {
      const kept = {
        ...resetTurnEndFlags,
        suppressIdleOnTurnEnd: next.suppressIdleOnTurnEnd,
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
  if (isLimitRecoveryEngaged === null) {
    return makePlan(flags, {
      resetThinkingTokens: isTopLevel,
      cancelSuppressedTimer: confirmsArmedClear,
    });
  }
  const settlesArmedClearError = confirmsArmedClear && !isSuccess;
  const lastResultWasSuccess = isTopLevel ? isSuccess && !isLimitError : flags.lastResultWasSuccess;
  const nextFlags = { ...flags, lastResultWasSuccess };
  const plan: Partial<Omit<TurnEndPlan, 'nextFlags' | 'afterEffectsFlags'>> = {
    resetThinkingTokens: isTopLevel && !isLimitError,
    cancelSuppressedTimer: confirmsArmedClear,
  };
  const canFallbackIdle =
    isTopLevel &&
    isLimitRecoveryEngaged === false &&
    !flags.suppressIdleOnTurnEnd &&
    !flags.usesSessionStateChangedTurnEnd;
  if (canFallbackIdle && !settlesArmedClearError) {
    plan.fallbackSetIdle = true;
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
    const after = { ...nextFlags, suppressIdleOnTurnEnd: false };
    if (nextFlags.usesSessionStateChangedTurnEnd) {
      after.clearAwaitingTrailingIdle = true;
      plan.rearmSuppressedTimer = true;
    } else {
      after.clearMessageInFlight = false;
      plan.settleSuppressedWaiter = 'confirmed';
    }
    return makePlan(nextFlags, plan, after);
  }
  if (canFallbackIdle && isSuccess) {
    plan.finishTurn = true;
    plan.allowQueueReplay = canReplay(nextFlags.lastResultWasSuccess, ctx.queryMode);
  }
  return makePlan(nextFlags, plan);
}
