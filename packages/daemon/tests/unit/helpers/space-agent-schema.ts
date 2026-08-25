import type { Database } from '../../../src/storage/sqlite-compat';

export function createSpaceAgentSchema(db: Database): void {
  db.exec(`PRAGMA foreign_keys = ON`);
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
			status TEXT NOT NULL DEFAULT 'active',
			autonomy_level TEXT NOT NULL DEFAULT 'supervised',
			config TEXT,
			task_agent_config TEXT,
			setting_sources TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);

  db.exec(`
		CREATE TABLE space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
				handle TEXT,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'archived')),
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			thinking_level TEXT DEFAULT NULL,
			custom_prompt TEXT,
			system_prompt TEXT NOT NULL DEFAULT '',
			instructions TEXT,
			provider TEXT,
			template_name TEXT DEFAULT NULL,
			template_hash TEXT DEFAULT NULL,
			setting_sources TEXT DEFAULT NULL,
			model_pool TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX idx_space_agents_space_id ON space_agents(space_id)`);
  db.exec(`
    CREATE UNIQUE INDEX idx_space_agents_handle
    ON space_agents(space_id, handle)
    WHERE handle IS NOT NULL
  `);

  db.exec(`
		CREATE TABLE space_long_horizon_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			handle TEXT NOT NULL,
			display_name TEXT NOT NULL,
			template_key TEXT DEFAULT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'disabled', 'archived')),
			session_id TEXT DEFAULT NULL,
			instructions TEXT NOT NULL DEFAULT '',
			autonomy_level INTEGER DEFAULT NULL
				CHECK(autonomy_level IS NULL OR autonomy_level BETWEEN 1 AND 5),
			model TEXT DEFAULT NULL,
			thinking_level TEXT DEFAULT NULL,
			provider TEXT DEFAULT NULL,
			setting_sources TEXT DEFAULT NULL,
			tool_permissions_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_long_horizon_agents_handle ` +
      `ON space_long_horizon_agents(space_id, handle) WHERE status != 'archived'`
  );
  db.exec(`
		CREATE TABLE space_long_horizon_agent_event_subscriptions (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			source TEXT NOT NULL,
			topic TEXT NOT NULL,
			filter_json TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'disabled')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE,
			UNIQUE(space_id, agent_id, source, topic, filter_json)
		)
	`);

  db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_path TEXT,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			status TEXT NOT NULL,
			config TEXT NOT NULL,
			metadata TEXT NOT NULL,
			is_worktree INTEGER NOT NULL DEFAULT 0,
			worktree_path TEXT,
			main_repo_path TEXT,
			worktree_branch TEXT,
			git_branch TEXT,
			sdk_session_id TEXT,
				acp_session_id TEXT,
			sdk_origin_path TEXT,
			available_commands TEXT,
			processing_state TEXT,
			archived_at TEXT,
			type TEXT,
			session_context TEXT,
			room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
			space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
			task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL
		)
	`);

  db.exec(`
		CREATE TABLE sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT,
			origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'system')),
			is_renderable INTEGER NOT NULL DEFAULT 1,
			is_terminal INTEGER NOT NULL DEFAULT 0,
			conversation_turn_index INTEGER,
			parent_tool_use_id TEXT,
			task_id TEXT,
			sdk_uuid TEXT,
			replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
		)
	`);
  db.exec(`
		CREATE TABLE sdk_message_replacements (
			source_message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			task_id TEXT,
			target_uuid TEXT NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
			PRIMARY KEY (source_message_id, target_uuid, kind)
		)
	`);

  db.exec(`
		CREATE TABLE space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_node_id TEXT,
			end_node_id TEXT,
			tags TEXT NOT NULL DEFAULT '[]',
			channels TEXT,
			gates TEXT,
				hooks TEXT,
			layout TEXT,
			template_name TEXT DEFAULT NULL,
			template_hash TEXT DEFAULT NULL,
			instructions TEXT DEFAULT NULL,
			completion_autonomy_level INTEGER NOT NULL DEFAULT 3,
			post_approval TEXT DEFAULT NULL,
			disabled INTEGER NOT NULL DEFAULT 0,
			handle TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_workflows_handle
		ON space_workflows(space_id, handle)
		WHERE handle IS NOT NULL
	`);

  db.exec(`
		CREATE TABLE space_workflow_nodes (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS node_executions (
			id TEXT PRIMARY KEY,
			workflow_run_id TEXT NOT NULL,
			workflow_node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			agent_id TEXT,
			agent_session_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			data TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL
		)
	`);
}

export function insertSpace(db: Database, id = 'space-1'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `/workspace/${id}`, `Space ${id}`, id, now, now);
}

export function insertWorkflow(db: Database, id: string, spaceId: string, name: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, spaceId, name, now, now);
}

export function insertWorkflowNode(
  db: Database,
  id: string,
  workflowId: string,
  agentId: string | null
): void {
  const now = Date.now();
  const configJson = agentId ? JSON.stringify({ agents: [{ agentId, name: `Node ${id}` }] }) : null;
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, workflowId, `Node ${id}`, configJson, now, now);
}
