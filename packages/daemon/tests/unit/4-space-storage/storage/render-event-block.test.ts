import { describe, expect, it } from 'bun:test';
import {
  buildExternalEventDigestMessage,
  type ExternalEventEssenceEntry,
  renderEventBlock,
  type RenderEventBlockOptions,
} from '../../../../src/lib/external-events/deferred-event-digest';

const PR_URL = 'https://github.com/o/r/pull/7';

function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 23, hour, minute);
}

const CHECK_SOURCES: Array<[string, string, number]> = [
  ['cf-0', 'canceled', at(15)],
  ['cf-1', 'canceled', at(15, 5)],
  ['cf-2', 'failure', at(16, 34)],
];
const CHECKS: ExternalEventEssenceEntry[] = CHECK_SOURCES.map(
  ([eventId, conclusion, occurredAt]) => ({
    eventId,
    topic: 'github/o/r/pull_request/7.check_failed',
    checkName: 'lint',
    conclusion,
    occurredAt,
    prUrl: PR_URL,
  })
);
const FOLDED_CHECKS: RenderEventBlockOptions = { count: CHECKS.length, events: CHECKS };

const REVIEW_SOURCES: Array<[string, string, number]> = [
  ['rt-1', 'review body 1', at(15, 50)],
  ['rt-2', 'review body 2', at(15, 55)],
  ['rt-3', 'latest review body', at(16)],
];
const REVIEWS: ExternalEventEssenceEntry[] = REVIEW_SOURCES.map(([eventId, body, occurredAt]) => ({
  eventId,
  topic: 'github/o/r/pull_request/7.review_comment_polled',
  eventType: 'pull_request_review_comment',
  actor: 'codex[bot]',
  body,
  commentId: eventId,
  inReplyToId: 'rt-thread',
  path: 'packages/daemon/src/lib/agent/query-mode-handler.ts',
  line: 88,
  occurredAt,
  prUrl: PR_URL,
}));

