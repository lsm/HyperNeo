CREATE TABLE migration_markers (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

CREATE TABLE mission_metric_history (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			metric_name TEXT NOT NULL,
			value REAL NOT NULL,
			recorded_at INTEGER NOT NULL,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
		);

CREATE TABLE mission_executions (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			execution_number INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			status TEXT NOT NULL DEFAULT 'running',
			result_summary TEXT,
			task_ids TEXT NOT NULL DEFAULT '[]',
			planning_attempts INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
			UNIQUE(goal_id, execution_number)
		);

CREATE TABLE space_workflow_definition_versions (
			workflow_id TEXT NOT NULL,
			version_hash TEXT NOT NULL,
			space_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (workflow_id, version_hash),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		);

CREATE TABLE short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		);

CREATE TABLE app_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      source_type TEXT NOT NULL CHECK(source_type IN ('stdio', 'sse', 'http')),
      command TEXT,
      args TEXT,
      env TEXT,
      url TEXT,
      headers TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER
    , source TEXT, source_path TEXT);

CREATE TABLE room_mcp_enablement (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (room_id, server_id)
    );

CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      source_type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      built_in INTEGER NOT NULL DEFAULT 0,
      validation_status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

CREATE TABLE room_skill_overrides (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (skill_id, room_id)
    );

CREATE TABLE space_worktrees (
			id         TEXT PRIMARY KEY,
			space_id   TEXT NOT NULL,
			task_id    TEXT NOT NULL,
			slug       TEXT NOT NULL,
			path       TEXT NOT NULL,
			created_at INTEGER NOT NULL, completed_at INTEGER,
			UNIQUE(space_id, task_id),
			UNIQUE(space_id, slug),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
		);

CREATE TABLE channel_cycles (
			run_id TEXT NOT NULL,
			channel_index INTEGER NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			max_cycles INTEGER NOT NULL DEFAULT 5,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, channel_index),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		);

CREATE TABLE "space_workflows" (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					start_node_id TEXT,
					end_node_id TEXT,
					tags TEXT NOT NULL DEFAULT '[]',
					layout TEXT,
					channels TEXT,
					disabled INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL, template_name TEXT DEFAULT NULL, template_hash TEXT DEFAULT NULL, instructions TEXT DEFAULT NULL, completion_autonomy_level INTEGER NOT NULL DEFAULT 3, post_approval TEXT DEFAULT NULL, handle TEXT DEFAULT NULL, hooks TEXT,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				);

CREATE TABLE "space_workflow_nodes" (
					id TEXT PRIMARY KEY,
					workflow_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
				);

CREATE TABLE workspace_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			path TEXT NOT NULL UNIQUE,
			last_used_at INTEGER NOT NULL,
			use_count INTEGER NOT NULL DEFAULT 1
		);

CREATE TABLE workflow_run_artifacts (
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
		);

CREATE TABLE "spaces" (
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
					autonomy_level INTEGER NOT NULL DEFAULT 1
						CHECK(autonomy_level BETWEEN 1 AND 5),
					config TEXT,
					paused INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				, stopped INTEGER NOT NULL DEFAULT 0, task_agent_config TEXT DEFAULT NULL, setting_sources TEXT DEFAULT NULL, max_concurrent_tasks INTEGER NOT NULL DEFAULT 1);

CREATE TABLE workflow_run_artifact_cache (
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
		);

CREATE TABLE mcp_enablement (
			server_id  TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
			scope_type TEXT NOT NULL CHECK (scope_type IN ('space', 'room', 'session')),
			scope_id   TEXT NOT NULL,
			enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
			PRIMARY KEY (server_id, scope_type, scope_id)
		);

CREATE TABLE tool_continuation_recovery (
			tool_use_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			execution_id TEXT,
			workflow_run_id TEXT,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'waiting_rebind', 'rebound', 'failed', 'expired', 'consumed')),
			attempts_409 INTEGER NOT NULL DEFAULT 0,
			recovery_reason TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		);

CREATE TABLE tool_continuation_inbox (
			id TEXT PRIMARY KEY,
			tool_use_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			execution_id TEXT,
			workflow_run_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'rebound', 'failed', 'expired')),
			request_json TEXT NOT NULL,
			recovery_reason TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		);

CREATE TABLE space_github_watched_repos (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			owner TEXT NOT NULL,
			repo TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			webhook_enabled INTEGER NOT NULL DEFAULT 1,
			polling_enabled INTEGER NOT NULL DEFAULT 0,
			webhook_secret TEXT,
			last_webhook_at INTEGER,
			last_poll_at INTEGER,
			poll_cursor TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL, webhook_remote_id INTEGER, webhook_url TEXT, webhook_auto_registered INTEGER NOT NULL DEFAULT 0, webhook_active INTEGER, webhook_last_checked_at INTEGER, webhook_last_error TEXT, webhook_configured_at INTEGER,
			UNIQUE(space_id, owner, repo)
		);

CREATE TABLE space_github_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_id TEXT,
			source TEXT NOT NULL CHECK(source IN ('webhook', 'polling')),
			delivery_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			action TEXT NOT NULL,
			repo_owner TEXT NOT NULL,
			repo_name TEXT NOT NULL,
			pr_number INTEGER NOT NULL,
			pr_url TEXT NOT NULL,
			actor TEXT NOT NULL,
			actor_type TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL DEFAULT '',
			external_url TEXT NOT NULL DEFAULT '',
			external_id TEXT NOT NULL DEFAULT '',
			occurred_at INTEGER NOT NULL,
			dedupe_key TEXT NOT NULL,
			raw_payload TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received', 'processed', 'ignored', 'ambiguous', 'routed', 'delivered', 'failed')),
			matched_by TEXT,
			confidence TEXT,
			route_note TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(space_id, dedupe_key)
		);

