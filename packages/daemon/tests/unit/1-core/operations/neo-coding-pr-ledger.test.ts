import { describe, expect, test } from 'bun:test';
import {
  CODING_LEDGER_KEEP_MS,
  CodingPrLedgerRepository,
  codingPrState,
  planCodingLedgerRead,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const node = (
  number: number,
  more: Record<string, unknown> = {},
  ci: string | null = 'SUCCESS'
) => ({
  number,
  title: `PR ${number}`,
  headRefName: `b${number}`,
  headRefOid: `h${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  closedAt: null,
  commits: { nodes: [{ commit: { statusCheckRollup: ci ? { state: ci } : null } }] },
  ...more,
});

const response = (
  open: unknown[],
  done: unknown[] = [],
  more = { remaining: 4000, next: false }
) => ({
  data: {
    rateLimit: { remaining: more.remaining },
    repository: {
      open: { pageInfo: { hasNextPage: more.next }, nodes: open },
      done: { nodes: done },
    },
  },
});

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  createCodingPackTables(db);
  return { db, ledger: new CodingPrLedgerRepository(db) };
}

describe('codingPrState', () => {
  test('reads each PR into one ledger state', () => {
    const state = (more: Record<string, unknown>, ci: string | null = 'SUCCESS') =>
      codingPrState(node(1, more, ci) as never);
    expect(state({ state: 'MERGED' })).toBe('merged');
    expect(state({ state: 'CLOSED' })).toBe('closed');
    expect(state({ isDraft: true })).toBe('draft');
    expect(state({ mergeable: 'CONFLICTING', reviewDecision: 'APPROVED' })).toBe('dirty');
    expect(state({ reviewDecision: 'APPROVED' }, 'FAILURE')).toBe('failing');
    expect(state({ reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes_requested');
    expect(state({ reviewDecision: 'APPROVED' })).toBe('approved_green');
    expect(state({ reviewDecision: 'APPROVED' }, null)).toBe('approved_green');
    expect(state({ reviewDecision: 'APPROVED' }, 'PENDING')).toBe('approved_pending');
    expect(state({ reviewDecision: 'REVIEW_REQUIRED' }, 'PENDING')).toBe('waiting_review');
  });
});

describe('planCodingLedgerRead', () => {
  test('keeps open PRs and ones closed within 7 days, and refuses partial reads', () => {
    const now = 10 * CODING_LEDGER_KEEP_MS;
    const recent = new Date(now - 60_000).toISOString();
    const old = new Date(now - CODING_LEDGER_KEEP_MS - 1).toISOString();
    const planned = planCodingLedgerRead(
      'lsm/hyperneo',
      response(
        [node(1)],
        [
          node(2, { state: 'MERGED', closedAt: recent }),
          node(3, { state: 'CLOSED', closedAt: old }),
        ]
      ),
      now
    );
    expect(planned?.rows.map((row) => [row.number, row.state])).toEqual([
      [1, 'waiting_review'],
      [2, 'merged'],
    ]);
    expect(planned?.remaining).toBe(4000);
    expect(
      planCodingLedgerRead('r/x', response([node(1)], [], { remaining: 4000, next: true }), now)
    ).toBeNull();
    expect(
      planCodingLedgerRead('r/x', { ...response([node(1)]), errors: [{ message: 'x' }] }, now)
    ).toBeNull();
    expect(planCodingLedgerRead('r/x', null, now)).toBeNull();
  });
});

describe('reconcileCodingPrLedger', () => {
  test('lists every open PR across repos and moves state_since only on a state or head change', async () => {
    const { db, ledger } = setup();
    let second = [node(7)];
    const read = async (repo: string) =>
      repo === 'lsm/hyperneo' ? response([node(1), node(2, { isDraft: true })]) : response(second);
    await reconcileCodingPrLedger(ledger, ['lsm/hyperneo', 'lsm/neo-ios'], read, 100);
    expect(ledger.list().map((row) => [row.repo, row.number, row.state, row.stateSince])).toEqual([
      ['lsm/hyperneo', 1, 'waiting_review', 100],
      ['lsm/hyperneo', 2, 'draft', 100],
      ['lsm/neo-ios', 7, 'waiting_review', 100],
    ]);
    db.exec('UPDATE pack_coding_pr_ledger SET nudges = 2');
    await reconcileCodingPrLedger(ledger, ['lsm/hyperneo', 'lsm/neo-ios'], read, 200);
    second = [node(7, { headRefOid: 'pushed' })];
    await reconcileCodingPrLedger(ledger, ['lsm/hyperneo', 'lsm/neo-ios'], read, 300);
    const rows = db
      .prepare(
        'SELECT number, state_since AS since, nudges, read_at AS readAt FROM pack_coding_pr_ledger ORDER BY number'
      )
      .all();
    expect(rows).toEqual([
      { number: 1, since: 100, nudges: 2, readAt: 300 },
      { number: 2, since: 100, nudges: 2, readAt: 300 },
      { number: 7, since: 300, nudges: 0, readAt: 300 },
    ]);
    db.close();
  });

  test('a failed or partial read leaves the rows untouched, and a low rate limit ends the cycle', async () => {
    const { db, ledger } = setup();
    await reconcileCodingPrLedger(ledger, ['a/a'], async () => response([node(1)]), 100);
    const reads: string[] = [];
    await reconcileCodingPrLedger(
      ledger,
      ['a/a', 'b/b', 'c/c'],
      async (repo) => {
        reads.push(repo);
        if (repo === 'a/a') return null;
        return response([node(2)], [], { remaining: 499, next: false });
      },
      200
    );
    expect(reads).toEqual(['a/a', 'b/b']);
    expect(ledger.list().map((row) => [row.repo, row.number, row.readAt])).toEqual([
      ['a/a', 1, 100],
      ['b/b', 2, 200],
    ]);
    db.close();
  });

  test('drops rows closed more than 7 days ago', async () => {
    const { db, ledger } = setup();
    const closedAt = new Date(1_000).toISOString();
    await reconcileCodingPrLedger(
      ledger,
      ['a/a'],
      async () => response([], [node(1, { state: 'MERGED', closedAt })]),
      2_000
    );
    expect(ledger.list()).toHaveLength(1);
    await reconcileCodingPrLedger(
      ledger,
      ['a/a'],
      async () => null,
      1_000 + CODING_LEDGER_KEEP_MS + 1
    );
    expect(ledger.list()).toEqual([]);
    db.close();
  });
});
