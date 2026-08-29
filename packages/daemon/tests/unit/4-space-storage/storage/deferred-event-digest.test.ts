import { describe, expect, it } from 'bun:test';
import {
  buildExternalEventDigestMessage,
  type ExternalEventEssenceEntry,
} from '../../../../src/lib/external-events/deferred-event-digest';
import { essenceEntryFromExternalEvent } from '../../../../src/lib/external-events/event-essence-entry';
import { externalEventTopicSuffix } from '../../../../src/lib/external-events/event-tiers';

const PR_URL = 'https://github.com/lsm/HyperNeo/pull/2828';

function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 23, hour, minute);
}

interface EssenceArgs {
  eventId: string;
  topic: string;
  eventType: string;
  occurredAt: number;
  action?: string;
  actor?: string;
  prNumber?: number;
  body?: string;
  extra?: Record<string, unknown>;
}

function essence(args: EssenceArgs): ExternalEventEssenceEntry {
  return essenceEntryFromExternalEvent({
    id: args.eventId,
    spaceId: 'space-1',
    topic: args.topic,
    occurredAt: args.occurredAt,
    ingestedAt: args.occurredAt,
    source: 'github',
    summary: 'summary',
    dedupeKey: args.eventId,
    externalUrl: `${PR_URL}#${args.eventId}`,
    payload: {
      eventType: args.eventType,
      action: args.action ?? 'polled',
      actor: args.actor ?? 'codex[bot]',
      repoOwner: 'lsm',
      repoName: 'HyperNeo',
      prNumber: args.prNumber ?? 2828,
      prUrl: PR_URL,
      body: args.body ?? '',
      ...args.extra,
    },
  })!;
}

function check(eventId: string, occurredAt: number, conclusion: string): ExternalEventEssenceEntry {
  return essence({
    eventId,
    topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
    eventType: 'check_run',
    occurredAt,
    extra: { checkName: 'Build Binary (linux-x64)', conclusion },
  });
}

describe('external event topic suffix', () => {
  it('extracts the suffix after the final dot', () => {
    expect(externalEventTopicSuffix('github/lsm/hyperneo/pull_request/2828.check_failed')).toBe(
      'check_failed'
    );
    expect(externalEventTopicSuffix('plain')).toBe('plain');
  });
});