CREATE TABLE mcp_audit_log (
				id TEXT PRIMARY KEY,
				timestamp INTEGER NOT NULL,
				agent_name TEXT DEFAULT NULL,
				session_id TEXT DEFAULT NULL,
				tool_name TEXT NOT NULL,
				params_summary TEXT DEFAULT NULL,
				space_id TEXT DEFAULT NULL,
				task_id TEXT DEFAULT NULL,
				workflow_run_id TEXT DEFAULT NULL
			);

CREATE TABLE space_external_event_deliveries (
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
		);

CREATE TABLE "space_external_events" (
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
					updated_at INTEGER NOT NULL, urgency TEXT, render TEXT,
					UNIQUE(space_id, source, dedupe_key),
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				);

CREATE TABLE task_schedules (
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
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL, goal_id TEXT DEFAULT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		);

CREATE TABLE external_event_extension_configs (
			source TEXT PRIMARY KEY,
			globally_enabled INTEGER NOT NULL DEFAULT 0 CHECK(globally_enabled IN (0, 1)),
			capabilities_json TEXT NOT NULL DEFAULT '{}',
			secrets_ref TEXT DEFAULT NULL,
			settings_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

CREATE TABLE space_external_event_source_configs (
			space_id TEXT NOT NULL,
			source TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			settings_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(space_id, source),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		);

CREATE TABLE space_goals (
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
			completed_at INTEGER, revision INTEGER NOT NULL DEFAULT 0, workspace_path TEXT,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		);

CREATE TABLE space_agent_memory (
			id INTEGER PRIMARY KEY,
			key TEXT NOT NULL,
			space_id TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '',
			created_by_session TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			access_count INTEGER NOT NULL DEFAULT 0,
			last_accessed_at INTEGER, embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'ready', 'failed')), embedding_model TEXT, embedding_updated_at INTEGER, embedding_error TEXT, embedding_revision INTEGER NOT NULL DEFAULT 0, embedding_token TEXT NOT NULL DEFAULT '',
			UNIQUE(space_id, key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		);

CREATE VIRTUAL TABLE space_agent_memory_fts USING fts5(
			key,
			content,
			tags,
			content='space_agent_memory',
			content_rowid='id',
			tokenize='trigram'
		);

CREATE TABLE space_goal_events (
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
		);

CREATE TABLE message_search_content (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL CHECK(kind IN ('message', 'task')),
			source_id TEXT NOT NULL,
			message_id TEXT,
			session_id TEXT,
			task_id TEXT,
			space_id TEXT,
			task_number INTEGER,
			message_type TEXT,
			title TEXT,
			body TEXT,
			timestamp INTEGER,
			UNIQUE (kind, source_id)
		);

CREATE VIRTUAL TABLE message_search_fts USING fts5(
			title,
			body,
			content='message_search_content',
			content_rowid='id',
			detail=column,
			tokenize = 'unicode61'
		);

CREATE TABLE memory_vectors (
			memory_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			model TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		);

CREATE TABLE evolution_scopes (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			space_goal_id TEXT,
			kind TEXT NOT NULL
				CHECK(kind IN ('mission', 'project', 'campaign', 'workflow', 'custom')),
			name TEXT NOT NULL,
			objective TEXT NOT NULL,
			parent_scope_id TEXT,
			metric_definitions_json TEXT NOT NULL DEFAULT '[]',
			policy_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (space_goal_id) REFERENCES space_goals(id) ON DELETE SET NULL,
			FOREIGN KEY (parent_scope_id) REFERENCES evolution_scopes(id) ON DELETE SET NULL
		);

CREATE TABLE evolution_evidence (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			kind TEXT NOT NULL
					CHECK(kind IN ('task', 'workflow_run', 'session', 'manual_note', 'metric_snapshot', 'task_result', 'artifact', 'error', 'daemon_error', 'runtime_crash', 'runtime_warning', 'uncaught_exception', 'error_cluster', 'retry_loop', 'tool_failure', 'test_failure', 'permission_block', 'slow_tool_call', 'conversation_friction', 'friction_digest', 'verification_triage')),
			summary TEXT NOT NULL,
			source_id TEXT,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		);

CREATE TABLE evolution_episodes (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft'
				CHECK(status IN ('draft', 'accepted', 'dismissed')),
			rollup_applied_at INTEGER,
			title TEXT NOT NULL,
			time_window_json TEXT,
			evidence_ids_json TEXT NOT NULL DEFAULT '[]',
			outcome_summary TEXT NOT NULL DEFAULT '',
			findings_json TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		);

CREATE TABLE evolution_lessons (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'candidate'
				CHECK(status IN ('candidate', 'active', 'dismissed')),
			applies_to_json TEXT NOT NULL DEFAULT '[]',
			rule TEXT NOT NULL,
			why TEXT NOT NULL,
			evidence_episode_ids_json TEXT NOT NULL DEFAULT '[]',
			confidence REAL NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		);

CREATE TABLE evolution_task_proposals (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			reason TEXT NOT NULL,
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			status TEXT NOT NULL DEFAULT 'proposed'
				CHECK(status IN ('proposed', 'accepted', 'dismissed', 'created')),
			evidence_episode_ids_json TEXT NOT NULL DEFAULT '[]',
			created_task_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE,
			FOREIGN KEY (created_task_id) REFERENCES space_tasks(id) ON DELETE SET NULL
		);

CREATE TABLE evolution_metric_snapshots (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			captured_at INTEGER NOT NULL,
			values_json TEXT NOT NULL DEFAULT '{}',
			source TEXT NOT NULL,
			note TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		);

