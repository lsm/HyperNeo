import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { readCodingDaemonMergeFacts } from '../../../../src/lib/neo/packs/coding/daemon-merge-facts.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/types.ts';

const url = 'https://github.com/synthetic/merge/pull/1',
  head = 'a'.repeat(40);
let db: Database, fail: string, finalHead: string, labels: unknown, reviews: unknown;
let files: { path: string }[], changedFiles: number;
let calls: string[][], state: string, mergeCommit: { oid: string } | null;
let checksReply: { stdout: string; stderr: string; exit: number } | undefined;
const spawn: SpawnFn = (args) => {
  calls.push(args);
  let value: unknown;
  if (args.includes('graphql'))
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
      state,
      headRefOid: args.at(-1) === 'headRefOid,state' ? finalHead : head,
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
  checksReply = undefined;
  state = 'OPEN';
  mergeCommit = null;
  finalHead = head;
  files = [{ path: 'src/app.ts' }];
  changedFiles = 1;
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
        requiredCi: { head, green: true },
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
    expect(calls.at(-1)).toContain('headRefOid,state');
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
  test.each(['/labels', '/reviews', 'checks', 'graphql'])(
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
  test('keeps truncated file scope unknown instead of declaring it complete', async () => {
    changedFiles = 101;
    expect(await readCodingDaemonMergeFacts(db, url, spawn)).toMatchObject({
      ok: true,
      files: null,
    });
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
