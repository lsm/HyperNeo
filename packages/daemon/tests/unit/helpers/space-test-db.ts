/**
 * Space test database helper
 *
 * Creates the minimal set of tables needed for Space system tests
 * without requiring a full migration run.
 *
 * Keep in sync with the fully-migrated production schema (after all migrations).
 *
 * IMPORTANT: The schema defined here must exactly match the fully-migrated production
 * schema (i.e. after all migrations have run). Never add columns or constraints here
 * that do not yet exist in a production migration — that masks schema divergence.
 */

import { createEvolutionTables } from '../../../src/storage/schema/evolution';
import { createLongHorizonAgentTables } from '../../../src/storage/schema/long-horizon-agents';
import { createWorkflowEventSubscriptionTables } from '../../../src/storage/schema/workflow-event-subscriptions';
import type { Database as BunDatabase } from '../../../src/storage/sqlite-compat';

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agents (
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
			system_prompt TEXT NOT NULL DEFAULT '',
			custom_prompt TEXT,
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);

  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_agents_handle
		ON space_agents(space_id, handle)
		WHERE handle IS NOT NULL
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`);
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
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_definition_versions (
			workflow_id TEXT NOT NULL,
			version_hash TEXT NOT NULL,
			space_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (workflow_id, version_hash),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_workflow_definition_versions_space
		ON space_workflow_definition_versions(space_id)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			definition_version TEXT,
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
			FOREIGN KEY (workflow_id, definition_version)
				REFERENCES space_workflow_definition_versions(workflow_id, version_hash)
		)
	`);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_hook_state (
				run_id TEXT NOT NULL,
				hook_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				local_state TEXT NOT NULL DEFAULT '{}',
				last_result TEXT,
				retry_count INTEGER NOT NULL DEFAULT 0,
				next_retry_at INTEGER,
				vote_maps TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (run_id, hook_id),
				FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
			)
		`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_hook_state_run ON workflow_hook_state(run_id)`);

  db.exec(`
			CREATE TABLE IF NOT EXISTS workflow_hook_result_artifacts (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				hook_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				result TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
			)
		`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workflow_hook_result_artifacts_run_hook ` +
      `ON workflow_hook_result_artifacts(run_id, hook_id, created_at)`
  );

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

  // Per-handoff-transition cycle counters (migration 194, task #923). Backs
  // HandoffTransition.maxCycles enforcement for cyclic handoffs.
  db.exec(`
		CREATE TABLE IF NOT EXISTS handoff_cycles (
			run_id TEXT NOT NULL,
			transition_key TEXT NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			max_cycles INTEGER NOT NULL DEFAULT 5,
			epoch INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, transition_key),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);

  // One timestamped row per cyclic-channel traversal, used for rate-based
  // dead-loop detection (rolling window count). See migration 193.
  db.exec(`
		CREATE TABLE IF NOT EXISTS channel_cycle_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			channel_index INTEGER NOT NULL,
			sent_at INTEGER NOT NULL,
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_channel_cycle_events_window
		ON channel_cycle_events(run_id, channel_index, sent_at)
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
			last_activity_at INTEGER,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE SET NULL
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_node_executions_agent_session ON node_executions(agent_session_id)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_slot ` +
      `ON node_executions(workflow_run_id, workflow_node_id, agent_name)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_number INTEGER NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open'
				CHECK(status IN ('rate_limited', 'usage_limited', 'draft', 'open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived', 'approved')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			labels TEXT NOT NULL DEFAULT '[]',
			workflow_run_id TEXT,
			preferred_workflow_id TEXT,
			created_by_task_id TEXT,
			goal_id TEXT DEFAULT NULL,
			evolution_scope_id TEXT DEFAULT NULL,
			result TEXT,
			workflow_model_overrides TEXT,
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
			post_approval_source_node_id TEXT DEFAULT NULL,
			reported_status TEXT DEFAULT NULL
				CHECK(reported_status IS NULL OR reported_status IN ('done', 'blocked', 'cancelled')),
			reported_summary TEXT DEFAULT NULL,
			created_by TEXT DEFAULT NULL,
			created_by_session TEXT DEFAULT NULL,
			created_by_task_schedule_id TEXT DEFAULT NULL,
			archived_at INTEGER,
			restrictions TEXT,
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
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_space_status_updated ON space_tasks(space_id, status, updated_at DESC, id DESC)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_evolution_scope_id ON space_tasks(evolution_scope_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
  );

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
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goals_next_check_in ON space_goals(status, next_check_in_at)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_worktrees (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			completed_at INTEGER,
			UNIQUE(space_id, task_id),
			UNIQUE(space_id, slug),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_worktrees_space_id ON space_worktrees(space_id)`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_memory (
			id INTEGER PRIMARY KEY,
			key TEXT NOT NULL,
			space_id TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '',
			created_by_session TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			access_count INTEGER NOT NULL DEFAULT 0,
			last_accessed_at INTEGER,
			embedding_status TEXT NOT NULL DEFAULT 'pending'
				CHECK(embedding_status IN ('pending', 'ready', 'failed')),
			embedding_model TEXT,
			embedding_updated_at INTEGER,
			embedding_error TEXT,
			embedding_revision INTEGER NOT NULL DEFAULT 0,
			embedding_token TEXT NOT NULL DEFAULT '',
			UNIQUE(space_id, key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS space_agent_memory_fts USING fts5(
			key,
			content,
			tags,
			content='space_agent_memory',
			content_rowid='id',
			tokenize='trigram'
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_vectors (
			memory_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			model TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_core_memory (
			space_id TEXT NOT NULL,
			memory_id INTEGER NOT NULL,
			score REAL NOT NULL,
			rank INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (space_id, memory_id),
			UNIQUE(space_id, rank),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_ai
		AFTER INSERT ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_ad
		AFTER DELETE ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_au
		AFTER UPDATE OF key, content, tags ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_space ON space_agent_memory(space_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_updated ON space_agent_memory(space_id, updated_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_access ON space_agent_memory(space_id, last_accessed_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_embedding_status ON space_agent_memory(space_id, embedding_status)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_core_memory_rank ON space_agent_core_memory(space_id, rank)`
  );

  createEvolutionTables(db);
  createLongHorizonAgentTables(db);
  createWorkflowEventSubscriptionTables(db);

  // Minimal `sessions` table — used by tests that need to seed
  // `session_context.taskId` so the SDKMessageRepository can derive the
  // `sdk_messages.task_id` column at INSERT time.
  db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_path TEXT,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
			config TEXT NOT NULL,
			metadata TEXT NOT NULL,
			is_worktree INTEGER DEFAULT 0,
			worktree_path TEXT,
			main_repo_path TEXT,
			worktree_branch TEXT,
			git_branch TEXT,
			sdk_session_id TEXT,
				acp_session_id TEXT,
			sdk_origin_path TEXT,
			available_commands TEXT,
			processing_state TEXT,
			last_error TEXT,
			archived_at TEXT,
			parent_id TEXT,
			type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'space_chat')),
			session_context TEXT,
			visible_message_count INTEGER NOT NULL DEFAULT 0
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_space_agent_provenance
		ON sessions(json_extract(session_context, '$.spaceId'), json_extract(metadata, '$.promptProvenance.agentId'))`);

  // `sdk_messages` is the canonical message store. Tests that exercise
  // task-scoped feeds rely on the `task_id` column being present and
  // indexed exactly the way migration 122 produces it in production.
  db.exec(`
		CREATE TABLE IF NOT EXISTS sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			message_subtype_norm TEXT GENERATED ALWAYS AS (COALESCE(message_subtype, '')) VIRTUAL,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'submitted', 'consumed', 'failed')),
			origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'system')),
			is_renderable INTEGER NOT NULL DEFAULT 1,
			is_terminal INTEGER NOT NULL DEFAULT 0,
			conversation_turn_index INTEGER,
			parent_tool_use_id TEXT,
			task_id TEXT,
			sdk_uuid TEXT,
			consumed_seq INTEGER,
			replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS sdk_message_replacements (
			source_message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			task_id TEXT,
			target_uuid TEXT NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
			PRIMARY KEY (source_message_id, target_uuid, kind),
			FOREIGN KEY (source_message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
		)
	`);
  // Monotonic consumption-watermark counter (saveSDKMessage stamps terminal
  // results from it). See schema/index.ts + Codex (PR #2463, P2).
  db.exec(`
		CREATE TABLE IF NOT EXISTS delivery_consumed_seq (
			singleton INTEGER PRIMARY KEY DEFAULT 1,
			next_seq INTEGER NOT NULL DEFAULT 1
		)
	`);
  db.exec(`
		INSERT OR IGNORE INTO delivery_consumed_seq (singleton, next_seq) VALUES (1, 1)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id
		ON sdk_messages(session_id, timestamp DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id
		ON sdk_messages(session_id, parent_tool_use_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_renderable_terminal
		ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_type
		ON sdk_messages(message_type, message_subtype)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_subtype_parent
		ON sdk_messages(session_id, message_subtype_norm, parent_tool_use_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_consumed_seq
		ON sdk_messages(consumed_seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status
		ON sdk_messages(session_id, send_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id
		ON sdk_messages(task_id, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session
		ON sdk_messages(task_id, session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_turn
		ON sdk_messages(task_id, conversation_turn_index)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session_turn
		ON sdk_messages(task_id, session_id, conversation_turn_index)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_uuid
		ON sdk_messages(session_id, sdk_uuid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_unnormalized_replacements
		ON sdk_messages(id) WHERE replacement_metadata_normalized = 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_message_replacements_session_target
		ON sdk_message_replacements(session_id, target_uuid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_message_replacements_task_target
		ON sdk_message_replacements(task_id, target_uuid)`);

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wra_run_node ON workflow_run_artifacts(run_id, node_id)`);

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
			workflow_node_id TEXT,
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
			delivery_mode TEXT,
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
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_agent_messages_idem_pending ` +
      `ON pending_agent_messages(workflow_run_id, target_agent_name, idempotency_key) ` +
      `WHERE idempotency_key IS NOT NULL AND status = 'pending'`
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
		CREATE INDEX IF NOT EXISTS idx_space_external_events_recency
		ON space_external_events(space_id, source, ingested_at)
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
		CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_state_updated
		ON space_external_event_deliveries(state, updated_at)
	`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_external_event_deliveries_key
		ON space_external_event_deliveries(delivery_key)
	`);

  // Migration 164: partial index for pending-delivery scans (queue-health snapshot).
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_pending
		ON space_external_event_deliveries(updated_at)
		WHERE state = 'pending'
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
			metadata_json TEXT NOT NULL DEFAULT '{}',
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
