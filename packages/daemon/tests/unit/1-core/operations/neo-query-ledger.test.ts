import { afterEach, expect, spyOn, test } from 'bun:test';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingQueryReader } from '../../../../src/lib/neo/packs/coding/query-reader.ts';
import {
  NeoGithubQuery,
  planNeoGithubQuery,
  queryNeoGithub,
  type NeoGithubCollection,
} from '../../../../src/lib/neo/packs/coding/github-query.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('public bounded queries share acquisition without masking later changed, failed or empty reads', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'query-ledger-rpc-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/github-ledger-query.ts', import.meta.url)
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
    const result = JSON.parse(readFileSync(join(run, 'evidence/query-ledger.json'), 'utf8'));
    expect(result.verified).toBe(true);
    expect(result.fanout).toHaveLength(5);
    expect(result.counts).toEqual({ initial: 1, changed: 1, failed: 1, malformed: 1, empty: 1 });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 30000);

const input = NeoGithubQuery.parse({
  repo: 'synthetic/ledger',
  state: 'merged',
  since: '2026-10-15T10:00:00Z',
  until: '2026-10-15T12:00:00Z',
  limit: 2,
});
const coverage: NeoGithubCollection = { ...input, by: 'merged' };
const raw = (title = 'Current') => [
  {
    number: 7,
    title,
    url: 'https://github.com/synthetic/ledger/pull/7',
    state: 'MERGED',
    createdAt: input.since!,
    updatedAt: input.until!,
    mergedAt: input.until!,
    closedAt: input.until!,
  },
];
const databases: Database[] = [],
  roots: string[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function fixture(disk = false) {
  const root = disk ? mkdtempSync(join(tmpdir(), 'query-facts-')) : null;
  if (root) roots.push(root);
  const path = root ? join(root, 'facts.db') : ':memory:',
    db = new Database(path);
  databases.push(db);
  createCodingPackTables(db);
  let data: unknown = raw(),
    code = 0,
    calls = 0,
    gate = Promise.resolve(0);
  const args: string[][] = [];
  const spawn: SpawnFn = (command) => {
    calls++;
    args.push(command);
    return {
      stdout: new Response(JSON.stringify(data)).body,
      stderr: new Response(code ? 'synthetic failure' : '').body,
      exited: gate.then(() => code),
      exitCode: null,
      kill: () => {},
    };
  };
  return {
    db,
    path,
    spawn,
    args,
    read: createCodingQueryReader(() => db, spawn),
    facts: new CodingPrLedgerRepository(db).queryFacts,
    calls: () => calls,
    data: (next: unknown, exit = 0) => {
      data = next;
      code = exit;
    },
    hold: () => {
      let release!: (code: number) => void;
      gate = new Promise((done) => {
        release = done;
      });
      return () => release(0);
    },
  };
}

test('identical demands across reader instances share acquisition while settled reads remain fresh', async () => {
  const f = fixture(),
    release = f.hold(),
    other = createCodingQueryReader(() => f.db, f.spawn);
  const held = Promise.all([queryNeoGithub(f.read, input), queryNeoGithub(other, input)]);
  release();
  const results = await held;
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ ok: true, items: [{ title: 'Current' }], truncated: false });
  expect(f.calls()).toBe(1);
  f.data(raw('Changed'));
  expect(await queryNeoGithub(f.read, input)).toMatchObject({
    ok: true,
    items: [{ title: 'Changed' }],
  });
  f.data(null, 1);
  expect(await queryNeoGithub(f.read, input)).toMatchObject({
    ok: false,
    reason: expect.stringContaining('unreadable'),
  });
  expect(f.calls()).toBe(3);
});

test('coverage distinguishes repo, kind, state, date field, interval and limit without parsing command text', async () => {
  const f = fixture(),
    release = f.hold();
  const inputs = [
    coverage,
    { ...coverage, repo: 'other/repo' },
    { ...coverage, kind: 'issue' as const, state: 'all' as const, by: 'updated' as const },
    { ...coverage, state: 'all' as const },
    { ...coverage, by: 'created' as const },
    { ...coverage, since: '2026-10-15T10:30:00Z' },
    { ...coverage, until: '2026-10-15T11:30:00Z' },
    { ...coverage, limit: 1 },
  ];
  const held = Promise.all(inputs.map((query) => f.facts.refresh(query, f.spawn)));
  release();
  const facts = await held;
  expect(f.calls()).toBe(inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    expect(facts[i].coverage.query).toEqual(inputs[i]);
    expect(facts[i].view.status).toBe('known');
    const plan = planNeoGithubQuery(inputs[i]);
    expect(f.args[i]).toEqual('value' in plan ? plan.value.args : []);
  }
});

test('known aliases and case coalesce, and relative windows retain the resolved lower bound', async () => {
  const f = fixture(),
    release = f.hold();
  f.db
    .prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)')
    .run('old/repo', 'synthetic/ledger');
  const held = Promise.all([
    f.facts.refresh(coverage, f.spawn),
    f.facts.refresh({ ...coverage, repo: 'OLD/Repo' }, f.spawn),
  ]);
  release();
  expect((await held).map((fact) => fact.coverage.query.repo)).toEqual([
    'synthetic/ledger',
    'synthetic/ledger',
  ]);
  expect(f.calls()).toBe(1);
  const relative = await queryNeoGithub(
    f.read,
    NeoGithubQuery.parse({ repo: input.repo, withinHours: 6 })
  );
  expect(relative.ok).toBe(true);
  if (relative.ok) {
    expect(f.args.at(-1)).toContain(`created:>=${relative.window.since}`);
    expect(Date.parse(relative.window.since!)).toBeLessThan(Date.parse(relative.window.until));
    const rows = f.db.prepare('SELECT subject FROM pack_coding_query_facts').all() as {
      subject: string;
    }[];
    expect(rows.map((row) => JSON.parse(row.subject))).toContainEqual({
      repo: input.repo,
      kind: 'pr',
      state: 'all',
      by: 'created',
      withinHours: 6,
      limit: 50,
    });
  }
});

