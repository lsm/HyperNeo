import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import {
  planNeoWorkFollow,
  planNeoWorkFollowLive,
  requireNeoWorkFollow,
  requireNeoWorkFollowAnswered,
  requireNeoWorkFollowUp,
} from '../../../../src/lib/neo/work-follow.ts';

const now = 10_000_000;
const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 's1' };
const work = {
  id: 'w1',
  status: 'reported',
  report: 'Agent: Waiting for the build.',
  updatedAt: now - 60 * 60_000,
} as NeoWork;
type Card = Parameters<typeof requireNeoWorkFollow>[1];
const card: Card = {
  ref,
  goal: true,
  ask: { status: 'open' },
  readAt: null,
  superseded: false,
  live: 'done',
};

describe('requireNeoWorkFollow', () => {
  test.each<[string, NeoWork, Partial<Card>, boolean]>([
    ['a reported card under an open ask', work, {}, true],
    ['a blocked ask', work, { ask: { status: 'blocked' } }, true],
    ['an old card with a done list but no ask', work, { ask: null }, false],
    ['a card under an ask that waits on the human', work, { ask: { status: 'waiting' } }, true],
    ['a card still running', { ...work, status: 'queued' }, {}, false],
    ['a card the user closed as done', { ...work, report: NEO_WORK_CLOSED_DONE }, {}, false],
    [
      'a card whose ask has every item met',
      work,
      {
        ask: {
          status: 'open',
          doneItems: [
            {
              id: 'i1',
              text: 'Merged',
              state: 'met',
              evidence: 'merged',
              check: null,
              metBy: 'daemon',
              removed: false,
            },
          ],
        },
        live: 'running',
      },
      false,
    ],
    ['a card with no driver ref', work, { ref: null }, false],
    ['a card with no done list', work, { goal: false }, false],
    ['an achieved ask', work, { ask: { status: 'achieved' } }, false],
    ['an abandoned ask', work, { ask: { status: 'abandoned' } }, false],
    ['a card read a minute ago', work, { readAt: now - 60_000 }, false],
    ['a card read three minutes ago', work, { readAt: now - 3 * 60_000 }, true],
    ['a card reported over a week ago', { ...work, updatedAt: now - 8 * 86_400_000 }, {}, false],
    ['a card whose session has since taken a newer card', work, { superseded: true }, false],
    [
      'an achieved ask whose session still shows running',
      work,
      { ask: { status: 'achieved' }, live: 'running' },
      true,
    ],
    [
      'a card with no ask whose session shows needs you',
      work,
      { ask: null, goal: false, live: 'needs_you' },
      true,
    ],
    ['a card with no ask whose session finished', work, { ask: null, live: 'stopped' }, false],
    [
      'a card the user closed as done, still running',
      { ...work, report: NEO_WORK_CLOSED_DONE },
      { live: 'running' },
      false,
    ],
  ])('%s', (_label, at, overrides, following) => {
    const gate = requireNeoWorkFollow(at, { ...card, ...overrides }, now);
    expect(gate).toEqual(following ? { value: ref } : { reason: null });
  });
});

describe('requireNeoWorkFollowUp', () => {
  test('follows up only for a card under a live ask with a done list', () => {
    expect(requireNeoWorkFollowUp(work, card)).toEqual({ value: ref });
    expect(requireNeoWorkFollowUp(work, { ...card, ask: { status: 'achieved' } })).toEqual({
      reason: null,
    });
    expect(requireNeoWorkFollowUp(work, { ...card, goal: false })).toEqual({ reason: null });
  });
});

describe('requireNeoWorkFollowAnswered', () => {
  test.each<[string, { status: 'done' | 'needs_you' | 'running' } | null, boolean]>([
    ['a session that finished', { status: 'done' }, true],
    ['a session still working', { status: 'running' }, true],
    ['a session that could not be read', null, true],
    ['a session waiting on the user', { status: 'needs_you' }, false],
  ])('%s', (_label, live, follows) => {
    expect(requireNeoWorkFollowAnswered(live, ref)).toEqual(
      follows ? { value: ref } : { reason: null }
    );
  });
});

describe('planNeoWorkFollowLive', () => {
  test("takes the session's own state, or nothing when it could not be read", () => {
    expect(
      planNeoWorkFollowLive({
        outcome: {
          kind: 'completed',
          value: { ok: true, value: { status: 'done', lastActivityAt: 5, link: '/session/s1' } },
        },
      })
    ).toEqual({ status: 'done', link: '/session/s1', remoteLink: undefined });
    expect(
      planNeoWorkFollowLive({
        outcome: { kind: 'completed', value: { ok: false, reason: 'unreachable', detail: 'down' } },
      })
    ).toBe(null);
  });
});

describe('planNeoWorkFollow', () => {
  const sent = { inputBefore: 1, opening: 'Fix font' };
  const read = (exchange: unknown[]) => ({
    outcome: {
      kind: 'completed' as const,
      value: {
        ok: true,
        value: { status: 'done', lastActivityAt: 40, lastReply: 'Unrelated', exchange },
      },
    },
  });
  test('ignores another input and preserves the prior report', () => {
    expect(
      planNeoWorkFollow(
        work,
        read([
          { at: 30, role: 'user', text: 'PR event' },
          { at: 40, role: 'agent', text: 'Other PR merged' },
        ]),
        { since: 20, sent }
      )
    ).toEqual({ reason: null });
    expect(
      planNeoWorkFollow(work, read([{ at: 40, role: 'agent', text: 'No input proof' }]), {
        since: 20,
      })
    ).toEqual({ reason: null });
  });
  test('follows only replies to the recorded input, using the worker clock', () => {
    const own = read([
      { at: 2, role: 'user', text: sent.opening },
      { at: 25, role: 'agent', text: 'Font fixed' },
      { at: 30, role: 'user', text: 'CI event' },
      { at: 40, role: 'agent', text: 'Other result' },
    ]);
    expect(planNeoWorkFollow(work, own, { since: 20, sent })).toEqual({
      value: `Agent: Font fixed\n\nEarlier report:\n${work.report}`,
    });
    expect(planNeoWorkFollow(work, own, { since: 25, sent })).toEqual({ reason: null });
  });
});
