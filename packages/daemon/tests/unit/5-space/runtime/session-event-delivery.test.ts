import { describe, expect, test } from 'bun:test';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import {
  deliverSessionExternalEvent,
  mailSessionEvent,
  planSessionEventDeliveries,
  requireSessionFeedbackEvent,
  SESSION_EVENT_ORIGIN,
  type SessionEventDelivery,
  type SessionEventDeliveryDeps,
  sessionEventHeadline,
  topicMatchesPattern,
} from '../../../../src/lib/external-events/session-event-delivery';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import {
  type SessionEventSubscription,
  SessionEventSubscriptionRepository,
} from '../../../../src/storage/repositories/session-event-subscription-repository';
import { runMigration329 } from '../../../../src/storage/schema/m329-session-event-subscriptions';
import { Database } from '../../../../src/storage/sqlite-compat';

const PR = 'https://github.com/acme/widgets/pull/7';
const PR_TOPIC = 'github/acme/widgets/pull_request/7.*';

function event(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: 'ev-1',
    spaceId: SESSION_EVENT_SCOPE,
    source: 'github',
    topic: 'github/acme/widgets/pull_request/7.review_comment_polled',
    occurredAt: 1_700_000_000_000,
    ingestedAt: 1_700_000_001_000,
    dedupeKey: 'acme/widgets:review_comment:1',
    summary: 'PR #7 pull_request_review_comment by bot[bot]: fix this',
    externalUrl: `${PR}#discussion_r1`,
    payload: { prUrl: PR, prNumber: 7, actor: 'bot[bot]' },
    urgency: 'immediate',
    render: '- Review comment by bot[bot]\n  fix this',
    ...overrides,
  };
}

function subscription(sessionId: string, topic = PR_TOPIC): SessionEventSubscription {
  return { sessionId, topic, label: null, createdAt: 1 };
}

function published(stored: ExternalEvent): ExternalEventPublishedPayload {
  return {
    namespaceId: stored.spaceId,
    spaceId: stored.spaceId,
    eventId: stored.id,
    source: stored.source,
    topic: stored.topic,
    dedupeKey: stored.dedupeKey,
    summary: stored.summary,
    externalUrl: stored.externalUrl,
    payload: stored.payload,
    occurredAt: stored.occurredAt,
    ingestedAt: stored.ingestedAt,
  };
}

describe('topicMatchesPattern', () => {
  test('a pull request pattern matches every action on that pull request, in any case', () => {
    expect(
      topicMatchesPattern(PR_TOPIC, 'github/acme/widgets/pull_request/7.review_submitted')
    ).toBe(true);
    expect(topicMatchesPattern(PR_TOPIC, 'github/Acme/Widgets/pull_request/7.check_failed')).toBe(
      true
    );
  });

  test('another pull request or a different depth does not match', () => {
    expect(topicMatchesPattern(PR_TOPIC, 'github/acme/widgets/pull_request/70.check_failed')).toBe(
      false
    );
    expect(topicMatchesPattern(PR_TOPIC, 'github/acme/widgets/pull_request')).toBe(false);
    expect(topicMatchesPattern(PR_TOPIC, 'github/acme/other/pull_request/7.check_failed')).toBe(
      false
    );
  });
});

describe('sessionEventHeadline', () => {
  test('names the event, its pull request and who caused it', () => {
    expect(sessionEventHeadline(event())).toBe(`PR #7 review comment — ${PR} — by bot[bot]`);
  });

  test('prefers the event title when the payload carries one', () => {
    expect(
      sessionEventHeadline(
        event({
          topic: 'github/acme/widgets/pull_request/7.review_submitted',
          payload: { prUrl: PR, prNumber: 7, actor: 'alice', title: 'PR #7 review APPROVED' },
        })
      )
    ).toBe(`PR #7 review APPROVED — ${PR} — by alice`);
  });
});

describe('requireSessionFeedbackEvent', () => {
  test('urgent events are delivered right away', () => {
    expect(requireSessionFeedbackEvent(event())).toEqual({
      value: { event: event(), urgent: true },
    });
  });

  test('queued review and comment events are feedback but not urgent', () => {
    const comment = event({
      topic: 'github/acme/widgets/pull_request/7.comment_polled',
      urgency: 'queued',
    });
    expect(requireSessionFeedbackEvent(comment)).toEqual({
      value: { event: comment, urgent: false },
    });
  });

  test('pushes and settled checks are not feedback', () => {
    for (const topic of [
      'github/acme/widgets/pull_request/7.polled',
      'github/acme/widgets/pull_request/7.check_failed',
      'github/acme/widgets/pull_request/7.merge_conflict_resolved',
    ]) {
      expect(requireSessionFeedbackEvent(event({ topic, urgency: 'queued' }))).toEqual({
        reason: 'not_feedback',
      });
    }
  });
});

