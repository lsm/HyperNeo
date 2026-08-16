import type { SessionContext } from '@hyperneo/shared';

// ── Types ──────────────────────────────────────────────────────────────────────

/** The three scope levels that determine table access and filter injection. */
export type DbScopeType = 'global' | 'room' | 'space';

/** Configuration for indirect scope resolution via a join table. */
export interface ScopeJoinConfig {
  /** Column on the target table that references the join table (e.g., 'goal_id'). */
  localColumn: string;
  /** The intermediate table used for scope resolution (e.g., 'goals'). */
  joinTable: string;
  /** Primary key column on the join table (e.g., 'id'). */
  joinPkColumn: string;
  /** The scope column on the join table (e.g., 'room_id' or 'space_id'). */
  scopeColumn: string;
  /**
   * When set, uses `LIKE ?` instead of `= ?` for the join's WHERE clause.
   * The LIKE parameter is constructed as: `likePrefix + scopeValue + likeSuffix`.
   * Example: likePrefix='space:', likeSuffix=':%' → WHERE session_id LIKE 'space:abc:%'
   */
  likePrefix?: string;
  /** Suffix for the LIKE pattern. Only used when likePrefix is set. Defaults to ''. */
  likeSuffix?: string;
}

/**
 * Configuration for LIKE-based scope filtering on a direct column.
 *
 * Used for tables where scope is encoded in a column value via a prefix pattern,
 * such as session IDs with the format `space:<spaceId>:<rest>`.
 *
 * The LIKE parameter is constructed as: `patternPrefix + scopeValue + patternSuffix`.
 */
export interface ScopeLikeConfig {
  /** Column to apply LIKE filter on (e.g., 'id', 'session_id'). */
  column: string;
  /** Text before the scope value in the LIKE pattern (e.g., 'space:'). */
  patternPrefix: string;
  /** Text after the scope value in the LIKE pattern (e.g., ':%'). */
  patternSuffix: string;
}

/** Full configuration for a table within a given scope. */
export interface ScopeTableConfig {
  /** Must match the actual table name in the SQLite schema. */
  tableName: string;
  /** Direct scope column on this table (e.g., 'room_id', 'space_id'). */
  scopeColumn?: string;
  /** Indirect scope resolution via a join table. */
  scopeJoin?: ScopeJoinConfig;
  /** LIKE-based scope filter for prefix-encoded IDs (e.g., session ID prefix). */
  scopeLike?: ScopeLikeConfig;
  /** Columns to exclude from `db_describe_table` and `SELECT *`. */
  blacklistedColumns: string[];
  /** Human-readable description for the agent. */
  description: string;
}

/** Resolved scope information for a given session context. */
export interface ResolvedScope {
  scopeType: DbScopeType;
  scopeValue: string;
}

/** Parameterized WHERE clause result from `buildScopeFilter`. */
export interface ScopeFilterResult {
  whereClause: string;
  params: unknown[];
}

// ── Global column blacklist (applied regardless of scope) ─────────────────────

/**
 * Per-table column blacklists. These columns are excluded from
 * `db_describe_table` output and `SELECT *` expansion.
 *
 * Blacklists are global per-table, not scope-dependent.
 */
const COLUMN_BLACKLISTS: Record<string, string[]> = {
  sessions: ['config', 'session_context'],
  rooms: ['config'],
  spaces: ['config'],
  app_mcp_servers: ['env'],
  inbox_items: ['raw_event', 'security_check'],
  job_queue: ['payload'],
  space_agents: ['system_prompt'],
  space_workflows: ['config', 'gates', 'channels', 'hooks'],
  tasks: ['restrictions'], // internal use — agent-imposed task constraints
  space_workflow_nodes: ['config'],
};

// ── Scope configurations ──────────────────────────────────────────────────────

/**
 * Tables visible in the **global** scope (no entity filter).
 * No WHERE clause injection — the agent can read all rows.
 */
