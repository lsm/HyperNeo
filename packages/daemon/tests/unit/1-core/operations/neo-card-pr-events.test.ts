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
import { planNeoCardSend } from '../../../../src/lib/neo/card-events.ts';
import { neoCardPrTopics } from '../../../../src/lib/neo/packs/coding/card-pr-events.ts';
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
    ).toEqual(['github/lsm/hyperneo/pull_request/7.*']);
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

describe('Neo card pull request events', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let service: NeoService;
  let publisher: ExternalEventService;
  let sent: { ref: unknown; message: string }[];
  let watched: string[];

  beforeEach(async () => {
    db = await createTestDb();
    for (const id of ['root', 'native']) db.createSession(createTestSession(id));
    sent = [];
    watched = [];
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.send',
        description: 'test send',
        inputSchema: z.object({ ref: z.unknown(), message: z.string() }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'mutate' },
        execute: async (input: { ref: unknown; message: string }) => {
          sent.push(input);
          return { ok: true, value: { delivered: true } };
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
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
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
        concernId: null,
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

  test('an approval, a 👍 and a plain comment each reach a desktop card session, not Neo', async () => {
    const work = desktopCard();
    attach(work);
    expect(watched).toEqual(['github/lsm/hyperneo/pull_request/7.*']);
    expect(service.followedTopics()).toEqual(['github/lsm/hyperneo/pull_request/7.*']);

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
      concernId: null,
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
        concernId: null,
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
      { workId: 'w-live', topic: 'github/lsm/hyperneo/pull_request/7.*' },
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
      { workId: work.id, topic: 'github/lsm/hyperneo/pull_request/7.*' },
    ]);
    expect(watched).toHaveLength(2);
  });

  test('a session that already subscribed to the pull request itself is not sent it twice', async () => {
    const proposed = service.repo.proposeWork({
      id: 'w-legacy',
      requestKey: 'root:legacy',
      concernId: null,
      originSessionId: 'root',
      originMessageId: 'm3',
      title: 'Fix it',
      instruction: 'Fix it.',
      targetSessionId: 'native',
    });
    attach(
      service.repo.transitionWork(proposed.id, proposed, { status: 'queued', sessionId: 'native' })!
    );
    new SessionEventSubscriptionRepository(db.getDatabase()).upsert({
      sessionId: 'native',
      topic: 'github/lsm/HyperNeo/pull_request/7.*',
    });

    await event('review_submitted', 'Review: APPROVED', { state: 'approved' });

    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'native' })
    ).toEqual([]);
  });
});
