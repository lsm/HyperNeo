import { describe, expect, it } from 'bun:test';
import {
  type HandlerOutcomeRoute,
  routeDriveTurnOutcome,
  routeFeedSteerOutcome,
  routeSteerPromoteFallback,
} from '../../../../src/lib/agent/handler-outcome-routing';
import {
  type DriveTurnOutcome,
  type FeedSteerOutcome,
  MAX_ACP_STEER_PARKS,
  MAX_STEER_PARKS,
  MESSAGE_DELIVERY_PARK_MS,
} from '../../../../src/lib/agent/message-delivery';

const NOW = 1_000_000;
const PARK_AT = NOW + MESSAGE_DELIVERY_PARK_MS;

describe('routeDriveTurnOutcome', () => {
  const ROWS: Array<{ label: string; drive: DriveTurnOutcome; expected: HandlerOutcomeRoute }> = [
    {
      label: 'completed',
      drive: { outcome: 'completed' },
      expected: { mutation: 'none', settleSkipped: false, result: { outcome: 'completed' } },
    },
    {
      label: 'blocked',
      drive: { outcome: 'blocked', retryAt: 5000 },
      expected: {
        mutation: 'requeue',
        retryAt: 5000,
        settleSkipped: false,
        result: { parked: 'sdk_resume_choice', retryAt: 5000 },
      },
    },
    {
      label: 'recovery_pending',
      drive: { outcome: 'recovery_pending', retryAt: 9000 },
      expected: {
        mutation: 'requeue',
        retryAt: 9000,
        settleSkipped: false,
        result: { parked: 'limit_recovery', retryAt: 9000 },
      },
    },
    {
      label: 'aborted',
      drive: { outcome: 'aborted' },
      expected: { mutation: 'none', settleSkipped: true, result: { outcome: 'aborted' } },
    },
    {
      label: 'turn_terminated',
      drive: { outcome: 'turn_terminated' },
      expected: {
        mutation: 'none',
        settleSkipped: true,
        reclaimSkip: 'turn_terminated',
        result: { outcome: 'completed', skipped: 'turn_terminated' },
      },
    },
  ];

  it.each(ROWS.map((row) => [row.label, row] as const))('%s', (_label, row) => {
    expect(routeDriveTurnOutcome(row.drive)).toEqual(row.expected);
  });
});

describe('routeFeedSteerOutcome', () => {
  const ROWS: Array<{
    label: string;
    feed: FeedSteerOutcome;
    parkCount: number;
    waitingForInput: boolean;
    expected: HandlerOutcomeRoute;
  }> = [
    {
      label: 'consumed',
      feed: { outcome: 'consumed' },
      parkCount: 0,
      waitingForInput: false,
      expected: { mutation: 'none', settleSkipped: false, result: { outcome: 'consumed' } },
    },
    {
      label: 'aborted',
      feed: { outcome: 'aborted' },
      parkCount: 0,
      waitingForInput: false,
      expected: { mutation: 'none', settleSkipped: true, result: { outcome: 'aborted' } },
    },
    {
      label: 'park while not waiting parks via requeueParked',
      feed: { outcome: 'park' },
      parkCount: 0,
      waitingForInput: false,
      expected: {
        mutation: 'requeueParked',
        retryAt: PARK_AT,
        settleSkipped: false,
        result: { parked: 'turn_blocked', retryAt: PARK_AT },
      },
    },
    {
      label: 'park one under the steer budget still parks',
      feed: { outcome: 'park' },
      parkCount: MAX_STEER_PARKS - 1,
      waitingForInput: false,
      expected: {
        mutation: 'requeueParked',
        retryAt: PARK_AT,
        settleSkipped: false,
        result: { parked: 'turn_blocked', retryAt: PARK_AT },
      },
    },
    {
      label: 'park at the steer budget dead-letters',
      feed: { outcome: 'park' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: false,
      expected: { deadLetter: 'Steer parked past its budget — owning turn never unblocked' },
    },
    {
      label: 'park while waiting for input requeues plain and bypasses the budget',
      feed: { outcome: 'park' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: true,
      expected: {
        mutation: 'requeue',
        retryAt: PARK_AT,
        settleSkipped: false,
        result: { parked: 'turn_blocked_gate_open', retryAt: PARK_AT },
      },
    },
    {
      label: 'awaiting_acceptance one under the ACP budget parks',
      feed: { outcome: 'awaiting_acceptance' },
      parkCount: MAX_ACP_STEER_PARKS - 1,
      waitingForInput: false,
      expected: {
        mutation: 'requeueParked',
        retryAt: PARK_AT,
        settleSkipped: false,
        result: { parked: 'acp_awaiting_acceptance', retryAt: PARK_AT },
      },
    },
    {
      label: 'awaiting_acceptance at the ACP budget dead-letters',
      feed: { outcome: 'awaiting_acceptance' },
      parkCount: MAX_ACP_STEER_PARKS,
      waitingForInput: false,
      expected: {
        deadLetter: 'ACP steer awaited acceptance past its budget — subprocess never accepted',
      },
    },
    {
      label: 'ack_timeout parks via requeueParked',
      feed: { outcome: 'ack_timeout' },
      parkCount: 0,
      waitingForInput: false,
      expected: {
        mutation: 'requeueParked',
        retryAt: PARK_AT,
        settleSkipped: false,
        result: { parked: 'steer_ack_timeout', retryAt: PARK_AT },
      },
    },
    {
      label: 'ack_timeout one under the steer budget still parks',
      feed: { outcome: 'ack_timeout' },
      parkCount: MAX_STEER_PARKS - 1,
      waitingForInput: false,
      expected: {
        mutation: 'requeueParked',
        retryAt: PARK_AT,
        settleSkipped: false,
        result: { parked: 'steer_ack_timeout', retryAt: PARK_AT },
      },
    },
    {
      label: 'ack_timeout at the steer budget dead-letters',
      feed: { outcome: 'ack_timeout' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: false,
      expected: {
        deadLetter:
          'Steer acknowledgment timed out past its budget — query never consumed the steer',
      },
    },
    {
      label: 'promote',
      feed: { outcome: 'promote' },
      parkCount: 0,
      waitingForInput: false,
      expected: {
        mutation: 'requeueAs',
        requeueRole: 'turn',
        retryAt: NOW,
        settleSkipped: false,
        result: { outcome: 'superseded', promoted: 'turn' },
      },
    },
  ];

  it.each(ROWS.map((row) => [row.label, row] as const))('%s', (_label, row) => {
    expect(
      routeFeedSteerOutcome(row.feed, {
        parkCount: row.parkCount,
        waitingForInput: row.waitingForInput,
        now: NOW,
      })
    ).toEqual(row.expected);
  });
});

describe('routeSteerPromoteFallback', () => {
  it('a UNIQUE-constraint failure on promote falls back to requeueing as steer', () => {
    expect(
      routeSteerPromoteFallback(new Error('UNIQUE constraint failed: idx'), { now: NOW })
    ).toEqual({
      mutation: 'requeueAs',
      requeueRole: 'steer',
      retryAt: PARK_AT,
      settleSkipped: false,
      result: { outcome: 'superseded', promoted: 'steer' },
    });
  });

  it('a non-UNIQUE failure has no fallback route', () => {
    expect(routeSteerPromoteFallback(new Error('boom'), { now: NOW })).toBeNull();
  });
});
