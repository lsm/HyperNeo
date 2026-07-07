import { describe, expect, it, test } from 'bun:test';
import {
  normalizeGitHubCheckRun,
  normalizeGitHubPollingRow,
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

  it('falls back to watched repo when payload URL is missing or malformed', () => {
    const row = {
      id: 111,
      node_id: 'PRRC_kwAAA_fallback',
      body: 'missing url',
      html_url: 'https://github.com/lsm/neokai/pull/2236#discussion_r111',
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
