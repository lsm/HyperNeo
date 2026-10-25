import { expect, spyOn, test } from 'bun:test';
import { CodingMergeFactsRepository } from '../../../../src/lib/neo/packs/coding/merge-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createCodingPrStateReader } from '../../../../src/lib/neo/packs/coding/pr-state-reader.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const repo = 'synthetic/ledger';
const value = { state: 'MERGED', mergeCommit: 'c'.repeat(40) } as const;

test('merge acquisition and returned coverage leave the main repository', async () => {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingMergeFactsRepository(db);
  const main = spyOn(facts, 'read').mockImplementation(() => {
    throw new Error('merge coverage read on main repository');
  });
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(
        JSON.stringify({ state: 'MERGED', mergeCommit: { oid: value.mergeCommit } })
      ).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    };
  };
  try {
    const found = await facts.refresh(repo, 7, spawn, () => 100);
    expect(found.merge).toMatchObject({ status: 'known', value, observedAt: 100 });
    expect(calls).toBe(1);
  } finally {
    main.mockRestore();
    db.close();
  }
});

test('explicit merge observations use the bound writer with read-only main', async () => {
  const main = new Database(':memory:'),
    writer = new Database(':memory:');
  createCodingPackTables(main);
  createCodingPackTables(writer);
  main.exec('PRAGMA query_only=ON');
  const gateway = new DbGateway(':memory:', writer);
  bindGateway(main, gateway);
  try {
    await new CodingMergeFactsRepository(main).observeCurrent(
      repo,
      7,
      { value, source: 'synthetic' },
      100,
      0
    );
    expect(
      writer.prepare('SELECT observation_revision FROM pack_coding_merge_facts').get()
    ).toEqual({ observation_revision: 1 });
    expect(main.prepare('SELECT count(*) AS n FROM pack_coding_merge_facts').get()).toEqual({
      n: 0,
    });
  } finally {
    await gateway.close();
    main.close();
    writer.close();
  }
});

function fixture() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingMergeFactsRepository(db);
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(
        JSON.stringify({ state: 'MERGED', mergeCommit: { oid: value.mergeCommit } })
      ).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    };
  };
  return { db, facts, spawn, calls: () => calls };
}

test('forced merge acquisition cannot join a covered non-forced return', async () => {
  const f = fixture();
  try {
    await f.facts.observeCurrent(
      repo,
      7,
      { value: { state: 'OPEN', mergeCommit: null }, source: 'old' },
      100,
      0
    );
    const [cached, fresh] = await Promise.all([
      f.facts.refresh(repo, 7, f.spawn, () => 100),
      f.facts.refresh(repo, 7, f.spawn, () => 100, true),
    ]);
    expect(cached.merge).toMatchObject({ status: 'known', value: { state: 'OPEN' } });
    expect(fresh.merge).toMatchObject({ status: 'known', value });
    expect(f.calls()).toBe(1);
  } finally {
    f.db.close();
  }
});

test('merge writer retries coalesce the acquired observation and stop at three attempts', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
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
    const result = await Promise.all([
      f.facts.refresh(repo, 7, f.spawn, () => 100),
      f.facts.refresh(repo, 7, f.spawn, () => 100),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(result[0].merge).toMatchObject({ status: 'known', value });
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('merge snapshot retries coalesce normalized demands before collection', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    if (mode !== 'deferred') return transaction(fn, mode);
    const read = transaction(fn, mode);
    return (...args) => {
      if (++attempts < 3) throw new Error('database is locked');
      return read(...args);
    };
  }) as typeof f.db.transaction);
  try {
    const result = await Promise.all([
      f.facts.refresh(repo, 7, f.spawn, () => 100),
      f.facts.refresh(repo.toUpperCase(), 7, f.spawn, () => 100),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('merge writer rejection rolls back and a later forced retry can win', async () => {
  const f = fixture();
  try {
    const first = await f.facts.observeCurrent(
      repo,
      7,
      { value: { state: 'OPEN', mergeCommit: null }, source: 'old' },
      100,
      0
    );
    f.db.exec(`CREATE TRIGGER reject_merge BEFORE UPDATE ON pack_coding_merge_facts
      BEGIN SELECT RAISE(ABORT, 'synthetic merge write rejection'); END`);
    await expect(f.facts.refresh(repo, 7, f.spawn, () => 200, true)).rejects.toThrow(
      'synthetic merge write rejection'
    );
    expect(await f.facts.readCurrent(repo, 7, 200, 120000)).toEqual(first.facts);
    f.db.exec('DROP TRIGGER reject_merge');
    expect((await f.facts.refresh(repo, 7, f.spawn, () => 300, true)).observationRevision).toBe(2);
    expect(f.calls()).toBe(2);
    const late = await f.facts.observeCurrent(repo, 7, { reason: 'failed' }, 400, 0);
    expect(late.accepted).toBe(false);
    expect(late.facts.observationRevision).toBe(2);
    expect(late.facts.merge).toMatchObject({ status: 'known', value });
  } finally {
    f.db.close();
  }
});

test('PR-state coverage reads the bound gateway snapshot before deciding to acquire', async () => {
  const main = new Database(':memory:'),
    writer = new Database(':memory:');
  createCodingPackTables(main);
  createCodingPackTables(writer);
  main.exec('PRAGMA query_only=ON');
  const gateway = new DbGateway(':memory:', writer);
  bindGateway(main, gateway);
  try {
    await new CodingMergeFactsRepository(main).observeCurrent(
      repo,
      7,
      { value, source: 'writer' },
      100,
      0
    );
    const read = createCodingPrStateReader(
      () => main,
      () => {
        throw new Error('covered state must not acquire');
      },
      () => 100
    );
    expect(await read(`https://github.com/${repo}/pull/7`)).toEqual({ value: 'MERGED' });
    expect(main.prepare('SELECT count(*) AS n FROM pack_coding_merge_facts').get()).toEqual({
      n: 0,
    });
  } finally {
    await gateway.close();
    main.close();
    writer.close();
  }
});
