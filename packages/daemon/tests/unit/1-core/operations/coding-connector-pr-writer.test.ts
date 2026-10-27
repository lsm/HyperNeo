import { expect, spyOn, test } from 'bun:test';
import { createCodingConnectorPrReader } from '../../../../src/lib/neo/packs/coding/connector-pr-reader.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/basic/pull/7';
const value = { url, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
const spawn: SpawnFn = () =>
  ({
    stdout: new Response(JSON.stringify(value)).body!,
    stderr: new Response('').body!,
    exited: Promise.resolve(0),
    pid: 12345,
    kill() {},
  }) as ReturnType<SpawnFn>;

for (const readOnly of [false, true]) {
  test(`basic PR observation uses the bound writer with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    createCodingPackTables(main);
    createCodingPackTables(writer);
    writer
      .prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)')
      .run('old/repo', 'synthetic/basic');
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const prepare = main.prepare.bind(main);
    const fault = readOnly
      ? null
      : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
          if (/pack_coding_(poll_facts|repo_aliases)/.test(sql))
            throw new Error('basic PR observation SQL on main');
          return prepare(sql);
        }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    try {
      const read = createCodingConnectorPrReader(
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
