import { describe, expect, test } from 'bun:test';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const repos = ['synthetic/first', 'synthetic/tail'];
const response = (repo: string, remaining = 4000, next = false, resetAt?: string) => ({
  data: {
    rateLimit: { remaining, resetAt },
    repository: {
      nameWithOwner: repo,
      open: { pageInfo: { hasNextPage: next }, nodes: [] },
      done: { nodes: [] },
    },
  },
});
async function using(run: (db: Database, ledger: CodingPrLedgerRepository) => Promise<void>) {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  createCodingPackTables(db);
  try {
    await run(db, new CodingPrLedgerRepository(db));
  } finally {
    db.close();
  }
}

describe('ledger reconciliation health', () => {
  for (const [label, raw, reason] of [
    ['empty', response(repos[0]), 'complete'],
    ['partial', response(repos[0], 4000, true), 'partial'],
    ['failed', { error: 'synthetic unavailable' }, 'failed'],
    ['unreadable', null, 'failed'],
  ] as const)
    test(`records ${label} coverage without inventing PR rows`, () =>
      using(async (_db, ledger) => {
        await reconcileCodingPrLedger(ledger, [repos[0]], async () => raw, 0);
        expect(ledger.health.read(repos[0])).toMatchObject({
          cycleAt: 0,
          attemptedAt: 0,
          completeAt: reason === 'complete' ? 0 : null,
          misses: reason === 'complete' ? 0 : 1,
          reason,
        });
        expect(ledger.list()).toEqual([]);
      }));
  test('stale approved-pending snapshots retain acquisition diagnostics and raise one notice through cooldown', () =>
    using(async (db, ledger) => {
      const start = 10_000_000,
        stale = start + 15 * 60_000,
        reset = stale + 60_000;
      ledger.replace(
        repos[0],
        [
          {
            repo: repos[0],
            number: 1,
            title: 'Ready after CI',
            branch: 'topic',
            head: 'approved-head',
            state: 'approved_pending',
            closedAt: null,
          },
        ],
        start
      );
      ledger.recordHealth(repos[0], { at: start, outcome: 'complete' });
      await reconcileCodingPrLedger(
        ledger,
        repos,
        async () => ({ error: 'HTTP 429 token=synthetic-do-not-persist', retryAt: reset }),
        stale
      );
      const snapshot = ledger.snapshot(null, stale)[0];
      expect(snapshot).toMatchObject({
        readAt: start,
        completeAt: start,
        nextRetryAt: reset,
        lastError: 'rate_limited',
        lastErrorAt: stale,
      });
      const notices = ledger.health.read(repos[0])?.notices ?? [];
      expect(notices).toHaveLength(1);
      expect(notices[0].text).toContain('approved_pending');
      expect(notices[0].text).toContain('readAt=');
      expect(JSON.stringify(ledger.health.read(repos[0]))).not.toContain(
        'synthetic-do-not-persist'
      );
      await reconcileCodingPrLedger(
        new CodingPrLedgerRepository(db),
        repos,
        async () => {
          throw new Error('cooldown must not read');
        },
        stale + 1
      );
      expect(ledger.health.read(repos[0])?.notices).toEqual(notices);
      expect(ledger.snapshot(null, stale + 1)[0]).toMatchObject({
        readAt: start,
        completeAt: start,
        nextRetryAt: reset,
        lastError: 'rate_limited',
        lastErrorAt: stale,
      });
    }));
  test('unreached misses survive reopening and duplicate cycles without changing fetch order', () =>
    using(async (db, ledger) => {
      const reads: string[] = [];
      for (const at of [100, 200, 300, 300]) {
        await reconcileCodingPrLedger(
          new CodingPrLedgerRepository(db),
          repos,
          async (repo) => {
            reads.push(repo);
            return response(repo, 499);
          },
          at
        );
      }
      expect(reads).toEqual(Array(4).fill(repos[0]));
      expect(ledger.health.read(repos[1])).toMatchObject({
        attemptedAt: null,
        completeAt: null,
        misses: 3,
        reason: 'not_reached',
        incident: { key: 'github-health:synthetic/tail:100', raisedAt: 300, resolvedAt: null },
      });
    }));
  test('rate-limit retry evidence persists with the attempted failure and excludes cooldown misses', () =>
    using(async (db, ledger) => {
      await reconcileCodingPrLedger(
        ledger,
        repos,
        async () => ({ error: 'HTTP 429', retryAt: 1000 }),
        100
      );
      expect(ledger.health.read(repos[0])).toMatchObject({
        attemptedAt: 100,
        misses: 1,
        nextRetryAt: 1000,
        reason: 'failed',
      });
      expect(ledger.health.read(repos[1])).toMatchObject({
        attemptedAt: null,
        misses: 0,
        nextRetryAt: 1000,
        reason: 'cooldown',
      });
      const reads: string[] = [];
      const read = async (repo: string) => {
        reads.push(repo);
        return response(repo);
      };
      await reconcileCodingPrLedger(new CodingPrLedgerRepository(db), repos, read, 200);
      expect(reads).toEqual([]);
      expect(ledger.health.read(repos[0])).toMatchObject({
        attemptedAt: 100,
        misses: 1,
        reason: 'cooldown',
      });
      await reconcileCodingPrLedger(ledger, repos, read, 1000);
      expect(reads).toEqual(repos);
      expect(repos.map((repo) => ledger.health.read(repo)?.completeAt)).toEqual([1000, 1000]);
    }));
  test('low-budget complete coverage retains reset evidence; expired or invalid reset never invents cooldown', () =>
    using(async (_db, ledger) => {
      await reconcileCodingPrLedger(
        ledger,
        repos,
        async (repo) => response(repo, 499, false, new Date(1000).toISOString()),
        100
      );
      expect(ledger.health.read(repos[0])).toMatchObject({
        completeAt: 100,
        misses: 0,
        nextRetryAt: 1000,
      });
      expect(ledger.health.read(repos[1])).toMatchObject({
        misses: 0,
        reason: 'cooldown',
        nextRetryAt: 1000,
      });
      for (const [i, reset] of ['invalid', new Date(1000).toISOString()].entries()) {
        await reconcileCodingPrLedger(
          ledger,
          repos,
          async (repo) => response(repo, 499, false, reset),
          2000 + i
        );
        expect(ledger.health.read(repos[1])).toMatchObject({
          reason: 'not_reached',
          misses: 1 + i,
          nextRetryAt: null,
        });
      }
    }));
  test('partial coverage still honors explicit exhausted-budget reset evidence', () =>
    using(async (_db, ledger) => {
      const reads: string[] = [];
      await reconcileCodingPrLedger(
        ledger,
        repos,
        async (repo) => {
          reads.push(repo);
          return response(repo, 499, true, new Date(1000).toISOString());
        },
        100
      );
      expect(reads).toEqual([repos[0]]);
      expect(ledger.health.read(repos[0])).toMatchObject({ reason: 'partial', nextRetryAt: 1000 });
      expect(ledger.health.read(repos[1])).toMatchObject({ reason: 'cooldown', misses: 0 });
    }));
});
