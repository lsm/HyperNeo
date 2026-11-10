import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deliveryState } from '../../../../src/lib/external-events/session-event-operations.ts';
import { sessionEventMessageUuid } from '../../../../src/lib/external-events/session-event-delivery.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../../../../src/lib/external-events/session-external-event-store.ts';
import {
  PLAIN_SESSION_SCOPE,
  resolveCallerIdentity,
} from '../../../../src/lib/operations/caller.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import type { FamilyOperationContext } from '../../../../src/lib/rpc-handlers/family-operations/context.ts';
import { registerSessionEventOperations } from '../../../../src/lib/rpc-handlers/family-operations/external-events.ts';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const PR = 'https://github.com/Acme/Widgets/pull/7';
const PR_TOPIC = 'github/Acme/Widgets/pull_request/7.*';
const NAMES = [
  'event.external.subscribe',
  'event.external.unsubscribe',
  'event.external.subscription.list',
  'event.external.get',
  'event.external.delivery.list',
];

describe('session event operations without Space', () => {
  let db: TestDb;
  let registry: OperationRegistry;
  let watched: string[];
  const caller: OperationCaller = {
    ...resolveCallerIdentity(PLAIN_SESSION_SCOPE, 's-plain'),
    source: 'mcp',
  };

  const context = (sessionSpace?: FamilyOperationContext['sessionSpace']) =>
    ({
      sessionSpace,
      deps: {
        db,
        jobQueue: db.getJobQueueRepo(),
        watchSessionRepo: async (owner: string, repo: string) => {
          watched.push(`${owner}/${repo}`);
          return null;
        },
      },
    }) as unknown as Pick<FamilyOperationContext, 'deps' | 'sessionSpace'>;

  async function run(name: string, input: unknown, as: OperationCaller = caller) {
    const outcome = await invokeOperation(registry, name, input, as);
    if (outcome.kind !== 'completed') throw new Error(`${name}: ${outcome.message}`);
    return outcome.value;
  }

  function storeEvent(id: string) {
    new SessionExternalEventStore(db.getDatabase()).store({
      id,
      spaceId: SESSION_EVENT_SCOPE,
      source: 'github',
      topic: 'github/Acme/Widgets/pull_request/7.review_submitted',
      dedupeKey: id,
      occurredAt: 1,
      ingestedAt: 2,
      summary: `Summary ${id}`,
      payload: {},
    });
  }

  beforeEach(async () => {
    db = await createTestDb();
    watched = [];
    await db.createSession(createTestSession('s-plain'));
    registry = createOperationRegistry(registerSessionEventOperations(context()));
  });
  afterEach(() => db.close());

  test('registers all five operations when Space is absent, and none when Space owns them', () => {
    expect(registry.entries.map((entry) => entry.name).sort()).toEqual([...NAMES].sort());
    const withSpace = context({} as FamilyOperationContext['sessionSpace']);
    expect(registerSessionEventOperations(withSpace)).toEqual([]);
  });

  test('a plain session subscribes, lists and unsubscribes itself by prUrl', async () => {
    expect(await run('event.external.subscribe', { prUrl: PR, label: 'mine' })).toEqual({
      ok: true,
      topicPattern: PR_TOPIC,
    });
    expect(watched).toEqual(['Acme/Widgets']);
    expect(await run('event.external.subscription.list', {})).toMatchObject({
      ok: true,
      owner: { type: 'session', id: 's-plain' },
      stored: [{ topic: PR_TOPIC, label: 'mine' }],
    });
    expect(await run('event.external.unsubscribe', { prUrl: PR })).toEqual({
      ok: true,
      topicPattern: PR_TOPIC,
    });
    const repo = new SessionEventSubscriptionRepository(db.getDatabase());
    expect(repo.listBySession('s-plain')).toEqual([]);
  });

  test('rejects a bad glob, an archived session and a caller without a session', async () => {
    expect(await run('event.external.subscribe', { topicPattern: 'a//b' })).toBe('invalid_pattern');
    await db.createSession({ ...createTestSession('s-gone'), status: 'archived' });
    const archived: OperationCaller = { ...caller, sessionId: 's-gone' };
    expect(await run('event.external.subscription.list', {}, archived)).toBe('session_inactive');
    expect(await run('event.external.subscription.list', {}, { source: 'rpc' })).toBe(
      'caller_denied'
    );
  });

  test('get reads only events delivered to this session, and Neo reads any', async () => {
    storeEvent('e1');
    storeEvent('theirs');
    const jobs = db.getJobQueueRepo();
    jobs.enqueue({
      queue: 'mailbox',
      payload: { messageUuid: sessionEventMessageUuid('e1', 's-plain') },
    });
    expect(await run('event.external.get', { eventId: 'e1' })).toMatchObject({
      event: { id: 'e1', summary: 'Summary e1' },
      state: 'published',
    });
    expect(await run('event.external.get', { eventId: 'theirs' })).toBe('event_not_found');
    expect(await run('event.external.get', { eventId: 'nope' })).toBe('event_not_found');
    const neo: OperationCaller = { ...caller, role: 'neo' };
    expect(await run('event.external.get', { eventId: 'theirs' }, neo)).toMatchObject({
      event: { id: 'theirs' },
    });
  });

  test('delivery list reports this session mailbox jobs only, filtered by state', async () => {
    storeEvent('mine');
    storeEvent('theirs');
    const jobs = db.getJobQueueRepo();
    const job = (eventId: string, sessionId: string) =>
      jobs.enqueue({
        queue: 'mailbox',
        payload: { messageUuid: sessionEventMessageUuid(eventId, sessionId) },
      });
    job('mine', 's-plain');
    job('theirs', 's-other');
    expect(await run('event.external.delivery.list', {})).toMatchObject({
      deliveries: [{ eventId: 'mine', state: 'pending' }],
    });
    expect(await run('event.external.delivery.list', { state: 'delivered' })).toEqual({
      deliveries: [],
    });
  });
});

describe('deliveryState', () => {
  const job = (status: Job['status']) => ({ status }) as Job;

  test('a saved or deferred message is pending until the session consumes it', () => {
    expect(deliveryState(job('completed'), 'deferred')).toBe('pending');
    expect(deliveryState(job('completed'), 'enqueued')).toBe('pending');
    expect(deliveryState(job('completed'), null)).toBe('pending');
    expect(deliveryState(job('completed'), 'consumed')).toBe('delivered');
  });

  test('a failed message or dead job is failed', () => {
    expect(deliveryState(job('completed'), 'failed')).toBe('failed');
    expect(deliveryState(job('dead'), null)).toBe('failed');
  });
});

describe('default caller scope', () => {
  test('a session with no scope provider is a plain session', () => {
    expect(resolveCallerIdentity(PLAIN_SESSION_SCOPE, 's1')).toEqual({
      sessionId: 's1',
      role: 'universal_read',
    });
  });
});
