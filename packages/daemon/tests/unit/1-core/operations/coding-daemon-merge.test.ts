import { describe, expect, test } from 'bun:test';
import {
  decideCodingDaemonMerge,
  type CodingDaemonMergeFacts,
} from '../../../../src/lib/neo/packs/coding/daemon-merge-gates.ts';

const head = 'a'.repeat(40);
const facts: CodingDaemonMergeFacts = {
  ok: true,
  head,
  state: 'OPEN',
  draft: false,
  mergeable: 'MERGEABLE',
  passingCommitStatus: true,
  requiredCi: { count: 1, head, green: true },
  threads: { head, unresolved: 0 },
  reviews: [{ login: 'hyperneo-ai-test', head, state: 'APPROVED' }],
  files: ['src/app.ts'],
  labels: [],
};
const policy = {
  mergeBy: 'daemon',
  mergePolicy: 'review_bot',
  reviewBot: 'hyperneo-ai-test',
  humanSignoff: [],
} as const;

describe('decideCodingDaemonMerge', () => {
  test('identifies unresolved threads when GitHub reports the merge blocked', () => {
    expect(
      decideCodingDaemonMerge(
        { ...facts, passingCommitStatus: false, threads: { head, unresolved: 1 } },
        policy
      )
    ).toEqual({ kind: 'skip', reason: 'review_threads_unresolved_or_stale' });
  });
  test('admits an unowned PR without a todo or Review/Verify assignments', () => {
    expect(decideCodingDaemonMerge(facts, policy)).toEqual({ kind: 'merge', head });
  });
  test('defaults merging to the owner and never mutates preferences or facts', () => {
    const before = JSON.stringify({ facts, policy });
    expect(decideCodingDaemonMerge(facts, { ...policy, mergeBy: undefined })).toEqual({
      kind: 'skip',
      reason: 'merge_by_owner',
    });
    expect(JSON.stringify({ facts, policy })).toBe(before);
  });
  test.each([
    { state: 'CLOSED' },
    { draft: true },
    { mergeable: 'CONFLICTING' },
    { passingCommitStatus: false, requiredCi: { count: 0, head, green: true } },
    { requiredCi: { count: 1, head, green: false } },
    { requiredCi: { count: 1, head: 'b'.repeat(40), green: true } },
    { threads: { head, unresolved: 1 } },
    { threads: { head: 'b'.repeat(40), unresolved: 0 } },
    { reviews: [] },
    { reviews: [{ login: 'another-bot', head, state: 'APPROVED' }] },
    { reviews: [{ login: 'hyperneo-ai-test', head: 'b'.repeat(40), state: 'APPROVED' }] },
    {
      reviews: [...facts.reviews, { login: 'hyperneo-ai-test', head, state: 'CHANGES_REQUESTED' }],
    },
  ])('refuses unsafe PR facts %j', (change) => {
    expect(decideCodingDaemonMerge({ ...facts, ...change }, policy).kind).toBe('skip');
  });
  test('uses the latest substantive bot verdict and supports CI-only policy', () => {
    expect(
      decideCodingDaemonMerge(
        {
          ...facts,
          reviews: [...facts.reviews, { login: 'hyperneo-ai-test', head, state: 'COMMENTED' }],
        },
        policy
      ).kind
    ).toBe('merge');
    expect(
      decideCodingDaemonMerge({ ...facts, reviews: [] }, { ...policy, mergePolicy: 'ci_only' }).kind
    ).toBe('merge');
    expect(decideCodingDaemonMerge(facts, { ...policy, mergePolicy: 'human' }).kind).toBe(
      'needs_human_signoff'
    );
  });
  test.each(['label:human-*', 'human-merge'])('checks actual PR labels for %s', (pattern) => {
    const scoped = { ...policy, humanSignoff: [pattern] };
    expect(decideCodingDaemonMerge(facts, scoped).kind).toBe('merge');
    expect(decideCodingDaemonMerge({ ...facts, labels: ['human-merge'] }, scoped).kind).toBe(
      'needs_human_signoff'
    );
    expect(decideCodingDaemonMerge({ ...facts, labels: null }, scoped).kind).toBe('read_failure');
  });
  test.each(['README.md', '*.md'])('bare path %s still triggers daemon signoff', (pattern) => {
    const scoped = { ...policy, humanSignoff: [pattern] };
    expect(decideCodingDaemonMerge(facts, scoped).kind).toBe('merge');
    expect(
      decideCodingDaemonMerge({ ...facts, files: ['README.md'], labels: [] }, scoped).kind
    ).toBe('needs_human_signoff');
  });
  test('holds path matches and unreadable facts closed', () => {
    const scoped = { ...policy, humanSignoff: ['docs/design/**'] };
    expect(
      decideCodingDaemonMerge({ ...facts, files: ['docs/design/merge.md'] }, scoped).kind
    ).toBe('needs_human_signoff');
    expect(decideCodingDaemonMerge({ ...facts, files: null }, scoped).kind).toBe('read_failure');
    expect(decideCodingDaemonMerge({ ok: false, reason: 'GitHub unavailable' }, policy)).toEqual({
      kind: 'read_failure',
      reason: 'GitHub unavailable',
    });
    expect(decideCodingDaemonMerge({ ...facts, head: '' }, policy).kind).toBe('read_failure');
  });
});

