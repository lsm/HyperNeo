import { describe, expect, it } from 'bun:test';
import { RESET_BUFFER_MS } from '../../../../src/lib/agent/fallback-recovery';
import {
  canRetryNow,
  decideRateLimitTrip,
  manualRecoveryPause,
  type RateLimitTripDecision,
  refinedResetAtMs,
  resolveWatchdogStatus,
} from '../../../../src/lib/agent/rate-limit-watchdog-gates';

const NOW = 1_700_000_000_000;

function asCooldownTrip(
  trip: RateLimitTripDecision
): Extract<RateLimitTripDecision, { action: 'cooldown' }> {
  if (trip.action !== 'cooldown') throw new Error(`expected cooldown decision, got ${trip.action}`);
  return trip;
}

describe('rate-limit-watchdog-gates', () => {
  describe('decideRateLimitTrip', () => {
    it('billing-terminal outranks a usable hinted reset', () => {
      const trip = decideRateLimitTrip({
        hint: { billingTerminal: true, kind: 'usage_limit', resetAtMs: NOW + 60 * 60 * 1000 },
        errorMessage: '429',
        retryCount: 0,
        maxAutoRetries: 3,
        now: NOW,
      });
      expect(trip).toEqual({ action: 'surface-billing' });
    });

    it('a usable hinted reset arms a free-wait cooldown at reset plus buffer without charging', () => {
      const reset = NOW + 2 * 60 * 60 * 1000;
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: reset, kind: 'usage_limit' },
          errorMessage: '429',
          retryCount: 2,
          maxAutoRetries: 3,
          now: NOW,
        })
      );
      expect(trip.charge).toBe(false);
      expect(trip.decision.reason).toBe('parsed-reset');
      expect(trip.decision.freeWait).toBe(true);
      expect(trip.decision.retryAtMs).toBe(reset + RESET_BUFFER_MS);
    });

    it('a stale hinted reset falls back to the ladder and charges the budget', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: NOW - 1000, kind: 'usage_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 3,
          now: NOW,
        })
      );
      expect(trip.charge).toBe(true);
      expect(trip.decision.reason).toBe('backoff-ladder');
      expect(trip.decision.freeWait).toBe(false);
    });

    it('a hinted reset beyond the 7-day horizon falls back to the ladder', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: NOW + 8 * 24 * 60 * 60 * 1000, kind: 'usage_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 3,
          now: NOW,
        })
      );
      expect(trip.charge).toBe(true);
      expect(trip.decision.reason).toBe('backoff-ladder');
    });

    it('a message-parsed reset arms a free wait even without a hint', () => {
      const reset = NOW + 60 * 60 * 1000;
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: null,
          errorMessage: `resets ${new Date(reset).toISOString()}`,
          retryCount: 5,
          maxAutoRetries: 0,
          now: NOW,
        })
      );
      expect(trip.charge).toBe(false);
      expect(trip.decision.reason).toBe('parsed-reset');
      expect(trip.decision.retryAtMs).toBe(reset + RESET_BUFFER_MS);
    });

    it('gives up when the ladder is required and the retry budget is spent', () => {
      const trip = decideRateLimitTrip({
        hint: null,
        errorMessage: '429',
        retryCount: 2,
        maxAutoRetries: 2,
        now: NOW,
      });
      expect(trip).toEqual({ action: 'give-up' });
    });

    it('a free wait bypasses a spent retry budget', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: NOW + 60 * 60 * 1000, kind: 'usage_limit' },
          errorMessage: '429',
          retryCount: 2,
          maxAutoRetries: 0,
          now: NOW,
        })
      );
      expect(trip.charge).toBe(false);
    });

    it('arms the ladder under budget with one step left', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: null,
          errorMessage: '429',
          retryCount: 1,
          maxAutoRetries: 2,
          now: NOW,
        })
      );
      expect(trip.charge).toBe(true);
      expect(trip.decision.reason).toBe('backoff-ladder');
    });
  });

  describe('refinedResetAtMs', () => {
    it('rejects null assessments, not-a-limit verdicts, and missing resets', () => {
      expect(refinedResetAtMs(null, NOW)).toBeNull();
      expect(
        refinedResetAtMs({ resetAtMs: NOW + 60 * 1000, kind: null, notALimit: true }, NOW)
      ).toBeNull();
      expect(
        refinedResetAtMs({ resetAtMs: null, kind: 'usage_limit', notALimit: false }, NOW)
      ).toBeNull();
    });

    it('rejects resets in the past and beyond the horizon', () => {
      expect(
        refinedResetAtMs({ resetAtMs: NOW - 1, kind: null, notALimit: false }, NOW)
      ).toBeNull();
      expect(
        refinedResetAtMs(
          { resetAtMs: NOW + 8 * 24 * 60 * 60 * 1000, kind: null, notALimit: false },
          NOW
        )
      ).toBeNull();
    });

    it('normalizes epoch-seconds resets', () => {
      const sec = Math.floor((NOW + 2 * 60 * 60 * 1000) / 1000);
      expect(refinedResetAtMs({ resetAtMs: sec, kind: 'usage_limit', notALimit: false }, NOW)).toBe(
        sec * 1000
      );
    });

    it('passes epoch-milliseconds resets through unchanged', () => {
      const ms = NOW + 2 * 60 * 60 * 1000;
      expect(refinedResetAtMs({ resetAtMs: ms, kind: 'rate_limit', notALimit: false }, NOW)).toBe(
        ms
      );
    });
  });

  describe('resolveWatchdogStatus', () => {
    it('prefers fallback-pending over cooldown over idle', () => {
      expect(resolveWatchdogStatus({ fallbackPending: true, cooldownActive: true })).toBe(
        'fallback-pending'
      );
      expect(resolveWatchdogStatus({ fallbackPending: true, cooldownActive: false })).toBe(
        'fallback-pending'
      );
      expect(resolveWatchdogStatus({ fallbackPending: false, cooldownActive: true })).toBe(
        'cooldown'
      );
      expect(resolveWatchdogStatus({ fallbackPending: false, cooldownActive: false })).toBe('idle');
    });
  });

  describe('canRetryNow', () => {
    it('admits only with a live cooldown timer or an exhausted startup budget, never mid-fallback', () => {
      expect(
        canRetryNow({ fallbackPending: true, cooldownActive: true, startupExhausted: true })
      ).toBe(false);
      expect(
        canRetryNow({ fallbackPending: false, cooldownActive: false, startupExhausted: false })
      ).toBe(false);
      expect(
        canRetryNow({ fallbackPending: false, cooldownActive: true, startupExhausted: false })
      ).toBe(true);
      expect(
        canRetryNow({ fallbackPending: false, cooldownActive: false, startupExhausted: true })
      ).toBe(true);
    });
  });

  describe('manualRecoveryPause', () => {
    it('pauses manually only when quiet and startup-exhausted or billing-surfaced', () => {
      const base = {
        cooldownActive: false,
        fallbackPending: false,
        retryCallbackInFlight: false,
        startupExhausted: false,
        billingPauseSurfaced: false,
      };
      expect(manualRecoveryPause(base)).toBe(false);
      expect(manualRecoveryPause({ ...base, startupExhausted: true })).toBe(true);
      expect(manualRecoveryPause({ ...base, billingPauseSurfaced: true })).toBe(true);
      expect(manualRecoveryPause({ ...base, startupExhausted: true, cooldownActive: true })).toBe(
        false
      );
      expect(manualRecoveryPause({ ...base, startupExhausted: true, fallbackPending: true })).toBe(
        false
      );
      expect(
        manualRecoveryPause({ ...base, startupExhausted: true, retryCallbackInFlight: true })
      ).toBe(false);
    });
  });
});