CREATE TABLE goal_automation_cursors (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			trigger_kind TEXT NOT NULL
				CHECK(trigger_kind IN ('completed_task_threshold', 'self_nag', 'external_event')),
			trigger_key TEXT NOT NULL,
			last_evidence_created_at INTEGER,
			last_evidence_id TEXT,
			last_task_completed_at INTEGER,
			last_external_event_id TEXT,
			last_episode_id TEXT,
			last_fired_at INTEGER,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(goal_id, scope_id, trigger_kind, trigger_key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE,
			FOREIGN KEY (last_episode_id) REFERENCES evolution_episodes(id) ON DELETE SET NULL
		);

CREATE TABLE space_agent_core_memory (
			space_id TEXT NOT NULL,
			memory_id INTEGER NOT NULL,
			score REAL NOT NULL,
			rank INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (space_id, memory_id),
			UNIQUE(space_id, rank),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		);

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
			description TEXT DEFAULT NULL,
			model_pool TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		);

CREATE TABLE space_long_horizon_agent_goals (
			agent_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			relationship TEXT NOT NULL DEFAULT 'owner'
				CHECK(relationship IN ('owner', 'manager', 'watcher')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(agent_id, goal_id, relationship),
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE,
			FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE
		);

CREATE TABLE space_long_horizon_agent_forge_scopes (
			agent_id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			relationship TEXT NOT NULL DEFAULT 'owner'
				CHECK(relationship IN ('owner', 'manager', 'watcher')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(agent_id, scope_id, relationship),
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		);

CREATE TABLE space_long_horizon_agent_reminders (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'fired', 'cancelled')),
			trigger_type TEXT NOT NULL CHECK(trigger_type IN ('at', 'cron')),
			run_at INTEGER DEFAULT NULL,
			cron_expression TEXT DEFAULT NULL,
			timezone TEXT NOT NULL DEFAULT 'UTC',
			next_run_at INTEGER DEFAULT NULL,
			last_fired_at INTEGER DEFAULT NULL,
			created_by_session TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
		);

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
			UNIQUE(space_id, agent_id, source, topic, filter_json),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
		);

CREATE TABLE provider_credentials (
      provider_id TEXT PRIMARY KEY,
      encrypted_data BLOB NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      provider_id TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('built_in', 'custom_endpoint')),
      auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key', 'oauth', 'none')),
      is_enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      base_url TEXT,
      config_json TEXT,
      custom_endpoint_config_json TEXT,
      health_status TEXT NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown', 'healthy', 'unhealthy')),
      last_health_check_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE workflow_hook_state (
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
    );

CREATE TABLE workflow_hook_result_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      hook_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
    );

CREATE TABLE "space_workflow_runs" (
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
      );

CREATE TABLE space_workflow_event_subscriptions (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_run_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			topic TEXT NOT NULL,
			topic_normalized TEXT NOT NULL,
			-- Only 'dynamic' subscriptions are persisted here (static template
			-- interests are re-materialized from the workflow definition), so the
			-- kind is fixed to 'dynamic'. The column is retained for schema clarity.
			subscription_kind TEXT NOT NULL DEFAULT 'dynamic'
				CHECK(subscription_kind = 'dynamic'),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(workflow_run_id, task_id, node_id, agent_name, topic_normalized, subscription_kind),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
			-- A hard-deleted task (SpaceTaskManager/GoalService deleteTask, which
			-- skips clearTaskInterests) would otherwise orphan its row, which
			-- rehydrate then re-inserts forever. Cascade like the other two FKs.
			FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
		);

CREATE TABLE delivery_turn_end (
      session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_uuid)
    );

CREATE TABLE delivery_consumed_seq (
      singleton INTEGER PRIMARY KEY DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1
    );

CREATE TABLE channel_cycle_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			channel_index INTEGER NOT NULL,
			sent_at INTEGER NOT NULL,
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		);

CREATE TABLE "space_tasks" (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						task_number INTEGER NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'open'
							CHECK(status IN ('rate_limited', 'usage_limited', 'draft', 'open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived', 'approved', 'stopped')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						labels TEXT NOT NULL DEFAULT '[]',
						workflow_run_id TEXT,
						preferred_workflow_id TEXT,
						created_by_task_id TEXT,
						result TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						approval_source TEXT,
						approval_reason TEXT,
						approved_at INTEGER,
						block_reason TEXT,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						pending_checkpoint_type TEXT DEFAULT NULL
							CHECK(pending_checkpoint_type IN ('gate', 'task_completion')),
						reported_status TEXT DEFAULT NULL
							CHECK(reported_status IS NULL OR reported_status IN ('done', 'blocked', 'cancelled')),
						reported_summary TEXT DEFAULT NULL,
						pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
						pending_completion_submitted_at INTEGER DEFAULT NULL,
						pending_completion_reason TEXT DEFAULT NULL, post_approval_session_id TEXT DEFAULT NULL, post_approval_started_at INTEGER DEFAULT NULL, post_approval_blocked_reason TEXT DEFAULT NULL, created_by TEXT DEFAULT NULL, created_by_session TEXT DEFAULT NULL, created_by_task_schedule_id TEXT DEFAULT NULL, goal_id TEXT DEFAULT NULL, evolution_scope_id TEXT DEFAULT NULL, workflow_model_overrides TEXT,
						restrictions TEXT, post_approval_source_node_id TEXT DEFAULT NULL, spawn_reservation_token TEXT, terminal_generation INTEGER NOT NULL DEFAULT 0, workspace_path TEXT, reconcile_checked_at INTEGER,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
					);

CREATE TABLE space_goal_outcome_notifications (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      terminal_generation INTEGER NOT NULL DEFAULT 0,
      goal_revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'superseded', 'acknowledged', 'rejected')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(goal_id, task_id, terminal_generation),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
    );

