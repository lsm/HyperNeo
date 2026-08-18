import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

describe('Migration 35: Add iteration tracking to space_workflow_runs', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-35-36', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
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

  test('fresh DB: iteration_count column is absent after M71 removed it', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_workflow_runs', 'iteration_count')).toBe(false);
  });

  test('fresh DB: max_iterations column is absent on space_workflow_runs after M71', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_workflow_runs', 'max_iterations')).toBe(false);
  });

  test('fresh DB: new runs can be inserted without iteration columns', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'test-space', '/workspace/project', 'Test Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'space-1', 'Test Workflow', now, now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('run-1', 'space-1', 'wf-1', 'Run #1', now, now)
    ).not.toThrow();
  });

  test('idempotency: running migration twice does not error', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });

  test('upgrade path: migrations can run on older DB schema', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT, allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', start_step_id TEXT, config TEXT, layout TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
    db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
				title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0, current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending', config TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace', 'S', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'space-1', 'WF', now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'space-1', 'wf-1', 'Old Run', 'in_progress', now, now);

    expect(() => runMigrations(db, () => {})).not.toThrow();
  });
});

describe('Migration 36: Add max_iterations to space_workflows', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-35-36', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
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

  test('fresh DB: max_iterations column does NOT exist on space_workflows after M74 dropped it', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_workflows', 'max_iterations')).toBe(false);
  });

  test('fresh DB: new workflows can be inserted without max_iterations', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'test-space', '/workspace/project', 'Test Space', now, now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
        )
        .run('wf-1', 'space-1', 'Test Workflow', now, now)
    ).not.toThrow();
  });

  test('idempotency: running migration twice does not error', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });
});
