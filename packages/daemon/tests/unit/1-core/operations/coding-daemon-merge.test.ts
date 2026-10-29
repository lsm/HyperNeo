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
  requiredCi: { head, green: true },
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
    { requiredCi: { head, green: false } },
    { requiredCi: { head: 'b'.repeat(40), green: true } },
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
