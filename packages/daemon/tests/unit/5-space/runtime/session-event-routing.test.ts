import { describe, expect, test } from 'bun:test';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import type { SessionEventDelivery } from '../../../../src/lib/external-events/session-event-delivery';
import {
  routeSessionExternalEvent,
  type SessionEventRouteDeps,
} from '../../../../src/lib/external-events/session-event-routing';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import type { SessionEventSubscription } from '../../../../src/storage/repositories/session-event-subscription-repository';

function event(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: 'ev-1',
    spaceId: SESSION_EVENT_SCOPE,
    source: 'github',
    topic: 'github/acme/widgets/pull_request/7.review_comment_polled',
    occurredAt: 1,
    ingestedAt: 1,
    dedupeKey: 'k',
    summary: 'review comment',
    payload: { prNumber: 7, actor: 'bot[bot]' },
    urgency: 'immediate',
    ...overrides,
  };
}

const subscription = (sessionId: string, topic: string): SessionEventSubscription => ({
  sessionId,
  topic,
  label: null,
  createdAt: 1,
});

const FOLLOWERS = [
  subscription('s1', 'github/Acme/Widgets/pull_request/7.*'),
  subscription('s2', 'github/acme/widgets/pull_request/7.review_*'),
  subscription('s3', 'github/acme/widgets/pull_request/8.*'),
];

function harness(stored: ExternalEvent | null, subscriptions = FOLLOWERS) {
  const delivered: SessionEventDelivery[] = [];
  const removed: string[] = [];
  let reads = 0;
  let lists = 0;
  const deps: SessionEventRouteDeps = {
    readEvent: () => {
      reads++;
      return stored ? { event: stored, state: 'published', createdAt: 1, updatedAt: 1 } : null;
    },
    listSubscriptions: () => {
      lists++;
      return subscriptions;
    },
    isSessionBusy: () => false,
    deliver: async (delivery) => {
      delivered.push(delivery);
    },
    removeSubscription: (sessionId, topic) => removed.push(`${sessionId} ${topic}`),
  };
  const run = (published: ExternalEvent = stored ?? event()) =>
    routeSessionExternalEvent(deps, {
      spaceId: published.spaceId,
      eventId: published.id,
      topic: published.topic,
    } as ExternalEventPublishedPayload);
  return { run, delivered, removed, counts: () => ({ reads, lists }) };
}

describe('a session external event is routed in one pass', () => {
  test('delivers feedback to the sessions that follow the PR, reading once', async () => {
    const h = harness(event());
    const route = await h.run();
    expect(h.delivered.map((delivery) => delivery.sessionId)).toEqual(['s1', 's2']);
    expect(route).toMatchObject({ ending: [] });
    expect(h.removed).toEqual([]);
    expect(h.counts()).toEqual({ reads: 1, lists: 1 });
  });

  test('a closed PR is delivered and then ends the subscriptions to that PR', async () => {
    const h = harness(event({ topic: 'github/acme/widgets/pull_request/7.closed' }));
    await h.run();
    expect(h.delivered.map((delivery) => delivery.sessionId)).toEqual(['s1', 's2']);
    expect(h.removed).toEqual([
      's1 github/Acme/Widgets/pull_request/7.*',
      's2 github/acme/widgets/pull_request/7.review_*',
    ]);
    expect(h.counts()).toEqual({ reads: 1, lists: 1 });
  });

  test('a poll-mode update ends the subscriptions only once its state is closed', async () => {
    const open = harness(
      event({
        topic: 'github/acme/widgets/pull_request/7.polled',
        payload: { state: 'open' },
        urgency: 'queued',
      })
    );
    expect(await open.run()).toBe('nothing_to_route');
    expect(open.removed).toEqual([]);
    const closed = harness(
      event({
        topic: 'github/acme/widgets/pull_request/7.polled',
        payload: { state: 'closed', merged: true },
        urgency: 'queued',
      })
    );
    await closed.run();
    expect(closed.removed).toHaveLength(2);
    expect(closed.delivered.map((delivery) => delivery.sessionId)).toEqual(['s1', 's2']);
  });

  test('every explicit follower gets its final event before removal', async () => {
    const h = harness(event({ topic: 'github/acme/widgets/pull_request/7.closed' }), FOLLOWERS);
    await h.run();
    expect(h.delivered.map((delivery) => delivery.sessionId)).toEqual(['s1', 's2']);
    expect(h.removed).toEqual([
      's1 github/Acme/Widgets/pull_request/7.*',
      's2 github/acme/widgets/pull_request/7.review_*',
    ]);
  });

  test('ignores Space events without reading the session store', async () => {
    const h = harness(event());
    expect(await h.run(event({ spaceId: 'space-1' }))).toBe('not_session_scope');
    expect(h.counts()).toEqual({ reads: 0, lists: 0 });
  });

  test('stops when the event is not stored', async () => {
    const h = harness(null);
    expect(await h.run(event())).toBe('event_missing');
    expect(h.delivered).toEqual([]);
    expect(h.removed).toEqual([]);
  });
});
