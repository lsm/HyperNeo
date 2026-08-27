import { describe, expect, it } from 'bun:test';
import {
  type ExternalEventEssenceEntry,
  parseDeferredExternalEventText,
  renderEventBlock,
} from '../../../../src/lib/external-events/deferred-event-digest.ts';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence.ts';
import { essenceEntryFromExternalEvent } from '../../../../src/lib/external-events/event-essence-entry.ts';
import type { ExternalEventPublishedPayload as PublishedPayload } from '../../../../src/lib/external-events/external-event-service.ts';
import {
  normalizeGitHubPollingRow,
  normalizeGitHubReaction,
  normalizeGitHubWebhook,
  toExternalEvent,
} from '../../../../src/lib/external-events/github/github-normalizer.ts';
import { renderIngestEvent } from '../../../../src/lib/external-events/ingest-external-event-pipeline.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';

const SPACE_ID = 'space-essence-entry-equivalence';
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

function branchProtectionEvent(action: 'created' | 'edited'): ExternalEvent {
  return webhookEvent('branch_protection_rule', `delivery-rule-${action}`, {
    action,
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
      ...(action === 'edited' ? { changes: { required_approving_review_count: { from: 1 } } } : {}),
    },
  });
}

function syntheticEvent(
  topic: string,
  payload: Record<string, unknown>,
  overrides: Partial<ExternalEvent> = {}
): ExternalEvent {
  return {
    id: 'evt-synthetic',
    spaceId: SPACE_ID,
    topic,
    occurredAt: 1755648000000,
    ingestedAt: 1755648001000,
    source: 'github',
    summary: 'synthetic fixture',
    payload,
    dedupeKey: 'dk-synthetic',
    ...overrides,
  };
}