describe('planSessionEventDeliveries', () => {
  const subscribed = {
    subscriptions: [
      subscription('s1'),
      subscription('s1', 'github/acme/widgets/pull_request/*.review_*'),
      subscription('s2'),
      subscription('s3', 'github/acme/widgets/pull_request/8.*'),
    ],
  };

  test('delivers once to each subscribed session, urgent events even to busy ones', () => {
    const planned = planSessionEventDeliveries(
      { event: event(), urgent: true },
      subscribed,
      () => true
    );
    if (!('value' in planned)) throw new Error('expected deliveries');
    expect(planned.value.map((delivery) => [delivery.sessionId, delivery.mode])).toEqual([
      ['s1', 'immediate'],
      ['s2', 'immediate'],
    ]);
    expect(planned.value[0].text).toBe(
      `PR #7 review comment — ${PR} — by bot[bot]\n- Review comment by bot[bot]\n  fix this`
    );
    expect(new Set(planned.value.map((delivery) => delivery.messageUuid)).size).toBe(2);
  });

  test('a queued event waits for a busy session to finish and wakes an idle one', () => {
    const planned = planSessionEventDeliveries(
      { event: event({ urgency: 'queued' }), urgent: false },
      subscribed,
      (sessionId) => sessionId === 's1'
    );
    if (!('value' in planned)) throw new Error('expected deliveries');
    expect(planned.value.map((delivery) => [delivery.sessionId, delivery.mode])).toEqual([
      ['s1', 'defer'],
      ['s2', 'immediate'],
    ]);
  });

  test('an event nobody follows has no deliveries', () => {
    expect(
      planSessionEventDeliveries(
        {
          event: event({ topic: 'github/acme/widgets/pull_request/9.comment_polled' }),
          urgent: true,
        },
        subscribed,
        () => false
      )
    ).toEqual({ reason: 'no_subscribers' });
  });

  test('the same event and session always produce the same message id', () => {
    const first = planSessionEventDeliveries(
      { event: event(), urgent: true },
      subscribed,
      () => false
    );
    const again = planSessionEventDeliveries(
      { event: event(), urgent: true },
      subscribed,
      () => false
    );
    expect(first).toEqual(again);
  });
});

describe('deliverSessionExternalEvent', () => {
  function deps(stored: ExternalEvent | null, subscriptions: SessionEventSubscription[]) {
    const delivered: SessionEventDelivery[] = [];
    const reads: string[] = [];
    const value: SessionEventDeliveryDeps = {
      readEvent: (eventId) => {
        reads.push(eventId);
        return stored ? { event: stored, state: 'published', createdAt: 1, updatedAt: 1 } : null;
      },
      listSubscriptions: () => subscriptions,
      isSessionBusy: () => false,
      deliver: async (delivery) => {
        delivered.push(delivery);
      },
    };
    return { value, delivered, reads };
  }

  test('delivers a stored session event to the sessions that follow its pull request', async () => {
    const { value, delivered } = deps(event(), [subscription('s1'), subscription('s2')]);
    const result = await deliverSessionExternalEvent(value, published(event()));
    expect(delivered.map((delivery) => delivery.sessionId)).toEqual(['s1', 's2']);
    expect(result).toEqual(delivered);
  });

  test('ignores Space events without reading the session store', async () => {
    const { value, delivered, reads } = deps(event(), [subscription('s1')]);
    const result = await deliverSessionExternalEvent(
      value,
      published(event({ spaceId: 'space-1' }))
    );
    expect(result).toBe('not_session_scope');
    expect(reads).toEqual([]);
    expect(delivered).toEqual([]);
  });

  test('stops when the event is not stored', async () => {
    const { value, delivered } = deps(null, [subscription('s1')]);
    expect(await deliverSessionExternalEvent(value, published(event()))).toBe('event_missing');
    expect(delivered).toEqual([]);
  });
});

describe('mailSessionEvent', () => {
  test('hands the event to the session mailbox as system input under its message id', async () => {
    const enqueued: { payload: Record<string, unknown> }[] = [];
    const jobQueue = {
      enqueueUniquePending: (args: { payload: Record<string, unknown> }) => {
        enqueued.push(args);
      },
    } as unknown as JobQueueRepository;
    const outcome = await mailSessionEvent(jobQueue, {
      sessionId: 's1',
      messageUuid: 'ev-1234',
      text: 'PR #7 review comment',
      mode: 'defer',
    });
    expect(outcome.kind).toBe('enqueued');
    expect(enqueued[0].payload).toMatchObject({
      to: { kind: 'session', sessionId: 's1' },
      origin: SESSION_EVENT_ORIGIN,
      messageUuid: 'ev-1234',
      deliveryMode: 'defer',
      message: { message: { content: 'PR #7 review comment' }, inputKind: 'system' },
    });
  });
});

describe('SessionEventSubscriptionRepository.listAll', () => {
  test('lists every session subscription in the order they were made', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO sessions (id) VALUES ('s1'), ('s2')");
    runMigration329(db);
    const repo = new SessionEventSubscriptionRepository(db);
    repo.upsert({ sessionId: 's2', topic: PR_TOPIC });
    repo.upsert({ sessionId: 's1', topic: 'github/acme/widgets/pull_request/8.*' });
    expect(repo.listAll().map((row) => [row.sessionId, row.topic])).toEqual([
      ['s2', PR_TOPIC],
      ['s1', 'github/acme/widgets/pull_request/8.*'],
    ]);
  });
});
