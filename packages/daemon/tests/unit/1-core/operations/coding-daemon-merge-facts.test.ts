import {
  createCodingTodoPack,
  CodingTodoPrRepository,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTrackerMirrorRepository } from '../../../../src/storage/repositories/neo-tracker-mirror.ts';
import { decideCodingDaemonMerge } from '../../../../src/lib/neo/packs/coding/daemon-merge-gates.ts';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { readCodingDaemonMergeFacts } from '../../../../src/lib/neo/packs/coding/daemon-merge-facts.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/types.ts';

const url = 'https://github.com/synthetic/merge/pull/1',
  head = 'a'.repeat(40),
  base = 'd'.repeat(40);
let db: Database, fail: string, finalHead: string, labels: unknown, reviews: unknown;
let files: { path: string }[], changedFiles: number;
let completeFiles: string[] | undefined;
let finalBase: string;
let pageBase: string;
let calls: string[][], state: string, mergeCommit: { oid: string } | null;
let closingIssues: { url: string }[];
let checksReply: { stdout: string; stderr: string; exit: number } | undefined;
const spawn: SpawnFn = (args) => {
  calls.push(args);
  let value: unknown;
  if (args.some((arg) => arg.includes('CodingMergeFiles'))) {
    const pages = completeFiles
      ? [completeFiles.slice(0, 100), completeFiles.slice(100)]
      : [files.map((file) => file.path)];
    value = pages.map((paths, i) => ({
      data: {
        repository: {
          pullRequest: {
            headRefOid: head,
            baseRefOid: pageBase,
            files: {
              nodes: paths.map((path) => ({ path })),
              pageInfo: { hasNextPage: i < pages.length - 1, endCursor: String(i) },
            },
          },
        },
      },
    }));
  } else if (args.includes('graphql'))
    value = {
      data: {
        repository: {
          pullRequest: {
            url,
            headRefOid: head,
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    };
  else if (args.some((a) => a.endsWith('/labels'))) value = labels;
  else if (args.some((a) => a.endsWith('/reviews'))) value = reviews;
  else if (args[2] === 'checks')
    value = [{ name: 'Required', bucket: 'pass', link: url + '/checks' }];
  else
    value = {
      url,
      body: '',
      closingIssuesReferences: closingIssues,
      state,
      headRefOid: args.at(-1)!.startsWith('headRefOid,state') ? finalHead : head,
      baseRefOid: args.at(-1)!.startsWith('headRefOid,state') ? finalBase : base,
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      author: { login: 'author' },
      changedFiles,
      files,
      labels: [],
      mergeCommit,
    };
  const broken = !!fail && args.some((a) => a.includes(fail));
  const reply = args[2] === 'checks' ? checksReply : undefined;
  return {
    stdout: new Response(reply?.stdout ?? JSON.stringify(value)).body,
    stderr: new Response(reply?.stderr ?? (broken ? 'synthetic read failure' : '')).body,
    exited: Promise.resolve(reply?.exit ?? (broken ? 1 : 0)),
    exitCode: reply?.exit ?? (broken ? 1 : 0),
    kill() {},
  };
};
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  fail = '';
  closingIssues = [];
  checksReply = undefined;
  state = 'OPEN';
  mergeCommit = null;
  finalHead = head;
  finalBase = base;
  pageBase = base;
  files = [{ path: 'src/app.ts' }];
  changedFiles = 1;
  completeFiles = undefined;
  calls = [];
  labels = [[{ name: 'bug' }], [{ name: 'human-merge' }]];
  reviews = [
    [
      {
        state: 'APPROVED',
        commit_id: head,
        html_url: url + '#review',
        user: { login: 'bot', type: 'Bot' },
      },
    ],
  ];
});
afterEach(() => db.close());

describe('readCodingDaemonMergeFacts', () => {
  test.each(['no required checks', 'no checks'])(
    'reads gh explicit %s exit 1 as a known empty set',
    async (diagnostic) => {
      checksReply = {
        stdout: '',
        stderr: `${diagnostic} reported on the 'fixture' branch\n`,
        exit: 1,
      };
      expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
        ok: true,
        head,
        requiredCi: { head, green: true, count: 0 },
      });
    }
  );
  test.each([
    { stdout: '', stderr: '', exit: 1 },
    { stdout: '', stderr: 'gh: HTTP 401', exit: 1 },
    { stdout: '', stderr: 'gh: HTTP 403', exit: 1 },
    { stdout: '', stderr: 'gh: HTTP 502', exit: 1 },
    { stdout: '', stderr: 'gh: HTTP 504', exit: 1 },
    { stdout: '[]', stderr: "no checks reported on the 'fixture' branch\n", exit: 1 },
    { stdout: '', stderr: "no checks reported on the 'fixture' branch\n", exit: 2 },
    { stdout: '', stderr: "gh: HTTP 502\nno checks reported on the 'fixture' branch\n", exit: 1 },
    { stdout: '', stderr: "no checks reported on the 'fixture' branch\ngh: HTTP 504", exit: 1 },
    { stdout: 'not json', stderr: '', exit: 0 },
    { stdout: '', stderr: '', exit: 0 },
    {
      stdout: 'not json',
      stderr: "no required checks reported on the 'fixture' branch\n",
      exit: 1,
    },
    { stdout: '', stderr: "no required checks reported on the 'fixture' branch\n", exit: 2 },
    {
      stdout: '',
      stderr: "gh: HTTP 403\nno required checks reported on the 'fixture' branch\n",
      exit: 1,
    },
  ])('keeps an unreadable checks response closed: %j', async (reply) => {
    checksReply = reply;
    expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({ ok: false });
  });
  test('reads all labels and review pages before returning facts on the final head', async () => {
    const facts = await readCodingDaemonMergeFacts(db, url, spawn);
    expect(facts).toMatchObject({
      ok: true,
      head,
      labels: ['bug', 'human-merge'],
      reviews: [{ login: 'bot', head, state: 'APPROVED' }],
      requiredCi: { head, green: true },
      threads: { head, unresolved: 0 },
    });
    expect(calls.at(-1)).toContain('headRefOid,state,baseRefOid');
  });
  test('accepts a mixed-case GitHub hostname without GH_HOST', async () => {
    const configured = process.env.GH_HOST;
    delete process.env.GH_HOST;
    try {
      const canonical = await readCodingDaemonMergeFacts(db, url, spawn);
      expect(canonical.ok).toBe(true);
      expect(
        await readCodingDaemonMergeFacts(db, url.replace('github.com', 'GitHub.com'), spawn)
      ).toEqual(canonical);
    } finally {
      if (configured === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = configured;
    }
  });
  test.each(['/labels', '/reviews', 'CodingMergeFiles', 'checks', 'graphql'])(
    'fails closed on an unreadable %s',
    async (part) => {
      fail = part;
      expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('synthetic read failure'),
      });
    }
  );
  test('rejects missing pages and a head changed during acquisition', async () => {
    labels = { error: 'not a complete labels collection' };
    expect((await readCodingDaemonMergeFacts(db, url, spawn)).ok).toBe(false);
    labels = [];
    expect((await readCodingDaemonMergeFacts(db, url, spawn)).ok).toBe(false);
    labels = [[]];
    finalHead = 'b'.repeat(40);
    expect((await readCodingDaemonMergeFacts(db, url, spawn)).ok).toBe(false);
  });
  test('returns a confirmed merge commit for later receipt recovery', async () => {
    state = 'MERGED';
    mergeCommit = { oid: 'c'.repeat(40) };
    expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
      ok: true,
      state: 'MERGED',
      head,
      mergeCommit: 'c'.repeat(40),
    });
  });
  test('explains malformed GitHub data without relying on a core refusal entry', async () => {
    labels = null;
    const result = await readCodingDaemonMergeFacts(db, url, spawn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/: .+/);
  });
  test('fails closed if the filenames-only reply exceeds the output cap', async () => {
    completeFiles = ['x'.repeat(1_100_000)];
    expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('files:'),
    });
  });
  test('refuses file pages bound to another base', async () => {
    pageBase = 'e'.repeat(40);
    expect((await readCodingDaemonMergeFacts(db, url, spawn)).ok).toBe(false);
  });
  test('refuses a changed base even when the head and state stay unchanged', async () => {
    finalBase = 'e'.repeat(40);
    expect((await readCodingDaemonMergeFacts(db, url, spawn)).ok).toBe(false);
  });
  test('duplicate pages cannot complete a truncated file scope', async () => {
    completeFiles = Array.from({ length: 171 }, (_, i) => `src/file-${i}.ts`);
    completeFiles[170] = completeFiles[0];
    files = completeFiles.slice(0, 100).map((path) => ({ path }));
    changedFiles = completeFiles.length;
    expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
      ok: true,
      files: null,
      fileScopePaginated: false,
    });
  });
  test('keeps truncated file scope unknown instead of declaring it complete', async () => {
    changedFiles = 101;
    expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
      ok: true,
      files: null,
      fileScopePaginated: false,
    });
  });
  test('reads every changed path when pr view truncates at 100 files', async () => {
    completeFiles = Array.from({ length: 171 }, (_, i) => `src/file-${i}.ts`);
    files = completeFiles.slice(0, 100).map((path) => ({ path }));
    changedFiles = completeFiles.length;
    expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
      ok: true,
      files: completeFiles,
      fileScopePaginated: true,
    });
    const fileCall = calls.find((args) => args.some((arg) => arg.includes('CodingMergeFiles')))!;
    const query = fileCall.find((arg) => arg.startsWith('query='))!;
    expect(query).toMatch(/nodes\s*{\s*path\s*}/);
    expect(query).not.toContain('patch');
    expect(fileCall).toEqual(
      expect.arrayContaining([
        'gh',
        'api',
        'graphql',
        '--hostname',
        'github.com',
        '--paginate',
        '--slurp',
        'owner=synthetic',
        'name=merge',
        'number=1',
      ])
    );
  });
});

