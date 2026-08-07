/**
 * Migration 174 Tests — composite (space_id, status, updated_at, id) index on
 * space_tasks.
 *
 * The Tasks view renders through listByStatus / listBySpaceAndStatus /
 * listBySpace, which all filter by space_id (+ an optional status equality)
 * and ORDER BY updated_at DESC, id DESC. The legacy single-column
 * idx_space_tasks_status was dropped and never replaced, so every render
 * scanned all non-archived rows in the space and post-filtered on status.
 *
 * Covers:
 *   - Fresh, fully-migrated DB — the index exists.
 *   - Pre-174 schema — runMigration174 creates the index with the expected
 *     column order and DESC sort direction.
 *   - EXPLAIN QUERY PLAN for the Tasks-view query shapes uses the index and
 *     does not fall back to a full table scan.
 *   - Idempotent and a no-op when space_tasks is absent.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import {
  createTables,
  runMigration174,
  runMigrations,
} from '../../../../../src/storage/schema/index.ts';

function indexExists(db: BunDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

/**
 * Minimal pre-174 space_tasks schema (the columns the indexed queries touch).
 * Mirrors the column subset the real table exposes after the status-CHECK
 * migrations; the index only needs space_id/status/updated_at/id to exist.
 */
function seedSpaceTasks(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			updated_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			block_reason TEXT
		)
	`);
}

/** Ordered columns + per-column DESC flag, straight from the index definition. */
function indexColumns(db: BunDatabase, name: string): Array<{ name: string; desc: boolean }> {
  return (
    db.prepare(`PRAGMA index_xinfo('${name}')`).all() as Array<{
      cid: number;
      name: string | null;
      desc: number;
    }>
  )
    .filter((row) => row.cid >= 0 && !!row.name)
    .map((row) => ({ name: row.name as string, desc: row.desc === 1 }));
}

function explainQueryPlan(db: BunDatabase, sql: string): string[] {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail);
}

describe('Migration 174: space_tasks (space_id, status, updated_at, id) index', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-174',
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

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      runMigrations(db, () => {});
      createTables(db);
    }, 30_000);

    test('the composite index exists', () => {
      expect(indexExists(db, 'idx_space_tasks_space_status_updated')).toBe(true);
    });
  });

  describe('pre-174 schema', () => {
    beforeEach(() => {
      seedSpaceTasks(db);
    });

    test('creates the index with the expected column order and sort direction', () => {
      runMigration174(db);
      const cols = indexColumns(db, 'idx_space_tasks_space_status_updated');
      expect(cols.map((c) => c.name)).toEqual(['space_id', 'status', 'updated_at', 'id']);
      expect(cols.map((c) => c.desc)).toEqual([false, false, true, true]);
    });

    test('listByStatus query uses the index without a full scan or temp sort', () => {
      runMigration174(db);
      const plan = explainQueryPlan(
        db,
        `SELECT * FROM space_tasks WHERE space_id = ? AND status = ? ORDER BY updated_at DESC, id DESC`
      );
      const joined = plan.join(' | ');
      expect(joined).toContain('idx_space_tasks_space_status_updated');
      // No full table scan...
      expect(joined).not.toMatch(/SCAN space_tasks/);
      // ...and the index satisfies the ORDER BY (no spill to a temp b-tree).
      expect(joined).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    });

    test('listBySpaceAndStatus query uses the index', () => {
      runMigration174(db);
      const plan = explainQueryPlan(
        db,
        `SELECT * FROM space_tasks WHERE space_id = ? AND status = ? AND block_reason = ? ORDER BY updated_at DESC, id DESC`
      );
      const joined = plan.join(' | ');
      expect(joined).toContain('idx_space_tasks_space_status_updated');
      expect(joined).not.toMatch(/SCAN space_tasks/);
    });

    test('listBySpace query scopes to the space via the index prefix', () => {
      runMigration174(db);
      const plan = explainQueryPlan(
        db,
        `SELECT * FROM space_tasks WHERE space_id = ? AND status != 'archived' ORDER BY updated_at DESC, id DESC`
      );
      const joined = plan.join(' | ');
      // The (space_id, status) prefix scopes the scan to the space rather than
      // walking the whole table. We deliberately do NOT assert the absence of
      // "USE TEMP B-TREE FOR ORDER BY" here, unlike listByStatus above: the
      // `status != 'archived'` inequality spans multiple status groups, so the
      // index gives per-group but not global (updated_at, id) order, and a temp
      // b-tree is still required for the final sort.
      expect(joined).toContain('idx_space_tasks_space_status_updated');
      expect(joined).not.toMatch(/SCAN space_tasks/);
    });

    test('is idempotent — running twice does not throw or duplicate', () => {
      runMigration174(db);
      expect(() => runMigration174(db)).not.toThrow();
      // Still exactly one index of this name.
      const count = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_space_tasks_space_status_updated'`
          )
          .get() as { n: number }
      ).n;
      expect(count).toBe(1);
    });
  });

  describe('no-op guards', () => {
    test('does not throw when space_tasks does not exist', () => {
      expect(() => runMigration174(db)).not.toThrow();
      expect(indexExists(db, 'idx_space_tasks_space_status_updated')).toBe(false);
    });

    test('skips sentinel space_tasks missing the indexed columns', () => {
      // The baseline-schema sentinels (see migration-markers-runner) carry a
      // stub space_tasks with only id/status/task_agent_session_id. The
      // migration must not throw on it.
      db.exec(`
				CREATE TABLE space_tasks (
					id TEXT PRIMARY KEY,
					status TEXT NOT NULL DEFAULT 'open',
					task_agent_session_id TEXT
				)
			`);
      expect(() => runMigration174(db)).not.toThrow();
      expect(indexExists(db, 'idx_space_tasks_space_status_updated')).toBe(false);
    });
  });
});
