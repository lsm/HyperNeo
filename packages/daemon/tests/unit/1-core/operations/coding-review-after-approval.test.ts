import { describe, expect, test } from 'bun:test';
import type { NeoAttentionEvent } from '../../../../src/lib/neo/attention/decide.ts';
import { CODING_ATTENTION_KINDS } from '../../../../src/lib/neo/packs/coding/attention.ts';
import {
  CodingPrEventRepository,
  deliverCodingPrEvents,
} from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CODING_REVIEW_AFTER_PREFERENCE } from '../../../../src/lib/neo/packs/coding/stage-preferences.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const pr = (ci: string) => ({
  number: 1,
  title: 'PR 1',
  headRefName: 'b1',
  headRefOid: 'head1abc',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  reviews: {
    nodes: [{ state: 'APPROVED', commit: { oid: 'head1abc' }, author: { login: 'bot' } }],
  },
  closedAt: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
});
const response = (ci: string) => ({
  data: {
    rateLimit: { remaining: 4000 },
    repository: {
      nameWithOwner: 'lsm/a',
      open: { pageInfo: { hasNextPage: false }, nodes: [pr(ci)] },
      done: { nodes: [] },
    },
  },
});

async function run(preferences: Record<string, unknown>) {
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
  const events = new CodingPrEventRepository(db);
  const attended: NeoAttentionEvent[] = [];
  const deps = { host: 'github.com', tell: async () => true, wake: async () => true };
  const attend = async (event: NeoAttentionEvent) => {
    attended.push(event);
    return true;
  };
  for (const [ci, now] of [
    ['PENDING', 100],
    ['SUCCESS', 200],
    ['SUCCESS', 300],
  ] as const)
    await deliverCodingPrEvents(
      events,
      await reconcileCodingPrLedger(ledger, ['lsm/a'], async () => response(ci), now),
      deps as never,
      attend
    );
  db.close();
  return attended;
}

describe('review after approval', () => {
  test('an approved green head wakes Neo once to start a coding.review worker', async () => {
    const attended = await run({ 'review.after': 'approved', mergeBy: 'daemon' });
    expect(attended).toHaveLength(1);
    expect(attended[0]).toMatchObject({
      kind: 'coding.review_after_approval',
      subject: { type: 'pr_head', id: 'https://github.com/lsm/a/pull/1@head1abc' },
    });
    expect(String(attended[0].facts.text)).toContain('named.workKind "coding.review"');
    expect(
      CODING_ATTENTION_KINDS.find((kind) => kind.id === attended[0].kind)?.decide(attended[0], {
        covered: false,
        latestReportAt: null,
      })
    ).toBe('wake');
  });

  test('without the preference nothing is started', async () => {
    expect(await run({})).toEqual([]);
    expect(await run({ 'review.after': 'never' })).toEqual([]);
  });

  test('the preference is a repository enum that defaults to never', () => {
    expect(CODING_REVIEW_AFTER_PREFERENCE).toMatchObject({
      scope: 'repo',
      type: { kind: 'enum', values: ['never', 'approved'] },
      default: 'never',
    });
  });
});
