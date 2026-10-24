import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodingClaudeOwnerReader } from '../../../../src/lib/neo/packs/coding/claude-pr-owners.ts';
import { describe, expect, test } from 'bun:test';
import {
  CODING_LEDGER_KEEP_MS,
  CodingPrLedgerRepository,
  codingLedgerArgs,
  codingPrReplyAt,
  codingPrState,
  planCodingLedgerRead,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import type { NeoSessionFacts } from '../../../../src/lib/neo/pack-contract.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
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
const reconcile = (ledger: CodingPrLedgerRepository, repos: string[], read: Read, now: number) =>
  reconcileCodingPrLedger(ledger, repos, named(read), now);

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
      codingPrState(
        node(
          1,
          {
            reviews: {
              nodes:
                more.reviewDecision === 'APPROVED'
                  ? [{ state: 'APPROVED', commit: { oid: 'h1' }, author: { login: 'bot' } }]
                  : [],
            },
            ...more,
          },
          ci
        ) as never,
        false,
        { mergePolicy: 'review_bot', reviewBot: 'bot' }
      );
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
  test.each(['review_bot', 'ci_only'] as const)(
    'scopes %s human signoff to changed paths',
    (mergePolicy) => {
      const state = (files: unknown) =>
        planCodingLedgerRead(
          response([
            node(1, {
              reviews: {
                nodes: [{ state: 'APPROVED', commit: { oid: 'h1' }, author: { login: 'bot' } }],
              },
              files,
            }),
          ]),
          0,
          () => ({ mergePolicy, reviewBot: 'bot', humanSignoff: ['docs/design/**'] })
        )?.rows[0].state;
      const files = (paths: string[], hasNextPage = false) => ({
        nodes: paths.map((path) => ({ path })),
        pageInfo: { hasNextPage },
      });
      expect(state(files(['packages/daemon/src/app.ts']))).toBe('approved_green');
      expect(state(files(['docs/design/nested/contract.md']))).toBe('waiting_human');
      expect(state(files(['docs/designish/contract.md']))).toBe('approved_green');
      expect(state(files([]))).toBe('approved_green');
      expect(state(files(['packages/daemon/src/app.ts'], true))).toBe('waiting_human');
      expect(state(undefined)).toBe('waiting_human');
    }
  );

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
      [1, 'waiting_human'],
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

  test('an unanswered repo never infers policy from PR history', () => {
    const states = (done: unknown[], more: Record<string, unknown> = {}) =>
      planCodingLedgerRead(response([node(1, more)], done), 0)?.rows.map((row) => row.state);
    expect(states([])).toEqual(['waiting_human']);
    expect(states([node(2, { state: 'CLOSED', closedAt: new Date(0).toISOString() })])).toEqual([
      'waiting_human',
      'closed',
    ]);
    expect(states([node(2, { state: 'MERGED', closedAt: new Date(0).toISOString() })])).toEqual([
      'waiting_human',
      'merged',
    ]);
    expect(states([], { reviews: { nodes: [{ state: 'COMMENTED', commit: null }] } })).toEqual([
      'waiting_human',
    ]);
    expect(states([], { reviewDecision: 'REVIEW_REQUIRED' })).toEqual(['waiting_human']);
  });
});

