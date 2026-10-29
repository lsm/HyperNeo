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
  return {
    stdout: new Response(JSON.stringify(value)).body,
    stderr: new Response(broken ? 'synthetic read failure' : '').body,
    exited: Promise.resolve(broken ? 1 : 0),
    exitCode: broken ? 1 : 0,
    kill() {},
  };
};
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  fail = '';
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
  test.each(['/labels', '/reviews', 'checks', 'graphql'])(
    'fails closed on an unreadable %s',
    async (part) => {
      fail = part;
      expect((await readCodingDaemonMergeFacts(db, url, spawn)).ok).toBe(false);
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