describe('renderEventBlock', () => {
  it('renders a single check event with its conclusion', () => {
    expect(renderEventBlock(CHECKS[2]!)).toBe(
      `- CI check "lint": failure ×1, latest 16:34 UTC` + ` — ${PR_URL}`
    );
  });

  it('folds review threads by default and lists each body when renderAllReviewBodies is set', () => {
    expect(renderEventBlock(REVIEWS[2]!, { count: REVIEWS.length, events: REVIEWS })).toBe(
      '- Review comments on packages/daemon/src/lib/agent/query-mode-handler.ts:L88: ×3, ' +
        `latest by codex[bot] at 16:00 UTC — ${PR_URL}` +
        ' (latest eventId: rt-3)\n' +
        '  latest review body'
    );
    expect(
      renderEventBlock(REVIEWS[2]!, {
        count: REVIEWS.length,
        events: REVIEWS,
        renderAllReviewBodies: true,
      })
    ).toBe(
      '- Review comment by codex[bot] at 15:50 UTC ' +
        'on packages/daemon/src/lib/agent/query-mode-handler.ts:L88 ' +
        `— ${PR_URL} (latest eventId: rt-1)\n` +
        '  review body 1\n' +
        '- Review comment by codex[bot] at 15:55 UTC ' +
        'on packages/daemon/src/lib/agent/query-mode-handler.ts:L88 ' +
        `— ${PR_URL} (latest eventId: rt-2)\n` +
        '  review body 2\n' +
        '- Review comment by codex[bot] at 16:00 UTC ' +
        'on packages/daemon/src/lib/agent/query-mode-handler.ts:L88 ' +
        `— ${PR_URL} (latest eventId: rt-3)\n` +
        '  latest review body'
    );
  });

  it('renders a PR comment with its body below the metadata line', () => {
    expect(
      renderEventBlock({
        eventId: 'pc-1',
        topic: 'github/o/r/pull_request/7.comment_polled',
        eventType: 'issue_comment',
        actor: 'marcliu',
        body: 'pr comment 1',
        commentId: 'pc-1',
        occurredAt: at(15, 30),
        prUrl: PR_URL,
      })
    ).toBe(
      `- PR comment: ×1, latest by marcliu at 15:30 UTC — ${PR_URL}` +
        ' (latest eventId: pc-1)\n' +
        '  pr comment 1'
    );
  });

  it('renders multi-line bodies verbatim with markdown and HTML intact', () => {
    expect(
      renderEventBlock({
        eventId: 'ml-1',
        topic: 'github/o/r/pull_request/7.comment_polled',
        eventType: 'issue_comment',
        actor: 'coderabbitai[bot]',
        body:
          '<sub>![P2 Badge](https://img.shields.io/badge/P2-5e2c2c) <b>Nit</b></sub> in `foo.ts`\r\n\r\n' +
          'second paragraph\n\n\nthird',
        commentId: 'ml-1',
        occurredAt: at(16),
        prUrl: PR_URL,
      })
    ).toBe(
      `- PR comment: ×1, latest by coderabbitai[bot] at 16:00 UTC — ${PR_URL}` +
        ' (latest eventId: ml-1)\n' +
        '  <sub>![P2 Badge](https://img.shields.io/badge/P2-5e2c2c) <b>Nit</b></sub> in `foo.ts`\n' +
        '\n' +
        '  second paragraph\n' +
        '\n' +
        '\n' +
        '  third'
    );
  });

  it('renders a review-thread body below the topic line', () => {
    expect(
      renderEventBlock({
        eventId: 'th-1',
        topic: 'github/o/r/pull_request/7.thread_resolved',
        eventType: 'pull_request_review_thread',
        action: 'resolved',
        actor: 'marcliu',
        body: 'thread resolved\n\nthanks',
        threadId: 'tt_1',
        occurredAt: at(15),
        prUrl: PR_URL,
      })
    ).toBe(
      `- github/o/r/pull_request/7.thread_resolved: ×1 (latest 15:00 UTC) — ` +
        `resolved by marcliu — ${PR_URL}\n` +
        '  thread resolved\n' +
        '\n' +
        '  thanks'
    );
  });

  it('preserves leading indentation in comment bodies', () => {
    expect(
      renderEventBlock({
        eventId: 'ws-1',
        topic: 'github/o/r/pull_request/7.comment_polled',
        eventType: 'issue_comment',
        actor: 'marcliu',
        body: '    const x = 1\n    const y = 2',
        commentId: 'ws-1',
        occurredAt: at(16),
        prUrl: PR_URL,
      })
    ).toBe(
      `- PR comment: ×1, latest by marcliu at 16:00 UTC — ${PR_URL}` +
        ' (latest eventId: ws-1)\n' +
        '      const x = 1\n' +
        '      const y = 2'
    );
    expect(
      renderEventBlock({
        eventId: 'ws-2',
        topic: 'github/o/r/pull_request/7.comment_polled',
        eventType: 'issue_comment',
        actor: 'marcliu',
        body: '  \n\n  ',
        commentId: 'ws-2',
        occurredAt: at(16),
        prUrl: PR_URL,
      })
    ).toBe(
      `- PR comment: ×1, latest by marcliu at 16:00 UTC — ${PR_URL}` + ' (latest eventId: ws-2)'
    );
  });

  it('caps comment bodies at 200000 characters with a truncation marker', () => {
    const block = renderEventBlock({
      eventId: 'cap-1',
      topic: 'github/o/r/pull_request/7.comment_polled',
      eventType: 'issue_comment',
      actor: 'marcliu',
      body: 'a'.repeat(200050),
      commentId: 'cap-1',
      occurredAt: at(16),
      prUrl: PR_URL,
    });
    const lines = block.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`  ${'a'.repeat(200000)}`);
    expect(lines[2]).toBe('  [comment body truncated at 200000 characters]');
  });

  it('renders state markers and poll folds', () => {
    expect(
      renderEventBlock(
        {
          eventId: 'st-1',
          topic: 'github/o/r/pull_request/7.polled',
          eventType: 'pull_request',
          prNumber: 7,
          state: 'open',
          draft: true,
          occurredAt: at(16, 34),
          prUrl: PR_URL,
        },
        { count: 8 }
      )
    ).toBe(`- PR #7 state: open (draft) (latest poll 16:34 UTC, ×8 polls folded) — ${PR_URL}`);
  });

  it('renders a reaction with its emoji and actor', () => {
    expect(
      renderEventBlock({
        eventId: 're-1',
        topic: 'github/o/r/pull_request/7.reaction_added',
        eventType: 'reaction',
        prNumber: 7,
        action: 'added',
        actor: 'marcliu',
        body: '👍',
        occurredAt: at(15, 5),
        prUrl: PR_URL,
      })
    ).toBe(`- Reactions on PR #7: ×1, latest 👍 by marcliu at 15:05 UTC` + ` — ${PR_URL}`);
  });

  it('preserves other-tier payload fields and carries the full description', () => {
    expect(
      renderEventBlock(
        {
          eventId: 'dep-1',
          topic: 'github/o/r/pull_request/9.deployment_status_failure',
          prNumber: 9,
          state: 'failure',
          environment: 'production',
          description: 'Deploy failed: health check timed out',
          occurredAt: at(16, 5),
          prUrl: 'https://github.com/o/r/pull/9',
        },
        { includeDate: true }
      )
    ).toBe(
      '- github/o/r/pull_request/9.deployment_status_failure: ×1 (latest 08-23 16:05 UTC) — ' +
        'state: failure — environment: production — "Deploy failed: health check timed out" — ' +
        'https://github.com/o/r/pull/9'
    );
  });

  it('renders digest groups of one and folded groups byte-identically to the digest renderer', () => {
    const single: ExternalEventEssenceEntry = {
      eventId: 'eq-1',
      topic: 'github/o/r/pull_request/7.comment_polled',
      eventType: 'issue_comment',
      actor: 'marcliu',
      body: 'equivalence pin',
      commentId: 'eq-1',
      occurredAt: at(16),
      prUrl: PR_URL,
    };
    const singleDigest = buildExternalEventDigestMessage([single]);
    expect(renderEventBlock(single)).toBe(singleDigest.split('\n').slice(1).join('\n'));
    const foldedDigest = buildExternalEventDigestMessage(CHECKS);
    expect(renderEventBlock(CHECKS[2]!, FOLDED_CHECKS)).toBe(foldedDigest.split('\n')[1]);
  });
});
