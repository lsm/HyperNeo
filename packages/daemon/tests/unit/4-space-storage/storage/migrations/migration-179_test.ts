/**
 * Migration 179 Tests — NULLABLE `space_tasks.post_approval_requires_merge`.
 *
 * The flag lets resolveSpaceMcpSessionPolicy / rehydrateSubSession recognise the
 * designated merger PRECISELY. The spawner sets it (TRUE/FALSE) at dispatch;
 * this migration adds the column as NULLABLE so legacy rows (dispatched before
 * the column existed) stay NULL and remain distinguishable from an explicit
 * FALSE. `rehydrateSubSession` lazy-derives + persists NULL rows at runtime —
 * the migration deliberately performs NO backfill (a blanket
 * `post_approval_session_id IS NOT NULL` update would over-provision legacy
 * non-merge routes AND throw on sentinel-seeded schemas that lack that column).
 *
 * Covers:
 *   - Column is added NULLABLE (no NOT NULL, no DEFAULT), so existing rows are NULL.
 *   - NO backfill: in-flight AND idle rows both stay NULL after the migration.
 *   - Idempotent re-run.
 *   - Fresh, fully-migrated DB carries the column.
 *   - Missing-table guard (empty DB).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../../src/storage/schema';
import { runMigration179, runMigrations } from '../../../../../src/storage/schema/migrations.ts';

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columnInfo(db: BunDatabase, table: string, col: string): ColumnRow | undefined {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as ColumnRow[];
  return rows.find((r) => r.name === col);
}

/** Minimal pre-M179 shape: space_tasks without post_approval_requires_merge. */
function seedPreM179Schema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      post_approval_session_id TEXT
    );
  `);
}

/** Read the raw stored value (null/0/1) for the flag. */
function rawFlag(db: BunDatabase, id: string): number | null {
  return (
    db
      .prepare(`SELECT post_approval_requires_merge AS v FROM space_tasks WHERE id = ?`)
      .get(id) as { v: number | null }
  ).v;
}

describe('Migration 179: NULLABLE space_tasks.post_approval_requires_merge', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-179',
      `test-${Date.now()}-${Math.random()}`
    );
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

  describe('pre-M179 schema — add NULLABLE column, NO backfill', () => {
    beforeEach(() => {
      seedPreM179Schema(db);
      // A legacy in-flight merger (post_approval_session_id set at upgrade time)
      // and a legacy idle task. Neither should be touched by the migration.
      db.prepare(`INSERT INTO space_tasks (id, post_approval_session_id) VALUES (?, ?)`).run(
        'in-flight',
        'space:sp:task:t1:post-approval:merger'
      );
      db.prepare(`INSERT INTO space_tasks (id, post_approval_session_id) VALUES (?, ?)`).run(
        'idle',
        null
      );
    });

    test('adds the column NULLABLE (notnull=0, no DEFAULT)', () => {
      expect(columnInfo(db, 'space_tasks', 'post_approval_requires_merge')).toBeUndefined();
      runMigration179(db);
      const col = columnInfo(db, 'space_tasks', 'post_approval_requires_merge');
      expect(col).toBeDefined();
      expect(col!.type).toBe('INTEGER');
      expect(col!.notnull).toBe(0); // NULLABLE — distinguishes legacy NULL from FALSE
      expect(col!.dflt_value).toBeNull();
    });

    test('does NOT backfill: in-flight AND idle rows stay NULL (#879 round-3)', () => {
      // The migration must not over-provision legacy rows — rehydrateSubSession
      // lazy-derives NULL rows from the workflow at runtime. A blanket backfill
      // would over-provision legacy non-merge routes (merge_pr authorises on
      // session identity + approved status, not this flag) and would also throw
      // on sentinel-seeded schemas lacking post_approval_session_id.
      runMigration179(db);
      expect(rawFlag(db, 'in-flight')).toBeNull(); // legacy merger stays NULL → runtime derives
      expect(rawFlag(db, 'idle')).toBeNull();
    });

    test('is idempotent — a second run is a no-op and keeps values', () => {
      runMigration179(db);
      const after1 = { inflight: rawFlag(db, 'in-flight'), idle: rawFlag(db, 'idle') };
      expect(() => runMigration179(db)).not.toThrow();
      const after2 = { inflight: rawFlag(db, 'in-flight'), idle: rawFlag(db, 'idle') };
      expect(after2).toEqual(after1);
    });
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      createTables(db);
      runMigrations(db, () => {});
    });

    test('space_tasks carries a NULLABLE post_approval_requires_merge from createTables', () => {
      // Parity: createTables+runMigrations and the test helper (space-test-db.ts)
      // must agree on the column shape. check-db-schema-parity enforces this.
      const col = columnInfo(db, 'space_tasks', 'post_approval_requires_merge');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBeNull();
    });
  });

  describe('missing tables — no-op guard', () => {
    test('runMigration179 on an empty DB does not throw', () => {
      expect(() => runMigration179(db)).not.toThrow();
    });
  });
});
