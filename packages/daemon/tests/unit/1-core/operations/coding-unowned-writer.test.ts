import { expect, spyOn, test } from 'bun:test';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { wakeCodingUnownedPrs } from '../../../../src/lib/neo/packs/coding/pr-unowned.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

for (const readOnly of [false, true]) {
  test(`unowned PR wake commits its reservation on the writer with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    for (const db of [main, writer]) {
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, 0);
    }
    writer
      .prepare(`INSERT INTO pack_coding_pr_ledger
      (repo,number,title,branch,head,state,state_since,read_at,created_at,author_is_bot)
      VALUES ('synthetic/unowned',1,'New human PR','work','head','unreviewed',1,10,1,0)`)
      .run();
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const prepare = main.prepare.bind(main);
    const fault = readOnly
      ? null
      : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
          if (/pack_coding_|neo_pack_preferences/.test(sql))
            throw new Error('Unowned PR SQL on main');
          return prepare(sql);
        }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    const attempts: string[] = [];
    let accept = false;
    try {
      const repo = new CodingPrEventRepository(main);
      const wake = async (key: string, text: string) => {
        expect(text).toContain('synthetic/unowned#1');
        expect(writer.prepare('SELECT count(*) AS n FROM pack_coding_pr_unowned').get()).toEqual({
          n: 1,
        });
        expect(
          writer.prepare('SELECT pending_key AS key FROM pack_coding_pr_unowned_state').get()
        ).toEqual({ key });
        attempts.push(key);
        return accept;
      };
      await wakeCodingUnownedPrs(repo, wake, 10);
      expect(attempts).toHaveLength(1);
      accept = true;
      await wakeCodingUnownedPrs(repo, wake, 10);
      expect(attempts).toEqual([attempts[0], attempts[0]]);
      await wakeCodingUnownedPrs(repo, wake, 10);
      expect(attempts).toHaveLength(2);
      expect(
        writer.prepare('SELECT pending_key AS key FROM pack_coding_pr_unowned_state').get()
      ).toEqual({ key: null });
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