test('missing, bounded/truncated, stale, failed, unchanged and recovered coverage remains truthful', async () => {
  const f = fixture();
  expect(f.facts.read(coverage, 100, 10).view).toMatchObject({
    status: 'unknown',
    reason: 'missing',
  });
  f.data([...raw(), ...raw('Second'), ...raw('Third')]);
  const first = await f.facts.refresh(coverage, f.spawn, () => 100);
  expect(first).toMatchObject({
    coverage: { kind: 'bounded-query', query: coverage },
    view: { status: 'known', truncated: true, observedAt: 100 },
  });
  expect(f.facts.read(coverage, 111, 10).view).toMatchObject({
    status: 'unknown',
    reason: 'stale',
  });
  const unchanged = await f.facts.refresh(coverage, f.spawn, () => 200);
  expect(unchanged.factRevision).toBe(first.factRevision);
  expect(unchanged.observationRevision).toBeGreaterThan(first.observationRevision);
  for (const data of [null, { items: [] }, [{ number: 7 }]]) {
    f.data(data);
    const failed = await f.facts.refresh(coverage, f.spawn, () => 201);
    expect(failed.view).toMatchObject({
      status: 'unknown',
      reason: 'failed',
      observedAt: 200,
      attemptedAt: 201,
    });
    expect(failed.factRevision).toBe(first.factRevision);
  }
  f.data([]);
  const empty = await f.facts.refresh(coverage, f.spawn, () => 300);
  expect(empty.view).toMatchObject({
    status: 'known',
    value: [],
    truncated: false,
    observedAt: 300,
  });
  expect(empty.factRevision).toBeGreaterThan(first.factRevision);
});

test('a late read cannot overwrite newer facts committed through another connection', async () => {
  const f = fixture(true),
    release = f.hold();
  const held = f.facts.refresh(coverage, f.spawn);
  const db = new Database(f.path);
  databases.push(db);
  const newer = new CodingPrLedgerRepository(db).queryFacts;
  const spawn: SpawnFn = () => ({
    stdout: new Response(JSON.stringify(raw('Newer'))).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
  });
  const current = await newer.refresh(coverage, spawn);
  release();
  expect(await held).toEqual(current);
  expect(f.facts.read(coverage).view).toMatchObject({
    status: 'known',
    value: [{ title: 'Newer' }],
  });
  expect(f.facts.read(coverage).observationRevision).toBe(1);
});

test('reopened storage retains known facts but a new demand still refreshes', async () => {
  const f = fixture(true);
  await f.facts.refresh(coverage, f.spawn);
  const db = new Database(f.path);
  databases.push(db);
  expect(new CodingPrLedgerRepository(db).queryFacts.read(coverage).view).toMatchObject({
    status: 'known',
    value: [{ title: 'Current' }],
  });
  f.data(raw('After reopen'));
  expect(
    await queryNeoGithub(
      createCodingQueryReader(() => db, f.spawn),
      input
    )
  ).toMatchObject({ ok: true, items: [{ title: 'After reopen' }] });
  expect(f.calls()).toBe(2);
});

test('transient SQLite contention retries persistence without repeating shared acquisition', async () => {
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
    const results = await Promise.all([
      f.facts.refresh(coverage, f.spawn),
      f.facts.refresh(coverage, f.spawn),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].view).toMatchObject({ status: 'known', value: [{ title: 'Current' }] });
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
  }
});

for (const mode of ['relative', 'growth']) {
  test(`public relative query ${mode} shares coverage without per-call row growth`, () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'relative-query-rpc-')));
    mkdirSync(join(run, 'home'));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/github-ledger-query.ts',
              import.meta.url
            )
          ),
          run,
          mode,
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
      const result = JSON.parse(readFileSync(join(run, 'evidence/query-ledger.json'), 'utf8'));
      expect(result.verified).toBe(true);
      expect(result.rows).toHaveLength(1);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 30000);
}

test('rolling windows retain the actual winning interval and reject a late earlier interval', async () => {
  const f = fixture(true),
    release = f.hold();
  const older = { ...coverage, withinHours: 3 },
    newer = { ...older, since: '2026-10-15T10:30:00Z' };
  const held = f.facts.refresh(older, f.spawn, () => 100);
  const db = new Database(f.path);
  databases.push(db);
  const facts = new CodingPrLedgerRepository(db).queryFacts;
  const spawn: SpawnFn = () => ({
    stdout: new Response(JSON.stringify(raw('Newer'))).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
  });
  const current = await facts.refresh(newer, spawn, () => 200);
  release();
  expect(await held).toEqual(current);
  expect(current.coverage.query.since).toBe(newer.since);
  f.data(null, 1);
  const failed = await f.facts.refresh(
    { ...newer, since: '2026-10-15T11:00:00Z' },
    f.spawn,
    () => 300
  );
  expect(failed.view).toMatchObject({ status: 'unknown', reason: 'failed', observedAt: 200 });
  expect(failed.coverage.query.since).toBe(newer.since);
  const distinct = await f.facts.refresh({ ...newer, withinHours: 6 }, spawn, () => 400);
  expect(distinct.coverage.query.withinHours).toBe(6);
  expect(f.facts.read(newer, 200).coverage.query.withinHours).toBe(3);
  const rows = db.prepare('SELECT count(*) AS n FROM pack_coding_query_facts').get() as {
    n: number;
  };
  expect(rows.n).toBe(2);
});
