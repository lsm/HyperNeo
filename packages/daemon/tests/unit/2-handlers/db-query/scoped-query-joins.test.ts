import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runScopedQuery } from '../../../../src/lib/db-query/scoped-query.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, created_at INTEGER);
    CREATE TABLE goals (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, task_id TEXT);
    INSERT INTO tasks VALUES ('t1', 'room-1', 'Mine', 1), ('t2', 'room-2', 'Theirs', 2);
    INSERT INTO goals VALUES ('g1', 'room-1', 'MineGoal', 't1'), ('g2', 'room-2', 'TheirsGoal', 't1');
  `);
  return db;
}

function run(db: Database, sql: string, params?: unknown[]) {
  return runScopedQuery(db, 'room', 'room-1', { sql, params });
}

describe('runScopedQuery — every referenced table is scoped', () => {
  it('does not leak a joined table that shares the scope column', () => {
    const db = makeDb();
    const result = run(
      db,
      'SELECT t.title AS tt, g.title AS gt FROM tasks t JOIN goals g ON g.task_id = t.id'
    );

    expect(result.rows).toEqual([{ tt: 'Mine', gt: 'MineGoal' }]);
    db.close();
  });

  it('keeps unmatched rows on a LEFT JOIN instead of turning it into an inner join', () => {
    const db = makeDb();
    const result = run(
      db,
      "SELECT t.title AS tt, g.title AS gt FROM tasks t LEFT JOIN goals g ON g.task_id = t.id AND g.id = 'g2'"
    );

    expect(result.rows).toEqual([{ tt: 'Mine', gt: null }]);
    db.close();
  });

  it('scopes a self-join on both sides', () => {
    const db = makeDb();
    const result = run(
      db,
      'SELECT a.id AS a_id, b.id AS b_id FROM tasks a JOIN tasks b ON a.id = b.id'
    );

    expect(result.rows).toEqual([{ a_id: 't1', b_id: 't1' }]);
    db.close();
  });

  it('interleaves user params with the injected scope params', () => {
    const db = makeDb();
    const result = run(db, 'SELECT title FROM tasks WHERE title LIKE ?', ['%ine']);

    expect(result.rows).toEqual([{ title: 'Mine' }]);
    db.close();
  });

  it('scopes a table referenced without an alias', () => {
    const db = makeDb();
    const result = run(
      db,
      'SELECT tasks.id AS t_id, goals.id AS g_id FROM tasks JOIN goals ON goals.task_id = tasks.id'
    );

    expect(result.rows).toEqual([{ t_id: 't1', g_id: 'g1' }]);
    db.close();
  });
});
