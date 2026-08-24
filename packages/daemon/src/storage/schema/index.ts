import type { Database as BunDatabase } from '../sqlite-compat';
import { createEvolutionTables } from './evolution';
import { createLongHorizonAgentTables } from './long-horizon-agents';
import { createWorkflowEventSubscriptionTables } from './workflow-event-subscriptions';
import { backfillSessionCounters, createSessionCounters } from './session-counters';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';

// knip-ignore-next-line
export { runMigrations } from './migrations';
export { reclaimPendingMigrationSpace } from './migration-space-reclaim';
// knip-ignore-next-line
export { runMigration12 } from './migrations';
// knip-ignore-next-line
export { runMigration47 } from './migrations';
// knip-ignore-next-line
export { runMigration48 } from './migrations';
// knip-ignore-next-line
export { runMigration49 } from './migrations';
// knip-ignore-next-line
export { runMigration50 } from './migrations';
// knip-ignore-next-line
export { runMigration51 } from './migrations';
// knip-ignore-next-line
export { runMigration55 } from './migrations';
// knip-ignore-next-line
export { runMigration56 } from './migrations';
// knip-ignore-next-line
export { runMigration57 } from './migrations';
// knip-ignore-next-line
export { runMigration58 } from './migrations';
// knip-ignore-next-line
export { runMigration66 } from './migrations';
// knip-ignore-next-line
export { runMigration68 } from './migrations';
// knip-ignore-next-line
export { runMigration72 } from './migrations';
// knip-ignore-next-line
export { runMigration74 } from './migrations';
// knip-ignore-next-line
export { runMigration78 } from './migrations';
// knip-ignore-next-line
export { runMigration86 } from './migrations';
// knip-ignore-next-line
export { runMigration93 } from './migrations';
// knip-ignore-next-line
export { runMigration94 } from './migrations';
// knip-ignore-next-line
export { runMigration95 } from './migrations';
// knip-ignore-next-line
export { runMigration96 } from './migrations';
// knip-ignore-next-line
export { runMigration97 } from './migrations';
// knip-ignore-next-line
export { runMigration98 } from './migrations';
// knip-ignore-next-line
export { runMigration99 } from './migrations';
// knip-ignore-next-line
export { runMigration100 } from './migrations';
// knip-ignore-next-line
export { runMigration101 } from './migrations';
// knip-ignore-next-line
export { runMigration109 } from './migrations';
// knip-ignore-next-line
export { runMigration110 } from './migrations';
// knip-ignore-next-line
export { runMigration111 } from './migrations';
// knip-ignore-next-line
export { runMigration112 } from './migrations';
// knip-ignore-next-line
export { runMigration117 } from './migrations';
// knip-ignore-next-line
export { runMigration118 } from './migrations';
// knip-ignore-next-line
export { runMigration119 } from './migrations';
// knip-ignore-next-line
export { runMigration120 } from './migrations';
// knip-ignore-next-line
export { runMigration121 } from './migrations';
// knip-ignore-next-line
export { runMigration122 } from './migrations';
// knip-ignore-next-line
export { runMigration123 } from './migrations';
// knip-ignore-next-line
export { runMigration124 } from './migrations';
// knip-ignore-next-line
export { runMigration125 } from './migrations';
// knip-ignore-next-line
export { runMigration126 } from './migrations';
// knip-ignore-next-line
export { runMigration127 } from './migrations';
// knip-ignore-next-line
export { runMigration128 } from './migrations';
// knip-ignore-next-line
export { runMigration129 } from './migrations';
// knip-ignore-next-line
export { runMigration130 } from './migrations';
// knip-ignore-next-line
export { runMigration131 } from './migrations';
// knip-ignore-next-line
export { runMigration132 } from './migrations';
// knip-ignore-next-line
export { runMigration133 } from './migrations';
// knip-ignore-next-line
export { runMigration134 } from './migrations';
// knip-ignore-next-line
export { runMigration137 } from './migrations';
// knip-ignore-next-line
export { runMigration138 } from './migrations';
// knip-ignore-next-line
export { runMigration139 } from './migrations';
// knip-ignore-next-line
export {
  configureMessageSearchFts,
  runMigration141,
  runMigration211,
  runMigration212,
} from './migrations';
// knip-ignore-next-line
export { runMigration142 } from './migrations';
// knip-ignore-next-line
export { runMigration143 } from './migrations';
// knip-ignore-next-line
export { runMigration144 } from './migrations';
// knip-ignore-next-line
export { runMigration148 } from './migrations';
// knip-ignore-next-line
export { runMigration156 } from './migrations';
// knip-ignore-next-line
export { runMigration166 } from './migrations';
// knip-ignore-next-line
export { runMigration170 } from './migrations';
// knip-ignore-next-line
export { runMigration174 } from './migrations';
// knip-ignore-next-line
export { runMigration186 } from './migrations';

