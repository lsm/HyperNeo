import { describe, expect, test } from 'bun:test';
import { validateSql } from '../../../../src/lib/db-query/sql-validator.ts';
import { runScopedQuery } from '../../../../src/lib/db-query/scoped-query.ts';
import { Database } from '../../../../src/storage/sqlite-compat';

function refs(sql: string): string[] {
  return validateSql(sql).tableRefs;
}

describe('validateSql — comma-separated table lists', () => {
  test('extracts every table in a comma list', () => {
    expect(refs('SELECT * FROM space_tasks, space_workflows')).toEqual([
      'space_tasks',
      'space_workflows',
    ]);
  });

  test('extracts through bare and AS aliases', () => {
    expect(refs('SELECT * FROM space_tasks t, space_workflows w')).toContain('space_workflows');
    expect(refs('SELECT * FROM space_tasks AS t, space_workflows AS w')).toContain(
      'space_workflows'
    );
  });

  test('extracts a schema-qualified table in the list', () => {
    expect(refs('SELECT * FROM space_tasks, main.space_workflows')).toContain('space_workflows');
  });

  test('stops at the clause that follows the list', () => {
    expect(refs('SELECT * FROM space_tasks t WHERE t.id = ?')).toEqual(['space_tasks']);
    expect(refs('SELECT * FROM space_tasks JOIN space_workflows ON 1 = 1')).toEqual([
      'space_tasks',
      'space_workflows',
    ]);
  });

  test('ignores a comma inside a string literal', () => {
    expect(refs("SELECT * FROM space_tasks WHERE title = 'a, auth_config'")).toEqual([
      'space_tasks',
    ]);
  });
});

describe('runScopedQuery — comma joins cannot reach excluded tables', () => {
  function seeded(): Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE space_tasks (space_id TEXT, id TEXT);
      CREATE TABLE auth_config (k TEXT, token TEXT);
      INSERT INTO space_tasks VALUES ('space-a', 't1');
      INSERT INTO auth_config VALUES ('api', 'SECRET');
    `);
    return db;
  }

  test.each([
    'SELECT * FROM space_tasks, auth_config',
    'SELECT * FROM space_tasks t, auth_config a',
    'SELECT * FROM space_tasks AS t, auth_config AS a',
    'SELECT * FROM space_tasks, main.auth_config',
  ])('rejects %s', (sql) => {
    const db = seeded();
    expect(() => runScopedQuery(db, 'space', 'space-a', { sql })).toThrow(/not accessible/);
    db.close();
  });
});