CREATE TABLE migration_space_reclaims (
      migration_key TEXT PRIMARY KEY,
      reclaimed_at INTEGER NOT NULL
    );

CREATE TABLE space_agent_inactivity_config (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      threshold_ms INTEGER,
      prompt TEXT,
      config_revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, agent_id),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
    );

CREATE TABLE space_agent_inactivity_claims (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      claim_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'accepted'
        CHECK(state IN ('none', 'accepted', 'in_flight')),
      window_anchored_at INTEGER NOT NULL,
      attempt_generation INTEGER NOT NULL DEFAULT 0,
      owner_token TEXT,
      config_revision INTEGER,
      degraded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, agent_id),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
    );

CREATE TABLE space_workspaces (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, path),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    );

CREATE TABLE daemon_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE "node_executions" (
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
				FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE SET NULL
			);

CREATE TABLE space_agent_templates (
      key TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      suggested_autonomy_level INTEGER NOT NULL DEFAULT 2
        CHECK(suggested_autonomy_level BETWEEN 1 AND 5),
      model TEXT DEFAULT NULL,
      provider TEXT DEFAULT NULL,
      model_pool TEXT DEFAULT NULL,
      thinking_level TEXT DEFAULT NULL,
      setting_sources TEXT DEFAULT NULL,
      tools TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , version INTEGER NOT NULL DEFAULT 1, labels TEXT DEFAULT NULL);

CREATE TABLE space_agent_template_version_seq (
      key TEXT PRIMARY KEY,
      next_version INTEGER NOT NULL DEFAULT 1
    );

CREATE TABLE sessions (
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
        -- VIRTUAL generated columns exposing the frequently-filtered
        -- session_context keys as plain columns so room/space/task predicates
        -- avoid per-row json_extract and can use plain indexes. Guarded by
        -- json_valid so malformed contexts read as NULL. Migration 200 adds
        -- them to pre-existing databases.
        room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
        space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
        task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL,
        -- Maintained counter of visible top-level SDK messages (the badge
        -- predicate: non-subagent, non-deferred user, non-hidden subtype). Read
        -- directly by spaceSessions.bySpace instead of a correlated COUNT(*)
        -- per session per poll. Maintained by SDKMessageRepository on every
        -- sdk_messages mutation. See migration 177 for the backfill.
        visible_message_count INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE auth_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auth_method TEXT NOT NULL CHECK(auth_method IN ('oauth', 'oauth_token', 'api_key', 'none')),
        api_key_encrypted TEXT,
        oauth_tokens_encrypted TEXT,
        oauth_token_encrypted TEXT,
        updated_at TEXT NOT NULL
      );

CREATE TABLE sdk_messages (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_subtype TEXT,
        -- VIRTUAL generated column so subtype equality/IN filters (which must
        -- treat NULL as '') become sargable against idx_sdk_messages_session_subtype_parent.
        -- VIRTUAL = computed on read, no storage/rewrite; semantically identical
        -- to COALESCE(message_subtype,'') by construction.
        message_subtype_norm TEXT GENERATED ALWAYS AS (COALESCE(message_subtype, '')) VIRTUAL,
        sdk_message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'submitted', 'consumed', 'failed')),
        origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'system')),
        is_renderable INTEGER NOT NULL DEFAULT 1,
        is_terminal INTEGER NOT NULL DEFAULT 0,
        -- Global, per-task conversation-turn number (#2338). Incremented at each
        -- anchor (message_type='user' AND is_renderable=1) across the whole task,
        -- maintained at insert (append-only) and backfilled by migration 178.
        -- NULL for rows with no task_id. Lets the compact feed + active roster
        -- seek recent turns instead of recomputing turns via window passes.
        conversation_turn_index INTEGER,
        parent_tool_use_id TEXT,
        task_id TEXT,
        sdk_uuid TEXT,
        -- Monotonic consumption sequence (#2463 P2): assigned at consumption
        -- (markDeliveryConsumedByUuid / updateMessageStatus consumed-flip). Rows
        -- retain their original rowid, which only reflects INSERTION order — a
        -- message queued in turn A and consumed in turn B keeps an old rowid, so
        -- the delivery re-claim boundary (hasTerminalResultAfter) must order by
        -- this consumption sequence, not rowid, to avoid matching turn A's result.
        consumed_seq INTEGER,
        replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

CREATE TABLE sdk_message_replacements (
        source_message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        target_uuid TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
        PRIMARY KEY (source_message_id, target_uuid, kind),
        FOREIGN KEY (source_message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
      );

CREATE TABLE message_search_pending (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
      );

CREATE TABLE global_tools_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        background_context TEXT,
        instructions TEXT,
        allowed_paths TEXT DEFAULT '[]',
        default_path TEXT,
        default_model TEXT,
        allowed_models TEXT DEFAULT '[]',
        session_ids TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        config TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived', 'rate_limited', 'usage_limited')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
        progress INTEGER,
        current_step TEXT,
        result TEXT,
        error TEXT,
        depends_on TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        task_type TEXT DEFAULT 'coding' CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
        assigned_agent TEXT DEFAULT 'coder' CHECK(assigned_agent IN ('coder', 'general', 'planner')),
        created_by_task_id TEXT,
        archived_at INTEGER,
        active_session TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        pr_created_at INTEGER,
        input_draft TEXT,
        updated_at INTEGER,
        short_id TEXT,
        restrictions TEXT,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );

CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'needs_human', 'completed', 'archived')),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
        progress INTEGER DEFAULT 0,
        linked_task_ids TEXT DEFAULT '[]',
        metrics TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        planning_attempts INTEGER DEFAULT 0,
        goal_review_attempts INTEGER DEFAULT 0,
        mission_type TEXT NOT NULL DEFAULT 'one_shot'
          CHECK(mission_type IN ('one_shot', 'measurable', 'recurring')),
        autonomy_level TEXT NOT NULL DEFAULT 'supervised'
          CHECK(autonomy_level IN ('supervised', 'semi_autonomous')),
        schedule TEXT,
        schedule_paused INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER,
        structured_metrics TEXT,
        max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
        max_planning_attempts INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        replan_count INTEGER NOT NULL DEFAULT 0,
        short_id TEXT,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );

