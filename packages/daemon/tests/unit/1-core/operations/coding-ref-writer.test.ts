import { afterEach, expect, spyOn, test } from 'bun:test';
import { CodingRefFactsRepository } from '../../../../src/lib/neo/packs/coding/ref-facts.ts';
import { createCodingRefReader } from '../../../../src/lib/neo/packs/coding/ref-reader.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { codingRefWrites } from '../../../../src/lib/neo/packs/coding/ref-facts-db.ts';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const ref = { owner: 'synthetic', repo: 'refs', number: 7 };
const url = 'https://github.com/synthetic/refs/pull/7';
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  createCodingPackTables(db);
  const facts = new CodingRefFactsRepository(db);
  let calls = 0;
  let state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN';
  let base = 'dev';
  let failed = false;
  let gate = Promise.resolve(0);
  let started: (() => void) | undefined;
  const spawn: SpawnFn = () => {
    calls++;
    started?.();
    return {
      stdout: new Response(
        JSON.stringify({
          data: {
            repository: {
              defaultBranchRef: { name: base },
              issueOrPullRequest: {
                __typename: 'PullRequest',
                url,
                state,
                mergedAt: state === 'MERGED' ? '2026-10-20T10:00:00Z' : null,
                closedAt: null,
                baseRefName: 'dev',
              },
            },
          },
        })
      ).body,
      stderr: new Response(failed ? 'controlled acquisition failure' : '').body,
      exited: gate.then(() => (failed ? 1 : 0)),
      exitCode: null,
      kill: () => {},
    };
  };
  return {
    db,
    facts,
    spawn,
    calls: () => calls,
    data: (next: typeof state, nextBase = 'dev') => {
      state = next;
      base = nextBase;
    },
    fail: () => {
      failed = true;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<number>((done) => {
        release = () => done(0);
      });
      const ready = new Promise<void>((done) => {
        started = done;
      });
      return { ready, release };
    },
  };
}

test('reference acquisition and its terminal-cache check do not read through the main repository', async () => {
  const f = fixture();
  const main = spyOn(f.facts, 'read').mockImplementation(() => {
    throw new Error('reference admission read on main repository');
  });
  try {
    const read = createCodingRefReader(
      () => f.facts,
      f.spawn,
      () => 100
    );
    expect(await read([ref])).toMatchObject([{ url, state: 'OPEN', defaultBase: 'dev' }]);
    expect(f.calls()).toBe(1);
  } finally {
    main.mockRestore();
  }
});

test('aliases and case coalesce into one reference acquisition', async () => {
  const f = fixture();
  f.db
    .prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES (?,?)')
    .run('old/repo', 'synthetic/refs');
  const read = createCodingRefReader(
    () => f.facts,
    f.spawn,
    () => 100
  );
  const results = await read([ref, { owner: 'OLD', repo: 'Repo', number: 7 }]);
  expect(results).toEqual([results[0], results[0]]);
  expect(results[0]).toMatchObject({ url, state: 'OPEN' });
  expect(f.calls()).toBe(1);
});

test('terminal cache reuse preserves observation time and expiry refreshes mutable evidence', async () => {
  const f = fixture();
  let at = 100;
  f.data('MERGED');
  const read = createCodingRefReader(
    () => f.facts,
    f.spawn,
    () => at
  );
  expect(await read([ref])).toMatchObject([{ state: 'MERGED', done: true }]);
  const first = await f.facts.readCurrent(ref, at);
  at = 101;
  expect(await read([ref])).toMatchObject([{ state: 'MERGED' }]);
  expect(await f.facts.readCurrent(ref, at)).toEqual(first);
  expect(f.calls()).toBe(1);
  at = 120100;
  f.data('MERGED', 'main');
  expect(await read([ref])).toMatchObject([{ defaultBase: 'main' }]);
  expect((await f.facts.readCurrent(ref, at)).view).toMatchObject({
    status: 'known',
    observedAt: at,
  });
  expect(f.calls()).toBe(2);
});

test('a stale collector returns the winning observation without overwriting its revision', async () => {
  const f = fixture();
  const held = f.hold();
  const pending = f.facts.refresh(ref, f.spawn, () => 100);
  await held.ready;
  const value: NeoRefState = {
    url,
    kind: 'pr',
    state: 'OPEN',
    at: null,
    done: false,
    closedBy: null,
    defaultBase: 'main',
  };
  try {
    const winner = await gatewayFor(f.db).call(codingRefWrites, 'observe', ref, 0, value, 200);
    held.release();
    expect(await pending).toEqual(winner);
    expect(winner.observationRevision).toBe(1);
    expect(winner.view).toMatchObject({ status: 'known', value: { defaultBase: 'main' } });
    expect(f.calls()).toBe(1);
  } finally {
    held.release();
    await pending;
  }
});

test('failed acquisition retains old evidence without certifying it as fresh', async () => {
  const f = fixture();
  const first = await f.facts.refresh(ref, f.spawn, () => 100);
  const saved = f.db.prepare('SELECT value_json FROM pack_coding_ref_facts').get();
  f.fail();
  const failed = await f.facts.refresh(ref, f.spawn, () => 200);
  expect(failed.view).toMatchObject({
    status: 'unknown',
    reason: 'failed',
    observedAt: 100,
    attemptedAt: 200,
  });
  expect(failed.factRevision).toBe(first.factRevision);
  expect(failed.observationRevision).toBe(2);
  expect(f.db.prepare('SELECT value_json FROM pack_coding_ref_facts').get()).toEqual(saved);
});

test('writer contention retries three times without reacquiring the upstream value', async () => {
  const f = fixture();
  const transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    if (mode !== 'immediate') return transaction(fn, mode);
    const commit = transaction(fn, mode);
    return (...args) => {
      if (++attempts < 3) throw new Error('database is locked');
      return commit(...args);
    };
  }) as typeof f.db.transaction);
  try {
    const results = await Promise.all([
      f.facts.refresh(ref, f.spawn, () => 100),
      f.facts.refresh(ref, f.spawn, () => 100),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].view).toMatchObject({ status: 'known', value: { url } });
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
  }
});

test('persistent writer failure leaves no observation and permits a later retry', async () => {
  const f = fixture();
  const transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    if (mode !== 'immediate') return transaction(fn, mode);
    return () => {
      attempts++;
      throw new Error('database is locked');
    };
  }) as typeof f.db.transaction);
  try {
    await expect(f.facts.refresh(ref, f.spawn, () => 100)).rejects.toThrow('database is locked');
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
    expect((await f.facts.readCurrent(ref, 100)).view).toMatchObject({
      status: 'unknown',
      reason: 'missing',
    });
    fault.mockRestore();
    expect((await f.facts.refresh(ref, f.spawn, () => 200)).view).toMatchObject({
      status: 'known',
      observedAt: 200,
    });
    expect(f.calls()).toBe(2);
  } finally {
    fault.mockRestore();
  }
});
