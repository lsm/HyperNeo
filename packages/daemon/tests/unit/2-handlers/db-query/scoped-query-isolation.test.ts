import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runScopedQuery } from '../../../../src/lib/db-query/scoped-query.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE space_tasks (id TEXT PRIMARY KEY, space_id TEXT, title TEXT, created_at INTEGER,
      norm TEXT GENERATED ALWAYS AS (COALESCE(title, '')) VIRTUAL);
    CREATE INDEX idx_space_tasks_space ON space_tasks(space_id);
    CREATE TABLE space_goals (id TEXT, space_id TEXT, title TEXT, task_id TEXT);
    CREATE TABLE space_workflows (id TEXT, space_id TEXT, name TEXT, config TEXT);
    CREATE INDEX idx_space_workflows_hidden ON space_workflows (json_extract(config, '$.x'));
    CREATE TABLE auth_config (id TEXT, secret TEXT);
    INSERT INTO space_tasks (id, space_id, title, created_at) VALUES
      ('t0', 'space-2', 'Theirs', 50),
      ('t1', 'space-1', 'Mine', 100),
      ('t2', 'space-1', 'Abc', 200),
      ('t3', 'space-1', 'Big', 9007199254740993);
    INSERT INTO space_goals VALUES ('g1', 'space-1', 'G1', 't1');
    INSERT INTO space_workflows VALUES ('w1', 'space-1', 'W1', '{"secret":"CONFIG"}');
    INSERT INTO auth_config VALUES ('a', 'CREDS');
  `);
  return db;
}

function run(db: Database, sql: string, params?: unknown[]) {
  return runScopedQuery(db, 'space', 'space-1', { sql, params });
}

describe('runScopedQuery — the scratch database is the security boundary', () => {
  it('gives every joined table its own scope, including a parenthesized join', () => {
    const db = makeDb();
    const rows = run(
      db,
      'SELECT * FROM (space_tasks JOIN space_goals ON space_goals.task_id = space_tasks.id)'
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].space_id).toBe('space-1');
    expect(rows[0]['space_id:1']).toBe('space-1');
    db.close();
  });

  it('resolves tables through arbitrary parenthesis nesting', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM (((space_tasks)))').rows;

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.space_id === 'space-1')).toBe(true);
    expect(
      run(
        db,
        'SELECT * FROM ((space_tasks JOIN space_goals ON space_goals.task_id = space_tasks.id))'
      ).rows
    ).toHaveLength(1);
    db.close();
  });

  it('keeps unmatched rows on an outer join', () => {
    const db = makeDb();
    const rows = run(
      db,
      "SELECT * FROM space_tasks t LEFT JOIN space_goals g ON g.task_id = t.id AND g.id = 'nope'"
    ).rows;

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r['title:1'] === null)).toBe(true);
    db.close();
  });

  it.each([
    'SELECT * FROM auth_config',
    'SELECT * FROM space_tasks, auth_config',
    'SELECT * FROM (auth_config JOIN space_tasks ON 1 = 1)',
    'SELECT * FROM (auth_config)',
    'SELECT * FROM ((auth_config))',
  ])('refuses to reach a table outside the scope: %s', (sql) => {
    const db = makeDb();

    expect(() => run(db, sql)).toThrow(/auth_config/);
    db.close();
  });

  it('does not expose a blacklisted column, even renamed', () => {
    const db = makeDb();

    expect(() => run(db, 'SELECT config AS exposed FROM space_workflows')).toThrow(/config/);
    expect(run(db, 'SELECT * FROM space_workflows').rows[0]).not.toHaveProperty('config');
    db.close();
  });

  it('copies the source faithfully rather than an approximation of it', () => {
    const db = makeDb();

    expect(run(db, 'SELECT norm FROM space_tasks ORDER BY id').rows).toEqual([
      { norm: 'Mine' },
      { norm: 'Abc' },
      { norm: 'Big' },
    ]);
    expect(run(db, "SELECT id FROM space_tasks WHERE created_at = '100'").rows).toEqual([
      { id: 't1' },
    ]);
    expect(run(db, "SELECT id FROM space_tasks WHERE title LIKE 'a%'").rows).toEqual([]);
    expect(run(db, 'SELECT id, rowid AS r FROM space_tasks ORDER BY id').rows).toEqual([
      { id: 't1', r: 2 },
      { id: 't2', r: 3 },
      { id: 't3', r: 4 },
    ]);
    expect(() =>
      run(db, 'SELECT id FROM space_tasks INDEXED BY idx_space_tasks_space WHERE space_id = ?', [
        'space-1',
      ])
    ).not.toThrow();
    db.close();
  });

  it('keeps scanning the table list after a parenthesized factor', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM (space_tasks), space_goals').rows;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.space_id === 'space-1' && r['space_id:1'] === 'space-1')).toBe(true);
    db.close();
  });

  it('refuses connection-state functions, whose values would report the scratch copy', () => {
    const db = makeDb();

    expect(() => run(db, 'SELECT changes() AS c FROM space_tasks')).toThrow(/connection state/);
    expect(() => run(db, 'SELECT last_insert_rowid() AS r FROM space_tasks')).toThrow(
      /connection state/
    );
    db.close();
  });

  it('recreates automatic primary-key indexes under their original names', () => {
    const db = makeDb();

    expect(() =>
      run(db, 'SELECT id FROM space_tasks INDEXED BY sqlite_autoindex_space_tasks_1')
    ).not.toThrow();
    db.close();
  });

  it('keeps large integers exact in the scratch copy', () => {
    const db = makeDb();

    expect(run(db, 'SELECT id FROM space_tasks WHERE created_at = 9007199254740993').rows).toEqual([
      { id: 't3' },
    ]);
    expect(run(db, "SELECT created_at AS c FROM space_tasks WHERE id = 't3'").rows).toEqual([
      { c: '9007199254740993' },
    ]);
    expect(run(db, "SELECT created_at AS c FROM space_tasks WHERE id = 't1'").rows).toEqual([
      { c: 100 },
    ]);
    db.close();
  });

  it('keeps an index name usable when its definition cannot be recreated', () => {
    const db = makeDb();

    expect(() =>
      run(db, 'SELECT id FROM space_workflows INDEXED BY idx_space_workflows_hidden')
    ).not.toThrow();
    db.close();
  });

  it('supports SQL shapes the rewriting approach could not', () => {
    const db = makeDb();

    expect(run(db, 'SELECT COUNT(*) AS n FROM space_tasks').rows).toEqual([{ n: 3 }]);
    expect(run(db, 'SELECT MAX(rowid) AS m FROM space_tasks').rows).toEqual([{ m: 4 }]);
    expect(run(db, 'SELECT * FROM space_tasks [t]').rows).toHaveLength(3);
    expect(run(db, 'SELECT * FROM space_tasks WHERE title = ?1', ['Mine']).rows).toHaveLength(1);
    db.close();
  });
});