CREATE TABLE room_github_mappings (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        repositories TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );

CREATE TABLE inbox_items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('github_issue', 'github_comment', 'github_pr')),
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        comment_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        author_permission TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'routed', 'dismissed', 'blocked')),
        routed_to_room_id TEXT,
        routed_at INTEGER,
        security_check TEXT NOT NULL,
        raw_event TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (routed_to_room_id) REFERENCES rooms(id) ON DELETE SET NULL
      );

CREATE TABLE session_groups (
        id TEXT PRIMARY KEY,
        group_type TEXT NOT NULL DEFAULT 'task',
        ref_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

CREATE TABLE session_group_members (
        group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, session_id)
      );

CREATE TABLE task_group_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );

CREATE TABLE job_queue (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
        payload TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        error TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        retry_count INTEGER NOT NULL DEFAULT 0,
        run_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        heartbeat_at INTEGER,
        completed_at INTEGER
      );

CREATE TABLE session_counters (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_count INTEGER NOT NULL DEFAULT 0,
    archived_count INTEGER NOT NULL DEFAULT 0
  );

CREATE INDEX idx_mission_metric_history_lookup ON mission_metric_history(goal_id, metric_name, recorded_at);

CREATE UNIQUE INDEX idx_mission_executions_one_running ON mission_executions(goal_id) WHERE status = 'running';

CREATE INDEX idx_space_workflow_definition_versions_space
		ON space_workflow_definition_versions(space_id)
	;

CREATE INDEX idx_space_worktrees_space_id ON space_worktrees(space_id);

CREATE INDEX idx_space_workflows_space_id ON space_workflows(space_id);

CREATE INDEX idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id);

CREATE INDEX idx_wra_run_id ON workflow_run_artifacts(run_id);

CREATE INDEX idx_wra_run_node ON workflow_run_artifacts(run_id, node_id);

CREATE UNIQUE INDEX idx_spaces_slug ON spaces(slug);

CREATE INDEX idx_spaces_status ON spaces(status);

CREATE INDEX idx_wrac_run_task ON workflow_run_artifact_cache(run_id, task_id);

CREATE INDEX idx_wrac_run_task_key ON workflow_run_artifact_cache(run_id, task_id, cache_key);

CREATE UNIQUE INDEX idx_app_mcp_servers_import
		 ON app_mcp_servers(source_path, name)
		 WHERE source = 'imported' AND source_path IS NOT NULL;

CREATE INDEX idx_mcp_enablement_scope ON mcp_enablement(scope_type, scope_id);

CREATE INDEX idx_mcp_enablement_server ON mcp_enablement(server_id);

CREATE INDEX idx_tool_continuation_recovery_session
		 ON tool_continuation_recovery(session_id, status, expires_at);

CREATE INDEX idx_tool_continuation_recovery_execution
		 ON tool_continuation_recovery(execution_id, status, expires_at);

CREATE INDEX idx_tool_continuation_inbox_execution
		 ON tool_continuation_inbox(execution_id, status, expires_at);

CREATE INDEX idx_tool_continuation_inbox_tool
		 ON tool_continuation_inbox(tool_use_id, status, expires_at);

CREATE INDEX idx_space_github_watched_repo_lookup ON space_github_watched_repos(owner, repo, enabled);

CREATE INDEX idx_space_github_events_task ON space_github_events(task_id, occurred_at);

CREATE INDEX idx_space_github_events_repo ON space_github_events(space_id, repo_owner, repo_name, pr_number);

CREATE INDEX idx_mcp_audit_log_space ON mcp_audit_log (space_id, timestamp);

CREATE INDEX idx_mcp_audit_log_task ON mcp_audit_log (task_id, timestamp);

CREATE INDEX idx_mcp_audit_log_session ON mcp_audit_log (session_id, timestamp);

CREATE INDEX idx_space_external_event_deliveries_event
		ON space_external_event_deliveries(event_id, state)
	;

CREATE INDEX idx_space_external_event_deliveries_run
		ON space_external_event_deliveries(workflow_run_id, state)
	;

CREATE UNIQUE INDEX idx_space_external_event_deliveries_key
		ON space_external_event_deliveries(delivery_key)
	;

CREATE INDEX idx_space_external_events_lookup
				ON space_external_events(space_id, source, dedupe_key)
			;

CREATE INDEX idx_space_external_events_state
				ON space_external_events(state, updated_at)
			;

CREATE INDEX idx_task_schedules_space
		ON task_schedules(space_id, status)
	;

CREATE INDEX idx_task_schedules_active_due
		ON task_schedules(status, next_run_at)
		WHERE status = 'active'
	;

CREATE UNIQUE INDEX idx_space_workflows_handle
		ON space_workflows(space_id, handle)
		WHERE handle IS NOT NULL
	;

CREATE INDEX idx_space_goals_space ON space_goals(space_id, status);

CREATE INDEX idx_space_goals_schedule ON space_goals(task_schedule_id);

CREATE INDEX idx_space_goals_active_task ON space_goals(active_task_id);

CREATE INDEX idx_space_goals_next_check_in ON space_goals(status, next_check_in_at);

CREATE INDEX idx_task_schedules_goal ON task_schedules(goal_id);

CREATE INDEX idx_space_agent_memory_space ON space_agent_memory(space_id);

CREATE INDEX idx_space_agent_memory_updated ON space_agent_memory(space_id, updated_at DESC);

