/**
 * Migration 170 Tests — Convert auto_vacuum NONE → INCREMENTAL.
 *
 * Covers:
 *   - Converts a populated auto_vacuum = NONE database to INCREMENTAL (2)
 *   - After conversion, incremental_vacuum reclaims freed pages (the whole point)
 *   - No-op when already INCREMENTAL (fresh DBs created by DatabaseCore)
 *   - Leaves FULL (1) mode untouched
 *   - Idempotent: running twice is a no-op after the first pass
 */

import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { runMigration170 } from '../../../../../src/storage/schema/migrations';

function autoVacuum(db: BunDatabase): number {
  return (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
}

function pageCount(db: BunDatabase): number {
  return (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
}

/** Populate a single table with enough rows to span many pages. */
function populate(db: BunDatabase): void {
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
  const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
  for (let i = 0; i < 3000; i++) insert.run('x'.repeat(3000));
}

describe('Migration 170: convert auto_vacuum NONE → INCREMENTAL', () => {
  test('converts a populated NONE database to INCREMENTAL', () => {
    const db = new BunDatabase(':memory:');
    // Fresh in-memory DB defaults to auto_vacuum = NONE (0).
    populate(db);
    expect(autoVacuum(db)).toBe(0);

    runMigration170(db);

    expect(autoVacuum(db)).toBe(2); // INCREMENTAL
    db.close();
  });

  test('after conversion, incremental_vacuum reclaims freed pages', () => {
    const db = new BunDatabase(':memory:');
    populate(db);
    expect(autoVacuum(db)).toBe(0);

    runMigration170(db);
    expect(autoVacuum(db)).toBe(2);

    // Free a large contiguous range, then reclaim — only possible because the
    // rebuild put the DB in incremental mode with a pointer-map.
    db.exec('DELETE FROM t WHERE id > 100');
    const freeBefore = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
      .freelist_count;
    const pagesBefore = pageCount(db);
    expect(freeBefore).toBeGreaterThan(0);

    db.exec('PRAGMA incremental_vacuum(500)');
    expect(pageCount(db)).toBeLessThan(pagesBefore);
    db.close();
  });

  test('is a no-op when already INCREMENTAL', () => {
    const db = new BunDatabase(':memory:');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    populate(db);
    expect(autoVacuum(db)).toBe(2);

    runMigration170(db); // should not throw or alter mode

    expect(autoVacuum(db)).toBe(2);
    db.close();
  });

  test('leaves FULL (1) mode untouched', () => {
    const db = new BunDatabase(':memory:');
    db.exec('PRAGMA auto_vacuum = FULL');
    populate(db);
    expect(autoVacuum(db)).toBe(1);

    runMigration170(db);

    expect(autoVacuum(db)).toBe(1); // unchanged
    db.close();
  });

  test('is idempotent — running twice yields the same mode', () => {
    const db = new BunDatabase(':memory:');
    populate(db);
    expect(autoVacuum(db)).toBe(0);

    runMigration170(db);
    expect(autoVacuum(db)).toBe(2);

    runMigration170(db); // second run is a no-op (already INCREMENTAL)
    expect(autoVacuum(db)).toBe(2);
    db.close();
  });
});
