import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import { planNeoWorkFollow, requireNeoWorkFollow } from '../../../../src/lib/neo/work-follow.ts';

const now = 10_000_000;
const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 's1' };
const work = {
  id: 'w1',
  status: 'reported',
  report: 'Agent: Waiting for the build.',
  updatedAt: now - 60 * 60_000,
} as NeoWork;
type Card = Parameters<typeof requireNeoWorkFollow>[1];
const card: Card = { ref, goal: true, ask: { status: 'open' }, readAt: null };

describe('requireNeoWorkFollow', () => {
  test.each<[string, NeoWork, Partial<Card>, boolean]>([
    ['a reported card under an open ask', work, {}, true],
    ['a blocked ask', work, { ask: { status: 'blocked' } }, true],
    ['a card without an ask but with a done list', work, { ask: null }, true],
    ['a card still running', { ...work, status: 'queued' }, {}, false],
    ['a card the user closed as done', { ...work, report: NEO_WORK_CLOSED_DONE }, {}, false],
    ['a card with no driver ref', work, { ref: null }, false],
    ['a card with no done list', work, { goal: false }, false],
    ['an achieved ask', work, { ask: { status: 'achieved' } }, false],
    ['an abandoned ask', work, { ask: { status: 'abandoned' } }, false],
    ['a card read a minute ago', work, { readAt: now - 60_000 }, false],
    ['a card read three minutes ago', work, { readAt: now - 3 * 60_000 }, true],
    ['a card reported over a week ago', { ...work, updatedAt: now - 8 * 86_400_000 }, {}, false],
  ])('%s', (_label, at, overrides, following) => {
    const gate = requireNeoWorkFollow(at, { ...card, ...overrides }, now);
    expect(gate).toEqual(following ? { value: ref } : { reason: null });
  });
});

describe('planNeoWorkFollow', () => {
  const later = work.updatedAt + 30 * 60_000;
  const read = (value: Record<string, unknown>) => ({
    outcome: { kind: 'completed' as const, value: { ok: true, value } },
  });
  test.each<[string, ReturnType<typeof read>, string | null]>([
    [
      'the session merged on its own after the report',
      read({
        status: 'done',
        lastActivityAt: later,
        lastReplyAt: later,
        exchange: [
          { at: later, role: 'agent', text: 'Merged https://github.com/lsm/neo-ios/pull/25.' },
        ],
      }),
      'Agent: Merged https://github.com/lsm/neo-ios/pull/25.\n\nEarlier report:\nAgent: Waiting for the build.',
    ],
    ['nothing happened since', read({ status: 'done', lastActivityAt: work.updatedAt - 1 }), null],
    [
      'a session the app no longer has open, with a new reply',
      read({
        status: 'stopped',
        lastActivityAt: later,
        lastReplyAt: later,
        exchange: [{ at: later, role: 'agent', text: 'PR C merged.' }],
      }),
      'Agent: PR C merged.\n\nEarlier report:\nAgent: Waiting for the build.',
    ],
    [
      'a session that asks the human something',
      read({
        status: 'needs_you',
        lastActivityAt: later,
        lastReplyAt: later,
        lastReply: 'Can I merge?',
      }),
      'Agent: Can I merge?\n\nEarlier report:\nAgent: Waiting for the build.',
    ],
    ['the session is still working', read({ status: 'running', lastActivityAt: later }), null],
    ['the session said nothing new', read({ status: 'done', lastActivityAt: later }), null],
    [
      'the last reply predates the report',
      read({
        status: 'done',
        lastActivityAt: later,
        lastReplyAt: work.updatedAt - 1,
        lastReply: 'Old.',
      }),
      null,
    ],
  ])('%s', (_label, status, report) => {
    expect(planNeoWorkFollow(work, status, { since: work.updatedAt })).toEqual(
      report === null ? { reason: null } : { value: report }
    );
  });

  test('judges freshness by the work machine clock, even when it runs behind', () => {
    const remoteSince = work.updatedAt - 60 * 60_000;
    const behind = read({
      status: 'done',
      lastActivityAt: remoteSince + 60_000,
      lastReplyAt: remoteSince + 60_000,
      lastReply: 'Merged.',
    });
    expect(planNeoWorkFollow(work, behind, { since: remoteSince })).toMatchObject({
      value: expect.stringContaining('Merged.'),
    });
    expect(planNeoWorkFollow(work, behind, { since: work.updatedAt })).toEqual({
      reason: null,
    });
  });
});