CREATE INDEX idx_space_agent_memory_access ON space_agent_memory(space_id, last_accessed_at DESC);

CREATE INDEX idx_space_goal_events_goal_created ON space_goal_events(goal_id, created_at DESC);

CREATE INDEX idx_space_goal_events_space_created ON space_goal_events(space_id, created_at DESC);

CREATE INDEX idx_space_goal_events_source_task ON space_goal_events(source_task_id, created_at DESC);

CREATE INDEX idx_space_agent_memory_embedding_status ON space_agent_memory(space_id, embedding_status);

CREATE INDEX idx_evolution_scopes_space ON evolution_scopes(space_id, updated_at DESC);

CREATE INDEX idx_evolution_scopes_goal ON evolution_scopes(space_goal_id);

CREATE INDEX idx_evolution_scopes_parent ON evolution_scopes(parent_scope_id);

CREATE INDEX idx_evolution_evidence_scope_created ON evolution_evidence(scope_id, created_at DESC);

CREATE INDEX idx_evolution_evidence_source ON evolution_evidence(kind, source_id);

CREATE INDEX idx_evolution_evidence_scope_source_created ON evolution_evidence(scope_id, source_id, created_at DESC, id DESC);

CREATE INDEX idx_evolution_episodes_scope_created ON evolution_episodes(scope_id, created_at DESC);

CREATE INDEX idx_evolution_episodes_scope_status ON evolution_episodes(scope_id, status, updated_at DESC);

CREATE INDEX idx_evolution_lessons_scope_status ON evolution_lessons(scope_id, status, updated_at DESC);

CREATE INDEX idx_evolution_lessons_scope_confidence ON evolution_lessons(scope_id, confidence DESC);

CREATE INDEX idx_evolution_task_proposals_scope_status ON evolution_task_proposals(scope_id, status, updated_at DESC);

CREATE INDEX idx_evolution_task_proposals_created_task ON evolution_task_proposals(created_task_id);

CREATE INDEX idx_evolution_metric_snapshots_scope_captured ON evolution_metric_snapshots(scope_id, captured_at DESC);

CREATE INDEX idx_goal_automation_cursors_scope ON goal_automation_cursors(scope_id, updated_at DESC);

CREATE INDEX idx_goal_automation_cursors_external_event ON goal_automation_cursors(last_external_event_id);

CREATE INDEX idx_space_agent_core_memory_rank ON space_agent_core_memory(space_id, rank);

CREATE UNIQUE INDEX idx_space_long_horizon_agents_handle ON space_long_horizon_agents(space_id, handle) WHERE status != 'archived';

CREATE INDEX idx_space_long_horizon_agents_space_status ON space_long_horizon_agents(space_id, status);

CREATE INDEX idx_space_lh_agent_goals_goal ON space_long_horizon_agent_goals(goal_id);

CREATE INDEX idx_space_lh_agent_scopes_scope ON space_long_horizon_agent_forge_scopes(scope_id);

CREATE INDEX idx_space_lh_agent_reminders_due ON space_long_horizon_agent_reminders(status, next_run_at) WHERE status = 'active';

CREATE INDEX idx_space_lh_agent_reminders_agent ON space_long_horizon_agent_reminders(agent_id, status);

CREATE INDEX idx_space_lh_agent_subscriptions_route ON space_long_horizon_agent_event_subscriptions(space_id, source, topic, status);

CREATE INDEX idx_space_lh_agent_subscriptions_agent ON space_long_horizon_agent_event_subscriptions(agent_id, status);

CREATE INDEX idx_providers_provider_id ON providers(provider_id);

CREATE INDEX idx_providers_sort_order ON providers(sort_order);

CREATE INDEX idx_workflow_hook_state_run ON workflow_hook_state(run_id);

CREATE INDEX idx_workflow_hook_result_artifacts_run_hook ON workflow_hook_result_artifacts(run_id, hook_id, created_at);

CREATE INDEX idx_space_external_event_deliveries_pending
    ON space_external_event_deliveries(updated_at)
    WHERE state = 'pending'
  ;

CREATE INDEX idx_space_external_event_deliveries_state_updated
    ON space_external_event_deliveries(state, updated_at)
  ;

CREATE INDEX idx_space_external_events_recency
     ON space_external_events(space_id, source, ingested_at);

CREATE INDEX idx_space_workflow_runs_space_id ON space_workflow_runs(space_id);

CREATE INDEX idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id);

CREATE INDEX idx_space_workflow_runs_status ON space_workflow_runs(status);

CREATE INDEX idx_space_wf_event_subs_space ON space_workflow_event_subscriptions(space_id);

CREATE INDEX idx_space_wf_event_subs_run ON space_workflow_event_subscriptions(workflow_run_id, subscription_kind);

CREATE INDEX idx_space_wf_event_subs_task ON space_workflow_event_subscriptions(task_id, subscription_kind);

CREATE INDEX idx_delivery_turn_end_session
      ON delivery_turn_end(session_id)
  ;

CREATE INDEX idx_channel_cycle_events_window
		ON channel_cycle_events(run_id, channel_index, sent_at)
	;

CREATE INDEX idx_space_tasks_space_id ON space_tasks(space_id);

CREATE INDEX idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id);

CREATE UNIQUE INDEX idx_space_tasks_task_number ON space_tasks(space_id, task_number);

CREATE INDEX idx_space_tasks_goal_id ON space_tasks(goal_id);

CREATE INDEX idx_space_tasks_evolution_scope_id ON space_tasks(evolution_scope_id);

CREATE INDEX idx_space_tasks_space_status_updated ON space_tasks(space_id, status, updated_at DESC, id DESC);

