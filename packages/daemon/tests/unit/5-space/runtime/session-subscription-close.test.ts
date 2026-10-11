import { describe, expect, test } from 'bun:test';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import {
  endClosedPrSubscriptions,
  isPrSubscription,
  type SessionSubscriptionCloseDeps,
} from '../../../../src/lib/external-events/session-subscription-close';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import type { SessionEventSubscription } from '../../../../src/storage/repositories/session-event-subscription-repository';

const subscription = (sessionId: string, topic: string): SessionEventSubscription => ({
  sessionId,
  topic,
  label: null,
  createdAt: 1,
});

function harness(event: Partial<ExternalEvent>, subscriptions: SessionEventSubscription[]) {
  const removed: string[] = [];
  const stored: ExternalEvent = {
    id: 'e1',
    spaceId: SESSION_EVENT_SCOPE,
    source: 'github',
    topic: 'github/acme/widgets/pull_request/7.closed',
    occurredAt: 1,
    ingestedAt: 1,
    summary: 'closed',
    dedupeKey: 'k',
    payload: {},
    ...event,
  };
  const deps: SessionSubscriptionCloseDeps = {
    readEvent: (id) =>
      id === stored.id ? { event: stored, state: 'published', createdAt: 1, updatedAt: 1 } : null,
    listSubscriptions: () => subscriptions,
    removeSubscription: (sessionId, topic) => removed.push(`${sessionId} ${topic}`),
  };
  const payload = {
    spaceId: stored.spaceId,
    eventId: stored.id,
    topic: stored.topic,
  } as ExternalEventPublishedPayload;
  return { run: () => endClosedPrSubscriptions(deps, payload), removed };
}

const subscriptions = [
  subscription('s1', 'github/Acme/Widgets/pull_request/7.*'),
  subscription('s2', 'github/acme/widgets/pull_request/7.review_*'),
  subscription('s3', 'github/acme/widgets/pull_request/8.*'),
  subscription('s4', 'github/acme/widgets/pull_request/*.review_*'),
  subscription('s5', 'github/acme/other/pull_request/7.*'),
];

describe('a PR closing ends the session subscriptions that follow it', () => {
  test('a closed PR ends every session subscription to that PR and nothing else', async () => {
    const { run, removed } = harness({}, subscriptions);
    await run();
    expect(removed).toEqual([
      's1 github/Acme/Widgets/pull_request/7.*',
      's2 github/acme/widgets/pull_request/7.review_*',
    ]);
  });

  test('a poll-mode update ends them only once its state is closed', async () => {
    const open = harness(
      { topic: 'github/acme/widgets/pull_request/7.polled', payload: { state: 'open' } },
      subscriptions
    );
    expect(await open.run()).toBe('pr_not_closed');
    expect(open.removed).toEqual([]);
    const merged = harness(
      {
        topic: 'github/acme/widgets/pull_request/7.polled',
        payload: { state: 'closed', merged: true },
      },
      subscriptions
    );
    await merged.run();
    expect(merged.removed).toHaveLength(2);
  });

  test('skips Space events, other actions and PRs nobody follows', async () => {
    const space = harness({ spaceId: 'space-1' }, subscriptions);
    expect(await space.run()).toBe('not_session_scope');
    const review = harness(
      { topic: 'github/acme/widgets/pull_request/7.review_submitted' },
      subscriptions
    );
    expect(await review.run()).toBe('pr_not_closed');
    const unfollowed = harness(
      { topic: 'github/acme/widgets/pull_request/9.closed' },
      subscriptions
    );
    expect(await unfollowed.run()).toBe('no_pr_subscriptions');
    expect([...space.removed, ...review.removed, ...unfollowed.removed]).toEqual([]);
  });
});

describe('isPrSubscription', () => {
  const pr = { owner: 'acme', repo: 'widgets', prNumber: '7' };
  test.each([
    ['github/ACME/widgets/pull_request/7.*', true],
    ['github/acme/widgets/pull_request/7.closed', true],
    ['github/acme/widgets/pull_request/70.*', false],
    ['github/acme/widgets/pull_request/*.closed', false],
    ['github/*/widgets/pull_request/7.*', false],
    ['github/acme/widgets/repo/7.*', false],
  ] as const)('%s', (pattern, expected) => {
    expect(isPrSubscription(pattern, pr)).toBe(expected);
  });
});
