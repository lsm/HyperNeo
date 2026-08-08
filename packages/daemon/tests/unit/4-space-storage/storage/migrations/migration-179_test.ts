/**
 * Migration 179 Tests — `space_tasks.post_approval_requires_merge` flag + backfill.
 *
 * The flag lets resolveSpaceMcpSessionPolicy / rehydrateSubSession recognise the
 * designated merger PRECISELY. The router sets it for every NEW dispatch; this
 * migration must also backfill LEGACY in-flight rows (dispatched before this
 * migration, mid-merge at upgrade time) so a restarted merger still gets
 * space-agent-tools. Covers only the migration itself (column add + one-time
 * backfill); the runtime consumers are covered by their own suites.
 *
 * Covers:
 *   - Pre-M179 schema: the column is added and in-flight rows (post_approval_session_id
 *     IS NOT NULL) are backfilled to 1; others stay 0.
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

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
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

function flag(db: BunDatabase, id: string): number {
  return (
    db
      .prepare(`SELECT post_approval_requires_merge AS v FROM space_tasks WHERE id = ?`)
      .get(id) as {
      v: number;
    }
  ).v;
}

describe('Migration 179: space_tasks.post_approval_requires_merge flag + backfill', () => {
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

  describe('pre-M179 schema — add column + backfill', () => {
    beforeEach(() => {
      seedPreM179Schema(db);
      // Legacy in-flight merger (mid-post-approval at upgrade time).
      db.prepare(`INSERT INTO space_tasks (id, post_approval_session_id) VALUES (?, ?)`).run(
        'in-flight',
        'space:sp:task:t1:post-approval:merger'
      );
      // Legacy task NOT in post-approval.
      db.prepare(`INSERT INTO space_tasks (id, post_approval_session_id) VALUES (?, ?)`).run(
        'idle',
        null
      );
    });

    test('adds the NOT NULL DEFAULT 0 column', () => {
      expect(columnNames(db, 'space_tasks')).not.toContain('post_approval_requires_merge');
      runMigration179(db);
      expect(columnNames(db, 'space_tasks')).toContain('post_approval_requires_merge');
    });

    test('backfills in-flight post-approval rows to 1 and leaves others 0 (#879 upgrade safety)', () => {
      runMigration179(db);
      expect(flag(db, 'in-flight')).toBe(1); // legacy merger preserved across restart
      expect(flag(db, 'idle')).toBe(0);
    });

    test('is idempotent — a second run keeps the same values', () => {
      runMigration179(db);
      const after1 = { inflight: flag(db, 'in-flight'), idle: flag(db, 'idle') };
      expect(() => runMigration179(db)).not.toThrow();
      const after2 = { inflight: flag(db, 'in-flight'), idle: flag(db, 'idle') };
      expect(after2).toEqual(after1);
    });
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      createTables(db);
      runMigrations(db, () => {});
    });

    test('space_tasks carries post_approval_requires_merge from createTables', () => {
      expect(columnNames(db, 'space_tasks')).toContain('post_approval_requires_merge');
    });
  });

  describe('missing tables — no-op guard', () => {
    test('runMigration179 on an empty DB does not throw', () => {
      expect(() => runMigration179(db)).not.toThrow();
    });
  });
});
