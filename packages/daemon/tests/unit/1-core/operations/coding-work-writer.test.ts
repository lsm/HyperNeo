import { afterEach, expect, spyOn, test } from 'bun:test';
import { CodingWorkFactsRepository } from '../../../../src/lib/neo/packs/coding/work-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/ledger/pull/7';
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  createCodingPackTables(db);
  const facts = new CodingWorkFactsRepository(db);
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(
        JSON.stringify({
          url,
          state: 'MERGED',
          headRefOid: 'a'.repeat(40),
          reviews: [{ state: 'APPROVED', commit: { oid: 'a'.repeat(40) } }],
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        })
      ).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    };
  };
  return { db, facts, spawn, calls: () => calls };
}

test('work acquisition and returned coverage do not read through the main repository', async () => {
  const f = fixture();
  const main = spyOn(f.facts, 'read').mockImplementation(() => {
    throw new Error('work coverage read on main repository');
  });
  try {
    const result = await f.facts.refresh(url, f.spawn, () => 100);
    expect(result.view).toMatchObject({ status: 'known', value: { url, review: 'approved' } });
    expect(f.calls()).toBe(1);
  } finally {
    main.mockRestore();
  }
});
