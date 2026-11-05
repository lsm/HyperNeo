import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { existsSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ArtifactFileRepository } from '../../../../src/storage/repositories/artifact-file-repository';

const uuid = vi.hoisted(() => ({ value: '11111111-1111-4111-8111-111111111111' }));
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomUUID: () => uuid.value,
}));
const insert = 'INSERT OR IGNORE INTO artifact_file_identity VALUES (1, ?)';
const select = 'SELECT daemon_id FROM artifact_file_identity';
const databases: Database[] = [];
function database(existing?: string) {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(
    'CREATE TABLE artifact_file_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), daemon_id TEXT NOT NULL)'
  );
  if (existing) db.prepare(insert).run(existing);
  return db;
}
async function extracted() {
  const file = new URL(
    '../../../../src/storage/repositories/artifact-file-identity.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Extracted artifact identity helper is unavailable');
  const module = (await import(file.href)) as {
    ensureArtifactFileIdentity: (db: Database) => string;
  };
  if (typeof module.ensureArtifactFileIdentity !== 'function')
    throw new Error('Extracted artifact identity helper is unavailable');
  return module.ensureArtifactFileIdentity;
}
function trace(db: Database, action: () => string) {
  const prepare = db.prepare;
  const events: { kind: string; sql: string; args?: unknown[] }[] = [];
  db.prepare = ((sql: string) => {
    events.push({ kind: 'prepare', sql });
    const statement = prepare.call(db, sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (key === 'run' || key === 'get') events.push({ kind: String(key), sql, args });
          return Reflect.apply(value, target, args);
        };
      },
    });
  }) as typeof db.prepare;
  try {
    return { id: action(), events };
  } finally {
    db.prepare = prepare;
  }
}
function readFault(db: Database, action: () => string) {
  const prepare = db.prepare;
  db.prepare = ((sql: string) => {
    const stmt = prepare.call(db, sql);
    return sql === select
      ? new Proxy(stmt, {
          get(target, key) {
            if (key === 'get')
              return () => {
                throw new Error('synthetic identity receipt failure');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      : stmt;
  }) as typeof db.prepare;
  try {
    return action();
  } finally {
    db.prepare = prepare;
  }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  uuid.value = '11111111-1111-4111-8111-111111111111';
});

describe('Artifact identity extraction', () => {
  test('legacy constructor preserves exact SQL, UUID argument and retained identity', () => {
    const db = database();
    const first = trace(db, () => new ArtifactFileRepository(db).daemonId);
    expect(first).toEqual({
      id: uuid.value,
      events: [
        { kind: 'prepare', sql: insert },
        { kind: 'run', sql: insert, args: [uuid.value] },
        { kind: 'prepare', sql: select },
        { kind: 'get', sql: select, args: [] },
      ],
    });
    uuid.value = '22222222-2222-4222-8222-222222222222';
    expect(new ArtifactFileRepository(db).daemonId).toBe(first.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()).toEqual({ n: 1 });
  });
  test('legacy caller-owned transaction rolls back a new identity', () => {
    const db = database();
    expect(() =>
      db.transaction(() => {
        new ArtifactFileRepository(db);
        throw new Error('synthetic outer rollback');
      })()
    ).toThrow('synthetic outer rollback');
    expect(db.prepare(select).get()).toBeNull();
  });
  test('helper and constructor have byte-identical SQL/arguments/results on empty and retained rows', async () => {
    const ensure = await extracted();
    for (const existing of [undefined, '33333333-3333-4333-8333-333333333333']) {
      const oldDb = database(existing);
      const newDb = database(existing);
      const old = trace(oldDb, () => new ArtifactFileRepository(oldDb).daemonId);
      expect(trace(newDb, () => ensure(newDb))).toEqual(old);
      expect(oldDb.prepare('SELECT * FROM artifact_file_identity').all()).toEqual(
        newDb.prepare('SELECT * FROM artifact_file_identity').all()
      );
    }
  });
  test('both entrypoints preserve caller-owned rollback for new and existing identities', async () => {
    const ensure = await extracted();
    for (const run of [(db: Database) => new ArtifactFileRepository(db).daemonId, ensure])
      for (const existing of [undefined, '33333333-3333-4333-8333-333333333333']) {
        const db = database(existing);
        const before = db.prepare('SELECT * FROM artifact_file_identity').all();
        expect(() =>
          db.transaction(() => {
            run(db);
            throw new Error('synthetic outer rollback');
          })()
        ).toThrow('synthetic outer rollback');
        expect(db.prepare('SELECT * FROM artifact_file_identity').all()).toEqual(before);
      }
  });
  test('read failure keeps the legacy partial insert outside a transaction and rolls it back inside one', async () => {
    const ensure = await extracted();
    for (const run of [(db: Database) => new ArtifactFileRepository(db).daemonId, ensure]) {
      const plain = database();
      expect(() => readFault(plain, () => run(plain))).toThrow(
        'synthetic identity receipt failure'
      );
      expect(plain.prepare(select).get()).toEqual({ daemon_id: uuid.value });
      const atomic = database();
      expect(() => atomic.transaction(() => readFault(atomic, () => run(atomic)))()).toThrow(
        'synthetic identity receipt failure'
      );
      expect(atomic.prepare(select).get()).toBeNull();
    }
  });
  test('insert rejection still prevents receipt lookup at either entrypoint', async () => {
    const ensure = await extracted();
    for (const run of [(db: Database) => new ArtifactFileRepository(db).daemonId, ensure]) {
      const db = database();
      db.exec(
        "CREATE TRIGGER reject_identity BEFORE INSERT ON artifact_file_identity BEGIN SELECT RAISE(ABORT,'synthetic identity insert failure'); END"
      );
      expect(() => run(db)).toThrow('synthetic identity insert failure');
      expect(db.prepare(select).get()).toBeNull();
    }
  });
});
