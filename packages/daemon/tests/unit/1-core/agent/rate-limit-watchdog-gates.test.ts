import { describe, expect, it } from 'bun:test';
import {
  BACKOFF_JITTER,
  BACKOFF_LADDER_MS,
  RESET_BUFFER_MS,
} from '../../../../src/lib/agent/fallback-recovery';
import {
  canRetryNow,
  DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES,
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

  describe('decideRateLimitTrip — consecutive-exhaustion escalation', () => {
    const SHORT_RESET = NOW + 60 * 1000;

    it('below the threshold a short free wait defers to the reset window unchanged', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: SHORT_RESET, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES - 1,
        })
      );
      expect(trip.decision.reason).toBe('parsed-reset');
      expect(trip.decision.retryAtMs).toBe(SHORT_RESET + RESET_BUFFER_MS);
      expect(trip.charge).toBe(false);
    });

    it('parks past a short reset window once N consecutive cycles exhausted, without charging', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: SHORT_RESET, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES,
        })
      );
      expect(trip.decision.reason).toBe('escalated-park');
      expect(trip.decision.freeWait).toBe(true);
      expect(trip.charge).toBe(false);
      expect(trip.decision.ladderIndex).toBe(0);
      expect(trip.decision.retryAtMs).toBeGreaterThanOrEqual(
        NOW + BACKOFF_LADDER_MS[0] * (1 - BACKOFF_JITTER)
      );
      expect(trip.decision.retryAtMs).toBeGreaterThan(SHORT_RESET + RESET_BUFFER_MS);
    });

    it('each further exhausted cycle advances the park ladder', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: SHORT_RESET, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES + 1,
        })
      );
      expect(trip.decision.reason).toBe('escalated-park');
      expect(trip.decision.ladderIndex).toBe(1);
      expect(trip.decision.retryAtMs).toBeGreaterThanOrEqual(
        NOW + BACKOFF_LADDER_MS[1] * (1 - BACKOFF_JITTER)
      );
    });

    it('a reset window longer than the park ladder still defers to the window', () => {
      const longReset = NOW + 3 * 60 * 60 * 1000;
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: longReset, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES,
        })
      );
      expect(trip.decision.reason).toBe('escalated-park');
      expect(trip.decision.retryAtMs).toBe(longReset + RESET_BUFFER_MS);
      expect(trip.decision.freeWait).toBe(true);
      expect(trip.charge).toBe(false);
    });

    it('carries backoff forward onto ladder cycles that follow free-wait cycles', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: null,
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES + 2,
        })
      );
      expect(trip.decision.reason).toBe('escalated-park');
      expect(trip.decision.freeWait).toBe(false);
      expect(trip.charge).toBe(true);
      expect(trip.decision.ladderIndex).toBe(2);
      expect(trip.decision.retryAtMs).toBeGreaterThanOrEqual(
        NOW + BACKOFF_LADDER_MS[2] * (1 - BACKOFF_JITTER)
      );
    });

    it('a spent ladder budget still gives up instead of parking', () => {
      const trip = decideRateLimitTrip({
        hint: null,
        errorMessage: '429',
        retryCount: 2,
        maxAutoRetries: 2,
        now: NOW,
        exhaustedRetryCycles: 9,
      });
      expect(trip).toEqual({ action: 'give-up' });
    });

    it('billing-terminal limits still surface instead of parking', () => {
      const trip = decideRateLimitTrip({
        hint: { billingTerminal: true, kind: 'usage_limit' },
        errorMessage: '429',
        retryCount: 0,
        maxAutoRetries: 5,
        now: NOW,
        exhaustedRetryCycles: 9,
      });
      expect(trip).toEqual({ action: 'surface-billing' });
    });

    it('defaults the threshold to three consecutive exhausted cycles', () => {
      expect(DEFAULT_PARK_AFTER_EXHAUSTED_CYCLES).toBe(3);
      const below = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: SHORT_RESET, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: 2,
        })
      );
      expect(below.decision.reason).toBe('parsed-reset');
      const at = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: SHORT_RESET, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: 3,
        })
      );
      expect(at.decision.reason).toBe('escalated-park');
    });

    it('a custom threshold of zero parks on the first exhaustion', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: SHORT_RESET, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
          exhaustedRetryCycles: 0,
          parkAfterCycles: 0,
        })
      );
      expect(trip.decision.reason).toBe('escalated-park');
    });

    it('omitting the cycle count never parks (single-cycle behavior unchanged)', () => {
      const trip = asCooldownTrip(
        decideRateLimitTrip({
          hint: { resetAtMs: SHORT_RESET, kind: 'rate_limit' },
          errorMessage: '429',
          retryCount: 0,
          maxAutoRetries: 5,
          now: NOW,
        })
      );
      expect(trip.decision.reason).toBe('parsed-reset');
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