describe('PR ledger reconcile', () => {
  test('lists every open PR across repos and moves state_since only on a state or head change', async () => {
    const { db, ledger } = setup();
    let second = [node(7)];
    const read = async (repo: string) =>
      repo === 'lsm/hyperneo' ? response([node(1), node(2, { isDraft: true })]) : response(second);
    await reconcile(ledger, ['lsm/hyperneo', 'lsm/neo-ios'], read, 100);
    expect(ledger.list().map((row) => [row.repo, row.number, row.state, row.stateSince])).toEqual([
      ['lsm/hyperneo', 1, 'waiting_human', 100],
      ['lsm/hyperneo', 2, 'draft', 100],
      ['lsm/neo-ios', 7, 'waiting_human', 100],
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
    await reconcile(ledger, ['a/a', 'b/b'], async () => response([node(1)]), 100);
    const reads: string[] = [];
    await reconcile(
      ledger,
      ['a/a', 'b/b', 'c/c', 'd/d'],
      async (repo) => {
        reads.push(repo);
        if (repo === 'a/a') return null;
        return response([node(2)], [], { remaining: 499, next: false });
      },
      200
    );
    db.prepare("UPDATE pack_coding_pr_ledger SET read_at = 10 WHERE repo = 'a/a'").run();
    expect(reads).toEqual(['c/c']);
    reads.length = 0;
    await reconcile(
      ledger,
      ['a/a', 'b/b'],
      async (repo) => {
        reads.push(repo);
        return repo === 'a/a' ? null : response([node(2)], [], { remaining: 499, next: false });
      },
      300
    );
    expect(reads).toEqual(['a/a', 'b/b']);
    expect(ledger.list().map((row) => [row.repo, row.number, row.readAt])).toEqual([
      ['a/a', 1, 10],
      ['b/b', 2, 300],
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

describe('PR ledger cleanup', () => {
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
    let good = false;
    const read = async () => (good ? response([node(1)]) : null);
    for (const at of [1, 2, 3]) await reconcile(ledger, ['a/a'], read, at);
    expect(ledger.health.read('a/a')?.misses).toBe(3);
    good = true;
    await reconcile(ledger, ['a/a'], read, 4);
    expect(ledger.health.read('a/a')?.misses).toBe(0);
    db.close();
  });
});

describe('ledger approval and repo coverage', () => {
  test('approval needs the designated bot on the head, never aggregate reviewDecision', () => {
    const state = (reviews: { state: string; oid: string }[], decision: string | null = null) =>
      codingPrState(
        node(1, {
          reviewDecision: decision,
          reviews: {
            nodes: reviews.map((item) => ({
              state: item.state,
              commit: { oid: item.oid },
              author: { login: 'bot' },
            })),
          },
        }) as never,
        false,
        { mergePolicy: 'review_bot', reviewBot: 'bot' }
      );
    expect(state([{ state: 'APPROVED', oid: 'h1' }])).toBe('approved_green');
    expect(state([{ state: 'APPROVED', oid: 'old' }])).toBe('waiting_review');
    expect(
      state([
        { state: 'APPROVED', oid: 'h1' },
        { state: 'CHANGES_REQUESTED', oid: 'h1' },
      ])
    ).toBe('changes_requested');
    expect(state([{ state: 'APPROVED', oid: 'old' }], 'APPROVED')).toBe('waiting_review');
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

  test("puts open todos' PRs first, and falls back to the todo's own read when the ledger lacks the repo", async () => {
    const { ledger, db } = setup();
    await reconcile(ledger, ['lsm/hyperneo'], async () => response([node(1), node(2)]), 100);
    const tracked = ledger.snapshot(null, 100).find((row) => row.pr === 'lsm/hyperneo#2');
    expect(
      ledger
        .snapshot(null, 100, [
          { todoId: 'live', url: 'https://github.com/LSM/HyperNeo/pull/2', state: 'OPEN' },
          { todoId: 'live', url: 'https://github.com/other/repo/pull/7', state: 'MERGED' },
        ])
        .map((row) => [row.todoId ?? null, row.pr, row.state])
    ).toEqual([
      ['live', 'lsm/hyperneo#2', tracked?.state],
      ['live', 'other/repo#7', 'merged'],
      [null, 'lsm/hyperneo#1', tracked?.state],
    ]);
    db.close();
  });

  test('tags only the PRs a todo owns, not other PRs it was ever matched to', async () => {
    const { ledger, db } = setup();
    await reconcile(ledger, ['lsm/hyperneo'], async () => response([node(1), node(2)]), 100);
    db.exec(`INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
      VALUES ('ask', 'neo', 'A', 'R', 'open', 1, 1);
      INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at)
      VALUES ('live', 'ask', 0, 'T', 'D', 'doing', 1, 1)`);
    const todoPrs = new CodingTodoPrRepository(db);
    const url = (n: number) => `https://github.com/lsm/hyperneo/pull/${n}`;
    todoPrs.claim(
      'live',
      [
        { url: url(1), claim: 'named' },
        { url: url(2), claim: 'branch' },
      ],
      1
    );
    todoPrs.record('live', [{ url: url(1), state: 'OPEN', checks: 'passing', review: 'none' }], 1);
    const coding = createCodingPack({
      todoPrs,
      prLedger: ledger,
    } as unknown as Parameters<typeof createCodingPack>[0]);
    expect(
      coding.snapshotRows?.(null, 100, ['live']).map((row) => [row.todoId ?? null, row.pr])
    ).toEqual([
      ['live', 'lsm/hyperneo#1'],
      [null, 'lsm/hyperneo#2'],
    ]);
    db.close();
  });

  test("finds an open todo's PR under its repo's new name when the todo names the old one", async () => {
    const { ledger, db } = setup();
    await reconcile(ledger, ['lsm/hyperneo'], async () => response([node(1), node(2)]), 100);
    ledger.recordAlias('lsm/neokai', 'lsm/hyperneo');
    expect(
      ledger
        .snapshot(null, 100, [
          { todoId: 'live', url: 'https://github.com/lsm/neokai/pull/2', state: 'OPEN' },
        ])
        .map((row) => [row.todoId ?? null, row.pr])
    ).toEqual([
      ['live', 'lsm/hyperneo#2'],
      [null, 'lsm/hyperneo#1'],
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
        state: 'waiting_human',
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

describe('CodingPrLedgerRepository.observeSessions', () => {
  const facts = (
    ref: { adapter: string; id: string },
    more: Partial<NeoSessionFacts> = {}
  ): NeoSessionFacts => ({
    ref,
    status: 'running',
    lastActivityAt: 1,
    remotes: [],
    branches: [],
    openedPrs: [],
    ...more,
  });
  const owners = (db: Database) =>
    db.prepare('SELECT number, owner FROM pack_coding_pr_ledger ORDER BY number').all();

  test('a Claude commenter link does not claim a PR it did not create', async () => {
    const { db, ledger } = setup();
    await reconcile(ledger, ['lsm/a'], async () => response([node(4)]), 100);
    ledger.observeSessions(
      [
        facts(
          { adapter: 'claude-desktop', id: 'commenter' },
          {
            linkedPrs: [{ url: 'https://github.com/lsm/a/pull/4' }],
            linkedPrsWindow: true,
          }
        ),
      ],
      101
    );
    expect(owners(db)).toEqual([{ number: 4, owner: null }]);
    db.close();
  });

  test('keeps actual opened-PR evidence when a Claude session has no sidebar list', async () => {
    const { db, ledger } = setup();
    const ref = { adapter: 'claude-desktop', id: 'legacy-opener' };
    await reconcile(ledger, ['lsm/a'], async () => response([node(4)]), 100);
    ledger.observeSessions([facts(ref, { openedPrs: ['https://github.com/lsm/a/pull/4'] })], 101);
    expect(owners(db)).toEqual([{ number: 4, owner: JSON.stringify(ref) }]);
    db.close();
  });

  test('a no-sidebar creation sweep preserves watcher-opened PRs across repeated observations', async () => {
    const { db, ledger } = setup();
    const root = mkdtempSync(join(tmpdir(), 'claude-owner-ledger-'));
    const scope = join(root, 'sessions/account/scope');
    const project = join(root, 'projects/-synthetic');
    mkdirSync(scope, { recursive: true });
    mkdirSync(project, { recursive: true });
    const ref = { adapter: 'claude-desktop', id: 'local_one' };
    const pr = (number: number) => `https://github.com/lsm/a/pull/${number}`;
    writeFileSync(
      join(scope, 'local_one.json'),
      JSON.stringify({ sessionId: ref.id, cliSessionId: 'one', cwd: '/synthetic' })
    );
    writeFileSync(
      join(project, 'one.jsonl'),
      JSON.stringify({
        type: 'user',
        toolUseResult: { gitOperation: { pr: { action: 'created', number: 5, url: pr(5) } } },
      }) + '\n'
    );
    const read = createCodingClaudeOwnerReader(
      join(root, 'sessions'),
      join(root, 'projects'),
      async () => ({ remotes: ['git@github.com:lsm/a.git'] })
    );
    try {
      await reconcile(ledger, ['lsm/a'], async () => response([node(4), node(5)]), 100);
      for (const now of [101, 103]) {
        ledger.observeSessions([facts(ref, { openedPrs: [pr(4)] })], now);
        ledger.observeSessions(await read(), now + 1);
        expect(owners(db)).toEqual([
          { number: 4, owner: JSON.stringify(ref) },
          { number: 5, owner: JSON.stringify(ref) },
        ]);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an app link owns its PR before a branch match, and the first owner keeps it', async () => {
    const { db, ledger } = setup();
    const opener = { adapter: 'claude-desktop', id: 'opener' };
    const worker = { adapter: 'hyperneo', id: 'worker' };
    await reconcile(ledger, ['lsm/a'], async () => response([node(1), node(2), node(3)]), 100);
    ledger.observeSessions(
      [
        facts(opener, {
          linkedPrs: [{ url: 'https://github.com/LSM/a/pull/1', own: true }],
          linkedPrsWindow: true,
          branches: ['b1'],
        }),
      ],
      101
    );
    ledger.observeSessions(
      [
        facts(worker, {
          lastActivityAt: 5,
          remotes: ['git@github.com:lsm/a.git'],
          branches: ['b1', 'b2'],
          openedPrs: ['https://github.com/lsm/a/pull/1'],
        }),
      ],
      102
    );
    expect(owners(db)).toEqual([
      { number: 1, owner: JSON.stringify(opener) },
      { number: 2, owner: JSON.stringify(worker) },
      { number: 3, owner: null },
    ]);
    db.close();
  });

  test('a session the app marks as the PR author wins over a more recent session that only linked it', async () => {
    const { db, ledger } = setup();
    const author = { adapter: 'claude-desktop', id: 'author' };
    const reviewer = { adapter: 'claude-desktop', id: 'reviewer' };
    const url = 'https://github.com/lsm/a/pull/1';
    await reconcile(ledger, ['lsm/a'], async () => response([node(1)]), 100);
    ledger.observeSessions(
      [
        facts(reviewer, { lastActivityAt: 9, linkedPrs: [{ url }], linkedPrsWindow: true }),
        facts(author, {
          lastActivityAt: 1,
          linkedPrs: [{ url, own: true }],
          linkedPrsWindow: true,
        }),
      ],
      101
    );
    expect(owners(db)).toEqual([{ number: 1, owner: JSON.stringify(author) }]);
    db.close();
  });

  test('a PR leaving the capped Claude list stays linked; a dismissal or a removed Codex row unlinks', async () => {
    const { db, ledger } = setup();
    const claude = { adapter: 'claude-desktop', id: 'c' };
    const codex = { adapter: 'codex-desktop', id: 'x' };
    await reconcile(ledger, ['lsm/a'], async () => response([node(1), node(2)]), 100);
    const pr = (n: number) => `https://github.com/lsm/a/pull/${n}`;
    ledger.observeSessions(
      [
        facts(claude, { linkedPrs: [{ url: pr(1), own: true }], linkedPrsWindow: true }),
        facts(codex, { linkedPrs: [{ url: pr(2) }] }),
      ],
      101
    );
    ledger.observeSessions(
      [facts(claude, { linkedPrs: [], linkedPrsWindow: true, openedPrs: [pr(2)] })],
      102
    );
    expect(owners(db)).toEqual([
      { number: 1, owner: JSON.stringify(claude) },
      { number: 2, owner: JSON.stringify(codex) },
    ]);
    ledger.observeSessions(
      [
        facts(claude, { linkedPrs: [{ url: pr(1), dismissed: true }], linkedPrsWindow: true }),
        facts(codex, { linkedPrs: [] }),
      ],
      103
    );
    expect(owners(db)).toEqual([
      { number: 1, owner: null },
      { number: 2, owner: null },
    ]);
    db.close();
  });
});

describe('reconcileCodingPrLedger renamed repos', () => {
  test('rows kept under a repo alias are dropped once GitHub answers with another name', async () => {
    const { db, ledger } = setup();
    await reconcile(ledger, ['lsm/neokai'], async () => response([node(7563)]), 100);
    expect(ledger.list().map((row) => row.repo)).toEqual(['lsm/neokai']);
    await reconcileCodingPrLedger(
      ledger,
      ['lsm/hyperneo', 'lsm/neokai'],
      async () => {
        const raw = response([node(7577)]);
        raw.data.repository.nameWithOwner = 'lsm/HyperNeo';
        return raw;
      },
      200
    );
    expect(ledger.list().map((row) => [row.repo, row.number])).toEqual([['lsm/hyperneo', 7577]]);
    db.close();
  });
});

describe('CodingPrLedgerRepository.pruneSessions', () => {
  test('forgets sessions not seen for the keep window, and keeps the owner they gave', async () => {
    const { db, ledger } = setup();
    const ref = { adapter: 'hyperneo', id: 's' };
    await reconcile(ledger, ['lsm/a'], async () => response([node(1)]), 1);
    ledger.observeSessions(
      [
        {
          ref,
          status: 'idle',
          lastActivityAt: 1,
          remotes: ['https://github.com/lsm/a'],
          branches: ['b1'],
          openedPrs: [],
        },
      ],
      1
    );
    await reconcile(ledger, ['lsm/a'], async () => response([node(1)]), CODING_LEDGER_KEEP_MS + 2);
    expect(db.prepare('SELECT ref FROM pack_coding_session_facts').all()).toEqual([]);
    expect(db.prepare('SELECT owner FROM pack_coding_pr_ledger').get()).toEqual({
      owner: JSON.stringify(ref),
    });
    db.close();
  });
});

describe('PR ledger read order', () => {
  test('reads the least recently read repos first, so a low budget does not starve the same repos', async () => {
    const { db, ledger } = setup();
    await reconcile(ledger, ['a/a', 'b/b', 'c/c'], async () => response([node(1)]), 100);
    db.prepare("UPDATE pack_coding_pr_ledger SET read_at = 50 WHERE repo = 'c/c'").run();
    const reads: string[] = [];
    await reconcile(
      ledger,
      ['a/a', 'b/b', 'c/c', 'new/new'],
      async (repo) => {
        reads.push(repo);
        return response([node(1)], [], { remaining: 100, next: false });
      },
      200
    );
    expect(reads).toEqual(['new/new']);
    reads.length = 0;
    await reconcile(
      ledger,
      ['a/a', 'b/b', 'c/c', 'new/new'],
      async (repo) => {
        reads.push(repo);
        return repo === 'c/c' ? { error: 'HTTP 429: Too Many Requests' } : response([node(1)]);
      },
      300
    );
    expect(reads).toEqual(['c/c']);
    db.close();
  });
});

describe('codingPrReplyAt', () => {
  test("takes the PR author's latest comment or review comment, never someone else's", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(
      codingPrReplyAt(
        node(1, {
          author: { login: 'lsm' },
          comments: {
            nodes: [
              { author: { login: 'lsm' }, createdAt: '2026-10-19T08:00:00Z' },
              { author: { login: 'hyperneo-ai-test' }, createdAt: '2026-10-19T09:00:00Z' },
            ],
          },
          replies: { nodes: [{ author: { login: 'lsm' }, submittedAt: '2026-10-19T08:30:00Z' }] },
        }) as never
      )
    ).toBe(at('2026-10-19T08:30:00Z'));
    expect(
      codingPrReplyAt(
        node(1, { author: null, comments: { nodes: [] }, replies: { nodes: [] } }) as never
      )
    ).toBeNull();
  });
});

describe('PR ledger worker replies', () => {
  const replied = (iso: string | null, by = 'lsm') =>
    node(1, {
      author: { login: 'lsm' },
      comments: { nodes: iso ? [{ author: { login: by }, createdAt: iso }] : [] },
    });

  test('a new reply by the PR author restarts the clock and the nudges; a bot comment does not', async () => {
    const { db, ledger } = setup();
    const t = Date.parse('2026-10-19T08:00:00Z');
    const rows = () =>
      db.prepare('SELECT state_since AS since, nudges FROM pack_coding_pr_ledger').get();
    await reconcile(ledger, ['a/a'], async () => response([replied('2026-10-19T07:00:00Z')]), t);
    db.exec('UPDATE pack_coding_pr_ledger SET nudges = 2');
    await reconcile(
      ledger,
      ['a/a'],
      async () => response([replied('2026-10-19T07:00:00Z')]),
      t + 1
    );
    expect(rows()).toEqual({ since: t, nudges: 2 });
    await reconcile(
      ledger,
      ['a/a'],
      async () => response([replied('2026-10-19T08:10:00Z', 'hyperneo-ai-test')]),
      t + 2
    );
    expect(rows()).toEqual({ since: t, nudges: 2 });
    await reconcile(
      ledger,
      ['a/a'],
      async () => response([replied('2026-10-19T08:20:00Z')]),
      t + 3
    );
    expect(rows()).toEqual({ since: Date.parse('2026-10-19T08:20:00Z'), nudges: 0 });
    db.close();
  });

  test('a row from before replies were read takes its first reply without a reset', async () => {
    const { db, ledger } = setup();
    await reconcile(ledger, ['a/a'], async () => response([node(1)]), 100);
    db.exec('UPDATE pack_coding_pr_ledger SET nudges = 1, reply_at = NULL');
    await reconcile(ledger, ['a/a'], async () => response([replied('2026-10-19T08:20:00Z')]), 200);
    expect(
      db
        .prepare(
          'SELECT state_since AS since, nudges, reply_at AS replyAt FROM pack_coding_pr_ledger'
        )
        .get()
    ).toEqual({ since: 100, nudges: 1, replyAt: Date.parse('2026-10-19T08:20:00Z') });
    db.close();
  });

  test('an existing ledger table gains the reply column', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE pack_coding_pr_ledger (repo TEXT, number INTEGER, title TEXT, branch TEXT,
      head TEXT, state TEXT, state_since INTEGER, closed_at INTEGER, owner TEXT,
      nudges INTEGER NOT NULL DEFAULT 0, told_at INTEGER, read_at INTEGER, PRIMARY KEY (repo, number))`);
    createCodingPackTables(db);
    createCodingPackTables(db);
    expect(
      (db.prepare('PRAGMA table_info(pack_coding_pr_ledger)').all() as { name: string }[]).some(
        (column) => column.name === 'reply_at'
      )
    ).toBe(true);
    db.close();
  });
});

describe('codingPrState without CI', () => {
  const approved = (suites: number) =>
    node(1, {
      reviewDecision: 'APPROVED',
      reviews: { nodes: [{ state: 'APPROVED', commit: { oid: 'h1' }, author: { login: 'bot' } }] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: null, checkSuites: { totalCount: suites } } }],
      },
    }) as never;

  test('a CI repo just after a push, or with its run still queued, reads pending', () => {
    expect(codingPrState(approved(1), false, { mergePolicy: 'review_bot', reviewBot: 'bot' })).toBe(
      'approved_pending'
    );
  });

  test('a repo with no CI at all reads green', () => {
    expect(codingPrState(approved(0), false, { mergePolicy: 'review_bot', reviewBot: 'bot' })).toBe(
      'approved_green'
    );
  });

  test('a repo whose CI posts commit statuses reads pending while one PR has no result yet', () => {
    expect(codingPrState(approved(0), true, { mergePolicy: 'review_bot', reviewBot: 'bot' })).toBe(
      'approved_pending'
    );
    const fresh = {
      ...(approved(0) as object),
      number: 2,
    };
    const planned = planCodingLedgerRead(response([node(1), fresh]), 0, () => ({
      mergePolicy: 'review_bot',
      reviewBot: 'bot',
    }));
    expect(planned?.rows.map((row) => [row.number, row.state])).toEqual([
      [1, 'waiting_review'],
      [2, 'approved_pending'],
    ]);
  });
});

describe('CodingPrLedgerRepository.stateOf', () => {
  test('finds a PR by its URL, in any case', async () => {
    const { db, ledger } = setup();
    await reconcile(ledger, ['lsm/a'], async () => response([node(5, { isDraft: true })]), 100);
    expect(ledger.stateOf('https://github.com/LSM/A/pull/5')).toBe('draft');
    expect(ledger.stateOf('https://github.com/lsm/a/pull/6')).toBeNull();
    expect(ledger.stateOf('not a url')).toBeNull();
    db.close();
  });
});

describe('PR ledger snapshot for a renamed repo', () => {
  test('a project registered under the old name still lists the rows kept under the new one', async () => {
    const { db, ledger } = setup();
    await reconcileCodingPrLedger(
      ledger,
      ['lsm/neokai'],
      async () => {
        const raw = response([node(7614)]);
        raw.data.repository.nameWithOwner = 'lsm/HyperNeo';
        return raw;
      },
      100
    );
    expect(ledger.snapshot(['lsm/neokai'], 100).map((row) => row.pr)).toEqual([
      'lsm/hyperneo#7614',
    ]);
    expect(ledger.snapshot(['lsm/other'], 100)).toEqual([]);
    db.close();
  });

  test('lists the repos of one project, or of all projects', () => {
    const { db } = setup();
    for (const id of ['project:a', 'project:b'])
      db.prepare(
        "INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at) VALUES (?, 't', '', '', 1, 1, 1)"
      ).run(id);
    const alias = db.prepare(
      'INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)'
    );
    alias.run('repository:github.com/lsm/neokai', 'project:a');
    alias.run('repository:github.com/lsm/hyperneo-review', 'project:a');
    alias.run('repository:github.com/lsm/ops', 'project:b');
    const repo = new NeoRepository(db);
    expect(repo.allRepositories('project:a')).toEqual(['lsm/hyperneo-review', 'lsm/neokai']);
    expect(repo.allRepositories()).toEqual(['lsm/hyperneo-review', 'lsm/neokai', 'lsm/ops']);
    db.close();
  });
});

test('ledger facts retain terminal state despite missing approval and red CI', () => {
  const now = 10 * CODING_LEDGER_KEEP_MS;
  const planned = planCodingLedgerRead(
    response(
      [],
      [
        node(
          8,
          {
            state: 'MERGED',
            closedAt: new Date(now - 1).toISOString(),
            createdAt: new Date(now - 100).toISOString(),
            author: { login: 'writer', __typename: 'User' },
          },
          'FAILURE'
        ),
      ]
    ),
    now
  );
  expect(planned?.rows).toEqual([
    {
      repo: 'x/x',
      number: 8,
      title: 'PR 8',
      branch: 'b8',
      head: 'h8',
      state: 'merged',
      ci: 'FAILURE',
      replyAt: null,
      closedAt: now - 1,
      createdAt: now - 100,
      authorIsBot: false,
    },
  ]);
});

test('ledger reads repo preferences before same-pack global fallback', () => {
  const { db, ledger } = setup();
  try {
    const save = (pack: string, scope: string, key: string, value: unknown) =>
      db
        .prepare(`INSERT INTO neo_pack_preferences VALUES (?, ?, ?, ?, ?, 'human', 1)`)
        .run(pack, scope ? 'repo' : 'global', scope, key, JSON.stringify(value));
    save('other', '', 'mergePolicy', 'ci_only');
    expect(ledger.policy('x/x')).toEqual({
      mergePolicy: undefined,
      reviewBot: undefined,
      humanSignoff: undefined,
    });
    save('coding', '', 'mergePolicy', 'review_bot');
    save('coding', '', 'reviewBot', 'global-bot');
    save('coding', '', 'humanSignoff', ['global/**']);
    save('coding', 'X/X', 'mergePolicy', 'human');
    save('coding', 'X/X', 'humanSignoff', []);
    expect(ledger.policy('x/x')).toEqual({
      mergePolicy: 'human',
      reviewBot: 'global-bot',
      humanSignoff: [],
    });
    expect(ledger.policy('y/y')).toEqual({
      mergePolicy: 'review_bot',
      reviewBot: 'global-bot',
      humanSignoff: ['global/**'],
    });
  } finally {
    db.close();
  }
});
