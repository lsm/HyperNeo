export type DbScopeType = 'global' | 'room' | 'space';

export interface ScopeJoinConfig {
  localColumn: string;
  joinTable: string;
  joinPkColumn: string;
  scopeColumn: string;
  likePrefix?: string;
  likeSuffix?: string;
}

export interface ScopeLikeConfig {
  column: string;
  patternPrefix: string;
  patternSuffix: string;
}

export interface ScopeTableConfig {
  tableName: string;
  scopeColumn?: string;
  scopeJoin?: ScopeJoinConfig;
  scopeLike?: ScopeLikeConfig;
  blacklistedColumns: string[];
  description: string;
}

const COLUMN_BLACKLISTS: Record<string, string[]> = {
  sessions: ['config', 'session_context'],
  rooms: ['config'],
  spaces: ['config'],
  app_mcp_servers: ['env'],
  inbox_items: ['raw_event', 'security_check'],
  job_queue: ['payload'],
  space_long_horizon_agents: ['session_id'],
  space_workflows: ['config', 'gates', 'channels', 'hooks'],
  tasks: ['restrictions'],
  space_workflow_nodes: ['config'],
};

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

const SPACE_SCOPE_TABLES: ScopeTableConfig[] = [
  {
    tableName: 'space_long_horizon_agents',
    scopeColumn: 'space_id',
    blacklistedColumns: COLUMN_BLACKLISTS.space_long_horizon_agents,
    description: 'Space agent definitions with name, model, tools, provider, and instructions.',
  },
  {
    tableName: 'space_agent_templates',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Agent templates this space owns — the prefilled creation form for its agents, with handle, instructions, model, tools, and labels. Built-in templates live in code and are not rows here.',
  },
  {
    tableName: 'space_agent_template_hides',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Built-in agent template keys this space has hidden from its template library. Restore removes the row.',
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
    tableName: 'space_goal_outcome_notifications',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Per-terminal-generation outcome notifications for Space goals, with pending/superseded/acknowledged/rejected status and bounded payloads.',
  },
  {
    tableName: 'space_agent_inactivity_config',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Per-agent inactivity watchdog configuration with enablement, threshold, prompt, and revision.',
  },
  {
    tableName: 'space_agent_inactivity_claims',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Per-agent inactivity nag window claims with attempt generation, owner token, revision binding, and degraded state.',
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
    description: 'Workspace paths for a space, with a single primary workspace.',
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
    description: 'Evolution scopes that define bounded learning loops for a Space or Space goal.',
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
      'Evidence references collected for Evolution scopes, such as tasks, runs, sessions, notes, and metric snapshots.',
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
      'Evolution learning episodes that summarize evidence, findings, and outcomes for a scope.',
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
      'Candidate and active Evolution lessons derived from evolution episodes for future scoped work.',
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
    description: 'Follow-up Space task proposals produced from evolution findings and lessons.',
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
    description: 'Metric snapshots captured for Evolution scopes over time.',
  },
  {
    tableName: 'goal_automation_cursors',
    scopeColumn: 'space_id',
    blacklistedColumns: [],
    description:
      'Evolution automation cursor state for deduplicating goal-triggered retrospectives and external event runs.',
  },
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

const SCOPE_CONFIGS: Record<DbScopeType, ScopeTableConfig[]> = {
  global: GLOBAL_SCOPE_TABLES,
  room: ROOM_SCOPE_TABLES,
  space: SPACE_SCOPE_TABLES,
};

export function getScopeConfig(scopeType: DbScopeType): ScopeTableConfig[] {
  return SCOPE_CONFIGS[scopeType];
}
