/**
 * Space test database helper
 *
 * Creates the minimal set of tables needed for Space system tests
 * without requiring a full migration run.
 *
 * Keep in sync with the fully-migrated production schema (after M86).
 *
 * IMPORTANT: The schema defined here must exactly match the fully-migrated production
 * schema (i.e. after all migrations have run). Never add columns or constraints here
 * that do not yet exist in a production migration — that masks schema divergence.
 */

import type { Database as BunDatabase } from 'bun:sqlite';

export function createSpaceTables(db: BunDatabase): void {
	db.exec('PRAGMA foreign_keys = ON');

	db.exec(`
		CREATE TABLE IF NOT EXISTS spaces (
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
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'archived')),
			paused INTEGER NOT NULL DEFAULT 0,
			stopped INTEGER NOT NULL DEFAULT 0,
			autonomy_level INTEGER NOT NULL DEFAULT 1
				CHECK(autonomy_level BETWEEN 1 AND 5),
			max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
			config TEXT,
			task_agent_config TEXT DEFAULT NULL,
			setting_sources TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			thinking_level TEXT DEFAULT NULL,
			system_prompt TEXT NOT NULL DEFAULT '',
			instructions TEXT,
			provider TEXT,
			template_name TEXT DEFAULT NULL,
			template_hash TEXT DEFAULT NULL,
			setting_sources TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflows (
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
		CREATE TABLE IF NOT EXISTS space_workflow_nodes (
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
		CREATE TABLE IF NOT EXISTS space_workflow_transitions (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			from_node_id TEXT NOT NULL,
			to_node_id TEXT NOT NULL,
			condition TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			is_cyclic INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
			FOREIGN KEY (from_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE,
			FOREIGN KEY (to_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_runs (
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
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS gate_data (
			run_id TEXT NOT NULL,
			gate_id TEXT NOT NULL,
			data TEXT NOT NULL DEFAULT '{}',
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, gate_id),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_data_run ON gate_data(run_id)`);

	// Per-channel cycle counters (migration 69). Tracks how many times each
	// backward (cyclic) channel has been traversed in a workflow run.
	db.exec(`
		CREATE TABLE IF NOT EXISTS channel_cycles (
			run_id TEXT NOT NULL,
			channel_index INTEGER NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			max_cycles INTEGER NOT NULL DEFAULT 5,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, channel_index),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
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
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'idle', 'done', 'waiting_rebind', 'blocked', 'cancelled')),
			result TEXT,
			data TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE SET NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
	);

	db.exec(`
		CREATE TABLE IF NOT EXISTS space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_number INTEGER NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open'
				CHECK(status IN ('draft', 'open', 'in_progress', 'review', 'approved', 'done', 'blocked', 'cancelled', 'archived')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			labels TEXT NOT NULL DEFAULT '[]',
			workflow_run_id TEXT,
			preferred_workflow_id TEXT,
			created_by_task_id TEXT,
			goal_id TEXT DEFAULT NULL,
			result TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			active_session TEXT
				CHECK(active_session IN ('worker', 'leader')),
			task_agent_session_id TEXT,
			block_reason TEXT,
			approval_source TEXT,
			approval_reason TEXT,
			approved_at INTEGER,
			pending_checkpoint_type TEXT DEFAULT NULL
				CHECK(pending_checkpoint_type IN ('gate', 'task_completion')),
			pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
			pending_completion_submitted_at INTEGER DEFAULT NULL,
			pending_completion_reason TEXT DEFAULT NULL,
			post_approval_session_id TEXT DEFAULT NULL,
			post_approval_started_at INTEGER DEFAULT NULL,
			post_approval_blocked_reason TEXT DEFAULT NULL,
			reported_status TEXT DEFAULT NULL,
			reported_summary TEXT DEFAULT NULL,
			created_by TEXT DEFAULT NULL,
			created_by_session TEXT DEFAULT NULL,
			created_by_task_schedule_id TEXT DEFAULT NULL,
			archived_at INTEGER,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
		)
	`);

	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_space_task_number ON space_tasks(space_id, task_number)`
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
	);

	// Minimal `sessions` table — used by tests that need to seed
	// `session_context.taskId` so the SDKMessageRepository can derive the
	// `sdk_messages.task_id` column at INSERT time.
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			type TEXT,
			session_context TEXT
		)
	`);

	// `sdk_messages` is the canonical message store. Tests that exercise
	// task-scoped feeds rely on the `task_id` column being present and
	// indexed exactly the way migration 122 produces it in production.
	db.exec(`
		CREATE TABLE IF NOT EXISTS sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT DEFAULT 'consumed',
			origin TEXT,
			is_renderable INTEGER NOT NULL DEFAULT 1,
			is_terminal INTEGER NOT NULL DEFAULT 0,
			parent_tool_use_id TEXT,
			task_id TEXT
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id)`);

	// Workflow run artifacts
	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			artifact_type TEXT NOT NULL,
			artifact_key TEXT NOT NULL DEFAULT '',
			data TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(run_id, node_id, artifact_type, artifact_key),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_wra_run_id ON workflow_run_artifacts(run_id)`);

	// Workflow run artifact cache (migration 98). Stores JSON-serialised results
	// of the expensive git subprocess calls backing the TaskArtifactsPanel so the
	// panel serves from SQLite instead of running git inline on every open.
	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_run_artifact_cache (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT NOT NULL,
			task_id TEXT NOT NULL DEFAULT '',
			cache_key TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'ok'
				CHECK(status IN ('ok', 'syncing', 'error')),
			data TEXT NOT NULL DEFAULT '{}',
			error TEXT,
			synced_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(run_id, task_id, cache_key),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_wrac_run_task ON workflow_run_artifact_cache(run_id, task_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_wrac_run_task_key ON workflow_run_artifact_cache(run_id, task_id, cache_key)`
	);

	// Pending agent messages (Task Agent → peer agent persistent queue).
	// See migration 90.
	db.exec(`
		CREATE TABLE IF NOT EXISTS pending_agent_messages (
			id TEXT PRIMARY KEY,
			workflow_run_id TEXT NOT NULL,
			space_id TEXT NOT NULL,
			task_id TEXT,
			source_agent_name TEXT NOT NULL DEFAULT 'task-agent',
			target_kind TEXT NOT NULL
				CHECK(target_kind IN ('node_agent', 'space_agent')),
			target_agent_name TEXT NOT NULL,
			message TEXT NOT NULL,
			idempotency_key TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 5,
			last_attempt_at INTEGER,
			last_error TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'delivered', 'expired', 'failed')),
			delivered_at INTEGER,
			delivered_session_id TEXT,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_run_status ` +
			`ON pending_agent_messages(workflow_run_id, status, created_at)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_space_status ` +
			`ON pending_agent_messages(space_id, status, created_at)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_run_target ` +
			`ON pending_agent_messages(workflow_run_id, target_agent_name, status, created_at)`
	);
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_agent_messages_idem ` +
			`ON pending_agent_messages(workflow_run_id, target_agent_name, idempotency_key) ` +
			`WHERE idempotency_key IS NOT NULL`
	);

	// Durable inbox for long-term Space agents. See migration 137.
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_inbox_messages (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			target_agent_id TEXT NOT NULL,
			source_actor_id TEXT NOT NULL,
			source_session_id TEXT,
			message TEXT NOT NULL,
			message_record_json TEXT,
			idempotency_key TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 5,
			last_attempt_at INTEGER,
			last_error TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'delivered', 'expired', 'failed')),
			delivered_at INTEGER,
			delivered_session_id TEXT,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (target_agent_id) REFERENCES space_agents(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_agent_inbox_target_status ` +
			`ON space_agent_inbox_messages(space_id, target_agent_id, status, created_at)`
	);
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_agent_inbox_idempotency ` +
			`ON space_agent_inbox_messages(space_id, target_agent_id, idempotency_key) ` +
			`WHERE idempotency_key IS NOT NULL AND status = 'pending'`
	);

	// External Event Bus extension configuration tables.
	db.exec(`
		CREATE TABLE IF NOT EXISTS external_event_source_configs (
			source TEXT PRIMARY KEY,
			globally_enabled INTEGER NOT NULL DEFAULT 0,
			capabilities_json TEXT NOT NULL,
			secrets_ref TEXT,
			settings_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_external_event_source_configs (
			space_id TEXT NOT NULL,
			source TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			settings_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(space_id, source),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

	// External Event Bus tables (migration 124 — simplified schema)
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_external_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			source TEXT NOT NULL,
			topic TEXT NOT NULL,
			dedupe_key TEXT NOT NULL,
			occurred_at INTEGER NOT NULL,
			ingested_at INTEGER NOT NULL,
			source_event_id TEXT,
			summary TEXT NOT NULL,
			external_url TEXT,
			payload_json TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'published'
				CHECK(state IN ('published', 'delivered', 'failed', 'ignored')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(space_id, source, dedupe_key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_events_lookup
		ON space_external_events(space_id, source, dedupe_key)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_events_state
		ON space_external_events(state, updated_at)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS space_external_event_deliveries (
			event_id TEXT NOT NULL,
			delivery_key TEXT NOT NULL,
			workflow_run_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending'
				CHECK(state IN ('pending', 'delivered', 'failed')),
			failure_reason TEXT,
			delivered_at INTEGER,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(event_id, delivery_key),
			FOREIGN KEY (event_id) REFERENCES space_external_events(id) ON DELETE CASCADE
		)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_event
		ON space_external_event_deliveries(event_id, state)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_run
		ON space_external_event_deliveries(workflow_run_id, state)
	`);
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_external_event_deliveries_key
		ON space_external_event_deliveries(delivery_key)
	`);

	// MCP audit log (migration 121)
	db.exec(`
		CREATE TABLE IF NOT EXISTS mcp_audit_log (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			agent_name TEXT,
			session_id TEXT,
			tool_name TEXT NOT NULL,
			params_summary TEXT,
			space_id TEXT,
			task_id TEXT,
			workflow_run_id TEXT
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_space ON mcp_audit_log (space_id, timestamp)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_task ON mcp_audit_log (task_id, timestamp)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_session ON mcp_audit_log (session_id, timestamp)`
	);

	// Task schedules (migration 124)
	db.exec(`
		CREATE TABLE IF NOT EXISTS task_schedules (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			preferred_workflow_id TEXT DEFAULT NULL,
			labels TEXT NOT NULL DEFAULT '[]',
			trigger_type TEXT NOT NULL CHECK(trigger_type IN ('cron', 'at')),
			cron_expression TEXT DEFAULT NULL,
			run_at INTEGER DEFAULT NULL,
			timezone TEXT NOT NULL DEFAULT 'UTC',
			next_run_at INTEGER DEFAULT NULL,
			last_run_at INTEGER DEFAULT NULL,
			last_created_task_id TEXT DEFAULT NULL,
			pending_job_id TEXT DEFAULT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'completed')),
			created_by_agent TEXT DEFAULT NULL,
			created_by_session TEXT DEFAULT NULL,
			goal_id TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_task_schedules_space
		ON task_schedules(space_id, status)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_task_schedules_active_due
		ON task_schedules(status, next_run_at)
		WHERE status = 'active'
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_task_schedules_goal ON task_schedules(goal_id)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS space_goals (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'completed', 'archived')),
			type TEXT NOT NULL DEFAULT 'one_shot'
				CHECK(type IN ('one_shot', 'measurable', 'recurring')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			labels TEXT NOT NULL DEFAULT '[]',
			metrics TEXT NOT NULL DEFAULT '{}',
			summary TEXT NOT NULL DEFAULT '',
			progress INTEGER NOT NULL DEFAULT 0,
			next_steps TEXT NOT NULL DEFAULT '[]',
			preferred_workflow_id TEXT,
			task_schedule_id TEXT,
			auto_trigger_next INTEGER NOT NULL DEFAULT 0,
			pending_next_run INTEGER NOT NULL DEFAULT 0,
			active_task_id TEXT,
			last_task_id TEXT,
			last_check_in_at INTEGER,
			next_check_in_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_space ON space_goals(space_id, status)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_schedule ON space_goals(task_schedule_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_active_task ON space_goals(active_task_id)`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_goal_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			event_type TEXT NOT NULL
				CHECK(event_type IN ('created', 'updated', 'status_changed', 'task_triggered', 'task_queued', 'task_terminal', 'schedule_updated')),
			source TEXT NOT NULL
				CHECK(source IN ('rpc', 'space_agent_tool', 'workflow_node_agent', 'scheduler', 'system')),
			source_task_id TEXT,
			source_session_id TEXT,
			previous_state TEXT,
			new_state TEXT,
			diff TEXT,
			note TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
			FOREIGN KEY (source_task_id) REFERENCES space_tasks(id) ON DELETE SET NULL
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_goal_events_goal_created ON space_goal_events(goal_id, created_at DESC)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_goal_events_space_created ON space_goal_events(space_id, created_at DESC)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_goal_events_source_task ON space_goal_events(source_task_id, created_at DESC)`
	);
}
