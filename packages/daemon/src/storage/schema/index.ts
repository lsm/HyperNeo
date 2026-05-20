/**
 * Database Schema Management
 *
 * Responsibilities:
 * - Table definitions for all tables
 * - Index creation
 * - Default value initialization
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

// Re-export migrations
// knip-ignore-next-line
export { runMigrations } from './migrations';
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

/**
 * Create all database tables and initialize defaults
 */
export function createTables(db: BunDatabase): void {
	// Sessions table
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
        sdk_origin_path TEXT,
        available_commands TEXT,
        processing_state TEXT,
        archived_at TEXT,
        parent_id TEXT,
        type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'space_chat')),
        session_context TEXT
      )
    `);

	// Messages and tool_calls tables removed - we now only use sdk_messages table
	// This provides a cleaner design with single source of truth

	// Authentication configuration table (stores current auth method and credentials)
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

	// OAuth state table removed - web-based OAuth flow is no longer supported
	// Authentication is now handled via environment variables only

	// SDK Messages table (stores full SDK messages with all metadata).
	//
	// `task_id` is denormalised from the writing session's
	// `session_context.taskId` at INSERT time. It supports task-scoped
	// activity feeds without a separate map table. Nullable (most non-Space
	// sessions are not task-bound) and intentionally has no FK — task
	// lifecycle is managed independently and we don't want a task delete
	// to cascade-blow-away historic messages.
	db.exec(`
      CREATE TABLE IF NOT EXISTS sdk_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_subtype TEXT,
        sdk_message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
        origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'system')),
        is_renderable INTEGER NOT NULL DEFAULT 1,
        is_terminal INTEGER NOT NULL DEFAULT 0,
        parent_tool_use_id TEXT,
        task_id TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

	// Initialize auth_config with default values if not exists
	db.exec(`
      INSERT OR IGNORE INTO auth_config (id, auth_method, updated_at)
      VALUES (1, 'none', datetime('now'))
    `);

	// Global tools configuration table
	db.exec(`
      CREATE TABLE IF NOT EXISTS global_tools_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

	// Initialize global_tools_config with default values if not exists
	db.exec(`
      INSERT OR IGNORE INTO global_tools_config (id, config, updated_at)
      VALUES (1, '${JSON.stringify(DEFAULT_GLOBAL_TOOLS_CONFIG)}', datetime('now'))
    `);

	// Global settings table
	db.exec(`
      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

	// Initialize global_settings with default values if not exists
	db.exec(`
      INSERT OR IGNORE INTO global_settings (id, settings, updated_at)
      VALUES (1, '${JSON.stringify(DEFAULT_GLOBAL_SETTINGS)}', datetime('now'))
    `);

	// Room tables - self-aware architecture foundation

	// Rooms table - conceptual workspaces
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

	// Tasks table - task management
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

	// Goals table
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

	// Space-native long-horizon goals. These intentionally do not couple to
	// the legacy room `goals` / mission execution tables above: goal state lives
	// here, concrete execution happens through linked `space_tasks` rows.
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

	// Short ID counters — per-(entity_type, scope_id) monotonic counter for short ID allocation
	db.exec(`
      CREATE TABLE IF NOT EXISTS short_id_counters (
        entity_type TEXT NOT NULL,
        scope_id    TEXT NOT NULL,
        counter     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entity_type, scope_id)
      )
    `);

	// Partial unique indexes for short_id on tasks and goals — scoped to room so that
	// different rooms can each have their own t-1, t-2, ... sequence without collision.
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
	);
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_room_short_id ON goals(room_id, short_id) WHERE short_id IS NOT NULL`
	);

	// Mission metric history table
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

	// Mission executions table
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

	// GitHub integration tables

	// Room GitHub mappings - maps repositories to rooms
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

	// Space-level watched GitHub repositories and PR activity events
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

	// Inbox items - GitHub events awaiting routing
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

	// Room Runtime tables — session groups for multi-agent collaboration

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

	// task_session_map has been removed. Task-scoped lookups now read
	// `sdk_messages.task_id` directly (see migration 122 + the column
	// declared in `sdk_messages` above). This bootstrap path no longer
	// needs to know about the legacy table at all.

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

	// Partial unique index on (source_path, name) for imported rows — enables
	// idempotent upserts from McpImportService without a pre-check round trip.
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_mcp_servers_import
		 ON app_mcp_servers(source_path, name)
		 WHERE source = 'imported' AND source_path IS NOT NULL`
	);

	// Per-room MCP enablement overrides (legacy — superseded by `mcp_enablement`
	// with scope_type='room'. Kept here until M5 purges it.)
	db.exec(`
      CREATE TABLE IF NOT EXISTS room_mcp_enablement (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (room_id, server_id)
      )
    `);

	// Generalized MCP enablement overrides — one row per explicit override at a
	// specific scope (space / room / session). Missing rows inherit from the
	// next most-specific scope, falling back to the registry default. Added in
	// M3 (Migration 100); supersedes `room_mcp_enablement`, which is dropped in M5.
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

	// Application-level Skills registry
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

	// Per-room skill enablement overrides
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
        completed_at INTEGER
      )
    `);

	// Workspace history — persists recently-used workspace paths
	db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        last_used_at INTEGER NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 1
      )
	    `);

	// Durable Codex tool continuation recovery state. The full space schema is
	// migration-owned, so these tables avoid foreign keys here and are also
	// created by migration 109 for existing databases.
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

	createAgentMemoryTables(db);

	// Create indexes
	createIndexes(db);
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

/**
 * Create database indexes for performance
 */
function createIndexes(db: BunDatabase): void {
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session
      ON sdk_messages(session_id, timestamp)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id
      ON sdk_messages(session_id, timestamp DESC, id DESC)`);
	// Plain B-tree index over the materialised parent_tool_use_id column.
	// The earlier json_extract function index (idx_sdk_messages_parent_tool)
	// was dropped in migration 126 — all callers now use the column directly.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id
      ON sdk_messages(session_id, parent_tool_use_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_renderable_terminal
      ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_uuid_status
      ON sdk_messages(session_id, send_status, json_extract(sdk_message, '$.uuid'))`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_type
      ON sdk_messages(message_type, message_subtype)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status
      ON sdk_messages(session_id, send_status)`);
	// Task-scoped feeds and activity views read directly from this column.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id
      ON sdk_messages(task_id, timestamp)`);
	// Covers the `SELECT DISTINCT session_id WHERE task_id = ?` dedup in the
	// SPACE_TASK_ACTIVITY_BY_TASK_SQL `contributing_sessions` CTE — turns it
	// into an index-only scan rather than walking the (task_id, timestamp)
	// index and dropping the timestamp column.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session
      ON sdk_messages(task_id, session_id)`);

	// Legacy `task_session_map` indexes no longer exist — see the
	// `sdk_messages.task_id` column above for the replacement.

	// Agent memory indexes
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

	// Room indexes
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

	// GitHub integration indexes
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
	// Room Runtime indexes
	db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_ref ON session_groups(ref_id)`);
	// Partial unique index: at most one active group per task ref_id at the DB level.
	// Scoped to task/task_pair group types only — other future group types may share
	// ref_id values without violating this constraint.
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_active_ref
		 ON session_groups(ref_id) WHERE completed_at IS NULL AND (group_type = 'task' OR group_type = 'task_pair')`
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sgm_session ON session_group_members(session_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tge_group ON task_group_events(group_id, id)`);
	// Job queue indexes
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC)`
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status)`);
	// Workspace history index — supports ORDER BY last_used_at DESC in list()
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
