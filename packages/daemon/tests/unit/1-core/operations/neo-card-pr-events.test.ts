import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../../../../src/lib/external-events/session-external-event-store.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { neoCardWorkerSession, planNeoCardSend } from '../../../../src/lib/neo/card-events.ts';
import { isSessionTopicCovered } from '../../../../src/lib/external-events/topic-trie.ts';
import {
  isNeoCardPrActionable,
  neoCardPrTopics,
} from '../../../../src/lib/neo/packs/coding/card-pr-events.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const PR = 'https://github.com/lsm/HyperNeo/pull/7';
const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 'local_worker' };
const open = {
  url: PR,
  state: 'OPEN' as const,
  checks: 'passing' as const,
  review: 'none' as const,
};

describe('neoCardPrTopics', () => {
  test('follows every event of each open pull request, never a merged or closed one', () => {
    expect(
      neoCardPrTopics([
        open,
        { ...open, url: 'https://github.com/lsm/HyperNeo/pull/8', state: 'MERGED' },
      ])
    ).toEqual(['github/lsm/HyperNeo/pull_request/7.*']);
  });
});

describe('isNeoCardPrActionable', () => {
  test.each([
    ['review_submitted', true],
    ['review_comment_created', true],
    ['comment_polled', true],
    ['reaction_added', true],
    ['check_failed', true],
    ['suite_failed', true],
    ['status_failure', true],
    ['merge_conflict', true],
    ['polled', false],
    ['check_skipped', false],
    ['check_cancelled', false],
    ['status_pending', false],
    ['status_success', false],
    ['merge_conflict_resolved', false],
    ['synchronize', false],
  ])('%s forwards: %s', (action, forwards) => {
    expect(isNeoCardPrActionable(action)).toBe(forwards);
  });
});

describe('planNeoCardSend', () => {
  const work = { id: 'w', status: 'queued' as const, report: null, sessionId: 'native' };
  test('sends through the driver when the card runs in another tool, else to its session', () => {
    expect(planNeoCardSend({ work, ref })).toEqual({ via: 'driver', ref });
    expect(planNeoCardSend({ work, ref: null })).toEqual({ via: 'session', sessionId: 'native' });
    expect(planNeoCardSend({ work: { ...work, status: 'cancelled' }, ref })).toEqual({
      via: 'none',
    });
  });
});

describe('neoCardWorkerSession', () => {
  test('names a local HyperNeo worker or the target session, never another tool', () => {
    expect(
      neoCardWorkerSession({ via: 'driver', ref: { adapter: 'hyperneo-sessions', id: 's9' } })
    ).toBe('s9');
    expect(
      neoCardWorkerSession({
        via: 'driver',
        ref: { adapter: 'hyperneo-sessions', daemon: 'tts', id: 's9' },
      })
    ).toBeNull();
    expect(neoCardWorkerSession({ via: 'driver', ref })).toBeNull();
    expect(neoCardWorkerSession({ via: 'session', sessionId: 'native' })).toBe('native');
    expect(neoCardWorkerSession({ via: 'none' })).toBeNull();
  });
});

describe('isSessionTopicCovered', () => {
  const followed = [{ session: 's9', topic: 'github/lsm/HyperNeo/pull_request/7.*' }];
  test.each([
    ['the same PR pattern', 's9', 'github/lsm/hyperneo/pull_request/7.*', true],
    ['one of its events', 's9', 'github/lsm/hyperneo/pull_request/7.review_submitted', true],
    ['a narrower pattern', 's9', 'github/lsm/hyperneo/pull_request/7.review_*', true],
    ['another PR', 's9', 'github/lsm/hyperneo/pull_request/8.*', false],
    ['every PR', 's9', 'github/lsm/hyperneo/pull_request/*', false],
    ['another session', 's1', 'github/lsm/hyperneo/pull_request/7.*', false],
  ] as const)('%s: %s', (_label, session, topic, covered) => {
    expect(isSessionTopicCovered(followed, session, topic)).toBe(covered);
  });
});

