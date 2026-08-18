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
      expect(joined).not.toMatch(/SCAN space_tasks/);
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
      expect(joined).toContain('idx_space_tasks_space_status_updated');
      expect(joined).not.toMatch(/SCAN space_tasks/);
    });

    test('is idempotent — running twice does not throw or duplicate', () => {
      runMigration174(db);
      expect(() => runMigration174(db)).not.toThrow();
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
