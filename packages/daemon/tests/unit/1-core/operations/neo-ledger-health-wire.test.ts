import { describe, expect, test } from 'bun:test';
import { initializeCodingWatches } from '../../../../src/lib/neo/packs/coding/watched-repos.ts';
import { deliverCodingHealth } from '../../../../src/lib/neo/packs/coding/health-delivery.ts';
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
  test('failed PR persistence cannot advance completed coverage', () =>
    using(async (db, ledger) => {
      await reconcileCodingPrLedger(ledger, [repos[0]], async () => response(repos[0]), 1);
      const before = ledger.health.read(repos[0]);
      const raw = response(repos[0]);
      const observed = {
        ...raw,
        data: {
          ...raw.data,
          repository: {
            ...raw.data.repository,
            open: {
              ...raw.data.repository.open,
              nodes: [
                {
                  number: 1,
                  title: 'Observed 甲🙂',
                  headRefName: 'topic',
                  headRefOid: 'new-head',
                  state: 'OPEN',
                  isDraft: false,
                  mergeable: 'MERGEABLE',
                  reviewDecision: null,
                  closedAt: null,
                },
              ],
            },
          },
        },
      };
      db.exec(
        "CREATE TRIGGER reject_poll_rows BEFORE INSERT ON pack_coding_pr_ledger BEGIN SELECT RAISE(ABORT,'synthetic observation rejection'); END"
      );
      await expect(
        reconcileCodingPrLedger(ledger, [repos[0]], async () => observed, 2)
      ).rejects.toThrow('synthetic observation rejection');
      expect(ledger.health.read(repos[0])).toEqual(before);
      expect(ledger.list()).toEqual([]);
    }));
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
        async () => ({
          error: 'HTTP 429 token=synthetic-do-not-persist',
          retryAt: reset,
          quota: {
            status: 429,
            resource: 'graphql',
            remaining: 0,
            resetAt: reset,
            requestId: 'synthetic',
            retryAfterMs: null,
            credentialBucket: 'synthetic:1',
            retryAt: reset,
          },
        }),
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
      expect(notices[0]).toMatchObject({
        pending: {
          number: 1,
          head: 'approved-head',
          readAt: start,
          completeAt: start,
          nextRetryAt: reset,
          lastError: 'rate_limited',
          lastErrorAt: stale,
        },
      });
      expect(notices[0].text).toContain('approved_pending');
      expect(notices[0].text).toContain('readAt=');
      expect(JSON.stringify(ledger.health.read(repos[0]))).not.toContain(
        'synthetic-do-not-persist'
      );
      await reconcileCodingPrLedger(
        new CodingPrLedgerRepository(db),
        repos,
        async (_repo, quota) => ({
          error: 'GitHub acquisition cooldown',
          retryAt: reset,
          quota: { ...quota!, deferred: true },
        }),
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
      ledger.acceptHealthNotice(repos[0], notices[0].key, stale + 2);
      await reconcileCodingPrLedger(ledger, repos, async (repo) => response(repo), reset);
      expect(ledger.health.read(repos[0])).toMatchObject({
        completeAt: reset,
        nextRetryAt: null,
        lastError: 'rate_limited',
        lastErrorAt: stale,
      });
      expect(ledger.health.read(repos[0])?.notices?.[0].pending).toEqual(notices[0].pending);
    }));
  test('an aliased target exposes canonical pending diagnostics and delivers one durable notice', () =>
    using(async (db, ledger) => {
      const alias = 'synthetic/old',
        canonical = 'synthetic/renamed';
      const start = 10_000_000,
        stale = start + 15 * 60_000,
        reset = stale + 60_000;
      initializeCodingWatches(db, [alias]);
      ledger.recordHealth(alias, { at: start, outcome: 'complete' });
      ledger.recordAlias(alias, canonical);
      ledger.replace(
        canonical,
        [
          {
            repo: canonical,
            number: 1,
            title: 'Renamed pending work',
            branch: 'topic',
            head: 'renamed-head',
            state: 'approved_pending',
            closedAt: null,
          },
        ],
        start
      );
      await reconcileCodingPrLedger(
        ledger,
        [alias.toUpperCase()],
        async () => ({ error: 'HTTP 429', retryAt: reset }),
        stale
      );
      expect(ledger.snapshot([alias], stale)[0]).toMatchObject({
        pr: `${canonical}#1`,
        readAt: start,
        completeAt: start,
        nextRetryAt: reset,
        lastError: 'rate_limited',
        lastErrorAt: stale,
      });
      const wakes: string[] = [];
      for (const instance of [ledger, new CodingPrLedgerRepository(db)])
        await deliverCodingHealth(
          instance,
          [alias],
          async (key) => {
            wakes.push(key);
            return true;
          },
          stale + 1
        );
      expect(wakes).toEqual([`github-pending:${canonical}#1:renamed-head:${start}`]);
      expect(ledger.health.read(alias)?.notices?.[0].acceptedAt).toBe(stale + 1);
      expect(ledger.health.read(canonical)).toEqual(ledger.health.read(alias));
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
