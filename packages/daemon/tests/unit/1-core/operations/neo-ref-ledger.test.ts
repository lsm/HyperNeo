import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingRefReader } from '../../../../src/lib/neo/packs/coding/ref-reader.ts';
import { readGithubRefStates } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

test('public reference and project reads share acquisition without masking failure or changed branch evidence', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'ref-ledger-rpc-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/github-ledger-refs.ts', import.meta.url)
        ),
        run,
      ],
      {
        cwd: run,
        env: {
          HOME: join(run, 'home'),
          PATH: process.env.PATH!,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    const result = JSON.parse(readFileSync(join(run, 'evidence/ref-ledger.json'), 'utf8'));
    expect(result.verified).toBe(true);
    expect(result.fanout).toHaveLength(5);
    expect(result.counts).toEqual({ initial: 1, changed: 1, failed: 1, reopen: 1 });
    expect(result.issueLookups).toBe(1);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 30000);

const ref = { owner: 'synthetic', repo: 'refs', number: 7 };
const url = 'https://github.com/synthetic/refs/pull/7';
const raw = (state = 'OPEN', base = 'dev', number = 7) => ({
  data: {
    repository: {
      defaultBranchRef: { name: base },
      issueOrPullRequest: {
        __typename: 'PullRequest',
        url: `https://github.com/synthetic/refs/pull/${number}`,
        state,
        mergedAt: state === 'MERGED' ? '2026-10-20T10:00:00Z' : null,
        closedAt: null,
        baseRefName: 'dev',
      },
    },
  },
});
const databases: Database[] = [],
  roots: string[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function fixture(disk = false) {
  const root = disk ? mkdtempSync(join(tmpdir(), 'ref-facts-')) : null;
  if (root) roots.push(root);
  const path = root ? join(root, 'facts.db') : ':memory:',
    db = new Database(path);
  databases.push(db);
  createCodingPackTables(db);
  let data: unknown = raw(),
    code = 0,
    error = '',
    calls = 0,
    gate = Promise.resolve(0),
    clock = 100;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(JSON.stringify(data)).body,
      stderr: new Response(error).body,
      exited: gate.then(() => code),
      exitCode: null,
      kill: () => {},
    };
  };
  const facts = new CodingPrLedgerRepository(db).refFacts;
  return {
    db,
    path,
    spawn,
    facts,
    read: createCodingRefReader(
      () => facts,
      spawn,
      () => clock
    ),
    calls: () => calls,
    data: (value: unknown, exit = 0, stderr = '') => {
      data = value;
      code = exit;
      error = stderr;
    },
    now: (time: number) => {
      clock = time;
    },
    hold: () => {
      let release!: (n: number) => void;
      gate = new Promise((done) => {
        release = done;
      });
      return () => release(0);
    },
  };
}

test('coalesced open demands stay fresh on later reads and unavailable is never known empty', async () => {
  const f = fixture(),
    release = f.hold(),
    other = createCodingRefReader(
      () => f.facts,
      f.spawn,
      () => 100
    );
  const held = Promise.all([f.read([ref]), other([ref]), f.read([ref])]);
  release();
  const reads = await held;
  expect(reads).toEqual([reads[0], reads[0], reads[0]]);
  expect(reads[0]).toMatchObject([{ state: 'OPEN', done: false, defaultBase: 'dev' }]);
  expect(f.calls()).toBe(1);
  f.data(raw('CLOSED', 'main'));
  expect(await f.read([ref])).toMatchObject([
    { state: 'CLOSED', done: false, defaultBase: 'main' },
  ]);
  f.data(null, 1);
  expect(await f.read([ref])).toEqual([]);
  expect(f.calls()).toBe(3);
  expect(await f.read([])).toEqual([]);
  expect(f.calls()).toBe(3);
});

test('terminal reuse retains observation time and expires before refreshing the mutable default branch', async () => {
  const f = fixture();
  f.data(raw('MERGED'));
  await f.read([ref]);
  const first = f.facts.read(ref, 100);
  f.now(101);
  expect(await f.read([ref])).toMatchObject([{ state: 'MERGED', defaultBase: 'dev' }]);
  expect(f.facts.read(ref, 101)).toEqual(first);
  expect(f.calls()).toBe(1);
  f.data(raw('MERGED', 'main'));
  f.now(120100);
  expect(await f.read([ref])).toMatchObject([{ state: 'MERGED', defaultBase: 'main' }]);
  expect(f.facts.read(ref, 120100).view).toMatchObject({ status: 'known', observedAt: 120100 });
  expect(f.calls()).toBe(2);
  f.now(240100);
  f.data(null, 1);
  expect(await f.read([ref])).toEqual([]);
  expect(f.facts.read(ref, 240100).view).toMatchObject({
    status: 'unknown',
    reason: 'failed',
    observedAt: 120100,
  });
});