test('daemon merge receipts preserve executor/head/time and acknowledge only completed merges', async () => {
  const ledger = new CodingPrLedgerRepository(db);
  expect(
    await ledger.write('daemonMerge', {
      kind: 'begin',
      url,
      head,
      actor: 'daemon:synthetic',
      at: 1,
    })
  ).toMatchObject([
    { url, head, actor: 'daemon:synthetic', startedAt: 1, mergeCommit: null, mergedAt: null },
  ]);
  expect(
    await ledger.write('daemonMerge', { kind: 'begin', url, head, actor: 'other', at: 2 })
  ).toEqual([]);
  expect(await ledger.write('daemonMerge', { kind: 'notified', url, head, at: 3 })).toEqual([]);
  expect(
    await ledger.write('daemonMerge', { kind: 'finish', url, head, commit: 'c'.repeat(40), at: 4 })
  ).toMatchObject([
    { actor: 'daemon:synthetic', startedAt: 1, mergedAt: 4, mergeCommit: 'c'.repeat(40) },
  ]);
  expect(
    await ledger.write('daemonMerge', { kind: 'finish', url, head, commit: 'd'.repeat(40), at: 5 })
  ).toEqual([]);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toHaveLength(1);
  await ledger.write('daemonMerge', { kind: 'notified', url, head, at: 6 });
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
});

