import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store.ts';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence.ts';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import {
  normalizeGitHubDeployment,
  normalizeGitHubDeploymentStatus,
  normalizeGitHubPollingRow,
  normalizeGitHubWebhook,
  toExternalEvent,
  type GitHubPollingRepo,
} from '../../../../src/lib/external-events/github/github-normalizer.ts';

// ============================================================================
// External-event essence contract tests
//
// Locks the lean "essence" boundary that several tasks (#686, #688, #689, #690,
// #733) established for GitHub external events. The contract has three legs,
// each covered below by feeding realistic GitHub webhook/polling fixtures
// through the full pipeline (normalize → toExternalEvent → injected essence):
//
//   1. Review-comment and thread events carry the FULL body text plus reply and
//      resolve handles.
//   2. Raw source payloads are EXCLUDED from the injected essence.
//   3. Raw payloads remain retrievable on demand through get_external_event
//      (the same store read path the tool uses).
// ============================================================================

const SPACE_ID = 'space-essence-contract';
const WATCHED: GitHubPollingRepo = { owner: 'acme', repo: 'widgets' };

// A sentinel that GitHub embeds deep in webhook payloads (a repository archive
// URL template). It must reach rawPayload/storage but never the injected
// essence — its absence from the essence proves raw payload projection stops at
// the documented handle fields.
const RAW_SENTINEL = 'archive_format{/ref}';

// A body longer than the 240-char summary truncation limit, so "full body"
// assertions are meaningful (the summary would be ellipsed; the body must not).
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

// ---------------------------------------------------------------------------
// GitHub webhook / polling fixtures (realistic REST + webhook shapes).
// ---------------------------------------------------------------------------

function reviewCommentWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'created',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
      url: 'https://api.github.com/repos/acme/widgets',
      // Real GitHub payloads carry URL templates like this deep in the tree.
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

function reviewCommentReplyWebhook(): unknown {
  // A reply within a review thread carries `in_reply_to_id` pointing at the
  // root comment. The reply REST endpoint requires the ROOT id, so the
  // replyHandle.commentId must resolve to 4242 (root), not 5000 (the reply).
  return reviewCommentWebhook({
    comment: {
      id: 5000,
      in_reply_to_id: 4242,
      node_id: 'PRRC_kwDOA_reply',
      pull_request_review_id: 99,
      body: 'Good catch — fixing now.',
      path: 'packages/daemon/src/lib/external-events/delivery.ts',
      line: 87,
      side: 'RIGHT',
      html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5000',
      user: { login: 'alice', type: 'User' },
      created_at: '2026-07-22T00:01:00Z',
      updated_at: '2026-07-22T00:01:00Z',
    },
  });
}

function issueCommentWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'created',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
      archive_url: `https://api.github.com/repos/acme/widgets/{${RAW_SENTINEL}}`,
    },
    sender: { login: 'reviewer', type: 'User' },
    issue: { number: 42, title: 'Fix delivery flush', pull_request: { url: 'pr-api' } },
    comment: {
      id: 101,
      node_id: 'IC_kwDOA_issuecomment',
      body: 'Approving — the rate-budget orphan is gone after the requeue guard.',
      html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-101',
      user: { login: 'reviewer', type: 'User' },
      created_at: '2026-07-22T00:02:00Z',
      updated_at: '2026-07-22T00:02:00Z',
    },
    ...overrides,
  };
}

function reviewThreadWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'resolved',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
      archive_url: `https://api.github.com/repos/acme/widgets/{${RAW_SENTINEL}}`,
    },
    sender: { login: 'reviewer', type: 'User' },
    pull_request: {
      number: 42,
      node_id: 'PR_kwDOA_root',
      html_url: 'https://github.com/acme/widgets/pull/42',
      head: { sha: 'abc123deadbeef', ref: 'feature/fix' },
      user: { login: 'alice', type: 'User' },
      // Resolution bumps the PR's updated_at; it is the latest timestamp here.
      updated_at: '2026-07-22T00:10:00Z',
    },
    // The thread node id is the `PullRequestReviewThread.id` resolveReviewThread
    // needs — present on this webhook (unlike review-comment webhooks).
    thread: {
      node_id: 'PRRT_kwDOA_thread',
      comments: [
        {
          id: 4242,
          node_id: 'PRRC_kwDOA_rootcomment',
          pull_request_review_id: 99,
          body: LONG_REVIEW_BODY,
          path: 'packages/daemon/src/lib/external-events/delivery.ts',
          line: 87,
          side: 'RIGHT',
          start_line: 84,
          start_side: 'RIGHT',
          original_line: 87,
          original_side: 'RIGHT',
          original_start_line: 84,
          commit_id: 'abc123deadbeef',
          html_url: 'https://github.com/acme/widgets/pull/42#discussion_r4242',
          user: { login: 'reviewer', type: 'User' },
          created_at: '2026-07-22T00:00:00Z',
          updated_at: '2026-07-22T00:05:00Z',
        },
      ],
    },
    ...overrides,
  };
}

function checkSuiteWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'completed',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
      archive_url: `https://api.github.com/repos/acme/widgets/{${RAW_SENTINEL}}`,
    },
    sender: { login: 'github-actions[bot]', type: 'Bot' },
    check_suite: {
      id: 424242,
      node_id: 'CS_kwDOA_suite',
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'abc123deadbeef',
      app: { name: 'GitHub Actions', slug: 'github-actions' },
      created_at: '2026-07-22T00:00:00Z',
      updated_at: '2026-07-22T00:05:00Z',
      url: 'https://api.github.com/repos/acme/widgets/check-suites/424242',
      pull_requests: [{ number: 42, url: 'https://api.github.com/repos/acme/widgets/pulls/42' }],
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

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Mirror of SpaceRuntime.externalEventPayloadFromRecord (the inject input). */
function publishedPayloadFromEvent(event: ExternalEvent): ExternalEventPublishedPayload {
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

/** Normalize a webhook fixture and project it to an ExternalEvent. */
function webhookToEvent(
  eventType: string,
  payload: unknown,
  deliveryId = 'delivery-1'
): ExternalEvent {
  const normalized = normalizeGitHubWebhook(eventType, deliveryId, payload);
  if (!normalized) throw new Error(`webhook did not normalize: ${eventType}`);
  return toExternalEvent(SPACE_ID, normalized);
}

/** Run an ExternalEvent through the injected-essence formatter. */
function essenceOf(event: ExternalEvent): Record<string, unknown> {
  return JSON.parse(formatExternalEventEssence(publishedPayloadFromEvent(event))) as Record<
    string,
    unknown
  >;
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

// ============================================================================
// Contract leg 1 — full body + reply/resolve handles
// ============================================================================

describe('external_event essence contract — body + handles', () => {
  it('review-comment webhook carries the full body and a replyHandle keyed to the root comment id', () => {
    const event = webhookToEvent('pull_request_review_comment', reviewCommentWebhook());

    // Full body (the summary would be truncated at 240 chars; the body is not).
    expect(event.payload.body).toBe(LONG_REVIEW_BODY);
    // Reply handle resolves to the REST comment id the reply endpoint needs.
    expect(event.payload.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
    expect(event.payload.commentId).toBe('4242');
    expect(event.payload.commentNodeId).toBe('PRRC_kwDOA_reviewcomment');

    const essence = essenceOf(event);
    expect(essence.body).toBe(LONG_REVIEW_BODY);
    expect(essence.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
    // Documented inline-comment fields are projected.
    expect(essence).toMatchObject({
      path: 'packages/daemon/src/lib/external-events/delivery.ts',
      line: 87,
      side: 'RIGHT',
      startLine: 84,
      startSide: 'RIGHT',
      originalLine: 87,
      originalSide: 'RIGHT',
      pullRequestReviewId: 99,
    });
  });

  it('a review-comment REPLY resolves replyHandle.commentId to the ROOT id, not the reply id', () => {
    const event = webhookToEvent('pull_request_review_comment', reviewCommentReplyWebhook());

    // 4242 (root via in_reply_to_id), NOT 5000 (the reply's own id).
    expect(event.payload.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
    // External identity still keys on the actual delivered comment (5000).
    expect(event.payload.externalId).toBe('review_comment:5000:created');

    const essence = essenceOf(event);
    expect(essence.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
    expect(essence.body).toBe('Good catch — fixing now.');
  });

  it('issue-comment webhook carries the full body and an issue_comment replyHandle', () => {
    const event = webhookToEvent('issue_comment', issueCommentWebhook());

    expect(event.payload.body).toBe(
      'Approving — the rate-budget orphan is gone after the requeue guard.'
    );
    expect(event.payload.replyHandle).toEqual({ kind: 'issue_comment', commentId: '101' });

    const essence = essenceOf(event);
    expect(essence.body).toBe(event.payload.body);
    expect(essence.replyHandle).toEqual({ kind: 'issue_comment', commentId: '101' });
  });

  it('deployment_status webhook projects state/environment/targetUrl and excludes rawPayload', () => {
    // deployment_status payloads carry no pull_requests array; the PR is resolved
    // out-of-band, so the normalizer is driven directly with prNumber (mirroring
    // the polling-row leg above).
    const normalized = normalizeGitHubDeploymentStatus({
      repo: WATCHED,
      deploymentStatus: {
        id: 654,
        state: 'failure',
        description: 'deploy failed',
        target_url: 'https://example.com/deploy/654',
        log_url: 'https://example.com/deploy/654/logs',
        environment: 'production',
        created_at: '2026-08-02T00:00:00Z',
        creator: { login: 'ci-bot', type: 'Bot' },
      },
      // `deployment` is a top-level sibling of `deployment_status` in the real
      // payload — passed in explicitly (mirrors how the handler resolves it).
      deployment: {
        id: 321,
        ref: 'feat/deploy',
        sha: 'abc123deadbeef',
        environment: 'production',
        creator: { login: 'ci-bot', type: 'Bot' },
      },
      source: 'webhook',
      deliveryId: 'delivery-deploy',
      rawPayload: { action: 'created', repository: { archive_url: `x{${RAW_SENTINEL}}` } },
      sender: { login: 'ci-bot', type: 'Bot' },
      prNumber: 42,
    })!;
    const event = toExternalEvent(SPACE_ID, normalized);
    const essence = essenceOf(event);

    expect(event.topic).toBe('github/acme/widgets/pull_request/42.deployment_status_failure');
    // The status state is carried as the action and projected as `state`.
    expect(essence).toMatchObject({
      eventType: 'deployment_status',
      action: 'failure',
      state: 'failure',
      environment: 'production',
      targetUrl: 'https://example.com/deploy/654',
      logUrl: 'https://example.com/deploy/654/logs',
      ref: 'feat/deploy',
      sha: 'abc123deadbeef',
      deploymentId: 321,
    });
    // Raw payload (and its sentinel) never reaches the lean essence.
    expect(essence.rawPayload).toBeUndefined();
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
  });

  it('deployment webhook projects environment/ref/sha/task and excludes rawPayload', () => {
    const normalized = normalizeGitHubDeployment({
      repo: WATCHED,
      deployment: {
        id: 321,
        ref: 'feat/deploy',
        sha: 'abc123deadbeef',
        environment: 'production',
        task: 'deploy',
        description: 'ship it',
        creator: { login: 'ci-bot', type: 'Bot' },
        created_at: '2026-08-02T00:00:00Z',
      },
      source: 'webhook',
      deliveryId: 'delivery-deploy',
      rawPayload: { action: 'created', repository: { archive_url: `x{${RAW_SENTINEL}}` } },
      sender: { login: 'ci-bot', type: 'Bot' },
      prNumber: 42,
    })!;
    const event = toExternalEvent(SPACE_ID, normalized);
    const essence = essenceOf(event);

    expect(event.topic).toBe('github/acme/widgets/pull_request/42.deployment_created');
    expect(essence).toMatchObject({
      eventType: 'deployment',
      action: 'created',
      deploymentId: 321,
      environment: 'production',
      ref: 'feat/deploy',
      sha: 'abc123deadbeef',
      task: 'deploy',
      description: 'ship it',
    });
    // Raw payload (and its sentinel) never reaches the lean essence.
    expect(essence.rawPayload).toBeUndefined();
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
  });

  it('check-suite webhook projects conclusion/headSha/app to the essence and drops the raw payload', () => {
    const event = webhookToEvent('check_suite', checkSuiteWebhook());

    expect(event.topic).toBe('github/acme/widgets/pull_request/42.suite_failed');
    expect(event.payload.conclusion).toBe('failure');
    expect(event.payload.app).toBe('GitHub Actions');
    // A suite has no browsable html_url, so the actionable link is the PR.
    expect(event.externalUrl).toBe('https://github.com/acme/widgets/pull/42');

    const essence = essenceOf(event);
    expect(essence.eventType).toBe('check_suite');
    expect(essence).toMatchObject({
      conclusion: 'failure',
      headSha: 'abc123deadbeef',
      app: 'GitHub Actions',
    });
    // The raw payload (and the deep sentinel) never reach the injected essence.
    expect(essence.rawPayload).toBeUndefined();
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
  });

  it('review-comment POLLING row carries the body and replyHandle (polling parity)', () => {
    const normalized = normalizeGitHubPollingRow(
      WATCHED,
      reviewCommentPollingRow(),
      'review_comments'
    );
    expect(normalized).not.toBeNull();
    const event = toExternalEvent(SPACE_ID, normalized!);

    expect(event.payload.body).toBe('Polled inline nit on line 87.');
    expect(event.payload.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });

    const essence = essenceOf(event);
    expect(essence.body).toBe('Polled inline nit on line 87.');
    expect(essence.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
  });

  it('thread resolve handles pass through the essence when a consumer resolves the thread node id', () => {
    // The normalizer intentionally does NOT capture the review-THREAD node id
    // (GitHub omits it from webhook/REST payloads; it must be queried via the
    // `reviewThreads` GraphQL connection at runtime — see github-normalizer.ts).
    // The essence contract is therefore a passthrough: when a consumer adds
    // `resolveHandle` / `resolveThreadId` to the payload, they reach the agent.
    const event = webhookToEvent(
      'pull_request_review_comment',
      reviewCommentWebhook(),
      'delivery-thread'
    );
    event.payload.resolveHandle = {
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwDOA_thread',
    };
    event.payload.resolveThreadId = 'PRRT_kwDOA_thread';

    const essence = essenceOf(event);
    expect(essence.resolveHandle).toEqual({
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwDOA_thread',
    });
    expect(essence.resolveThreadId).toBe('PRRT_kwDOA_thread');
    // The reply handle still accompanies the resolve handle.
    expect(essence.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
  });

  it('pull_request_review_thread webhook projects the thread node id and resolveHandle into the essence', () => {
    const event = webhookToEvent('pull_request_review_thread', reviewThreadWebhook());

    // Re-expressed topic + the thread node id captured directly from the payload.
    expect(event.topic).toBe('github/acme/widgets/pull_request/42.thread_resolved');
    expect(event.payload.threadId).toBe('PRRT_kwDOA_thread');
    expect(event.payload.resolveHandle).toEqual({
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwDOA_thread',
    });

    const essence = essenceOf(event);
    expect(essence.eventType).toBe('pull_request_review_thread');
    expect(essence.action).toBe('resolved');
    expect(essence.threadId).toBe('PRRT_kwDOA_thread');
    expect(essence.resolveHandle).toEqual({
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwDOA_thread',
    });
    // The thread's root comment body and full diff location reach the essence,
    // matching the pull_request_review_comment projection (incl. original_* so
    // outdated threads with line:null keep their last-valid location).
    expect(essence.body).toBe(LONG_REVIEW_BODY);
    expect(essence).toMatchObject({
      path: 'packages/daemon/src/lib/external-events/delivery.ts',
      line: 87,
      side: 'RIGHT',
      startLine: 84,
      startSide: 'RIGHT',
      originalLine: 87,
      originalSide: 'RIGHT',
      originalStartLine: 84,
    });
    // Raw payload (incl. the deep sentinel) never leaks into the injected essence.
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
  });
});

// ============================================================================
// Contract leg 2 — raw payloads excluded from the injected essence
// ============================================================================

describe('external_event essence contract — raw payload excluded from context', () => {
  it('the essence never projects rawPayload, summary, or the nested payload object', () => {
    const event = webhookToEvent('pull_request_review_comment', reviewCommentWebhook());
    const serialized = formatExternalEventEssence(publishedPayloadFromEvent(event));
    const essence = JSON.parse(serialized) as Record<string, unknown>;

    expect(essence.rawPayload).toBeUndefined();
    expect(essence.summary).toBeUndefined();
    expect(essence.payload).toBeUndefined();
    // A deep sentinel from the raw payload must not leak into the injected text.
    expect(serialized).not.toContain(RAW_SENTINEL);
    // No commit sha / avatar noise from the raw payload either.
    expect(serialized).not.toContain('abc123deadbeef');
  });

  it('the raw payload is still carried verbatim on the ExternalEvent for later retrieval', () => {
    const fixture = reviewCommentWebhook();
    const event = webhookToEvent('pull_request_review_comment', fixture);

    expect(event.payload.rawPayload).toBe(fixture);
    // Spot-check deep raw fields the essence deliberately omits.
    const raw = event.payload.rawPayload as Record<string, unknown>;
    expect((raw.repository as Record<string, unknown>).archive_url).toContain(RAW_SENTINEL);
    expect((raw.comment as Record<string, unknown>).commit_id).toBe('abc123deadbeef');
  });

  it('issue-comment and review-comment events both exclude rawPayload from the essence', () => {
    const reviewComment = essenceOf(
      webhookToEvent('pull_request_review_comment', reviewCommentWebhook())
    );
    const issueComment = essenceOf(webhookToEvent('issue_comment', issueCommentWebhook()));

    for (const essence of [reviewComment, issueComment]) {
      expect(essence.rawPayload).toBeUndefined();
      expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
    }
  });
});

// ============================================================================
// Contract leg 3 — raw payloads retrievable through get_external_event
// ============================================================================

describe('external_event essence contract — raw payload retrievable on demand', () => {
  it('a normalized+stored event is fetchable with its rawPayload intact (get_external_event path)', () => {
    const db = makeStoreDb();
    try {
      const store = new ExternalEventStore(db);
      const fixture = reviewCommentWebhook();
      const event = webhookToEvent('pull_request_review_comment', fixture);
      const stored = store.store(event);
      expect(stored.duplicate).toBe(false);

      // get_external_event reads exactly this: store.getById(eventId).event.
      const record = store.getById(event.id);
      expect(record).not.toBeNull();
      const fetched = record!.event;
      expect(fetched.id).toBe(event.id);
      expect(fetched.payload.body).toBe(LONG_REVIEW_BODY);
      expect(fetched.payload.replyHandle).toEqual({
        kind: 'pull_request_review_comment',
        commentId: '4242',
      });
      // The complete raw payload survived the storage round-trip.
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
