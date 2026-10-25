import { expect, spyOn, test } from 'bun:test';
import { CodingPollFactsRepository } from '../../../../src/lib/neo/packs/coding/poll-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';

const subject = {
  credentialId: 'synthetic-only',
  url: 'https://api.github.com/repos/synthetic/ledger/pulls?page=1',
  accept: 'application/vnd.github+json',
  apiVersion: '2022-11-28',
};

test('HTTP page collection does not read coverage through the main repository', async () => {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingPollFactsRepository(db);
  const main = spyOn(facts, 'read').mockImplementation(() => {
    throw new Error('poll coverage read on main repository');
  });
  let calls = 0;
  try {
    const response = await facts.collect(
      subject,
      'synthetic-cycle',
      null,
      async () => {
        calls++;
        return Response.json([{ id: 7 }]);
      },
      () => 100
    );
    expect(await response.json()).toEqual([{ id: 7 }]);
    expect(calls).toBe(1);
  } finally {
    main.mockRestore();
    db.close();
  }
});

test('external page cleanup commits on the bound writer before HTTP acquisition', async () => {
  const main = new Database(':memory:'),
    writer = new Database(':memory:');
  createCodingPackTables(main);
  createCodingPackTables(writer);
  main.exec('PRAGMA query_only=ON');
  writer
    .prepare(
      'INSERT INTO pack_coding_poll_facts(subject,fact_revision,observation_revision,value_json,attempted_at) VALUES(?,?,?,?,?)'
    )
    .run('["external-event-page:v1:expired"]', 1, 1, '[]', 0);
  writer
    .prepare(
      'INSERT INTO pack_coding_poll_facts(subject,fact_revision,observation_revision,value_json,attempted_at) VALUES(?,?,?,?,?)'
    )
    .run('["protected"]', 1, 1, '[]', 0);
  const gateway = new DbGateway(':memory:', writer);
  bindGateway(main, gateway);
  let calls = 0;
  try {
    const response = await new CodingPollFactsRepository(main).collectExternalEventPage(
      subject,
      'external-cycle',
      null,
      async () => {
        calls++;
        expect(
          writer.prepare('SELECT subject FROM pack_coding_poll_facts ORDER BY subject').all()
        ).toEqual([{ subject: '["protected"]' }]);
        return Response.json([{ id: 7 }]);
      },
      () => 1000000
    );
    expect(await response.json()).toEqual([{ id: 7 }]);
    expect(calls).toBe(1);
    expect(writer.prepare('SELECT count(*) AS n FROM pack_coding_poll_facts').get()).toEqual({
      n: 2,
    });
    expect(main.prepare('SELECT count(*) AS n FROM pack_coding_poll_facts').get()).toEqual({
      n: 0,
    });
  } finally {
    await gateway.close();
    main.close();
    writer.close();
  }
});
