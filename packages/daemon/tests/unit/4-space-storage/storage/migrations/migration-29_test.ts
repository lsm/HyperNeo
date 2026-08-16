/**
 * Migration 29 Tests
 *
 * Tests for Migration 29: Space system tables (consolidated from former migrations 29–32).
 *
 * Covers:
 * - All Space tables created correctly on a fresh DB
 * - Migration is idempotent (runs twice without error)
 * - No existing tables are affected
 * - FK CASCADE deletes work: delete space → all child rows deleted
 * - space_tasks.workflow_run_id SET NULL on workflow run delete
 * - CHECK constraints are enforced (status, priority, etc.)
 * - Indexes are created
 *
 * NOTE: Several columns originally added by M29 were subsequently removed:
 * - space_tasks.custom_agent_id, workflow_node_id — removed by M73
 * - space_workflow_runs.config — removed by M73
 * - space_tasks status values changed by M73 ('pending'→'open', 'completed'→'done', etc.)
 * - space_agents.role, config, inject_workflow_context — removed by M74
 * - space_workflows.config, max_iterations — removed by M74
 * - space_workflow_nodes.order_index, agent_id — removed by M74
 * Tests have been updated to reflect the post-M74 schema.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { buildMigratedTemplate, openEmptyDb, openMigratedClone } from './test-db-template';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return info.some((c) => c.name === column);
}

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 29: Space system tables', () => {
  let testDir: string;
  let db: BunDatabase;
  let templateDir: string;
  let templatePath: string;
  let cloneCounter = 0;

  // The full migration chain is replayed once here; every test below starts
  // from a file-clone of this template, so each test's runMigrations() call
  // is a fast marker-only no-op replay instead of a full chain rebuild.
  beforeAll(() => {
    templateDir = join(process.cwd(), 'tmp', 'test-migration-29', `template-${Date.now()}`);
    templatePath = buildMigratedTemplate(templateDir);
  }, 30_000);

  afterAll(() => {
    try {
      rmSync(templateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    cloneCounter += 1;
    testDir = join(process.cwd(), 'tmp', 'test-migration-29', `test-${Date.now()}-${cloneCounter}`);
    db = openMigratedClone(templatePath, testDir);
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

  // -------------------------------------------------------------------------
  // Table creation
  // -------------------------------------------------------------------------

  test('all Space tables are created after migration', () => {
    runMigrations(db, () => {});

    const expectedTables = [
      'spaces',
      'space_agents',
      'space_workflows',
      'space_workflow_nodes',
      'space_workflow_runs',
      'space_tasks',
    ];
    // Note: space_session_groups and space_session_group_members were dropped by migration 60.

    for (const table of expectedTables) {
      expect(tableExists(db, table)).toBe(true);
    }
  }, 15_000);

  test('migration is idempotent — running twice does not throw', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  }, 15_000);

  // -------------------------------------------------------------------------
  // space_tasks columns — post-M73 schema
  // -------------------------------------------------------------------------

  test('space_tasks does NOT have custom_agent_id column after M73 removed it', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_tasks', 'custom_agent_id')).toBe(false);
  });

  test('legacy space_tasks without custom_agent_id is upgraded safely', () => {
    // Simulate an early preview schema missing custom_agent_id. This test
    // builds pre-migration state, so reset the migrated clone to an empty DB
    // first and replay the full chain against the legacy table below.
    try {
      db.close();
    } catch {
      // ignore
    }
    db = openEmptyDb(testDir);
    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
				workflow_run_id TEXT,
				workflow_step_id TEXT,
				created_by_task_id TEXT,
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

    // M29 should add the missing column so intermediate migrations (M30–M72) work.
    // After M73 runs, it removes the column — but M29 must not throw in the process.
    expect(() => runMigrations(db, () => {})).not.toThrow();
    // M73 removes custom_agent_id, so it should NOT exist after all migrations.
    expect(columnExists(db, 'space_tasks', 'custom_agent_id')).toBe(false);
  });

  test('space_tasks has workflow_run_id column', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_tasks', 'workflow_run_id')).toBe(true);
  });

  test('space_tasks does NOT have workflow_node_id column after M73 removed it', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_tasks', 'workflow_node_id')).toBe(false);
  });

  test('space_tasks has labels column (added by M73)', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_tasks', 'labels')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // space_workflow_runs state tracking — post-M73 schema
  // -------------------------------------------------------------------------

  test('space_workflow_runs has all required workflow tracking columns', () => {
    runMigrations(db, () => {});

    const requiredCols = [
      'id',
      'space_id',
      'workflow_id',
      'title',
      'description',
      'status',
      'created_at',
      'updated_at',
      'completed_at',
      'started_at', // added by M73
    ];

    for (const col of requiredCols) {
      expect(columnExists(db, 'space_workflow_runs', col)).toBe(true);
    }

    // M73 removed config, iteration_count, max_iterations, goal_id, current_step_index, current_node_id
    expect(columnExists(db, 'space_workflow_runs', 'config')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'current_step_index')).toBe(false);
  });

  test('space_agents: role dropped by M74, provider retained', () => {
    runMigrations(db, () => {});

    // M74 drops role, config, inject_workflow_context from space_agents
    expect(columnExists(db, 'space_agents', 'role')).toBe(false);
    expect(columnExists(db, 'space_agents', 'provider')).toBe(true);
  });

  test('space_workflows has start_node_id column', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
  });

  test('space_workflow_runs status CHECK constraint is enforced with new values', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    // Insert a space first
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('s-1', 'space-a', '/workspace/a', 'Space A', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 's-1', 'Workflow 1', ${now}, ${now})`
    );

    // Valid status (new M73 values)
    expect(() => {
      db.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-ok', 's-1', 'wf-1', 'Run 1', 'in_progress', ${now}, ${now})`
      );
    }).not.toThrow();

    // 'done' is now a valid status (was 'completed' before M73)
    expect(() => {
      db.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-done', 's-1', 'wf-1', 'Run done', 'done', ${now}, ${now})`
      );
    }).not.toThrow();

    // Invalid status
    expect(() => {
      db.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-bad', 's-1', 'wf-1', 'Run 2', 'invalid_status', ${now}, ${now})`
      );
    }).toThrow();
  });

  // -------------------------------------------------------------------------
  // Indexes — post-M73/M74 schema
  // -------------------------------------------------------------------------

  test('expected indexes are created', () => {
    runMigrations(db, () => {});

    const expectedIndexes = [
      'idx_spaces_status',
      'idx_space_agents_space_id',
      'idx_space_workflows_space_id',
      'idx_space_workflow_nodes_workflow_id',
      // idx_space_workflow_nodes_order removed: M74 drops order_index column
      'idx_space_workflow_runs_space_id',
      'idx_space_workflow_runs_workflow_id',
      'idx_space_tasks_space_id',
      'idx_space_tasks_workflow_run_id',
    ];

    for (const idx of expectedIndexes) {
      expect(indexExists(db, idx)).toBe(true);
    }

    // These indexes were removed (the columns they referenced were dropped by M73/M74)
    expect(indexExists(db, 'idx_space_tasks_workflow_node_id')).toBe(false);
    expect(indexExists(db, 'idx_space_tasks_custom_agent_id')).toBe(false);
    expect(indexExists(db, 'idx_space_workflow_nodes_order')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // CASCADE deletes: delete space → all child rows deleted
  // -------------------------------------------------------------------------

  test('deleting a space cascades to all child tables', () => {
    runMigrations(db, () => {});

    const now = Date.now();

    // Insert a space
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-1', 'cascade-space', '/workspace/cascade', 'Cascade Space', ${now}, ${now})`
    );

    // Insert a space agent (role dropped by M74)
    db.exec(
      `INSERT INTO space_agents (id, space_id, name, created_at, updated_at)
			 VALUES ('agent-1', 'sp-1', 'Agent 1', ${now}, ${now})`
    );

    // Insert a workflow
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 'sp-1', 'Workflow 1', ${now}, ${now})`
    );

    // Insert a workflow node (order_index dropped by M74)
    db.exec(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, created_at, updated_at)
			 VALUES ('step-1', 'wf-1', 'Step 1', ${now}, ${now})`
    );

    // Insert a workflow run
    db.exec(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at)
			 VALUES ('wr-1', 'sp-1', 'wf-1', 'Run 1', ${now}, ${now})`
    );

    // Insert a task (use new status 'open')
    db.exec(
      `INSERT INTO space_tasks (id, space_id, task_number, title, created_at, updated_at)
			 VALUES ('task-1', 'sp-1', 1, 'Task 1', ${now}, ${now})`
    );

    // Delete the space
    db.exec(`DELETE FROM spaces WHERE id = 'sp-1'`);

    // All child rows should be gone
    expect(db.prepare(`SELECT * FROM space_agents WHERE space_id = 'sp-1'`).all()).toHaveLength(0);
    expect(db.prepare(`SELECT * FROM space_workflows WHERE space_id = 'sp-1'`).all()).toHaveLength(
      0
    );
    expect(
      db.prepare(`SELECT * FROM space_workflow_nodes WHERE workflow_id = 'wf-1'`).all()
    ).toHaveLength(0);
    expect(
      db.prepare(`SELECT * FROM space_workflow_runs WHERE space_id = 'sp-1'`).all()
    ).toHaveLength(0);
    expect(db.prepare(`SELECT * FROM space_tasks WHERE space_id = 'sp-1'`).all()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // SET NULL on space_workflow_runs delete
  // -------------------------------------------------------------------------

  test('deleting a workflow run sets space_tasks.workflow_run_id to NULL', () => {
    runMigrations(db, () => {});

    const now = Date.now();

    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-2', 'setnull-space', '/workspace/setnull', 'SetNull Space', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-2', 'sp-2', 'Workflow 2', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at)
			 VALUES ('wr-2', 'sp-2', 'wf-2', 'Run 2', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO space_tasks (id, space_id, task_number, title, workflow_run_id, created_at, updated_at)
			 VALUES ('task-2', 'sp-2', 1, 'Task 2', 'wr-2', ${now}, ${now})`
    );

    // Delete the workflow run
    db.exec(`DELETE FROM space_workflow_runs WHERE id = 'wr-2'`);

    // Task should still exist, but workflow_run_id should be NULL
    const task = db.prepare(`SELECT * FROM space_tasks WHERE id = 'task-2'`).get() as Record<
      string,
      unknown
    >;
    expect(task).toBeTruthy();
    expect(task['workflow_run_id']).toBeNull();
  });

  // -------------------------------------------------------------------------
  // CHECK constraints on space_tasks — post-M73 values
  // -------------------------------------------------------------------------

  test('space_tasks status CHECK constraint is enforced', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-3', 'check-space', '/workspace/checks', 'Check Space', ${now}, ${now})`
    );

    // Valid status values (new M73 values)
    let taskNum = 0;
    for (const status of ['open', 'in_progress', 'done', 'blocked', 'cancelled', 'archived']) {
      taskNum++;
      expect(() => {
        db.exec(
          `INSERT INTO space_tasks (id, space_id, task_number, title, status, created_at, updated_at)
					 VALUES ('t-${status}', 'sp-3', ${taskNum}, 'Task', '${status}', ${now}, ${now})`
        );
      }).not.toThrow();
    }

    // Old values like 'pending', 'draft', 'completed' are now invalid
    expect(() => {
      db.exec(
        `INSERT INTO space_tasks (id, space_id, task_number, title, status, created_at, updated_at)
				 VALUES ('t-bad', 'sp-3', ${taskNum + 1}, 'Task', 'invalid', ${now}, ${now})`
      );
    }).toThrow();
  });

  test('space_tasks priority CHECK constraint is enforced', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-4', 'priority-space', '/workspace/priority', 'Priority Space', ${now}, ${now})`
    );

    expect(() => {
      db.exec(
        `INSERT INTO space_tasks (id, space_id, task_number, title, priority, created_at, updated_at)
				 VALUES ('t-urgent', 'sp-4', 1, 'Task', 'urgent', ${now}, ${now})`
      );
    }).not.toThrow();

    expect(() => {
      db.exec(
        `INSERT INTO space_tasks (id, space_id, task_number, title, priority, created_at, updated_at)
				 VALUES ('t-bad-pri', 'sp-4', 2, 'Task', 'extreme', ${now}, ${now})`
      );
    }).toThrow();
  });

  // -------------------------------------------------------------------------
  // spaces workspace_path uniqueness
  // -------------------------------------------------------------------------

  test('spaces.workspace_path is unique', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-u1', 'space-u1', '/workspace/unique', 'Space U1', ${now}, ${now})`
    );

    expect(() => {
      db.exec(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
				 VALUES ('sp-u2', 'space-u2', '/workspace/unique', 'Space U2', ${now}, ${now})`
      );
    }).toThrow();
  });

  // -------------------------------------------------------------------------
  // No existing tables affected
  // -------------------------------------------------------------------------

  test('no existing core tables are dropped or modified by migration 29', () => {
    runMigrations(db, () => {});

    // These tables are created by runMigrations / createTables and must still exist
    const tablesFromEarlierMigrations = ['mission_metric_history', 'mission_executions'];

    for (const table of tablesFromEarlierMigrations) {
      expect(tableExists(db, table)).toBe(true);
    }
  });
});