function publishedPayloadOf(event: ExternalEvent): PublishedPayload {
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

function roundTripEssence(event: ExternalEvent): ExternalEventEssenceEntry | null {
  const parsed = parseDeferredExternalEventText(
    formatExternalEventEssence(publishedPayloadOf(event))
  );
  return parsed && parsed.kind === 'event' ? parsed.essence : null;
}

const CASES: Array<{ kind: string; event: ExternalEvent }> = [
  { kind: 'check_run', event: checkRunEvent() },
  { kind: 'review_comment', event: reviewCommentEvent() },
  { kind: 'pr_comment', event: issueCommentEvent() },
  { kind: 'polled_pr', event: polledPullRequestEvent() },
  { kind: 'reaction', event: reactionEvent() },
  { kind: 'branch_protection_created', event: branchProtectionEvent('created') },
  { kind: 'branch_protection_edited', event: branchProtectionEvent('edited') },
  {
    kind: 'pull_request_review',
    event: syntheticEvent('github/acme/widgets/pull_request/42.review_submitted', {
      eventType: 'pull_request_review',
      action: 'submitted',
      state: 'approved',
      submittedAt: '2026-08-20T09:00:00Z',
      commitId: 'abc123deadbeef',
      reviewerBot: true,
      reviewId: 'rv-1',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
      prUrl: 'https://github.com/acme/widgets/pull/42',
      actor: 'devin-ai-integration[bot]',
      body: 'No issues found',
    }),
  },
  {
    kind: 'review_thread',
    event: syntheticEvent('github/acme/widgets/pull_request/42.thread_resolved', {
      eventType: 'pull_request_review_thread',
      action: 'resolved',
      threadId: 'PRRT_kwDOA_thread',
      path: 'packages/daemon/src/lib/external-events/delivery.ts',
      line: 87,
      side: 'RIGHT',
      originalStartLine: 84,
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
    }),
  },
  {
    kind: 'status',
    event: syntheticEvent('github/acme/widgets/pull_request/42.status_failure', {
      eventType: 'status',
      action: 'failure',
      state: 'failure',
      description: 'build failed',
      context: 'ci/lint',
      targetUrl: 'https://example.com/status',
      sha: 'abc123deadbeef',
      statusId: 1,
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
    }),
  },
  {
    kind: 'check_suite',
    event: syntheticEvent('github/acme/widgets/pull_request/42.suite_failed', {
      eventType: 'check_suite',
      action: 'completed',
      conclusion: 'failure',
      headSha: 'abc123deadbeef',
      app: 'GitHub Actions',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
    }),
  },
  {
    kind: 'merge_group',
    event: syntheticEvent('github/acme/widgets/pull_request/123.merge_group_checks_requested', {
      eventType: 'merge_group',
      action: 'checks_requested',
      headSha: 'abc123def456789012345678901234567890abcd',
      headRef: 'refs/heads/gh-readonly-queue/main/pr-123-abc123def456',
      baseRef: 'refs/heads/main',
      baseSha: 'def456789012345678901234567890abcdef12',
      headCommitId: 'abc123def456789012345678901234567890abcd',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 123,
    }),
  },
  {
    kind: 'deployment',
    event: syntheticEvent('github/acme/widgets/pull_request/42.deployment_created', {
      eventType: 'deployment',
      action: 'created',
      deploymentId: 321,
      environment: 'production',
      ref: 'feat/deploy',
      sha: 'abc123deadbeef',
      task: 'deploy',
      description: 'ship it',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
    }),
  },
  {
    kind: 'deployment_status',
    event: syntheticEvent('github/acme/widgets/pull_request/42.deployment_status_failure', {
      eventType: 'deployment_status',
      action: 'failure',
      deploymentStatusId: 654,
      state: 'failure',
      environment: 'production',
      description: 'deploy failed',
      targetUrl: 'https://example.com/deploy/654',
      environmentUrl: 'https://app.example.com/prod',
      logUrl: 'https://example.com/deploy/654/logs',
      ref: 'feat/deploy',
      sha: 'abc123deadbeef',
      deploymentId: 321,
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
    }),
  },
  {
    kind: 'suffix_check_failed',
    event: syntheticEvent('github/acme/widgets/pull_request/42.check_failed', {
      eventType: 'watch',
      action: 'started',
      checkName: 'build-linux',
      conclusion: 'failure',
      runUrl: 'https://example.com/run/9001',
      status: 'completed',
      headSha: 'abc123deadbeef',
    }),
  },
  {
    kind: 'suffix_suite_failed',
    event: syntheticEvent('github/acme/widgets/pull_request/42.suite_failed', {
      eventType: 'fork',
      action: 'completed',
      conclusion: 'timed_out',
      headSha: 'abc123deadbeef',
      app: 'GitHub Actions',
    }),
  },
  {
    kind: 'scope_backfill',
    event: syntheticEvent('github/acme/widgets/pull_request/42.comment_created', {
      eventType: 'issue_comment',
      action: 'created',
      actor: 'reviewer',
      body: 'scope comes from the topic',
    }),
  },
  {
    kind: 'zero_pr_number',
    event: syntheticEvent('github/acme/widgets/pull_request/42.polled', {
      eventType: 'pull_request',
      action: 'polled',
      state: 'open',
      prNumber: 0,
      repoOwner: 'acme',
      repoName: 'widgets',
    }),
  },
  {
    kind: 'empty_strings',
    event: syntheticEvent('github/acme/widgets/pull_request/42.comment_created', {
      eventType: 'issue_comment',
      action: '',
      actor: '',
      body: '',
      prUrl: '',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
    }),
  },
  {
    kind: 'non_github_topic',
    event: syntheticEvent('gitlab/acme/widgets/merge/7.opened', {
      eventType: 'merge_request',
      action: 'open',
      repoOwner: 'acme',
      repoName: 'widgets',
    }),
  },
  {
    kind: 'nonfinite_occurred_at',
    event: syntheticEvent(
      'github/acme/widgets/pull_request/42.comment_created',
      { eventType: 'issue_comment', action: 'created', body: 'infinite timestamp' },
      { occurredAt: Number.POSITIVE_INFINITY }
    ),
  },
  {
    kind: 'falsey_scalars',
    event: syntheticEvent('github/acme/widgets/repo/main.branch_protection_edited', {
      eventType: 'branch_protection_rule',
      action: 'edited',
      ruleName: 'main',
      adminEnforced: false,
      requiredApprovingReviewCount: 0,
      requireCodeOwnerReview: false,
      requiredStatusChecks: [],
      changedFields: ['required_approving_review_count'],
      repoOwner: 'acme',
      repoName: 'widgets',
    }),
  },
];

describe('direct record→essence converter equivalence', () => {
  it('matches the format→parse round trip across the fixture corpus', () => {
    let nonNull = 0;
    for (const { kind, event } of CASES) {
      expect([kind, essenceEntryFromExternalEvent(event)]).toEqual([kind, roundTripEssence(event)]);
      if (roundTripEssence(event) !== null) nonNull += 1;
    }
    expect(nonNull).toBe(CASES.length);
  });

  it('returns null exactly where the round trip returns null', () => {
    for (const event of [
      { ...checkRunEvent(), id: '' },
      { ...checkRunEvent(), topic: '' },
    ]) {
      expect(essenceEntryFromExternalEvent(event)).toBeNull();
      expect(roundTripEssence(event)).toBeNull();
    }
  });

  it('ingest render falls back to { eventId, topic } when the converter returns null', () => {
    const event = { ...checkRunEvent(), id: '' };
    const ctx = renderIngestEvent({
      event,
      deps: {
        store: () => {
          throw new Error('store is not used by the render stage');
        },
      },
    });
    expect(ctx.render).toBe(renderEventBlock({ eventId: event.id, topic: event.topic }));
  });
});
