import { describe, expect, test } from 'bun:test';
import {
  CODING_LEDGER_KEEP_MS,
  CodingPrLedgerRepository,
  codingLedgerArgs,
  codingPrState,
  planCodingLedgerRead,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
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
  reviews: { nodes: [] },
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
      nameWithOwner: 'x/x',
      open: { pageInfo: { hasNextPage: more.next }, nodes: open },
      done: { nodes: done },
    },
  },
});

type Read = (repo: string) => Promise<unknown | null>;
const named =
  (read: Read): Read =>
  async (repo) => {
    const raw = (await read(repo)) as { data?: { repository?: { nameWithOwner: string } } } | null;
    if (raw?.data?.repository) raw.data.repository.nameWithOwner = repo;
    return raw;
  };
const reconcile = (
  ledger: CodingPrLedgerRepository,
  repos: string[],
  read: Read,
  now: number,
  skips?: Map<string, number>
) => reconcileCodingPrLedger(ledger, repos, named(read), now, skips);

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
      planCodingLedgerRead(response([node(1)], [], { remaining: 4000, next: true }), now)
    ).toBeNull();
    expect(
      planCodingLedgerRead({ ...response([node(1)]), errors: [{ message: 'x' }] }, now)
    ).toBeNull();
    expect(planCodingLedgerRead(null, now)).toBeNull();
  });
});

