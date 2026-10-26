import { expect, spyOn, test } from 'bun:test';
import { CodingQueryFactsRepository } from '../../../../src/lib/neo/packs/coding/query-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { codingQueryReads } from '../../../../src/lib/neo/packs/coding/query-facts-db.ts';
import type { NeoGithubCollection } from '../../../../src/lib/neo/packs/coding/github-query.ts';

const coverage: NeoGithubCollection = {
  repo: 'synthetic/ledger',
  kind: 'pr',
  state: 'merged',
  by: 'merged',
  limit: 2,
};

test('query acquisition and returned coverage leave the main repository', async () => {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingQueryFactsRepository(db);
  const main = spyOn(facts, 'read').mockImplementation(() => {
    throw new Error('query coverage read on main repository');
  });
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response('[]').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    };
  };
  try {
    const result = await facts.refresh(coverage, spawn, () => 100);
    expect(result.view).toMatchObject({ status: 'known', value: [], observedAt: 100 });
    expect(calls).toBe(1);
  } finally {
    main.mockRestore();
    db.close();
  }
});

function fixture() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingQueryFactsRepository(db);
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response('[]').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    };
  };
  return { db, facts, spawn, calls: () => calls };
}

test('query writer retries remain bounded and share the acquired value', async () => {
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
    const results = await Promise.all([
      f.facts.refresh(coverage, f.spawn, () => 100),
      f.facts.refresh(coverage, f.spawn, () => 100),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].view).toMatchObject({ status: 'known', value: [] });
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('query writer exhaustion leaves no certified view and permits a later retry', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    if (mode !== 'immediate') return transaction(fn, mode);
    return () => {
      attempts++;
      throw new Error('database is locked');
    };
  }) as typeof f.db.transaction);
  try {
    await expect(f.facts.refresh(coverage, f.spawn, () => 100)).rejects.toThrow(
      'database is locked'
    );
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
    expect(
      (await gatewayFor(f.db).call(codingQueryReads, 'read', coverage, 100)).view
    ).toMatchObject({ status: 'unknown', reason: 'missing' });
    fault.mockRestore();
    expect((await f.facts.refresh(coverage, f.spawn, () => 200)).view).toMatchObject({
      status: 'known',
      observedAt: 200,
    });
    expect(f.calls()).toBe(2);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('query writer rejection preserves committed coverage and later fresh admission', async () => {
  const f = fixture();
  try {
    const first = await f.facts.refresh(coverage, f.spawn, () => 100);
    f.db.exec(`CREATE TRIGGER reject_query BEFORE UPDATE ON pack_coding_query_facts
      BEGIN SELECT RAISE(ABORT, 'synthetic query write rejection'); END`);
    await expect(f.facts.refresh(coverage, f.spawn, () => 200)).rejects.toThrow(
      'synthetic query write rejection'
    );
    expect(await gatewayFor(f.db).call(codingQueryReads, 'read', coverage, 200)).toEqual(first);
    f.db.exec('DROP TRIGGER reject_query');
    expect((await f.facts.refresh(coverage, f.spawn, () => 300)).observationRevision).toBe(2);
    expect(f.calls()).toBe(3);
  } finally {
    f.db.close();
  }
});
