import {
  type CooldownDecision,
  computeCooldown,
  escalateCooldownDecision,
  MAX_RESET_HORIZON_MS,
} from './fallback-recovery.ts';
import {
  cooldownFromReset,
  type LimitRetryHint,
  normalizeEpochMs,
} from './limit-error-classifier.ts';
import type { LlmLimitAssessment } from './limit-error-llm-classifier.ts';

export type RateLimitWatchdogStatus = 'idle' | 'cooldown' | 'fallback-pending';

export type RateLimitTripDecision =
  | { action: 'surface-billing' }
  | { action: 'give-up' }
  | { action: 'cooldown'; decision: CooldownDecision; charge: boolean };

export const DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES = 3;

export function decideRateLimitTrip(input: {
  hint: LimitRetryHint | null;
  errorMessage: string;
  retryCount: number;
  maxAutoRetries: number;
  now: number;
  exhaustedRetryCycles?: number;
  parkAfterCycles?: number;
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
  const exhaustedRetryCycles = input.exhaustedRetryCycles ?? 0;
  const parkAfterCycles = input.parkAfterCycles ?? DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES;
  if (exhaustedRetryCycles >= parkAfterCycles) {
    const escalated = escalateCooldownDecision(
      decision,
      exhaustedRetryCycles - parkAfterCycles,
      input.now
    );
    return { action: 'cooldown', decision: escalated, charge: !escalated.freeWait };
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