function mirroredTodo() {
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'synthetic',
    originMessageId: null,
    title: 'Plan',
    request: 'Work',
    createdAt: 1,
  });
  store.addTodo(
    'todo',
    'ask',
    {
      title: 'Step',
      instruction: 'Work',
      named: null,
      doneWhen: 'Merged',
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
    },
    2,
    'synthetic/merge'
  );
  db.prepare(
    "INSERT INTO neo_pack_preferences VALUES ('coding','repo','synthetic/merge','mirror_issues','true','human',1)"
  ).run();
  const mirrors = new NeoTrackerMirrorRepository(db);
  for (const ownerKind of ['ask', 'todo'] as const)
    mirrors.put({
      ownerKind,
      ownerId: ownerKind,
      tracker: 'github-issues',
      home: 'synthetic/merge',
      ref: `synthetic/merge#${ownerKind === 'ask' ? 20 : 21}`,
      parentRef: null,
      state: 'bound',
      failures: 0,
      updatedAt: 3,
    });
  labels = [[]];
}
const mirrorPolicy = {
  mergeBy: 'daemon',
  mergePolicy: 'review_bot',
  reviewBot: 'bot',
} as const;

test('no closing reference to the todo issue refuses the merge', async () => {
  mirroredTodo();
  const facts = await readCodingDaemonMergeFacts(db, url, spawn);
  expect(decideCodingDaemonMerge(facts, mirrorPolicy)).toMatchObject({
    kind: 'skip',
    reason: expect.stringContaining('linked_issue_required:'),
  });
});