CREATE INDEX idx_space_tasks_goal_created
    ON space_tasks(goal_id, created_at DESC, id DESC);

CREATE INDEX idx_space_tasks_goal_status_created
    ON space_tasks(goal_id, status, created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_space_lh_agent_goals_one_owner
    ON space_long_horizon_agent_goals(goal_id)
    WHERE relationship = 'owner';

CREATE INDEX idx_goal_outcome_notifications_goal_pending
    ON space_goal_outcome_notifications(goal_id, status, created_at);

CREATE INDEX idx_goal_outcome_notifications_task
    ON space_goal_outcome_notifications(task_id, terminal_generation);

CREATE INDEX idx_space_agent_inactivity_claims_space
    ON space_agent_inactivity_claims(space_id, agent_id)
  ;

CREATE INDEX idx_space_workspaces_space_id ON space_workspaces(space_id);

CREATE UNIQUE INDEX idx_space_workspaces_primary ON space_workspaces(space_id) WHERE is_primary = 1;

CREATE INDEX idx_node_executions_run ON node_executions(workflow_run_id);

CREATE INDEX idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id);

CREATE INDEX idx_node_executions_agent_session ON node_executions(agent_session_id);

CREATE UNIQUE INDEX idx_node_executions_unique_slot
			 ON node_executions(workflow_run_id, workflow_node_id, agent_name);

CREATE INDEX idx_sdk_messages_session_uuid
      ON sdk_messages(session_id, sdk_uuid)
    ;

CREATE INDEX idx_sdk_messages_unnormalized_replacements
      ON sdk_messages(id) WHERE replacement_metadata_normalized = 0
    ;

CREATE INDEX idx_sdk_message_replacements_session_target
      ON sdk_message_replacements(session_id, target_uuid)
    ;

CREATE INDEX idx_sdk_message_replacements_task_target
      ON sdk_message_replacements(task_id, target_uuid)
    ;

CREATE UNIQUE INDEX idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL;

CREATE UNIQUE INDEX idx_goals_room_short_id ON goals(room_id, short_id) WHERE short_id IS NOT NULL;

CREATE INDEX idx_sessions_space_agent_provenance ON sessions(space_id, json_extract(metadata, '$.promptProvenance.agentId'));

CREATE INDEX idx_sessions_room_id ON sessions(room_id) WHERE room_id IS NOT NULL;

CREATE INDEX idx_sdk_messages_session_timestamp_id
      ON sdk_messages(session_id, timestamp DESC, id DESC);

CREATE INDEX idx_sdk_messages_parent_tool_use_id
      ON sdk_messages(session_id, parent_tool_use_id);

CREATE INDEX idx_sdk_messages_renderable_terminal
      ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id);

CREATE INDEX idx_sdk_messages_session_subtype_parent
      ON sdk_messages(session_id, message_subtype_norm, parent_tool_use_id);

CREATE INDEX idx_sdk_messages_send_status_timestamp
      ON sdk_messages(session_id, send_status, timestamp);

CREATE INDEX idx_sdk_messages_deferred_uuid
      ON sdk_messages(sdk_uuid) WHERE send_status = 'deferred';

CREATE INDEX idx_sdk_messages_task_id
      ON sdk_messages(task_id, timestamp);

CREATE INDEX idx_sdk_messages_task_turn
      ON sdk_messages(task_id, conversation_turn_index);

CREATE INDEX idx_sdk_messages_task_session_turn
      ON sdk_messages(task_id, session_id, conversation_turn_index);

CREATE INDEX idx_tasks_room ON tasks(room_id);

CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_tasks_room_updated ON tasks(room_id, updated_at DESC);

CREATE INDEX idx_goals_room ON goals(room_id);

CREATE INDEX idx_goals_status ON goals(status);

CREATE INDEX idx_goals_mission_scheduler ON goals(mission_type, schedule_paused, next_run_at);

CREATE INDEX idx_goal_outcome_notifications_pending_created
      ON space_goal_outcome_notifications(status, created_at);

CREATE INDEX idx_goal_outcome_notifications_space_pending
      ON space_goal_outcome_notifications(space_id, status, created_at);

CREATE INDEX idx_room_github_mappings_room ON room_github_mappings(room_id);

CREATE INDEX idx_inbox_items_status ON inbox_items(status);

CREATE INDEX idx_inbox_items_repository ON inbox_items(repository, issue_number);

CREATE INDEX idx_session_groups_ref ON session_groups(ref_id);

CREATE UNIQUE INDEX idx_session_groups_active_ref
		 ON session_groups(ref_id) WHERE completed_at IS NULL AND (group_type = 'task' OR group_type = 'task_pair');

CREATE INDEX idx_sgm_session ON session_group_members(session_id);

CREATE INDEX idx_tge_group ON task_group_events(group_id, id);

CREATE INDEX idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);

CREATE INDEX idx_job_queue_status ON job_queue(status);

