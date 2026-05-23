/**
 * Shared test schema helpers for Space Agent tests.
 *
 * Used by both space-agent-repository.test.ts and space-agent-manager.test.ts
 * to avoid duplicating schema setup and fixture insertion code.
 *
 * Keep in sync with the fully-migrated production schema (after M74).
 */

import type { Database } from 'bun:sqlite';

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

	// Keep in sync with space-test-db.ts (post-M116 schema — thinking_level
	// column added for per-agent thinking overrides).
	db.exec(`
		CREATE TABLE space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'archived')),
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			thinking_level TEXT DEFAULT NULL,
			custom_prompt TEXT,
			provider TEXT,
			template_name TEXT DEFAULT NULL,
			template_hash TEXT DEFAULT NULL,
			setting_sources TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
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
			tags TEXT NOT NULL DEFAULT '[]',
			channels TEXT,
			gates TEXT,
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

	// node_executions still required by tests that exercise the repo's
	// agent-name update path (which used to refresh denormalised labels and
	// is now a no-op — kept here so the schema parity is obvious).
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
	// config stores JSON: { agents?: [{ agentId, name }] }
	const configJson = agentId ? JSON.stringify({ agents: [{ agentId, name: `Node ${id}` }] }) : null;
	db.prepare(
		`INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, workflowId, `Node ${id}`, configJson, now, now);
}
