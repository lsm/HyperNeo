import { describe, expect, test } from 'bun:test';
import {
  SQLITE_QUERY_DISPLAY_MAX_LENGTH,
  createSQLiteQueryDescriptor,
  normalizeSQLiteQuery,
} from '../../../../src/storage/sqlite-query-normalization';

describe('normalizeSQLiteQuery', () => {
  test('collapses whitespace and lowercases keywords', () => {
    expect(normalizeSQLiteQuery('SELECT   id\nFROM\tUsers')).toBe(
      normalizeSQLiteQuery('select id from users')
    );
    expect(normalizeSQLiteQuery('  SELECT 1  ')).toBe('select ?');
  });

  test('strips line and block comments', () => {
    expect(normalizeSQLiteQuery('SELECT 1 -- trailing comment')).toBe('select ?');
    expect(normalizeSQLiteQuery('SELECT /* block\n comment */ 1')).toBe('select ?');
  });

  test('replaces every literal form with a value token', () => {
    const normalized = normalizeSQLiteQuery(
      `SELECT * FROM t WHERE a = 'text' AND b = 'it''s' AND c = 5 AND d = 3.5e2
         AND e = 0xFF AND f = x'ABCD' AND g = .5 AND h = TRUE AND i = FALSE AND j = NULL`
    );
    expect(normalized).toBe(
      'select * from t where a = ? and b = ? and c = ? and d = ? and e = ? and f = ? and g = ? and h = ? and i = ? and j = ?'
    );
  });

  test('canonicalizes bind placeholders of every style', () => {
    expect(
      normalizeSQLiteQuery(
        'SELECT * FROM t WHERE a = :name AND b = @other AND c = $third AND d = ? AND e = ?7'
      )
    ).toBe(
      normalizeSQLiteQuery('SELECT * FROM t WHERE a = ? AND b = ? AND c = ? AND d = ? AND e = ?')
    );
  });

  test('collapses placeholder list cardinality into one list token', () => {
    expect(normalizeSQLiteQuery('SELECT * FROM t WHERE id IN (?, ?, ?)')).toBe(
      normalizeSQLiteQuery('SELECT * FROM t WHERE id IN (?, ?)')
    );
    expect(normalizeSQLiteQuery('SELECT * FROM t WHERE id IN (?, ?, ?)')).toContain('( ?.. )');
  });

  test('redacts quoted identifier contents', () => {
    expect(normalizeSQLiteQuery('SELECT "secretColumn" FROM `tbl`')).toBe(
      normalizeSQLiteQuery('SELECT "otherName" FROM [anything]')
    );
  });

  test('consumes unterminated strings, identifiers, and comments without leaking the suffix', () => {
    expect(normalizeSQLiteQuery("SELECT 'unterminated-secret")).toBe('select ?');
    expect(normalizeSQLiteQuery('SELECT "unterminated')).toBe('select "#"');
    expect(normalizeSQLiteQuery('SELECT /* never closed 1')).toBe('select ?');
  });
});

describe('createSQLiteQueryDescriptor', () => {
  test('keeps structurally different queries distinguishable', () => {
    expect(createSQLiteQueryDescriptor('SELECT a FROM t').fingerprint).not.toBe(
      createSQLiteQueryDescriptor('SELECT b FROM t').fingerprint
    );
    expect(createSQLiteQueryDescriptor('SELECT a FROM t WHERE x = 1').fingerprint).not.toBe(
      createSQLiteQueryDescriptor('SELECT a FROM t').fingerprint
    );
  });

  test('fingerprints formatting variants identically', () => {
    expect(
      createSQLiteQueryDescriptor("SELECT id\n  FROM sessions\n WHERE name = 'x'").fingerprint
    ).toBe(createSQLiteQueryDescriptor('select id from sessions where name = ?').fingerprint);
  });

  test('truncates the display form but keeps the fingerprint on the full normalized text', () => {
    const columnList = Array.from({ length: 200 }, (_, index) => `col_${index}`).join(', ');
    const sql = `SELECT ${columnList} FROM wide_table WHERE id = ?`;
    const descriptor = createSQLiteQueryDescriptor(sql);
    expect(descriptor.normalizedSqlTruncated).toBe(true);
    expect(descriptor.normalizedSql.length).toBeLessThanOrEqual(SQLITE_QUERY_DISPLAY_MAX_LENGTH);
    expect(descriptor.fingerprint).toBe(createSQLiteQueryDescriptor(sql).fingerprint);
  });

  test('never exposes literal values in descriptors', () => {
    const descriptor = createSQLiteQueryDescriptor(
      "SELECT * FROM credentials WHERE token = 'sk-live-super-secret' AND password = 'hunter2'"
    );
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain('sk-live-super-secret');
    expect(serialized).not.toContain('hunter2');
  });
});