const GLOBAL_SCOPE_TABLES: ScopeTableConfig[] = [
  {
    tableName: 'sessions',
    blacklistedColumns: COLUMN_BLACKLISTS.sessions,
    description:
      'Agent sessions with metadata such as title, status, workspace path, type, and timestamps.',
  },
  {
    tableName: 'rooms',
    blacklistedColumns: COLUMN_BLACKLISTS.rooms,
    description:
      'Room definitions with name, instructions, allowed paths, model config, and status.',
  },
  {
    tableName: 'spaces',
    blacklistedColumns: COLUMN_BLACKLISTS.spaces,
    description:
      'Space definitions for multi-agent environments with workspace path, slug, and config.',
  },
  {
    tableName: 'app_mcp_servers',
    blacklistedColumns: COLUMN_BLACKLISTS.app_mcp_servers,
    description:
      'Globally-configured MCP servers with connection details (command, args, URL, headers).',
  },
  {
    tableName: 'skills',
    blacklistedColumns: [],
    // Note: skills.config stores structured config (McpServerSkillConfig with appMcpServerId UUID,
    // PluginSkillConfig with local path) — no raw credentials. If credential-bearing config is
    // ever added to skill configs, it must be blacklisted here and in COLUMN_BLACKLISTS.
    description:
      'Available skills (plugins, MCP servers, built-ins) with config, enablement, and validation status.',
  },
  {
    tableName: 'inbox_items',
    blacklistedColumns: COLUMN_BLACKLISTS.inbox_items,
    description: 'Incoming GitHub events (issues, comments, PRs) routed through the inbox system.',
  },
  {
    tableName: 'job_queue',
    blacklistedColumns: COLUMN_BLACKLISTS.job_queue,
    description:
      'Background job queue entries with status, priority, retry tracking, and scheduling.',
  },
  {
    tableName: 'short_id_counters',
    blacklistedColumns: [],
    description: 'Auto-incrementing short-ID counters keyed by entity type and scope.',
  },
];

/**
 * Tables visible in the **room** scope (room agent).
 * Auto-injects `WHERE room_id = ?` (or indirect equivalent) on all queries.
 */
const ROOM_SCOPE_TABLES: ScopeTableConfig[] = [
  {
    tableName: 'tasks',
    scopeColumn: 'room_id',
    blacklistedColumns: COLUMN_BLACKLISTS.tasks,
    description:
      'Room tasks with title, status, priority, dependencies, PR tracking, and agent assignments.',
  },
  {
    tableName: 'goals',
    scopeColumn: 'room_id',
    blacklistedColumns: [],
    description:
      'Room missions/goals with mission type, autonomy level, schedule, structured metrics, and execution tracking.',
  },
  {
    tableName: 'mission_executions',
    scopeJoin: {
      localColumn: 'goal_id',
      joinTable: 'goals',
      joinPkColumn: 'id',
      scopeColumn: 'room_id',
    },
    blacklistedColumns: [],
    description:
      'Individual execution runs of recurring missions with status, task IDs, and planning attempts.',
  },
  {
    tableName: 'mission_metric_history',
    scopeJoin: {
      localColumn: 'goal_id',
      joinTable: 'goals',
      joinPkColumn: 'id',
      scopeColumn: 'room_id',
    },
    blacklistedColumns: [],
    description: 'Time-series snapshots of measurable mission metrics recorded over time.',
  },
  {
    tableName: 'room_github_mappings',
    scopeColumn: 'room_id',
    blacklistedColumns: [],
    description: 'GitHub repository mappings for rooms with priority ordering.',
  },
  {
    tableName: 'room_mcp_enablement',
    scopeColumn: 'room_id',
    blacklistedColumns: [],
    description: 'Per-room MCP server enablement overrides.',
  },
  {
    tableName: 'room_skill_overrides',
    scopeColumn: 'room_id',
    blacklistedColumns: [],
    description: 'Per-room skill enablement overrides.',
  },
];

