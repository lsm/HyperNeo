import { afterEach, expect, spyOn, test } from 'bun:test';
import { CodingRefFactsRepository } from '../../../../src/lib/neo/packs/coding/ref-facts.ts';
import { createCodingRefReader } from '../../../../src/lib/neo/packs/coding/ref-reader.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
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
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(
        JSON.stringify({
          data: {
            repository: {
              defaultBranchRef: { name: 'dev' },
              issueOrPullRequest: {
                __typename: 'PullRequest',
                url,
                state: 'OPEN',
                mergedAt: null,
                closedAt: null,
                baseRefName: 'dev',
              },
            },
          },
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
