/**
 * Migration 181 Tests — message_delivery_lifecycle ledger table + indexes.
 *
 * Round-16 P3: the pre-fix `if (tableExists) return` guard skipped the CREATE
 * INDEX statements on a crash-recovery re-run — runMarkedMigration marks AFTER
 * the function, so a crash between the table create and the index creates left
 * the indexes permanently absent (180 only adds created_at). The guard is gone;
 * all statements are IF NOT EXISTS and idempotent.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration181 } from '../../../../../src/storage/schema/migrations.ts';

function indexNames(db: BunDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_message_delivery_lifecycle%'`
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

describe('Migration 181: message_delivery_lifecycle ledger', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-179', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('creates the table and its three indexes on a fresh database', () => {
    runMigration181(db);
    expect(indexNames(db)).toEqual([
      'idx_message_delivery_lifecycle_message',
      'idx_message_delivery_lifecycle_session',
      'idx_message_delivery_lifecycle_stage',
    ]);
  });

  test('re-run creates the indexes even when the table already exists (crash recovery)', () => {
    // Simulate a crash between the table create and the index creates: the table
    // exists, the indexes do not. The old `if (tableExists) return` guard would
    // skip them permanently — the fix runs the idempotent statements always.
    db.exec(`
      CREATE TABLE message_delivery_lifecycle (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    expect(indexNames(db)).toEqual([]);

    runMigration181(db);

    expect(indexNames(db)).toEqual([
      'idx_message_delivery_lifecycle_message',
      'idx_message_delivery_lifecycle_session',
      'idx_message_delivery_lifecycle_stage',
    ]);
  });

  test('runMigration181 is idempotent — running twice does not error', () => {
    runMigration181(db);
    expect(() => runMigration181(db)).not.toThrow();
    expect(indexNames(db).length).toBe(3);
  });
});