describe('reconcileCodingPrLedger', () => {
  test('lists every open PR across repos and moves state_since only on a state or head change', async () => {
    const { db, ledger } = setup();
    let second = [node(7)];
    const read = async (repo: string) =>
      repo === 'lsm/hyperneo' ? response([node(1), node(2, { isDraft: true })]) : response(second);
    await reconcile(ledger, ['lsm/hyperneo', 'lsm/neo-ios'], read, 100);
    expect(ledger.list().map((row) => [row.repo, row.number, row.state, row.stateSince])).toEqual([
      ['lsm/hyperneo', 1, 'waiting_review', 100],
      ['lsm/hyperneo', 2, 'draft', 100],
      ['lsm/neo-ios', 7, 'waiting_review', 100],
    ]);
    db.exec('UPDATE pack_coding_pr_ledger SET nudges = 2');
    await reconcile(ledger, ['lsm/hyperneo', 'lsm/neo-ios'], read, 200);
    second = [node(7, { headRefOid: 'pushed' })];
    await reconcile(ledger, ['lsm/hyperneo', 'lsm/neo-ios'], read, 300);
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
    await reconcile(ledger, ['a/a'], async () => response([node(1)]), 100);
    const reads: string[] = [];
    await reconcile(
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
    await reconcile(
      ledger,
      ['a/a'],
      async () => response([], [node(1, { state: 'MERGED', closedAt })]),
      2_000
    );
    expect(ledger.list()).toHaveLength(1);
    await reconcile(ledger, ['a/a'], async () => null, 1_000 + CODING_LEDGER_KEEP_MS + 1);
    expect(ledger.list()).toEqual([]);
    db.close();
  });
});

describe('reconcileCodingPrLedger cleanup', () => {
  test('drops an open row the next full read no longer lists, rows of repos no project names, and rows unread for 7 days', async () => {
    const { db, ledger } = setup();
    await reconcile(
      ledger,
      ['a/a', 'b/b', 'c/c'],
      async (repo) => response(repo === 'a/a' ? [node(1), node(2)] : [node(3)]),
      100
    );
    await reconcile(
      ledger,
      ['a/a', 'b/b'],
      async (repo) => (repo === 'a/a' ? response([node(1)]) : null),
      200
    );
    expect(ledger.list().map((row) => [row.repo, row.number])).toEqual([
      ['a/a', 1],
      ['b/b', 3],
    ]);
    await reconcile(
      ledger,
      ['a/a', 'b/b'],
      async (repo) => (repo === 'a/a' ? response([node(1)]) : null),
      101 + CODING_LEDGER_KEEP_MS
    );
    expect(ledger.list().map((row) => [row.repo, row.number])).toEqual([['a/a', 1]]);
    db.close();
  });

  test('counts consecutive failed reads per repo and clears the count on a good read', async () => {
    const { db, ledger } = setup();
    const skips = new Map<string, number>();
    let good = false;
    const read = async () => (good ? response([node(1)]) : null);
    for (const at of [1, 2, 3]) await reconcile(ledger, ['a/a'], read, at, skips);
    expect(skips.get('a/a')).toBe(3);
    good = true;
    await reconcile(ledger, ['a/a'], read, 4, skips);
    expect(skips.get('a/a')).toBe(0);
    db.close();
  });
});

describe('ledger approval and repo coverage', () => {
  test('approval comes from the latest review on the head commit when the repo requires none', () => {
    const state = (reviews: { state: string; oid: string }[], decision: string | null = null) =>
      codingPrState(
        node(1, {
          reviewDecision: decision,
          reviews: {
            nodes: reviews.map((item) => ({ state: item.state, commit: { oid: item.oid } })),
          },
        }) as never
      );
    expect(state([{ state: 'APPROVED', oid: 'h1' }])).toBe('approved_green');
    expect(state([{ state: 'APPROVED', oid: 'old' }])).toBe('waiting_review');
    expect(
      state([
        { state: 'APPROVED', oid: 'h1' },
        { state: 'CHANGES_REQUESTED', oid: 'h1' },
      ])
    ).toBe('changes_requested');
    expect(state([{ state: 'APPROVED', oid: 'old' }], 'APPROVED')).toBe('approved_green');
  });

  test('a renamed repo listed under both names is read into one set of rows under its GitHub name', async () => {
    const { db, ledger } = setup();
    const reads: string[] = [];
    await reconcileCodingPrLedger(
      ledger,
      ['lsm/hyperneo', 'lsm/neokai'],
      async (repo) => {
        reads.push(repo);
        const raw = response([node(1)]);
        raw.data.repository.nameWithOwner = 'lsm/HyperNeo';
        return raw;
      },
      100
    );
    expect(reads).toEqual(['lsm/hyperneo', 'lsm/neokai']);
    expect(ledger.list().map((row) => [row.repo, row.number])).toEqual([['lsm/hyperneo', 1]]);
    db.close();
  });

  test('every repo of every project is listed, not one per project', () => {
    const { db } = setup();
    for (const id of ['project:a', 'project:b'])
      db.prepare(
        "INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at) VALUES (?, 't', '', '', 1, 1, 1)"
      ).run(id);
    const alias = db.prepare(
      'INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)'
    );
    alias.run('repository:github.com/lsm/hyperneo', 'project:a');
    alias.run('repository:github.com/lsm/hyperneo-review', 'project:a');
    alias.run('repo:lsm/hyperneo\u0000/Users/x/hn', 'project:a');
    alias.run('repo:lsm/Ops\u0000/Users/x/ops', 'project:b');
    expect(new NeoRepository(db).allRepositories()).toEqual([
      'lsm/hyperneo',
      'lsm/hyperneo-review',
      'lsm/ops',
    ]);
    db.close();
  });
});

describe('CodingPrLedgerRepository owners and snapshot', () => {
  const claim = (
    db: Database,
    todo: string,
    state: string,
    startedAt: number,
    url: string,
    ref: unknown
  ) => {
    db.prepare(
      `INSERT INTO neo_asks (id, project_id, session_id, origin_message_id, title, request, status, created_at, updated_at)
       VALUES ('ask', NULL, 'neo', NULL, 'A', 'R', 'open', 1, 1) ON CONFLICT DO NOTHING`
    ).run();
    db.prepare(
      `INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, started_at, created_at, updated_at)
       VALUES (?, 'ask', 0, 'T', 'D', ?, ?, 1, 1)`
    ).run(todo, state, startedAt);
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
      todo,
      '{}',
      ref ? JSON.stringify(ref) : null
    );
    db.prepare(
      "INSERT INTO pack_coding_pr_claims (todo_id, url, claim, claimed_at) VALUES (?, ?, 'branch', 1)"
    ).run(todo, url);
  };

  test('takes the owner from the open todo that claims the PR, and leaves an unclaimed PR unassigned', async () => {
    const { db, ledger } = setup();
    const url = 'https://github.com/lsm/hyperneo/pull/1';
    claim(db, 'old', 'done', 50, url, { adapter: 'codex-desktop', id: 'thread-old' });
    claim(db, 'live', 'doing', 10, url, { adapter: 'hyperneo', id: 'worker-1', daemon: 'imac' });
    await reconcile(ledger, ['lsm/hyperneo'], async () => response([node(1), node(2)]), 100);
    expect(
      ledger
        .snapshot(null, 100)
        .map((row) => [row.pr, row.ownerAdapter, row.ownerId, row.ownerDaemon])
    ).toEqual([
      ['lsm/hyperneo#1', 'hyperneo', 'worker-1', 'imac'],
      ['lsm/hyperneo#2', null, null, null],
    ]);
    db.close();
  });

  test('lists open PRs and ones closed in the last day, for the requested repos', async () => {
    const { ledger, db } = setup();
    const now = 10 * CODING_LEDGER_KEEP_MS;
    const ago = (ms: number) => new Date(now - ms).toISOString();
    await reconcile(
      ledger,
      ['a/a', 'b/b'],
      async (repo) =>
        repo === 'a/a'
          ? response(
              [node(1, { reviewDecision: 'APPROVED' })],
              [
                node(2, { state: 'MERGED', closedAt: ago(60_000) }),
                node(3, { state: 'CLOSED', closedAt: ago(2 * 24 * 60 * 60_000) }),
              ]
            )
          : response([node(9)]),
      now
    );
    expect(ledger.snapshot(['a/a'], now)).toEqual([
      {
        pr: 'a/a#1',
        title: 'PR 1',
        state: 'approved_green',
        since: new Date(now).toISOString(),
        ownerAdapter: null,
        ownerId: null,
        ownerDaemon: null,
      },
      expect.objectContaining({ pr: 'a/a#2', state: 'merged' }),
    ]);
    expect(ledger.snapshot(null, now).map((row) => row.pr)).toEqual(['a/a#1', 'a/a#2', 'b/b#9']);
    db.close();
  });
});

describe('codingLedgerArgs', () => {
  test('passes owner and name as strings, so an all-digit repo is not sent as an Int', () => {
    const args = codingLedgerArgs('gabrielecirulli/2048');
    expect(args.slice(-4)).toEqual(['-f', 'o=gabrielecirulli', '-f', 'n=2048']);
    expect(args).not.toContain('-F');
  });
});
