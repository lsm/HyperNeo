import { describe, expect, test } from 'bun:test';
import { runMigration297 } from '../../../../../src/storage/schema/m297-message-search-vectors.ts';
import { runMigration408 } from '../../../../../src/storage/schema/m408-search-vector-model-index.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const plan = (db: Database) =>
  (
    db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT MIN(content_id) AS low, MAX(content_id) AS high
           FROM message_search_vectors WHERE model = ? AND dimensions = ?`
      )
      .all('m', 3) as { detail: string }[]
  ).map((row) => row.detail);

describe('runMigration408', () => {
  test('the embedded range reads an index instead of scanning every embedding', () => {
    const db = new Database(':memory:');
    runMigration297(db);
    expect(plan(db).some((detail) => detail.startsWith('SCAN message_search_vectors'))).toBe(true);
    runMigration408(db);
    runMigration408(db);
    expect(plan(db).some((detail) => detail.startsWith('SCAN'))).toBe(false);
    db.close();
  });

  test('skips a database without the vectors table', () => {
    const db = new Database(':memory:');
    runMigration408(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).toEqual([]);
    db.close();
  });
});
