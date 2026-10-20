import { describe, expect, test } from 'bun:test';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/live-query/registry.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('NAMED_QUERY_REGISTRY', () => {
  test('every live query prepares against the migrated schema', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const refused = [...NAMED_QUERY_REGISTRY].flatMap(([name, entry]) => {
      try {
        db.prepare(entry.sql);
        return [];
      } catch (error) {
        return [`${name}: ${(error as Error).message}`];
      }
    });
    expect(refused).toEqual([]);
    db.close();
  });

  test('every live query leaves room for a second copy of itself under the subquery cap', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const tight = [...NAMED_QUERY_REGISTRY].flatMap(([name, entry]) => {
      try {
        db.prepare(`SELECT * FROM (${entry.sql}) UNION ALL SELECT * FROM (${entry.sql})`);
        return [];
      } catch (error) {
        return [`${name}: ${(error as Error).message}`];
      }
    });
    expect(tight).toEqual([]);
    db.close();
  });
});
