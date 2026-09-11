import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runScopedQuery } from '../../../../src/lib/db-query/scoped-query.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (id TEXT, room_id TEXT, title TEXT, restrictions TEXT, created_at INTEGER,
      norm TEXT GENERATED ALWAYS AS (COALESCE(title, '')) VIRTUAL);
    CREATE INDEX idx_tasks_room ON tasks(room_id);
    CREATE INDEX idx_tasks_hidden ON tasks (json_extract(restrictions, '$.x'));
    CREATE TABLE goals (id TEXT, room_id TEXT, title TEXT, task_id TEXT);
    CREATE TABLE auth_config (id TEXT, secret TEXT);
    INSERT INTO tasks (id, room_id, title, restrictions, created_at) VALUES
      ('t0', 'room-2', 'Theirs', '{"s":"SECRET2"}', 50),
      ('t1', 'room-1', 'Mine', '{"s":"SECRET1"}', 100),
      ('t2', 'room-1', 'Abc', '{"s":"SECRET3"}', 200),
      ('t3', 'room-1', 'Big', '{"s":"SECRET4"}', 9007199254740993);
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

  it('resolves tables through arbitrary parenthesis nesting', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM (((tasks)))').rows;

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.room_id === 'room-1')).toBe(true);
    expect(
      run(db, 'SELECT * FROM ((tasks JOIN goals ON goals.task_id = tasks.id))').rows
    ).toHaveLength(1);
    db.close();
  });

  it('keeps unmatched rows on an outer join', () => {
    const db = makeDb();
    const rows = run(
      db,
      "SELECT * FROM tasks t LEFT JOIN goals g ON g.task_id = t.id AND g.id = 'nope'"
    ).rows;

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r['title:1'] === null)).toBe(true);
    db.close();
  });

  it.each([
    'SELECT * FROM auth_config',
    'SELECT * FROM tasks, auth_config',
    'SELECT * FROM (auth_config JOIN tasks ON 1 = 1)',
    'SELECT * FROM (auth_config)',
    'SELECT * FROM ((auth_config))',
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

  it('copies the source faithfully rather than an approximation of it', () => {
    const db = makeDb();

    expect(run(db, 'SELECT norm FROM tasks ORDER BY id').rows).toEqual([
      { norm: 'Mine' },
      { norm: 'Abc' },
      { norm: 'Big' },
    ]);
    expect(run(db, "SELECT id FROM tasks WHERE created_at = '100'").rows).toEqual([{ id: 't1' }]);
    expect(run(db, "SELECT id FROM tasks WHERE title LIKE 'a%'").rows).toEqual([]);
    expect(run(db, 'SELECT id, rowid AS r FROM tasks ORDER BY id').rows).toEqual([
      { id: 't1', r: 2 },
      { id: 't2', r: 3 },
      { id: 't3', r: 4 },
    ]);
    expect(() =>
      run(db, 'SELECT id FROM tasks INDEXED BY idx_tasks_room WHERE room_id = ?', ['room-1'])
    ).not.toThrow();
    db.close();
  });

  it('keeps large integers exact in the scratch copy', () => {
    const db = makeDb();

    expect(run(db, 'SELECT id FROM tasks WHERE created_at = 9007199254740993').rows).toEqual([
      { id: 't3' },
    ]);
    expect(run(db, "SELECT created_at AS c FROM tasks WHERE id = 't3'").rows).toEqual([
      { c: '9007199254740993' },
    ]);
    expect(run(db, "SELECT created_at AS c FROM tasks WHERE id = 't1'").rows).toEqual([{ c: 100 }]);
    db.close();
  });

  it('keeps an index name usable when its definition cannot be recreated', () => {
    const db = makeDb();

    expect(() => run(db, 'SELECT id FROM tasks INDEXED BY idx_tasks_hidden')).not.toThrow();
    db.close();
  });

  it('supports SQL shapes the rewriting approach could not', () => {
    const db = makeDb();

    expect(run(db, 'SELECT COUNT(*) AS n FROM tasks').rows).toEqual([{ n: 3 }]);
    expect(run(db, 'SELECT MAX(rowid) AS m FROM tasks').rows).toEqual([{ m: 4 }]);
    expect(run(db, 'SELECT * FROM tasks [t]').rows).toHaveLength(3);
    expect(run(db, 'SELECT * FROM tasks WHERE title = ?1', ['Mine']).rows).toHaveLength(1);
    db.close();
  });
});
