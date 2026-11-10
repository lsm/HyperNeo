import { Logger } from '../../../../src/lib/logger.ts';
import type { CodingSweepDeps } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wakeCodingUnownedPrs as wakeUnowned } from '../../../../src/lib/neo/packs/coding/pr-unowned.ts';
import { describe, expect, spyOn, test } from 'bun:test';
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

function wakeCodingUnownedPrs(...[repo, wake, now, delivery]: Parameters<typeof wakeUnowned>) {
  return wakeUnowned(
    repo,
    wake,
    now,
    delivery ?? {
      recipient: () => 'neo',
      status: async () => 'absent',
      send: (_recipient, key, text) => wake(key, text),
    }
  );
}

function readPending(repo: CodingPrEventRepository, now: number) {
  return repo.pendingUnowned(now, {
    key: repo.pendingDelivery().key,
    recipient: 'neo',
    status: 'absent',
  });
}

function setup(delivery?: CodingSweepDeps['delivery']) {
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
        delivery: delivery ?? {
          recipient: () => 'neo',
          status: async () => 'absent',
          send: async (_recipient, key, text) => {
            wakes.push({ key, text });
            return accepted;
          },
        },
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
    const { db, wakes, cycle } = setup();
    try {
      await new WorkTurnRepository(db).record(worker, [turn(url, true)]);
      await cycle([pr(1)]);
      expect(
        db.prepare("SELECT owner FROM pack_coding_pr_ledger WHERE repo = 'synthetic/a'").get()
      ).toEqual({ owner: JSON.stringify(worker) });
      expect(wakes.flatMap((wake) => wake.text)).not.toContainEqual(
        expect.stringContaining('synthetic/a#1')
      );
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
    const { db, wakes, cycle } = setup();
    try {
      await new WorkTurnRepository(db).record(worker, [turn(url, false)]);
      await cycle([pr(1)]);
      expect(wakes.flatMap((wake) => wake.text)).not.toContainEqual(
        expect.stringContaining('synthetic/a#1')
      );
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
      expect(readPending(new CodingPrEventRepository(db), ship + 120_000)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('a PR opened while a worker turn runs waits for that turn to end', async () => {
    const { db, wakes, cycle } = setup();
    try {
      markWorkerRunning(db, 'doing');
      await cycle([pr(1)]);
      expect(wakes).toEqual([]);

      await new WorkTurnRepository(db).record(worker, [
        { ...turn('https://example.com', true), endedAt: ship + 100_000 },
      ]);
      await cycle([pr(1)], ship + 180_000);
      expect(wakes[0].text).toContain('synthetic/a#1');
    } finally {
      db.close();
    }
  });

  test('a worker blocked on its check does not hold the notice, since nothing refreshes its status', async () => {
    const { db, wakes, cycle } = setup();
    try {
      markWorkerRunning(db, 'blocked');
      await cycle([pr(1)]);
      expect(wakes[0].text).toContain('synthetic/a#1');
    } finally {
      db.close();
    }
  });

  test('a PR no turn produced and no session claims is announced', async () => {
    const { db, wakes, cycle } = setup();
    try {
      await new WorkTurnRepository(db).record(worker, [
        { ...turn(url, true), startedAt: ship - 2000, endedAt: ship - 1000 },
      ]);
      await cycle([pr(1)]);
      expect(wakes[0].text).toContain('synthetic/a#1');
    } finally {
      db.close();
    }
  });

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
      await new WorkTurnRepository(db).record(worker, [turn(url, true)]);
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

  test.each([
    'owner',
    'addUrls',
    'named',
    'single',
    'removed',
    'closed-ask',
    'other-pr',
    'other-host',
  ] as const)('a refused batch rechecks its current claims before retry: %s', async (claim) => {
    const f = setup();
    try {
      f.accept(false);
      await f.cycle([pr(1)]);
      expect(f.wakes).toHaveLength(1);
      const original = readPending(new CodingPrEventRepository(f.db), ship + 120_000)!;
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
      const retry: { key: string; text: string }[] = [];
      const events = new CodingPrEventRepository(f.db);
      const send = async (key: string, text: string) => {
        retry.push({ key, text });
        return false;
      };
      await wakeCodingUnownedPrs(events, send, ship + 180_000);
      const covered = ['owner', 'addUrls', 'named', 'single'].includes(claim);
      expect(retry).toHaveLength(1);
      expect(retry[0].key).toBe(original.key);
      expect(retry[0].text.includes('synthetic/a#1')).toBe(!covered);
      expect(retry[0].text).toContain('synthetic/b#1');
      if (!covered) expect(retry[0]).toEqual(original);
      await wakeCodingUnownedPrs(new CodingPrEventRepository(f.db), send, ship + 240_000);
      expect(retry[1]).toEqual(retry[0]);
      await wakeCodingUnownedPrs(events, async () => true, ship + 300_000);
      await wakeCodingUnownedPrs(events, send, ship + 360_000);
      expect(retry).toHaveLength(2);
    } finally {
      f.db.close();
    }
  });

  test('a fully claimed pending batch retires without another wake', async () => {
    const f = setup();
    try {
      f.accept(false);
      await f.cycle([pr(1)]);
      expect(f.wakes).toHaveLength(1);
      f.db.prepare('UPDATE pack_coding_pr_ledger SET owner=?').run(JSON.stringify(worker));
      await wakeCodingUnownedPrs(
        new CodingPrEventRepository(f.db),
        async () => {
          throw new Error('Claimed rows must not wake Neo');
        },
        ship + 180_000
      );
      expect(
        f.db.prepare('SELECT pending_key AS key FROM pack_coding_pr_unowned_state').get()
      ).toEqual({ key: null });
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
      expect(f.wakes).toHaveLength(1);
      expect(f.wakes[0].text).not.toContain('synthetic/a#1');
      expect(f.wakes[0].text).toContain('synthetic/b#1');
    } finally {
      f.db.close();
    }
  });

  test('an unreadable optional claim recheck preserves the pending notification', async () => {
    const f = setup();
    try {
      f.accept(false);
      await f.cycle([pr(1)]);
      const events = new CodingPrEventRepository(f.db);
      const original = readPending(events, ship + 120_000)!;
      const prepare = f.db.prepare.bind(f.db);
      const fault = spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
        if (sql.includes('WITH active AS')) throw new Error('Synthetic claim read unavailable');
        return prepare(sql);
      }) as typeof f.db.prepare);
      try {
        const sent: unknown[] = [];
        await wakeCodingUnownedPrs(
          events,
          async (key, text) => {
            sent.push({ key, text });
            return true;
          },
          ship + 180_000
        );
        expect(sent).toEqual([original]);
        expect(
          f.db.prepare('SELECT pending_key AS key FROM pack_coding_pr_unowned_state').get()
        ).toEqual({ key: null });
      } finally {
        fault.mockRestore();
      }
    } finally {
      f.db.close();
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
  test('an admitted pending batch keeps its delivery identity after a crash and trimming', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unowned-admission-'));
    const path = join(root, 'synthetic.db');
    let db = new Database(path);
    const admitted = new Map<string, string>();
    const attempts: { key: string; text: string }[] = [];
    const wake = async (key: string, text: string) => {
      attempts.push({ key, text });
      if (!admitted.has(key)) admitted.set(key, text);
      return true;
    };
    try {
      runMigrations(db, () => {});
      createTables(db);
      createCodingPackTables(db, 10);
      for (const number of [1, 2])
        db.prepare(`INSERT INTO pack_coding_pr_ledger
        (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
        VALUES ('synthetic/a',?,'Synthetic','work','head','unreviewed',20,20,11,0)`).run(number);
      const events = new CodingPrEventRepository(db);
      const lostAck = spyOn(events, 'unownedDeliveredLater').mockRejectedValueOnce(
        new Error('Synthetic acknowledgement lost')
      );
      await expect(wakeCodingUnownedPrs(events, wake, 20)).rejects.toThrow(
        'Synthetic acknowledgement lost'
      );
      lostAck.mockRestore();
      expect(admitted.size).toBe(1);
      db.close();
      db = new Database(path);
      db.prepare('UPDATE pack_coding_pr_ledger SET owner=? WHERE number=1').run(
        JSON.stringify({ adapter: 'hyperneo', id: 'claimed-worker' })
      );
      await wakeCodingUnownedPrs(new CodingPrEventRepository(db), wake, 30);
      expect(attempts).toHaveLength(2);
      expect(attempts[1].text).not.toContain('synthetic/a#1');
      expect(attempts[1].text).toContain('synthetic/a#2');
      expect(attempts[1].key).toBe(attempts[0].key);
      expect(admitted.size).toBe(1);
      expect(
        db.prepare('SELECT pending_key AS key FROM pack_coding_pr_unowned_state').get()
      ).toEqual({ key: null });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['absent', 'admitted', 'in-flight', 'unknown', 'error'] as const)(
    'claim removal after %s preserves exactly the eligible notices',
    async (status) => {
      const f = setup({
        recipient: () => 'neo',
        status: async () => 'absent',
        send: async () => false,
      });
      try {
        f.accept(false);
        await f.cycle([pr(1)]);
        const events = new CodingPrEventRepository(f.db);
        const original = readPending(events, ship + 120_000)!;
        f.db
          .prepare("UPDATE pack_coding_pr_ledger SET owner=? WHERE repo='synthetic/a' AND number=1")
          .run(JSON.stringify({ adapter: 'hyperneo', id: 'claimed-worker' }));
        const attempts: string[] = [];
        await wakeCodingUnownedPrs(
          events,
          async (_key, text) => {
            attempts.push(text);
            return true;
          },
          ship + 180_000,
          {
            recipient: () => 'replacement-neo',
            status: async (recipient, key) => {
              expect(recipient).toBe('neo');
              expect(key).toBe(original.key);
              if (status === 'error') throw new Error('Synthetic transient receipt error');
              return status;
            },
            send: async (recipient, key, text) => {
              expect(recipient).toBe('neo');
              expect(key).toBe(original.key);
              attempts.push(text);
              return true;
            },
          }
        );
        const history = f.db.prepare('SELECT key FROM pack_coding_pr_unowned ORDER BY key').all();
        expect(history).toHaveLength(status === 'absent' ? 1 : 2);
        expect(attempts).toHaveLength(status === 'absent' ? 1 : 0);
        if (status === 'absent' || status === 'admitted')
          expect(events.pendingDelivery().recipient).toBeUndefined();
        f.db.prepare('UPDATE pack_coding_pr_ledger SET owner=NULL').run();
        if (status === 'absent') {
          const renewed = readPending(events, ship + 120_000)!;
          expect(renewed.text).toContain('synthetic/a#1');
          expect(renewed.text).not.toContain('synthetic/b#1');
        }
      } finally {
        f.db.close();
      }
    }
  );

  test('a changed pending key refuses a stale receipt and overlapping producers serialize', async () => {
    const f = setup();
    try {
      f.accept(false);
      await f.cycle([pr(1)]);
      const events = new CodingPrEventRepository(f.db);
      const original = events.pendingDelivery();
      f.db.prepare('UPDATE pack_coding_pr_unowned_state SET pending_key=?').run('replacement');
      expect(
        events.pendingUnowned(ship + 120_000, {
          key: original.key,
          recipient: 'neo',
          status: 'admitted',
        })
      ).toBeNull();
      expect(events.pendingDelivery().key).toBe('replacement');
      const attempts: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      let started!: () => void;
      const entered = new Promise<void>((done) => {
        started = done;
      });
      const first = wakeCodingUnownedPrs(
        events,
        async (key) => {
          attempts.push(key);
          started();
          await held;
          return true;
        },
        ship + 120_000
      );
      await entered;
      const second = wakeCodingUnownedPrs(
        events,
        async (key) => {
          attempts.push(key);
          return true;
        },
        ship + 120_000
      );
      await Promise.resolve();
      expect(attempts).toEqual(['replacement']);
      release();
      await Promise.all([first, second]);
      expect(attempts).toEqual(['replacement']);
    } finally {
      f.db.close();
    }
  });

  test.each(['array', 'null', 'recipient_gone'] as const)(
    'retires %s pending without sending or releasing history, then admits unrelated work',
    async (shape) => {
      const f = setup({
        recipient: () => 'original',
        status: async () => 'absent',
        send: async () => false,
      });
      const diagnostic = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      try {
        await f.cycle([pr(1)]);
        const events = new CodingPrEventRepository(f.db);
        const original = events.pendingDelivery();
        const history = f.db.prepare('SELECT * FROM pack_coding_pr_unowned ORDER BY key').all();
        if (shape !== 'recipient_gone') {
          const saved = f.db
            .prepare('SELECT pending_rows AS rows FROM pack_coding_pr_unowned_state')
            .get() as { rows: string };
          f.db
            .prepare('UPDATE pack_coding_pr_unowned_state SET pending_rows=?')
            .run(shape === 'null' ? null : JSON.stringify(JSON.parse(saved.rows).rows));
        }
        const sent: string[] = [];
        const delivery = {
          recipient: () => 'replacement',
          status: async () => 'recipient_gone' as const,
          send: async (recipient: string, _key: string, text: string) => {
            sent.push(recipient + text);
            return true;
          },
        };
        await wakeCodingUnownedPrs(
          events,
          async () => {
            throw new Error('No fallback permitted');
          },
          ship + 120_000,
          delivery
        );
        expect(sent).toEqual([]);
        expect(
          diagnostic.mock.calls.filter(
            ([message]) => message === 'Unowned PR pending slot retired without delivery'
          )
        ).toHaveLength(1);
        expect(events.pendingDelivery().key).toBeNull();
        expect(f.db.prepare('SELECT * FROM pack_coding_pr_unowned ORDER BY key').all()).toEqual(
          history
        );
        f.db
          .prepare(`INSERT INTO pack_coding_pr_ledger
          (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
          VALUES ('synthetic/a',99,'Unrelated','work','new-head','unreviewed',20,30,?,0)`)
          .run(ship + 60_000);
        await wakeCodingUnownedPrs(events, async () => false, 30, delivery);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('replacement');
        expect(sent[0]).toContain('synthetic/a#99');
        expect(sent[0]).not.toContain('synthetic/a#1');
        expect(original.key).not.toBeNull();
      } finally {
        diagnostic.mockRestore();
        f.db.close();
      }
    }
  );

  test('new reservations require a concrete recipient', () => {
    const f = setup();
    try {
      f.db
        .prepare(`INSERT INTO pack_coding_pr_ledger
        (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
        VALUES ('synthetic/a',99,'Unrelated','work','head','unreviewed',20,30,?,0)`)
        .run(ship + 60_000);
      expect(new CodingPrEventRepository(f.db).pendingUnowned(30)).toBeNull();
      expect(f.db.prepare('SELECT * FROM pack_coding_pr_unowned').all()).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test('the activation cutoff is strict and does not reset when schema is reapplied', async () => {
    const { db, wakes, cycle } = setup();
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
      runMigration477(db);
      runMigration480(db);
      runMigrations(db, () => {});
      createTables(db);
      db.prepare(`INSERT INTO pack_coding_pr_ledger (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
        VALUES ('synthetic/a',1,'Synthetic','b','h','unreviewed',20,20,11,0)`).run();
      const pending = readPending(new CodingPrEventRepository(db), 20);
      expect(pending?.text).toContain('synthetic/a#1');
      db.close();
      db = new Database(path);
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, 30);
      runMigration477(db);
      runMigration480(db);
      runMigrations(db, () => {});
      createTables(db);
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
      expect(readPending(new CodingPrEventRepository(db), 1)).toBeNull();
    } finally {
      db.close();
    }
  });
});
