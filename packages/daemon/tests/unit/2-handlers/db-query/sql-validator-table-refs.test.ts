import { describe, expect, test } from 'bun:test';
import { validateSql } from '../../../../src/lib/db-query/sql-validator.ts';

function refs(sql: string): string[] {
  return validateSql(sql).tableRefs;
}

describe('validateSql table references', () => {
  test('records every table in a join, however it is written', () => {
    expect(refs('SELECT *\n  FROM   space_tasks t\n  JOIN space_workflows w ON 1 = 1')).toEqual([
      'space_tasks',
      'space_workflows',
    ]);
    expect(refs('SELECT * FROM a, main.b')).toEqual(['a', 'b']);
    expect(refs('SELECT * FROM a, main . b')).toEqual(['a', 'b']);
    expect(refs("SELECT * FROM space_tasks AS 't', space_goals")).toEqual([
      'space_tasks',
      'space_goals',
    ]);
    expect(refs('SELECT * FROM space_tasks CROSS JOIN space_workflows, space_goals')).toEqual([
      'space_tasks',
      'space_workflows',
      'space_goals',
    ]);
  });

  test('deduplicates a name that appears twice', () => {
    expect(refs('SELECT * FROM space_workflows a JOIN space_workflows b ON 1 = 1')).toEqual([
      'space_workflows',
    ]);
  });

  test('is not displaced by comments or string literals', () => {
    expect(refs('/* lead */ SELECT * FROM space_tasks -- trailing\n, space_goals')).toEqual([
      'space_tasks',
      'space_goals',
    ]);
    expect(refs("SELECT * FROM space_tasks WHERE title = 'FROM space_workflows'")).toEqual([
      'space_tasks',
    ]);
    expect(refs("SELECT * FROM space_tasks -- it's fine\nJOIN space_workflows ON 1 = 1")).toEqual([
      'space_tasks',
      'space_workflows',
    ]);
  });

  test('skips CTE names but records what the CTE reads', () => {
    expect(refs('WITH active AS (SELECT * FROM space_tasks) SELECT * FROM active')).toEqual([
      'space_tasks',
    ]);
  });

  test('descends into parenthesized table factors, which the allowlist depends on', () => {
    expect(refs('SELECT * FROM (a JOIN b ON 1 = 1)')).toEqual(['a', 'b']);
    expect(refs('SELECT * FROM ( a , b )')).toEqual(['a', 'b']);
    expect(refs('SELECT * FROM (((a)))')).toEqual(['a']);
    expect(refs('SELECT * FROM (SELECT * FROM a)')).toEqual(['a']);
  });

  test("stops at the table factor's own closing parenthesis", () => {
    expect(refs('SELECT (SELECT id FROM (a)), abs(1)')).toEqual(['a']);
    expect(refs('SELECT * FROM (a, b), c')).toEqual(['a', 'b', 'c']);
    expect(refs('SELECT * FROM (a), b')).toEqual(['a', 'b']);
  });
});
