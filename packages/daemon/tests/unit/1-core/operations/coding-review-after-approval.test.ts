import { describe, expect, test } from 'bun:test';
import type { NeoAttentionEvent } from '../../../../src/lib/neo/attention/decide.ts';
import { CODING_ATTENTION_KINDS } from '../../../../src/lib/neo/packs/coding/attention.ts';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { deliverCodingReviewAfterApproval } from '../../../../src/lib/neo/packs/coding/review-after-approval.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CODING_REVIEW_AFTER_PREFERENCE } from '../../../../src/lib/neo/packs/coding/stage-preferences.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const merged = (head: string) => ({
  ...pr(head),
  state: 'MERGED',
  closedAt: '2026-01-01T00:00:00Z',
  mergedAt: '2026-01-01T00:00:00Z',
});
const pr = (head: string, title = 'PR 1') => ({
  number: 1,
  title,
  headRefName: 'b1',
  headRefOid: head,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  reviews: { nodes: [{ state: 'APPROVED', commit: { oid: head }, author: { login: 'bot' } }] },
  closedAt: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
});
const response = (node: unknown, done: unknown[] = []) => ({
  data: {
    rateLimit: { remaining: 4000 },
    repository: {
      nameWithOwner: 'lsm/a',
      open: { pageInfo: { hasNextPage: false }, nodes: node ? [node] : [] },
      done: { nodes: done },
    },
  },
});

function setup(preferences: Record<string, unknown>) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db, 0);
  for (const [key, value] of Object.entries({
    mergePolicy: 'review_bot',
    reviewBot: 'bot',
    ...preferences,
  }))
    db.prepare(`INSERT INTO neo_pack_preferences VALUES (?, ?, ?, ?, ?, 'human', 1)`).run(
      'coding',
      'repo',
      'lsm/a',
      key,
      JSON.stringify(value)
    );
  const ledger = new CodingPrLedgerRepository(db);
  const attended: NeoAttentionEvent[] = [];
  let answer: () => Promise<boolean> = async () => true;
  const sweep = async (node: unknown, now: number, done: unknown[] = []) => {
    await reconcileCodingPrLedger(ledger, ['lsm/a'], async () => response(node, done), now);
    await deliverCodingReviewAfterApproval(
      db,
      'github.com',
      async (event) => {
        attended.push(event);
        return answer();
      },
      now
    );
  };
  return { db, attended, sweep, fail: (next: () => Promise<boolean>) => (answer = next) };
}

describe('review after approval', () => {
  test.each([false, true])(
    'a first-seen approved head wakes Neo once per head (crossModelReview %p)',
    async (crossModelReview) => {
      const { db, attended, sweep } = setup({ 'review.after': 'approved', crossModelReview });
      try {
        await sweep(pr('heada'), 100);
        await sweep(pr('heada', 'Renamed'), 200);
        await sweep(pr('headb'), 300);
        expect(attended.map((event) => event.subject.id)).toEqual([
          'https://github.com/lsm/a/pull/1@heada',
          'https://github.com/lsm/a/pull/1@headb',
        ]);
        expect(attended[0].kind).toBe('coding.review_after_approval');
        expect(String(attended[0].facts.text)).toContain('named.workKind "coding.review"');
        expect(
          CODING_ATTENTION_KINDS.find((kind) => kind.id === attended[0].kind)?.decide(attended[0], {
            covered: false,
            latestReportAt: null,
          })
        ).toBe('wake');
      } finally {
        db.close();
      }
    }
  );

  test('a failed or thrown wake is retried on the next sweep', async () => {
    const { db, attended, sweep, fail } = setup({ 'review.after': 'approved' });
    try {
      fail(async () => false);
      await sweep(pr('heada'), 100);
      fail(async () => {
        throw new Error('queue failed');
      });
      await sweep(pr('heada'), 200);
      fail(async () => true);
      await sweep(pr('heada'), 300);
      await sweep(pr('heada'), 400);
      expect(attended).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test('a head observed approved is still told after the PR merges', async () => {
    const { db, attended, sweep, fail } = setup({ 'review.after': 'approved', mergeBy: 'daemon' });
    try {
      fail(async () => false);
      await sweep(pr('heada'), 100);
      fail(async () => true);
      await sweep(null, 200, [merged('heada')]);
      await sweep(null, 300, [merged('heada')]);
      expect(attended.map((event) => event.subject.id)).toEqual([
        'https://github.com/lsm/a/pull/1@heada',
        'https://github.com/lsm/a/pull/1@heada',
      ]);
    } finally {
      db.close();
    }
  });

  test('without the preference nothing is started', async () => {
    for (const preferences of [{}, { 'review.after': 'never' }]) {
      const { db, attended, sweep } = setup(preferences);
      try {
        await sweep(pr('heada'), 100);
        expect(attended).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  test('the preference is a repository enum that defaults to never', () => {
    expect(CODING_REVIEW_AFTER_PREFERENCE).toMatchObject({
      scope: 'repo',
      type: { kind: 'enum', values: ['never', 'approved'] },
      default: 'never',
    });
  });
});