test.each([20, 21])(
  'a closing reference to child or parent issue %s admits the merge',
  async (number) => {
    mirroredTodo();
    closingIssues = [{ url: `https://github.com/Synthetic/Merge/issues/${number}` }];
    expect(
      decideCodingDaemonMerge(await readCodingDaemonMergeFacts(db, url, spawn), mirrorPolicy)
    ).toEqual({ kind: 'merge', head });
  }
);

test('a closing reference to the same issue number in another repository refuses the merge', async () => {
  mirroredTodo();
  closingIssues = [{ url: 'https://github.com/other/repo/issues/21' }];
  expect(
    decideCodingDaemonMerge(await readCodingDaemonMergeFacts(db, url, spawn), mirrorPolicy).kind
  ).toBe('skip');
});

test('an early closed mirror issue finishes nothing', async () => {
  mirroredTodo();
  const store = new NeoAskTodoRepository(db);
  db.prepare("UPDATE neo_todos SET state='doing' WHERE id='todo'").run();
  const mirrors = new NeoTrackerMirrorRepository(db);
  const row = mirrors.facts().mirrors.find((row) => row.ownerId === 'todo')!;
  mirrors.put({ ...row, state: 'closed' });
  const pack = createCodingTodoPack(new CodingTodoPrRepository(db), async () => [
    { url, state: 'OPEN', checks: 'passing', review: 'approved', head },
  ]);
  expect(await pack.check(store.getTodo('todo')!)).toMatchObject({ done: false });
  expect(store.getTodo('todo')?.state).toBe('doing');
});

test('a closing reference to a cross-repository parent admits the merge', async () => {
  mirroredTodo();
  const mirrors = new NeoTrackerMirrorRepository(db);
  const parent = mirrors.facts().mirrors.find((row) => row.ownerKind === 'ask')!;
  mirrors.put({ ...parent, home: 'other/plan', ref: 'other/plan#20' });
  closingIssues = [{ url: 'https://github.com/other/plan/issues/20' }];
  expect(
    decideCodingDaemonMerge(await readCodingDaemonMergeFacts(db, url, spawn), mirrorPolicy)
  ).toEqual({ kind: 'merge', head });
});

test('irrelevant mirrors add zero PR ownership reads', () => {
  mirroredTodo();
  const store = new NeoAskTodoRepository(db);
  const mirrors = new NeoTrackerMirrorRepository(db);
  for (const id of ['missing', 'disabled', 'capped', 'retired']) {
    store.openAsk({
      id: `${id}-ask`,
      projectId: null,
      sessionId: 'synthetic',
      originMessageId: null,
      title: id,
      request: 'Work',
      createdAt: 1,
    });
    store.addTodo(
      id,
      `${id}-ask`,
      {
        title: id,
        instruction: 'Work',
        named: null,
        doneWhen: 'Merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
      },
      2,
      'synthetic/merge'
    );
    if (id !== 'missing')
      mirrors.put({
        ownerKind: 'todo',
        ownerId: id,
        tracker: 'github-issues',
        home: id === 'disabled' ? 'synthetic/off' : 'synthetic/merge',
        ref: null,
        parentRef: null,
        state: id === 'retired' ? 'closed' : 'creating',
        failures: id === 'capped' ? 3 : 0,
        updatedAt: 3,
      });
  }
  const repo = new CodingTodoPrRepository(db);
  const ownership = spyOn(repo, 'linked');
  try {
    expect(repo.linkedIssues(url)).toHaveLength(1);
    expect(ownership.mock.calls.map(([id]) => id)).toEqual(['todo']);
  } finally {
    ownership.mockRestore();
  }
});
