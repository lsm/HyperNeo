import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import {
  normalizeGitHubPollingRow,
  normalizeGitHubWebhook,
  toExternalEvent,
  type GitHubPollingRepo,
} from '../../../../src/lib/external-events/github/github-normalizer.ts';

const SPACE_ID = 'space-essence-contract';
const WATCHED: GitHubPollingRepo = { owner: 'acme', repo: 'widgets' };

const RAW_SENTINEL = 'archive_format{/ref}';

const LONG_REVIEW_BODY = [
  'Please address this before merging.',
  '',
  'The retry loop in `flushDeliveries` requeues on any thrown error, but the',
  'terminal-failure branch already persisted `failed`. Re-entering it double-',
  'counts the delivery against the rate budget and leaves an orphaned row.',
  '',
  'Prefer checking `TERMINAL_DELIVERY_STATES` before requeue so transient and',
  'terminal paths stay disjoint. See the linked trace for the reproduction.',
].join('\n');

function reviewCommentWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'created',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
      url: 'https://api.github.com/repos/acme/widgets',
      archive_url: `https://api.github.com/repos/acme/widgets/{${RAW_SENTINEL}}`,
    },
    sender: { login: 'codex', type: 'Bot' },
    pull_request: {
      number: 42,
      node_id: 'PR_kwDOA_root',
      html_url: 'https://github.com/acme/widgets/pull/42',
      head: { sha: 'abc123deadbeef', ref: 'feature/fix' },
      user: { login: 'alice', type: 'User' },
      updated_at: '2026-07-22T00:00:00Z',
    },
    comment: {
      id: 4242,
      node_id: 'PRRC_kwDOA_reviewcomment',
      pull_request_review_id: 99,
      body: LONG_REVIEW_BODY,
      path: 'packages/daemon/src/lib/external-events/delivery.ts',
      line: 87,
      side: 'RIGHT',
      start_line: 84,
      start_side: 'RIGHT',
      original_line: 87,
      original_side: 'RIGHT',
      commit_id: 'abc123deadbeef',
      html_url: 'https://github.com/acme/widgets/pull/42#discussion_r4242',
      user: { login: 'codex', type: 'Bot' },
      created_at: '2026-07-22T00:00:00Z',
      updated_at: '2026-07-22T00:00:00Z',
    },
    ...overrides,
  };
}

function reviewCommentPollingRow(): Record<string, unknown> {
  return {
    id: 4242,
    node_id: 'PRRC_kwDOA_poll',
    pull_request_review_id: 99,
    body: 'Polled inline nit on line 87.',
    path: 'packages/daemon/src/lib/external-events/delivery.ts',
    line: 87,
    side: 'RIGHT',
    url: 'https://api.github.com/repos/acme/widgets/pulls/comments/4242',
    html_url: 'https://github.com/acme/widgets/pull/42#discussion_r4242',
    user: { login: 'codex', type: 'Bot' },
    created_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:00:00Z',
  };
}

function webhookToEvent(
  eventType: string,
  payload: unknown,
  deliveryId = 'delivery-1'
): ExternalEvent {
  const normalized = normalizeGitHubWebhook(eventType, deliveryId, payload);
  if (!normalized) throw new Error(`webhook did not normalize: ${eventType}`);
  return toExternalEvent(SPACE_ID, normalized);
}

function makeStoreDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, SPACE_ID, SPACE_ID, now, now);
  return db;
}

describe('external_event essence contract — raw payload carried on the ExternalEvent', () => {
  it('the raw payload is still carried verbatim on the ExternalEvent for later retrieval', () => {
    const fixture = reviewCommentWebhook();
    const event = webhookToEvent('pull_request_review_comment', fixture);

    expect(event.payload.rawPayload).toBe(fixture);
    const raw = event.payload.rawPayload as Record<string, unknown>;
    expect((raw.repository as Record<string, unknown>).archive_url).toContain(RAW_SENTINEL);
    expect((raw.comment as Record<string, unknown>).commit_id).toBe('abc123deadbeef');
  });
});

describe('external_event essence contract — raw payload retrievable on demand', () => {
  it('a normalized+stored event is fetchable with its rawPayload intact (get_external_event path)', () => {
    const db = makeStoreDb();
    try {
      const store = new ExternalEventStore(db);
      const fixture = reviewCommentWebhook();
      const event = webhookToEvent('pull_request_review_comment', fixture);
      const stored = store.store(event);
      expect(stored.duplicate).toBe(false);

      const record = store.getById(event.id);
      expect(record).not.toBeNull();
      const fetched = record!.event;
      expect(fetched.id).toBe(event.id);
      expect(fetched.payload.body).toBe(LONG_REVIEW_BODY);
      expect(fetched.payload.replyHandle).toEqual({
        kind: 'pull_request_review_comment',
        commentId: '4242',
      });
      expect(fetched.payload.rawPayload).toEqual(fixture);
      expect((fetched.payload.rawPayload as Record<string, unknown>).repository).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('a polling-row event round-trips rawPayload through storage too', () => {
    const db = makeStoreDb();
    try {
      const store = new ExternalEventStore(db);
      const row = reviewCommentPollingRow();
      const normalized = normalizeGitHubPollingRow(WATCHED, row, 'review_comments')!;
      const event = toExternalEvent(SPACE_ID, normalized);
      store.store(event);

      const fetched = store.getById(event.id)!.event;
      expect(fetched.payload.rawPayload).toEqual(row);
      expect(fetched.payload.body).toBe('Polled inline nit on line 87.');
    } finally {
      db.close();
    }
  });
});
