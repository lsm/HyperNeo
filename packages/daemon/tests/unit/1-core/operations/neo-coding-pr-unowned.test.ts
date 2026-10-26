import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wakeCodingUnownedPrs } from '../../../../src/lib/neo/packs/coding/pr-unowned.ts';
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
  createNeoPackPreferencesTable(db);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const wakes: { key: string; text: string }[] = [];
  let accepted = true;
  let partial = false;
  let nodes: unknown[] = [];
  const makePack = () =>
    createCodingPack({
      database: () => db,
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
            open: { pageInfo: { hasNextPage: partial }, nodes },
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
    partial: (value: boolean) => {
      partial = value;
    },
    accept: (value: boolean) => {
      accepted = value;
    },
    restart: () => {
      createNeoPackPreferencesTable(db);
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
      expect(db.prepare('SELECT key FROM pack_coding_pr_unowned ORDER BY key').all()).toEqual([
        { key: 'neo-pr-unowned:synthetic/a#1' },
        { key: 'neo-pr-unowned:synthetic/a#2' },
        { key: 'neo-pr-unowned:synthetic/b#1' },
        { key: 'neo-pr-unowned:synthetic/b#2' },
      ]);
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

  test('a partial read does not turn stale unowned rows into a new notification', async () => {
    const { db, wakes, cycle, partial } = setup();
    try {
      db.prepare(`INSERT INTO pack_coding_pr_ledger
        (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
        VALUES ('synthetic/a',1,'Stale','b','h','unreviewed',?,?,?,0)`).run(
        ship,
        ship,
        ship + 60_000
      );
      partial(true);
      await cycle([pr(1)]);
      expect(wakes).toEqual([]);
      partial(false);
      await cycle([pr(1)], ship + 180_000);
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

describe('coding pack unowned PR persistence', () => {
  test('the activation cutoff is strict and does not reset when schema is reapplied', async () => {
    const { db, wakes, cycle } = setup();
    try {
      const { activated_at: cutoff } = db
        .prepare('SELECT activated_at FROM pack_coding_pr_unowned_state')
        .get() as { activated_at: number };
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, cutoff + 600_000);
      expect(db.prepare('SELECT activated_at FROM pack_coding_pr_unowned_state').get()).toEqual({
        activated_at: cutoff,
      });
      await cycle([
        pr(1, { createdAt: new Date(cutoff).toISOString() }),
        pr(2, { createdAt: new Date(cutoff + 1).toISOString() }),
      ]);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].text).not.toContain('synthetic/a#1 ');
      expect(wakes[0].text).toContain('synthetic/a#2 ');
    } finally {
      db.close();
    }
  });

  test('a pending notice and once-only keys survive closing and reopening the database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-unowned-persistence-'));
    const path = join(root, 'synthetic.db');
    let db = new Database(path);
    try {
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, 10);
      db.prepare(`INSERT INTO pack_coding_pr_ledger (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
        VALUES ('synthetic/a',1,'Synthetic','b','h','unreviewed',20,20,11,0)`).run();
      const pending = new CodingPrEventRepository(db).pendingUnowned(20);
      expect(pending?.text).toContain('synthetic/a#1');
      db.close();
      db = new Database(path);
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, 30);
      const repo = new CodingPrEventRepository(db);
      const sent: unknown[] = [];
      await wakeCodingUnownedPrs(
        repo,
        async (key, text) => {
          sent.push({ key, text });
          return true;
        },
        30
      );
      expect(sent).toEqual([pending]);
      db.prepare('UPDATE pack_coding_pr_ledger SET read_at = 40').run();
      await wakeCodingUnownedPrs(
        repo,
        async (key, text) => {
          sent.push({ key, text });
          return true;
        },
        40
      );
      expect(sent).toHaveLength(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('upgrading the prior ledger preserves its rows and excludes unknown historical metadata', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE pack_coding_pr_ledger (
        repo TEXT, number INTEGER, title TEXT, branch TEXT, head TEXT, state TEXT,
        state_since INTEGER, closed_at INTEGER, owner TEXT, nudges INTEGER DEFAULT 0,
        told_at INTEGER, read_at INTEGER, PRIMARY KEY(repo,number));
        INSERT INTO pack_coding_pr_ledger (repo,number,title,read_at) VALUES ('synthetic/a',1,'Keep this row',1)`);
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, 2);
      expect(
        db.prepare('SELECT title,created_at,author_is_bot FROM pack_coding_pr_ledger').get()
      ).toEqual({
        title: 'Keep this row',
        created_at: null,
        author_is_bot: 1,
      });
      expect(new CodingPrEventRepository(db).pendingUnowned(1)).toBeNull();
    } finally {
      db.close();
    }
  });
});
