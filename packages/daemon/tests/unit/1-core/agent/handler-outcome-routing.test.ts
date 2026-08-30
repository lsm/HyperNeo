import { describe, expect, it } from 'bun:test';
import {
  type HandlerOutcomeRoute,
  routeDriveTurnOutcome,
} from '../../../../src/lib/agent/handler-outcome-routing';
import {
  type DeliveryOutcome,
  MESSAGE_DELIVERY_PARK_MS,
} from '../../../../src/lib/agent/message-delivery';

const NOW = 1_000_000;

const noDeadLetter = (route: HandlerOutcomeRoute): void => {
  expect('deadLetter' in route).toBe(false);
};

describe('routeDriveTurnOutcome', () => {
  const DRIVE_OUTCOMES: Array<{
    label: string;
    drive: DeliveryOutcome;
    expected: HandlerOutcomeRoute;
  }> = [
    {
      label: 'completed',
      drive: { outcome: 'completed' },
      expected: { mutation: 'none', settleSkipped: false, result: { outcome: 'completed' } },
    },
    {
      label: 'blocked',
      drive: { outcome: 'blocked', retryAt: 1234 },
      expected: {
        mutation: 'requeue',
        retryAt: 1234,
        settleSkipped: false,
        result: { parked: 'sdk_resume_choice', retryAt: 1234 },
      },
    },
    {
      label: 'blocked behind a context-clear boundary',
      drive: { outcome: 'blocked', retryAt: 1234, reason: 'context_clear_boundary' },
      expected: {
        mutation: 'requeue',
        retryAt: 1234,
        settleSkipped: false,
        result: { parked: 'context_clear_boundary', retryAt: 1234 },
      },
    },
    {
      label: 'blocked with limit recovery',
      drive: { outcome: 'blocked', retryAt: 5678, reason: 'limit_recovery' },
      expected: {
        mutation: 'requeue',
        retryAt: 5678,
        settleSkipped: false,
        result: { parked: 'limit_recovery', retryAt: 5678 },
      },
    },
    {
      label: 'aborted',
      drive: { outcome: 'aborted' },
      expected: { mutation: 'none', settleSkipped: true, result: { outcome: 'aborted' } },
    },
  ];

  it.each(DRIVE_OUTCOMES.map((row) => [row.label, row] as const))('%s', (_label, row) => {
    const route = routeDriveTurnOutcome(row.drive);
    noDeadLetter(route);
    expect(route).toEqual(row.expected);
  });
});
