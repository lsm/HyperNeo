import { describe, expect, it } from 'bun:test';
import { routeDriveTurnOutcome } from '../../../../src/lib/agent/handler-outcome-routing';
import type { DeliveryOutcome } from '../../../../src/lib/agent/message-delivery';

const DRIVE_OUTCOMES: DeliveryOutcome[] = [
  { outcome: 'completed' },
  { outcome: 'blocked', retryAt: 1234 },
  { outcome: 'blocked', retryAt: 5678, reason: 'limit_recovery' },
  { outcome: 'aborted' },
];

describe('routeDriveTurnOutcome outcome gates', () => {
  it('completed is a plain completion with no queue mutation and no retry', () => {
    expect(routeDriveTurnOutcome({ outcome: 'completed' })).toEqual({
      mutation: 'none',
      settleSkipped: false,
      result: { outcome: 'completed' },
    });
  });

  it('blocked requeues at the retryAt the SDK supplied, parked as sdk_resume_choice', () => {
    expect(routeDriveTurnOutcome({ outcome: 'blocked', retryAt: 1234 })).toEqual({
      mutation: 'requeue',
      retryAt: 1234,
      settleSkipped: false,
      result: { parked: 'sdk_resume_choice', retryAt: 1234 },
    });
  });

  it('limit_recovery requeues at its own retryAt, parked as limit_recovery', () => {
    expect(
      routeDriveTurnOutcome({ outcome: 'blocked', retryAt: 5678, reason: 'limit_recovery' })
    ).toEqual({
      mutation: 'requeue',
      retryAt: 5678,
      settleSkipped: false,
      result: { parked: 'limit_recovery', retryAt: 5678 },
    });
  });

  it('aborted mutates nothing and settles the skipped delivery', () => {
    expect(routeDriveTurnOutcome({ outcome: 'aborted' })).toEqual({
      mutation: 'none',
      settleSkipped: true,
      result: { outcome: 'aborted' },
    });
  });

  it('only aborted settles the skipped delivery', () => {
    for (const drive of DRIVE_OUTCOMES) {
      const route = routeDriveTurnOutcome(drive);
      const settles = 'settleSkipped' in route && route.settleSkipped;
      expect(settles).toBe(drive.outcome === 'aborted');
    }
  });

  it('no drive-turn outcome dead-letters', () => {
    for (const drive of DRIVE_OUTCOMES) {
      expect('deadLetter' in routeDriveTurnOutcome(drive)).toBe(false);
    }
  });
});
