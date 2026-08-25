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
  isLimitEngaged: boolean;
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
  clearSuppression: boolean;
  settleSuppressedWaiter: 'confirmed' | 'reset' | null;
  rearmSuppressedTimer: boolean;
  nextFlags: TurnEndFlags;
};

export type TurnEndContext = {
  queryMode: 'immediate' | 'manual';
  inRateLimitCooldown: boolean;
  limitRecoveryPending: boolean;
};

function canReplay(
  lastResultWasSuccess: boolean | null,
  queryMode: 'immediate' | 'manual'
): boolean {
  return lastResultWasSuccess !== false && queryMode !== 'manual';
}

function makePlan(
  nextFlags: TurnEndFlags,
  plan: Partial<Omit<TurnEndPlan, 'nextFlags'>> = {}
): TurnEndPlan {
  return {
    idleFence: false,
    earlySetIdle: false,
    finishTurn: false,
    allowQueueReplay: false,
    setIdleSuppressed: false,
    resetThinkingTokens: false,
    clearSuppression: false,
    settleSuppressedWaiter: null,
    rearmSuppressedTimer: false,
    ...plan,
    nextFlags,
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
    const clearTurnPending = next.clearAwaitingTrailingIdle || next.suppressIdleOnNextResult;
    if (clearTurnPending) {
      const settle = next.clearAwaitingTrailingIdle ? 'confirmed' : null;
      return makePlan(
        {
          ...resetTurnEndFlags,
          suppressIdleOnNextResult: next.suppressIdleOnNextResult,
          clearMessageInFlight: next.clearMessageInFlight,
        },
        { setIdleSuppressed: true, resetThinkingTokens: true, settleSuppressedWaiter: settle }
      );
    }
    const replay = canReplay(next.lastResultWasSuccess, ctx.queryMode);
    const finish = !ctx.inRateLimitCooldown && !ctx.limitRecoveryPending;
    return makePlan(
      { ...resetTurnEndFlags },
      { finishTurn: finish, allowQueueReplay: replay, resetThinkingTokens: true }
    );
  }
  const { isTopLevel, isSuccess, isLimitEngaged, confirmsArmedClear } = event.result;
  const settlesArmedClearError = confirmsArmedClear && !isSuccess;
  const lastResultWasSuccess = isTopLevel
    ? !isLimitEngaged && isSuccess
    : flags.lastResultWasSuccess;
  const nextFlags = { ...flags, lastResultWasSuccess };
  const plan: Partial<Omit<TurnEndPlan, 'nextFlags'>> = { resetThinkingTokens: isTopLevel };
  if (isTopLevel && !isLimitEngaged && !flags.suppressIdleOnNextResult) {
    plan.idleFence = true;
    if (!flags.usesSessionStateChangedTurnEnd && !settlesArmedClearError) {
      plan.earlySetIdle = true;
    }
  }
  if (isLimitEngaged) {
    return makePlan(nextFlags, plan);
  }
  if (settlesArmedClearError) {
    return makePlan(
      { ...resetTurnEndFlags },
      { ...plan, clearSuppression: true, settleSuppressedWaiter: 'reset' }
    );
  }
  if (confirmsArmedClear) {
    nextFlags.suppressIdleOnNextResult = false;
    if (nextFlags.usesSessionStateChangedTurnEnd && nextFlags.expectsSessionStateIdleAfterResult) {
      nextFlags.clearAwaitingTrailingIdle = true;
      plan.rearmSuppressedTimer = true;
    } else {
      nextFlags.clearMessageInFlight = false;
      plan.settleSuppressedWaiter = 'confirmed';
    }
  }
  if (
    isTopLevel &&
    isSuccess &&
    !confirmsArmedClear &&
    !flags.suppressIdleOnNextResult &&
    !flags.usesSessionStateChangedTurnEnd &&
    !flags.expectsSessionStateIdleAfterResult &&
    !ctx.inRateLimitCooldown &&
    !ctx.limitRecoveryPending
  ) {
    plan.finishTurn = true;
    plan.allowQueueReplay = canReplay(nextFlags.lastResultWasSuccess, ctx.queryMode);
  }
  return makePlan(nextFlags, plan);
}
