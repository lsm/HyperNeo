import { expect, spyOn, test } from 'bun:test';
import { CodingAncestryFactsRepository } from '../../../../src/lib/neo/packs/coding/ancestry-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const subject = { repo: 'synthetic/ledger', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) };

test('ancestry acquisition and returned coverage leave the main repository', async () => {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingAncestryFactsRepository(db);
  const main = spyOn(facts, 'read').mockImplementation(() => {
    throw new Error('ancestry coverage read on main repository');
  });
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(JSON.stringify({ status: 'ahead' })).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    };
  };
  try {
    const result = await facts.refresh(subject, spawn, () => 100);
    expect(result.ancestry).toMatchObject({
      status: 'known',
      comparison: 'ahead',
      contains: true,
      observedAt: 100,
    });
    expect(calls).toBe(1);
  } finally {
    main.mockRestore();
    db.close();
  }
});
