import { describe, expect, test } from 'bun:test';
import { runScopedQuery } from '../../../../src/lib/db-query/scoped-query.ts';
import { Database } from '../../../../src/storage/sqlite-compat';

function seededDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE space_tasks (space_id TEXT, id TEXT, title TEXT);
    CREATE TABLE space_workflows (space_id TEXT, id TEXT, name TEXT);
    INSERT INTO space_tasks VALUES ('space-a', 't1', 'Task A');
    INSERT INTO space_workflows VALUES ('space-a', 'w1', 'Workflow A'), ('space-b', 'w2', 'Workflow B');
  `);
  return db;
}

function names(db: Database, sql: string): string[] {
  const result = runScopedQuery(db, 'space', 'space-a', { sql });
  return result.rows.map((row) => String(row.name ?? row['name:1'] ?? ''));
}

describe('runScopedQuery — joins of two Space-scoped tables (#4163)', () => {
  test('an uncorrelated join cannot read another Space rows', () => {
    const db = seededDb();
    expect(names(db, 'SELECT * FROM space_tasks JOIN space_workflows ON 1 = 1')).not.toContain(
      'Workflow B'
    );
    db.close();
  });

  test('a cross join cannot read another Space rows', () => {
    const db = seededDb();
    expect(names(db, 'SELECT * FROM space_tasks, space_workflows')).not.toContain('Workflow B');
    db.close();
  });

  test('a narrow projection is still scoped after the SELECT * rewrite', () => {
    const db = seededDb();
    expect(
      names(db, 'SELECT space_workflows.name FROM space_tasks JOIN space_workflows ON 1 = 1')
    ).not.toContain('Workflow B');
    db.close();
  });

  test('a correlated equi-join still returns the Space own rows', () => {
    const db = seededDb();
    const rows = names(
      db,
      `SELECT * FROM space_tasks JOIN space_workflows
         ON space_tasks.space_id = space_workflows.space_id`
    );
    expect(rows).toEqual(['Workflow A']);
    db.close();
  });

  test('a single scoped table is unaffected', () => {
    const db = seededDb();
    expect(names(db, 'SELECT * FROM space_workflows')).toEqual(['Workflow A']);
    db.close();
  });

  test('user placeholders keep their positions alongside the scope predicates', () => {
    const db = seededDb();
    const result = runScopedQuery(db, 'space', 'space-a', {
      sql: 'SELECT * FROM space_tasks JOIN space_workflows ON 1 = 1 WHERE space_tasks.title = ?',
      params: ['Task A'],
    });
    expect(result.rows.map((row) => row['name:1'] ?? row.name)).toEqual(['Workflow A']);
    db.close();
  });
});
