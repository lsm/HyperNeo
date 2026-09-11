import { describe, expect, test } from 'bun:test';
import { extractTableRefSpans, validateSql } from '../../../../src/lib/db-query/sql-validator.ts';

function sliced(sql: string): string[] {
  return extractTableRefSpans(sql).map((span) => sql.slice(span.start, span.end));
}

function spanNames(sql: string): string[] {
  return [...new Set(extractTableRefSpans(sql).map((span) => span.name))];
}

describe('extractTableRefSpans', () => {
  test('spans index into the original SQL, not a normalized copy', () => {
    const sql = 'SELECT *\n  FROM   space_tasks t\n  JOIN space_workflows w ON 1 = 1';
    expect(extractTableRefSpans(sql).map((span) => span.name)).toEqual([
      'space_tasks',
      'space_workflows',
    ]);
    expect(sliced(sql)).toEqual(['space_tasks', 'space_workflows']);
  });

  test('covers the whole qualified reference, including spaces around the dot', () => {
    expect(extractTableRefSpans('SELECT * FROM a, main.b').map((s) => s.name)).toEqual(['a', 'b']);
    expect(sliced('SELECT * FROM space_tasks, main.space_workflows')).toEqual([
      'space_tasks',
      'main.space_workflows',
    ]);
    expect(sliced('SELECT * FROM space_tasks, main . space_workflows')).toEqual([
      'space_tasks',
      'main . space_workflows',
    ]);
  });

  test('reports one span per occurrence even when the name repeats', () => {
    const sql = 'SELECT * FROM space_workflows a JOIN space_workflows b ON 1 = 1';
    expect(extractTableRefSpans(sql)).toHaveLength(2);
    expect(sliced(sql)).toEqual(['space_workflows', 'space_workflows']);
    expect(validateSql(sql).tableRefs).toEqual(['space_workflows']);
  });

  test('is not displaced by comments or string literals', () => {
    expect(extractTableRefSpans('/* c */ SELECT * FROM space_tasks')[0].start).toBe(
      '/* c */ SELECT * FROM '.length
    );
    expect(sliced('/* lead */ SELECT * FROM space_tasks -- trailing\n, space_goals')).toEqual([
      'space_tasks',
      'space_goals',
    ]);
    expect(sliced("SELECT * FROM space_tasks WHERE title = 'FROM space_workflows'")).toEqual([
      'space_tasks',
    ]);
  });

  test('skips CTE names the way the reference list does', () => {
    const sql = 'WITH active AS (SELECT * FROM space_tasks) SELECT * FROM active';
    expect(extractTableRefSpans(sql).map((span) => span.name)).toEqual(['space_tasks']);
    expect(sliced(sql)).toEqual(['space_tasks']);
  });

  test('agrees with tableRefs on which tables a query names', () => {
    for (const sql of [
      'SELECT * FROM space_tasks, space_workflows',
      'SELECT * FROM space_tasks CROSS JOIN space_workflows, space_goals',
      "SELECT * FROM space_tasks AS 't', space_goals",
    ]) {
      expect(spanNames(sql)).toEqual(validateSql(sql).tableRefs);
      expect(extractTableRefSpans(sql).length).toBeGreaterThan(0);
    }
  });
});
