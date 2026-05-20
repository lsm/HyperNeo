/**
 * ExternalEventService Unit Tests
 *
 * Covers:
 *   - publish: new event → stored, bus published
 *   - publish: terminal duplicate → short-circuits
 *   - publish: retryable duplicate → returns retryable_duplicate, re-emits bus
 *   - bus payload carries space-scoped sessionId
 *   - no session injection in service
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
	type ExternalEventPublishedPayload,
	ExternalEventService,
} from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import {
	createInternalEventBus,
	type InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let store: ExternalEventStore;
let bus: InternalEventBus<{
	'externalEvent.published': ExternalEventPublishedPayload;
}>;
let service: ExternalEventService;

const SPACE_ID = 'sp-evt-svc';

function freshDb(): Database {
	const d = new Database(':memory:');
	createSpaceTables(d);
	const now = Date.now();
	d.exec(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/test', 'Test Space', ${now}, ${now})`
	);
	return d;
}

function makeEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2, 8)}`,
		spaceId: SPACE_ID,
		source: 'github',
		topic: 'github/lsm/neokai/pull_request/42.review_submitted',
		occurredAt: 1_700_000_000_000,
		ingestedAt: 1_700_000_001_000,
		dedupeKey: `dk-${Math.random().toString(36).slice(2, 8)}`,
		summary: 'PR review submitted',
		payload: { action: 'review_submitted', prNumber: 42, repoOwner: 'lsm', repoName: 'neokai' },
		...overrides,
	};
}

beforeEach(() => {
	db = freshDb();
	store = new ExternalEventStore(db);
	bus = createInternalEventBus<{
		'externalEvent.published': ExternalEventPublishedPayload;
	}>();
	service = new ExternalEventService(store, bus);
});

// ---------------------------------------------------------------------------
// New event
// ---------------------------------------------------------------------------

describe('publish — new event', () => {
	test('stores event, publishes bus event, returns published', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'test-sub' }
		);

		const event = makeEvent({ externalUrl: 'https://github.com/lsm/neokai/pull/42' });
		const result = await service.publish(event);

		expect(result.outcome).toBe('published');
		expect(result.eventId).toBe(event.id);

		// Bus fired with full event payload
		expect(busReceived).toHaveLength(1);
		expect(busReceived[0]!.spaceId).toBe(SPACE_ID);
		expect(busReceived[0]!.namespaceId).toBe(SPACE_ID);
		expect(busReceived[0]!.eventId).toBe(event.id);
		expect(busReceived[0]!.source).toBe('github');
		expect(busReceived[0]!.topic).toBe(event.topic);
		expect(busReceived[0]!.dedupeKey).toBe(event.dedupeKey);
		expect(busReceived[0]!.summary).toBe(event.summary);
		expect(busReceived[0]!.externalUrl).toBe('https://github.com/lsm/neokai/pull/42');
		expect(busReceived[0]!.payload).toEqual(event.payload);
		expect(busReceived[0]!.occurredAt).toBe(event.occurredAt);
		expect(busReceived[0]!.ingestedAt).toBe(event.ingestedAt);

		// Stored state is published
		const rec = store.getById(event.id);
		expect(rec!.state).toBe('published');
	});

	test('source-specific metadata lives in payload', async () => {
		const event = makeEvent({
			payload: { prNumber: 99, repoOwner: 'acme', repoName: 'widget', branch: 'feature-99' },
		});
		const result = await service.publish(event);

		expect(result.outcome).toBe('published');
		const rec = store.getById(event.id);
		expect(rec!.event.payload.prNumber).toBe(99);
		expect(rec!.event.payload.repoOwner).toBe('acme');
		expect(rec!.event.payload.repoName).toBe('widget');
		expect(rec!.event.payload.branch).toBe('feature-99');
	});

	test('first observation publishes canonical JSON-normalized payload', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'test-sub' }
		);

		// Event with non-JSON-normalized values (undefined field) that would be
		// dropped during JSON.stringify/parse round-tripping.
		const event = makeEvent({
			payload: { action: 'opened', prNumber: 42, extra: undefined },
		});
		const result = await service.publish(event);

		expect(result.outcome).toBe('published');
		expect(busReceived).toHaveLength(1);
		// The bus payload should be the canonical stored version (no `extra` key).
		expect(busReceived[0]!.payload).toEqual({ action: 'opened', prNumber: 42 });
		expect('extra' in busReceived[0]!.payload).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

describe('publish — duplicates', () => {
	test('terminal duplicate returns duplicate_terminal', async () => {
		const event = makeEvent();
		store.store(event);
		store.markEventIgnored(event.id, 'no_matching_subscriptions');

		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('duplicate_terminal');
		expect(result.eventId).toBe(event.id);
	});

	test('retryable duplicate returns retryable_duplicate and re-emits bus', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'sub' }
		);

		const event = makeEvent();
		const firstResult = await service.publish(event);
		expect(firstResult.outcome).toBe('published');
		expect(busReceived).toHaveLength(1);

		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('retryable_duplicate');
		expect(result.eventId).toBe(event.id);
		expect(busReceived).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Bus semantics
// ---------------------------------------------------------------------------

describe('publish — bus semantics', () => {
	test('bus event is space-scoped (namespaceId === spaceId)', async () => {
		const received: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				received.push(data);
			},
			{ subscriberName: 'scoped-sub', namespaceId: SPACE_ID }
		);

		const event = makeEvent();
		await service.publish(event);

		expect(received).toHaveLength(1);
		expect(received[0]!.namespaceId).toBe(SPACE_ID);
	});

	test('global subscriber also receives space-scoped event', async () => {
		const globalReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				globalReceived.push(data);
			},
			{ subscriberName: 'global-sub' }
		);

		const event = makeEvent();
		await service.publish(event);

		expect(globalReceived).toHaveLength(1);
	});

	test('bus is not fired for terminal duplicates', async () => {
		const received: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				received.push(data);
			},
			{ subscriberName: 'sub' }
		);

		const event = makeEvent();
		await service.publish(event);
		expect(received).toHaveLength(1);

		// Mark terminal, then duplicate should NOT fire bus
		store.markEventIgnored(event.id, 'no_matching_subscriptions');
		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);
		expect(result.outcome).toBe('duplicate_terminal');
		expect(received).toHaveLength(1); // no second bus event
	});
});
