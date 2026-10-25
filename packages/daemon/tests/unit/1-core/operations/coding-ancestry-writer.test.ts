import { expect, spyOn, test } from 'bun:test';
import { CodingAncestryFactsRepository } from '../../../../src/lib/neo/packs/coding/ancestry-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  gatewayFor,
  bindGateway,
  DbGateway,
} from '../../../../src/storage/db-gateway/db-gateway.ts';
import { codingAncestryReads } from '../../../../src/lib/neo/packs/coding/ancestry-facts-db.ts';
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

function fixture() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingAncestryFactsRepository(db);
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
  return { db, facts, spawn, calls: () => calls };
}

test('ancestry writer retries share one comparison and stop at three attempts', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    if (mode !== 'immediate') return transaction(fn, mode);
    const commit = transaction(fn, mode);
    return (...args) => {
      if (++attempts < 3) throw new Error('database is locked');
      return commit(...args);
    };
  }) as typeof f.db.transaction);
  try {
    const result = await Promise.all([
      f.facts.refresh(subject, f.spawn, () => 100),
      f.facts.refresh(subject, f.spawn, () => 100),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(result[0].ancestry).toMatchObject({ status: 'known', contains: true });
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('ancestry writer exhaustion certifies nothing and a later fresh demand recovers', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    if (mode !== 'immediate') return transaction(fn, mode);
    return () => {
      attempts++;
      throw new Error('database is locked');
    };
  }) as typeof f.db.transaction);
  try {
    await expect(f.facts.refresh(subject, f.spawn, () => 100)).rejects.toThrow(
      'database is locked'
    );
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
    expect(
      (await gatewayFor(f.db).call(codingAncestryReads, 'read', subject)).ancestry
    ).toMatchObject({ status: 'unknown', reason: 'missing' });
    fault.mockRestore();
    expect((await f.facts.refresh(subject, f.spawn, () => 200)).ancestry).toMatchObject({
      status: 'known',
      observedAt: 200,
    });
    expect(f.calls()).toBe(2);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('ancestry writer rejection preserves the previous observation and allows retry', async () => {
  const f = fixture();
  try {
    const before = await f.facts.observeCurrent(subject, { reason: 'partial' }, 100, 0);
    f.db.exec(`CREATE TRIGGER reject_ancestry BEFORE UPDATE ON pack_coding_ancestry_facts
      BEGIN SELECT RAISE(ABORT, 'synthetic ancestry write rejection'); END`);
    await expect(f.facts.refresh(subject, f.spawn, () => 200)).rejects.toThrow(
      'synthetic ancestry write rejection'
    );
    expect(await gatewayFor(f.db).call(codingAncestryReads, 'read', subject)).toEqual(before);
    f.db.exec('DROP TRIGGER reject_ancestry');
    expect((await f.facts.refresh(subject, f.spawn, () => 300)).observationRevision).toBe(2);
    expect(f.calls()).toBe(2);
  } finally {
    f.db.close();
  }
});

test('known negative ancestry remains immutable and failed attempts retain prior status', async () => {
  const f = fixture();
  try {
    const known = await f.facts.observeCurrent(subject, { status: 'behind' }, 100, 0);
    expect(await f.facts.refresh(subject, f.spawn, () => 200)).toEqual(known);
    expect(f.calls()).toBe(0);
    const failed = await f.facts.observeCurrent(subject, { reason: 'failed' }, 300, 1);
    expect(failed.ancestry).toMatchObject({
      status: 'unknown',
      reason: 'failed',
      observedAt: 100,
      attemptedAt: 300,
    });
    expect(failed.factRevision).toBe(known.factRevision);
    expect(f.db.prepare('SELECT status FROM pack_coding_ancestry_facts').get()).toEqual({
      status: 'behind',
    });
    expect((await f.facts.refresh(subject, f.spawn, () => 400)).ancestry).toMatchObject({
      status: 'known',
      comparison: 'ahead',
      contains: true,
    });
  } finally {
    f.db.close();
  }
});

test('ancestry snapshot retries coalesce normalized demands without repeating comparison', async () => {
  const f = fixture(),
    transaction = f.db.transaction.bind(f.db);
  let attempts = 0;
  const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
    if (mode !== 'deferred') return transaction(fn, mode);
    const read = transaction(fn, mode);
    return (...args) => {
      if (++attempts < 3) throw new Error('database is locked');
      return read(...args);
    };
  }) as typeof f.db.transaction);
  try {
    const result = await Promise.all([
      f.facts.refresh(subject, f.spawn, () => 100),
      f.facts.refresh({ ...subject, repo: subject.repo.toUpperCase() }, f.spawn, () => 100),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(result[0].ancestry.status).toBe('known');
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
    f.db.close();
  }
});

test('explicit ancestry observations write only through the bound gateway connection', async () => {
  const main = new Database(':memory:'),
    writer = new Database(':memory:');
  createCodingPackTables(main);
  createCodingPackTables(writer);
  main.exec('PRAGMA query_only=ON');
  const gateway = new DbGateway(':memory:', writer);
  bindGateway(main, gateway);
  try {
    const facts = new CodingAncestryFactsRepository(main);
    await facts.observeCurrent(subject, { status: 'behind' }, 100, 0);
    expect(
      writer.prepare('SELECT status, observation_revision FROM pack_coding_ancestry_facts').get()
    ).toEqual({ status: 'behind', observation_revision: 1 });
    expect(main.prepare('SELECT count(*) AS n FROM pack_coding_ancestry_facts').get()).toEqual({
      n: 0,
    });
  } finally {
    await gateway.close();
    main.close();
    writer.close();
  }
});