export function createTables(db: BunDatabase): void {
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS auth_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auth_method TEXT NOT NULL CHECK(auth_method IN ('oauth', 'oauth_token', 'api_key', 'none')),
        api_key_encrypted TEXT,
        oauth_tokens_encrypted TEXT,
        oauth_token_encrypted TEXT,
        updated_at TEXT NOT NULL
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS sdk_messages (
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
  db.exec(`
      CREATE TABLE IF NOT EXISTS message_search_pending (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_uuid
      ON sdk_messages(session_id, sdk_uuid)
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sdk_messages_unnormalized_replacements
      ON sdk_messages(id) WHERE replacement_metadata_normalized = 0
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sdk_message_replacements_session_target
      ON sdk_message_replacements(session_id, target_uuid)
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sdk_message_replacements_task_target
      ON sdk_message_replacements(task_id, target_uuid)
    `);

  db.exec(`
      INSERT OR IGNORE INTO auth_config (id, auth_method, updated_at)
      VALUES (1, 'none', datetime('now'))
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS provider_credentials (
        provider_id TEXT PRIMARY KEY,
        encrypted_data BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS global_tools_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

  db.exec(`
      INSERT OR IGNORE INTO global_tools_config (id, config, updated_at)
      VALUES (1, '${JSON.stringify(DEFAULT_GLOBAL_TOOLS_CONFIG)}', datetime('now'))
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

  db.exec(`
      INSERT OR IGNORE INTO global_settings (id, settings, updated_at)
      VALUES (1, '${JSON.stringify(DEFAULT_GLOBAL_SETTINGS)}', datetime('now'))
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
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
      )
    `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_providers_provider_id ON providers(provider_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_providers_sort_order ON providers(sort_order)`);

  db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
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
      )
    `);

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
        revision INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
      )
    `);

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

  db.exec(`
      CREATE TABLE IF NOT EXISTS space_goal_outcome_notifications (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS short_id_counters (
        entity_type TEXT NOT NULL,
        scope_id    TEXT NOT NULL,
        counter     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entity_type, scope_id)
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS space_agent_inactivity_config (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS space_agent_inactivity_claims (
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
      )
    `);

  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_space_agent_inactivity_claims_space
      ON space_agent_inactivity_claims(space_id, agent_id)
    `);

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_room_short_id ON goals(room_id, short_id) WHERE short_id IS NOT NULL`
  );

  db.exec(`
      CREATE TABLE IF NOT EXISTS mission_metric_history (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS mission_executions (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS room_github_mappings (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        repositories TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS space_github_watched_repos (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        webhook_enabled INTEGER NOT NULL DEFAULT 1,
        polling_enabled INTEGER NOT NULL DEFAULT 0,
        webhook_secret TEXT,
        webhook_remote_id INTEGER,
        webhook_url TEXT,
        webhook_auto_registered INTEGER NOT NULL DEFAULT 0,
        webhook_active INTEGER,
        webhook_last_checked_at INTEGER,
        webhook_last_error TEXT,
        webhook_configured_at INTEGER,
        last_webhook_at INTEGER,
        last_poll_at INTEGER,
        poll_cursor TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(space_id, owner, repo)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS space_github_events (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_items (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        group_type TEXT NOT NULL DEFAULT 'task',
        ref_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS session_group_members (
        group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, session_id)
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS task_group_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS app_mcp_servers (
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
        source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('builtin', 'user', 'imported')),
        source_path TEXT,
        created_at INTEGER,
        updated_at INTEGER
      )
    `);

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_app_mcp_servers_import
		 ON app_mcp_servers(source_path, name)
		 WHERE source = 'imported' AND source_path IS NOT NULL`
  );

  db.exec(`
      CREATE TABLE IF NOT EXISTS room_mcp_enablement (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (room_id, server_id)
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_enablement (
        server_id  TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('space', 'room', 'session')),
        scope_id   TEXT NOT NULL,
        enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        PRIMARY KEY (server_id, scope_type, scope_id)
      )
    `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mcp_enablement_scope ON mcp_enablement(scope_type, scope_id)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_enablement_server ON mcp_enablement(server_id)`);

  db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS room_skill_overrides (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (skill_id, room_id)
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS job_queue (
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
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_turn_end (
        session_id TEXT NOT NULL,
        message_uuid TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_uuid)
      )
    `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_turn_end_session
      ON delivery_turn_end(session_id)
  `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_consumed_seq (
        singleton INTEGER PRIMARY KEY DEFAULT 1,
        next_seq INTEGER NOT NULL DEFAULT 1
      )
    `);
  db.exec(`
      INSERT OR IGNORE INTO delivery_consumed_seq (singleton, next_seq) VALUES (1, 1)
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        last_used_at INTEGER NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 1
      )
	    `);

  db.exec(`
	      CREATE TABLE IF NOT EXISTS tool_continuation_recovery (
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
	      )
	    `);
  db.exec(`
	      CREATE TABLE IF NOT EXISTS tool_continuation_inbox (
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
	      )
	    `);

  createSpaceAgentInboxTables(db);
  createAgentMemoryTables(db);
  createEvolutionTables(db);
  createLongHorizonAgentTables(db);
  createWorkflowEventSubscriptionTables(db);
  createSessionCounters(db);
  backfillSessionCounters(db);

  createIndexes(db);
}

function createSpaceAgentInboxTables(db: BunDatabase): void {
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
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
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
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_space_agent_provenance ` +
      `ON sessions(space_id, json_extract(metadata, '$.promptProvenance.agentId'))`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_room_id ` +
      `ON sessions(room_id) WHERE room_id IS NOT NULL`
  );
}

function createAgentMemoryTables(db: BunDatabase): void {
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
}

function createIndexes(db: BunDatabase): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id
      ON sdk_messages(session_id, timestamp DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id
      ON sdk_messages(session_id, parent_tool_use_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_renderable_terminal
      ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_subtype_parent
      ON sdk_messages(session_id, message_subtype_norm, parent_tool_use_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status_timestamp
      ON sdk_messages(session_id, send_status, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id
      ON sdk_messages(task_id, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_turn
      ON sdk_messages(task_id, conversation_turn_index)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session_turn
      ON sdk_messages(task_id, session_id, conversation_turn_index)`);

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

  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_room ON goals(room_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_space ON space_goals(space_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_schedule ON space_goals(task_schedule_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_active_task ON space_goals(active_task_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goals_next_check_in ON space_goals(status, next_check_in_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goals_mission_scheduler ON goals(mission_type, schedule_paused, next_run_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mission_metric_history_lookup ON mission_metric_history(goal_id, metric_name, recorded_at)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running ON mission_executions(goal_id) WHERE status = 'running'`
  );

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_goal_created ON space_goal_events(goal_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_space_created ON space_goal_events(space_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_source_task ON space_goal_events(source_task_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_goal_pending
      ON space_goal_outcome_notifications(goal_id, status, created_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_task
      ON space_goal_outcome_notifications(task_id, terminal_generation)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_pending_created
      ON space_goal_outcome_notifications(status, created_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_space_pending
      ON space_goal_outcome_notifications(space_id, status, created_at)`
  );

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_room_github_mappings_room ON room_github_mappings(room_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_watched_repo_lookup ON space_github_watched_repos(owner, repo, enabled)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_task ON space_github_events(task_id, occurred_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_repo ON space_github_events(space_id, repo_owner, repo_name, pr_number)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_inbox_items_repository ON inbox_items(repository, issue_number)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_ref ON session_groups(ref_id)`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_active_ref
		 ON session_groups(ref_id) WHERE completed_at IS NULL AND (group_type = 'task' OR group_type = 'task_pair')`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sgm_session ON session_group_members(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tge_group ON task_group_events(group_id, id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status)`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_message_delivery_active_turn
      ON job_queue (queue, json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery'
        AND json_extract(payload, '$.role') = 'turn'
        AND status IN ('pending', 'processing')
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_session_active
      ON job_queue (json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery' AND status IN ('pending', 'processing')
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workspace_history_last_used_at ON workspace_history(last_used_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_recovery_session
		 ON tool_continuation_recovery(session_id, status, expires_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_recovery_execution
		 ON tool_continuation_recovery(execution_id, status, expires_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_inbox_execution
		 ON tool_continuation_inbox(execution_id, status, expires_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_inbox_tool
		 ON tool_continuation_inbox(tool_use_id, status, expires_at)`
  );
}
