import { describe, expect, it } from 'bun:test';
import { routeFeedSteerOutcome } from '../../../../src/lib/agent/handler-outcome-routing';

describe('routeFeedSteerOutcome', () => {
  it('completed returns a plain completion', () => {
    expect(routeFeedSteerOutcome({ outcome: 'completed' })).toEqual({
      mutation: 'none',
      settleSkipped: false,
      result: { outcome: 'completed' },
    });
  });

  it('aborted settles and does not requeue', () => {
    expect(routeFeedSteerOutcome({ outcome: 'aborted' })).toEqual({
      mutation: 'none',
      settleSkipped: true,
      result: { outcome: 'aborted' },
    });
  });

  it('blocked requeues at the supplied retryAt', () => {
    expect(
      routeFeedSteerOutcome({ outcome: 'blocked', retryAt: 1234, reason: 'sdk_resume_choice' })
    ).toEqual({
      mutation: 'requeue',
      retryAt: 1234,
      settleSkipped: false,
      result: { parked: 'sdk_resume_choice', retryAt: 1234 },
    });
  });

  it('no feed-steer outcome dead-letters', () => {
    const outcomes = [
      { outcome: 'completed' },
      { outcome: 'aborted' },
      { outcome: 'blocked', retryAt: 1234 },
    ];
    for (const feed of outcomes) {
      expect('deadLetter' in routeFeedSteerOutcome(feed as never)).toBe(false);
    }
  });
});
