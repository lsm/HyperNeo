import { describe, expect, test } from 'bun:test';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import {
  mailSessionEvent,
  planSessionEventDeliveries,
  requireSessionFeedbackEvent,
  SESSION_EVENT_ORIGIN,
  type SessionEventDelivery,
  sessionEventHeadline,
} from '../../../../src/lib/external-events/session-event-delivery';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import { topicMatchesPattern } from '../../../../src/lib/external-events/topic-trie';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createMailboxTestDb } from '../../../helpers/mailbox-test-db';
import {
  type SessionEventSubscription,
  SessionEventSubscriptionRepository,
} from '../../../../src/storage/repositories/session-event-subscription-repository';
import { runMigration329 } from '../../../../src/storage/schema/m329-session-event-subscriptions';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery.ts';
import { NeoWakeQueueRepository } from '../../../../src/storage/repositories/neo-wake-queue-repository.ts';

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

describe('mailSessionEvent', () => {
  test('urgent GitHub feedback reaches Neo immediately rather than entering its note queue', async () => {
    const db = createMailboxTestDb();
    try {
      db.db
        .prepare("INSERT INTO neo_session_bindings(session_id,kind) VALUES ('neo:feedback','neo')")
        .run();
      await mailSessionEvent(db.jobQueue, {
        sessionId: 'neo:feedback',
        messageUuid: 'urgent-review',
        text: 'PR review needs action.',
        mode: 'immediate',
      });
      const handler = createMailboxDeliveryHandler({
        jobQueue: db.jobQueue,
        db: db.db,
        sdkMessageRepo: db.sdkMessageRepo,
        getSession: async () => ({}),
        isSessionArchived: () => false,
        prepareEntry: async (entry, id) => new NeoWakeQueueRepository(db.db).prepare(entry, id, entry.origin === 'chat' || !!entry.message.workerReportKind || !!entry.message.neoWakeEvent),
      });
      await handler(db.jobQueue.dequeue('mailbox')[0]);
      expect(db.sdkRows().map((row) => row.sdk_uuid)).toEqual(['urgent-review']);
    } finally {
      db.close();
    }
  });
  test('hands the event to the session mailbox as system input under its message id', async () => {
    const db = createMailboxTestDb();
    try {
      const outcome = await mailSessionEvent(db.jobQueue, {
        sessionId: 's1',
        messageUuid: 'ev-1234',
        text: 'PR #7 review comment',
        mode: 'defer',
      });
      expect(outcome.kind).toBe('enqueued');
      expect(JSON.parse(db.jobsByQueue('mailbox')[0].payload)).toMatchObject({
        to: { kind: 'session', sessionId: 's1' },
        origin: SESSION_EVENT_ORIGIN,
        messageUuid: 'ev-1234',
        deliveryMode: 'defer',
        message: { message: { content: 'PR #7 review comment' }, inputKind: 'system' },
      });
    } finally {
      db.close();
    }
  });

  test('accepts the same event once per destination even after the job is consumed', async () => {
    const db = createMailboxTestDb();
    const delivery = {
      sessionId: 's1',
      messageUuid: 'ev-terminal',
      text: 'PR #7 closed',
      mode: 'immediate' as const,
    };
    try {
      const first = await mailSessionEvent(db.jobQueue, delivery);
      expect(first.kind).toBe('enqueued');
      db.db.exec("UPDATE job_queue SET status = 'completed'");
      expect(await mailSessionEvent(db.jobQueue, { ...delivery, mode: 'defer' })).toEqual(first);
      expect(db.jobsByQueue('mailbox')).toHaveLength(1);
      expect((await mailSessionEvent(db.jobQueue, { ...delivery, sessionId: 's2' })).kind).toBe(
        'enqueued'
      );
      expect(db.jobsByQueue('mailbox')).toHaveLength(2);
      expect(
        await mailSessionEvent(db.jobQueue, { ...delivery, text: 'different event content' })
      ).toMatchObject({
        kind: 'rejected',
        reason: expect.stringContaining('idempotency_conflict'),
      });
      expect(db.jobsByQueue('mailbox')).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test.each(['job_queue', 'message_send_receipts'])(
    'a failed %s insert rolls back acceptance and can be retried',
    async (table) => {
      const db = createMailboxTestDb();
      const delivery = {
        sessionId: 's1',
        messageUuid: 'ev-retry',
        text: 'PR #7 closed',
        mode: 'immediate' as const,
      };
      try {
        db.db.exec(
          `CREATE TRIGGER reject_mailbox BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic mailbox unavailable'); END`
        );
        expect(await mailSessionEvent(db.jobQueue, delivery)).toMatchObject({
          kind: 'rejected',
          reason: expect.stringContaining('synthetic mailbox unavailable'),
        });
        expect(db.db.prepare('SELECT * FROM message_send_receipts').all()).toEqual([]);
        expect(db.jobsByQueue('mailbox')).toEqual([]);
        db.db.exec('DROP TRIGGER reject_mailbox');
        expect((await mailSessionEvent(db.jobQueue, delivery)).kind).toBe('enqueued');
        expect(db.db.prepare('SELECT * FROM message_send_receipts').all()).toHaveLength(1);
        expect(db.jobsByQueue('mailbox')).toHaveLength(1);
      } finally {
        db.close();
      }
    }
  );
});

describe('SessionEventSubscriptionRepository.listAll', () => {
  test('lists active subscriptions in order without deleting archived subscriptions', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT DEFAULT 'active')");
    db.exec("INSERT INTO sessions (id) VALUES ('s1'), ('s2')");
    db.exec("INSERT INTO sessions (id, status) VALUES ('s3', 'archived')");
    runMigration329(db);
    const repo = new SessionEventSubscriptionRepository(db);
    repo.upsert({ sessionId: 's2', topic: PR_TOPIC });
    repo.upsert({ sessionId: 's1', topic: 'github/acme/widgets/pull_request/8.*' });
    repo.upsert({ sessionId: 's3', topic: PR_TOPIC });
    expect(repo.listAll().map((row) => [row.sessionId, row.topic])).toEqual([
      ['s2', PR_TOPIC],
      ['s1', 'github/acme/widgets/pull_request/8.*'],
    ]);
    expect(repo.listBySession('s3')).toHaveLength(1);
    db.exec("UPDATE sessions SET status = 'active' WHERE id = 's3'");
    expect(repo.listAll().map((row) => row.sessionId)).toEqual(['s2', 's1', 's3']);
  });
});
