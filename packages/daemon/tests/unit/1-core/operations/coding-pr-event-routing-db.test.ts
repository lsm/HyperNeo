import { expect, spyOn, test } from 'bun:test';
import {
  CodingPrEventRepository,
  deliverCodingPrEvents,
} from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

for (const readOnly of [false, true]) {
  test(`PR events route from the bound database with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    for (const db of [main, writer]) {
      createNeoPackPreferencesTable(db);
      createCodingPackTables(db, 0);
    }
    const owner = { adapter: 'codex-desktop', id: 'synthetic-owner' };
    const row = {
      repo: 'synthetic/events',
      number: 1,
      title: 'Ready PR',
      branch: 'work',
      head: 'head',
      state: 'merged',
      from: 'waiting_ci',
      since: 1,
      readAt: 1,
      owner: JSON.stringify(owner),
    };
    writer
      .prepare(`INSERT INTO pack_coding_pr_ledger
      (repo,number,title,branch,head,state,state_since,read_at,owner,terminal_event_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        row.repo,
        row.number,
        row.title,
        row.branch,
        row.head,
        row.state,
        row.since,
        row.readAt,
        row.owner,
        JSON.stringify(row)
      );
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const prepare = main.prepare.bind(main);
    const fault = readOnly
      ? null
      : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
          if (/pack_coding_pr_ledger|neo_pack_preferences|pack_coding_repo_aliases/.test(sql))
            throw new Error('PR delivery SQL on main');
          return prepare(sql);
        }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    const events = new CodingPrEventRepository(main),
      attempts: string[] = [];
    let accept = false;
    const deps = {
      tell: async (ref: unknown, key: string, text: string) => {
        expect(ref).toEqual(owner);
        expect(text).toContain('was merged');
        attempts.push(key);
        return accept;
      },
      wake: async () => {
        throw new Error('No unowned wake expected');
      },
    };
    try {
      await deliverCodingPrEvents(events, [], deps);
      expect(attempts).toHaveLength(1);
      accept = true;
      await Promise.all([
        deliverCodingPrEvents(events, [], deps),
        deliverCodingPrEvents(events, [], deps),
      ]);
      expect(attempts).toEqual([attempts[0], attempts[0]]);
      expect(
        writer
          .prepare('SELECT terminal_event_json AS event, told_at AS at FROM pack_coding_pr_ledger')
          .get()
      ).toEqual({ event: null, at: expect.any(Number) });
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
