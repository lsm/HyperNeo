import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runScopedQuery } from '../../../../src/lib/db-query/scoped-query.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (id TEXT, room_id TEXT, title TEXT, restrictions TEXT);
    CREATE TABLE goals (id TEXT, room_id TEXT, title TEXT, task_id TEXT);
    CREATE TABLE auth_config (id TEXT, secret TEXT);
    INSERT INTO tasks VALUES ('t1', 'room-1', 'Mine', 'SECRET1'), ('t2', 'room-2', 'Theirs', 'SECRET2');
    INSERT INTO goals VALUES ('g1', 'room-1', 'G1', 't1');
    INSERT INTO auth_config VALUES ('a', 'CREDS');
  `);
  return db;
}

function run(db: Database, sql: string, params?: unknown[]) {
  return runScopedQuery(db, 'room', 'room-1', { sql, params });
}

describe('runScopedQuery — the scratch database is the security boundary', () => {
  it('gives every joined table its own scope, including a parenthesized join', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM (tasks JOIN goals ON goals.task_id = tasks.id)').rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].room_id).toBe('room-1');
    expect(rows[0]['room_id:1']).toBe('room-1');
    db.close();
  });

  it('keeps unmatched rows on an outer join', () => {
    const db = makeDb();
    const rows = run(
      db,
      "SELECT * FROM tasks t LEFT JOIN goals g ON g.task_id = t.id AND g.id = 'nope'"
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]['title:1']).toBeNull();
    db.close();
  });

  it.each([
    'SELECT * FROM auth_config',
    'SELECT * FROM tasks, auth_config',
    'SELECT * FROM (auth_config JOIN tasks ON 1 = 1)',
    'SELECT * FROM (auth_config)',
  ])('refuses to reach a table outside the scope: %s', (sql) => {
    const db = makeDb();

    expect(() => run(db, sql)).toThrow(/auth_config/);
    db.close();
  });

  it('does not expose a blacklisted column, even renamed', () => {
    const db = makeDb();

    expect(() => run(db, 'SELECT restrictions AS exposed FROM tasks')).toThrow(/restrictions/);
    expect(run(db, 'SELECT * FROM tasks').rows[0]).not.toHaveProperty('restrictions');
    db.close();
  });

  it('supports SQL shapes the rewriting approach could not', () => {
    const db = makeDb();

    expect(run(db, 'SELECT COUNT(*) AS n FROM tasks').rows).toEqual([{ n: 1 }]);
    expect(run(db, 'SELECT MAX(rowid) AS m FROM tasks').rows).toEqual([{ m: 1 }]);
    expect(run(db, 'SELECT * FROM tasks [t]').rows).toHaveLength(1);
    expect(run(db, 'SELECT * FROM tasks WHERE title = ?1', ['Mine']).rows).toHaveLength(1);
    db.close();
  });
});
