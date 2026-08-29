import { describe, expect, it } from 'bun:test';
import {
  classifyUrgency,
  type ExternalEventUrgency,
} from '../../../../src/lib/external-events/event-urgency.ts';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service.ts';

const PR_TOPIC = 'github/acme/widgets/pull_request/42';

const SUFFIX_EVENT_TYPES: Record<string, string> = {
  review_submitted: 'pull_request_review',
  review_comment_polled: 'pull_request_review_comment',
  review_comment_created: 'pull_request_review_comment',
  check_failed: 'check_run',
  check_cancelled: 'check_run',
  check_skipped: 'check_run',
  suite_failed: 'check_suite',
  merge_conflict: 'pull_request',
  merge_conflict_resolved: 'pull_request',
  comment_polled: 'issue_comment',
  polled: 'pull_request',
  reaction_added: 'reaction',
  thread_resolved: 'pull_request_review_thread',
  status_failure: 'status',
};

let eventSeq = 0;

function publishedEvent(
  topic: string,
  overrides: Record<string, unknown>
): ExternalEventPublishedPayload {
  eventSeq += 1;
  const eventId = `evt-${eventSeq}`;
  return {
    namespaceId: 'space-urgency-pin',
    spaceId: 'space-urgency-pin',
    eventId,
    source: 'github',
    topic,
    dedupeKey: `dedupe-${eventId}`,
    summary: `urgency pin ${topic}`,
    externalUrl: 'https://github.com/acme/widgets/pull/42',
    payload: {
      eventType: SUFFIX_EVENT_TYPES[topic.split('.').pop() ?? ''] ?? 'pull_request',
      action: 'polled',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
      ...overrides,
    },
    occurredAt: 1_753_600_000_000,
    ingestedAt: 1_753_600_000_000,
  };
}

const DECISION_TABLE: Array<
  [suffix: string, overrides: Record<string, unknown>, expected: ExternalEventUrgency]
> = [
  ['review_submitted', { actor: 'reviewer', state: 'APPROVED' }, 'immediate'],
  ['review_submitted', { actor: 'reviewer', state: 'CHANGES_REQUESTED' }, 'immediate'],
  ['review_submitted', { actor: 'reviewer', state: 'COMMENTED' }, 'queued'],
  ['review_submitted', { actor: 'reviewer', state: 'PENDING' }, 'queued'],
  ['review_submitted', { actor: 'reviewer', state: 'approved' }, 'queued'],
  ['review_submitted', { actor: 'reviewer' }, 'queued'],
  [
    'review_submitted',
    { actor: 'reviewer', state: 'APPROVED', conclusion: 'success' },
    'immediate',
  ],
  ['review_comment_polled', { actor: 'codex[bot]', commentId: '4242' }, 'immediate'],
  ['review_comment_polled', { actor: 'Codex[Bot]', commentId: '4242' }, 'queued'],
  ['review_comment_polled', { actor: 'alice', commentId: '4242' }, 'queued'],
  ['review_comment_polled', { commentId: '4242' }, 'queued'],
  ['review_comment_polled', { actor: 'codex[bot]', state: 'CHANGES_REQUESTED' }, 'immediate'],
  ['check_failed', { checkName: 'CI', conclusion: 'failure' }, 'immediate'],
  ['check_failed', { checkName: 'CI', conclusion: 'timed_out' }, 'immediate'],
  ['check_failed', { checkName: 'CI', conclusion: 'startup_failure' }, 'immediate'],
  ['check_failed', { checkName: 'CI', conclusion: 'Failure' }, 'immediate'],
  ['check_failed', { checkName: 'CI' }, 'immediate'],
  ['check_failed', { checkName: 'CI', conclusion: 'cancelled' }, 'queued'],
  ['check_failed', { checkName: 'CI', conclusion: 'canceled' }, 'queued'],
  ['check_failed', { checkName: 'CI', conclusion: 'skipped' }, 'queued'],
  ['check_failed', { checkName: 'CI', conclusion: 'success' }, 'queued'],
  ['check_failed', { checkName: 'CI', conclusion: 'neutral' }, 'queued'],
  ['merge_conflict', { state: 'conflicting' }, 'immediate'],
  ['merge_conflict', { state: 'clean' }, 'immediate'],
  ['merge_conflict_resolved', { state: 'clean' }, 'queued'],
  ['review_comment_created', { actor: 'codex[bot]', commentId: '4242' }, 'queued'],
  ['comment_polled', { actor: 'alice', commentId: '101' }, 'queued'],
  ['polled', { actor: 'alice', state: 'open' }, 'queued'],
  ['reaction_added', { actor: 'alice', body: '+1' }, 'queued'],
  ['check_cancelled', { checkName: 'CI', conclusion: 'cancelled' }, 'queued'],
  ['check_skipped', { checkName: 'CI', conclusion: 'skipped' }, 'queued'],
  ['suite_failed', { conclusion: 'failure' }, 'queued'],
  ['thread_resolved', { actor: 'alice', threadId: 'PRRT_1' }, 'queued'],
  ['status_failure', { actor: 'alice', state: 'failure' }, 'queued'],
  ['made_up_suffix', { actor: 'alice' }, 'queued'],
];

describe('classifyUrgency — decision table', () => {
  for (const [suffix, overrides, expected] of DECISION_TABLE) {
    const spec = Object.entries(overrides)
      .map(([field, value]) => `${field}=${String(value)}`)
      .join(' ');
    it(`${suffix}${spec ? ` ${spec}` : ''} → ${expected}`, () => {
      const event = publishedEvent(`${PR_TOPIC}.${suffix}`, overrides);
      expect(classifyUrgency(event)).toBe(expected);
    });
  }

  it('topic without a suffix dot → queued', () => {
    const event = publishedEvent('weird-topic-without-suffix', { actor: 'alice' });
    expect(classifyUrgency(event)).toBe('queued');
  });

  it('non-string payload fields are never verdicts, bot logins, or conclusions', () => {
    const numericState = publishedEvent(`${PR_TOPIC}.review_submitted`, {
      actor: 'reviewer',
      state: 42,
    });
    expect(classifyUrgency(numericState)).toBe('queued');

    const objectActor = publishedEvent(`${PR_TOPIC}.review_comment_polled`, {
      actor: { login: 'codex[bot]' },
      commentId: '4242',
    });
    expect(classifyUrgency(objectActor)).toBe('queued');
  });
});
