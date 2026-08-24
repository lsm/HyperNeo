import { describe, expect, test } from 'bun:test';
import {
  buildInactivityNagClaimKey,
  decideInactivityNag,
  decideNagWindowReset,
  INACTIVITY_WATCHDOG_PREDICATE_VERSION,
  resolveLastActivityAt,
  type InactivityWatchdogInput,
} from '../../../../src/lib/space/agents/inactivity-watchdog-gates';

const NOW = 1_000_000;
const THRESHOLD_MS = 3_600_000;

function makeActor(
  overrides: Partial<InactivityWatchdogInput['actor']> = {}
): InactivityWatchdogInput['actor'] {
  return {
    agentStatus: 'active',
    spaceWakeable: true,
    sessionIdle: true,
    pendingAcceptedDelivery: false,
    lastActivityAt: NOW - THRESHOLD_MS - 1,
    ...overrides,
  };
}

function input(overrides: Partial<InactivityWatchdogInput> = {}): InactivityWatchdogInput {
  return {
    now: NOW,
    enabled: true,
    thresholdMs: THRESHOLD_MS,
    agentId: 'agent-1',
    actor: makeActor(),
    claim: null,
    ...overrides,
  };
}

describe('resolveLastActivityAt', () => {
  test('prefers the latest consumed message timestamp', () => {
    expect(
      resolveLastActivityAt({
        latestConsumedMessageAt: 300,
        sessionCreatedAt: 200,
        agentCreatedAt: 100,
      })
    ).toBe(300);
  });

  test('falls back to session creation time, then agent creation time', () => {
    expect(
      resolveLastActivityAt({
        latestConsumedMessageAt: null,
        sessionCreatedAt: 200,
        agentCreatedAt: 100,
      })
    ).toBe(200);
    expect(
      resolveLastActivityAt({
        latestConsumedMessageAt: null,
        sessionCreatedAt: null,
        agentCreatedAt: 100,
      })
    ).toBe(100);
  });

  test('returns null when no baseline exists', () => {
    expect(
      resolveLastActivityAt({
        latestConsumedMessageAt: null,
        sessionCreatedAt: null,
        agentCreatedAt: null,
      })
    ).toBeNull();
  });
});

