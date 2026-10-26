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
  test('unattributed low-budget summaries do not starve targets across reopening', () =>
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
      expect(reads).toEqual(Array.from({ length: 4 }, () => repos).flat());
      expect(ledger.health.read(repos[1])).toMatchObject({
        attemptedAt: 300,
        completeAt: 300,
        misses: 0,
        reason: 'complete',
        incident: null,
      });
    }));
  test('unscoped retry evidence records actual attempts without suppressing a fresh reader', () =>
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
        attemptedAt: 100,
        misses: 1,
        nextRetryAt: 1000,
        reason: 'failed',
      });
      const reads: string[] = [];
      const read = async (repo: string) => {
        reads.push(repo);
        return response(repo);
      };
      await reconcileCodingPrLedger(new CodingPrLedgerRepository(db), repos, read, 200);
      expect(reads).toEqual(repos);
      expect(ledger.health.read(repos[0])).toMatchObject({
        attemptedAt: 200,
        misses: 0,
        reason: 'complete',
      });
      reads.length = 0;
      await reconcileCodingPrLedger(ledger, repos, read, 1000);
      expect(reads).toEqual(repos);
      expect(repos.map((repo) => ledger.health.read(repo)?.completeAt)).toEqual([1000, 1000]);
    }));
  test('summary resets without response attribution never invent shared cooldowns', () =>
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
        nextRetryAt: null,
      });
      expect(ledger.health.read(repos[1])).toMatchObject({
        misses: 0,
        reason: 'complete',
        nextRetryAt: null,
      });
      for (const [i, reset] of ['invalid', new Date(1000).toISOString()].entries()) {
        await reconcileCodingPrLedger(
          ledger,
          repos,
          async (repo) => response(repo, 499, false, reset),
          2000 + i
        );
        expect(ledger.health.read(repos[1])).toMatchObject({
          reason: 'complete',
          misses: 0,
          nextRetryAt: null,
        });
      }
    }));
  test('partial coverage without credential attribution cannot halt unrelated targets', () =>
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
      expect(reads).toEqual(repos);
      expect(ledger.health.read(repos[0])).toMatchObject({ reason: 'partial', nextRetryAt: null });
      expect(ledger.health.read(repos[1])).toMatchObject({ reason: 'partial', misses: 1 });
    }));
});
