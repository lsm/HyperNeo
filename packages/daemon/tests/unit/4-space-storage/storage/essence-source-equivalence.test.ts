import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  deferredExternalEventEntryEvents,
  type ExternalEventEssenceEntry,
  parseDeferredExternalEventText,
} from '../../../../src/lib/external-events/deferred-event-digest.ts';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence.ts';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service.ts';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store.ts';
import {
  normalizeGitHubPollingRow,
  normalizeGitHubReaction,
  normalizeGitHubWebhook,
  toExternalEvent,
} from '../../../../src/lib/external-events/github/github-normalizer.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

const SPACE_ID = 'space-essence-equivalence';
const REPOSITORY = { name: 'widgets', owner: { login: 'acme' }, full_name: 'acme/widgets' };
const WATCHED = { owner: 'acme', repo: 'widgets' };

function webhookEvent(
  eventType: string,
  deliveryId: string,
  payload: Record<string, unknown>
): ExternalEvent {
  const normalized = normalizeGitHubWebhook(eventType, deliveryId, {
    repository: REPOSITORY,
    ...payload,
  });
  if (!normalized) throw new Error(`fixture did not normalize: ${eventType}`);
  return toExternalEvent(SPACE_ID, normalized);
}

function checkRunEvent(): ExternalEvent {
  return webhookEvent('check_run', 'delivery-check', {
    action: 'completed',
    sender: { login: 'github-actions[bot]', type: 'Bot' },
    check_run: {
      id: 9001,
      name: 'build-linux',
      status: 'completed',
      conclusion: 'failure',
      completed_at: '2026-08-20T09:15:00Z',
      pull_requests: [{ number: 42 }],
    },
  });
}

function reviewCommentEvent(): ExternalEvent {
  return webhookEvent('pull_request_review_comment', 'delivery-review', {
    action: 'created',
    sender: { login: 'codex', type: 'Bot' },
    pull_request: { number: 42 },
    comment: {
      id: 4242,
      pull_request_review_id: 99,
      body: 'The retry loop double-counts terminal failures.',
      path: 'packages/daemon/src/lib/external-events/delivery.ts',
      line: 87,
      side: 'RIGHT',
      user: { login: 'codex', type: 'Bot' },
      updated_at: '2026-08-20T09:20:00Z',
    },
  });
}

function issueCommentEvent(): ExternalEvent {
  return webhookEvent('issue_comment', 'delivery-pr-comment', {
    action: 'created',
    sender: { login: 'reviewer', type: 'User' },
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/repos/acme/widgets/issues/42' },
    },
    comment: {
      id: 101,
      body: 'Approving — the requeue guard holds.',
      user: { login: 'reviewer', type: 'User' },
      updated_at: '2026-08-20T09:35:00Z',
    },
  });
}

function polledPullRequestEvent(): ExternalEvent {
  const normalized = normalizeGitHubPollingRow(
    WATCHED,
    {
      id: 42,
      number: 42,
      url: 'https://api.github.com/repos/acme/widgets/pulls/42',
      html_url: 'https://github.com/acme/widgets/pull/42',
      state: 'open',
      title: 'Fix delivery flush',
      merged: false,
      draft: false,
      merged_at: '',
      updated_at: '2026-08-20T09:25:00Z',
      user: { login: 'alice', type: 'User' },
      head: { sha: 'abc123deadbeef' },
    },
    'pulls'
  );
  if (!normalized) throw new Error('pulls polling row did not normalize');
  return toExternalEvent(SPACE_ID, normalized);
}

function reactionEvent(): ExternalEvent {
  const normalized = normalizeGitHubReaction(WATCHED, 42, {
    id: 777,
    content: '👍',
    user: { login: 'alice', type: 'User' },
    created_at: '2026-08-20T09:30:00Z',
  });
  if (!normalized) throw new Error('reaction row did not normalize');
  return toExternalEvent(SPACE_ID, normalized);
}

function branchProtectionEvent(): ExternalEvent {
  return webhookEvent('branch_protection_rule', 'delivery-rule', {
    action: 'created',
    sender: { login: 'admin', type: 'User' },
    rule: {
      id: 4242,
      name: 'main',
      admin_enforced: true,
      required_status_checks: ['ci/lint', 'ci/test'],
      required_approving_review_count: 2,
      require_code_owner_review: true,
      required_conversation_resolution_level: 'everyone',
      strict_required_status_checks_policy: true,
      updated_at: '2026-08-20T09:40:00Z',
    },
  });
}

