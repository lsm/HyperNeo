import { describe, expect, test } from 'bun:test';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const ship = Date.now();
const pr = (number: number, more: Record<string, unknown> = {}) => ({
  number,
  title: `Synthetic PR ${number}`,
  headRefName: `b${number}`,
  headRefOid: `h${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  closedAt: null,
  createdAt: new Date(ship + 60_000).toISOString(),
  author: { login: 'synthetic', __typename: 'User' },
  ...more,
});

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const wakes: { key: string; text: string }[] = [];
  let accepted = true;
  let nodes: unknown[] = [];
  const makePack = () =>
    createCodingPack({
      readPrs: async () => [],
      readClaudeOwners: async () => [],
      todoPrs: new CodingTodoPrRepository(db),
      prLedger: ledger,
      prEvents: new CodingPrEventRepository(db),
      prSweep: new CodingPrSweepRepository(db),
      projectRepos: () => ['synthetic/a', 'synthetic/b'],
      readLedgerRepo: async (repo) => ({
        data: {
          rateLimit: { remaining: 4000 },
          repository: {
            nameWithOwner: repo,
            open: { pageInfo: { hasNextPage: false }, nodes },
            done: { nodes: [] },
          },
        },
      }),
      prSweepDeps: {
        tell: async () => true,
        wake: async (key, text) => {
          wakes.push({ key, text });
          return accepted;
        },
      },
    });
  let pack = makePack();
  return {
    db,
    ledger,
    wakes,
    accept: (value: boolean) => {
      accepted = value;
    },
    restart: () => {
      createCodingPackTables(db);
      pack = makePack();
    },
    cycle: async (rows: unknown[], now = ship + 120_000) => {
      nodes = rows;
      await pack.sweep!(now);
    },
  };
}

describe('coding pack newly unowned PR notifications', () => {
  test('one reconcile wakes Neo once with all new human PRs across repos, never the old backlog', async () => {
    const { db, wakes, cycle } = setup();
    try {
      await cycle([
        pr(1),
        pr(2),
        pr(3, { isDraft: true }),
        pr(4, { author: { login: 'synthetic-bot', __typename: 'Bot' } }),
        pr(5, { createdAt: new Date(ship - 60_000).toISOString() }),
        pr(6, { author: null }),
        pr(7, { createdAt: null }),
      ]);
      expect(wakes).toHaveLength(1);
      for (const repo of ['synthetic/a', 'synthetic/b']) {
        expect(wakes[0].text).toContain(`${repo}#1`);
        expect(wakes[0].text).toContain(`${repo}#2`);
        for (const n of [3, 4, 5, 6, 7]) expect(wakes[0].text).not.toContain(`${repo}#${n}`);
      }
      await cycle([pr(1), pr(2)], ship + 180_000);
      expect(wakes).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('a known owner is not announced, and each PR is listed once through restart, head change and pruning', async () => {
    const { db, ledger, wakes, cycle, restart } = setup();
    try {
      ledger.observeSessions(
        [
          {
            ref: { adapter: 'codex-desktop', id: 'owner' },
            status: 'running',
            lastActivityAt: ship,
            remotes: [],
            branches: [],
            openedPrs: [],
            linkedPrs: [{ url: 'https://github.com/synthetic/a/pull/1', own: true }],
          },
        ],
        ship
      );
      await cycle([pr(1)]);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].text).not.toContain('synthetic/a#1');
      expect(wakes[0].text).toContain('synthetic/b#1');
      restart();
      await cycle([pr(1, { headRefOid: 'pushed' })], ship + 180_000);
      expect(wakes).toHaveLength(1);
      ledger.dropRepo('synthetic/b');
      await cycle([pr(1)], ship + 240_000);
      expect(wakes).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('drafts become eligible later, with no repeat on later state changes', async () => {
    const { db, wakes, cycle } = setup();
    try {
      await cycle([pr(1, { isDraft: true })]);
      expect(wakes).toEqual([]);
      await cycle([pr(1)], ship + 180_000);
      expect(wakes).toHaveLength(1);
      await cycle([pr(1, { reviewDecision: 'APPROVED' })], ship + 240_000);
      expect(wakes).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('failed handoff survives restart with the same batch identity; new arrivals wait for the next wake', async () => {
    const { db, wakes, cycle, accept, restart } = setup();
    try {
      accept(false);
      await cycle([pr(1)]);
      expect(wakes).toHaveLength(1);
      const pending = wakes[0];
      restart();
      accept(true);
      await cycle([pr(1), pr(2)], ship + 180_000);
      expect(wakes).toHaveLength(2);
      expect(wakes[1]).toEqual(pending);
      await cycle([pr(1), pr(2)], ship + 240_000);
      expect(wakes).toHaveLength(3);
      expect(wakes[2].text).toContain('synthetic/a#2');
      expect(wakes[2].text).not.toContain('synthetic/a#1');
      await cycle([pr(1), pr(2)], ship + 300_000);
      expect(wakes).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
