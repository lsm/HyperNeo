import { describe, expect, test } from 'bun:test';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const response = (repo: string) => ({
  data: {
    rateLimit: { remaining: 4000 },
    repository: {
      nameWithOwner: repo,
      open: { pageInfo: { hasNextPage: false }, nodes: [] },
      done: { nodes: [] },
    },
  },
});
async function using(run: (ledger: CodingPrLedgerRepository) => Promise<void>) {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  createCodingPackTables(db);
  try {
    await run(new CodingPrLedgerRepository(db));
  } finally {
    db.close();
  }
}
describe('ledger target fairness', () => {
  test('successful empty targets get a durable place in the scan order', () =>
    using(async (ledger) => {
      await reconcileCodingPrLedger(ledger, ['synthetic/old'], async (repo) => response(repo), 100);
      await reconcileCodingPrLedger(
        ledger,
        ['synthetic/empty'],
        async (repo) => response(repo),
        200
      );
      const order: string[] = [];
      await reconcileCodingPrLedger(
        ledger,
        ['synthetic/empty', 'synthetic/old'],
        async (repo) => {
          order.push(repo);
          return response(repo);
        },
        300
      );
      expect(order).toEqual(['synthetic/old', 'synthetic/empty']);
      expect(ledger.list()).toEqual([]);
    }));
  test('aliased targets use their canonical health timestamp in the scan order', () =>
    using(async (ledger) => {
      const alias = 'synthetic/old',
        canonical = 'synthetic/renamed',
        other = 'synthetic/other';
      ledger.recordAlias(alias, canonical);
      ledger.recordHealth(alias, { at: 200, outcome: 'complete' });
      ledger.recordHealth(other, { at: 100, outcome: 'complete' });
      const order: string[] = [];
      await reconcileCodingPrLedger(
        ledger,
        [alias, other],
        async (repo) => {
          order.push(repo);
          return response(repo === alias ? canonical : repo);
        },
        300
      );
      expect(order).toEqual([other, alias]);
    }));
  test('an unattributed failure does not put another credential in cooldown', () =>
    using(async (ledger) => {
      const order: string[] = [];
      await reconcileCodingPrLedger(
        ledger,
        ['synthetic/limited', 'synthetic/healthy'],
        async (repo) => {
          order.push(repo);
          return repo.endsWith('limited') ? { error: 'HTTP 429', retryAt: 1000 } : response(repo);
        },
        100
      );
      expect(order).toEqual(['synthetic/limited', 'synthetic/healthy']);
      expect(ledger.health.read('synthetic/healthy')).toMatchObject({
        reason: 'complete',
        misses: 0,
        completeAt: 100,
      });
    }));
  test('legacy unscoped cooldowns cannot block fresh credential observations', () =>
    using(async (ledger) => {
      for (const repo of ['synthetic/first', 'synthetic/second'])
        ledger.recordHealth(repo, { at: 100, outcome: 'cooldown', retryAt: 10000 });
      const order: string[] = [];
      await reconcileCodingPrLedger(
        ledger,
        ['synthetic/first', 'synthetic/second'],
        async (repo) => {
          order.push(repo);
          return response(repo);
        },
        200
      );
      expect(order).toEqual(['synthetic/first', 'synthetic/second']);
      expect(ledger.health.read('synthetic/second')?.reason).toBe('complete');
    }));
});
