import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runScopedQuery } from '../../../../src/lib/db-query/scoped-query.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT, title TEXT);
    CREATE TABLE goals (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, task_id TEXT);
    INSERT INTO tasks VALUES ('t1', 'room-1', 'Mine'), ('t2', 'room-2', 'Theirs');
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
    const rows = run(db, 'SELECT * FROM tasks t JOIN goals g ON g.task_id = t.id').rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Mine');
    expect(rows[0]['title:1']).toBe('MineGoal');
    db.close();
  });

  it('keeps unmatched rows on a LEFT JOIN instead of turning it into an inner join', () => {
    const db = makeDb();
    const rows = run(
      db,
      "SELECT * FROM tasks t LEFT JOIN goals g ON g.task_id = t.id AND g.id = 'g2'"
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Mine');
    expect(rows[0]['title:1']).toBeNull();
    db.close();
  });

  it('scopes a self-join on both sides', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM tasks a JOIN tasks b ON a.id = b.id').rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('t1');
    expect(rows[0]['id:1']).toBe('t1');
    db.close();
  });

  it('interleaves user params with the injected scope params', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM tasks WHERE title LIKE ?', ['%ine']).rows;

    expect(rows).toEqual([{ id: 't1', room_id: 'room-1', title: 'Mine' }]);
    db.close();
  });

  it('scopes a table referenced without an alias', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM tasks JOIN goals ON goals.task_id = tasks.id').rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('t1');
    expect(rows[0]['id:1']).toBe('g1');
    db.close();
  });

  it('scopes the first relation inside a parenthesized join', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM (tasks JOIN goals ON goals.task_id = tasks.id)').rows;

    expect(rows.every((r) => r.room_id === 'room-1')).toBe(true);
    expect(rows.every((r) => r['room_id:1'] === 'room-1')).toBe(true);
    db.close();
  });

  it('scopes both sides of a FULL JOIN', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM tasks FULL JOIN goals ON goals.task_id = tasks.id').rows;

    for (const row of rows) {
      expect([null, 'room-1']).toContain(row.room_id);
      expect([null, 'room-1']).toContain(row['room_id:1']);
    }
    db.close();
  });

  it('keeps a bracket-quoted alias instead of emitting two aliases', () => {
    const db = makeDb();
    const rows = run(db, 'SELECT * FROM tasks [t]').rows;

    expect(rows).toEqual([{ id: 't1', room_id: 'room-1', title: 'Mine' }]);
    db.close();
  });

  it('rejects constructs it cannot rewrite safely', () => {
    const db = makeDb();

    expect(() => run(db, 'SELECT * FROM tasks WHERE title = ?1', ['Mine'])).toThrow(/numbered/);
    expect(() => run(db, 'SELECT * FROM tasks INDEXED BY idx')).toThrow(/index hints/);
    expect(() => run(db, 'SELECT MAX(rowid) FROM tasks')).toThrow(/row identifier/);
    expect(() => run(db, 'SELECT * FROM main.tasks')).toThrow(/schema-qualified/);
    db.close();
  });
});
