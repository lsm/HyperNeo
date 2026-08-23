import { describe, expect, it, test } from 'bun:test';
import {
  mapEventType,
  normalizeGitHubCheckRun,
  normalizeGitHubCheckSuite,
  normalizeGitHubDeployment,
  normalizeGitHubDeploymentStatus,
  normalizeGitHubMergeConflict,
  normalizeGitHubPollingRow,
  normalizeGitHubReview,
  normalizeGitHubStatus,
  normalizeGitHubWebhook,
  toExternalEvent,
  type GitHubPollingRepo,
} from '../../../../src/lib/external-events/github/github-normalizer';

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

function branchProtectionRuleWebhook(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'created',
    repository: { id: 1, name: 'widgets', full_name: 'Acme/Widgets', owner: { login: 'Acme' } },
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

describe('normalizeGitHubPollingRow — renamed repo uses payload URL, not stale watched config', () => {
  const staleWatched: GitHubPollingRepo = { owner: 'lsm', repo: 'neokai' };

  function makeRenamedReviewCommentRow(): Record<string, unknown> {
    return {
      id: 12345,
      node_id: 'PRRC_kwAAA_renamed',
      pull_request_review_id: 99,
      body: 'nit on renamed repo',
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
    expect(event.dedupeKey).toBe(`acme/widgets:pull_request:1001:${HEAD_SHA_INITIAL}`);
    expect(event.deliveryId).toBe(`poll:pull_request:1001:${HEAD_SHA_INITIAL}`);
    expect(event.externalId).toBe(`pull_request:1001:${HEAD_SHA_INITIAL}`);
  });

  it('keeps the same dedupeKey when only updated_at advanced (e.g. a comment/check)', () => {
    const first = normalizeGitHubPollingRow(watched, makePullRow(), 'pulls');
    const second = normalizeGitHubPollingRow(
      watched,
      makePullRow({ updated_at: '2026-06-24T15:10:00Z' }),
      'pulls'
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.dedupeKey).toBe(first!.dedupeKey);
    expect(second!.deliveryId).toBe(first!.deliveryId);
    expect(second!.externalId).toBe(first!.externalId);
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
    const secondSame = normalizeGitHubPollingRow(watched, row, 'pulls');

    expect(first).not.toBeNull();
    expect(secondSame!.dedupeKey).toBe(first!.dedupeKey);
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
      expect(normalized.commentId).toBe('4242');
      expect(normalized.nodeId).toBe('PRRC_kwAAA_reviewcomment');
    });

    test('review comment that is a reply yields the ROOT comment id, not the reply id', () => {
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
      expect(normalized.commentId).toBe('4242');
      expect(normalized.nodeId).toBe('PRRC_kwAAA_reply');
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

  describe('normalizeGitHubCheckSuite', () => {
    test('check_suite events carry no reply/resolve handles and emit suite_failed', () => {
      const webhookEvent = normalizeGitHubCheckSuite({
        repo: watched,
        checkSuite: {
          id: 123456,
          status: 'completed',
          conclusion: 'failure',
          head_sha: 'abc123',
          app: { name: 'GitHub Actions' },
          updated_at: '2026-01-01T00:00:00Z',
          pull_requests: [{ number: 7 }],
        },
        deliveryId: 'delivery-1',
        rawPayload: { action: 'completed' },
        sender: { login: 'github-actions[bot]', type: 'Bot' },
      })!;
      expect(webhookEvent.commentId).toBe('');
      expect(webhookEvent.nodeId).toBe('');
      expect(webhookEvent.eventType).toBe('check_suite');
      expect(webhookEvent.action).toBe('failed');
      expect(webhookEvent.payload).toMatchObject({
        suiteId: 123456,
        conclusion: 'failure',
        app: 'GitHub Actions',
      });

      const event = toExternalEvent('space-1', webhookEvent);
      expect(event.topic).toBe('github/acme/widgets/pull_request/7.suite_failed');
    });

    test('cancelled check suites land on suite_cancelled and skipped suites are dropped', () => {
      const cancelled = normalizeGitHubCheckSuite({
        repo: watched,
        checkSuite: {
          id: 123457,
          status: 'completed',
          conclusion: 'cancelled',
          head_sha: 'abc123',
          app: { name: 'GitHub Actions' },
          updated_at: '2026-01-01T00:00:00Z',
          pull_requests: [{ number: 7 }],
        },
        deliveryId: 'delivery-2',
        rawPayload: { action: 'completed' },
        sender: { login: 'github-actions[bot]', type: 'Bot' },
      })!;
      expect(cancelled.action).toBe('cancelled');
      expect(toExternalEvent('space-1', cancelled).topic).toBe(
        'github/acme/widgets/pull_request/7.suite_cancelled'
      );

      expect(
        normalizeGitHubCheckSuite({
          repo: watched,
          checkSuite: {
            id: 123458,
            status: 'completed',
            conclusion: 'skipped',
            head_sha: 'abc123',
            pull_requests: [{ number: 7 }],
          },
          deliveryId: 'delivery-3',
          rawPayload: { action: 'completed' },
          sender: { login: 'dev', type: 'User' },
        })
      ).toBeNull();
    });
  });

  describe('normalizeGitHubMergeConflict', () => {
    test('conflicting transitions map to pull_request merge_conflict topics', () => {
      const normalized = normalizeGitHubMergeConflict({
        repo: watched,
        pullRequest: makePullRow(),
        prNumber: 42,
        conflicting: true,
        mergeable: false,
        mergeableState: 'dirty',
        sequence: 1,
        deliveryId: 'poll:merge_conflict:42',
      })!;
      expect(normalized.eventType).toBe('pull_request');
      expect(normalized.action).toBe('merge_conflict');
      expect(normalized.dedupeKey).toBe('acme/widgets:merge_conflict:42:conflict:1');
      const event = toExternalEvent('space-1', normalized);
      expect(event.topic).toBe('github/acme/widgets/pull_request/42.merge_conflict');
      expect(event.payload).toMatchObject({
        state: 'conflicting',
        mergeable: false,
        mergeableState: 'dirty',
        headSha: HEAD_SHA_INITIAL,
      });
    });

    test('resolved transitions map to merge_conflict_resolved', () => {
      const normalized = normalizeGitHubMergeConflict({
        repo: watched,
        pullRequest: makePullRow(),
        prNumber: 42,
        conflicting: false,
        mergeable: true,
        mergeableState: 'clean',
        sequence: 2,
        deliveryId: 'poll:merge_conflict:42',
      })!;
      expect(normalized.action).toBe('merge_conflict_resolved');
      expect(toExternalEvent('space-1', normalized).topic).toBe(
        'github/acme/widgets/pull_request/42.merge_conflict_resolved'
      );
    });
  });

  describe('normalizeGitHubReview', () => {
    test('a verdict review maps to review_submitted with reviewer and bot flag', () => {
      const normalized = normalizeGitHubReview(watched, 7, {
        id: 555,
        node_id: 'PRR_kwAAA_review',
        state: 'CHANGES_REQUESTED',
        body: 'please fix',
        submitted_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-555',
        user: { login: 'codex[bot]', type: 'Bot' },
      })!;
      expect(normalized.eventType).toBe('pull_request_review');
      expect(normalized.action).toBe('submitted');
      expect(normalized.dedupeKey).toBe('acme/widgets:review:555:submitted');
      const event = toExternalEvent('space-1', normalized);
      expect(event.topic).toBe('github/acme/widgets/pull_request/7.review_submitted');
      expect(event.payload).toMatchObject({
        state: 'CHANGES_REQUESTED',
        reviewer: 'codex[bot]',
        reviewerType: 'Bot',
        reviewerBot: true,
        reviewId: '555',
      });
    });

    test('human reviewers are not flagged as bots', () => {
      const normalized = normalizeGitHubReview(watched, 7, {
        id: 556,
        state: 'APPROVED',
        submitted_at: '2026-01-01T00:00:00Z',
        user: { login: 'dev', type: 'User' },
      })!;
      expect(normalized.payload).toMatchObject({ reviewer: 'dev', reviewerBot: false });
    });

    test('pending and dismissed reviews yield no verdict event', () => {
      expect(
        normalizeGitHubReview(watched, 7, {
          id: 557,
          state: 'PENDING',
          user: { login: 'dev', type: 'User' },
        })
      ).toBeNull();
      expect(
        normalizeGitHubReview(watched, 7, {
          id: 558,
          state: 'DISMISSED',
          user: { login: 'dev', type: 'User' },
        })
      ).toBeNull();
      expect(
        normalizeGitHubReview(watched, 7, {
          id: 559,
          state: 'pending',
          user: { login: 'dev', type: 'User' },
        })
      ).toBeNull();
    });

    test('lowercase polling states still match verdict states and normalize to uppercase', () => {
      const normalized = normalizeGitHubReview(watched, 7, {
        id: 560,
        state: 'approved',
        submitted_at: '2026-01-01T00:00:00Z',
        user: { login: 'dev', type: 'User' },
      })!;
      expect(normalized.payload).toMatchObject({ state: 'APPROVED' });
    });

    test('webhook review payloads use the same uppercase state casing', () => {
      const normalized = normalizeGitHubWebhook('pull_request_review', 'delivery-1', {
        ...reviewWebhook(),
        review: { ...(reviewWebhook() as { review: Record<string, unknown> }).review },
      })!;
      expect(normalized.payload).toMatchObject({ state: 'APPROVED', reviewer: 'dev' });
      expect(normalized.dedupeKey).toBe('acme/widgets:review:555:submitted');
    });
  });

  describe('normalizeGitHubDeployment', () => {
    const deployment = {
      id: 321,
      ref: 'feat/deploy',
      sha: 'abc123def456',
      environment: 'production',
      task: 'deploy',
      description: 'ship it',
      creator: { login: 'ci-bot', type: 'Bot' },
      created_at: '2026-08-02T00:00:00Z',
    };

    test('maps a deployment to a deployment_created topic under the PR', () => {
      const normalized = normalizeGitHubDeployment({
        repo: watched,
        deployment,
        source: 'webhook',
        deliveryId: 'delivery-dep',
        rawPayload: { action: 'created' },
        sender: { login: 'ci-bot', type: 'Bot' },
        prNumber: 7,
      })!;
      expect(normalized.eventType).toBe('deployment');
      expect(normalized.action).toBe('created');
      expect(normalized.prNumber).toBe(7);
      expect(normalized.dedupeKey).toBe('acme/widgets:deployment:321:created:7');
      expect(mapEventType(normalized.eventType, normalized.action, normalized.entityId)).toEqual({
        resource: 'pull_request',
        entityId: '7',
        action: 'deployment_created',
      });

      const event = toExternalEvent('space-1', normalized);
      expect(event.topic).toBe('github/acme/widgets/pull_request/7.deployment_created');
      expect(event.payload.deploymentId).toBe(321);
      expect(event.payload.environment).toBe('production');
      expect(event.payload.ref).toBe('feat/deploy');
      expect(event.payload.sha).toBe('abc123def456');
    });

    test('drops a deployment without a resolved PR (not attributable to a PR)', () => {
      expect(
        normalizeGitHubDeployment({
          repo: watched,
          deployment,
          source: 'webhook',
          deliveryId: 'delivery-dep',
          rawPayload: { action: 'created' },
        })
      ).toBeNull();
    });
  });

  describe('normalizeGitHubDeploymentStatus', () => {
    const deploymentForStatus = (overrides: Record<string, unknown> = {}) => ({
      id: 321,
      ref: 'feat/deploy',
      sha: 'abc123def456',
      environment: 'production',
      creator: { login: 'ci-bot', type: 'Bot' },
      ...overrides,
    });
    const deploymentStatus = (overrides: Record<string, unknown> = {}) => ({
      id: 654,
      state: 'success',
      description: 'Deployed successfully',
      target_url: 'https://example.com/deploy/654',
      log_url: 'https://example.com/deploy/654/logs',
      environment: 'production',
      created_at: '2026-08-02T00:00:00Z',
      creator: { login: 'ci-bot', type: 'Bot' },
      ...overrides,
    });

    test('carries the status state in the topic suffix (deployment_status_success)', () => {
      const normalized = normalizeGitHubDeploymentStatus({
        repo: watched,
        deploymentStatus: deploymentStatus(),
        deployment: deploymentForStatus(),
        source: 'webhook',
        deliveryId: 'delivery-status',
        rawPayload: { action: 'created' },
        sender: { login: 'ci-bot', type: 'Bot' },
        prNumber: 7,
      })!;
      expect(normalized.eventType).toBe('deployment_status');
      expect(normalized.action).toBe('success');
      expect(normalized.dedupeKey).toBe('acme/widgets:deployment_status:654:success:7');
      expect(mapEventType(normalized.eventType, normalized.action, normalized.entityId)).toEqual({
        resource: 'pull_request',
        entityId: '7',
        action: 'deployment_status_success',
      });

      const event = toExternalEvent('space-1', normalized);
      expect(event.topic).toBe('github/acme/widgets/pull_request/7.deployment_status_success');
      expect(event.payload.state).toBe('success');
      expect(event.payload.webhookAction).toBe('created');
      expect(event.payload.environment).toBe('production');
      expect(event.payload.targetUrl).toBe('https://example.com/deploy/654');
      expect(event.payload.logUrl).toBe('https://example.com/deploy/654/logs');
      expect(event.payload.ref).toBe('feat/deploy');
      expect(event.payload.sha).toBe('abc123def456');
      expect(event.payload.deploymentId).toBe(321);
      expect(event.externalUrl).toBe('https://example.com/deploy/654');
    });

    test('emits a distinct topic per status state', () => {
      for (const state of ['failure', 'error', 'in_progress', 'queued', 'pending']) {
        const normalized = normalizeGitHubDeploymentStatus({
          repo: watched,
          deploymentStatus: deploymentStatus({ state }),
          source: 'webhook',
          deliveryId: `delivery-${state}`,
          rawPayload: { action: 'created' },
          prNumber: 7,
        })!;
        expect(normalized.action).toBe(state);
        expect(
          mapEventType(normalized.eventType, normalized.action, normalized.entityId).action
        ).toBe(`deployment_status_${state}`);
      }
    });

    test('drops an inactive status (no event) per the merge-blocking spec', () => {
      expect(
        normalizeGitHubDeploymentStatus({
          repo: watched,
          deploymentStatus: deploymentStatus({ state: 'inactive' }),
          deployment: deploymentForStatus(),
          source: 'webhook',
          deliveryId: 'delivery-inactive',
          rawPayload: { action: 'created' },
          prNumber: 7,
        })
      ).toBeNull();
    });

    test('drops a deployment_status without a resolved PR', () => {
      expect(
        normalizeGitHubDeploymentStatus({
          repo: watched,
          deploymentStatus: deploymentStatus(),
          source: 'webhook',
          deliveryId: 'delivery-status',
          rawPayload: { action: 'created' },
        })
      ).toBeNull();
    });

    test('uses environment_url as the link when target_url is absent', () => {
      const normalized = normalizeGitHubDeploymentStatus({
        repo: watched,
        deploymentStatus: deploymentStatus({
          target_url: '',
          environment_url: 'https://app.example.com/prod',
        }),
        deployment: deploymentForStatus(),
        source: 'webhook',
        deliveryId: 'delivery-status',
        rawPayload: { action: 'created' },
        prNumber: 7,
      })!;
      expect(normalized.externalUrl).toBe('https://app.example.com/prod');
      expect(normalized.payload.environmentUrl).toBe('https://app.example.com/prod');
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
    expect(forPr7.dedupeKey).not.toBe(forPr9.dedupeKey);
    expect(forPr7.dedupeKey).toBe('acme/widgets:status:555:failure:7');
    expect(forPr9.dedupeKey).toBe('acme/widgets:status:555:failure:9');
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
    expect(normalized.nodeId).toBe('PRRT_kwAAA_thread');
    expect(normalized.commentId).toBe('4242');
    expect(normalized.prNumber).toBe(7);
    expect(normalized.actor).toBe('reviewer');
    expect(normalized.body).toBe('nit: rename this');
    expect(normalized.occurredAt).toBe(Date.parse('2026-01-01T00:10:00Z'));
    expect(normalized.payload).toMatchObject({
      title: 'PR #7 review thread resolved',
      threadId: 'PRRT_kwAAA_thread',
      resolveHandle: { kind: 'pull_request_review_thread', threadId: 'PRRT_kwAAA_thread' },
      replyHandle: { kind: 'pull_request_review_comment', commentId: '4242' },
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
    expect(event.payload.resolveHandle).toEqual({
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwAAA_thread',
    });
  });

  test('distinct resolution transitions of the same thread do not dedupe', () => {
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
    expect(event.payload.resolveHandle).toBeUndefined();
    expect(event.topic).toBe('github/acme/widgets/pull_request/7.thread_resolved');
  });

  test('outdated thread (line null) preserves the original diff location', () => {
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

describe('normalizeGitHubWebhook — branch_protection_rule (repo-scoped, resource=repo)', () => {
  test('created maps to a repo-scoped repo/{branch}.branch_protection_{action} topic', () => {
    const normalized = normalizeGitHubWebhook(
      'branch_protection_rule',
      'delivery-bpr-1',
      branchProtectionRuleWebhook()
    )!;
    expect(normalized).not.toBeNull();
    expect(normalized.eventType).toBe('branch_protection_rule');
    expect(normalized.action).toBe('created');
    expect(normalized.prNumber).toBe(0);
    expect(normalized.prUrl).toBe('https://github.com/Acme/widgets');
    expect(normalized.entityId).toBe('main');
    expect(normalized.actor).toBe('admin');
    expect(normalized.externalUrl).toBe('https://github.com/Acme/widgets/settings/branches');
    expect(normalized.body).toBe('');
    expect(normalized.payload?.changedFields).toBeUndefined();
    expect(normalized.summary).toBe('Branch protection rule "main" created by admin');

    expect(mapEventType(normalized.eventType, normalized.action, normalized.entityId)).toEqual({
      resource: 'repo',
      entityId: 'main',
      action: 'branch_protection_created',
    });

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/repo/main.branch_protection_created');
    expect(event.payload.prNumber).toBe(0);
    expect(event.payload.prUrl).toBe('https://github.com/Acme/widgets');
    expect(event.payload).toMatchObject({
      ruleId: '4242',
      ruleName: 'main',
      adminEnforced: true,
      requiredStatusChecks: ['ci/lint', 'ci/test'],
      requiredApprovingReviewCount: 2,
      requireCodeOwnerReview: true,
    });
  });

  test('preserves a required_approving_review_count of 0 (not dropped by || undefined)', () => {
    const normalized = normalizeGitHubWebhook(
      'branch_protection_rule',
      'delivery-bpr-zero',
      branchProtectionRuleWebhook({
        rule: { ...branchProtectionRuleWebhook()['rule'], required_approving_review_count: 0 },
      })
    )!;
    expect(normalized.payload?.requiredApprovingReviewCount).toBe(0);
  });

  test('sanitizes a glob branch name into a safe single topic segment', () => {
    const normalized = normalizeGitHubWebhook(
      'branch_protection_rule',
      'delivery-bpr-glob',
      branchProtectionRuleWebhook({ rule: { id: 99, name: 'release/*' } })
    )!;
    expect(normalized.entityId).toBe('release--');
    expect(normalized.payload?.ruleName).toBe('release/*');
    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/repo/release--.branch_protection_created');
  });

  test('edited surfaces the changed field names in the body/summary', () => {
    const payload = branchProtectionRuleWebhook({
      action: 'edited',
      changes: {
        required_approving_review_count: { from: 1 },
        admin_enforced: { from: false },
      },
    });
    const normalized = normalizeGitHubWebhook('branch_protection_rule', 'delivery-bpr-2', payload)!;
    expect(normalized.body).toBe('required_approving_review_count, admin_enforced');
    expect(normalized.payload?.changedFields).toEqual([
      'required_approving_review_count',
      'admin_enforced',
    ]);
    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/repo/main.branch_protection_edited');
  });

  test('deleted normalizes to the .deleted action', () => {
    const normalized = normalizeGitHubWebhook(
      'branch_protection_rule',
      'delivery-bpr-3',
      branchProtectionRuleWebhook({ action: 'deleted' })
    )!;
    expect(toExternalEvent('space-1', normalized).topic).toBe(
      'github/acme/widgets/repo/main.branch_protection_deleted'
    );
  });

  test('each webhook delivery dedupes on its own delivery id (distinct edits do not collapse)', () => {
    const first = normalizeGitHubWebhook(
      'branch_protection_rule',
      'delivery-bpr-2',
      branchProtectionRuleWebhook({
        action: 'edited',
        changes: { admin_enforced: { from: false } },
      })
    )!;
    const second = normalizeGitHubWebhook(
      'branch_protection_rule',
      'delivery-bpr-3',
      branchProtectionRuleWebhook({ action: 'edited', changes: { admin_enforced: { from: true } } })
    )!;
    expect(second.dedupeKey).not.toBe(first.dedupeKey);
    expect(first.dedupeKey).toBe('acme/widgets:branch_protection_rule:main:edited:delivery-bpr-2');
  });

  test('drops a payload without a branch name (validates on repo + branch, not rule id)', () => {
    expect(
      normalizeGitHubWebhook(
        'branch_protection_rule',
        'delivery-bpr-4',
        branchProtectionRuleWebhook({ rule: { id: 4242 } })
      )
    ).toBeNull();
    const named = normalizeGitHubWebhook(
      'branch_protection_rule',
      'delivery-bpr-4b',
      branchProtectionRuleWebhook({ rule: { name: 'main' } })
    )!;
    expect(named.entityId).toBe('main');
    expect(named.payload?.ruleId).toBeUndefined();
  });
});
