import { afterEach, expect, spyOn, test } from 'bun:test';
import { CodingWorkFactsRepository } from '../../../../src/lib/neo/packs/coding/work-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { codingWorkWrites } from '../../../../src/lib/neo/packs/coding/work-facts-db.ts';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
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
  let gate = Promise.resolve(0);
  let started: (() => void) | undefined;
  const spawn: SpawnFn = () => {
    calls++;
    started?.();
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
      exited: gate,
      exitCode: 0,
      kill: () => {},
    };
  };
  return {
    db,
    facts,
    spawn,
    calls: () => calls,
    hold: () => {
      let release!: () => void;
      gate = new Promise<number>((done) => {
        release = () => done(0);
      });
      const ready = new Promise<void>((done) => {
        started = done;
      });
      return { ready, release };
    },
  };
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

test('invalid work URLs remain unknown without an upstream attempt', async () => {
  const f = fixture();
  expect((await f.facts.refresh('invalid', f.spawn, () => 100)).view).toMatchObject({
    status: 'unknown',
    reason: 'missing',
  });
  expect(f.calls()).toBe(0);
});

test('an older collector returns the newer writer observation without incrementing its revision', async () => {
  const f = fixture(),
    held = f.hold();
  const pending = f.facts.refresh(url, f.spawn, () => 100);
  await held.ready;
  try {
    const value: NeoWorkPr = {
      url,
      state: 'OPEN',
      checks: 'passing',
      review: 'none',
      head: 'b'.repeat(40),
    };
    const winner = await gatewayFor(f.db).call(codingWorkWrites, 'observe', url, 0, value, 200);
    held.release();
    expect(await pending).toEqual(winner);
    expect(winner.observationRevision).toBe(1);
    expect(winner.view).toMatchObject({
      status: 'known',
      value: { head: 'b'.repeat(40), review: 'none' },
    });
  } finally {
    held.release();
    await pending;
  }
});

test('a writer failure retains the committed observation and permits a later fresh attempt', async () => {
  const f = fixture();
  const first = await f.facts.refresh(url, f.spawn, () => 100);
  f.db.exec(`CREATE TRIGGER reject_work BEFORE UPDATE ON pack_coding_work_facts
    BEGIN SELECT RAISE(ABORT, 'synthetic work write rejection'); END`);
  await expect(f.facts.refresh(url, f.spawn, () => 200)).rejects.toThrow(
    'synthetic work write rejection'
  );
  expect(await f.facts.readCurrent(url, 200)).toEqual(first);
  expect(f.calls()).toBe(2);
  f.db.exec('DROP TRIGGER reject_work');
  const retry = await f.facts.refresh(url, f.spawn, () => 300);
  expect(retry.view).toMatchObject({ status: 'known', observedAt: 300 });
  expect(retry.observationRevision).toBe(2);
  expect(f.calls()).toBe(3);
});

test('busy writer retries share the acquired value across all callers', async () => {
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
    const results = await Promise.all([
      f.facts.refresh(url, f.spawn, () => 100),
      f.facts.refresh(url, f.spawn, () => 100),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].view).toMatchObject({ status: 'known' });
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
  } finally {
    fault.mockRestore();
  }
});

test('persistent busy exhausts three writer attempts without certifying a missing view', async () => {
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
    await expect(f.facts.refresh(url, f.spawn, () => 100)).rejects.toThrow('database is locked');
    expect(attempts).toBe(3);
    expect(f.calls()).toBe(1);
    expect((await f.facts.readCurrent(url, 100)).view).toMatchObject({
      status: 'unknown',
      reason: 'missing',
    });
    fault.mockRestore();
    expect((await f.facts.refresh(url, f.spawn, () => 200)).view).toMatchObject({
      status: 'known',
      observedAt: 200,
    });
    expect(f.calls()).toBe(2);
  } finally {
    fault.mockRestore();
  }
});
