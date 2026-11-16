import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wakeCodingUnownedPrs } from '../../../../src/lib/neo/packs/coding/pr-unowned.ts';
import { describe, expect, spyOn, test } from 'bun:test';
import { CODING_ATTENTION_KINDS } from '../../../../src/lib/neo/packs/coding/attention.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPolicy,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { WorkTurnRepository } from '../../../../src/storage/repositories/work-turn-repository.ts';
import { runMigration477 } from '../../../../src/storage/schema/m477-work-turns.ts';
import { runMigration480 } from '../../../../src/storage/schema/m480-work-turn-urls.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { neoAttentionNotes } from '../../helpers/neo-attention-notes.ts';

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

const entry = (db: Database) => {
  const notes = neoAttentionNotes(
    db,
    new NeoAskTodoRepository(db),
    () => {},
    CODING_ATTENTION_KINDS
  );
  return {
    attend: async (event: Parameters<typeof notes.attend>[0]) =>
      'told' in (await notes.attend(event)),
    told: () =>
      notes
        .wakes()
        .map((text) => /owner: (\S+#\d+) "/.exec(text)?.[1])
        .sort(),
  };
};

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createNeoPackPreferencesTable(db);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const { attend, told } = entry(db);
  let accepted = true;
  let partial = false;
  let nodes: unknown[] = [];
  const makePack = () =>
    createCodingPack({
      database: () => db,
      readPrs: async () => [],
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
      attend: async (event) => accepted && attend(event),
      prSweepDeps: { tell: async () => true, wake: async () => false },
    });
  let pack = makePack();
  return {
    db,
    ledger,
    told,
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
  const turn = (url: string, complete: boolean) => ({
    id: 'turn-1',
    startedAt: ship,
    endedAt: ship + 90_000,
    ended: 'end_turn',
    inputs: [],
    urls: [url],
    finalUrls: [url],
    complete,
    cursor: '{"seq":1,"consumed":0}',
  });
  const worker = { adapter: 'claude-desktop', id: 'worker' };
  const url = 'https://github.com/synthetic/a/pull/1';

  const markWorkerRunning = (db: Database, state: 'doing' | 'blocked') => {
    const store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Work',
      request: 'Work',
      createdAt: 1,
    });
    store.addTodo(
      'todo',
      'ask',
      { title: 'Work', doneWhen: 'Done', check: null, instruction: 'Go', named: null },
      1
    );
    store.updateTodo(store.getTodo('todo')!, { state, startedAt: 2 }, 2);
    db.prepare(
      `INSERT INTO neo_todo_sessions (todo_id, target, ref, live_status)
       VALUES ('todo', '{}', ?, 'running')`
    ).run(JSON.stringify(worker));
  };

  test('the turn that produced a PR makes its session the owner', async () => {
    const { db, told, cycle } = setup();
    try {
      await new WorkTurnRepository(db).record(worker, [turn(url, true)]);
      await cycle([pr(1)]);
      expect(
        db.prepare("SELECT owner FROM pack_coding_pr_ledger WHERE repo = 'synthetic/a'").get()
      ).toEqual({ owner: JSON.stringify(worker) });
      expect(told()).toEqual(['synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('naming a PR on a todo hands it to that session, ahead of the turn that produced it', async () => {
    const { db, cycle } = setup();
    try {
      markWorkerRunning(db, 'doing');
      db.prepare("UPDATE neo_todos SET check_json = ? WHERE id = 'todo'").run(
        JSON.stringify({ pack: 'coding', kind: 'pr_merged', params: { urls: [url] } })
      );
      await new WorkTurnRepository(db).record({ adapter: 'codex-desktop', id: 'producer' }, [
        turn(url, true),
      ]);
      await cycle([pr(1)]);
      expect(
        db.prepare("SELECT owner FROM pack_coding_pr_ledger WHERE repo = 'synthetic/a'").get()
      ).toEqual({ owner: JSON.stringify(worker) });
    } finally {
      db.close();
    }
  });

  test('a turn that could not be read fully holds the unowned notice until it is known', async () => {
    const { db, told, cycle } = setup();
    try {
      await new WorkTurnRepository(db).record(worker, [turn(url, false)]);
      await cycle([pr(1)]);
      expect(told()).toEqual(['synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('a turn recorded after owners were assigned does not announce its PR as unowned', async () => {
    const { db, cycle } = setup();
    try {
      const turns = new WorkTurnRepository(db);
      await turns.record(worker, [turn(url, false)]);
      await cycle([pr(1)]);
      await turns.record(worker, [turn(url, true)]);
      expect(
        (await new CodingPrEventRepository(db).unownedLater(ship + 120_000)).map(
          (row) => `${row.repo}#${row.number}`
        )
      ).toEqual(['synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('a PR opened while a worker turn runs waits for that turn to end', async () => {
    const { db, told, cycle } = setup();
    try {
      markWorkerRunning(db, 'doing');
      await cycle([pr(1)]);
      expect(told()).toEqual([]);

      await new WorkTurnRepository(db).record(worker, [
        { ...turn('https://example.com', true), endedAt: ship + 100_000 },
      ]);
      await cycle([pr(1)], ship + 180_000);
      expect(told()).toEqual(['synthetic/a#1', 'synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('a worker blocked on its check does not hold the notice, since nothing refreshes its status', async () => {
    const { db, told, cycle } = setup();
    try {
      markWorkerRunning(db, 'blocked');
      await cycle([pr(1)]);
      expect(told()).toEqual(['synthetic/a#1', 'synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('a PR no turn produced and no session claims is announced', async () => {
    const { db, told, cycle } = setup();
    try {
      await new WorkTurnRepository(db).record(worker, [
        { ...turn(url, true), startedAt: ship - 2000, endedAt: ship - 1000 },
      ]);
      await cycle([pr(1)]);
      expect(told()).toEqual(['synthetic/a#1', 'synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('one reconcile wakes Neo once per new human PR across repos, never the old backlog', async () => {
    const { db, told, cycle } = setup();
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
      const all = ['synthetic/a#1', 'synthetic/a#2', 'synthetic/b#1', 'synthetic/b#2'];
      expect(told()).toEqual(all);
      await cycle([pr(1), pr(2)], ship + 180_000);
      expect(told()).toEqual(all);
    } finally {
      db.close();
    }
  });

  test('a known owner is not announced, and each PR is told once through restart, head change and pruning', async () => {
    const { db, ledger, told, cycle, restart } = setup();
    try {
      await new WorkTurnRepository(db).record(worker, [turn(url, true)]);
      await cycle([pr(1)]);
      expect(told()).toEqual(['synthetic/b#1']);
      restart();
      await cycle([pr(1, { headRefOid: 'pushed' })], ship + 180_000);
      expect(told()).toEqual(['synthetic/b#1']);
      ledger.dropRepo('synthetic/b');
      await cycle([pr(1)], ship + 240_000);
      expect(told()).toEqual(['synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('a partial read does not turn stale unowned rows into a new notification', async () => {
    const { db, told, cycle, partial } = setup();
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
      expect(told()).toEqual([]);
      partial(false);
      await cycle([pr(1)], ship + 180_000);
      expect(told()).toEqual(['synthetic/a#1', 'synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test('drafts become eligible later, with no repeat on later state changes', async () => {
    const { db, told, cycle } = setup();
    try {
      await cycle([pr(1, { isDraft: true })]);
      expect(told()).toEqual([]);
      await cycle([pr(1)], ship + 180_000);
      expect(told()).toEqual(['synthetic/a#1', 'synthetic/b#1']);
      await cycle([pr(1, { reviewDecision: 'APPROVED' })], ship + 240_000);
      expect(told()).toEqual(['synthetic/a#1', 'synthetic/b#1']);
    } finally {
      db.close();
    }
  });

  test.each([
    'owner',
    'addUrls',
    'named',
    'single',
    'removed',
    'closed-ask',
    'other-pr',
    'other-host',
  ] as const)('an undelivered PR rechecks its current claims before retry: %s', async (claim) => {
    const f = setup();
    try {
      f.accept(false);
      await f.cycle([pr(1)]);
      expect(f.told()).toEqual([]);
      if (claim === 'owner') {
        f.db
          .prepare("UPDATE pack_coding_pr_ledger SET owner=? WHERE repo='synthetic/a'")
          .run(JSON.stringify(worker));
      } else {
        const store = new NeoAskTodoRepository(f.db);
        store.openAsk({
          id: 'claim-ask',
          sessionId: 'neo',
          projectId: null,
          originMessageId: null,
          title: 'Claimed work',
          request: 'Work',
          createdAt: 1,
        });
        let todo = store.addTodo(
          'claim-todo',
          'claim-ask',
          {
            title: 'Claimed work',
            doneWhen: 'Merged',
            instruction: 'Build',
            named: null,
            check: {
              pack: 'coding',
              kind: claim === 'single' ? 'pr_approved' : 'pr_merged',
              params: {},
            },
          },
          1
        );
        const linked =
          claim === 'other-pr'
            ? 'https://github.com/synthetic/a/pull/2'
            : claim === 'other-host'
              ? 'https://other.example/synthetic/a/pull/1'
              : 'https://github.com/Synthetic/A/pull/1/files#diff';
        const check =
          claim === 'addUrls'
            ? createCodingTodoPolicy(new CodingTodoPrRepository(f.db)).addUrls(todo, [url])
            : { ...todo.check!, params: claim === 'single' ? { url: linked } : { urls: [linked] } };
        todo = store.updateTodo(todo, { check }, 2);
        if (claim === 'removed') store.updateTodo(todo, { state: 'removed' }, 3);
        if (claim === 'closed-ask')
          store.settleAsk(store.getAsk('claim-ask')!, 'done', 'Closed', 3);
        expect(
          f.db.prepare("SELECT owner FROM pack_coding_pr_ledger WHERE repo='synthetic/a'").get()
        ).toEqual({ owner: null });
      }
      f.accept(true);
      const { attend, told } = entry(f.db);
      await wakeCodingUnownedPrs(new CodingPrEventRepository(f.db), attend, ship + 120_000);
      const covered = ['owner', 'addUrls', 'named', 'single'].includes(claim);
      expect(told()).toEqual(covered ? ['synthetic/b#1'] : ['synthetic/a#1', 'synthetic/b#1']);
    } finally {
      f.db.close();
    }
  });

  test('an explicit unassigned todo claim is checked before the first notice', async () => {
    const f = setup();
    try {
      const store = new NeoAskTodoRepository(f.db);
      store.openAsk({
        id: 'fresh-ask',
        sessionId: 'neo',
        projectId: null,
        originMessageId: null,
        title: 'Linked work',
        request: 'Build',
        createdAt: 1,
      });
      store.addTodo(
        'fresh-todo',
        'fresh-ask',
        {
          title: 'Linked work',
          instruction: 'Build',
          named: null,
          doneWhen: 'Merged',
          check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
        },
        1
      );
      await f.cycle([pr(1)]);
      expect(f.told()).toEqual(['synthetic/b#1']);
    } finally {
      f.db.close();
    }
  });

  test('an unreadable optional claim recheck still announces the PR', async () => {
    const f = setup();
    try {
      f.accept(false);
      await f.cycle([pr(1)]);
      const prepare = f.db.prepare.bind(f.db);
      const fault = spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
        if (sql.includes('WITH active AS')) throw new Error('Synthetic claim read unavailable');
        return prepare(sql);
      }) as typeof f.db.prepare);
      try {
        const { attend, told } = entry(f.db);
        await wakeCodingUnownedPrs(new CodingPrEventRepository(f.db), attend, ship + 120_000);
        expect(told()).toEqual(['synthetic/a#1', 'synthetic/b#1']);
      } finally {
        fault.mockRestore();
      }
    } finally {
      f.db.close();
    }
  });

  test('a refused wake is retried after restart and each PR is still told once', async () => {
    const { db, told, cycle, accept, restart } = setup();
    try {
      accept(false);
      await cycle([pr(1)]);
      expect(told()).toEqual([]);
      restart();
      accept(true);
      const all = ['synthetic/a#1', 'synthetic/a#2', 'synthetic/b#1', 'synthetic/b#2'];
      await cycle([pr(1), pr(2)], ship + 180_000);
      expect(told()).toEqual(all);
      await cycle([pr(1), pr(2)], ship + 240_000);
      expect(told()).toEqual(all);
    } finally {
      db.close();
    }
  });
});

describe('coding pack unowned PR persistence', () => {
  test('the activation cutoff is strict and does not reset when schema is reapplied', async () => {
    const { db, told, cycle } = setup();
    try {
      const { activated_at: cutoff } = db
        .prepare('SELECT activated_at FROM pack_coding_pr_unowned_state')
        .get() as { activated_at: number };
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, cutoff + 600_000);
      runMigration477(db);
      runMigration480(db);
      runMigrations(db, () => {});
      createTables(db);
      expect(db.prepare('SELECT activated_at FROM pack_coding_pr_unowned_state').get()).toEqual({
        activated_at: cutoff,
      });
      await cycle([
        pr(1, { createdAt: new Date(cutoff).toISOString() }),
        pr(2, { createdAt: new Date(cutoff + 1).toISOString() }),
      ]);
      expect(told()).toEqual(['synthetic/a#2', 'synthetic/b#2']);
    } finally {
      db.close();
    }
  });

  test('a told PR stays told after closing and reopening the database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-unowned-persistence-'));
    const path = join(root, 'synthetic.db');
    let db = new Database(path);
    const open = (activatedAt: number) => {
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, activatedAt);
      runMigration477(db);
      runMigration480(db);
      runMigrations(db, () => {});
      createTables(db);
      return entry(db);
    };
    try {
      let notes = open(10);
      db.prepare(`INSERT INTO pack_coding_pr_ledger (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
        VALUES ('synthetic/a',1,'Synthetic','b','h','unreviewed',20,20,11,0)`).run();
      await wakeCodingUnownedPrs(new CodingPrEventRepository(db), notes.attend, 20);
      expect(notes.told()).toEqual(['synthetic/a#1']);
      db.close();
      db = new Database(path);
      notes = open(30);
      db.prepare('UPDATE pack_coding_pr_ledger SET read_at = 40').run();
      await wakeCodingUnownedPrs(new CodingPrEventRepository(db), notes.attend, 40);
      expect(notes.told()).toEqual(['synthetic/a#1']);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the pack keeps no record of which unowned PRs it told', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE pack_coding_pr_unowned (key TEXT PRIMARY KEY, listed_at INTEGER NOT NULL);
        INSERT INTO pack_coding_pr_unowned VALUES ('neo-pr-unowned:synthetic/a#1', 1);
        CREATE TABLE pack_coding_pr_unowned_state (id INTEGER PRIMARY KEY CHECK (id = 1),
          activated_at INTEGER NOT NULL, pending_key TEXT, pending_text TEXT, pending_rows TEXT);
        INSERT INTO pack_coding_pr_unowned_state VALUES (1, 7, 'key', 'text', '{}')`);
      for (const activatedAt of [8, 9]) {
        createCodingPackTables(db, activatedAt);
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name = 'pack_coding_pr_unowned'").all()
        ).toEqual([]);
        expect(db.prepare('SELECT * FROM pack_coding_pr_unowned_state').all()).toEqual([
          { id: 1, activated_at: 7 },
        ]);
      }
    } finally {
      db.close();
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
      runMigration477(db);
      runMigration480(db);
      runMigrations(db, () => {});
      createTables(db);
      expect(
        db.prepare('SELECT title,created_at,author_is_bot FROM pack_coding_pr_ledger').get()
      ).toEqual({
        title: 'Keep this row',
        created_at: null,
        author_is_bot: 1,
      });
      expect(new CodingPrEventRepository(db).unowned(1)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
