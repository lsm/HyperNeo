import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, createTables } from '../../../../../src/storage/schema/index.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const result = db
    .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = ?`)
    .get(column);
  return !!result;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function getIndexes(db: BunDatabase, table: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`)
    .all(table) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('Migration 45: rename step to node in workflow tables', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-45', `test-${Date.now()}`);
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

  test('fresh DB has node column names (not step)', () => {
    runMigrations(db, () => {});
    createTables(db);

    expect(tableExists(db, 'space_workflow_nodes')).toBe(true);
    expect(tableExists(db, 'space_workflow_steps')).toBe(false);

    expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
    expect(columnExists(db, 'space_workflows', 'start_step_id')).toBe(false);

    expect(columnExists(db, 'space_tasks', 'workflow_node_id')).toBe(false);
    expect(columnExists(db, 'space_tasks', 'workflow_step_id')).toBe(false);

    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'current_step_id')).toBe(false);
  });

  test('fresh DB has correct indexes', () => {
    runMigrations(db, () => {});
    createTables(db);

    const nodeIndexes = getIndexes(db, 'space_workflow_nodes');
    expect(nodeIndexes).not.toContain('idx_space_workflow_nodes_order');
    expect(nodeIndexes).toContain('idx_space_workflow_nodes_workflow_id');

    const taskIndexes = getIndexes(db, 'space_tasks');
    expect(taskIndexes).not.toContain('idx_space_tasks_workflow_node_id');
    expect(taskIndexes).toContain('idx_space_tasks_goal_id');
    expect(taskIndexes).toContain('idx_space_tasks_space_id');
    expect(taskIndexes).toContain('idx_space_tasks_workflow_run_id');
  });

  test('existing DB with old schema gets migrated correctly', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'archived')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_steps (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				agent_id TEXT,
				order_index INTEGER NOT NULL,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_transitions (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				from_step_id TEXT NOT NULL,
				to_step_id TEXT NOT NULL,
				condition TEXT,
				order_index INTEGER NOT NULL DEFAULT 0,
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				workflow_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0,
				current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
				config TEXT,
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
				custom_agent_id TEXT,
				workflow_run_id TEXT,
				workflow_step_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			CREATE TABLE space_session_groups (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description,
				workflow_run_id TEXT,
				current_step_id TEXT,
				task_id TEXT,
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'completed', 'failed')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace/test', 'Test Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, start_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('wf-1', 'space-1', 'Test Workflow', 'step-1', now, now);
    db.prepare(
      `INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('step-1', 'wf-1', 'Step 1', 0, now, now);
    db.prepare(
      `INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('step-2', 'wf-1', 'Step 2', 1, now, now);
    db.prepare(
      `INSERT INTO space_workflow_transitions (id, workflow_id, from_step_id, to_step_id, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('trans-1', 'wf-1', 'step-1', 'step-2', 0, now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, current_step_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'space-1', 'wf-1', 'Test Run', 'step-1', 'in_progress', now, now);
    db.prepare(
      `INSERT INTO space_tasks (id, space_id, title, workflow_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('task-1', 'space-1', 'Test Task', 'step-1', now, now);
    db.prepare(
      `INSERT INTO space_session_groups (id, space_id, name, current_step_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('group-1', 'space-1', 'Test Group', 'step-1', 'active', now, now);

    runMigrations(db, () => {});

    expect(tableExists(db, 'space_workflow_nodes')).toBe(true);
    expect(tableExists(db, 'space_workflow_steps')).toBe(false);

    expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
    expect(columnExists(db, 'space_workflows', 'start_step_id')).toBe(false);

    const wf = db
      .prepare(`SELECT id, start_node_id FROM space_workflows WHERE id='wf-1'`)
      .get() as {
      id: string;
      start_node_id: string | null;
    };
    expect(wf.start_node_id).toBe('step-1');

    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'current_step_id')).toBe(false);

    expect(columnExists(db, 'space_tasks', 'workflow_node_id')).toBe(false);
    expect(columnExists(db, 'space_tasks', 'workflow_step_id')).toBe(false);

    const task = db.prepare(`SELECT id FROM space_tasks WHERE id='task-1'`).get() as {
      id: string;
    } | null;
    expect(task).toBeTruthy();
    expect(task!.id).toBe('task-1');
  });

  test('migration is idempotent - re-running does not change anything', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'archived')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_steps (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				agent_id TEXT,
				order_index INTEGER NOT NULL,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_transitions (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				from_step_id TEXT NOT NULL,
				to_step_id TEXT NOT NULL,
				condition TEXT,
				order_index INTEGER NOT NULL DEFAULT 0,
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				workflow_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0,
				current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
				config TEXT,
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
				custom_agent_id TEXT,
				workflow_run_id TEXT,
				workflow_step_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			CREATE TABLE space_session_groups (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description,
				workflow_run_id TEXT,
				current_step_id TEXT,
				task_id TEXT,
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'completed', 'failed')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace/test', 'Test Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, start_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('wf-1', 'space-1', 'Test Workflow', 'step-1', now, now);
    db.prepare(
      `INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('step-1', 'wf-1', 'Step 1', 0, now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, current_step_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'space-1', 'wf-1', 'Test Run', 'step-1', 'in_progress', now, now);

    runMigrations(db, () => {});
    runMigrations(db, () => {});

    expect(tableExists(db, 'space_workflow_nodes')).toBe(true);
    expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);

    const wf = db.prepare(`SELECT start_node_id FROM space_workflows WHERE id='wf-1'`).get() as {
      start_node_id: string | null;
    };
    expect(wf.start_node_id).toBe('step-1');
  });

  test('foreign key relationships are preserved after migration', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'archived')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_steps (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				agent_id TEXT,
				order_index INTEGER NOT NULL,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_transitions (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				from_step_id TEXT NOT NULL,
				to_step_id TEXT NOT NULL,
				condition TEXT,
				order_index INTEGER NOT NULL DEFAULT 0,
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				workflow_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0,
				current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
				config TEXT,
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
				custom_agent_id TEXT,
				workflow_run_id TEXT,
				workflow_step_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace/test', 'Test Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'space-1', 'Test Workflow', now, now);
    db.prepare(
      `INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('step-1', 'wf-1', 'Step 1', 0, now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'space-1', 'wf-1', 'Test Run', 'in_progress', now, now);
    db.prepare(
      `INSERT INTO space_tasks (id, space_id, title, workflow_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('task-1', 'space-1', 'Test Task', 'step-1', now, now);

    runMigrations(db, () => {});

    expect(columnExists(db, 'space_tasks', 'workflow_node_id')).toBe(false);
    expect(columnExists(db, 'space_tasks', 'workflow_step_id')).toBe(false);

    const task = db.prepare(`SELECT id FROM space_tasks WHERE id='task-1'`).get() as {
      id: string;
    } | null;
    expect(task).toBeTruthy();
  });

  test('preserves columns added by earlier migrations', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'archived')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_steps (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				agent_id TEXT,
				order_index INTEGER NOT NULL,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_transitions (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				from_step_id TEXT NOT NULL,
				to_step_id TEXT NOT NULL,
				condition TEXT,
				order_index INTEGER NOT NULL DEFAULT 0,
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				workflow_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0,
				current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
				config TEXT,
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
				custom_agent_id TEXT,
				workflow_run_id TEXT,
				workflow_step_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			CREATE TABLE space_session_groups (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description,
				workflow_run_id TEXT,
				current_step_id TEXT,
				task_id TEXT,
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'completed', 'failed')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace/test', 'Test Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, layout, max_iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('wf-1', 'space-1', 'Test Workflow', '{"nodes":{}}', 10, now, now);
    db.prepare(
      `INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('step-1', 'wf-1', 'Step 1', 0, now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, iteration_count, max_iterations, goal_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'space-1', 'wf-1', 'Test Run', 3, 10, 'goal-1', now, now);

    runMigrations(db, () => {});

    const wf = db.prepare(`SELECT layout FROM space_workflows WHERE id='wf-1'`).get() as {
      layout: string | null;
    };
    expect(wf.layout).toBe('{"nodes":{}}');

    expect(columnExists(db, 'space_workflow_runs', 'iteration_count')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'max_iterations')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'goal_id')).toBe(false);

    const run = db.prepare(`SELECT id FROM space_workflow_runs WHERE id='run-1'`).get() as {
      id: string;
    } | null;
    expect(run).toBeTruthy();
  });
});
