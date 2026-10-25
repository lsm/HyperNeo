import { expect, spyOn, test } from 'bun:test';
import { CodingQueryFactsRepository } from '../../../../src/lib/neo/packs/coding/query-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
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
