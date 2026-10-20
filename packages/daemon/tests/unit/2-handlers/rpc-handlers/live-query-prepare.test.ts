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
});
