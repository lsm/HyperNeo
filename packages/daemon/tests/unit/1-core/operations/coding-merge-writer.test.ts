import { expect, spyOn, test } from 'bun:test';
import { CodingMergeFactsRepository } from '../../../../src/lib/neo/packs/coding/merge-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
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
    await new CodingMergeFactsRepository(main).record(
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
