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

function reviewCommentReplyWebhook(): unknown {
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
      updated_at: '2026-07-22T00:10:00Z',
    },
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

function mergeGroupWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'checks_requested',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
      archive_url: `https://api.github.com/repos/acme/widgets/{${RAW_SENTINEL}}`,
    },
    sender: { login: 'github-merge-queue[bot]', type: 'Bot' },
    merge_group: {
      base_ref: 'refs/heads/main',
      base_sha: 'def456789012345678901234567890abcdef12',
      head_commit: {
        id: 'abc123def456789012345678901234567890abcd',
        message: 'Merge pull request #123 from acme/feature-branch',
        timestamp: '2026-07-22T00:00:00Z',
        tree_id: 'tree123abc456def789012345678901234567890',
      },
      head_ref: 'refs/heads/gh-readonly-queue/main/pr-123-abc123def456',
      head_sha: 'abc123def456789012345678901234567890abcd',
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

function webhookToEvent(
  eventType: string,
  payload: unknown,
  deliveryId = 'delivery-1'
): ExternalEvent {
  const normalized = normalizeGitHubWebhook(eventType, deliveryId, payload);
  if (!normalized) throw new Error(`webhook did not normalize: ${eventType}`);
  return toExternalEvent(SPACE_ID, normalized);
}

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

function branchProtectionRuleWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'created',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
      archive_url: `https://api.github.com/repos/acme/widgets/{${RAW_SENTINEL}}`,
    },
    sender: { login: 'admin', type: 'User' },
    rule: {
      id: 4242,
      name: 'main',
      admin_enforced: true,
      required_status_checks_enforcement_level: 'non_admins',
      required_status_checks: ['ci/lint', 'ci/test'],
      pull_request_reviews_enforcement_level: 'everyone',
      required_approving_review_count: 2,
      require_code_owner_review: true,
      required_conversation_resolution_level: 'everyone',
      linear_history_requirement_enforcement_level: 'non_admins',
      strict_required_status_checks_policy: true,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
    },
    ...overrides,
  };
}

