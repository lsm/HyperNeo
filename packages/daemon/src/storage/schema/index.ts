import { runMigration470 } from './m470-neo-peers.ts';
import { runMigration467 } from './m467-google-connections.ts';
import { runMigration456 } from './m456-neo-todo-query-indexes.ts';
import { runMigration447 } from './m447-neo-todo-removed-index.ts';
import { runMigration445 } from './m445-job-queue-message-lookup-index.ts';
import { createNeoGoalsTable } from './m444-neo-goals.ts';
import { runMigration432 } from './m432-artifact-files.ts';
import { runMigration429 } from './m429-neo-rule-proposals.ts';
import { runMigration428 } from './m428-pack-preference-proposals.ts';
import { createNeoPackPreferencesTable } from './m426-neo-pack-preferences.ts';
import { runMigration425 } from './m425-message-send-receipts.ts';
import { runMigration388 } from './m388-claude-desktop-bridge-events.ts';
import { createNeoProjectSchema } from './m361-neo-project-avatars.ts';
import { runMigration360 } from './m360-workspace-projects.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { createNeoTables } from './neo.ts';
import { createNeoPublicationTable } from './m288-neo-publications.ts';
import { createNeoConversationAskTable } from './m289-neo-conversation-asks.ts';
import { createSessionIncarnationTable } from './m290-session-incarnations.ts';
import { backfillSessionCounters, createSessionCounters } from './session-counters.ts';
import { createTaskMessageRows } from './task-message-rows.ts';
import { SDK_MESSAGE_COLUMN_TYPES } from '../sdk-message-columns.ts';
import { createSdkMessageFilterIndexes } from './sdk-message-filter-indexes.ts';
import { runMigration418 } from './m418-sdk-message-bodies.ts';
import { runMigration419 } from './m419-task-message-body-triggers.ts';
import { runMigration422 } from './m422-tool-continuation-expiry-indexes.ts';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';

// knip-ignore-next-line
export { runMigrations } from './migrations.ts';
export { runMigration265 } from './m265-workflow-run-blocked-retries.ts';
export { runMigration266 } from './m266-task-assistant-messages-index.ts';
export { reclaimPendingMigrationSpace } from './migration-space-reclaim.ts';
// knip-ignore-next-line
export { runMigration47 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration48 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration66 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration74 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration86 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration101 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration111 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration112 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration122 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration124 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration126 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration127 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration128 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration129 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration131 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration134 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration137 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration139 } from './migrations.ts';
// knip-ignore-next-line
export {
  configureMessageSearchFts,
  runMigration141,
  runMigration211,
  runMigration212,
} from './migrations.ts';
// knip-ignore-next-line
export { runMigration142 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration143 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration144 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration148 } from './migrations.ts';
// knip-ignore-next-line
// knip-ignore-next-line
export { runMigration166 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration170 } from './migrations.ts';
// knip-ignore-next-line
export { runMigration174 } from './migrations.ts';
// knip-ignore-next-line

import {
  createExtensionIndexes,
  createExtensionTables,
  registerSchemaExtension,
} from './extensions.ts';
import { prepareCodingTodoStorage } from '../../lib/neo/packs/coding/schema/coding-tables.ts';

registerSchemaExtension({ id: 'coding-todos', tables: prepareCodingTodoStorage });

export function createTables(db: BunDatabase): void {
  createNeoGoalsTable(db);
  createNeoTables(db);
  createNeoProjectSchema(db);
  createNeoPublicationTable(db);
  createNeoConversationAskTable(db);
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

  createSessionIncarnationTable(db);
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
        ${Object.entries(SDK_MESSAGE_COLUMN_TYPES)
          .map(([name, type]) => `${name} ${type}`)
          .join(',\n')},
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
  runMigration418(db);
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
      CREATE TABLE IF NOT EXISTS daemon_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
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
      CREATE TABLE IF NOT EXISTS short_id_counters (
        entity_type TEXT NOT NULL,
        scope_id    TEXT NOT NULL,
        counter     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entity_type, scope_id)
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
        last_attach_error TEXT,
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
  runMigration360(db);
  runMigration388(db);

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

  createSessionAgentIndexes(db);
  createExtensionTables(db);
  createSessionCounters(db);
  backfillSessionCounters(db);
  createTaskMessageRows(db);
  runMigration419(db);

  createIndexes(db);
}

function createSessionAgentIndexes(db: BunDatabase): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_space_agent_provenance ` +
      `ON sessions(space_id, json_extract(metadata, '$.promptProvenance.agentId'))`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_room_id ` +
      `ON sessions(room_id) WHERE room_id IS NOT NULL`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)`);
}

function createIndexes(db: BunDatabase): void {
  createSdkMessageFilterIndexes(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id
      ON sdk_messages(session_id, timestamp DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id
      ON sdk_messages(session_id, parent_tool_use_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_subtype_parent
      ON sdk_messages(session_id, message_subtype_norm, parent_tool_use_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_visible
      ON sdk_messages(session_id, parent_tool_use_id, timestamp, id, message_type, send_status,
        message_subtype)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_subtype_time
      ON sdk_messages(session_id, message_subtype_norm, parent_tool_use_id, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status_timestamp
      ON sdk_messages(session_id, send_status, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_deferred_uuid
      ON sdk_messages(sdk_uuid) WHERE send_status = 'deferred'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id
      ON sdk_messages(task_id, timestamp) WHERE task_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_turn
      ON sdk_messages(task_id, conversation_turn_index) WHERE task_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session_turn
      ON sdk_messages(task_id, session_id, conversation_turn_index) WHERE task_id IS NOT NULL`);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_watched_repo_lookup ON space_github_watched_repos(owner, repo, enabled)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_task ON space_github_events(task_id, occurred_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_repo ON space_github_events(space_id, repo_owner, repo_name, pr_number)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_ref ON session_groups(ref_id)`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_active_ref
		 ON session_groups(ref_id) WHERE completed_at IS NULL AND (group_type = 'task' OR group_type = 'task_pair')`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sgm_session ON session_group_members(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tge_group ON task_group_events(group_id, id)`);
  runMigration445(db);
  runMigration447(db);
  runMigration456(db);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_job_queue_status_completed ON job_queue(status, completed_at)`
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_session_active
      ON job_queue (json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery' AND status IN ('pending', 'processing')
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_message
      ON job_queue (json_extract(payload, '$.messageUuid'))
      WHERE queue = 'message_delivery'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_session_message_active
      ON job_queue (json_extract(payload, '$.sessionId'), json_extract(payload, '$.messageUuid'))
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
  runMigration422(db);
  runMigration425(db);
  createNeoPackPreferencesTable(db);
  runMigration428(db);
  runMigration429(db);
  runMigration432(db);
  runMigration467(db);
  runMigration470(db);
  createExtensionIndexes(db);
}
