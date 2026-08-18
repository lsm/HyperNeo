import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, createTables } from '../../../../../src/storage/schema/index.ts';
import { runMigration51 } from '../../../../../src/storage/schema/migrations.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const result = db
    .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = ?`)
    .get(column);
  return !!result;
}

function getIndexes(db: BunDatabase, table: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`)
    .all(table) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('Migration 51: slot_role → agent_name + completion_summary on space_tasks', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-51', `test-${Date.now()}`);
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

  test('fresh DB does NOT have agent_name or completion_summary (removed by M71)', () => {
    runMigrations(db, () => {});
    createTables(db);

    expect(columnExists(db, 'space_tasks', 'agent_name')).toBe(false);
    expect(columnExists(db, 'space_tasks', 'completion_summary')).toBe(false);
    expect(columnExists(db, 'space_tasks', 'slot_role')).toBe(false);
    expect(columnExists(db, 'space_tasks', 'labels')).toBe(true);
  });

  test('fresh DB has correct indexes after M71 rebuild', () => {
    runMigrations(db, () => {});
    createTables(db);

    const indexes = getIndexes(db, 'space_tasks');
    expect(indexes).toContain('idx_space_tasks_space_id');
    expect(indexes).toContain('idx_space_tasks_workflow_run_id');
    expect(indexes).not.toContain('idx_space_tasks_status');
    expect(indexes).not.toContain('idx_space_tasks_workflow_node_id');
    expect(indexes).toContain('idx_space_tasks_goal_id');
    expect(indexes).not.toContain('idx_space_tasks_custom_agent_id');
    expect(indexes).not.toContain('idx_space_tasks_task_agent_session_id');
  });

  test('existing DB with slot_role gets renamed to agent_name', () => {
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
				status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
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
				current_node_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending',
				config TEXT,
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

    db.exec(`
			CREATE TABLE space_workflow_nodes (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
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
				slot_role TEXT,
				workflow_run_id TEXT,
				workflow_node_id TEXT,
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
				FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
			)
		`);
    db.exec(`CREATE INDEX idx_space_tasks_space_id ON space_tasks(space_id)`);
    db.exec(`CREATE INDEX idx_space_tasks_status ON space_tasks(status)`);
    db.exec(`CREATE INDEX idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`);
    db.exec(`CREATE INDEX idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`);
    db.exec(`CREATE INDEX idx_space_tasks_goal_id ON space_tasks(goal_id)`);
    db.exec(`CREATE INDEX idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`);
    db.exec(
      `CREATE INDEX idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
    );

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace/test', 'Test Space', now, now);

    db.prepare(
      `INSERT INTO space_tasks (id, space_id, title, description, slot_role, depends_on, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('task-1', 'space-1', 'Task 1', 'Desc 1', 'coder-role', '[]', now, now);

    db.prepare(
      `INSERT INTO space_tasks (id, space_id, title, description, slot_role, depends_on, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('task-2', 'space-1', 'Task 2', 'Desc 2', null, '[]', now, now);

    runMigration51(db);

    expect(columnExists(db, 'space_tasks', 'agent_name')).toBe(true);
    expect(columnExists(db, 'space_tasks', 'completion_summary')).toBe(true);
    expect(columnExists(db, 'space_tasks', 'slot_role')).toBe(false);
  });

  test('existing DB: slot_role values are preserved as agent_name', () => {
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE space_workflow_runs (id TEXT PRIMARY KEY, space_id TEXT, workflow_id TEXT,
				title TEXT, description TEXT DEFAULT '', current_step_index INTEGER DEFAULT 0,
				current_node_id TEXT, status TEXT DEFAULT 'pending', config TEXT,
				iteration_count INTEGER DEFAULT 0, max_iterations INTEGER DEFAULT 5,
				goal_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)
		`);
    db.exec(`
			CREATE TABLE space_workflow_nodes (id TEXT PRIMARY KEY, workflow_id TEXT, name TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
		`);
    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				slot_role TEXT,
				workflow_run_id TEXT,
				workflow_node_id TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`PRAGMA foreign_keys = ON`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('s1', '/ws', 'S', now, now);
    db.prepare(
      `INSERT INTO space_tasks (id, space_id, title, description, slot_role, depends_on, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('t1', 's1', 'Title', 'Desc', 'reviewer', '[]', now, now);
    db.prepare(
      `INSERT INTO space_tasks (id, space_id, title, description, slot_role, depends_on, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('t2', 's1', 'Title2', 'Desc2', null, '[]', now, now);

    runMigration51(db);

    const t1 = db.prepare(`SELECT * FROM space_tasks WHERE id = ?`).get('t1') as Record<
      string,
      unknown
    >;
    const t2 = db.prepare(`SELECT * FROM space_tasks WHERE id = ?`).get('t2') as Record<
      string,
      unknown
    >;

    expect(t1['agent_name']).toBe('reviewer');
    expect(t1['completion_summary']).toBeNull();

    expect(t2['agent_name']).toBeNull();
    expect(t2['completion_summary']).toBeNull();
  });

  test('migration is idempotent — running twice does not fail', () => {
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE space_workflow_runs (id TEXT PRIMARY KEY, space_id TEXT, workflow_id TEXT,
				title TEXT, description TEXT DEFAULT '', current_step_index INTEGER DEFAULT 0,
				current_node_id TEXT, status TEXT DEFAULT 'pending', config TEXT,
				iteration_count INTEGER DEFAULT 0, max_iterations INTEGER DEFAULT 5,
				goal_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)
		`);
    db.exec(`
			CREATE TABLE space_workflow_nodes (id TEXT PRIMARY KEY, workflow_id TEXT, name TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
		`);
    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				slot_role TEXT,
				workflow_run_id TEXT,
				workflow_node_id TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`PRAGMA foreign_keys = ON`);

    expect(() => runMigration51(db)).not.toThrow();

    expect(() => runMigration51(db)).not.toThrow();

    expect(columnExists(db, 'space_tasks', 'agent_name')).toBe(true);
    expect(columnExists(db, 'space_tasks', 'completion_summary')).toBe(true);
    expect(columnExists(db, 'space_tasks', 'slot_role')).toBe(false);
  });
});
