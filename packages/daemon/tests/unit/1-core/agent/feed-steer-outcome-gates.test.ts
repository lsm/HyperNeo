import { describe, expect, it } from 'bun:test';
import { routeFeedSteerOutcome } from '../../../../src/lib/agent/handler-outcome-routing';
import { MESSAGE_DELIVERY_PARK_MS } from '../../../../src/lib/agent/message-delivery';

const NOW = 1_000_000;

describe('routeFeedSteerOutcome', () => {
  it('completed returns a plain completion', () => {
    expect(routeFeedSteerOutcome({ outcome: 'completed' }, { now: NOW })).toEqual({
      mutation: 'none',
      settleSkipped: false,
      result: { outcome: 'completed' },
    });
  });

  it('aborted settles and does not requeue', () => {
    expect(routeFeedSteerOutcome({ outcome: 'aborted' }, { now: NOW })).toEqual({
      mutation: 'none',
      settleSkipped: true,
      result: { outcome: 'aborted' },
    });
  });

  it('blocked requeues at the supplied retryAt', () => {
    expect(
      routeFeedSteerOutcome(
        { outcome: 'blocked', retryAt: 1234, reason: 'sdk_resume_choice' },
        { now: NOW }
      )
    ).toEqual({
      mutation: 'requeue',
      retryAt: 1234,
      settleSkipped: false,
      result: { parked: 'sdk_resume_choice', retryAt: 1234 },
    });
  });

  it('park requeues at its retryAt', () => {
    expect(
      routeFeedSteerOutcome(
        { outcome: 'park', retryAt: NOW + MESSAGE_DELIVERY_PARK_MS, reason: 'waiting_for_input' },
        { now: NOW }
      )
    ).toEqual({
      mutation: 'requeue',
      retryAt: NOW + MESSAGE_DELIVERY_PARK_MS,
      settleSkipped: false,
      result: { parked: 'waiting_for_input', retryAt: NOW + MESSAGE_DELIVERY_PARK_MS },
    });
  });

  it('park with no reason falls back to turn_blocked', () => {
    expect(
      routeFeedSteerOutcome(
        { outcome: 'park', retryAt: NOW + MESSAGE_DELIVERY_PARK_MS },
        { now: NOW }
      )
    ).toEqual({
      mutation: 'requeue',
      retryAt: NOW + MESSAGE_DELIVERY_PARK_MS,
      settleSkipped: false,
      result: { parked: 'turn_blocked', retryAt: NOW + MESSAGE_DELIVERY_PARK_MS },
    });
  });

  it('no feed-steer outcome dead-letters', () => {
    const outcomes = [
      { outcome: 'completed' },
      { outcome: 'aborted' },
      { outcome: 'blocked', retryAt: 1234 },
      { outcome: 'park', retryAt: NOW + MESSAGE_DELIVERY_PARK_MS },
    ];
    for (const feed of outcomes) {
      expect('deadLetter' in routeFeedSteerOutcome(feed, { now: NOW })).toBe(false);
    }
  });
});