test('a collector source attempt bypasses legacy missing and terminal caches without re-stamping them', async () => {
  const f = fixture(),
    legacyRef = { ...ref, number: 777 };
  f.data(raw('MERGED', 'dev', 777));
  expect(await readGithubRefStates([legacyRef], f.spawn)).toMatchObject([{ defaultBase: 'dev' }]);
  f.data(raw('MERGED', 'main', 777));
  const current = await f.facts.refresh(legacyRef, f.spawn, () => 100);
  expect(current.view).toMatchObject({ status: 'known', value: { defaultBase: 'main' } });
  expect(f.calls()).toBe(2);
  const missing = { ...ref, number: 888 };
  f.data(null, 1, 'Could not resolve to an issue or pull request');
  expect(await readGithubRefStates([missing], f.spawn)).toEqual([]);
  f.data(raw('OPEN', 'dev', 888));
  const recovered = await f.facts.refresh(missing, f.spawn, () => 200);
  expect(recovered.view).toMatchObject({ status: 'known', observedAt: 200 });
  expect(f.calls()).toBe(4);
});

test('local coverage distinguishes stale/failure and preserves issue parent and closing-PR evidence', async () => {
  const f = fixture();
  expect(f.facts.read(ref, 100).view).toMatchObject({ status: 'unknown', reason: 'missing' });
  const node = {
    __typename: 'Issue',
    title: 'Epic',
    url: 'https://github.com/synthetic/refs/issues/7',
    state: 'CLOSED',
    stateReason: 'COMPLETED',
    createdAt: '2026-10-19T10:00:00Z',
    closedAt: '2026-10-20T10:00:00Z',
    parent: { url: 'https://github.com/synthetic/refs/issues/1' },
    timelineItems: { nodes: [{ createdAt: '2026-10-19T11:00:00Z' }] },
    closedByPullRequestsReferences: {
      nodes: [
        { url, merged: true, mergedAt: '2026-10-20T10:00:00Z', baseRefName: 'dev' },
        { url: url + '0', merged: false, baseRefName: 'release' },
      ],
    },
  };
  f.data({ data: { repository: { defaultBranchRef: { name: 'dev' }, issueOrPullRequest: node } } });
  const first = await f.facts.refresh(ref, f.spawn, () => 100);
  expect(first.view).toMatchObject({
    status: 'known',
    value: {
      kind: 'issue',
      title: 'Epic',
      done: true,
      closedBy: url,
      stateReason: 'COMPLETED',
      closingPrs: [url, url + '0'],
      parent: { url: node.parent.url, at: Date.parse('2026-10-19T11:00:00Z') },
      merges: [{ url, base: 'dev', at: Date.parse('2026-10-20T10:00:00Z') }],
    },
  });
  const unchanged = await f.facts.refresh(ref, f.spawn, () => 200);
  expect(unchanged.factRevision).toBe(first.factRevision);
  expect(unchanged.observationRevision).toBeGreaterThan(first.observationRevision);
  expect(f.facts.read(ref, 120200).view).toMatchObject({ status: 'unknown', reason: 'stale' });
  const saved = f.db.prepare('SELECT value_json FROM pack_coding_ref_facts').get();
  f.data({ data: { repository: null } });
  const failed = await f.facts.refresh(ref, f.spawn, () => 300);
  expect(failed.view).toMatchObject({ status: 'unknown', reason: 'failed', observedAt: 200 });
  expect(failed.factRevision).toBe(first.factRevision);
  expect(f.db.prepare('SELECT value_json FROM pack_coding_ref_facts').get()).toEqual(saved);
  f.data(raw());
  expect((await f.facts.refresh(ref, f.spawn, () => 400)).view).toMatchObject({
    status: 'known',
    value: { state: 'OPEN' },
  });
});

test('aliases/case share acquisition and a late cross-connection response cannot replace newer evidence', async () => {
  const f = fixture(true);
  f.db
    .prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)')
    .run('old/repo', 'synthetic/refs');
  const release = f.hold(),
    held = Promise.all([f.read([ref]), f.read([{ owner: 'OLD', repo: 'Repo', number: 7 }])]);
  const db = new Database(f.path);
  databases.push(db);
  const facts = new CodingPrLedgerRepository(db).refFacts;
  const spawn: SpawnFn = () => ({
    stdout: new Response(JSON.stringify(raw('OPEN', 'main'))).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
  });
  const current = await facts.refresh(ref, spawn, () => 200);
  release();
  const result = await held;
  expect(result[0]).toEqual(result[1]);
  expect(result[0]).toMatchObject([{ defaultBase: 'main' }]);
  expect(f.calls()).toBe(1);
  expect(f.facts.read(ref, 200)).toEqual(current);
});

test('reopened terminal facts serve locally without an acquisition or a newer observed timestamp', async () => {
  const f = fixture(true);
  f.data(raw('MERGED'));
  await f.read([ref]);
  const db = new Database(f.path);
  databases.push(db);
  const facts = new CodingPrLedgerRepository(db).refFacts;
  expect(
    await createCodingRefReader(
      () => facts,
      f.spawn,
      () => 101
    )([ref])
  ).toMatchObject([{ state: 'MERGED' }]);
  expect(f.calls()).toBe(1);
  expect(facts.read(ref, 101).view).toMatchObject({ status: 'known', observedAt: 100 });
});

test('transient SQLite contention retries shared persistence without repeating the source', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let failures = 2;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    const commit = transaction(fn, mode);
    return (...args) => {
      if (failures-- > 0)
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return commit(...args);
    };
  }) as typeof f.db.transaction);
  try {
    const results = await Promise.all([f.read([ref]), f.read([ref])]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject([{ state: 'OPEN' }]);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
  }
});
