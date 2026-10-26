import { mkdtempSync, rmSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { spyOn } from 'bun:test';
import { describe, expect, test } from 'bun:test';
import { createCodingWorkPrReader } from '../../../../src/lib/neo/packs/coding/work-reader.ts';
import {
  NEO_SETTLED_PR_READ_MS,
  NEO_WORK_PR_READ_MS,
} from '../../../../src/lib/neo/packs/coding/work-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { afterEach } from 'bun:test';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/ledger/pull/7';
const raw = (head = 'a') => ({
  url,
  state: 'MERGED',
  headRefOid: head.repeat(40),
  reviews: [{ state: 'APPROVED', commit: { oid: 'a'.repeat(40) } }],
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
});

const databases: Database[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function fixture(onDisk = false) {
  const root = onDisk ? mkdtempSync(join(tmpdir(), 'work-ledger-')) : null;
  if (root) roots.push(root);
  const path = root ? join(root, 'facts.db') : ':memory:';
  const db = new Database(path);
  createCodingPackTables(db);
  databases.push(db);
  let calls = 0;
  let data: unknown = raw();
  let code = 0;
  let gate = Promise.resolve(0);
  let clock = Date.now();
  const tick = (ms: number) => {
    clock += ms;
    return clock;
  };
  const spawn: SpawnFn = (args) => {
    calls++;
    const path = String(
      args.find((arg) => typeof arg === 'string' && arg.startsWith('repos/')) ?? ''
    );
    const rest = args[1] === 'api';
    const body = rest
      ? path.includes('check-runs')
        ? { check_runs: [] }
        : path.includes('/status')
          ? { statuses: [] }
          : []
      : data;
    return {
      stdout: new Response(rest || code === 0 ? JSON.stringify(body) : '').body,
      stderr: new Response(code && !rest ? 'HTTP 404: synthetic unavailable' : '').body,
      exited: gate.then(() => (rest ? 0 : code)),
      exitCode: null,
      kill: () => {},
    };
  };
  return {
    read: createCodingWorkPrReader(
      () => db,
      spawn,
      () => clock
    ),
    db,
    path,
    spawn,
    tick,
    now: () => clock,
    calls: () => calls,
    data: (value: unknown, exit = 0) => {
      data = value;
      code = exit;
    },
    hold: () => {
      let finish!: (code: number) => void;
      gate = new Promise((done) => {
        finish = done;
      });
      return () => finish(0);
    },
  };
}

describe('ledger work PR acquisition', () => {
  test('five simultaneous demands share one acquisition without changing their results', async () => {
    const f = fixture(),
      release = f.hold();
    const pending = Promise.all(Array.from({ length: 5 }, () => f.read([url])));
    release();
    const results = await pending;
    expect(results).toEqual(Array.from({ length: 5 }, () => results[0]));
    expect(results[0]?.[0]).toMatchObject({
      state: 'MERGED',
      head: 'a'.repeat(40),
      review: 'approved',
    });
    expect(f.calls()).toBe(1);
  });
  test('each settled human read makes a fresh attempt once the settled TTL passes', async () => {
    const f = fixture();
    expect((await f.read([url]))?.[0].review).toBe('approved');
    f.tick(NEO_SETTLED_PR_READ_MS + 1_000);
    f.data(raw('b'));
    expect((await f.read([url]))?.[0]).toMatchObject({ head: 'b'.repeat(40), review: 'none' });
    f.data({}, 1);
    f.tick(NEO_SETTLED_PR_READ_MS + 1_000);
    expect(await f.read([url])).toBe(null);
    expect(f.calls()).toBe(3);
  });

  test('a settled PR is not re-read while its terminal observation is fresh', async () => {
    const f = fixture();
    expect(await f.read([url])).toBeTruthy();
    f.data(raw('b'));
    f.tick(NEO_WORK_PR_READ_MS + 1_000);
    expect((await f.read([url]))?.[0]).toMatchObject({ head: 'a'.repeat(40) });
    expect(f.calls()).toBe(1);
  });

  test('an open PR is re-read once the short TTL passes, not per caller', async () => {
    const f = fixture();
    f.data({ ...raw(), state: 'OPEN' });
    expect(await f.read([url])).toBeTruthy();
    expect(await f.read([url])).toBeTruthy();
    expect(f.calls()).toBe(3);
    f.tick(NEO_WORK_PR_READ_MS + 1_000);
    expect(await f.read([url])).toBeTruthy();
    expect(f.calls()).toBe(6);
  });

  test('duplicate urls in one demand produce one read', async () => {
    const f = fixture();
    expect(
      await f.read([url, url.toUpperCase(), 'https://github.com/synthetic/ledger/PULL/7'])
    ).toBeTruthy();
    expect(f.calls()).toBe(1);
  });
});

describe('work-view coverage', () => {
  test('local reads distinguish missing, stale, unchanged success and failure without losing the prior view', async () => {
    const f = fixture(),
      facts = new CodingPrLedgerRepository(f.db).workFacts;
    expect(facts.read(url, 100, 10)).toMatchObject({
      coverage: 'work-pr-view',
      view: { status: 'unknown', reason: 'missing' },
    });
    const first = await facts.refresh(url, f.spawn, () => 100);
    expect(first.view).toMatchObject({
      status: 'known',
      value: { head: 'a'.repeat(40) },
      observedAt: 100,
    });
    expect(facts.read(url, 111, 10).view).toMatchObject({ status: 'unknown', reason: 'stale' });
    const unchanged = await facts.refresh(url, f.spawn, () => 200);
    expect(unchanged.factRevision).toBe(first.factRevision);
    expect(unchanged.observationRevision).toBeGreaterThan(first.observationRevision);
    f.data({}, 1);
    const failed = await facts.refresh(url, f.spawn, () => 201);
    expect(failed.view).toMatchObject({
      status: 'unknown',
      reason: 'failed',
      observedAt: 200,
      attemptedAt: 201,
    });
    expect(
      JSON.parse(
        (
          f.db.prepare('SELECT value_json FROM pack_coding_work_facts').get() as {
            value_json: string;
          }
        ).value_json
      )
    ).toMatchObject({ head: 'a'.repeat(40), review: 'approved' });
    f.data(raw('b'));
    const recovered = await facts.refresh(url, f.spawn, () => 300);
    expect(recovered.view).toMatchObject({
      status: 'known',
      value: { head: 'b'.repeat(40), review: 'none' },
    });
    expect(recovered.factRevision).toBeGreaterThan(first.factRevision);
  });
  test('known repo aliases, URL case and fragments share an acquisition across collector instances', async () => {
    const f = fixture(),
      release = f.hold();
    f.db
      .prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)')
      .run('old/repo', 'synthetic/ledger');
    const other = createCodingWorkPrReader(() => f.db, f.spawn);
    const pending = Promise.all([
      f.read([url]),
      other(['https://github.com/OLD/Repo/pull/7#discussion']),
    ]);
    release();
    expect((await pending).map((prs) => prs?.[0].url)).toEqual([url, url]);
    expect(f.calls()).toBe(1);
    expect(
      new CodingPrLedgerRepository(f.db).workFacts.read('https://github.com/old/repo/pull/7').url
    ).toBe(url);
  });
  test('late work reads cannot overwrite a newer observation from another database connection', async () => {
    const f = fixture(true),
      release = f.hold();
    const held = f.read([url]);
    const db = new Database(f.path);
    databases.push(db);
    const fresh: SpawnFn = () => ({
      stdout: new Response(JSON.stringify(raw('b'))).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    });
    const newer = createCodingWorkPrReader(() => db, fresh);
    const current = await newer([url]);
    release();
    expect(await held).toEqual(current);
    expect(current?.[0]).toMatchObject({ head: 'b'.repeat(40), review: 'none' });
    expect(new CodingPrLedgerRepository(db).workFacts.read(url).observationRevision).toBe(1);
  });
  test('reopened storage exposes the same local view while explicit demand still refreshes', async () => {
    const f = fixture(true);
    await f.read([url]);
    const db = new Database(f.path);
    databases.push(db);
    expect(new CodingPrLedgerRepository(db).workFacts.read(url).view).toMatchObject({
      status: 'known',
      value: { head: 'a'.repeat(40) },
    });
    f.data(raw('b'));
    expect((await createCodingWorkPrReader(() => db, f.spawn, f.now)([url]))?.[0]).toMatchObject({
      head: 'a'.repeat(40),
    });
    expect(f.calls()).toBe(1);
    f.tick(NEO_SETTLED_PR_READ_MS + 1_000);
    expect((await createCodingWorkPrReader(() => db, f.spawn, f.now)([url]))?.[0]).toMatchObject({
      head: 'b'.repeat(40),
      review: 'none',
    });
    expect(f.calls()).toBe(2);
  });
  test('transient write contention does not reject coalesced callers or repeat acquisition', async () => {
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
      const result = await Promise.all([f.read([url]), f.read([url])]);
      expect(result[0]).toEqual(result[1]);
      expect(result[0]?.[0]).toMatchObject({ review: 'approved' });
      expect(f.calls()).toBe(1);
    } finally {
      fault.mockRestore();
    }
  });
});

test('public work-detail reads coalesce and retain head, failure and reopen semantics', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'work-ledger-rpc-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/github-ledger-work.ts', import.meta.url)
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
    const result = JSON.parse(readFileSync(join(run, 'evidence/work-ledger.json'), 'utf8'));
    expect(result.verified).toBe(true);
    expect(result.workLookups).toBe(1);
    expect(result.referenceLookups).toBe(0);
    expect(result.fanout).toHaveLength(5);
    expect(result.changed).toMatchObject({
      review: 'none',
      blockers: ['1 unresolved review thread'],
    });
    expect(result.failed).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unreadable'),
    });
    expect(result.counts).toEqual({ initial: 1, changed: 1, 'detail-failed': 1, reopen: 1 });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 30000);
