/**
 * Migration 176 Tests — covering index for the post-approval reconciler sweep.
 *
 * `listApprovedTasks` runs `WHERE status='approved' ORDER BY updated_at DESC,
 * id DESC` every reconciler sweep. Migration 176 adds a covering index
 * `idx_space_tasks_status_updated` on `(status, updated_at DESC, id DESC)`.
 *
 * Covers:
 *   - Index is created on a schema that has the `updated_at` column.
 *   - The index serves the `listApprovedTasks` query (EXPLAIN QUERY PLAN).
 *   - Re-running the migration is a no-op (idempotent).
 *   - No-op when `updated_at` is absent (minimal baseline schemas) and when
 *     `space_tasks` does not exist.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration176 } from '../../../../../src/storage/schema/m176-space-tasks-status-updated-index';

function indexExists(db: BunDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

function tableExists(db: BunDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

/** Minimal `space_tasks` with the columns the index + query need. */
function seedSpaceTasks(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
}

describe('Migration 176: idx_space_tasks_status_updated covering index', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-176',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
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

  test('creates the covering index when updated_at exists', () => {
    seedSpaceTasks(db);
    runMigration176(db);
    expect(indexExists(db, 'idx_space_tasks_status_updated')).toBe(true);
  });

  test('the index serves the listApprovedTasks query', () => {
    seedSpaceTasks(db);
    runMigration176(db);
    // Seed a mix of statuses so the planner has a reason to use the index.
    const stmt = db.prepare(`INSERT INTO space_tasks (id, status, updated_at) VALUES (?, ?, ?)`);
    stmt.run('t1', 'approved', 3);
    stmt.run('t2', 'approved', 1);
    stmt.run('t3', 'open', 2);
    stmt.run('t4', 'done', 4);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM space_tasks WHERE status = 'approved' ORDER BY updated_at DESC, id DESC`
      )
      .all() as Array<{ detail: string }>;
    const usesIndex = plan.some((row) => row.detail.includes('idx_space_tasks_status_updated'));
    expect(usesIndex).toBe(true);
  });

  test('is idempotent — a second run does not throw and the index remains', () => {
    seedSpaceTasks(db);
    runMigration176(db);
    expect(() => runMigration176(db)).not.toThrow();
    expect(indexExists(db, 'idx_space_tasks_status_updated')).toBe(true);
  });

  test('is a no-op when updated_at is absent (minimal baseline schema)', () => {
    // Baseline sentinel schema used by migration-runner tests lacks updated_at.
    db.exec(`
      CREATE TABLE space_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'open',
        task_agent_session_id TEXT
      )
    `);
    expect(() => runMigration176(db)).not.toThrow();
    expect(indexExists(db, 'idx_space_tasks_status_updated')).toBe(false);
  });

  test('is a no-op when space_tasks does not exist', () => {
    expect(() => runMigration176(db)).not.toThrow();
    expect(tableExists(db, 'space_tasks')).toBe(false);
    expect(indexExists(db, 'idx_space_tasks_status_updated')).toBe(false);
  });
});
