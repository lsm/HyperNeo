import { expect, spyOn, test } from 'bun:test';
import { codingConnectorIdentityReads } from '../../../../src/lib/neo/packs/coding/connector-identity-db.ts';
import { createCodingReviewThreadReader } from '../../../../src/lib/neo/packs/coding/connector-review-thread-reader.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/threads/pull/7';
const value = { headOid: 'a'.repeat(40), unresolvedThreadUrls: [] };
const spawn: SpawnFn = () =>
  ({
    stdout: new Response(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              url,
              headRefOid: value.headOid,
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      })
    ).body!,
    stderr: new Response('').body!,
    exited: Promise.resolve(0),
    pid: 12345,
    kill() {},
  }) as ReturnType<SpawnFn>;

for (const readOnly of [false, true]) {
  test(`review-thread commands use the bound gateway with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    createCodingPackTables(main);
    createCodingPackTables(writer);
    writer
      .prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)')
      .run('old/repo', 'synthetic/threads');
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const prepare = main.prepare.bind(main);
    const fault = readOnly
      ? null
      : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
          if (/pack_coding_(poll_facts|repo_aliases)/.test(sql))
            throw new Error('review-thread SQL on main');
          return prepare(sql);
        }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    try {
      const read = createCodingReviewThreadReader(
        () => main,
        spawn,
        () => 100
      );
      expect(await read(readOnly ? url : 'https://github.com/OLD/REPO/pull/7', '/tmp')).toEqual({
        ok: true,
        data: value,
      });
      expect(
        writer.prepare('SELECT observation_revision FROM pack_coding_poll_facts').all()
      ).toEqual([{ observation_revision: 1 }]);
      fault?.mockRestore();
      expect(main.prepare('SELECT count(*) AS n FROM pack_coding_poll_facts').get()).toEqual({
        n: 0,
      });
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}

for (const [input, expected] of [
  ['OLD/REPO', 'synthetic/threads'],
  ['NEW/REPO', 'new/repo'],
]) {
  test(`connector identity canonicalizes mixed-case ${input}`, async () => {
    const db = new Database(':memory:');
    createCodingPackTables(db);
    db.prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)').run(
      'old/repo',
      'Synthetic/Threads'
    );
    const gateway = new DbGateway(':memory:', db);
    try {
      expect(await gateway.call(codingConnectorIdentityReads, 'canonical', input)).toBe(expected);
    } finally {
      await gateway.close();
      db.close();
    }
  });
}
