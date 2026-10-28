import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { resetHumanDevices } from '../../../../src/storage/repositories/human-device-reset-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { Statement } from '../../../../src/storage/sqlite-node';

const legacySql =
  'INSERT OR IGNORE INTO neo_conversation (singleton, id, created_at) VALUES (1, ?, ?)';
type Row = { singleton: number; id: string; created_at: number } | null;
type Trace = {
  sql: string;
  args: unknown[];
  changes: number;
  lastInsertRowid: number | bigint;
  row: Row;
};

describe('conversation reservation extraction', () => {
  let actual: Database;
  let reference: Database;
  const clock = 1_000_000;
  const row = (db: Database): Row =>
    (db.prepare('SELECT singleton, id, created_at FROM neo_conversation').get() as Row) ?? null;
  const capture = (db: Database) => {
    const traces: Trace[] = [];
    const prepare = db.prepare;
    db.prepare = function <TRow = unknown, TParams extends unknown[] = unknown[]>(
      ...args: Parameters<Database['prepare']>
    ) {
      const statement = Reflect.apply(prepare, this, args) as Statement<TRow, TParams>;
      if (args[0] !== legacySql) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== 'run') return typeof value === 'function' ? value.bind(target) : value;
          return (...values: unknown[]) => {
            const result = target.run(...values);
            traces.push({
              sql: args[0],
              args: values,
              changes: result.changes,
              lastInsertRowid: result.lastInsertRowid,
              row: row(db),
            });
            return result;
          };
        },
      });
    };
    return traces;
  };
  const bind = (db: Database, id: string) =>
    db
      .prepare(
        'INSERT INTO neo_session_bindings (session_id, concern_id, kind) VALUES (?, NULL, ?)'
      )
      .run(`neo:${id}`, 'neo');
  beforeEach(() => {
    actual = new Database(':memory:');
    reference = new Database(':memory:');
    for (const db of [actual, reference]) {
      runMigrations(db, () => {});
      createTables(db);
    }
    vi.spyOn(Date, 'now').mockReturnValue(clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    actual.close();
    reference.close();
  });

  test('the core fallback preserves the old SQL bytes, bound arguments and inserted row', () => {
    const id = randomUUID();
    bind(actual, id);
    const observed = capture(actual);
    const expected = capture(reference);
    expect(new NeoRepository(actual).conversationId()).toBe(id);
    reference.prepare(legacySql).run(id, clock);
    expect(observed).toEqual(expected);
    expect(observed).toHaveLength(1);
    expect(row(actual)).toEqual(row(reference));
  });

  test('a stored conversation still bypasses insertion and preserves its first timestamp', () => {
    const id = randomUUID();
    for (const db of [actual, reference]) db.prepare(legacySql).run(id, clock - 10);
    const observed = capture(actual);
    expect(new NeoRepository(actual).conversationId()).toBe(id);
    expect(observed).toEqual([]);
    expect(row(actual)).toEqual(row(reference));
  });

  test('the core fallback remains inside its caller transaction and rolls back identically', () => {
    const id = randomUUID();
    bind(actual, id);
    const observed = capture(actual);
    const expected = capture(reference);
    expect(() =>
      actual.transaction(() => {
        expect(new NeoRepository(actual).conversationId()).toBe(id);
        throw new Error('synthetic reservation rollback');
      })()
    ).toThrow('synthetic reservation rollback');
    expect(() =>
      reference.transaction(() => {
        reference.prepare(legacySql).run(id, clock);
        throw new Error('synthetic reservation rollback');
      })()
    ).toThrow('synthetic reservation rollback');
    expect(observed).toEqual(expected);
    expect(row(actual)).toBeNull();
    expect(row(reference)).toBeNull();
  });

  test('reset without a binding retains its generated ID and explicitly supplied timestamp', () => {
    const at = clock + 500;
    const observed = capture(actual);
    const expected = capture(reference);
    const receipt = resetHumanDevices(actual, at);
    reference.prepare(legacySql).run(receipt.conversationId, at);
    expect(observed).toEqual(expected);
    expect(observed).toHaveLength(1);
    expect(row(actual)).toEqual(row(reference));
  });

  test('reset retains INSERT OR IGNORE results when the conversation already exists', () => {
    const id = randomUUID();
    for (const db of [actual, reference]) db.prepare(legacySql).run(id, clock - 10);
    const observed = capture(actual);
    const expected = capture(reference);
    const receipt = resetHumanDevices(actual, clock + 500);
    reference.prepare(legacySql).run(id, clock + 500);
    expect(receipt.conversationId).toBe(id);
    expect(observed).toEqual(expected);
    expect(observed[0].changes).toBe(0);
    expect(row(actual)).toEqual(row(reference));
  });

  test('both insert sites keep their distinct clock arguments and the reset rollback boundary', () => {
    const id = randomUUID();
    const at = clock + 500;
    bind(actual, id);
    const observed = capture(actual);
    const expected = capture(reference);
    expect(() =>
      actual.transaction(() => {
        expect(resetHumanDevices(actual, at).conversationId).toBe(id);
        throw new Error('synthetic reset rollback');
      })()
    ).toThrow('synthetic reset rollback');
    expect(() =>
      reference.transaction(() => {
        reference.prepare(legacySql).run(id, clock);
        reference.prepare(legacySql).run(id, at);
        throw new Error('synthetic reset rollback');
      })()
    ).toThrow('synthetic reset rollback');
    expect(observed).toEqual(expected);
    expect(observed.map((trace) => trace.changes)).toEqual([1, 0]);
    expect(row(actual)).toBeNull();
    expect(row(reference)).toBeNull();
    expect(actual.prepare('SELECT id FROM human_device_resets').all()).toEqual([]);
    expect(actual.prepare('SELECT sequence FROM neo_publications').all()).toEqual([]);
  });
});
