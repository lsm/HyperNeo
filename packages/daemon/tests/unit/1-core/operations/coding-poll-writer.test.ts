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

function fixture() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingPollFactsRepository(db);
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json([{ id: 7 }], { headers: { etag: '"page"' } });
  };
  return { db, facts, request, calls: () => calls };
}

test('HTTP page writer retries preserve one acquisition and one observation', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    const commit = transaction(fn, mode);
    return (...args) => {
      if (mode === 'immediate' && !f.db.inTransaction && ++attempts < 3)
        throw new Error('database is locked');
      return commit(...args);
    };
  }) as typeof f.db.transaction);
  try {
    const pages = await Promise.all([
      f.facts.collect(subject, 'cycle', null, f.request, () => 100),
      f.facts.collect(subject, 'cycle', null, f.request, () => 100),
    ]);
    expect(await Promise.all(pages.map((page) => page.json()))).toEqual([[{ id: 7 }], [{ id: 7 }]]);
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
    expect((await f.facts.readCurrent(subject, 100, Infinity)).observationRevision).toBe(1);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('HTTP page writer exhaustion leaves missing coverage and allows a fresh retry', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    const commit = transaction(fn, mode);
    return (...args) => {
      if (mode === 'immediate' && !f.db.inTransaction) {
        attempts++;
        throw new Error('database is locked');
      }
      return commit(...args);
    };
  }) as typeof f.db.transaction);
  try {
    await expect(f.facts.collect(subject, 'cycle', null, f.request, () => 100)).rejects.toThrow(
      'database is locked'
    );
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
    expect((await f.facts.readCurrent(subject, 100, Infinity)).page).toMatchObject({
      status: 'unknown',
      reason: 'missing',
    });
    fault.mockRestore();
    expect(
      await (await f.facts.collect(subject, 'cycle', null, f.request, () => 200)).json()
    ).toEqual([{ id: 7 }]);
    expect(f.calls()).toBe(2);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('external cleanup failure rolls back and prevents the HTTP effect', async () => {
  const f = fixture();
  try {
    f.db
      .prepare(
        'INSERT INTO pack_coding_poll_facts(subject,fact_revision,observation_revision,value_json,attempted_at) VALUES(?,?,?,?,?)'
      )
      .run('["external-event-page:v1:expired"]', 1, 1, '[]', 0);
    f.db.exec(`CREATE TRIGGER reject_page_prune BEFORE DELETE ON pack_coding_poll_facts
      BEGIN SELECT RAISE(ABORT, 'synthetic page cleanup rejection'); END`);
    await expect(
      f.facts.collectExternalEventPage(subject, 'cycle', null, f.request, () => 1000000)
    ).rejects.toThrow('synthetic page cleanup rejection');
    expect(f.calls()).toBe(0);
    expect(f.db.prepare('SELECT count(*) AS n FROM pack_coding_poll_facts').get()).toEqual({
      n: 1,
    });
    f.db.exec('DROP TRIGGER reject_page_prune');
    expect(
      await (
        await f.facts.collectExternalEventPage(subject, 'cycle', null, f.request, () => 1000000)
      ).json()
    ).toEqual([{ id: 7 }]);
    expect(f.calls()).toBe(1);
  } finally {
    f.db.close();
  }
});