describe('decideInactivityNag', () => {
  describe('due computation', () => {
    test('nags once idle duration reaches the threshold', () => {
      expect(decideInactivityNag(input())).toEqual({
        action: 'nag',
        predicateVersion: INACTIVITY_WATCHDOG_PREDICATE_VERSION,
        windowAnchoredAt: NOW - THRESHOLD_MS - 1,
        attemptGeneration: 0,
        claimKey: buildInactivityNagClaimKey({
          agentId: 'agent-1',
          windowAnchoredAt: NOW - THRESHOLD_MS - 1,
          attemptGeneration: 0,
        }),
        idleForMs: THRESHOLD_MS + 1,
      });
    });

    test('does not nag before the threshold elapses', () => {
      const decision = decideInactivityNag(
        input({ actor: makeActor({ lastActivityAt: NOW - THRESHOLD_MS + 1 }) })
      );
      expect(decision).toEqual({ action: 'none', reason: 'not_due' });
    });

    test('treats the threshold boundary itself as due', () => {
      const decision = decideInactivityNag(
        input({ actor: makeActor({ lastActivityAt: NOW - THRESHOLD_MS }) })
      );
      expect(decision.action).toBe('nag');
      if (decision.action === 'nag') expect(decision.idleForMs).toBe(THRESHOLD_MS);
    });
  });

  describe('disabled and unconfigured states', () => {
    test('skips when the watchdog is disabled', () => {
      expect(decideInactivityNag(input({ enabled: false }))).toEqual({
        action: 'none',
        reason: 'disabled',
      });
    });

    test('skips when the threshold is unconfigured', () => {
      expect(decideInactivityNag(input({ thresholdMs: null }))).toEqual({
        action: 'none',
        reason: 'unconfigured',
      });
    });

    test('skips when the threshold is non-positive', () => {
      expect(decideInactivityNag(input({ thresholdMs: 0 }))).toEqual({
        action: 'none',
        reason: 'unconfigured',
      });
    });
  });

  describe('admission gates', () => {
    test('skips when the actor snapshot is missing', () => {
      expect(decideInactivityNag(input({ actor: null }))).toEqual({
        action: 'none',
        reason: 'actor_inactive',
      });
    });

    test('skips for paused, disabled, or archived agents', () => {
      for (const agentStatus of ['paused', 'disabled', 'archived'] as const) {
        expect(decideInactivityNag(input({ actor: makeActor({ agentStatus }) }))).toEqual({
          action: 'none',
          reason: 'actor_inactive',
        });
      }
    });

    test('skips when the Space is not wakeable', () => {
      expect(decideInactivityNag(input({ actor: makeActor({ spaceWakeable: false }) }))).toEqual({
        action: 'none',
        reason: 'actor_inactive',
      });
    });

    test('skips when the session is processing, queued, or cooling down', () => {
      expect(decideInactivityNag(input({ actor: makeActor({ sessionIdle: false }) }))).toEqual({
        action: 'none',
        reason: 'session_busy',
      });
    });

    test('skips when an accepted delivery is still unconsumed', () => {
      expect(
        decideInactivityNag(input({ actor: makeActor({ pendingAcceptedDelivery: true }) }))
      ).toEqual({ action: 'none', reason: 'delivery_pending' });
    });
  });

  describe('window-claim semantics', () => {
    test('skips while a claim is held for the current window', () => {
      const lastActivityAt = NOW - THRESHOLD_MS - 1;
      expect(
        decideInactivityNag(
          input({
            actor: makeActor({ lastActivityAt }),
            claim: {
              state: 'accepted',
              windowAnchoredAt: lastActivityAt,
              attemptGeneration: 0,
            },
          })
        )
      ).toEqual({ action: 'none', reason: 'claim_held' });
    });

    test('skips while a claim is in flight for the current window', () => {
      const lastActivityAt = NOW - THRESHOLD_MS - 1;
      expect(
        decideInactivityNag(
          input({
            actor: makeActor({ lastActivityAt }),
            claim: {
              state: 'in_flight',
              windowAnchoredAt: lastActivityAt,
              attemptGeneration: 2,
            },
          })
        )
      ).toEqual({ action: 'none', reason: 'claim_held' });
    });

    test('admits again when lastActivityAt advanced past the claimed window', () => {
      const decision = decideInactivityNag(
        input({
          claim: {
            state: 'accepted',
            windowAnchoredAt: NOW - THRESHOLD_MS - 501,
            attemptGeneration: 0,
          },
        })
      );
      expect(decision.action).toBe('nag');
    });

    test('carries the current attempt generation into the nag claim key', () => {
      const windowAnchoredAt = NOW - THRESHOLD_MS - 1;
      const decision = decideInactivityNag(
        input({
          actor: makeActor({ lastActivityAt: windowAnchoredAt }),
          claim: {
            state: 'none',
            windowAnchoredAt: 0,
            attemptGeneration: 3,
          },
        })
      );
      expect(decision).toEqual({
        action: 'nag',
        predicateVersion: INACTIVITY_WATCHDOG_PREDICATE_VERSION,
        windowAnchoredAt,
        attemptGeneration: 3,
        claimKey: buildInactivityNagClaimKey({
          agentId: 'agent-1',
          windowAnchoredAt,
          attemptGeneration: 3,
        }),
        idleForMs: THRESHOLD_MS + 1,
      });
    });
  });
});

describe('decideNagWindowReset', () => {
  test('a consumed nag resets the window and releases the claim', () => {
    expect(decideNagWindowReset('consumed')).toEqual({
      resetWindow: true,
      releaseClaim: true,
      advanceAttemptGeneration: false,
      degraded: false,
    });
  });

  test('a pre-admission failure re-arms without resetting or advancing the generation', () => {
    expect(decideNagWindowReset('pre_admission_failure')).toEqual({
      resetWindow: false,
      releaseClaim: true,
      advanceAttemptGeneration: false,
      degraded: false,
    });
  });

  test('an accepted delivery holds the claim without side effects', () => {
    expect(decideNagWindowReset('accepted')).toEqual({
      resetWindow: false,
      releaseClaim: false,
      advanceAttemptGeneration: false,
      degraded: false,
    });
  });

  test('a terminal delivery failure advances the generation into degraded recovery', () => {
    expect(decideNagWindowReset('terminal_failure')).toEqual({
      resetWindow: false,
      releaseClaim: true,
      advanceAttemptGeneration: true,
      degraded: true,
    });
  });
});

describe('buildInactivityNagClaimKey', () => {
  test('is deterministic for the same window and generation', () => {
    expect(
      buildInactivityNagClaimKey({ agentId: 'a', windowAnchoredAt: 5, attemptGeneration: 1 })
    ).toBe(buildInactivityNagClaimKey({ agentId: 'a', windowAnchoredAt: 5, attemptGeneration: 1 }));
    expect(
      buildInactivityNagClaimKey({ agentId: 'a', windowAnchoredAt: 5, attemptGeneration: 1 })
    ).not.toBe(
      buildInactivityNagClaimKey({ agentId: 'a', windowAnchoredAt: 5, attemptGeneration: 2 })
    );
    expect(
      buildInactivityNagClaimKey({ agentId: 'a', windowAnchoredAt: 5, attemptGeneration: 1 })
    ).not.toBe(
      buildInactivityNagClaimKey({ agentId: 'b', windowAnchoredAt: 5, attemptGeneration: 1 })
    );
  });
});
