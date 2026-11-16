import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { expect, spyOn, test } from 'bun:test';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { wakeCodingUnownedPrs } from '../../../../src/lib/neo/packs/coding/pr-unowned.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { runMigration477 } from '../../../../src/storage/schema/m477-work-turns.ts';
import { runMigration480 } from '../../../../src/storage/schema/m480-work-turn-urls.ts';
import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

for (const readOnly of [false, true]) {
  test(`unowned PR wake reads through the gateway with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    for (const db of [main, writer]) {
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, 0);
      runMigration477(db);
      runMigration480(db);
      runMigrations(db, () => {});
      createTables(db);
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
    const raised: unknown[] = [];
    try {
      await wakeCodingUnownedPrs(
        new CodingPrEventRepository(main),
        async (event) => {
          raised.push(event);
          return true;
        },
        10
      );
      expect(raised).toEqual([
        {
          kind: 'coding.pr_unowned',
          subject: { type: 'pr', id: 'synthetic/unowned#1' },
          since: 1,
          facts: {
            text: 'New pull request observed without a known worker owner: synthetic/unowned#1 "New human PR". Check the current ledger before assigning an owner.',
          },
        },
      ]);
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
