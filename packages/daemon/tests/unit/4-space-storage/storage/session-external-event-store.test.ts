import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type ExternalEventPublishedPayload,
  type ExternalEventPublisher,
  ExternalEventService,
  routeExternalEventPublisher,
} from '../../../../src/lib/external-events/external-event-service';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../../../../src/lib/external-events/session-external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { runMigration331 } from '../../../../src/storage/schema/m331-session-external-events';
import { Database } from '../../../../src/storage/sqlite-compat';

let store: SessionExternalEventStore;

function event(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: crypto.randomUUID(),
    spaceId: SESSION_EVENT_SCOPE,
    source: 'github',
    topic: 'github/acme/widgets/pull_request/7.review_submitted',
    occurredAt: 1_700_000_000_000,
    ingestedAt: 1_700_000_001_000,
    dedupeKey: 'acme/widgets:review:1',
    summary: 'Review submitted',
    externalUrl: 'https://github.com/acme/widgets/pull/7',
    payload: { state: 'CHANGES_REQUESTED' },
    ...overrides,
  };
}

beforeEach(() => {
  const db = new Database(':memory:');
  runMigration331(db);
  store = new SessionExternalEventStore(db);
});

describe('SessionExternalEventStore', () => {
  test('stores an event without a Space and reads it back under the sessions scope', () => {
    const first = event({ urgency: 'immediate', render: 'block' });
    expect(store.store(first)).toEqual({ event: first, duplicate: false, terminal: false });
    expect(store.getById(first.id)).toMatchObject({ event: first, state: 'published' });
    expect(store.getById('missing')).toBeNull();
  });

  test('a repeat of the same source and dedupe key returns the stored event as a terminal duplicate', () => {
    const first = event();
    store.store(first);
    const again = store.store(event({ id: crypto.randomUUID(), summary: 'changed' }));
    expect(again).toMatchObject({ duplicate: true, terminal: true, event: { id: first.id } });
  });
});

describe('session-scoped publishing', () => {
  test('publishes a new event once and drops a repeat', async () => {
    const bus = createInternalEventBus<{
      'externalEvent.published': ExternalEventPublishedPayload;
    }>();
    const seen: ExternalEventPublishedPayload[] = [];
    bus.subscribe('externalEvent.published', (payload) => void seen.push(payload), {
      subscriberName: 'test',
    });
    const service = new ExternalEventService(store, bus);
    expect(await service.publish(event())).toMatchObject({ outcome: 'published' });
    expect(await service.publish(event({ id: crypto.randomUUID() }))).toMatchObject({
      outcome: 'duplicate_terminal',
    });
    expect(seen.map((payload) => payload.spaceId)).toEqual([SESSION_EVENT_SCOPE]);
  });

  test('the router sends only sessions-scoped events to the session publisher', async () => {
    const routed: string[] = [];
    const publisher = (name: string): ExternalEventPublisher => ({
      publish: async (published) => {
        routed.push(`${name}:${published.spaceId}`);
        return { outcome: 'published', eventId: published.id };
      },
    });
    const router = routeExternalEventPublisher(publisher('spaces'), publisher('sessions'));
    await router.publish(event({ spaceId: 'space-1' }));
    await router.publish(event());
    expect(routed).toEqual(['spaces:space-1', `sessions:${SESSION_EVENT_SCOPE}`]);
  });
});
