import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration74 } from '../../../../../src/storage/schema/migrations.ts';

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function indexExists(db: BunDatabase, indexName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName);
  return !!row;
}

function createPreM74Schema(db: BunDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF');

  db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			workspace_path TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			background_context TEXT NOT NULL DEFAULT '',
			instructions TEXT NOT NULL DEFAULT '',
			default_model TEXT,
			allowed_models TEXT NOT NULL DEFAULT '[]',
			session_ids TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
			autonomy_level TEXT NOT NULL DEFAULT 'supervised',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

  db.exec(`
		CREATE TABLE space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			system_prompt TEXT NOT NULL DEFAULT '',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			role TEXT NOT NULL DEFAULT '',
			provider TEXT,
			inject_workflow_context INTEGER NOT NULL DEFAULT 0,
			instructions TEXT,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX idx_space_agents_space_id ON space_agents(space_id)`);

  db.exec(`
		CREATE TABLE space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_node_id TEXT,
			end_node_id TEXT,
			config TEXT,
			layout TEXT,
			max_iterations INTEGER,
			channels TEXT,
			gates TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX idx_space_workflows_space_id ON space_workflows(space_id)`);

  db.exec(`
		CREATE TABLE space_workflow_nodes (
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
  db.exec(`CREATE INDEX idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id)`);
  db.exec(
    `CREATE INDEX idx_space_workflow_nodes_order ON space_workflow_nodes(workflow_id, order_index)`
  );

  db.exec(`
		CREATE TABLE space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
			failure_reason TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`);

  db.exec(`
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_number INTEGER NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open'
				CHECK(status IN ('open', 'in_progress', 'done', 'blocked', 'cancelled', 'archived')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			labels TEXT NOT NULL DEFAULT '[]',
			workflow_run_id TEXT,
			created_by_task_id TEXT,
			result TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			active_session TEXT CHECK(active_session IN ('worker', 'leader')),
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
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
		)
	`);

  db.exec('PRAGMA foreign_keys = ON');
}

describe('Migration 74: Remaining schema cleanup', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-74', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('node_executions table is created with correct columns', () => {
    createPreM74Schema(db);
    runMigration74(db);

    expect(tableExists(db, 'node_executions')).toBe(true);

    const requiredColumns = [
      'id',
      'workflow_run_id',
      'workflow_node_id',
      'agent_name',
      'agent_id',
      'agent_session_id',
      'status',
      'result',
      'created_at',
      'started_at',
      'completed_at',
      'updated_at',
    ];
    for (const col of requiredColumns) {
      expect(columnExists(db, 'node_executions', col)).toBe(true);
    }
  });

  test('node_executions has correct indexes', () => {
    createPreM74Schema(db);
    runMigration74(db);

    expect(indexExists(db, 'idx_node_executions_run')).toBe(true);
    expect(indexExists(db, 'idx_node_executions_node')).toBe(true);
  });

  test('node_executions status CHECK constraint is enforced', () => {
    createPreM74Schema(db);
    runMigration74(db);

    const now = Date.now();

    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF', now, now);
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('ag-1', 'sp-1', 'Agent', now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'sp-1', 'wf-1', 'Run', 'pending', now, now);

    for (const status of ['pending', 'in_progress', 'done', 'blocked', 'cancelled']) {
      expect(() => {
        db.prepare(
          `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`ne-${status}`, 'run-1', 'node-1', 'agent', 'ag-1', status, now, now);
      }).not.toThrow();
    }

    expect(() => {
      db.prepare(
        `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('ne-bad', 'run-1', 'node-1', 'agent', 'ag-1', 'invalid_status', now, now);
    }).toThrow();
  });

  test('node_executions: deleting space_agent sets agent_id to NULL (ON DELETE SET NULL)', () => {
    createPreM74Schema(db);
    runMigration74(db);

    const now = Date.now();

    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('ag-1', 'sp-1', 'Agent', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF', now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'sp-1', 'wf-1', 'Run', 'pending', now, now);
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ne-1', 'run-1', 'node-1', 'Agent', 'ag-1', 'in_progress', now, now);

    const before = db.prepare(`SELECT agent_id FROM node_executions WHERE id = ?`).get('ne-1') as {
      agent_id: string | null;
    };
    expect(before.agent_id).toBe('ag-1');

    db.prepare(`DELETE FROM space_agents WHERE id = ?`).run('ag-1');

    const after = db.prepare(`SELECT agent_id FROM node_executions WHERE id = ?`).get('ne-1') as {
      agent_id: string | null;
    };
    expect(after.agent_id).toBeNull();
  });

  test('node_executions is created via full migration chain', () => {
    runMigrations(db, () => {});
    expect(tableExists(db, 'node_executions')).toBe(true);
  });

  test('space_workflows: config and max_iterations columns are dropped', () => {
    createPreM74Schema(db);
    runMigration74(db);

    expect(columnExists(db, 'space_workflows', 'config')).toBe(false);
    expect(columnExists(db, 'space_workflows', 'max_iterations')).toBe(false);
  });

  test('space_workflows: tags column exists with extracted data', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);

    const configWithTags = JSON.stringify({ tags: ['coding', 'review'], extra: 'data' });
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF1', configWithTags, now, now);

    const configNoTags = JSON.stringify({ other: 'value' });
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('wf-2', 'sp-1', 'WF2', configNoTags, now, now);

    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('wf-3', 'sp-1', 'WF3', null, now, now);

    const configEmptyTags = JSON.stringify({ tags: [] });
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('wf-4', 'sp-1', 'WF4', configEmptyTags, now, now);

    runMigration74(db);

    const wf1 = db.prepare(`SELECT tags FROM space_workflows WHERE id = 'wf-1'`).get() as {
      tags: string;
    };
    expect(JSON.parse(wf1.tags)).toEqual(['coding', 'review']);

    const wf2 = db.prepare(`SELECT tags FROM space_workflows WHERE id = 'wf-2'`).get() as {
      tags: string;
    };
    expect(JSON.parse(wf2.tags)).toEqual([]);

    const wf3 = db.prepare(`SELECT tags FROM space_workflows WHERE id = 'wf-3'`).get() as {
      tags: string;
    };
    expect(JSON.parse(wf3.tags)).toEqual([]);

    const wf4 = db.prepare(`SELECT tags FROM space_workflows WHERE id = 'wf-4'`).get() as {
      tags: string;
    };
    expect(JSON.parse(wf4.tags)).toEqual([]);
  });

  test('space_workflows: other columns preserved during rebuild', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);

    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, description, start_node_id, end_node_id, layout, channels, gates, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'wf-1',
      'sp-1',
      'My Workflow',
      'A test workflow',
      'node-start',
      'node-end',
      '{"node-1": {"x": 100, "y": 200}}',
      '[{"id": "ch-1"}]',
      '[{"id": "g-1"}]',
      now,
      now
    );

    runMigration74(db);

    const row = db
      .prepare(
        `SELECT name, description, start_node_id, end_node_id, layout, channels, gates FROM space_workflows WHERE id = 'wf-1'`
      )
      .get() as Record<string, unknown>;

    expect(row.name).toBe('My Workflow');
    expect(row.description).toBe('A test workflow');
    expect(row.start_node_id).toBe('node-start');
    expect(row.end_node_id).toBe('node-end');
    expect(row.layout).toBe('{"node-1": {"x": 100, "y": 200}}');
    expect(row.channels).toBe('[{"id": "ch-1"}]');
    expect(row.gates).toBe('[{"id": "g-1"}]');
  });

  test('space_workflow_nodes: order_index and agent_id are dropped', () => {
    createPreM74Schema(db);
    runMigration74(db);

    expect(columnExists(db, 'space_workflow_nodes', 'order_index')).toBe(false);
    expect(columnExists(db, 'space_workflow_nodes', 'agent_id')).toBe(false);
  });

  test('space_workflow_nodes: config column is preserved with data', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF', now, now);

    const configJson = JSON.stringify({
      instructions: 'Implement the feature',
      agents: [{ agentId: 'ag-1', name: 'coder', systemPrompt: 'You are a coder' }],
    });
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, agent_id, order_index, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('node-1', 'wf-1', 'Code', null, 0, configJson, now, now);

    runMigration74(db);

    const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = 'node-1'`).get() as {
      config: string;
    };
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    expect(cfg.instructions).toBe('Implement the feature');
    expect((cfg.agents as Array<Record<string, unknown>>)[0].agentId).toBe('ag-1');
  });

  test('space_workflow_nodes: index is recreated', () => {
    createPreM74Schema(db);
    runMigration74(db);

    expect(indexExists(db, 'idx_space_workflow_nodes_workflow_id')).toBe(true);
    expect(indexExists(db, 'idx_space_workflow_nodes_order')).toBe(false);
  });

  test('space_agents: role, config, inject_workflow_context are dropped', () => {
    createPreM74Schema(db);
    runMigration74(db);

    expect(columnExists(db, 'space_agents', 'role')).toBe(false);
    expect(columnExists(db, 'space_agents', 'config')).toBe(false);
    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);
  });

  test('space_agents: remaining columns preserved', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);

    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, config, role, provider, inject_workflow_context, instructions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ag-1',
      'sp-1',
      'Test Agent',
      'A test agent description',
      'claude-sonnet-4-5',
      '["read", "write"]',
      'You are a helpful agent.',
      '{"some": "config"}',
      'coder',
      'anthropic',
      1,
      'Default instructions',
      now,
      now
    );

    runMigration74(db);

    const row = db
      .prepare(
        `SELECT name, description, model, tools, system_prompt, provider, instructions FROM space_agents WHERE id = 'ag-1'`
      )
      .get() as Record<string, unknown>;

    expect(row.name).toBe('Test Agent');
    expect(row.description).toBe('A test agent description');
    expect(row.model).toBe('claude-sonnet-4-5');
    expect(row.tools).toBe('["read", "write"]');
    expect(row.system_prompt).toBe('You are a helpful agent.');
    expect(row.provider).toBe('anthropic');
    expect(row.instructions).toBe('Default instructions');
  });

  test('space_agents: index is recreated', () => {
    createPreM74Schema(db);
    runMigration74(db);

    expect(indexExists(db, 'idx_space_agents_space_id')).toBe(true);
  });

  test('node config JSON: string systemPrompt is wrapped to {mode, value}', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF', now, now);

    const configBefore = JSON.stringify({
      agents: [
        {
          agentId: 'ag-1',
          name: 'coder',
          systemPrompt: 'You are a coding expert',
          instructions: 'Follow TDD',
        },
      ],
    });
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, agent_id, order_index, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('node-1', 'wf-1', 'Code', null, 0, configBefore, now, now);

    runMigration74(db);

    const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = 'node-1'`).get() as {
      config: string;
    };
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    const agent = (cfg.agents as Array<Record<string, unknown>>)[0];

    expect(agent.systemPrompt).toEqual({ mode: 'override', value: 'You are a coding expert' });
    expect(agent.instructions).toEqual({ mode: 'override', value: 'Follow TDD' });
  });

  test('node config JSON: null/empty systemPrompt and instructions are NOT wrapped', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF', now, now);

    const configBefore = JSON.stringify({
      agents: [
        { agentId: 'ag-1', name: 'coder', systemPrompt: null, instructions: '' },
        { agentId: 'ag-2', name: 'reviewer' },
      ],
    });
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, agent_id, order_index, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('node-1', 'wf-1', 'Code', null, 0, configBefore, now, now);

    runMigration74(db);

    const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = 'node-1'`).get() as {
      config: string;
    };
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    const agents = cfg.agents as Array<Record<string, unknown>>;

    expect(agents[0].systemPrompt).toBeNull();
    expect(agents[0].instructions).toBe('');
    expect(agents[1].systemPrompt).toBeUndefined();
    expect(agents[1].instructions).toBeUndefined();
  });

  test('node config JSON: already-wrapped objects are NOT double-wrapped (idempotency)', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF', now, now);

    const configAlreadyWrapped = JSON.stringify({
      agents: [
        {
          agentId: 'ag-1',
          name: 'coder',
          systemPrompt: { mode: 'override', value: 'Already wrapped' },
          instructions: { mode: 'expand', value: 'Already expanded' },
        },
      ],
    });
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, agent_id, order_index, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('node-1', 'wf-1', 'Code', null, 0, configAlreadyWrapped, now, now);

    runMigration74(db);

    const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = 'node-1'`).get() as {
      config: string;
    };
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    const agent = (cfg.agents as Array<Record<string, unknown>>)[0];

    expect(agent.systemPrompt).toEqual({ mode: 'override', value: 'Already wrapped' });
    expect(agent.instructions).toEqual({ mode: 'expand', value: 'Already expanded' });
  });

  test('runMigration74 is idempotent — running twice does not error', () => {
    createPreM74Schema(db);
    runMigration74(db);
    expect(() => runMigration74(db)).not.toThrow();

    expect(tableExists(db, 'node_executions')).toBe(true);
    expect(columnExists(db, 'space_workflows', 'config')).toBe(false);
    expect(columnExists(db, 'space_workflow_nodes', 'order_index')).toBe(false);
    expect(columnExists(db, 'space_agents', 'role')).toBe(false);
  });

  test('node config JSON migration is idempotent — wrapping is skipped on re-run', () => {
    createPreM74Schema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 's', '/ws', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-1', 'sp-1', 'WF', now, now);

    const configBefore = JSON.stringify({
      agents: [{ agentId: 'ag-1', name: 'coder', systemPrompt: 'Original' }],
    });
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, agent_id, order_index, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('node-1', 'wf-1', 'Code', null, 0, configBefore, now, now);

    runMigration74(db);
    runMigration74(db);

    const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = 'node-1'`).get() as {
      config: string;
    };
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    const agent = (cfg.agents as Array<Record<string, unknown>>)[0];

    expect(agent.systemPrompt).toEqual({ mode: 'override', value: 'Original' });
  });

  test('full migration chain: all M74 changes applied correctly', () => {
    runMigrations(db, () => {});

    expect(tableExists(db, 'node_executions')).toBe(true);
    expect(indexExists(db, 'idx_node_executions_run')).toBe(true);
    expect(indexExists(db, 'idx_node_executions_node')).toBe(true);

    expect(columnExists(db, 'space_workflows', 'config')).toBe(false);
    expect(columnExists(db, 'space_workflows', 'max_iterations')).toBe(false);
    expect(columnExists(db, 'space_workflows', 'tags')).toBe(true);

    expect(columnExists(db, 'space_workflow_nodes', 'order_index')).toBe(false);
    expect(columnExists(db, 'space_workflow_nodes', 'agent_id')).toBe(false);
    expect(columnExists(db, 'space_workflow_nodes', 'config')).toBe(true);

    expect(columnExists(db, 'space_agents', 'role')).toBe(false);
    expect(columnExists(db, 'space_agents', 'config')).toBe(false);
    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);
    expect(columnExists(db, 'space_agents', 'instructions')).toBe(true);
  });
});
