import { describe, expect, it, test } from 'bun:test';
import {
  mapEventType,
  normalizeGitHubCheckRun,
  normalizeGitHubPollingRow,
  normalizeGitHubStatus,
  normalizeGitHubWebhook,
  toExternalEvent,
  type GitHubPollingRepo,
} from '../../../../src/lib/external-events/github/github-normalizer';

// ============================================================================
// Factory for GitHub `/repos/{owner}/{repo}/pulls` rows (dedupe-on-head-sha).
// ============================================================================

const watched: GitHubPollingRepo = { owner: 'Acme', repo: 'Widgets' };
const HEAD_SHA_INITIAL = 'aaa111bbb222ccc333';
const HEAD_SHA_PUSHED = 'ddd444eee555fff666';

function makePullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    number: 42,
    url: 'https://api.github.com/repos/Acme/Widgets/pulls/42',
    html_url: 'https://github.com/Acme/Widgets/pull/42',
    title: 'Add polling support',
    body: 'Adds polling support for GitHub PRs',
    user: { login: 'lsm', type: 'User' },
    head: { sha: HEAD_SHA_INITIAL, ref: 'feature/polling' },
    created_at: '2026-06-24T10:00:00Z',
    updated_at: '2026-06-24T14:24:20Z',
    ...overrides,
  };
}

// ============================================================================
// Webhook payloads for reply/resolve handle extraction.
// ============================================================================

function reviewCommentWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'created',
    repository: { id: 1, name: 'widgets', full_name: 'Acme/Widgets', owner: { login: 'Acme' } },
    sender: { login: 'dev', type: 'User' },
    pull_request: {
      number: 7,
      node_id: 'PR_kwAAA',
      html_url: 'https://github.com/acme/widgets/pull/7',
      user: { login: 'dev', type: 'User' },
      updated_at: '2026-01-01T00:00:00Z',
    },
    comment: {
      id: 4242,
      node_id: 'PRRC_kwAAA_reviewcomment',
      pull_request_review_id: 99,
      body: 'nit: rename this',
      html_url: 'https://github.com/acme/widgets/pull/7#discussion_r4242',
      user: { login: 'dev', type: 'User' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

function issueCommentWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'created',
    repository: { id: 1, name: 'widgets', full_name: 'Acme/Widgets', owner: { login: 'Acme' } },
    sender: { login: 'bot', type: 'Bot' },
    issue: { number: 7, title: 'PR', pull_request: { url: 'api' } },
    comment: {
      id: 101,
      node_id: 'IC_kwAAA_issuecomment',
      body: 'looks good',
      html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
      user: { login: 'bot', type: 'Bot' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

function reviewWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'submitted',
    repository: { id: 1, name: 'widgets', full_name: 'Acme/Widgets', owner: { login: 'Acme' } },
    sender: { login: 'dev', type: 'User' },
    pull_request: {
      number: 7,
      html_url: 'https://github.com/acme/widgets/pull/7',
      user: { login: 'dev', type: 'User' },
      updated_at: '2026-01-01T00:00:00Z',
    },
    review: {
      id: 555,
      node_id: 'PRR_kwAAA_review',
      body: 'looks good overall',
      state: 'approved',
      html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-555',
      user: { login: 'dev', type: 'User' },
      submitted_at: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

function pullRequestWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'synchronize',
    repository: { id: 1, name: 'widgets', full_name: 'Acme/Widgets', owner: { login: 'Acme' } },
    sender: { login: 'dev', type: 'User' },
    pull_request: {
      id: 77,
      number: 7,
      node_id: 'PR_kwAAA_pull',
      body: 'pr body',
      html_url: 'https://github.com/acme/widgets/pull/7',
      user: { login: 'dev', type: 'User' },
      updated_at: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

// `pull_request_review_thread` webhook (resolved/unresolved). Unlike review-
// comment events, this payload carries the review-THREAD node id directly at
// `thread.node_id` (the `PullRequestReviewThread.id` resolveReviewThread needs).
function reviewThreadWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'resolved',
    repository: { id: 1, name: 'widgets', full_name: 'Acme/Widgets', owner: { login: 'Acme' } },
    sender: { login: 'reviewer', type: 'User' },
    pull_request: {
      number: 7,
      node_id: 'PR_kwAAA_pull',
      html_url: 'https://github.com/acme/widgets/pull/7',
      user: { login: 'dev', type: 'User' },
      // Resolution bumps the PR's updated_at, so it is the latest timestamp and
      // the closest proxy for when the thread was actually resolved.
      updated_at: '2026-01-01T00:10:00Z',
    },
    thread: {
      node_id: 'PRRT_kwAAA_thread',
      comments: [
        {
          id: 4242,
          node_id: 'PRRC_kwAAA_rootcomment',
          pull_request_review_id: 99,
          body: 'nit: rename this',
          path: 'packages/daemon/src/file.ts',
          line: 12,
          side: 'RIGHT',
          start_line: 10,
          start_side: 'RIGHT',
          original_line: 12,
          original_side: 'RIGHT',
          original_start_line: 10,
          html_url: 'https://github.com/acme/widgets/pull/7#discussion_r4242',
          user: { login: 'reviewer', type: 'User' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:05:00Z',
        },
      ],
    },
    ...overrides,
  };
}

describe('normalizeGitHubPollingRow — renamed repo uses payload URL, not stale watched config', () => {
  const staleWatched: GitHubPollingRepo = { owner: 'lsm', repo: 'neokai' };

  function makeRenamedReviewCommentRow(): Record<string, unknown> {
    return {
      id: 12345,
      node_id: 'PRRC_kwAAA_renamed',
      pull_request_review_id: 99,
      body: 'nit on renamed repo',
      // The watched config is stale (neokai), but the API payload URL carries the
      // current canonical repo name (HyperNeo).
      url: 'https://api.github.com/repos/lsm/HyperNeo/pulls/comments/12345',
      html_url: 'https://github.com/lsm/HyperNeo/pull/2236#discussion_r12345',
      user: { login: 'reviewer', type: 'User' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
  }

  function makeRenamedIssueCommentRow(): Record<string, unknown> {
    return {
      id: 67890,
      node_id: 'IC_kwAAA_renamed',
      body: 'general comment on renamed repo',
      url: 'https://api.github.com/repos/lsm/HyperNeo/issues/comments/67890',
      html_url: 'https://github.com/lsm/HyperNeo/issues/2236#issuecomment-67890',
      issue_url: 'https://api.github.com/repos/lsm/HyperNeo/issues/2236',
      issue: { number: 2236, pull_request: { url: 'api' } },
      user: { login: 'reviewer', type: 'User' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
  }

  function makeRenamedPullRow(): Record<string, unknown> {
    return {
      id: 10001,
      number: 2236,
      node_id: 'PR_kwAAA_renamed',
      url: 'https://api.github.com/repos/lsm/HyperNeo/pulls/2236',
      html_url: 'https://github.com/lsm/HyperNeo/pull/2236',
      title: 'Renamed repo PR',
      body: 'PR body on renamed repo',
      user: { login: 'author', type: 'User' },
      head: { sha: 'abc123def456', ref: 'feature/renamed' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
  }

  it('review_comment row derives owner/repo from payload API URL and emits new-name topic', () => {
    const normalized = normalizeGitHubPollingRow(
      staleWatched,
      makeRenamedReviewCommentRow(),
      'review_comments'
    )!;
    expect(normalized).not.toBeNull();
    expect(normalized.repoOwner).toBe('lsm');
    expect(normalized.repoName).toBe('HyperNeo');
    expect(normalized.prNumber).toBe(2236);
    expect(normalized.prUrl).toBe('https://github.com/lsm/HyperNeo/pull/2236');

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/lsm/hyperneo/pull_request/2236.review_comment_polled');
  });

  it('issue_comment row derives owner/repo from payload API URL and emits new-name topic', () => {
    const normalized = normalizeGitHubPollingRow(
      staleWatched,
      makeRenamedIssueCommentRow(),
      'issue_comments'
    )!;
    expect(normalized).not.toBeNull();
    expect(normalized.repoOwner).toBe('lsm');
    expect(normalized.repoName).toBe('HyperNeo');
    expect(normalized.prNumber).toBe(2236);
    expect(normalized.prUrl).toBe('https://github.com/lsm/HyperNeo/pull/2236');

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/lsm/hyperneo/pull_request/2236.comment_polled');
  });

  it('pulls row derives owner/repo from payload API URL and emits new-name topic', () => {
    const normalized = normalizeGitHubPollingRow(staleWatched, makeRenamedPullRow(), 'pulls')!;
    expect(normalized).not.toBeNull();
    expect(normalized.repoOwner).toBe('lsm');
    expect(normalized.repoName).toBe('HyperNeo');
    expect(normalized.prNumber).toBe(2236);
    expect(normalized.prUrl).toBe('https://github.com/lsm/HyperNeo/pull/2236');

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/lsm/hyperneo/pull_request/2236.polled');
  });

  it('falls back to html_url when api url is missing but html_url has the new name', () => {
    const row = {
      id: 112,
      node_id: 'PRRC_kwAAA_htmlfallback',
      body: 'api url missing',
      html_url: 'https://github.com/lsm/HyperNeo/pull/2236#discussion_r112',
      user: { login: 'reviewer', type: 'User' },
      updated_at: '2026-01-01T00:00:00Z',
    };
    const normalized = normalizeGitHubPollingRow(staleWatched, row, 'review_comments')!;
    expect(normalized.repoOwner).toBe('lsm');
    expect(normalized.repoName).toBe('HyperNeo');

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/lsm/hyperneo/pull_request/2236.review_comment_polled');
  });

  it('falls back to watched repo when payload URL is missing or unparseable', () => {
    const row = {
      id: 111,
      number: 2236,
      node_id: 'PRRC_kwAAA_fallback',
      body: 'missing url',
      url: 'https://example.com/not-a-github-url',
      html_url: 'also-not-a-github-url',
      user: { login: 'reviewer', type: 'User' },
      updated_at: '2026-01-01T00:00:00Z',
    };
    const normalized = normalizeGitHubPollingRow(staleWatched, row, 'review_comments')!;
    expect(normalized.repoOwner).toBe('lsm');
    expect(normalized.repoName).toBe('neokai');

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/lsm/neokai/pull_request/2236.review_comment_polled');
  });
});

describe('normalizeGitHubPollingRow — pulls dedupe key', () => {
  it('keys the dedupe suffix on the head sha, not the volatile updated_at', () => {
    const event = normalizeGitHubPollingRow(watched, makePullRow(), 'pulls')!;
    expect(event).not.toBeNull();
    // eventType for the pulls endpoint is `pull_request`; owner/repo lowercased.
    expect(event.dedupeKey).toBe(`acme/widgets:pull_request:1001:${HEAD_SHA_INITIAL}`);
    expect(event.deliveryId).toBe(`poll:pull_request:1001:${HEAD_SHA_INITIAL}`);
    expect(event.externalId).toBe(`pull_request:1001:${HEAD_SHA_INITIAL}`);
  });

  it('keeps the same dedupeKey when only updated_at advanced (e.g. a comment/check)', () => {
    const first = normalizeGitHubPollingRow(watched, makePullRow(), 'pulls');
    // A comment or check_run bumped updated_at but did NOT push a new commit.
    const second = normalizeGitHubPollingRow(
      watched,
      makePullRow({ updated_at: '2026-06-24T15:10:00Z' }),
      'pulls'
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Same dedupe key → the store collapses both rows, no duplicate delivery.
    expect(second!.dedupeKey).toBe(first!.dedupeKey);
    expect(second!.deliveryId).toBe(first!.deliveryId);
    expect(second!.externalId).toBe(first!.externalId);
    // occurredAt still reflects the (advanced) updated_at.
    expect(second!.occurredAt).toBeGreaterThan(first!.occurredAt);
  });

  it('changes the dedupeKey when the head sha changes (a real push)', () => {
    const first = normalizeGitHubPollingRow(watched, makePullRow(), 'pulls');
    const second = normalizeGitHubPollingRow(
      watched,
      makePullRow({ head: { sha: HEAD_SHA_PUSHED, ref: 'feature/polling' } }),
      'pulls'
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.dedupeKey).not.toBe(first!.dedupeKey);
    expect(second!.dedupeKey).toBe(`acme/widgets:pull_request:1001:${HEAD_SHA_PUSHED}`);
  });

  it('falls back to updatedAt when head.sha is missing (deleted-head PR)', () => {
    const row = makePullRow({ head: {} });
    const first = normalizeGitHubPollingRow(watched, row, 'pulls');
    // Within a single cycle the identical row dedupes against itself.
    const secondSame = normalizeGitHubPollingRow(watched, row, 'pulls');

    expect(first).not.toBeNull();
    expect(secondSame!.dedupeKey).toBe(first!.dedupeKey);
    // When updated_at advances, the fallback key advances (no stale head to pin).
    const advanced = normalizeGitHubPollingRow(
      watched,
      makePullRow({ head: {}, updated_at: '2026-06-24T15:10:00Z' }),
      'pulls'
    );
    expect(advanced!.dedupeKey).not.toBe(first!.dedupeKey);
  });
});

describe('NormalizedGitHubEvent reply/resolve handles', () => {
  describe('normalizeGitHubWebhook', () => {
    test('review comment yields REST comment id + comment node_id', () => {
      const normalized = normalizeGitHubWebhook(
        'pull_request_review_comment',
        'delivery-1',
        reviewCommentWebhook()
      )!;
      // REST numeric id (the handle .../comments/{comment_id}/replies needs):
      expect(normalized.commentId).toBe('4242');
      // GraphQL node id of the COMMENT (≠ its thread node id):
      expect(normalized.nodeId).toBe('PRRC_kwAAA_reviewcomment');
    });

    test('review comment that is a reply yields the ROOT comment id, not the reply id', () => {
      // GitHub's reply endpoint requires a top-level comment id; a reply carries
      // the root id in `in_reply_to_id` (review threads are flat). See
      // https://docs.github.com/rest/pulls/comments.
      const normalized = normalizeGitHubWebhook(
        'pull_request_review_comment',
        'delivery-1',
        reviewCommentWebhook({
          comment: {
            id: 5000,
            in_reply_to_id: 4242,
            node_id: 'PRRC_kwAAA_reply',
            body: 'reply within thread',
            html_url: 'https://github.com/acme/widgets/pull/7#discussion_r5000',
            user: { login: 'dev', type: 'User' },
            created_at: '2026-01-01T00:00:00Z',
          },
        })
      )!;
      // commentId must be the ROOT id (4242), not the reply's own id (5000).
      expect(normalized.commentId).toBe('4242');
      // nodeId still references the triggering (reply) comment, by design.
      expect(normalized.nodeId).toBe('PRRC_kwAAA_reply');
      // external identity must stay keyed by the actual delivered comment id.
      expect(normalized.externalId).toBe('review_comment:5000:created');
      expect(normalized.dedupeKey).toBe('acme/widgets:review_comment:5000:created');
    });

    test('issue comment yields REST comment id + comment node_id', () => {
      const normalized = normalizeGitHubWebhook(
        'issue_comment',
        'delivery-1',
        issueCommentWebhook()
      )!;
      expect(normalized.commentId).toBe('101');
      expect(normalized.nodeId).toBe('IC_kwAAA_issuecomment');
    });

    test('review yields no comment id but the review node_id', () => {
      const normalized = normalizeGitHubWebhook(
        'pull_request_review',
        'delivery-1',
        reviewWebhook()
      )!;
      expect(normalized.commentId).toBe('');
      expect(normalized.nodeId).toBe('PRR_kwAAA_review');
    });

    test('pull_request yields no comment id but the PR node_id', () => {
      const normalized = normalizeGitHubWebhook(
        'pull_request',
        'delivery-1',
        pullRequestWebhook()
      )!;
      expect(normalized.commentId).toBe('');
      expect(normalized.nodeId).toBe('PR_kwAAA_pull');
    });

    test('missing comment ids default to empty string and normalization still succeeds', () => {
      const normalized = normalizeGitHubWebhook(
        'pull_request_review_comment',
        'delivery-1',
        reviewCommentWebhook({
          comment: {
            body: 'no ids here',
            html_url: 'https://github.com/acme/widgets/pull/7#discussion_r1',
            user: { login: 'dev', type: 'User' },
            created_at: '2026-01-01T00:00:00Z',
          },
        })
      )!;
      expect(normalized.commentId).toBe('');
      expect(normalized.nodeId).toBe('');
      // externalId still falls back to the delivery id when no REST id is present
      expect(normalized.externalId).toBe('review_comment:delivery-1:created');
    });

    test('issue comment missing node_id still normalizes', () => {
      const normalized = normalizeGitHubWebhook(
        'issue_comment',
        'delivery-2',
        issueCommentWebhook({ comment: { id: 202, body: 'no node id' } })
      )!;
      expect(normalized.commentId).toBe('202');
      expect(normalized.nodeId).toBe('');
    });
  });

  describe('normalizeGitHubPollingRow', () => {
    test('review_comment endpoint row yields REST comment id + node_id', () => {
      const row = {
        id: 4242,
        node_id: 'PRRC_kwAAA_poll',
        pull_request_review_id: 99,
        body: 'inline nit',
        html_url: 'https://github.com/acme/widgets/pull/7#discussion_r4242',
        user: { login: 'dev', type: 'User' },
        updated_at: '2026-01-01T00:00:00Z',
      };
      const normalized = normalizeGitHubPollingRow(watched, row, 'review_comments')!;
      expect(normalized.eventType).toBe('pull_request_review_comment');
      expect(normalized.commentId).toBe('4242');
      expect(normalized.nodeId).toBe('PRRC_kwAAA_poll');
    });

    test('review_comment endpoint row that is a reply yields the ROOT comment id', () => {
      const row = {
        id: 5000,
        in_reply_to_id: 4242,
        node_id: 'PRRC_kwAAA_pollreply',
        body: 'reply within thread',
        html_url: 'https://github.com/acme/widgets/pull/7#discussion_r5000',
        user: { login: 'dev', type: 'User' },
        updated_at: '2026-01-01T00:00:00Z',
      };
      const normalized = normalizeGitHubPollingRow(watched, row, 'review_comments')!;
      expect(normalized.commentId).toBe('4242');
      expect(normalized.nodeId).toBe('PRRC_kwAAA_pollreply');
    });

    test('issue_comments endpoint row yields REST comment id + node_id', () => {
      const row = {
        id: 101,
        node_id: 'IC_kwAAA_poll',
        body: 'general comment',
        html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
        issue_url: 'https://api.github.com/repos/acme/widgets/issues/7',
        issue: { number: 7, pull_request: { url: 'api' } },
        user: { login: 'bot', type: 'Bot' },
        updated_at: '2026-01-01T00:00:00Z',
      };
      const normalized = normalizeGitHubPollingRow(watched, row, 'issue_comments')!;
      expect(normalized.eventType).toBe('issue_comment');
      expect(normalized.commentId).toBe('101');
      expect(normalized.nodeId).toBe('IC_kwAAA_poll');
    });

    test('pulls endpoint row yields PR node_id but no comment id', () => {
      const row = {
        id: 77,
        number: 7,
        node_id: 'PR_kwAAA_poll',
        body: 'pr body',
        html_url: 'https://github.com/acme/widgets/pull/7',
        user: { login: 'dev', type: 'User' },
        updated_at: '2026-01-01T00:00:00Z',
      };
      const normalized = normalizeGitHubPollingRow(watched, row, 'pulls')!;
      expect(normalized.eventType).toBe('pull_request');
      expect(normalized.commentId).toBe('');
      expect(normalized.nodeId).toBe('PR_kwAAA_poll');
    });

    test('pulls endpoint row derives merged status from merged_at', () => {
      const merged = normalizeGitHubPollingRow(
        watched,
        {
          ...makePullRow({ state: 'closed', merged_at: '2026-06-26T00:00:00Z' }),
          node_id: 'PR_kwAAA_merged',
        },
        'pulls'
      )!;
      expect(merged.payload).toMatchObject({
        state: 'closed',
        merged: true,
        mergedAt: '2026-06-26T00:00:00Z',
      });

      const closed = normalizeGitHubPollingRow(
        watched,
        {
          ...makePullRow({ state: 'closed', merged_at: null }),
          node_id: 'PR_kwAAA_closed',
        },
        'pulls'
      )!;
      expect(closed.payload).toMatchObject({ state: 'closed', merged: false });
      expect(closed.payload?.mergedAt).toBeUndefined();
    });

    test('missing node_id on polling rows still normalizes', () => {
      const row = {
        id: 4242,
        body: 'inline nit',
        html_url: 'https://github.com/acme/widgets/pull/7#discussion_r4242',
        user: { login: 'dev', type: 'User' },
        updated_at: '2026-01-01T00:00:00Z',
      };
      const normalized = normalizeGitHubPollingRow(watched, row, 'review_comments')!;
      expect(normalized.commentId).toBe('4242');
      expect(normalized.nodeId).toBe('');
    });
  });

  describe('normalizeGitHubCheckRun', () => {
    test('check_run events carry no reply/resolve handles', () => {
      const webhookEvent = normalizeGitHubCheckRun({
        repo: watched,
        checkRun: {
          id: 987,
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/acme/widgets/runs/987',
          completed_at: '2026-01-01T00:00:00Z',
          pull_requests: [{ number: 7 }],
        },
        source: 'webhook',
        deliveryId: 'delivery-1',
        rawPayload: { action: 'completed' },
        sender: { login: 'github-actions[bot]', type: 'Bot' },
      })!;
      expect(webhookEvent.commentId).toBe('');
      expect(webhookEvent.nodeId).toBe('');

      const pollingEvent = normalizeGitHubCheckRun({
        repo: watched,
        checkRun: {
          id: 7001,
          name: 'unit tests',
          status: 'completed',
          conclusion: 'failure',
          head_sha: 'abc123',
          html_url: 'https://github.com/acme/widgets/actions/runs/1/job/7001',
          completed_at: '2099-01-03T00:00:00Z',
          pull_requests: [{ number: 7 }],
          app: { login: 'github-actions', type: 'Bot' },
        },
        source: 'polling',
        deliveryId: 'poll:check_run:7001',
        rawPayload: {},
      })!;
      expect(pollingEvent.commentId).toBe('');
      expect(pollingEvent.nodeId).toBe('');
    });
  });

  describe('toExternalEvent propagation', () => {
    test('handles flow into the ExternalEvent payload for the formatter', () => {
      const normalized = normalizeGitHubWebhook(
        'pull_request_review_comment',
        'delivery-1',
        reviewCommentWebhook()
      )!;
      const event = toExternalEvent('space-1', normalized);
      expect(event.payload.commentId).toBe('4242');
      expect(event.payload.nodeId).toBe('PRRC_kwAAA_reviewcomment');
    });

    test('empty handles are also present on the payload', () => {
      const normalized = normalizeGitHubCheckRun({
        repo: watched,
        checkRun: {
          id: 987,
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/acme/widgets/runs/987',
          completed_at: '2026-01-01T00:00:00Z',
          pull_requests: [{ number: 7 }],
        },
        source: 'webhook',
        deliveryId: 'delivery-1',
        rawPayload: { action: 'completed' },
        sender: { login: 'github-actions[bot]', type: 'Bot' },
      })!;
      const event = toExternalEvent('space-1', normalized);
      expect(event.payload.commentId).toBe('');
      expect(event.payload.nodeId).toBe('');
    });

    describe('essence payload fields', () => {
      test('preserves review comment body and documented inline fields', () => {
        const payload = reviewCommentWebhook({
          comment: {
            id: 123,
            node_id: 'PRRC_kwDOExample',
            body: 'Line one\n\nLine two with details',
            html_url: 'https://github.com/acme/widgets/pull/7#discussion_r123',
            path: 'packages/daemon/src/file.ts',
            line: 12,
            side: 'RIGHT',
            start_line: 10,
            start_side: 'RIGHT',
            original_line: 12,
            original_side: 'RIGHT',
            in_reply_to_id: 99,
            pull_request_review_id: 456,
            user: { login: 'codex', type: 'Bot' },
            created_at: '2026-06-26T00:00:00Z',
          },
        });
        const normalized = normalizeGitHubWebhook(
          'pull_request_review_comment',
          'delivery-1',
          payload
        )!;

        expect(normalized.body).toBe('Line one\n\nLine two with details');
        expect(normalized.payload).toMatchObject({
          title: 'PR #7 inline review comment',
          commentId: '99',
          commentNodeId: 'PRRC_kwDOExample',
          replyHandle: { kind: 'pull_request_review_comment', commentId: '99' },
          path: 'packages/daemon/src/file.ts',
          line: 12,
          side: 'RIGHT',
          startLine: 10,
          startSide: 'RIGHT',
          originalLine: 12,
          originalSide: 'RIGHT',
          inReplyToId: 99,
          pullRequestReviewId: 456,
        });

        const event = toExternalEvent('space-1', normalized);
        expect(event.payload.body).toBe(normalized.body);
        expect(event.payload.rawPayload).toBe(payload);
      });
    });
  });
});

// ============================================================================
// normalizeGitHubStatus — commit-status (external/legacy CI) webhook.
// ============================================================================

const STATUS_REPO: GitHubPollingRepo = { owner: 'Acme', repo: 'Widgets' };

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 555,
    sha: 'abc123def456',
    name: 'continuous-integration/jenkins',
    context: 'continuous-integration/jenkins',
    state: 'failure',
    description: 'Build failed in stage "test"',
    target_url: 'https://jenkins.example.com/job/widgets/42',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
    sender: { login: 'jenkins-bot', type: 'Bot' },
    ...overrides,
  };
}

describe('normalizeGitHubStatus', () => {
  test('re-expresses a failure as pull_request/<id>.status_failure', () => {
    const normalized = normalizeGitHubStatus({
      repo: STATUS_REPO,
      status: statusPayload(),
      prNumber: 7,
      source: 'webhook',
      deliveryId: 'delivery-1',
      rawPayload: statusPayload(),
    })!;
    expect(normalized).not.toBeNull();
    expect(normalized.eventType).toBe('status');
    expect(normalized.action).toBe('failure');
    expect(normalized.prNumber).toBe(7);

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/pull_request/7.status_failure');
    expect(event.payload).toMatchObject({
      state: 'failure',
      context: 'continuous-integration/jenkins',
      description: 'Build failed in stage "test"',
      targetUrl: 'https://jenkins.example.com/job/widgets/42',
      sha: 'abc123def456',
      statusId: 555,
    });
    // externalUrl falls back to the target_url when present.
    expect(event.externalUrl).toBe('https://jenkins.example.com/job/widgets/42');
  });

  test.each([
    'pending',
    'success',
    'failure',
    'error',
  ] as const)('surfaces every commit-status state (%s) — including pending', (state) => {
    const normalized = normalizeGitHubStatus({
      repo: STATUS_REPO,
      status: statusPayload({ state }),
      prNumber: 7,
      source: 'webhook',
      deliveryId: 'delivery-1',
      rawPayload: statusPayload({ state }),
    })!;
    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe(`github/acme/widgets/pull_request/7.status_${state}`);
  });

  test('scopes the dedupe/external identity by PR (one SHA → many PRs)', () => {
    const base = {
      repo: STATUS_REPO,
      status: statusPayload(),
      source: 'webhook' as const,
      deliveryId: 'delivery-1',
      rawPayload: statusPayload(),
    };
    const forPr7 = normalizeGitHubStatus({ ...base, prNumber: 7 })!;
    const forPr9 = normalizeGitHubStatus({ ...base, prNumber: 9 })!;
    // Same commit status, different PRs → distinct keys (no cross-PR collapse).
    expect(forPr7.dedupeKey).not.toBe(forPr9.dedupeKey);
    expect(forPr7.dedupeKey).toBe('acme/widgets:status:555:failure:7');
    expect(forPr9.dedupeKey).toBe('acme/widgets:status:555:failure:9');
    // Re-delivering the same status for the same PR dedupes.
    expect(normalizeGitHubStatus({ ...base, prNumber: 7 })!.dedupeKey).toBe(forPr7.dedupeKey);
  });

  test('id-absent fallback includes context so distinct CIs do not collide', () => {
    const base = (ci: string) => ({
      repo: STATUS_REPO,
      status: statusPayload({ id: undefined, name: ci, context: ci }),
      source: 'webhook' as const,
      deliveryId: 'delivery-1',
      rawPayload: {},
      prNumber: 7,
    });
    const jenkins = normalizeGitHubStatus(base('ci/jenkins'))!;
    const travis = normalizeGitHubStatus(base('ci/travis'))!;
    // Same SHA + state + PR, different CI context → distinct keys (no collision).
    expect(jenkins.dedupeKey).not.toBe(travis.dedupeKey);
    expect(jenkins.dedupeKey).toBe('acme/widgets:status:abc123def456:ci/jenkins:failure:7');
  });

  test('falls back to the commit.sha when the top-level sha is absent', () => {
    const normalized = normalizeGitHubStatus({
      repo: STATUS_REPO,
      status: statusPayload({ sha: undefined, commit: { sha: 'abc123def456' } }),
      prNumber: 7,
      source: 'webhook',
      deliveryId: 'delivery-1',
      rawPayload: {},
    })!;
    expect(normalized.payload).toMatchObject({ sha: 'abc123def456' });
  });

  test('returns null when the state or PR number is missing', () => {
    expect(
      normalizeGitHubStatus({
        repo: STATUS_REPO,
        status: statusPayload({ state: '' }),
        prNumber: 7,
        source: 'webhook',
        deliveryId: 'delivery-1',
        rawPayload: {},
      })
    ).toBeNull();
    expect(
      normalizeGitHubStatus({
        repo: STATUS_REPO,
        status: statusPayload(),
        prNumber: 0,
        source: 'webhook',
        deliveryId: 'delivery-1',
        rawPayload: {},
      })
    ).toBeNull();
  });

  test('uses the context alias when name is absent', () => {
    const normalized = normalizeGitHubStatus({
      repo: STATUS_REPO,
      status: statusPayload({ name: undefined, context: 'custom-ci' }),
      prNumber: 7,
      source: 'webhook',
      deliveryId: 'delivery-1',
      rawPayload: {},
    })!;
    expect(normalized.payload).toMatchObject({ context: 'custom-ci' });
    expect(normalized.summary).toContain('(custom-ci)');
  });
});

describe('mapEventType — status', () => {
  test('maps status to status_<state>', () => {
    expect(mapEventType('status', 'failure', '7')).toEqual({
      resource: 'pull_request',
      entityId: '7',
      action: 'status_failure',
    });
    expect(mapEventType('status', 'pending', '7').action).toBe('status_pending');
  });
});

describe('normalizeGitHubWebhook — pull_request_review_thread', () => {
  test('resolved action re-expresses as .thread_resolved and captures the thread node id', () => {
    const normalized = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-1',
      reviewThreadWebhook()
    )!;
    expect(normalized).not.toBeNull();
    // The thread node id (the primary entity) is captured directly from the payload.
    expect(normalized.nodeId).toBe('PRRT_kwAAA_thread');
    // The root comment REST id powers the reply endpoint.
    expect(normalized.commentId).toBe('4242');
    expect(normalized.prNumber).toBe(7);
    expect(normalized.actor).toBe('reviewer');
    expect(normalized.body).toBe('nit: rename this');
    // occurredAt tracks the PR's updated_at (resolution time), NOT the root
    // comment's updated_at (last text edit) — which is older here (00:05 < 00:10).
    expect(normalized.occurredAt).toBe(Date.parse('2026-01-01T00:10:00Z'));
    expect(normalized.payload).toMatchObject({
      title: 'PR #7 review thread resolved',
      threadId: 'PRRT_kwAAA_thread',
      resolveHandle: { kind: 'pull_request_review_thread', threadId: 'PRRT_kwAAA_thread' },
      replyHandle: { kind: 'pull_request_review_comment', commentId: '4242' },
      // Full diff location is projected, matching the review-comment branch.
      path: 'packages/daemon/src/file.ts',
      line: 12,
      side: 'RIGHT',
      startLine: 10,
      startSide: 'RIGHT',
      originalLine: 12,
      originalSide: 'RIGHT',
      originalStartLine: 10,
    });

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/pull_request/7.thread_resolved');
    expect(event.payload.resolveHandle).toEqual({
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwAAA_thread',
    });
  });

  test('unresolved action re-expresses as .thread_unresolved', () => {
    const normalized = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-2',
      reviewThreadWebhook({ action: 'unresolved' })
    )!;
    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/pull_request/7.thread_unresolved');
    // resolveHandle still identifies the thread regardless of transition direction.
    expect(event.payload.resolveHandle).toEqual({
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwAAA_thread',
    });
  });

  test('distinct resolution transitions of the same thread do not dedupe', () => {
    // A thread can be resolved, un-resolved, then resolved again. Each transition
    // is a separate GitHub delivery, so the two `resolved` events must keep
    // distinct dedupe keys (keyed by delivery id, like `pull_request` actions).
    const first = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-resolve-1',
      reviewThreadWebhook()
    )!;
    const second = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-resolve-2',
      reviewThreadWebhook()
    )!;
    expect(second.dedupeKey).not.toBe(first.dedupeKey);
    // Redelivering the same delivery id collapses to one event.
    const redelivery = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-resolve-1',
      reviewThreadWebhook()
    )!;
    expect(redelivery.dedupeKey).toBe(first.dedupeKey);
  });

  test('missing thread.node_id still normalizes and omits resolveHandle', () => {
    const normalized = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-3',
      reviewThreadWebhook({ thread: { comments: [] } })
    )!;
    expect(normalized).not.toBeNull();
    expect(normalized.nodeId).toBe('');
    expect(normalized.commentId).toBe('');
    const event = toExternalEvent('space-1', normalized);
    // No thread id → no resolveHandle, but the event still publishes.
    expect(event.payload.resolveHandle).toBeUndefined();
    expect(event.topic).toBe('github/acme/widgets/pull_request/7.thread_resolved');
  });

  test('outdated thread (line null) preserves the original diff location', () => {
    // When a thread refers to a line that has since changed/disappeared, GitHub
    // returns `line`/`side` as null but retains the last-valid location in
    // `original_line`/`original_side`. The event must keep that context so the
    // conversation-resolution rule can still locate the thread.
    const normalized = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-outdated',
      reviewThreadWebhook({
        thread: {
          node_id: 'PRRT_kwAAA_thread',
          comments: [
            {
              id: 4242,
              node_id: 'PRRC_kwAAA_rootcomment',
              body: 'nit: rename this',
              path: 'packages/daemon/src/file.ts',
              line: null,
              side: null,
              start_line: null,
              start_side: null,
              original_line: 12,
              original_side: 'RIGHT',
              original_start_line: 10,
              html_url: 'https://github.com/acme/widgets/pull/7#discussion_r4242',
              user: { login: 'reviewer', type: 'User' },
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:05:00Z',
            },
          ],
        },
      })
    )!;
    expect(normalized.payload).toMatchObject({
      path: 'packages/daemon/src/file.ts',
      line: undefined,
      side: '',
      startLine: undefined,
      startSide: '',
      originalLine: 12,
      originalSide: 'RIGHT',
      originalStartLine: 10,
    });
  });

  test('occurredAt falls back to the root comment timestamp when the PR object is thin', () => {
    // A minimal webhook (no pr.updated_at) must still source a sensible time from
    // the root comment rather than defaulting to the receive time.
    const normalized = normalizeGitHubWebhook(
      'pull_request_review_thread',
      'delivery-4',
      reviewThreadWebhook({
        pull_request: { number: 7, html_url: 'https://github.com/acme/widgets/pull/7' },
      })
    )!;
    expect(normalized.occurredAt).toBe(Date.parse('2026-01-01T00:05:00Z'));
  });
});