test.each(['policy', 'label'])(
  'linked issue holds preserve the human-signoff cue (%s)',
  (scope) => {
    expect(
      decideCodingDaemonMerge(
        { ...facts, labels: ['human-merge'], linkedIssueReason: 'linked_issue_required: missing' },
        {
          ...policy,
          mergePolicy: scope === 'policy' ? 'human' : 'review_bot',
          humanSignoff: ['label:human-merge'],
        }
      ).kind
    ).toBe('needs_human_signoff');
  }
);

describe('decideCodingDaemonMerge cross-model review', () => {
  const crossPolicy = { ...policy, crossModelReview: true } as const;
  const review = (model: string) => ({
    url: 'https://github.com/lsm/hyperneo/pull/1',
    head,
    stage: 'review' as const,
    actor: { kind: 'agent' as const, id: 'reviewer', model, harness: 'Codex' },
    verdict: 'pass' as const,
    acceptanceContract: 'contract',
    evidence: ['ran it'],
  });
  const authored = { ...facts, body: 'Agent: claude-opus-5-5 (effort: medium) via Claude' };

  test('refuses a bot-approved green PR without a review by a different model', () => {
    expect(decideCodingDaemonMerge({ ...authored, stageFacts: [] }, crossPolicy)).toEqual({
      kind: 'skip',
      reason: 'cross_model_review_required',
    });
    expect(
      decideCodingDaemonMerge({ ...authored, stageFacts: [review('claude-opus-5-5')] }, crossPolicy)
        .kind
    ).toBe('skip');
  });

  test('merges once a different model has passed the head', () => {
    expect(
      decideCodingDaemonMerge({ ...authored, stageFacts: [review('gpt-6.1-sol')] }, crossPolicy)
    ).toEqual({ kind: 'merge', head });
  });
});

describe('decideCodingDaemonMerge cross-model review for CI-only repositories', () => {
  test('refuses a green CI-only PR without a review by a different model', () => {
    expect(
      decideCodingDaemonMerge(
        { ...facts, reviews: [], body: 'Agent: claude-opus-5-5 (effort: medium) via Claude' },
        { ...policy, mergePolicy: 'ci_only', crossModelReview: true }
      )
    ).toEqual({ kind: 'skip', reason: 'cross_model_review_required' });
  });
});

describe('decideCodingDaemonMerge cross-model review with human sign-off', () => {
  test('human sign-off still wins over a missing cross-model review', () => {
    const authored = { ...facts, body: 'Agent: claude-opus-5-5 (effort: medium) via Claude' };
    expect(
      decideCodingDaemonMerge(authored, { ...policy, mergePolicy: 'human', crossModelReview: true })
    ).toEqual({ kind: 'needs_human_signoff' });
    expect(
      decideCodingDaemonMerge(
        { ...authored, labels: ['human-merge'] },
        { ...policy, humanSignoff: ['label:human-merge'], crossModelReview: true }
      )
    ).toEqual({ kind: 'needs_human_signoff' });
  });
});