describe('buildExternalEventDigestMessage', () => {
  it('collapses a mixed incident-shaped backlog into one grouped summary', () => {
    const events: string[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(check(`chk-c-${i}`, at(15, 5 + i), 'canceled'));
    }
    for (let i = 0; i < 4; i++) {
      events.push(check(`chk-f-${i}`, at(15, 40 + i), 'failure'));
    }
    events.push(check('check-11', at(16, 34), 'failure'));
    for (let i = 0; i < 3; i++) {
      events.push(
        essence({
          eventId: `rc-${i + 1}`,
          topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
          eventType: 'pull_request_review_comment',
          occurredAt: [at(15, 50), at(16), at(16, 20)][i]!,
          body: i === 2 ? 'latest review body' : `review body ${i + 1}`,
          extra: {
            commentId: `rc-${i + 1}`,
            inReplyToId: 'rc-thread-1',
            path: 'packages/daemon/src/lib/agent/query-mode-handler.ts',
            line: 88,
          },
        })
      );
    }
    events.push(
      essence({
        eventId: 'rc-4',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        eventType: 'pull_request_review_comment',
        occurredAt: at(16, 25),
        body: 'standalone review',
        extra: {
          commentId: 'rc-4',
          path: 'packages/web/src/app.tsx',
          line: 12,
        },
      })
    );
    for (let i = 0; i < 5; i++) {
      events.push(
        essence({
          eventId: `pc-${i + 1}`,
          topic: 'github/lsm/hyperneo/pull_request/2828.comment_polled',
          eventType: 'issue_comment',
          occurredAt: at(15, 30 + i),
          actor: 'marcliu',
          body: i === 4 ? 'latest pr comment' : `pr comment ${i + 1}`,
          extra: { commentId: `pc-${i + 1}` },
        })
      );
    }
    for (let i = 0; i < 8; i++) {
      events.push(
        essence({
          eventId: `st-${i + 1}`,
          topic: 'github/lsm/hyperneo/pull_request/2828.polled',
          eventType: 'pull_request',
          occurredAt: at(16, 0 + i * 5),
          extra: { state: 'open' },
        })
      );
    }
    events.push(
      essence({
        eventId: 're-1',
        topic: 'github/lsm/hyperneo/pull_request/2828.reaction_added',
        eventType: 'reaction',
        occurredAt: at(15, 5),
        action: 'added',
        actor: 'marcliu',
        body: '👍',
      })
    );
    events.push(
      essence({
        eventId: 're-2',
        topic: 'github/lsm/hyperneo/pull_request/2828.reaction_added',
        eventType: 'reaction',
        occurredAt: at(15, 10),
        action: 'added',
        actor: 'marcliu',
        body: '🚀',
      })
    );

    const essences = events;

    const digest = buildExternalEventDigestMessage(essences);
    const lines = digest.split('\n');

    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe('External events while you were working (30 events, PR #2828):');
    expect(lines[1]).toBe(
      '- CI check "Build Binary (linux-x64)": 11 runs (canceled ×6, failure ×5), ' +
        `latest 16:34 UTC (most cancelled, likely superseded by newer pushes) — ` +
        `${PR_URL}#check-11`
    );
    expect(lines[2]).toBe(
      '- Review comments on packages/daemon/src/lib/agent/query-mode-handler.ts:L88: ×3, ' +
        `latest by codex[bot] at 16:20 UTC — "latest review body" — ` +
        `${PR_URL}#rc-3 (latest eventId: rc-3)`
    );
    expect(lines[3]).toBe(
      `- Review comment on packages/web/src/app.tsx:L12: ×1, ` +
        `latest by codex[bot] at 16:25 UTC — "standalone review" — ` +
        `${PR_URL}#rc-4 (latest eventId: rc-4)`
    );
    for (let i = 0; i < 5; i++) {
      const body = i === 4 ? 'latest pr comment' : `pr comment ${i + 1}`;
      expect(lines[4 + i]).toBe(
        `- PR comment: ×1, latest by marcliu at 15:${30 + i} UTC — "${body}" — ` +
          `${PR_URL}#pc-${i + 1} (latest eventId: pc-${i + 1})`
      );
    }
    expect(lines[9]).toBe(
      `- PR #2828 state: open (latest poll 16:35 UTC, ×8 polls folded) — ` + `${PR_URL}#st-8`
    );
    expect(lines[10]).toBe(
      `- Reactions on PR #2828: ×1, latest 👍 by marcliu at 15:05 UTC — ` + `${PR_URL}#re-1`
    );
    expect(lines[11]).toBe(
      `- Reactions on PR #2828: ×1, latest 🚀 by marcliu at 15:10 UTC — ` + `${PR_URL}#re-2`
    );
  });

  it('keeps review-thread events grouped by thread', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'th-1',
        topic: 'github/o/r/pull_request/7.thread_reopened',
        eventType: 'pull_request_review_thread',
        action: 'reopened',
        actor: 'marcliu',
        prNumber: 7,
        threadId: 'tt_1',
        occurredAt: at(15),
      },
      {
        eventId: 'th-2',
        topic: 'github/o/r/pull_request/7.thread_reopened',
        eventType: 'pull_request_review_thread',
        action: 'reopened',
        actor: 'marcliu',
        prNumber: 7,
        threadId: 'tt_2',
        occurredAt: at(16),
      },
    ]);
    const lines = digest.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      '- github/o/r/pull_request/7.thread_reopened: ×1 (latest 15:00 UTC) — reopened by marcliu'
    );
    expect(lines[2]).toBe(
      '- github/o/r/pull_request/7.thread_reopened: ×1 (latest 16:00 UTC) — reopened by marcliu'
    );
  });

  it('collapses same-value reaction duplicates but keeps actors distinct', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'ra-1',
        topic: 'github/o/r/pull_request/7.reaction_added',
        eventType: 'reaction',
        action: 'added',
        actor: 'codex[bot]',
        prNumber: 7,
        body: '👍',
        occurredAt: at(15),
      },
      {
        eventId: 'ra-2',
        topic: 'github/o/r/pull_request/7.reaction_added',
        eventType: 'reaction',
        action: 'added',
        actor: 'codex[bot]',
        prNumber: 7,
        body: '👍',
        occurredAt: at(16),
      },
      {
        eventId: 'ra-3',
        topic: 'github/o/r/pull_request/7.reaction_added',
        eventType: 'reaction',
        action: 'added',
        actor: 'marcliu',
        prNumber: 7,
        body: '👍',
        occurredAt: at(17),
      },
      {
        eventId: 'ra-4',
        topic: 'github/o/r/pull_request/7.reaction_added',
        eventType: 'reaction',
        action: 'added',
        actor: 'marcliu',
        prNumber: 7,
        body: '🚀',
        occurredAt: at(18),
      },
    ]);
    expect(digest).toContain('Reactions on PR #7: ×2, latest 👍 by codex[bot] at 16:00 UTC');
    expect(digest).toContain('Reactions on PR #7: ×1, latest 👍 by marcliu at 17:00 UTC');
    expect(digest).toContain('Reactions on PR #7: ×1, latest 🚀 by marcliu at 18:00 UTC');
  });

  it('keeps payload-free reactions separate by event', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'pf-1',
        topic: 'github/o/r/pull_request/7.reaction_added',
        prNumber: 7,
      },
      {
        eventId: 'pf-2',
        topic: 'github/o/r/pull_request/7.reaction_added',
        prNumber: 7,
      },
    ]);
    const lines = digest.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('- Reactions on PR #7: ×1, latest reaction by unknown at unknown time');
    expect(lines[2]).toBe('- Reactions on PR #7: ×1, latest reaction by unknown at unknown time');
  });

  it('renders branch-protection policy values alongside changed field names', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'bp-2',
        topic: 'github/o/r/repo/42.branch_protection_edited',
        eventType: 'branch_protection_rule',
        action: 'edited',
        actor: 'marcliu',
        ruleName: 'main',
        requiredApprovingReviewCount: 2,
        requireCodeOwnerReview: true,
        occurredAt: at(16),
      },
    ]);
    expect(digest).toContain('"ruleName":"main"');
    expect(digest).toContain('"requiredApprovingReviewCount":2');
    expect(digest).toContain('"requireCodeOwnerReview":true');
  });

  it('renders structured branch-protection payload fields on other-tier lines', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'bp-1',
        topic: 'github/o/r/repo/42.branch_protection_edited',
        eventType: 'branch_protection_rule',
        action: 'edited',
        actor: 'marcliu',
        changedFields: { requireConversationResolution: true },
        occurredAt: at(16),
      },
    ]);
    expect(digest).toContain('edited by marcliu');
    expect(digest).toContain('{"requireConversationResolution":true}');
  });

  it('renders date-inclusive timestamps when the backlog spans multiple UTC days', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'd-1',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: Date.UTC(2026, 7, 22, 16, 34),
      },
      {
        eventId: 'd-2',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: Date.UTC(2026, 7, 23, 16, 34),
      },
    ]);
    expect(digest).toContain('latest 08-23 16:34 UTC');
  });

  it('carries dropped events through to the digest totals', () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      eventId: `env-${i + 5}`,
      topic: 'github/o/r/pull_request/7.check_failed',
      prNumber: 7,
      checkName: 'lint',
      conclusion: 'failure',
      occurredAt: at(15) + i * 1000,
    }));
    const digest = buildExternalEventDigestMessage(events, { droppedEventCount: 5 });
    expect(digest.split('\n')[0]).toBe(
      'External events while you were working (205 events, PR #7):'
    );
    expect(digest).toContain(
      '5 older events were omitted from this summary (over the event bound) and may still need attention.'
    );
  });

  it('keeps only the newest state across superseded polls', () => {
    const essences = [
      {
        eventId: 's1',
        topic: 'github/o/r/pull_request/7.polled',
        prNumber: 7,
        state: 'open',
      },
      {
        eventId: 's2',
        topic: 'github/o/r/pull_request/7.polled',
        prNumber: 7,
        state: 'closed',
      },
    ];
    const digest = buildExternalEventDigestMessage(essences);
    expect(digest).toContain('PR #7 state: closed');
    expect(digest).toContain('×2 polls folded');
    expect(digest).not.toContain('open');
  });

  it('routes non-poll pull_request webhook actions to the payload-preserving renderer', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'pr-1',
        topic: 'github/o/r/pull_request/7.review_requested',
        eventType: 'pull_request',
        action: 'review_requested',
        actor: 'marcliu',
        prNumber: 7,
        state: 'open',
        occurredAt: at(16),
      },
    ]);
    expect(digest).toContain('review_requested by marcliu');
    expect(digest).not.toContain('PR #7 state: open');
  });

  it('keeps merged markers on closed PR webhooks routed through the other renderer', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'pr-closed',
        topic: 'github/o/r/pull_request/7.closed',
        eventType: 'pull_request',
        action: 'closed',
        actor: 'marcliu',
        prNumber: 7,
        state: 'closed',
        merged: true,
        occurredAt: at(16),
      },
    ]);
    expect(digest).toContain('closed by marcliu');
    expect(digest).toContain('state: closed (merged)');
  });

  it('labels deleted comment actions instead of presenting them as current comments', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'del-1',
        topic: 'github/o/r/pull_request/7.comment_deleted',
        eventType: 'issue_comment',
        action: 'deleted',
        actor: 'marcliu',
        prNumber: 7,
        body: 'outdated comment',
        commentId: 'del-1',
        occurredAt: at(16),
      },
    ]);
    expect(digest).toContain('PR comment (deleted): ×1');
  });

  it('keeps payload-free reconstructed checks separate by event', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'rl-check-1',
        topic: 'github/o/r/pull_request/7.check_failed',
        prNumber: 7,
      },
      {
        eventId: 'rl-check-2',
        topic: 'github/o/r/pull_request/7.check_failed',
        prNumber: 7,
      },
    ]);
    const lines = digest.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('- CI check "unknown check": unknown ×1, latest unknown time');
    expect(lines[2]).toBe('- CI check "unknown check": unknown ×1, latest unknown time');
  });

  it('separates submitted reviews by reviewId and statuses by context', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'rev-1',
        topic: 'github/o/r/pull_request/7.review_submitted',
        eventType: 'pull_request_review',
        action: 'submitted',
        actor: 'reviewer-a',
        prNumber: 7,
        reviewId: 'rv-1',
        occurredAt: at(15),
      },
      {
        eventId: 'rev-2',
        topic: 'github/o/r/pull_request/7.review_submitted',
        eventType: 'pull_request_review',
        action: 'submitted',
        actor: 'reviewer-b',
        prNumber: 7,
        reviewId: 'rv-2',
        occurredAt: at(16),
      },
      {
        eventId: 'st-ctx-1',
        topic: 'github/o/r/pull_request/7.status_failure',
        eventType: 'status',
        action: 'failure',
        actor: 'github-actions[bot]',
        prNumber: 7,
        context: 'lint',
        occurredAt: at(15, 30),
      },
      {
        eventId: 'st-ctx-2',
        topic: 'github/o/r/pull_request/7.status_failure',
        eventType: 'status',
        action: 'failure',
        actor: 'github-actions[bot]',
        prNumber: 7,
        context: 'deploy',
        occurredAt: at(15, 40),
      },
    ]);
    expect(digest).toContain('submitted by reviewer-a');
    expect(digest).toContain('submitted by reviewer-b');
    expect(digest).toContain('status_failure: ×1 (latest 15:30 UTC)');
    expect(digest).toContain('status_failure: ×1 (latest 15:40 UTC)');
  });

  it('treats out-of-range occurredAt values as unknown and never ranks them as latest', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'bad-1',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: 8.7e15,
      },
      {
        eventId: 'bad-2',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: at(16),
      },
    ]);
    expect(digest).toContain('failure ×2');
    expect(digest).toContain(`latest 16:00 UTC`);
  });

  it('derives per-PR scope from topic-segmented events', () => {
    const topicScopedEssence = (eventId: string, topic: string): ExternalEventEssenceEntry =>
      essenceEntryFromExternalEvent({
        id: eventId,
        spaceId: 'space-1',
        topic,
        occurredAt: at(15),
        ingestedAt: at(15),
        source: 'github',
        summary: 'summary',
        dedupeKey: eventId,
        payload: { eventType: 'pull_request', action: 'polled' },
      })!;
    const essences = [
      topicScopedEssence('rl-7', 'github/o/r/pull_request/7.polled'),
      topicScopedEssence('rl-8', 'github/o/r/pull_request/8.polled'),
    ];
    const digest = buildExternalEventDigestMessage(essences);
    expect(digest).toContain('PR #7 state: updated');
    expect(digest).toContain('PR #8 state: updated');
  });

  it('marks merged, unmerged, and draft PR states distinctly', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'm-1',
        topic: 'github/o/r/pull_request/7.polled',
        prNumber: 7,
        state: 'closed',
        merged: true,
        occurredAt: at(15),
      },
      {
        eventId: 'm-2',
        topic: 'github/o/r/pull_request/8.polled',
        prNumber: 8,
        state: 'closed',
        merged: false,
        occurredAt: at(16),
      },
      {
        eventId: 'm-3',
        topic: 'github/o/r/pull_request/9.polled',
        prNumber: 9,
        state: 'open',
        draft: true,
        occurredAt: at(17),
      },
    ]);
    expect(digest).toContain('PR #7 state: closed (merged)');
    expect(digest).toContain('PR #8 state: closed (not merged)');
    expect(digest).toContain('PR #9 state: open (draft)');
  });

  it('does not claim a majority cancellation note when failures dominate', () => {
    const essences = [
      { conclusion: 'canceled', occurredAt: at(15) },
      { conclusion: 'failure', occurredAt: at(16) },
      { conclusion: 'failure', occurredAt: at(16, 30) },
    ].map((fields, i) => ({
      eventId: `c-${i}`,
      topic: 'github/o/r/pull_request/7.check_failed',
      checkName: 'lint',
      ...fields,
    }));
    const digest = buildExternalEventDigestMessage(essences);
    expect(digest).toContain('CI check "lint": 3 runs (failure ×2, canceled ×1)');
    expect(digest).not.toContain('most cancelled');
  });

  it('falls back to a topic line for unknown suffixes and keeps payload-free events separate', () => {
    const digest = buildExternalEventDigestMessage([
      { eventId: 'u-1', topic: 'github/o/r/pull_request/9.merge_group_polled', prNumber: 9 },
      { eventId: 'u-2', topic: 'github/o/r/pull_request/9.merge_group_polled', prNumber: 9 },
    ]);
    expect(digest).toContain('External events while you were working (2 events, PR #9):');
    expect(digest).toContain('github/o/r/pull_request/9.merge_group_polled: ×1');
    const lines = digest.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      '- github/o/r/pull_request/9.merge_group_polled: ×1 (latest unknown time)'
    );
    expect(lines[2]).toBe(
      '- github/o/r/pull_request/9.merge_group_polled: ×1 (latest unknown time)'
    );
  });

  it('preserves actionable payload fields on other-tier lines', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'dep-1',
        topic: 'github/o/r/pull_request/9.deployment_status_failure',
        prNumber: 9,
        state: 'failure',
        environment: 'production',
        description: 'Deploy failed: health check timed out',
        occurredAt: at(16, 5),
      },
    ]);
    expect(digest).toContain('state: failure');
    expect(digest).toContain('environment: production');
    expect(digest).toContain('"Deploy failed: health check timed out"');
  });

  it('collapses a single-conclusion check group without a runs clause', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'c-1',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: at(16),
      },
      {
        eventId: 'c-2',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: at(16, 10),
      },
    ]);
    expect(digest).toContain('CI check "lint": failure ×2');
    expect(digest).not.toContain('runs (');
  });

  it('uses a singular header for a single event and omits scope without a PR', () => {
    const digest = buildExternalEventDigestMessage([
      { eventId: 'u-1', topic: 'github/o/r/repo/42.branch_protection_edited' },
    ]);
    expect(digest.split('\n')[0]).toBe('External events while you were working (1 event):');
  });

  it('is deterministic for identical input', () => {
    const essences = [
      { eventId: 'a', topic: 'github/o/r/pull_request/1.polled', state: 'open' },
      { eventId: 'b', topic: 'github/o/r/pull_request/1.reaction_added', body: '👍' },
    ];
    expect(buildExternalEventDigestMessage(essences)).toBe(
      buildExternalEventDigestMessage([...essences].reverse())
    );
  });
});