describe('external_event essence contract — body + handles', () => {
  it('review-comment webhook carries the full body and a replyHandle keyed to the root comment id', () => {
    const event = webhookToEvent('pull_request_review_comment', reviewCommentWebhook());

    expect(event.payload.body).toBe(LONG_REVIEW_BODY);
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

    expect(event.payload.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
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
    const normalized = normalizeGitHubDeploymentStatus({
      repo: WATCHED,
      deploymentStatus: {
        id: 654,
        state: 'failure',
        description: 'deploy failed',
        target_url: 'https://example.com/deploy/654',
        log_url: 'https://example.com/deploy/654/logs',
        environment_url: 'https://app.example.com/prod',
        environment: 'production',
        created_at: '2026-08-02T00:00:00Z',
        creator: { login: 'ci-bot', type: 'Bot' },
      },
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
    expect(essence).toMatchObject({
      eventType: 'deployment_status',
      action: 'failure',
      state: 'failure',
      environment: 'production',
      targetUrl: 'https://example.com/deploy/654',
      environmentUrl: 'https://app.example.com/prod',
      logUrl: 'https://example.com/deploy/654/logs',
      ref: 'feat/deploy',
      sha: 'abc123deadbeef',
      deploymentId: 321,
    });
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
    expect(essence.rawPayload).toBeUndefined();
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
  });

  it('check-suite webhook projects conclusion/headSha/app to the essence and drops the raw payload', () => {
    const event = webhookToEvent('check_suite', checkSuiteWebhook());

    expect(event.topic).toBe('github/acme/widgets/pull_request/42.suite_failed');
    expect(event.payload.conclusion).toBe('failure');
    expect(event.payload.app).toBe('GitHub Actions');
    expect(event.externalUrl).toBe('https://github.com/acme/widgets/pull/42');

    const essence = essenceOf(event);
    expect(essence.eventType).toBe('check_suite');
    expect(essence).toMatchObject({
      conclusion: 'failure',
      headSha: 'abc123deadbeef',
      app: 'GitHub Actions',
    });
    expect(essence.rawPayload).toBeUndefined();
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
  });

  it('merge_group webhook projects the merge-queue refs/headSha to the essence and drops the raw payload', () => {
    const event = webhookToEvent('merge_group', mergeGroupWebhook());

    expect(event.topic).toBe('github/acme/widgets/pull_request/123.merge_group_checks_requested');
    expect(event.payload.headSha).toBe('abc123def456789012345678901234567890abcd');

    const essence = essenceOf(event);
    expect(essence.eventType).toBe('merge_group');
    expect(essence).toMatchObject({
      headSha: 'abc123def456789012345678901234567890abcd',
      headRef: 'refs/heads/gh-readonly-queue/main/pr-123-abc123def456',
      baseRef: 'refs/heads/main',
      baseSha: 'def456789012345678901234567890abcdef12',
      headCommitId: 'abc123def456789012345678901234567890abcd',
    });
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
    expect(essence.replyHandle).toEqual({
      kind: 'pull_request_review_comment',
      commentId: '4242',
    });
  });

  it('pull_request_review_thread webhook projects the thread node id and resolveHandle into the essence', () => {
    const event = webhookToEvent('pull_request_review_thread', reviewThreadWebhook());

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
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
  });
});

describe('external_event essence contract — raw payload excluded from context', () => {
  it('the essence never projects rawPayload, summary, or the nested payload object', () => {
    const event = webhookToEvent('pull_request_review_comment', reviewCommentWebhook());
    const serialized = formatExternalEventEssence(publishedPayloadFromEvent(event));
    const essence = JSON.parse(serialized) as Record<string, unknown>;

    expect(essence.rawPayload).toBeUndefined();
    expect(essence.summary).toBeUndefined();
    expect(essence.payload).toBeUndefined();
    expect(serialized).not.toContain(RAW_SENTINEL);
    expect(serialized).not.toContain('abc123deadbeef');
  });

  it('the raw payload is still carried verbatim on the ExternalEvent for later retrieval', () => {
    const fixture = reviewCommentWebhook();
    const event = webhookToEvent('pull_request_review_comment', fixture);

    expect(event.payload.rawPayload).toBe(fixture);
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

describe('external_event essence contract — repo-scoped branch_protection_rule', () => {
  it('projects merge-gating fields + repo url, omits prNumber, and excludes rawPayload', () => {
    const fixture = branchProtectionRuleWebhook();
    const event = webhookToEvent('branch_protection_rule', fixture);

    const essence = essenceOf(event);
    expect(essence.prNumber).toBeUndefined();
    expect(essence.prUrl).toBe('https://github.com/acme/widgets');
    expect(essence.topic).toBe('github/acme/widgets/repo/main.branch_protection_created');
    expect(essence).toMatchObject({
      eventType: 'branch_protection_rule',
      action: 'created',
      ruleId: '4242',
      ruleName: 'main',
      adminEnforced: true,
      requiredStatusChecks: ['ci/lint', 'ci/test'],
      requiredApprovingReviewCount: 2,
      requireCodeOwnerReview: true,
    });
    expect(essence.rawPayload).toBeUndefined();
    expect(JSON.stringify(essence)).not.toContain(RAW_SENTINEL);
    expect(event.payload.rawPayload).toBe(fixture);
  });

  it('edited projects changedFields and uses the branch_protection_edited action', () => {
    const event = webhookToEvent(
      'branch_protection_rule',
      branchProtectionRuleWebhook({
        action: 'edited',
        changes: { required_approving_review_count: { from: 1 } },
      })
    );
    expect(event.topic).toBe('github/acme/widgets/repo/main.branch_protection_edited');
    const essence = essenceOf(event);
    expect(essence.changedFields).toEqual(['required_approving_review_count']);
    expect(essence.body).toBe('required_approving_review_count');
  });
});
