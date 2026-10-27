import { describe, expect, test } from 'bun:test';
import { advanceFollowThrough } from '../../../../src/lib/work-queue/follow-through.ts';

const MIN = 60_000;
const follow = { remind: true, redispatch: true, move: true };
const idle = (since: number) => ({ since, live: 'done', idle: true });

describe('advanceFollowThrough', () => {
  test('an idle worker is reminded at 20 and 40 minutes, then moved at 60', () => {
    const first = advanceFollowThrough(null, idle(0), 20 * MIN, follow);
    expect(first.plan).toEqual({ kind: 'remind', nudges: 1 });
    const second = advanceFollowThrough(first.next, idle(0), 40 * MIN, follow);
    expect(second.plan).toEqual({ kind: 'remind', nudges: 2 });
    const third = advanceFollowThrough(second.next, idle(0), 60 * MIN, follow);
    expect(third.plan).toEqual({ kind: 'redispatch', nudges: 3 });
    expect(third.next).toEqual({ since: 60 * MIN, nudges: 0, redispatched: true });
  });

  test('a moved item stalls at its next hour instead of moving again', () => {
    const moved = { since: 0, nudges: 2, at: 40 * MIN, redispatched: true };
    expect(advanceFollowThrough(moved, idle(0), 60 * MIN, follow).plan).toEqual({
      kind: 'stall',
      nudges: 3,
    });
  });

  test('a busy worker is only recorded, with its live status', () => {
    const busy = advanceFollowThrough(
      null,
      { since: 0, live: 'running', idle: false },
      90 * MIN,
      follow
    );
    expect(busy.plan).toBeNull();
    expect(busy.next).toEqual({ since: 0, nudges: 0, live: 'running' });
  });

  test('new activity starts a fresh incident but keeps that the item was moved', () => {
    const prior = { since: 0, nudges: 2, at: 40 * MIN, redispatched: true };
    const fresh = advanceFollowThrough(prior, idle(55 * MIN), 56 * MIN, follow);
    expect(fresh.incident).toEqual({ since: 55 * MIN, nudges: 0, redispatched: true });
    expect(fresh.plan).toBeNull();
  });
});