function rateLimitDigestText(events: ExternalEvent[]): string {
  const topics = [...new Set(events.map((event) => event.topic))].sort();
  const occurredAt = events.map((event) => event.occurredAt);
  return (
    `${events.length} events received for topics: ${topics.join(', ')} ` +
    `(oldest: ${new Date(Math.min(...occurredAt)).toISOString()}, ` +
    `newest: ${new Date(Math.max(...occurredAt)).toISOString()}). ` +
    `Event IDs: ${JSON.stringify(events.map((event) => ({ id: event.id, topic: event.topic })))}. ` +
    `Use get_external_event(eventId) for full details.`
  );
}

function publishedPayloadOf(event: ExternalEvent): ExternalEventPublishedPayload {
  return {
    namespaceId: event.spaceId,
    spaceId: event.spaceId,
    eventId: event.id,
    source: event.source,
    topic: event.topic,
    dedupeKey: event.dedupeKey,
    summary: event.summary,
    externalUrl: event.externalUrl,
    payload: event.payload,
    occurredAt: event.occurredAt,
    ingestedAt: event.ingestedAt,
  };
}

function essenceOfEventEntry(event: ExternalEvent): ExternalEventEssenceEntry {
  const parsed = parseDeferredExternalEventText(
    formatExternalEventEssence(publishedPayloadOf(event))
  );
  if (!parsed || parsed.kind !== 'event') {
    throw new Error(`event ${event.id} did not render and parse to a deferred event entry`);
  }
  return parsed.essence;
}

function storeRecordEvent(store: ExternalEventStore, event: ExternalEvent): ExternalEvent {
  const stored = store.store(event);
  if (stored.duplicate) throw new Error(`event ${event.id} stored as duplicate`);
  const record = store.getById(event.id);
  if (!record) throw new Error(`store lost event ${event.id}`);
  return record.event;
}

describe('essence source equivalence — store record vs parsed deferred row', () => {
  let db: Database;
  let store: ExternalEventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, '/tmp/test', 'Essence Equivalence', ?, ?)`
    ).run(SPACE_ID, SPACE_ID, now, now);
    store = new ExternalEventStore(db);
  });

  afterEach(() => {
    db.close();
  });

  const CASES: Array<{ kind: string; topic: string; event: ExternalEvent }> = [
    {
      kind: 'check',
      topic: 'github/acme/widgets/pull_request/42.check_failed',
      event: checkRunEvent(),
    },
    {
      kind: 'review',
      topic: 'github/acme/widgets/pull_request/42.review_comment_created',
      event: reviewCommentEvent(),
    },
    {
      kind: 'pr_comment',
      topic: 'github/acme/widgets/pull_request/42.comment_created',
      event: issueCommentEvent(),
    },
    {
      kind: 'state',
      topic: 'github/acme/widgets/pull_request/42.polled',
      event: polledPullRequestEvent(),
    },
    {
      kind: 'reaction',
      topic: 'github/acme/widgets/pull_request/42.reaction_added',
      event: reactionEvent(),
    },
    {
      kind: 'other',
      topic: 'github/acme/widgets/repo/main.branch_protection_created',
      event: branchProtectionEvent(),
    },
  ];

  it('essence from the store record equals parse-back of the injected delivery text', () => {
    for (const { kind, topic, event } of CASES) {
      expect(event.topic).toBe(topic);
      const fromText = essenceOfEventEntry(event);
      const fromRecord = essenceOfEventEntry(storeRecordEvent(store, event));
      expect([kind, fromRecord]).toEqual([kind, fromText]);
    }
  });

  it('rate-limit fold stubs stay consistent with the store records they reference', () => {
    const events = [checkRunEvent(), issueCommentEvent()];
    for (const event of events) storeRecordEvent(store, event);
    const parsed = parseDeferredExternalEventText(rateLimitDigestText(events));
    if (!parsed || parsed.kind !== 'fold') {
      throw new Error('rate-limit digest text did not parse to a fold');
    }
    const stubs = deferredExternalEventEntryEvents(parsed);
    expect(stubs.length).toBe(2);
    for (const stub of stubs) {
      const record = store.getById(stub.eventId);
      expect(record).not.toBeNull();
      const fromRecord = essenceOfEventEntry(record!.event);
      const carried: Record<string, unknown> = {};
      for (const field of Object.keys(stub)) {
        carried[field] = (fromRecord as Record<string, unknown>)[field];
      }
      expect(carried).toEqual(stub);
    }
  });

  it('a single-event rate-limit fold carries the store record occurredAt', () => {
    const event = reactionEvent();
    const record = storeRecordEvent(store, event);
    const parsed = parseDeferredExternalEventText(rateLimitDigestText([event]));
    if (!parsed || parsed.kind !== 'fold') {
      throw new Error('single-event rate-limit digest text did not parse to a fold');
    }
    const stub = deferredExternalEventEntryEvents(parsed)[0]!;
    expect(stub.occurredAt).toBe(essenceOfEventEntry(record).occurredAt);
  });
});