/**
 * Tables visible in the **space** scope (space agent).
 * Auto-injects `WHERE space_id = ?` (or indirect equivalent) on all queries.
 */
const SPACE_SCOPE_TABLES: ScopeTableConfig[] = [
  {
    tableName: 'space_agents',
    scopeColumn: 'space_id',
    blacklistedColumns: COLUMN_BLACKLISTS.space_agents,
    description: 'Space agent definitions with name, model, tools, provider, and instructions.',
  },
  {
    tableName: 'space_workflows',
    scopeColumn: 'space_id',
    blacklistedColumns: COLUMN_BLACKLISTS.space_workflows,
    description:
      'Space workflow definitions with graph layout, channel routing, and gate configurations.',
  },
  {
    tableName: 'space_workflow_nodes',
    scopeJoin: {
      localColumn: 'workflow_id',
      joinTable: 'space_workflows',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: COLUMN_BLACKLISTS.space_workflow_nodes,
    description:
      'Individual nodes/steps within a space workflow with name, description, and config.',
  },
  {
    tableName: 'space_workflow_runs',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description: 'Executions of space workflows with status, timestamps, and failure tracking.',
  },
  {
    tableName: 'space_tasks',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Tasks within a space with numbering, status, PR tracking, and workflow run associations.',
  },
  {
    tableName: 'space_goals',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Space-native long-horizon goals with rolling state, progress, and recurring check-in schedules.',
  },
  {
    tableName: 'space_goal_events',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Append-only history events for Space goals, including state diffs, source metadata, and linked task IDs.',
  },
  {
    tableName: 'space_worktrees',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description: 'Git worktree mappings for space tasks with slug and path tracking.',
  },
  {
    tableName: 'space_workspaces',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Workspace repository registrations for a space with path, display label, and primary flag.',
  },
  {
    tableName: 'workflow_hook_state',
    scopeJoin: {
      localColumn: 'run_id',
      joinTable: 'space_workflow_runs',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: ['local_state', 'last_result', 'vote_maps'],
    description: 'Per-run workflow hook state with CAS versioning, retry metadata, and vote maps.',
  },
  {
    tableName: 'workflow_hook_result_artifacts',
    scopeJoin: {
      localColumn: 'run_id',
      joinTable: 'space_workflow_runs',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: ['result'],
    description: 'Append-only workflow hook result history for audit and debugging.',
  },
  {
    tableName: 'channel_cycles',
    scopeJoin: {
      localColumn: 'run_id',
      joinTable: 'space_workflow_runs',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description: 'Cycle counters for workflow channels to prevent infinite loop execution.',
  },
  {
    tableName: 'channel_cycle_events',
    scopeJoin: {
      localColumn: 'run_id',
      joinTable: 'space_workflow_runs',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description: 'Timestamped cyclic-channel traversal events for rate-based dead-loop detection.',
  },
  {
    tableName: 'workflow_run_artifacts',
    scopeJoin: {
      localColumn: 'run_id',
      joinTable: 'space_workflow_runs',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description:
      'Typed artifacts produced by workflow node agents (PRs, commit sets, test results, deployments).',
  },
  {
    tableName: 'workflow_run_artifact_cache',
    scopeJoin: {
      localColumn: 'run_id',
      joinTable: 'space_workflow_runs',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description:
      'JSON-serialised cache of git-derived artifact data (gate diffs, commit log, per-file diffs) populated by background sync jobs and served to the TaskArtifactsPanel.',
  },
  {
    tableName: 'mcp_audit_log',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Audit trail of MCP write operations (create_task, approve_task, send_message, save_artifact) with agent name, session ID, tool name, and parameters.',
  },
  {
    tableName: 'task_schedules',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Recurring (cron) and one-shot (at) task schedule templates with trigger config, status, and last-run tracking.',
  },
  {
    tableName: 'space_agent_memory',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Persistent agent-written Space memories with keys, content, tags, and access metadata.',
  },
  {
    tableName: 'space_agent_core_memory',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Space-scoped core memory ranking table populated by background consolidation jobs.',
  },
  {
    tableName: 'evolution_scopes',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Forge evolution scopes that define bounded learning loops for a Space or Space goal.',
  },
  {
    tableName: 'evolution_evidence',
    scopeJoin: {
      localColumn: 'scope_id',
      joinTable: 'evolution_scopes',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description:
      'Evidence references collected for Forge evolution scopes, such as tasks, runs, sessions, notes, and metric snapshots.',
  },
  {
    tableName: 'evolution_episodes',
    scopeJoin: {
      localColumn: 'scope_id',
      joinTable: 'evolution_scopes',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description:
      'Forge learning episodes that summarize evidence, findings, and outcomes for a scope.',
  },
  {
    tableName: 'evolution_lessons',
    scopeJoin: {
      localColumn: 'scope_id',
      joinTable: 'evolution_scopes',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description:
      'Candidate and active Forge lessons derived from evolution episodes for future scoped work.',
  },
  {
    tableName: 'evolution_task_proposals',
    scopeJoin: {
      localColumn: 'scope_id',
      joinTable: 'evolution_scopes',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description:
      'Follow-up Space task proposals produced from Forge evolution findings and lessons.',
  },
  {
    tableName: 'evolution_metric_snapshots',
    scopeJoin: {
      localColumn: 'scope_id',
      joinTable: 'evolution_scopes',
      joinPkColumn: 'id',
      scopeColumn: 'space_id',
    },
    blacklistedColumns: [],
    description: 'Metric snapshots captured for Forge evolution scopes over time.',
  },
  {
    tableName: 'goal_automation_cursors',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Forge automation cursor state for deduplicating goal-triggered retrospectives and external event runs.',
  },
  // ── Main-DB tables exposed with space-scoped filtering via session ID prefix ──
  {
    tableName: 'sessions',
    scopeLike: { column: 'id', patternPrefix: 'space:', patternSuffix: ':%' },
    blacklistedColumns: COLUMN_BLACKLISTS.sessions,
    description:
      'Agent sessions belonging to this space — task agents, node agents, and sub-sessions. Filtered by session ID prefix (space:<space_id>:*). Includes status, type, workspace path, and timestamps.',
  },
  {
    tableName: 'sdk_messages',
    scopeLike: { column: 'session_id', patternPrefix: 'space:', patternSuffix: ':%' },
    blacklistedColumns: [],
    description:
      'SDK conversation messages for sessions belonging to this space. Filtered by session_id prefix (space:<space_id>:*). Includes message type, subtype, content, timestamp, and send status.',
  },
  {
    tableName: 'session_groups',
    scopeJoin: {
      localColumn: 'id',
      joinTable: 'session_group_members',
      joinPkColumn: 'group_id',
      scopeColumn: 'session_id',
      likePrefix: 'space:',
      likeSuffix: ':%',
    },
    blacklistedColumns: [],
    description:
      'Session groups (multi-agent collaborations) whose members include sessions belonging to this space. Scoped via session_group_members.session_id prefix.',
  },
  {
    tableName: 'session_group_members',
    scopeLike: { column: 'session_id', patternPrefix: 'space:', patternSuffix: ':%' },
    blacklistedColumns: [],
    description:
      'Session group memberships for sessions belonging to this space. Filtered by session_id prefix (space:<space_id>:*).',
  },
];

/**
 * Tables that are intentionally excluded from ALL scopes.
 * These include sensitive config tables and internal infrastructure.
 *
 * Note: `sdk_messages`, `session_groups`, and `session_group_members` are now
 * accessible in the **space** scope (with session ID prefix filtering) and are
 * therefore NOT in this list. They remain inaccessible in global and room scopes.
 */
const EXCLUDED_TABLE_NAMES: string[] = [
  // Sensitive configuration (contains auth tokens, API keys)
  'auth_config',
  'global_tools_config',
  'global_settings',
  // Provider registry and credential store — admin tables, not queryable by agents
  'providers',
  'provider_credentials',
  // session_groups, session_group_members, and sdk_messages are now in SPACE_SCOPE_TABLES.
  // task_group_events remains excluded — internal event log, not useful for ad-hoc queries.
  'task_group_events',
  // Space GitHub tables are internal webhook/polling state and can include raw PR/comment payloads
  // plus webhook secret metadata; use Space task activity surfaces instead of ad-hoc DB queries.
  'space_github_events',
  'space_github_watched_repos',
  // Node execution tracking — transient per-run agent state, not useful for ad-hoc queries
  'node_executions',
  // Tool continuation recovery — internal bridge/runtime recovery state for orphaned tool_result chunks
  'tool_continuation_recovery',
  'tool_continuation_inbox',
  // Pending agent messages — internal queue-until-active infrastructure for Task Agent
  // send_message delivery; flushed by TaskAgentManager when target sessions activate.
  'pending_agent_messages',
  // Internal relational projection of replacement metadata embedded in sdk_messages.
  'sdk_message_replacements',
  // Long-term agent inbox — internal queue-until-active infrastructure for Space agents.
  'space_agent_inbox_messages',
  // Dynamically created tables (managed by FilterConfigManager, not part of static schema)
  'github_filter_configs',
  // Workspace history — user-level path bookmarks, not useful for agent queries
  'workspace_history',
  // MCP enablement overrides — infrastructure config spanning multiple scopes
  // (space/room/session), not useful for ad-hoc agent queries. Agents should
  // read MCP state through the resolver rather than hitting the table directly.
  'mcp_enablement',
  // Message search FTS projection and FTS5 shadow tables — queried through message.search RPC.
  'message_search_content',
  'message_search_fts',
  'message_search_fts_config',
  'message_search_fts_content',
  'message_search_fts_data',
  'message_search_fts_docsize',
  'message_search_fts_idx',
  // External Event Bus — internal event routing/delivery/config state, not useful for ad-hoc agent queries.
  'external_event_source_configs',
  'external_event_extension_configs',
  'space_external_event_source_configs',
  'space_external_events',
  'space_external_event_deliveries',
  // Durable delivery-turn completion markers — internal message-delivery v2
  // re-claim state (delivery_turn_end), not useful for ad-hoc agent queries.
  'delivery_turn_end',
  // Monotonic consumption-watermark counter — internal message-delivery v2
  // sequence state (delivery_consumed_seq), not useful for ad-hoc agent queries.
  'delivery_consumed_seq',
  // Agent memory search index/vector storage — query through space_agent_memory instead.
  'memory_vectors',
  'space_agent_memory_fts',
  'space_agent_memory_fts_config',
  'space_agent_memory_fts_data',
  'space_agent_memory_fts_docsize',
  'space_agent_memory_fts_idx',
  // Migration bookkeeping — internal one-time migration markers.
  'migration_markers',
  // Dropped tables (no longer exist in schema)
  'space_session_groups',
  'space_session_group_members',
  'space_workflow_transitions',
  // Immutable append-only workflow-definition version history (RFC §4 Phase 1) — internal
  // audit/pinning substrate, not useful for ad-hoc agent queries.
  'space_workflow_definition_versions',
  // Legacy dropped tables
  'messages',
  'tool_calls',
  // Long-horizon Space agent persistence — internal goal/scope/reminder/subscription state
  'space_long_horizon_agents',
  'space_long_horizon_agent_goals',
  'space_long_horizon_agent_forge_scopes',
  'space_long_horizon_agent_reminders',
  'space_long_horizon_agent_event_subscriptions',
  // Workflow-run event subscription routing — internal pub/sub trie source of
  // truth, not useful for ad-hoc agent queries.
  'space_workflow_event_subscriptions',
  // Space agent management tables — agent goal/scope assignments and reminders;
  // internal MCP tool state, not useful for ad-hoc agent queries.
  'space_agent_goal_assignments',
  'space_agent_forge_scope_assignments',
  'space_agent_reminders',
];

// ── Scope config registry ─────────────────────────────────────────────────────

const SCOPE_CONFIGS: Record<DbScopeType, ScopeTableConfig[]> = {
  global: GLOBAL_SCOPE_TABLES,
  room: ROOM_SCOPE_TABLES,
  space: SPACE_SCOPE_TABLES,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the full table configurations for a given scope type.
 */
export function getScopeConfig(scopeType: DbScopeType): ScopeTableConfig[] {
  return SCOPE_CONFIGS[scopeType];
}

/**
 * Resolves the scope type and value from a session context.
 *
 * - roomId present → room scope
 * - spaceId present (no roomId) → space scope
 * - Neither → global scope
 */
export function getScopeForSession(context: SessionContext): ResolvedScope {
  if (context.roomId) {
    return { scopeType: 'room', scopeValue: context.roomId };
  }
  if (context.spaceId) {
    return { scopeType: 'space', scopeValue: context.spaceId };
  }
  return { scopeType: 'global', scopeValue: '' };
}

/**
 * Returns the list of table names accessible within a given scope.
 */
export function getAccessibleTableNames(scopeType: DbScopeType): string[] {
  return SCOPE_CONFIGS[scopeType].map((cfg) => cfg.tableName);
}

/**
 * Returns column blacklists for a given table.
 * Blacklists are global per-table (not scope-dependent).
 * Returns an empty array for tables with no blacklisted columns.
 */
export function getBlacklistedColumns(tableName: string): string[] {
  return COLUMN_BLACKLISTS[tableName] ?? [];
}

/**
 * Returns the list of tables that are excluded from all scopes.
 * Used for schema evolution validation to ensure sensitive/infrastructure
 * tables are never accidentally exposed.
 */
export function getExcludedTableNames(): string[] {
  return [...EXCLUDED_TABLE_NAMES];
}

/**
 * Builds a parameterized WHERE clause for a scoped table configuration.
 *
 * Direct scope:       `room_id = ?`  (one param)
 * LIKE direct scope:  `id LIKE ?`    (one param — pattern is prefix+scopeValue+suffix)
 * Indirect scope:     `goal_id IN (SELECT id FROM goals WHERE room_id = ?)`  (one param)
 * LIKE indirect scope:`id IN (SELECT group_id FROM members WHERE session_id LIKE ?)`
 * Global scope:       returns empty clause (no filtering)
 */
export function buildScopeFilter(
  tableConfig: ScopeTableConfig,
  scopeValue: string
): ScopeFilterResult {
  // Global tables have no scope column, join, or like — no filter needed
  if (!tableConfig.scopeColumn && !tableConfig.scopeJoin && !tableConfig.scopeLike) {
    return { whereClause: '', params: [] };
  }

  // Direct scope filter
  if (tableConfig.scopeColumn) {
    return {
      whereClause: `${tableConfig.scopeColumn} = ?`,
      params: [scopeValue],
    };
  }

  // LIKE-based direct scope filter (e.g., session ID prefix matching)
  if (tableConfig.scopeLike) {
    const { column, patternPrefix, patternSuffix } = tableConfig.scopeLike;
    return {
      whereClause: `${column} LIKE ?`,
      params: [`${patternPrefix}${scopeValue}${patternSuffix}`],
    };
  }

  // Indirect scope filter via join table
  if (tableConfig.scopeJoin) {
    const join = tableConfig.scopeJoin;
    if (join.likePrefix !== undefined) {
      // LIKE-based join: e.g., session_groups scoped via session_group_members.session_id
      return {
        whereClause: `${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} LIKE ?)`,
        params: [`${join.likePrefix}${scopeValue}${join.likeSuffix ?? ''}`],
      };
    }
    return {
      whereClause: `${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} = ?)`,
      params: [scopeValue],
    };
  }

  return { whereClause: '', params: [] };
}