CREATE INDEX idx_message_delivery_session_active
      ON job_queue (json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery' AND status IN ('pending', 'processing')
  ;

CREATE INDEX idx_workspace_history_last_used_at ON workspace_history(last_used_at DESC);

CREATE TRIGGER space_agent_memory_ai
		AFTER INSERT ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END;

CREATE TRIGGER space_agent_memory_ad
		AFTER DELETE ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
		END;

CREATE TRIGGER space_agent_memory_au
		AFTER UPDATE OF key, content, tags ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END;

CREATE TRIGGER message_search_content_ai
		AFTER INSERT ON message_search_content BEGIN
			INSERT INTO message_search_fts(rowid, title, body)
			VALUES (new.id, new.title, new.body);
		END;

CREATE TRIGGER message_search_content_ad
		AFTER DELETE ON message_search_content BEGIN
			INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
			VALUES ('delete', old.id, old.title, old.body);
		END;

CREATE TRIGGER message_search_content_au
		AFTER UPDATE OF title, body ON message_search_content BEGIN
			INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
			VALUES ('delete', old.id, old.title, old.body);
			INSERT INTO message_search_fts(rowid, title, body)
			VALUES (new.id, new.title, new.body);
		END;

CREATE TRIGGER session_counters_ai
    AFTER INSERT ON sessions BEGIN
      UPDATE session_counters SET
        total_count = total_count + CASE WHEN new.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(new.session_context) THEN (json_extract(new.session_context, '$.roomId') IS NULL AND json_extract(new.session_context, '$.spaceId') IS NULL) ELSE 1 END THEN 1 ELSE 0 END,
        archived_count = archived_count + CASE WHEN new.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(new.session_context) THEN (json_extract(new.session_context, '$.roomId') IS NULL AND json_extract(new.session_context, '$.spaceId') IS NULL) ELSE 1 END AND new.status = 'archived' THEN 1 ELSE 0 END
      WHERE id = 1;
    END;

CREATE TRIGGER session_counters_ad
    AFTER DELETE ON sessions BEGIN
      UPDATE session_counters SET
        total_count = total_count - CASE WHEN old.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(old.session_context) THEN (json_extract(old.session_context, '$.roomId') IS NULL AND json_extract(old.session_context, '$.spaceId') IS NULL) ELSE 1 END THEN 1 ELSE 0 END,
        archived_count = archived_count - CASE WHEN old.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(old.session_context) THEN (json_extract(old.session_context, '$.roomId') IS NULL AND json_extract(old.session_context, '$.spaceId') IS NULL) ELSE 1 END AND old.status = 'archived' THEN 1 ELSE 0 END
      WHERE id = 1;
    END;

CREATE TRIGGER session_counters_au
    AFTER UPDATE OF type, status, session_context ON sessions
    WHEN old.type IS NOT new.type
      OR old.status IS NOT new.status
      OR old.session_context IS NOT new.session_context
    BEGIN
      UPDATE session_counters SET
        total_count = total_count
          + CASE WHEN new.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(new.session_context) THEN (json_extract(new.session_context, '$.roomId') IS NULL AND json_extract(new.session_context, '$.spaceId') IS NULL) ELSE 1 END THEN 1 ELSE 0 END - CASE WHEN old.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(old.session_context) THEN (json_extract(old.session_context, '$.roomId') IS NULL AND json_extract(old.session_context, '$.spaceId') IS NULL) ELSE 1 END THEN 1 ELSE 0 END,
        archived_count = archived_count
          + CASE WHEN new.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(new.session_context) THEN (json_extract(new.session_context, '$.roomId') IS NULL AND json_extract(new.session_context, '$.spaceId') IS NULL) ELSE 1 END AND new.status = 'archived' THEN 1 ELSE 0 END - CASE WHEN old.type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent') AND CASE WHEN json_valid(old.session_context) THEN (json_extract(old.session_context, '$.roomId') IS NULL AND json_extract(old.session_context, '$.spaceId') IS NULL) ELSE 1 END AND old.status = 'archived' THEN 1 ELSE 0 END
      WHERE id = 1;
    END;

INSERT INTO migration_markers (key, applied_at) VALUES ('m154_legacy_long_horizon_agent_data', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('m158_cleanup_terminal_space_runtime_state', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_001', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_002', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_003', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_004', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_005', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_006', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_007', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_008', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_009', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_010', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_011', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_012', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_013', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_014', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_015', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_016', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_017', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_018', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_019', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_020', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_021', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_022', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_023', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_024', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_025', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_026', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_027', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_028', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_029', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_030', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_031', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_032', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_033', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_034', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_035', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_036', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_037', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_038', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_039', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_040', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_041', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_042', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_043', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_044', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_045', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_046', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_047', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_048', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_049', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_050', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_051', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_052', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_053', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_054', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_055', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_056', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_057', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_058', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_059', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_060', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_061', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_062', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_063', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_064', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_065', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_066', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_067', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_068', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_069', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_070', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_071', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_072', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_073', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_074', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_075', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_076', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_077', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_078', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_079', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_080', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_081', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_082', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_083', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_084', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_085', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_086', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_087', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_088', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_089', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_090', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_091', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_093', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_094', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_095', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_096', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_097', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_098', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_099', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_100', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_101', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_102', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_103', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_104', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_105', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_106', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_107', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_108', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_109', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_111', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_112', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_113', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_114', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_115', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_116', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_117', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_118', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_119', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_120', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_121', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_122', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_123', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_124', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_125', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_126', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_127', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_128', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_129', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_130', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_131', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_132', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_133', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_134', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_136', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_137', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_138', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_139', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_140', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_141', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_142', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_143', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_144', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_145', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_146', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_147', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_148', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_149', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_150', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_151', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_152', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_153', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_154', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_155', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_156', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_157', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_158', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_159', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_160', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_161', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_162', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_163', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_164', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_165', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_166', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_167', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_168', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_169', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_170', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_171', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_172', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_173', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_174', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_175', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_176', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_177', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_178', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_180', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_181', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_182', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_183', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_184', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_185', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_186', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_187', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_188', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_189', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_190', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_191', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_193', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_194', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_195', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_196', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_197', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_198', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_199', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_200', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_201', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_202', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_203', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_204', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_205', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_206', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_207', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_208', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_210', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_211', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_212', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_213', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_214', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_215', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_216', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_217', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_218', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_219', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_220', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_221', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_222', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_223', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_224', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_225', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_226', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_227', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_228', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_229', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_230', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_231', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_232', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_233', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_234', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_235', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_236', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_237', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_238', 1);
INSERT INTO migration_markers (key, applied_at) VALUES ('migration_room_cleanup', 1);
