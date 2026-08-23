import { type CooldownDecision, computeCooldown, MAX_RESET_HORIZON_MS } from './fallback-recovery';
import { cooldownFromReset, type LimitRetryHint, normalizeEpochMs } from './limit-error-classifier';
import type { LlmLimitAssessment } from './limit-error-llm-classifier';

export type RateLimitWatchdogStatus = 'idle' | 'cooldown' | 'fallback-pending';

export type RateLimitTripDecision =
  | { action: 'surface-billing' }
  | { action: 'give-up' }
  | { action: 'cooldown'; decision: CooldownDecision; charge: boolean };

export function decideRateLimitTrip(input: {
  hint: LimitRetryHint | null;
  errorMessage: string;
  retryCount: number;
  maxAutoRetries: number;
  now: number;
}): RateLimitTripDecision {
  if (input.hint?.billingTerminal) {
    return { action: 'surface-billing' };
  }
  const hintedReset = input.hint?.resetAtMs ?? null;
  const usableHintedReset =
    hintedReset !== null &&
    hintedReset > input.now &&
    hintedReset <= input.now + MAX_RESET_HORIZON_MS
      ? hintedReset
      : null;
  const decision =
    usableHintedReset !== null
      ? cooldownFromReset(usableHintedReset, input.now)
      : computeCooldown(input.errorMessage, input.retryCount, input.now);
  if (!decision.freeWait && input.retryCount >= input.maxAutoRetries) {
    return { action: 'give-up' };
  }
  return { action: 'cooldown', decision, charge: !decision.freeWait };
}

export function refinedResetAtMs(
  assessment: LlmLimitAssessment | null,
  now: number
): number | null {
  if (!assessment || assessment.notALimit) return null;
  const raw = assessment.resetAtMs;
  const resetMs = typeof raw === 'number' && Number.isFinite(raw) ? normalizeEpochMs(raw) : null;
  if (resetMs === null || resetMs <= now || resetMs > now + MAX_RESET_HORIZON_MS) return null;
  return resetMs;
}

export function resolveWatchdogStatus(input: {
  fallbackPending: boolean;
  cooldownActive: boolean;
}): RateLimitWatchdogStatus {
  if (input.fallbackPending) return 'fallback-pending';
  return input.cooldownActive ? 'cooldown' : 'idle';
}

export function canRetryNow(input: {
  fallbackPending: boolean;
  cooldownActive: boolean;
  startupExhausted: boolean;
}): boolean {
  if (input.fallbackPending) return false;
  return input.cooldownActive || input.startupExhausted;
}

export function manualRecoveryPause(input: {
  cooldownActive: boolean;
  fallbackPending: boolean;
  retryCallbackInFlight: boolean;
  startupExhausted: boolean;
  billingPauseSurfaced: boolean;
}): boolean {
  return (
    !input.cooldownActive &&
    !input.fallbackPending &&
    !input.retryCallbackInFlight &&
    (input.startupExhausted || input.billingPauseSurfaced)
  );
}