describe('Neo card pull request events', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let service: NeoService;
  let publisher: ExternalEventService;
  let sent: { ref: unknown; message: string }[];
  let watched: string[];
  let sendFails = false;

  beforeEach(async () => {
    db = await createTestDb();
    for (const id of ['root', 'native']) db.createSession(createTestSession(id));
    sent = [];
    watched = [];
    sendFails = false;
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.send',
        description: 'test send',
        inputSchema: z.object({ ref: z.unknown(), message: z.string() }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'mutate' },
        execute: async (input: { ref: unknown; message: string }) => {
          sent.push(input);
          return sendFails
            ? { ok: false, reason: 'unreachable' }
            : { ok: true, value: { delivered: true } };
        },
      }),
    ]);
    bus = new InternalEventBus<DaemonInternalEventMap>();
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      bus
    );
    service.watchExternalTopic = async (topic) => {
      watched.push(topic);
    };
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', projectId: null });
    publisher = new ExternalEventService(new SessionExternalEventStore(db.getDatabase()), bus);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function desktopCard(): NeoWork {
    const { work } = service.driverTargets.propose(
      service.repo,
      {
        id: 'w-desktop',
        requestKey: 'root:desktop',
        projectId: null,
        originSessionId: 'root',
        title: 'Fix the bug',
        instruction: 'Fix it and merge.',
      },
      { verb: 'start', adapter: 'claude-desktop', place: { machine: 'm5', name: 'hyperneo' } }
    );
    service.driverTargets.recordRef(work.id, ref, Date.now());
    return service.repo.transitionWork(work.id, work, { status: 'queued' })!;
  }

  function attach(work: NeoWork) {
    service.workPrs.record(work.id, [open], Date.now());
    service.followCardTopics(work.id);
  }

  function subscriptions() {
    return service.cardEvents.listActive();
  }

  let seq = 0;
  async function event(action: string, render: string, payload: Record<string, unknown> = {}) {
    seq += 1;
    const record: ExternalEvent = {
      id: `event-${seq}`,
      spaceId: SESSION_EVENT_SCOPE,
      source: 'github',
      topic: `github/lsm/hyperneo/pull_request/7.${action}`,
      dedupeKey: `lsm/hyperneo:${action}:${seq}`,
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      summary: `PR #7 ${action}`,
      payload: { prUrl: PR, prNumber: 7, actor: 'hyperneo-ai-test[bot]', ...payload },
      render,
    };
    await publisher.publish(record);
  }

  function neoJobs() {
    return db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'root' });
  }

  test.each(['comment_created', 'review_comment_created', 'review_submitted', 'comment_polled'])(
    '%s suppresses driver-signed replies while keeping the same account’s human input',
    async (action) => {
      attach(desktopCard());
      const body = `${'Fixed the reported issue. '.repeat(30)}\n\n_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_`;
      await event(action, 'Own reply', { actor: 'lsm', body });
      expect(sent).toEqual([]);
      expect(subscriptions()).toHaveLength(1);
      await event(action, 'Human reply', {
        actor: 'lsm',
        body: 'Please also cover the edge case.',
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].message).toContain('Please also cover the edge case.');
    }
  );

  test('a quoted footer or unrelated event does not suppress delivery', async () => {
    attach(desktopCard());
    await event('comment_created', 'Quoted', {
      body: '> _🤖 Addressed by [Claude Code](https://claude.com/claude-code)_',
    });
    await event('check_failed', 'Failed', {
      body: '_🤖 Addressed by [Codex](https://chatgpt.com/codex)_',
    });
    expect(sent).toHaveLength(2);
    await event('review_comment_created', 'Own Codex reply', {
      body: 'Fixed.\n\n_🤖 Addressed by [Codex](https://chatgpt.com/codex)_',
    });
    expect(sent).toHaveLength(2);
  });

  test('an approval, a 👍 and a plain comment each reach a desktop card session, not Neo', async () => {
    const work = desktopCard();
    attach(work);
    expect(watched).toEqual(['github/lsm/HyperNeo/pull_request/7.*']);
    expect(service.followedTopics().map((row) => row.topic)).toEqual([
      'github/lsm/HyperNeo/pull_request/7.*',
    ]);

    await event('review_submitted', 'Review: APPROVED', { state: 'approved' });
    await event('reaction_added', 'Reaction: +1', { content: '+1' });
    await event('comment_created', 'No issues found.');

    expect(sent.map((item) => item.ref)).toEqual([ref, ref, ref]);
    expect(sent.map((item) => item.message)).toEqual([
      expect.stringContaining('7.review_submitted'),
      expect.stringContaining('Reactions on PR #7'),
      expect.stringContaining('7.comment_created'),
    ]);
    expect(sent[0]?.message).toContain(PR);
    expect(neoJobs()).toEqual([]);
  });

  test('delivers the merge, then nothing more for that pull request', async () => {
    attach(desktopCard());

    await event('closed', 'Merged.', { state: 'closed', merged: true });
    await event('comment_created', 'Late comment.');

    expect(sent.map((item) => item.message)).toEqual([expect.stringContaining('7.closed')]);
    expect(subscriptions()).toEqual([]);
    expect(service.followedTopics()).toEqual([]);
    expect(neoJobs()).toEqual([]);
  });

  test('a card running in a HyperNeo session gets the event in that session', async () => {
    const proposed = service.repo.proposeWork({
      id: 'w-native',
      requestKey: 'root:native',
      projectId: null,
      originSessionId: 'root',
      originMessageId: 'm1',
      title: 'Fix it',
      instruction: 'Fix it.',
      targetSessionId: 'native',
    });
    const work = service.repo.transitionWork(proposed.id, proposed, {
      status: 'queued',
      sessionId: 'native',
    })!;
    attach(work);

    await event('review_submitted', 'Review: APPROVED', { state: 'approved' });

    expect(sent).toEqual([]);
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', {
        'to.sessionId': 'native',
        messageUuid: 'neo-card-event:w-native:event-' + String(seq),
      })
    ).toHaveLength(1);
    expect(neoJobs()).toEqual([]);
  });

  function clubCard(id: string, opener: string): NeoWork {
    const { work } = service.driverTargets.propose(
      service.repo,
      {
        id,
        requestKey: `${opener}:${id}`,
        projectId: 'club',
        originSessionId: opener,
        title: 'Ship the club page',
        instruction: 'Ship it.',
      },
      { verb: 'start', adapter: 'claude-desktop', place: { machine: 'm5', name: 'hyperneo' } }
    );
    service.askRecords.open(
      {
        id: `ask-${id}`,
        requestKey: `ask-${id}`,
        projectId: 'club',
        originSessionId: opener,
        originMessageId: `m-${id}`,
        title: id,
        ask: id,
        doneWhen: id,
        doneSource: 'human',
      },
      [{ text: 'The page is live', check: null, deliveredBy: id }]
    );
    service.driverTargets.recordRef(work.id, ref, Date.now());
    const queued = service.repo.transitionWork(work.id, work, { status: 'queued' })!;
    attach(queued);
    return queued;
  }

  function holderNotes() {
    return db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo:club' });
  }

  describe('the project holder', () => {
    beforeEach(() => {
      service.repo.saveProject({ id: 'club', title: 'Club', summary: 'Book club', context: '' }, 0);
      db.createSession(createTestSession('neo:club'));
      service.repo.reserveBinding({ sessionId: 'neo:club', kind: 'project', projectId: 'club' });
    });

    test('hears its project’s card events once, whoever opened the cards', async () => {
      clubCard('w-a', 'root');
      clubCard('w-b', 'root');

      await event('closed', 'Merged.', { state: 'closed', merged: true });

      expect(sent).toHaveLength(2);
      expect(holderNotes().map((job) => job.payload.messageUuid)).toEqual([
        `neo-project-event:club:event-${seq}`,
      ]);
    });

    test('is not told again about an ask it owns', async () => {
      clubCard('w-own', 'neo:club');

      await event('check_failed', 'Failed.');

      expect(sent).toHaveLength(1);
      expect(holderNotes()).toEqual([]);
    });
  });

  test('without the coding pack nothing is subscribed or delivered', async () => {
    db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
    attach(desktopCard());

    await event('review_submitted', 'Review: APPROVED', { state: 'approved' });

    expect(subscriptions()).toEqual([]);
    expect(watched).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('a cancelled card, or one whose pack is off, stops following its pull request', async () => {
    const cancelled = desktopCard();
    attach(cancelled);
    service.repo.transitionWork(cancelled.id, cancelled, { status: 'cancelled' });
    expect(service.endUnfollowedCardTopics(Date.now())).toHaveLength(1);
    expect(service.followedTopics()).toEqual([]);

    const live = service.repo.transitionWork(
      service.repo.proposeWork({
        id: 'w-live',
        requestKey: 'root:live',
        projectId: null,
        originSessionId: 'root',
        originMessageId: 'm2',
        title: 'Fix more',
        instruction: 'Fix more.',
        targetSessionId: 'native',
      }).id,
      service.repo.getWork('w-live')!,
      { status: 'queued', sessionId: 'native' }
    )!;
    attach(live);
    expect(service.endUnfollowedCardTopics(Date.now())).toEqual([]);
    db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
    expect(service.endUnfollowedCardTopics(Date.now())).toEqual([
      { workId: 'w-live', topic: 'github/lsm/HyperNeo/pull_request/7.*' },
    ]);
    expect(service.followedTopics()).toEqual([]);
  });

  test('a pull request that is open again is followed again', async () => {
    const work = desktopCard();
    attach(work);
    await event('closed', 'Closed.', { state: 'closed' });
    expect(subscriptions()).toEqual([]);

    service.followCardTopics(work.id);

    expect(subscriptions()).toEqual([
      { workId: work.id, topic: 'github/lsm/HyperNeo/pull_request/7.*' },
    ]);
    expect(watched).toHaveLength(2);
  });

  test("a session's own subscription to its card's pull request is covered, and stays stored", async () => {
    const proposed = service.repo.proposeWork({
      id: 'w-legacy',
      requestKey: 'root:legacy',
      projectId: null,
      originSessionId: 'root',
      originMessageId: 'm3',
      title: 'Fix it',
      instruction: 'Fix it.',
      targetSessionId: 'native',
    });
    const own = new SessionEventSubscriptionRepository(db.getDatabase());
    own.upsert({ sessionId: 'native', topic: 'github/lsm/hyperneo/pull_request/7.*' });
    own.upsert({ sessionId: 'native', topic: 'github/lsm/HyperNeo/pull_request/9.*' });

    attach(
      service.repo.transitionWork(proposed.id, proposed, { status: 'queued', sessionId: 'native' })!
    );
    await event('reaction_added', 'Reaction: +1', { content: '+1' });

    expect(own.listBySession('native')).toHaveLength(2);
    expect(
      isSessionTopicCovered(
        service.followedTopics(),
        'native',
        'github/lsm/hyperneo/pull_request/7.*'
      )
    ).toBe(true);
    expect(
      isSessionTopicCovered(
        service.followedTopics(),
        'native',
        'github/lsm/HyperNeo/pull_request/9.*'
      )
    ).toBe(false);
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'native' })
    ).toHaveLength(1);
  });

  test('a HyperNeo driver card covers its worker session, which the card reaches by work.send', async () => {
    const { work } = service.driverTargets.propose(
      service.repo,
      {
        id: 'w-hyperneo',
        requestKey: 'root:hyperneo',
        projectId: null,
        originSessionId: 'root',
        title: 'Fix the bug',
        instruction: 'Fix it and merge.',
      },
      { verb: 'start', adapter: 'hyperneo-sessions', place: { machine: 'm5', name: 'hyperneo' } }
    );
    service.driverTargets.recordRef(
      work.id,
      { adapter: 'hyperneo-sessions', id: 'worker-s' },
      Date.now()
    );
    attach(service.repo.transitionWork(work.id, work, { status: 'queued' })!);
    expect(
      isSessionTopicCovered(
        service.followedTopics(),
        'worker-s',
        'github/lsm/hyperneo/pull_request/7.*'
      )
    ).toBe(true);
    await event('review_submitted', 'Review: changes requested');
    expect(sent).toHaveLength(1);
  });

  test('a PR state a raw event already carried to the card is not relayed again', async () => {
    const work = desktopCard();
    service.workPrs.record(work.id, [{ ...open, checks: 'failing' }], Date.now());
    service.followCardTopics(work.id);
    await event('check_failed', 'Check failed: lint');
    expect(sent).toHaveLength(1);
    expect(service['cardPrRelays'].get(work.id)).not.toBeNull();
    await service['relayCardPr'](work.id);
    expect(sent).toHaveLength(1);
  });

  test('a PR state the worker never received is still relayed', async () => {
    const work = desktopCard();
    service.workPrs.record(work.id, [{ ...open, checks: 'failing' }], Date.now());
    service.followCardTopics(work.id);
    sendFails = true;
    await event('check_failed', 'Check failed: lint');
    expect(service['cardPrRelays'].get(work.id)).toBeNull();
  });

  test("a finished card neither follows its pull request nor covers the session's own subscription", async () => {
    const proposed = service.repo.proposeWork({
      id: 'w-done',
      requestKey: 'root:done',
      projectId: null,
      originSessionId: 'root',
      originMessageId: 'm4',
      title: 'Fix it',
      instruction: 'Fix it.',
      targetSessionId: 'native',
    });
    const queued = service.repo.transitionWork(proposed.id, proposed, {
      status: 'queued',
      sessionId: 'native',
    })!;
    const cancelled = service.repo.transitionWork(queued.id, queued, { status: 'cancelled' })!;
    const own = new SessionEventSubscriptionRepository(db.getDatabase());
    own.upsert({ sessionId: 'native', topic: 'github/lsm/HyperNeo/pull_request/7.*' });

    attach(cancelled);

    expect(subscriptions()).toEqual([]);
    expect(own.listBySession('native')).toHaveLength(1);
    expect(
      isSessionTopicCovered(
        service.followedTopics(),
        'native',
        'github/lsm/HyperNeo/pull_request/7.*'
      )
    ).toBe(false);
  });

  test('a PR read as merged stays followed until its merge event reaches the card', async () => {
    const work = desktopCard();
    attach(work);
    service.workPrs.record(work.id, [{ ...open, state: 'MERGED' }], Date.now());

    expect(service.endUnfollowedCardTopics(Date.now())).toEqual([]);
    await event('closed', 'Merged.', { state: 'closed', merged: true });

    expect(sent.map((item) => item.message)).toEqual([expect.stringContaining('7.closed')]);
    expect(subscriptions()).toEqual([]);
  });

  test('routine polls and skipped checks never reach the card; an open PR stays followed', async () => {
    attach(desktopCard());

    await event('polled', 'PR #7 state: open', { state: 'open' });
    await event('check_skipped', 'CI check skipped', { conclusion: 'skipped' });
    await event('check_failed', 'CI check failed', { conclusion: 'failure' });

    expect(sent.map((item) => item.message)).toEqual([expect.stringContaining('failure')]);
    expect(subscriptions()).toHaveLength(1);
  });
});
