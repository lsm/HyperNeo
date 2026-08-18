import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration60 } from '../../../../../src/storage/schema/migrations.ts';

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

describe('Migration 60: Drop session group tables and remove current_node_id', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-60', `test-${Date.now()}`);
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

  test('space_session_groups table does NOT exist after full migration', () => {
    runMigrations(db, () => {});
    expect(tableExists(db, 'space_session_groups')).toBe(false);
  });

  test('space_session_group_members table does NOT exist after full migration', () => {
    runMigrations(db, () => {});
    expect(tableExists(db, 'space_session_group_members')).toBe(false);
  });

  test('space_workflow_runs does NOT have current_node_id after full migration', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
  });

  test('space_workflow_runs still has required columns after M60', () => {
    runMigrations(db, () => {});

    for (const col of ['id', 'space_id', 'workflow_id', 'status']) {
      expect(columnExists(db, 'space_workflow_runs', col)).toBe(true);
    }
    expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);

    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
  });

  test('runMigration60 is idempotent — running twice does not error', () => {
    runMigrations(db, () => {});
    expect(() => runMigration60(db)).not.toThrow();
    expect(tableExists(db, 'space_session_groups')).toBe(false);
    expect(tableExists(db, 'space_session_group_members')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
  });

  test('existing workflow run rows are preserved after M60 drops current_node_id', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT, allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', start_step_id TEXT, config TEXT, layout TEXT,
				max_iterations INTEGER,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
    db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
				title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0, current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
				config TEXT,
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('sp-1', '/workspace/m59', 'M59 Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'Workflow', now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, iteration_count, max_iterations, goal_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'sp-1', 'wf-1', 'Test Run', 'in_progress', 3, 10, 'goal-abc', now, now);

    runMigrations(db, () => {});

    const row = db
      .prepare(
        `SELECT id, space_id, workflow_id, title, status FROM space_workflow_runs WHERE id = 'run-1'`
      )
      .get() as {
      id: string;
      space_id: string;
      workflow_id: string;
      title: string;
      status: string;
    };

    expect(row).toBeTruthy();
    expect(row.id).toBe('run-1');
    expect(row.space_id).toBe('sp-1');
    expect(row.workflow_id).toBe('wf-1');
    expect(row.title).toBe('Test Run');
    expect(row.status).toBe('in_progress');
  });
});
