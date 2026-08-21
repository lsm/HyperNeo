import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { buildMigratedTemplate, openEmptyDb, openMigratedClone } from './test-db-template';

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

describe('Migration 29: Space system tables', () => {
  let testDir: string;
  let db: BunDatabase;
  let templateDir: string;
  let templatePath: string;
  let cloneCounter = 0;

  beforeAll(() => {
    templateDir = join(process.cwd(), 'tmp', 'test-migration-29', `template-${Date.now()}`);
    templatePath = buildMigratedTemplate(templateDir);
  }, 30_000);

  afterAll(() => {
    try {
      rmSync(templateDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    cloneCounter += 1;
    testDir = join(process.cwd(), 'tmp', 'test-migration-29', `test-${Date.now()}-${cloneCounter}`);
    db = openMigratedClone(templatePath, testDir);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

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

    for (const table of expectedTables) {
      expect(tableExists(db, table)).toBe(true);
    }
  }, 15_000);

  test('migration is idempotent — running twice does not throw', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  }, 15_000);

  test('space_tasks does NOT have custom_agent_id column after M73 removed it', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_tasks', 'custom_agent_id')).toBe(false);
  });

  test('legacy space_tasks without custom_agent_id is upgraded safely', () => {
    try {
      db.close();
    } catch {}
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

    expect(() => runMigrations(db, () => {})).not.toThrow();
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
      'started_at',
    ];

    for (const col of requiredCols) {
      expect(columnExists(db, 'space_workflow_runs', col)).toBe(true);
    }

    expect(columnExists(db, 'space_workflow_runs', 'config')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
    expect(columnExists(db, 'space_workflow_runs', 'current_step_index')).toBe(false);
  });

  test('space_agents: role dropped by M74, provider retained', () => {
    runMigrations(db, () => {});

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
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('s-1', 'space-a', '/workspace/a', 'Space A', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 's-1', 'Workflow 1', ${now}, ${now})`
    );

    expect(() => {
      db.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-ok', 's-1', 'wf-1', 'Run 1', 'in_progress', ${now}, ${now})`
      );
    }).not.toThrow();

    expect(() => {
      db.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-done', 's-1', 'wf-1', 'Run done', 'done', ${now}, ${now})`
      );
    }).not.toThrow();

    expect(() => {
      db.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-bad', 's-1', 'wf-1', 'Run 2', 'invalid_status', ${now}, ${now})`
      );
    }).toThrow();
  });

  test('expected indexes are created', () => {
    runMigrations(db, () => {});

    const expectedIndexes = [
      'idx_spaces_status',
      'idx_space_agents_space_id',
      'idx_space_workflows_space_id',
      'idx_space_workflow_nodes_workflow_id',
      'idx_space_workflow_runs_space_id',
      'idx_space_workflow_runs_workflow_id',
      'idx_space_tasks_space_id',
      'idx_space_tasks_workflow_run_id',
    ];

    for (const idx of expectedIndexes) {
      expect(indexExists(db, idx)).toBe(true);
    }

    expect(indexExists(db, 'idx_space_tasks_workflow_node_id')).toBe(false);
    expect(indexExists(db, 'idx_space_tasks_custom_agent_id')).toBe(false);
    expect(indexExists(db, 'idx_space_workflow_nodes_order')).toBe(false);
  });

  test('deleting a space cascades to all child tables', () => {
    runMigrations(db, () => {});

    const now = Date.now();

    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-1', 'cascade-space', '/workspace/cascade', 'Cascade Space', ${now}, ${now})`
    );

    db.exec(
      `INSERT INTO space_agents (id, space_id, name, created_at, updated_at)
			 VALUES ('agent-1', 'sp-1', 'Agent 1', ${now}, ${now})`
    );

    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 'sp-1', 'Workflow 1', ${now}, ${now})`
    );

    db.exec(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, created_at, updated_at)
			 VALUES ('step-1', 'wf-1', 'Step 1', ${now}, ${now})`
    );

    db.exec(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at)
			 VALUES ('wr-1', 'sp-1', 'wf-1', 'Run 1', ${now}, ${now})`
    );

    db.exec(
      `INSERT INTO space_tasks (id, space_id, task_number, title, created_at, updated_at)
			 VALUES ('task-1', 'sp-1', 1, 'Task 1', ${now}, ${now})`
    );

    db.exec(`DELETE FROM spaces WHERE id = 'sp-1'`);

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

    db.exec(`DELETE FROM space_workflow_runs WHERE id = 'wr-2'`);

    const task = db.prepare(`SELECT * FROM space_tasks WHERE id = 'task-2'`).get() as Record<
      string,
      unknown
    >;
    expect(task).toBeTruthy();
    expect(task['workflow_run_id']).toBeNull();
  });

  test('space_tasks status CHECK constraint is enforced', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-3', 'check-space', '/workspace/checks', 'Check Space', ${now}, ${now})`
    );

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

  test('no existing core tables are dropped or modified by migration 29', () => {
    runMigrations(db, () => {});

    const tablesFromEarlierMigrations = ['mission_metric_history', 'mission_executions'];

    for (const table of tablesFromEarlierMigrations) {
      expect(tableExists(db, table)).toBe(true);
    }
  });
});
