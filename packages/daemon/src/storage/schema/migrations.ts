/**
 * Database Migrations
 *
 * Migrations 1–13 handle incremental schema changes to core tables.
 * runMigrationRoomCleanup consolidates former migrations 25–36 (room feature
 * experiments that never shipped to production) into a single drop-and-recreate
 * cleanup. Migration 29 is the single consolidated migration for all Space system
 * tables — do not add separate Space migrations after it. CRITICAL: Preserve the
 * order of migrations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { runMigration94 as runMigration94External } from './m94-backfill-workflow-templates';
import { runMigration106 as runMigration106External } from './m106-backfill-agent-templates';
import { slugify, validateSlug } from '../../lib/space/slug';

/**
 * Run all database migrations
 *
 * @param db - The database instance
 * @param createBackup - Function to call before running migrations (creates backup)
 */
export function runMigrations(db: BunDatabase, createBackup: () => void): void {
	// Create backup before running any migrations
	// This ensures we can recover if a migration causes data loss
	createBackup();

	// Migration 1: Add oauth_token_encrypted column if it doesn't exist
	runMigration1(db);

	// Migration 2: Remove messages and tool_calls tables (replaced by sdk_messages)
	runMigration2(db);

	// Migration 3: Add worktree columns to sessions table
	runMigration3(db);

	// Migration 4: Add git_branch column for non-worktree git sessions
	runMigration4(db);

	// Migration 5: Add sdk_session_id column for session resumption
	runMigration5(db);

	// Migration 6: Add available_commands column for slash commands persistence
	runMigration6(db);

	// Migration 7: Add processing_state column for agent state persistence
	runMigration7(db);

	// Migration 8: Add archived_at column for archive session feature
	runMigration8(db);

	// Migration 9: Update CHECK constraint to include 'archived' status
	runMigration9(db);

	// Migration 10: Add send_status column to sdk_messages for query mode support
	runMigration10(db);

	// Migration 11: Add sub-session columns for parent-child session relationships
	runMigration11(db);

	// Migration 12: Ensure global_settings has autoScroll: true for existing databases
	runMigration12(db);

	// Migration 13: Update CHECK constraint to include 'pending_worktree_choice' status
	runMigration13(db);

	// Room cleanup: drop all room experiment tables and fix sessions schema if outdated
	// (consolidates former migrations 25–36, which covered features never shipped to production)
	runMigrationRoomCleanup(db);

	// Migration 14: Drop events table and unused session columns (labels, sub_session_order)
	runMigration14(db);

	// Migration 15: Add 'failed' to send_status CHECK constraint in sdk_messages
	runMigration15(db);

	// Migration 16: Replace 'escalated' with 'review' in tasks, remove 'hibernated' from session_groups,
	// add config column to rooms table
	runMigration16(db);

	// Migration 17: Fix goals table CHECK constraint and add goal_review_attempts column
	runMigration17(db);

	// Migration 18: Add 'cancelled' to tasks status CHECK constraint
	runMigration18(db);

	// Migration 19: Remove legacy mirrored session_group_messages table
	runMigration19(db);

	// Migration 20: Add archived_at column to tasks table
	runMigration20(db);

	// Migration 21: Backfill submittedForReview metadata for active awaiting_human groups
	runMigration21(db);

	// Migration 22: Drop legacy session_groups.state column and index
	runMigration22(db);

	// Migration 23: Add active_session column to tasks table
	runMigration23(db);

	// Migration 24: Rename 'failed' task status to 'needs_attention' for better semantic clarity
	runMigration24(db);

	// Migration 25: Add PR fields to tasks table
	runMigration25(db);

	// Migration 26: Add input_draft column to tasks table for server-side draft persistence
	runMigration26(db);

	// Migration 27: Add updated_at column to tasks table for sorting by most recently updated
	runMigration27(db);

	// Migration 28: Add mission metadata columns to goals table, create mission_metric_history
	// and mission_executions tables for Goal V2 / Mission System
	runMigration28(db);

	// Migration 29: Create all Space system tables (fully consolidated schema).
	// All space tables and columns — including role, provider, inject_workflow_context,
	// start_step_id, current_step_id, and space_workflow_transitions — are created here
	// in a single idempotent migration. (Note: M45 renames step→node columns/tables.)
	runMigration29(db);

	// Migration 30: Add layout column to space_workflows for visual editor node positions.
	runMigration30(db);

	// Migration 31: Add 'space_task_agent' to sessions type CHECK constraint.
	runMigration31(db);

	// Migration 32: Add task_agent_session_id column to space_tasks.
	runMigration32(db);

	// Migration 33: Add autonomy_level column to spaces table.
	runMigration33(db);

	// Migration 34: Add goal_id column to space_tasks for goal/mission association.
	runMigration34(db);

	// Migration 35: Add iteration tracking columns to space_workflow_runs.
	runMigration35(db);

	// Migration 36: Add max_iterations column to space_workflows.
	runMigration36(db);

	// Migration 37: Add goal_id column to space_workflow_runs for goal/mission association.
	runMigration37(db);

	// Migration 38: Add is_cyclic column to space_workflow_transitions.
	runMigration38(db);

	// Migration 39: Add 'archived' to status CHECK constraints on tasks and space_tasks.
	runMigration39(db);

	// Migration 40: Flexible session groups — add task_id + status to space_session_groups,
	// drop role CHECK constraint and add agent_id + status to space_session_group_members.
	runMigration40(db);

	// Migration 41: Historical no-op. Kept for migration-number continuity.
	runMigration41(db);

	// Migration 42: Clean up stale/zombie session groups and add partial unique index
	// on session_groups(ref_id) WHERE completed_at IS NULL to prevent future duplicates.
	runMigration42(db);

	// Migration 43: Drop legacy session_group_messages projection table.
	runMigration43(db);

	// Migration 44: Rename sdk_messages send_status values to deferred/enqueued/consumed.
	runMigration44(db);

	// Migration 45: Rename step-related columns and tables to node
	// - space_workflow_steps -> space_workflow_nodes
	// - start_step_id -> start_node_id in space_workflows
	// - from_step_id -> from_node_id, to_step_id -> to_node_id in space_workflow_transitions
	// - workflow_step_id -> workflow_node_id in space_tasks
	// - current_step_id -> current_node_id in space_workflow_runs
	// - current_step_id -> current_node_id in space_session_groups
	runMigration45(db);

	// Migration 46: Add slot_role column to space_tasks
	// Stores the WorkflowNodeAgent.role of the slot that spawned a task, enabling
	// unambiguous slot lookup when the same agentId appears multiple times in a node.
	runMigration46(db);

	// Migration 47: Add short_id columns to tasks and goals, create short_id_counters table.
	// Enables human-readable scoped short IDs for tasks and goals (e.g. t:04062505:42).
	// New columns are nullable — existing rows get NULL until short IDs are assigned.
	runMigration47(db);

	// Migration 48: Replace global short_id unique indexes with room-scoped composite indexes.
	// Migration 47 accidentally created single-column global indexes (unique across ALL rooms),
	// causing UNIQUE constraint failures when two different rooms each create their first task.
	// Short IDs are scoped to their parent room, so uniqueness must be (room_id, short_id).
	runMigration48(db);

	// Migration 49: Add restrictions column to tasks and expand status CHECK constraint
	// to include 'rate_limited' and 'usage_limited'. These new statuses let the runtime
	// surface API limit state in the UI and enable auto-resume on tick.
	runMigration49(db);

	// Migration 50: Create app_mcp_servers table for application-level MCP server registry.
	// This table stores MCP server configurations that are available globally.
	// Idempotent via CREATE TABLE IF NOT EXISTS.
	runMigration50(db);

	// Migration 51: Rename space_tasks.slot_role -> agent_name and add completion_summary column.
	// Part of the agent-centric refactor: "slot role" is replaced by a plain "agent name" that
	// directly identifies the agent. completion_summary stores a brief human-readable summary
	// written by the agent when a task reaches a terminal state.
	runMigration51(db);

	// Migration 52: Create room_mcp_enablement table for per-room MCP enablement overrides.
	runMigration52(db);

	// Migration 53: Add channels column to space_workflows for unified channel topology storage.
	// Channels move from the config JSON blob to a dedicated TEXT column (JSON-serialized
	// WorkflowChannel[]). Existing rows that have channels embedded in config are migrated
	// in-place so no data is lost.
	runMigration53(db);

	// Migration 54: Add unique partial index on space_tasks (workflow_run_id, workflow_node_id,
	// agent_name) to enforce at-most-one task per agent slot per workflow node per run.
	// Prevents duplicate tasks from concurrent ChannelRouter.activateNode() calls.
	runMigration54(db);

	// Migration 55: Rename slot_role → agent_name on space_tasks.
	// Aligns with "no role" naming convention from the agent-centric refactor.
	// Uses a table rebuild pattern (SQLite does not support DROP COLUMN in all versions).
	// Idempotent: checks for agent_name column before rebuilding.
	runMigration55(db);

	// Migration 56: Expand assigned_agent CHECK constraint to include 'planner'.
	// SQLite cannot ALTER a CHECK constraint directly, so we recreate the table.
	runMigration56(db);

	// Migration 57: Create skills table for application-level Skills registry.
	// Idempotent via CREATE TABLE IF NOT EXISTS.
	runMigration57(db);

	// Migration 58: Create room_skill_overrides table for per-room skill enablement.
	// Mirrors the room_mcp_enablement pattern (migration 52) but references skills(id).
	// Idempotent via CREATE TABLE IF NOT EXISTS.
	runMigration58(db);

	// Migration 59: Drop space_workflow_transitions table (replaced by channels).
	// Idempotent via DROP TABLE IF EXISTS.
	runMigration59(db);

	// Migration 60: Drop space_session_groups and space_session_group_members tables,
	// and drop current_node_id column from space_workflow_runs.
	// Session groups are replaced by direct space_tasks queries.
	// currentNodeId is replaced by the agent-centric model where tasks track state.
	runMigration60(db);

	// Migration 61: Add gate_data table, gates column to space_workflows,
	// and failure_reason column to space_workflow_runs.
	// Part of M1.1 — separated Channel + Gate types.
	runMigration61(db);

	// Migration 62: Add task_number column to space_tasks for human-friendly numeric IDs.
	// Scoped per space via UNIQUE(space_id, task_number). Backfills existing rows.
	runMigration62(db);

	// Migration 63: Add slug column to spaces table for human-readable URL identifiers.
	// Auto-generates slugs from existing space names and adds a UNIQUE index.
	runMigration63(db);

	// Migration 64: Create space_worktrees table for persisting task ↔ git worktree mappings.
	// One row per task; keyed by (space_id, task_id) with a per-space unique slug constraint.
	runMigration64(db);

	// Migration 65: Add completed_at column to space_worktrees for TTL-based reaper.
	// Worktrees are not removed on task completion; instead they are timestamped and
	// removed by the reaper after a configurable TTL (default: 7 days).
	runMigration65(db);

	// Migration 66: Add 'neo' to sessions type CHECK constraint and create neo_activity_log table.
	// Neo is a global AI agent with its own session type and activity log for auditing.
	runMigration66(db);

	// Migration 67: Add 'space_chat' to sessions type CHECK constraint.
	runMigration67(db);
	// Migration 68: Add 'origin' column to sdk_messages for frontend display of message provenance.
	// NULL (default) is treated as 'human' by the frontend. 'neo' marks Neo-injected messages.
	runMigration68(db);
	// Migration 69: Per-channel cycle tracking table.
	// Replaces the global iteration_count/max_iterations on space_workflow_runs.
	runMigration69(db);
	// Migration 70: Backfill default_path for existing rooms where it is NULL.
	// Sets default_path from allowed_paths[0].path, or '__NEEDS_WORKSPACE_PATH__' sentinel
	// when allowed_paths is also empty. Sentinel is replaced at startup with config.workspaceRoot.
	runMigration70(db);
	// Migration 71: Fix corrupted schedule values in goals table.
	// Some rows may contain raw cron strings (e.g. "@daily") instead of the expected
	// JSON object {"expression":"@daily","timezone":"UTC"}. This wraps bare strings
	// into the proper CronSchedule shape.
	runMigration71(db);
	// Migration 72: Add missing performance indexes for rooms, sessions, and goals tables.
	// - rooms: index on (status, updated_at) for room.list ORDER BY updated_at DESC WHERE status='active'
	// - sessions: index on (type) for listSessionsByType, findByRoomId
	// - sessions: index on (status, last_active_at) for listSessions ORDER BY last_active_at DESC
	runMigration72(db);
	// Migration 73: Update space_tasks and space_workflow_runs to use the new status schema.
	//   - space_tasks: new status values ('open'|'in_progress'|'done'|'blocked'|'cancelled'|'archived'),
	//     adds 'labels' column, removes deprecated columns.
	//   - space_workflow_runs: new status values ('pending'|'in_progress'|'done'|'blocked'|'cancelled'),
	//     adds 'started_at', removes deprecated columns.
	//   - Maps old → new status values in existing rows.
	runMigration73(db);

	// Migration 74: Remaining schema cleanup for end-node / workflow completion work.
	//   - node_executions: new table for per-node execution tracking
	//   - space_workflows: drop config (migrate tags out) and max_iterations
	//   - space_workflow_nodes: drop order_index and agent_id
	//   - space_agents: drop role, config, inject_workflow_context
	//   - node config JSON: wrap string systemPrompt/instructions to {mode, value}
	runMigration74(db);

	// Migration 75: Add UNIQUE constraint on node_executions for idempotent activation.
	//   - Adds UNIQUE INDEX on (workflow_run_id, workflow_node_id, agent_name)
	//   - Deduplicates any existing records before creating the index
	runMigration75(db);

	// Migration 76: Add 'review' status to space_tasks CHECK constraint.
	//   - In supervised mode, completed workflow tasks land in 'review' for human approval.
	runMigration76(db);

	// Migration 77: Make sessions.workspace_path nullable for unbound sessions.
	runMigration77(db);

	// Migration 78: Create workspace_history table for persisting recently-used workspace paths.
	runMigration78(db);

	// Migration 79: Update node_executions for the new agent model.
	//   - Add 'idle' status (replaces 'done') to the CHECK constraint.
	//   - Add 'data TEXT' column for structured agent output.
	runMigration79(db);

	// Migration 80: Consolidate space_agents.system_prompt + instructions → custom_prompt.
	//   - Adds 'custom_prompt TEXT' column.
	//   - Migrates data: combines system_prompt and instructions into a single field.
	runMigration80(db);

	// Migration 81: Add preferred_workflow_id to space_tasks.
	//   - Stores the caller-specified workflow template ID for standalone task attachment.
	//   - When set, the runtime uses this workflow instead of heuristic auto-selection.
	runMigration81(db);

	// Migration 82: Add approval audit trail columns to space_tasks.
	//   - approval_source: who approved (human, neo_agent, space_agent, task_agent, node_agent, semi_auto)
	//   - approval_reason: optional comment/reason for the approval
	//   - approved_at: timestamp when approval occurred
	runMigration82(db);

	// Migration 83: Add block_reason column to space_tasks.
	//   Records *why* a task is blocked (agent_crashed, workflow_invalid, etc.).
	runMigration83(db);

	// Migration 84: Workflow Run Artifacts.
	//   - Creates workflow_run_artifacts table for typed node outputs (PRs, commits, etc.).
	//   - Drops pr_url, pr_number, pr_created_at from space_tasks (replaced by artifacts).
	runMigration84(db);

	// Migration 85: Add paused column to spaces.
	//   Allows users to pause/resume space runtime execution without archiving.
	runMigration85(db);

	// Migration 86: 5-level numeric autonomy.
	//   - Converts spaces.autonomy_level from TEXT to INTEGER (1–5).
	//   - Adds pending_action_index and pending_checkpoint_type to space_tasks.
	//   - Migrates approval_source values to simplified 3-value type.
	runMigration86(db);

	// Migration 87: Add stopped column to spaces.
	//   Allows users to stop/start space runtime execution without archiving.
	//   Stopped spaces have all active work killed and will not auto-start on daemon restart.
	runMigration87(db);

	// Migration 88: Decouple `report_result` from canonical task status.
	//   Adds `reported_status` and `reported_summary` columns to space_tasks
	//   so the agent's report intent is recorded separately from the runtime's
	//   final status decision (which goes through completion-actions review).
	runMigration88(db);

	// Migration 89: Drop reserved writer keywords from persisted gates.
	//   Existing space_workflows.gates rows may contain `writers: ['human']`
	//   or `writers: ['reviewer']` from before the structural-semantics switch.
	//   Rewrite those `approved` fields to `writers: []` so external-approval
	//   gates keep working under the new authorization rules.
	runMigration89(db);

	// Migration 90: Add template_name and template_hash to space_workflows for drift detection.
	runMigration90(db);

	// Migration 91: Add instructions column to space_workflows.
	//   Stores workflow-level instructions injected into every agent session.
	runMigration91(db);

	// Migration 92: Persistent queue for Task Agent → node agent / Space Agent
	//   messages. Enables queue-until-active delivery when a target session is
	//   declared in the workflow but not yet active (e.g. reopen races, daemon
	//   restarts, lazy node activation). The flush-on-activate hook in
	//   TaskAgentManager drains pending rows when a sub-session comes online.
	runMigration92(db);

	// Migration 93: Add sdk_origin_path column to sessions for cross-workspace/worktree resume.
	//   Stores the resolved CWD used when the SDK session was first created, so that
	//   the session file can be found even when the effective CWD changes between daemon
	//   restarts (e.g. when a worktree is added/removed after the session was started).
	runMigration93(db);

	// Migration 94: Backfill workflow template tracking and end-node completion actions
	//   for workflows seeded by earlier code paths that silently dropped these fields.
	//   Also removes orphan duplicate built-in workflow rows that have no active runs.
	runMigration94(db);

	// Migration 95: Add completion_actions_fired_at column to space_workflow_runs.
	//   Used as an idempotency marker so completion actions are not re-fired when
	//   a workflow run is reopened (done → in_progress) and later completes again.
	runMigration95(db);

	// Migration 96: Remove the legacy "Full-Cycle Coding Workflow" built-in template
	//   now that it has been replaced by the Plan & Decompose workflow.
	//   Only deletes rows with no active workflow runs so in-flight work is preserved.
	runMigration96(db);

	// Migration 97: Delete orphan built-in workflow rows — rows whose `name` matches
	//   a known built-in template but whose `template_name` column is NULL. These are
	//   pre-template-tracking duplicates left over when a later seed created a fresh
	//   row alongside the orphan. Any runs referencing an orphan workflow are deleted
	//   first (M60 rebuilt space_workflow_runs without an ON DELETE CASCADE FK, so
	//   the migration handles the cleanup explicitly).
	runMigration97(db);

	// Migration 98: Create workflow_run_artifact_cache table for background-job-backed
	//   caching of git-derived artifact data (gate artifacts, commits, per-file diffs).
	//   Opening the TaskArtifactsPanel used to run three git subprocesses inline per RPC
	//   call; those are now enqueued to the job queue and the cached result is served
	//   synchronously from this table on subsequent opens.
	runMigration98(db);

	// Migration 99: Tool-contract refactor for Task #39 — adds the
	//   `space_workflows.completion_autonomy_level` column, three pending-completion
	//   columns on `space_tasks`, and the `space_task_report_results` append-only
	//   audit table used by the new `report_result` tool.
	runMigration99(db);

	// Migration 100: MCP registry provenance — adds `source` and `source_path`
	//   columns to `app_mcp_servers`. Backfills existing rows as 'builtin' (for
	//   seeded names) or 'user' (everything else). Adds a partial unique index
	//   on `(source_path, name)` WHERE source='imported' so the M2 import service
	//   can upsert idempotently from `.mcp.json` scans.
	runMigration100(db);

	// Migration 101: MCP M3 — create the unified `mcp_enablement` table used as
	//   the single source of truth for per-scope (space/room/session) MCP server
	//   overrides, and seed it from the legacy `room_mcp_enablement` table plus
	//   existing `GlobalSettings.disabledMcpServers` and per-session
	//   `config.tools.disabledMcpServers`. Legacy columns/table are left intact
	//   for this milestone — M5 removes them.
	runMigration101(db);

	// Migration 102: MCP M5 of `unify-mcp-config-model` — purge legacy MCP keys
	//   from the `global_settings` JSON blob now that M101 has migrated the data
	//   into `mcp_enablement`. The deleted keys (`disabledMcpServers`,
	//   `mcpServerSettings`, `enabledMcpServers`, `enableAllProjectMcpServers`)
	//   are superseded by the unified `app_mcp_servers` registry + the
	//   `mcp_enablement` override table. Carries no schema changes — only data
	//   cleanup. Runs strictly *after* M101 so the seed step still has the
	//   legacy data to copy.
	runMigration102(db);

	// Migration 103: PR 1/5 of the task-agent-as-post-approval-executor refactor
	//   (docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md).
	//   Schema-only — no runtime consumer yet.
	//   Step 1: widen the `space_tasks.status` CHECK constraint to include the
	//     new `'approved'` value.
	//   Steps 2–4: add three nullable columns on `space_tasks`:
	//     `post_approval_session_id`, `post_approval_started_at`,
	//     `post_approval_blocked_reason`.
	runMigration103(db);

	// Migration 104: PR 5/5 of the task-agent-as-post-approval-executor refactor.
	//   Final cleanup — drops the completion-action schema fields. By this stage
	//   PR 4/5 has already removed every runtime path that produced these
	//   values, so the migration is mostly defensive.
	//   Step 5: rewrite any live tasks paused at `pending_checkpoint_type =
	//     'completion_action'` to `'task_completion'` and clear
	//     `pending_action_index`.
	//   Step 6: drop `space_tasks.pending_action_index` column.
	//   Step 7: tighten the `pending_checkpoint_type` CHECK constraint from
	//     `('completion_action', 'gate', 'task_completion')` to
	//     `('gate', 'task_completion')`.
	//   Step 8: drop `space_workflow_runs.completion_actions_fired_at`.
	//   Step 9 (deferred per plan §4.4): `space_task_report_results` stays —
	//     dropping it is gated on a writer audit and shipped in a later
	//     cleanup migration.
	runMigration104(db);

	// Migration 105: Add template_name and template_hash to space_agents for
	//   preset-agent drift detection. Mirrors the workflow template-tracking
	//   columns added in M90 so preset-seeded agents can detect when the source
	//   definitions in seed-agents.ts have moved on, and the UI can offer a
	//   one-click "Sync from template" action.
	runMigration105(db);

	// Migration 106: Backfill template_name + template_hash on existing
	//   space_agents rows that match a preset agent by name but predate M105.
	//   Self-contained (frozen preset fingerprints inlined) — same pattern as
	//   M94 for workflow templates.
	runMigration106(db);

	// Migration 107: Drop the legacy `space_task_report_results` audit table.
	//   M104's plan §4.4 step 9 deferred this drop pending a writer audit; the
	//   audit is now complete (no remaining production code path writes to the
	//   table — the `report_result` end-node tool, repository, and helpers were
	//   all removed). Runs after every previous migration that may still
	//   reference the table.
	runMigration107(db);

	// Migration 108: Remove stale persisted Brave Search MCP rows from older
	//   databases. The built-in registry no longer seeds this MCP server or its
	//   wrapper skill, but users who ran older builds can still have rows in
	//   app_mcp_servers, skills, and enablement override tables. Delete those
	//   legacy rows so settings surfaces no longer display them.
	runMigration108(db);

	// Migration 109: Durable Codex tool continuation recovery. Adds
	//   `waiting_rebind` to node_executions and creates persistent tool_use →
	//   execution mapping plus a per-execution continuation inbox.
	runMigration109(db);

	// Migration 110: Limit pending-agent-message idempotency to live pending rows.
	//   Historical delivered/failed/expired rows must not suppress legitimate resends.
	runMigration110(db);

	// Migration 111: Space-level GitHub watched repositories and normalized PR events.
	runMigration111(db);

	// Migration 112: Normalize Space GitHub dedupe keys after canonical repo casing change.
	runMigration112(db);

	// Migration 113: Add SDK message indexes for large thread windows and replay lookups.
	runMigration113(db);

	// Migration 114: Add 'draft' to space_tasks status CHECK constraint.
	runMigration114(db);

	// Migration 115: Add task_agent_config column to spaces table.
	//   Stores per-space Task Agent overrides (model and custom prompt) as JSON.
	runMigration115(db);

	// Migration 116: Add thinking_level to space_agents for per-agent thinking overrides.
	runMigration116(db);

	// Migration 117: Add disabled column to space_workflows.
	//   When true, the workflow cannot be selected for new tasks.
	runMigration117(db);

	// Migration 118: Add setting_sources column to space_agents.
	//   Stores per-agent setting source overrides as JSON.
	runMigration118(db);

	// Migration 119: Add setting_sources column to spaces.
	//   Stores per-space default setting sources as JSON.
	runMigration119(db);

	// Migration 120: Add created_by and created_by_session columns to space_tasks.
	//   Tracks which agent and session created a task for audit trail.
	runMigration120(db);

	// Migration 121: Create mcp_audit_log table.
	//   General audit trail for MCP write operations (create_task, approve_task,
	//   send_message with gate data, save_artifact, etc.).
	runMigration121(db);

	// Migration 122: Replace task-thread projection with schema fix.
	//   - Add derived columns to sdk_messages: is_renderable, is_terminal, parent_tool_use_id.
	//     These are populated at write time so live-query handlers can read them
	//     without re-parsing JSON or running expensive json_each filters.
	//   - Add task_id column (+ index) to sdk_messages: stamped at INSERT time by
	//     SDKMessageRepository from sessions.session_context.taskId. Replaces the
	//     earlier task_session_map projection (which is dropped if present from a
	//     prior dev run) with a single denormalised column on the message row, so
	//     the live-query thread feeds can JOIN through sdk_messages.task_id directly
	//     without maintaining a parallel lookup table.
	//   - Backfill derived columns + task_id from the existing schema.
	runMigration122(db);

	// Migration 123: Add external-event lifecycle tables for the External Event Bus.
	//   space_external_events — source-level dedup + state machine.
	//   space_external_event_deliveries — per-subscription delivery lifecycle.
	runMigration123(db);

	// Migration 124: Simplify external-event schema.
	//   - Remove pr_number, repo_owner, repo_name, branch, routed_task_id columns
	//     from space_external_events (source-specific metadata now lives in payload_json).
	//   - Simplify state machine: published → delivered | failed | ignored.
	//     Remove 'routed', 'delivery_failed', 'ambiguous' states.
	runMigration124(db);

	// Migration 125: Add task_schedules table for recurring/one-shot scheduled tasks.
	//   task_schedules — stores template + trigger config + scheduling state.
	//   Also adds created_by_task_schedule_id column to space_tasks.
	runMigration125(db);

	// Migration 126: Drop the legacy json_extract function index
	//   idx_sdk_messages_parent_tool. The column-based equivalent
	//   idx_sdk_messages_parent_tool_use_id (added by migration 122) covers all
	//   call sites — keeping both costs write throughput without buying lookup
	//   speed.
	runMigration126(db);

	// Migration 127: Add `handle` column to `space_workflows` for human-readable
	// workflow identifiers (alternative to UUID). Unique per space.
	runMigration127(db);

	// Migration 128: Add external-event extension configuration tables.
	runMigration128(db);

	// Migration 129: Add per-space concurrent task execution limit.
	runMigration129(db);

	// Migration 130: Add gate_open_state table for persisting gate-open cache across daemon restarts.
	runMigration130(db);

	// Migration 131: Add Space-native goals and goal linkage on space_tasks/task_schedules.
	runMigration131(db);

	// Migration 132: Add per-space persistent agent memory with FTS5 search.
	runMigration132(db);

	// Migration 133: Add append-only Space goal event history.
	runMigration133(db);

	// Migration 134: Add FTS5-backed message and Space task search.
	runMigration134(db);

	// Migration 135: Add space-scoped pending message lookup index for actor registry.
	runMigration135(db);

	// Migration 136: Add agent-memory embedding status and vector storage.
	runMigration136(db);

	// Migration 137: Prune message search rows to current search retention policy.
	runMigration137(db);
}

/**
 * Migration 94 — delegated to m94-backfill-workflow-templates.ts so the large
 * backfill block doesn't bloat this file. The behaviour is documented in that
 * module. Exported for direct invocation from tests.
 */
export function runMigration94(db: BunDatabase): void {
	runMigration94External(db);
}

/**
 * Migration 96: Remove the legacy "Full-Cycle Coding Workflow" built-in template.
 *
 * The Full-Cycle workflow was replaced by the Plan & Decompose Workflow. Delete
 * its rows from `space_workflows` across all spaces — but only if the row has no
 * active runs, so any in-flight work keeps executing. Orphan rows without active
 * runs are safe to remove because the in-memory WorkflowExecutor holds a snapshot
 * of the workflow definition for the lifetime of each run.
 *
 * Idempotent: if no rows match (already removed or never seeded), this is a no-op.
 */
export function runMigration96(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) {
		return;
	}
	// Guard against older schemas that may pre-date space_workflow_runs.
	const hasRunsTable = tableExists(db, 'space_workflow_runs');

	let stmt: string;
	if (hasRunsTable) {
		stmt = `
			DELETE FROM space_workflows
			WHERE name = 'Full-Cycle Coding Workflow'
			  AND id NOT IN (
			    SELECT DISTINCT workflow_id
			    FROM space_workflow_runs
			    WHERE status IN ('pending', 'in_progress', 'blocked')
			  )
		`;
	} else {
		stmt = `DELETE FROM space_workflows WHERE name = 'Full-Cycle Coding Workflow'`;
	}
	try {
		db.exec(stmt);
	} catch {
		// Defensive: swallow errors on ancient schemas. The migration's only job
		// is a cleanup nudge — failing here would block unrelated migrations.
	}
}

/**
 * Migration 97 — Delete orphan built-in workflow rows.
 *
 * Clears pre-template-tracking rows that match a known built-in workflow name
 * but have `template_name IS NULL`. These rows predate the template-tracking
 * columns (see migration 90) and were typically superseded by a fresh seed row
 * that already carries `template_name`. Leaving them in place breaks drift
 * detection and confuses the workflow list UI.
 *
 * Idempotent — running the migration twice deletes 0 rows on the second pass.
 *
 * Orphaned-run handling: the `space_workflow_runs.workflow_id` FK was dropped
 * in migration 60, so deleting a workflow does NOT cascade to its runs. To
 * avoid leaving dangling run rows we first delete any runs that reference an
 * orphan workflow. This is acceptable because orphan rows have not been used
 * for new seeding since template tracking shipped — any run referencing one
 * is stale.
 *
 * Complements migration 96 (which deletes Full-Cycle rows without active runs):
 * M96 targets rows by exact name; this migration targets pre-tracking orphans
 * across the built-in set (including legacy names like "Coding with QA
 * Workflow" and "Full-Cycle Coding Workflow" for users upgrading from older
 * databases).
 */
export function runMigration97(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;
	// Guard on the template_name column existing — if migration 90 hasn't run
	// yet (shouldn't happen in practice, but defensive) skip silently.
	if (!tableHasColumn(db, 'space_workflows', 'template_name')) return;

	// Built-in workflow names at the time this migration was authored. Mirrors
	// `getBuiltInWorkflows()` in built-in-workflows.ts, plus the two legacy
	// names retired in PR #1539 so orphan rows on upgraded databases are also
	// cleaned up. Kept inline — migrations must be self-contained and stable
	// across future template changes.
	const BUILT_IN_NAMES = [
		'Coding Workflow',
		'Coding with QA Workflow',
		'Full-Cycle Coding Workflow',
		'Fullstack QA Loop Workflow',
		'Plan & Decompose Workflow',
		'Research Workflow',
		'Review-Only Workflow',
	];

	const placeholders = BUILT_IN_NAMES.map(() => '?').join(', ');

	// Clean up dangling runs first — there is no FK cascade from
	// space_workflow_runs.workflow_id anymore (M60 rebuilt the table without
	// it), so we do it explicitly to avoid leaving orphaned run rows.
	if (tableExists(db, 'space_workflow_runs')) {
		db.prepare(
			`DELETE FROM space_workflow_runs
			  WHERE workflow_id IN (
			    SELECT id FROM space_workflows
			    WHERE template_name IS NULL
			      AND name IN (${placeholders})
			  )`
		).run(...BUILT_IN_NAMES);
	}

	db.prepare(
		`DELETE FROM space_workflows
		  WHERE template_name IS NULL
		    AND name IN (${placeholders})`
	).run(...BUILT_IN_NAMES);
}

/**
 * Migration 1: Add oauth_token_encrypted column if it doesn't exist
 */
function runMigration1(db: BunDatabase): void {
	// First check if auth_config table exists (fresh database)
	if (!tableExists(db, 'auth_config')) {
		return;
	}
	try {
		// Check if column exists by trying to query it
		db.prepare(`SELECT oauth_token_encrypted FROM auth_config LIMIT 1`).all();
	} catch {
		// Column doesn't exist, add it
		db.exec(`ALTER TABLE auth_config ADD COLUMN oauth_token_encrypted TEXT`);
	}
}

/**
 * Migration 2: Remove messages and tool_calls tables (replaced by sdk_messages)
 */
function runMigration2(db: BunDatabase): void {
	try {
		// Check if messages table exists
		db.prepare(`SELECT 1 FROM messages LIMIT 1`).all();
		// Table exists, drop it
		db.exec(`DROP TABLE IF EXISTS tool_calls`);
		db.exec(`DROP TABLE IF EXISTS messages`);
		db.exec(`DROP INDEX IF EXISTS idx_messages_session`);
		db.exec(`DROP INDEX IF EXISTS idx_tool_calls_message`);
	} catch {
		// Tables don't exist, migration already complete
	}
}

/**
 * Migration 3: Add worktree columns to sessions table
 */
function runMigration3(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT is_worktree FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN is_worktree INTEGER DEFAULT 0`);
		db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN main_repo_path TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN worktree_branch TEXT`);
	}
}

/**
 * Migration 4: Add git_branch column for non-worktree git sessions
 */
function runMigration4(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT git_branch FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN git_branch TEXT`);
	}
}

/**
 * Migration 5: Add sdk_session_id column for session resumption
 */
function runMigration5(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT sdk_session_id FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`);
	}
}

/**
 * Migration 6: Add available_commands column for slash commands persistence
 */
function runMigration6(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT available_commands FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN available_commands TEXT`);
	}
}

/**
 * Migration 7: Add processing_state column for agent state persistence
 */
function runMigration7(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT processing_state FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN processing_state TEXT`);
	}
}

/**
 * Migration 8: Add archived_at column for archive session feature
 */
function runMigration8(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT archived_at FROM sessions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE sessions ADD COLUMN archived_at TEXT`);
	}
}

/**
 * Migration 9: Update CHECK constraint to include 'archived' status
 *
 * SQLite doesn't support ALTER COLUMN, so we need to recreate the table.
 *
 * CRITICAL: Must disable foreign_keys during table recreation!
 * With foreign_keys=ON, DROP TABLE cascades to child tables (sdk_messages),
 * which would delete all messages. This was a data-loss bug.
 */
function runMigration9(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		// Check if the CHECK constraint already includes 'archived'
		// We do this by trying to insert a test row with status='archived'
		const testId = '__migration_test_archived_status__';
		db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			testId,
			'Test',
			'/tmp',
			new Date().toISOString(),
			new Date().toISOString(),
			'archived',
			'{}',
			'{}',
			0,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null
		);
		// If we got here, the constraint already includes 'archived', clean up and skip migration
		db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
	} catch {
		// INSERT failed, which means CHECK constraint doesn't include 'archived'
		// Need to recreate the table with updated constraint

		// CRITICAL: Disable foreign keys during table recreation to prevent
		// CASCADE delete from wiping sdk_messages when we DROP TABLE sessions
		db.exec('PRAGMA foreign_keys = OFF');

		try {
			// SQLite table recreation pattern for modifying constraints
			db.exec(`
				-- Create new table with updated CHECK constraint
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived')),
					config TEXT NOT NULL,
					metadata TEXT NOT NULL,
					is_worktree INTEGER DEFAULT 0,
					worktree_path TEXT,
					main_repo_path TEXT,
					worktree_branch TEXT,
					git_branch TEXT,
					sdk_session_id TEXT,
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT
				);

				-- Copy all data from old table to new table
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					   is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
					   sdk_session_id, available_commands, processing_state, archived_at
				FROM sessions;

				-- Drop old table (safe now that foreign_keys is OFF)
				DROP TABLE sessions;

				-- Rename new table to original name
				ALTER TABLE sessions_new RENAME TO sessions;
			`);
		} finally {
			// Re-enable foreign keys
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 10: Add send_status column to sdk_messages for query mode support
 *
 * send_status tracks whether a message has been saved, queued, or sent to SDK
 */
function runMigration10(db: BunDatabase): void {
	// Skip if sdk_messages table doesn't exist (fresh database)
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}
	try {
		db.prepare(`SELECT send_status FROM sdk_messages LIMIT 1`).all();
	} catch {
		db.exec(
			`ALTER TABLE sdk_messages ADD COLUMN send_status TEXT DEFAULT 'sent' CHECK(send_status IN ('saved', 'queued', 'sent'))`
		);
		// Add index for efficient status queries
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
		);
	}
}

/**
 * Migration 11: Add sub-session columns for parent-child session relationships
 *
 * - parent_id: References parent session (null for root sessions)
 * - labels: JSON array of strings for categorization
 * - sub_session_order: Integer for ordering siblings in UI
 */
function runMigration11(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		db.prepare(`SELECT parent_id FROM sessions LIMIT 1`).all();
	} catch {
		// Note: SQLite doesn't support adding FK constraints via ALTER TABLE,
		// but the application layer will enforce the constraint
		db.exec(`ALTER TABLE sessions ADD COLUMN parent_id TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN labels TEXT`);
		db.exec(`ALTER TABLE sessions ADD COLUMN sub_session_order INTEGER DEFAULT 0`);
		// Add index for efficient parent lookups
		db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)`);
	}
}

/**
 * Migration 12: Ensure global_settings has autoScroll: true for existing databases
 *
 * Existing databases may have global_settings without the autoScroll field.
 * This migration ensures all existing settings have autoScroll: true as default.
 */
export function runMigration12(db: BunDatabase): void {
	// Skip if global_settings table doesn't exist (fresh database)
	if (!tableExists(db, 'global_settings')) {
		return;
	}
	try {
		const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
			| { settings: string }
			| undefined;

		if (!row) {
			db.exec(`
        INSERT INTO global_settings (id, settings, updated_at)
        VALUES (1, '{"autoScroll":true}', datetime('now'))
      `);
			return;
		}

		const settings = JSON.parse(row.settings) as Record<string, unknown>;

		// Only update if autoScroll is not already set
		if (settings.autoScroll === undefined) {
			settings.autoScroll = true;
			db.exec(`
        UPDATE global_settings
        SET settings = '${JSON.stringify(settings).replace(/'/g, "''")}',
            updated_at = datetime('now')
        WHERE id = 1
      `);
		}
	} catch {
		// Log but don't throw - migration errors shouldn't crash the app
	}
}

/**
 * Migration 13: Update CHECK constraint to include 'pending_worktree_choice' status
 *
 * SQLite doesn't support ALTER COLUMN, so we need to recreate the table.
 *
 * CRITICAL: Must disable foreign_keys during table recreation!
 * With foreign_keys=ON, DROP TABLE cascades to child tables (sdk_messages),
 * which would delete all messages. This was a data-loss bug.
 */
function runMigration13(db: BunDatabase): void {
	// Skip if sessions table doesn't exist (fresh database)
	if (!tableExists(db, 'sessions')) {
		return;
	}
	try {
		// Check if the CHECK constraint already includes 'pending_worktree_choice'
		// We do this by trying to insert a test row with status='pending_worktree_choice'
		const testId = '__migration_test_pending_worktree_choice_status__';
		db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			testId,
			'Test',
			'/tmp',
			new Date().toISOString(),
			new Date().toISOString(),
			'pending_worktree_choice',
			'{}',
			'{}',
			0,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null
		);
		// If we got here, the constraint already includes 'pending_worktree_choice', clean up and skip migration
		db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
	} catch {
		// INSERT failed, which means CHECK constraint doesn't include 'pending_worktree_choice'
		// Need to recreate the table with updated constraint
		// Recreate table with updated CHECK constraint to include 'pending_worktree_choice'

		// CRITICAL: Disable foreign keys during table recreation to prevent
		// CASCADE delete from wiping sdk_messages when we DROP TABLE sessions
		db.exec('PRAGMA foreign_keys = OFF');

		try {
			// Determine which optional columns exist before rebuild (they may or may not be present
			// depending on which migrations ran before this one)
			const hasLabels = tableHasColumn(db, 'sessions', 'labels');
			const hasSubOrder = tableHasColumn(db, 'sessions', 'sub_session_order');

			// SQLite table recreation pattern for modifying constraints
			db.exec(`
				-- Create new table with updated CHECK constraint
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
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
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT,
					parent_id TEXT
				);

				-- Copy all data from old table to new table
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					   is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
					   sdk_session_id, available_commands, processing_state, archived_at, parent_id
				FROM sessions;

				-- Drop old table (safe now that foreign_keys is OFF)
				DROP TABLE sessions;

				-- Rename new table to original name
				ALTER TABLE sessions_new RENAME TO sessions;
			`);

			// Re-add labels and sub_session_order if they existed in the old table
			// (Migration 14 will drop them, but we preserve them here so M14 can do it cleanly)
			if (hasLabels) {
				db.exec(`ALTER TABLE sessions ADD COLUMN labels TEXT`);
			}
			if (hasSubOrder) {
				db.exec(`ALTER TABLE sessions ADD COLUMN sub_session_order INTEGER DEFAULT 0`);
			}
		} finally {
			// Re-enable foreign keys
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 14: Drop events table and unused session columns
 *
 * - events table was never used (EventBus handles events in-memory)
 * - labels and sub_session_order columns were added in Migration 11 but never used
 *
 * ALTER TABLE DROP COLUMN requires SQLite 3.35+; Bun ships SQLite 3.46+.
 */
function runMigration14(db: BunDatabase): void {
	db.exec(`DROP TABLE IF EXISTS events`);
	db.exec(`DROP INDEX IF EXISTS idx_events_session`);

	if (!tableExists(db, 'sessions')) return;
	if (tableHasColumn(db, 'sessions', 'labels')) {
		db.exec(`ALTER TABLE sessions DROP COLUMN labels`);
	}
	if (tableHasColumn(db, 'sessions', 'sub_session_order')) {
		db.exec(`ALTER TABLE sessions DROP COLUMN sub_session_order`);
	}
}

/**
 * Migration 15: Add 'failed' to send_status CHECK constraint in sdk_messages
 *
 * Orphaned messages are now marked 'failed' instead of 'saved', so they appear
 * in the UI as undelivered rather than being silently re-dispatched on startup.
 *
 * Requires rebuilding the table because SQLite does not support modifying
 * existing CHECK constraints via ALTER TABLE.
 */
function runMigration15(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}
	// Check if the constraint already includes 'failed' by inspecting the schema SQL
	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sdk_messages'`)
		.get() as { sql: string } | null;
	if (tableInfo?.sql?.includes("'failed'")) {
		return; // Already migrated
	}

	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		db.exec(`
			CREATE TABLE sdk_messages_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'sent' CHECK(send_status IN ('saved', 'queued', 'sent', 'failed')),
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
		db.exec(`INSERT INTO sdk_messages_new SELECT * FROM sdk_messages`);
		db.exec(`DROP TABLE sdk_messages`);
		db.exec(`ALTER TABLE sdk_messages_new RENAME TO sdk_messages`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_id ON sdk_messages(session_id)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
		);
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 16: Replace 'escalated' with 'review' in tasks CHECK constraint,
 * remove 'hibernated' from session_groups CHECK constraint,
 * add config column to rooms table.
 *
 * - Tasks: 'escalated' → 'review' (existing escalated rows mapped to 'failed')
 * - Session groups: remove 'hibernated' (existing hibernated rows mapped to 'failed')
 * - Rooms: add config TEXT column for agent sub-agents and other room config
 */
function runMigration16(db: BunDatabase): void {
	// --- Tasks table: replace 'escalated' with 'review' ---
	if (tableExists(db, 'tasks')) {
		// Inspect CHECK constraint text instead of probe INSERT.
		// Probe inserts can fail due to FK constraints (tasks.room_id -> rooms.id)
		// even when the status CHECK is already migrated.
		const tableInfo = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
			.get() as { sql: string } | null;
		const needsTaskMigration =
			tableInfo !== null &&
			(tableInfo.sql.includes("'escalated'") || !tableInfo.sql.includes("'review'"));

		if (needsTaskMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				// Map any existing 'escalated' tasks to 'failed'
				db.exec(`PRAGMA ignore_check_constraints = 1`);
				db.exec(`UPDATE tasks SET status = 'failed' WHERE status = 'escalated'`);
				db.exec(`PRAGMA ignore_check_constraints = 0`);

				// Drop leftover temp table from a previous crashed migration attempt
				db.exec(`DROP TABLE IF EXISTS tasks_new`);

				db.exec(`
					CREATE TABLE tasks_new (
						id TEXT PRIMARY KEY,
						room_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled')),
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
						assigned_agent TEXT DEFAULT 'coder',
						created_by_task_id TEXT,
						FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
					)
				`);
				// Build column list dynamically — old schemas may not have all columns
				const cols = [
					'id',
					'room_id',
					'title',
					'description',
					'status',
					'priority',
					'progress',
					'current_step',
					'result',
					'error',
					'depends_on',
					'created_at',
					'started_at',
					'completed_at',
				];
				const optionalCols = ['task_type', 'assigned_agent', 'created_by_task_id'];
				for (const col of optionalCols) {
					if (tableHasColumn(db, 'tasks', col)) cols.push(col);
				}
				const selectCols = cols.join(', ');
				db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
				db.exec(`DROP TABLE tasks`);
				db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// --- Session groups table: remove 'hibernated' ---
	if (tableExists(db, 'session_groups')) {
		const testId = '__migration15_sg_test__';
		let needsGroupMigration = false;
		try {
			// Try inserting 'hibernated' — if it succeeds, the constraint still allows it
			db.prepare(
				`INSERT INTO session_groups (id, group_type, ref_id, state, version, metadata, created_at)
				 VALUES (?, 'task', 'test', 'hibernated', 0, '{}', 0)`
			).run(testId);
			db.prepare(`DELETE FROM session_groups WHERE id = ?`).run(testId);
			needsGroupMigration = true; // 'hibernated' is still allowed, need to remove it
		} catch {
			// 'hibernated' already not allowed — migration done
		}

		if (needsGroupMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				// Map any existing 'hibernated' groups to 'failed'
				db.exec(`UPDATE session_groups SET state = 'failed' WHERE state = 'hibernated'`);

				// Drop leftover temp table from a previous crashed migration attempt
				db.exec(`DROP TABLE IF EXISTS session_groups_new`);

				db.exec(`
					CREATE TABLE session_groups_new (
						id TEXT PRIMARY KEY,
						group_type TEXT NOT NULL DEFAULT 'task',
						ref_id TEXT NOT NULL,
						state TEXT NOT NULL DEFAULT 'awaiting_worker'
							CHECK(state IN ('awaiting_worker', 'awaiting_leader', 'awaiting_human', 'completed', 'failed')),
						version INTEGER NOT NULL DEFAULT 0,
						metadata TEXT NOT NULL DEFAULT '{}',
						created_at INTEGER NOT NULL,
						completed_at INTEGER
					)
				`);
				db.exec(`
					INSERT INTO session_groups_new
					SELECT id, group_type, ref_id, state, version, metadata, created_at, completed_at
					FROM session_groups
				`);
				db.exec(`DROP TABLE session_groups`);
				db.exec(`ALTER TABLE session_groups_new RENAME TO session_groups`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_ref ON session_groups(ref_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_state ON session_groups(state)`);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// --- Rooms table: add config column ---
	if (tableExists(db, 'rooms') && !tableHasColumn(db, 'rooms', 'config')) {
		db.exec(`ALTER TABLE rooms ADD COLUMN config TEXT`);
	}
}

/**
 * Migration 17: Fix goals table CHECK constraint and add goal_review_attempts column
 *
 * The goals table was created with an old CHECK constraint:
 *   CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked'))
 * The correct constraint (matching GoalStatus type) is:
 *   CHECK(status IN ('active', 'needs_human', 'completed', 'archived'))
 *
 * Also adds the goal_review_attempts column defined in the RoomGoal interface
 * but missing from the original table schema.
 *
 * Status mapping: pending → active, in_progress → active, blocked → needs_human
 *
 * CRITICAL: Must disable foreign_keys during table recreation to prevent
 * CASCADE delete from wiping related data when we DROP TABLE goals.
 */
function runMigration17(db: BunDatabase): void {
	if (!tableExists(db, 'goals')) {
		return;
	}

	// Check if migration is needed: try inserting a row with status='active'
	// If it fails, the old CHECK constraint is in place and we need to recreate the table.
	// Also check if goal_review_attempts column is already present.
	const testId = '__migration16_goals_test__';
	let needsConstraintFix = false;
	try {
		db.prepare(
			`INSERT INTO goals (id, room_id, title, description, status, priority, created_at, updated_at)
			 VALUES (?, 'test', 'test', '', 'active', 'normal', 0, 0)`
		).run(testId);
		db.prepare(`DELETE FROM goals WHERE id = ?`).run(testId);
	} catch {
		needsConstraintFix = true;
	}

	const needsColumn = !tableHasColumn(db, 'goals', 'goal_review_attempts');

	if (!needsConstraintFix && !needsColumn) {
		return; // Already up to date
	}

	db.exec('PRAGMA foreign_keys = OFF');
	try {
		if (needsConstraintFix) {
			// Map old status values to new ones before recreating the table
			db.exec(`PRAGMA ignore_check_constraints = 1`);
			db.exec(`UPDATE goals SET status = 'active' WHERE status IN ('pending', 'in_progress')`);
			db.exec(`UPDATE goals SET status = 'needs_human' WHERE status = 'blocked'`);
			db.exec(`PRAGMA ignore_check_constraints = 0`);
		}

		// Drop leftover temp table from a previous crashed migration attempt
		db.exec(`DROP TABLE IF EXISTS goals_new`);

		// Determine which optional columns exist so we can carry them over
		const hasGoalReviewAttempts = tableHasColumn(db, 'goals', 'goal_review_attempts');
		const hasPlanningAttempts = tableHasColumn(db, 'goals', 'planning_attempts');

		db.exec(`
			CREATE TABLE goals_new (
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
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

		// Build column list — only include goal_review_attempts if it existed before
		const cols = [
			'id',
			'room_id',
			'title',
			'description',
			'status',
			'priority',
			'progress',
			'linked_task_ids',
			'metrics',
			'created_at',
			'updated_at',
			'completed_at',
		];
		if (hasPlanningAttempts) {
			cols.push('planning_attempts');
		}
		if (hasGoalReviewAttempts) {
			cols.push('goal_review_attempts');
		}
		const selectCols = cols.join(', ');
		db.exec(`INSERT INTO goals_new (${selectCols}) SELECT ${selectCols} FROM goals`);

		db.exec(`DROP TABLE goals`);
		db.exec(`ALTER TABLE goals_new RENAME TO goals`);

		db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_room ON goals(room_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 18: Add 'cancelled' to tasks status CHECK constraint
 *
 * Cancelled tasks are intentionally stopped by the user — semantically distinct from failed.
 * Uses the same table-rebuild pattern required by SQLite's lack of ALTER CONSTRAINT support.
 */
function runMigration18(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}

	// Test if migration is needed by inspecting the CHECK constraint in the schema text.
	// We use sqlite_master instead of a probe INSERT to avoid triggering a FK violation:
	// tasks.room_id references rooms(id), and inserting with a fake room_id would fail
	// when foreign_keys=ON (which the app enables at startup), spuriously triggering a
	// full table-rebuild on every startup even for already-migrated databases.
	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
		.get() as { sql: string } | null;
	const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'cancelled'");

	if (!needsMigration) return;

	db.exec('PRAGMA foreign_keys = OFF');
	try {
		db.exec(`DROP TABLE IF EXISTS tasks_new`);

		db.exec(`
			CREATE TABLE tasks_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled')),
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
				assigned_agent TEXT DEFAULT 'coder',
				created_by_task_id TEXT,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

		const cols = [
			'id',
			'room_id',
			'title',
			'description',
			'status',
			'priority',
			'progress',
			'current_step',
			'result',
			'error',
			'depends_on',
			'created_at',
			'started_at',
			'completed_at',
		];
		const optionalCols = ['task_type', 'assigned_agent', 'created_by_task_id'];
		for (const col of optionalCols) {
			if (tableHasColumn(db, 'tasks', col)) cols.push(col);
		}
		const selectCols = cols.join(', ');
		db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
		db.exec(`DROP TABLE tasks`);
		db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Helper function to check if a table exists in the database
 */
function tableExists(db: BunDatabase, tableName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!result;
}

/**
 * Helper to check whether a table has a specific column
 */
function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
		.get(columnName);
	return !!result;
}

function tableCreateSql(db: BunDatabase, tableName: string): string | null {
	const row = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName) as { sql?: string } | undefined;
	return row?.sql ?? null;
}

function quoteSqlIdent(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function tableColumnNames(db: BunDatabase, tableName: string): string[] {
	return (
		db.prepare(`PRAGMA table_info(${quoteSqlString(tableName)})`).all() as Array<{ name: string }>
	).map((r) => r.name);
}

function replaceCreateTableName(createSql: string, newTableName: string): string {
	const replaced = createSql.replace(
		/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i,
		`CREATE TABLE ${quoteSqlIdent(newTableName)}`
	);
	if (replaced === createSql) {
		throw new Error('Unable to rewrite CREATE TABLE statement');
	}
	return replaced;
}

function widenSpaceTasksApprovedStatusCheck(createSql: string): string {
	let matched = false;
	const widened = createSql.replace(
		/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
		(match, values: string) => {
			matched = true;
			if (values.includes("'approved'")) {
				return match;
			}
			return `CHECK(status IN (${values.trim()}, 'approved'))`;
		}
	);
	if (!matched) {
		throw new Error('Unable to widen space_tasks.status CHECK constraint');
	}
	return widened;
}

function matchingParenIndex(sql: string, openIndex: number): number {
	let depth = 0;
	let quote: "'" | '"' | '`' | ']' | null = null;
	for (let i = openIndex; i < sql.length; i++) {
		const ch = sql[i];
		if (quote) {
			if (quote === "'" && ch === "'" && sql[i + 1] === "'") {
				i++;
				continue;
			}
			if (quote === ']' ? ch === ']' : ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			continue;
		}
		if (ch === '[') {
			quote = ']';
			continue;
		}
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	throw new Error('Unable to find closing parenthesis in CREATE TABLE statement');
}

function splitTopLevelSqlList(sql: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: "'" | '"' | '`' | ']' | null = null;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (quote) {
			if (quote === "'" && ch === "'" && sql[i + 1] === "'") {
				i++;
				continue;
			}
			if (quote === ']' ? ch === ']' : ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			continue;
		}
		if (ch === '[') {
			quote = ']';
			continue;
		}
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
		} else if (ch === ',' && depth === 0) {
			parts.push(sql.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(sql.slice(start));
	return parts;
}

function createTableSqlWithoutColumn(createSql: string, columnName: string): string {
	const open = createSql.indexOf('(');
	if (open < 0) {
		throw new Error('Unable to parse CREATE TABLE statement');
	}
	const close = matchingParenIndex(createSql, open);
	const prefix = createSql.slice(0, open + 1);
	const body = createSql.slice(open + 1, close);
	const suffix = createSql.slice(close);
	const columnPattern = new RegExp(
		`^\\s*(?:"${columnName.replaceAll('"', '""')}"|\\[${columnName.replaceAll(']', ']]')}\\]|\\\`${columnName.replaceAll('`', '``')}\\\`|${columnName})\\b`,
		'i'
	);
	const parts = splitTopLevelSqlList(body).filter((part) => !columnPattern.test(part.trimStart()));
	return `${prefix}${parts.join(',')}${suffix}`;
}

function tightenPendingCheckpointTypeCheck(createSql: string): string {
	return createSql.replace(
		/CHECK\s*\(\s*pending_checkpoint_type\s+IN\s*\([^)]*\)\s*\)/i,
		"CHECK(pending_checkpoint_type IN ('gate', 'task_completion'))"
	);
}

function capturedIndexDdl(
	db: BunDatabase,
	tableName: string
): Array<{ sql: string; columns: string[] }> {
	const rows = db
		.prepare(
			`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
		)
		.all(tableName) as Array<{ name: string; sql: string }>;
	return rows.map((row) => {
		const indexColumns = db
			.prepare(`PRAGMA index_info(${quoteSqlString(row.name)})`)
			.all() as Array<{ name: string | null }>;
		return {
			sql: row.sql,
			columns: indexColumns.map((col) => col.name).filter((name): name is string => !!name),
		};
	});
}

function recreateCompatibleIndexes(
	db: BunDatabase,
	tableName: string,
	indexes: Array<{ sql: string; columns: string[] }>
): void {
	const columns = new Set(tableColumnNames(db, tableName));
	for (const index of indexes) {
		if (index.columns.some((column) => !columns.has(column))) {
			continue;
		}
		const normalized = index.sql.replace(
			/^CREATE (UNIQUE )?INDEX /i,
			(_m, unique) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `
		);
		try {
			db.exec(normalized);
		} catch (err) {
			if (err instanceof Error && /\bno such column\b/i.test(err.message)) {
				continue;
			}
			throw err;
		}
	}
}

function statusCheckContains(db: BunDatabase, tableName: string, status: string): boolean {
	const sql = tableCreateSql(db, tableName);
	if (!sql) return false;

	const match = sql.match(/status\s+TEXT[\s\S]*?CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i);
	return match?.[1]?.includes(`'${status}'`) ?? false;
}

/**
 * Room cleanup migration (consolidates former migrations 25–36)
 *
 * Room features were never shipped to production, so all room-related tables are
 * dropped unconditionally — createTables() recreates them with the correct schema.
 *
 * For the sessions table (which contains real user data):
 * - Adds type/session_context columns if missing
 * - Rebuilds the table if the type CHECK constraint is outdated, mapping any
 *   dev-only type values to their production equivalents before the rebuild.
 */
function runMigration19(db: BunDatabase): void {
	db.exec(`DROP TABLE IF EXISTS session_group_messages`);
	db.exec(`DROP INDEX IF EXISTS idx_sgmsg_group`);
}

/**
 * Migration 20: Add archived_at column to tasks table
 *
 * archived_at is orthogonal to status - a task can be completed+archived, failed+archived, etc.
 * This supports the worktree cleanup strategy where:
 * - completed/cancelled tasks cleanup worktree immediately
 * - failed tasks keep worktree for debugging
 * - archived tasks cleanup worktree when user explicitly archives
 */
function runMigration20(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}

	// Check if archived_at column already exists
	if (tableHasColumn(db, 'tasks', 'archived_at')) {
		return;
	}

	db.exec(`ALTER TABLE tasks ADD COLUMN archived_at INTEGER`);
}

/**
 * Migration 21: Backfill submittedForReview metadata from legacy state column.
 *
 * For pre-existing databases, active groups may rely on `state='awaiting_human'`
 * without metadata.submittedForReview set. Runtime behavior now relies on metadata,
 * so this migration copies that semantic flag into metadata once.
 */
function runMigration21(db: BunDatabase): void {
	if (!tableExists(db, 'session_groups')) {
		return;
	}
	if (!tableHasColumn(db, 'session_groups', 'state')) {
		return;
	}

	const rows = db
		.prepare(
			`SELECT id, metadata
			 FROM session_groups
			 WHERE completed_at IS NULL AND state = 'awaiting_human'`
		)
		.all() as Array<{ id: string; metadata: string | null }>;

	const update = db.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`);
	for (const row of rows) {
		let meta: Record<string, unknown> = {};
		if (row.metadata) {
			try {
				meta = JSON.parse(row.metadata) as Record<string, unknown>;
			} catch {
				meta = {};
			}
		}
		if (meta.submittedForReview === true) {
			continue;
		}
		meta.submittedForReview = true;
		update.run(JSON.stringify(meta), row.id);
	}
}

/**
 * Migration 22: Drop legacy `session_groups.state` and its index.
 *
 * Routing semantics now rely on completed_at + metadata.submittedForReview.
 */
function runMigration22(db: BunDatabase): void {
	db.exec(`DROP INDEX IF EXISTS idx_session_groups_state`);

	if (!tableExists(db, 'session_groups')) {
		return;
	}
	if (!tableHasColumn(db, 'session_groups', 'state')) {
		return;
	}

	db.exec(`ALTER TABLE session_groups DROP COLUMN state`);
}

/**
 * Migration 23: Add active_session column to tasks table.
 * Tracks which agent session is currently generating output ('worker' | 'leader' | null).
 * Allows the UI to show a "working" indicator even when the task status is 'review'.
 */
function runMigration23(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (tableHasColumn(db, 'tasks', 'active_session')) {
		return;
	}
	db.exec(`ALTER TABLE tasks ADD COLUMN active_session TEXT`);
}

/**
 * Migration 24: Rename 'failed' task status to 'needs_attention'.
 *
 * Uses the table-rebuild pattern required by SQLite's lack of ALTER CONSTRAINT support.
 * Also updates any existing task rows with status='failed' to 'needs_attention'.
 */
function runMigration24(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}

	// Check if migration is needed by inspecting the CHECK constraint.
	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
		.get() as { sql: string } | null;
	const needsMigration = tableInfo !== null && tableInfo.sql.includes("'failed'");

	if (!needsMigration) return;

	db.exec('PRAGMA foreign_keys = OFF');
	try {
		db.exec(`DROP TABLE IF EXISTS tasks_new`);

		db.exec(`
			CREATE TABLE tasks_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
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
				assigned_agent TEXT DEFAULT 'coder',
				created_by_task_id TEXT,
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

		// Build column list dynamically for the INSERT SELECT (handles optional columns)
		const baseCols = [
			'id',
			'room_id',
			'title',
			'description',
			'priority',
			'progress',
			'current_step',
			'result',
			'error',
			'depends_on',
			'created_at',
			'started_at',
			'completed_at',
		];
		const optionalCols = [
			'task_type',
			'assigned_agent',
			'created_by_task_id',
			'archived_at',
			'active_session',
			'pr_url',
			'pr_number',
			'pr_created_at',
		];
		for (const col of optionalCols) {
			if (tableHasColumn(db, 'tasks', col)) baseCols.push(col);
		}

		// Rename 'failed' → 'needs_attention' during the copy using CASE expression
		const colsWithoutStatus = baseCols.join(', ');
		db.exec(`PRAGMA ignore_check_constraints = 1`);
		db.exec(`
			INSERT INTO tasks_new (status, ${colsWithoutStatus})
			SELECT
				CASE WHEN status = 'failed' THEN 'needs_attention' ELSE status END,
				${colsWithoutStatus}
			FROM tasks
		`);
		db.exec(`PRAGMA ignore_check_constraints = 0`);

		db.exec(`DROP TABLE tasks`);
		db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 25: Add PR fields to tasks table.
 *
 * Adds pr_url, pr_number, pr_created_at as first-class columns so PR data
 * is no longer stored as a hack in current_step.
 */
function runMigration25(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (!tableHasColumn(db, 'tasks', 'pr_url')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
	}
	if (!tableHasColumn(db, 'tasks', 'pr_number')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN pr_number INTEGER`);
	}
	if (!tableHasColumn(db, 'tasks', 'pr_created_at')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN pr_created_at INTEGER`);
	}
}

/**
 * Migration 26: Add input_draft column to tasks table for server-side draft persistence
 */
function runMigration26(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (tableHasColumn(db, 'tasks', 'input_draft')) {
		return;
	}
	db.exec(`ALTER TABLE tasks ADD COLUMN input_draft TEXT`);
}

function runMigration27(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) {
		return;
	}
	if (!tableHasColumn(db, 'tasks', 'updated_at')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN updated_at INTEGER`);
		// Backfill updated_at with the best available timestamp for existing rows
		db.exec(
			`UPDATE tasks SET updated_at = COALESCE(completed_at, started_at, created_at) WHERE updated_at IS NULL`
		);
	}
	// Add composite index for listTasks() query: WHERE room_id = ? ORDER BY updated_at DESC
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
}

function runMigrationRoomCleanup(db: BunDatabase): void {
	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		// Drop all old experiment and orchestration tables
		db.exec(`DROP TABLE IF EXISTS neo_context_messages`);
		db.exec(`DROP TABLE IF EXISTS neo_contexts`);
		db.exec(`DROP TABLE IF EXISTS neo_tasks`);
		db.exec(`DROP TABLE IF EXISTS neo_memories`);
		db.exec(`DROP TABLE IF EXISTS neo_rooms`);
		db.exec(`DROP TABLE IF EXISTS room_agent_states`);
		db.exec(`DROP TABLE IF EXISTS worker_sessions`);
		db.exec(`DROP TABLE IF EXISTS worker_sessions_orphaned`);
		db.exec(`DROP TABLE IF EXISTS recurring_jobs`);
		db.exec(`DROP TABLE IF EXISTS room_context_versions`);
		db.exec(`DROP TABLE IF EXISTS context_messages`);
		db.exec(`DROP TABLE IF EXISTS contexts`);
		db.exec(`DROP TABLE IF EXISTS memories`);
		db.exec(`DROP TABLE IF EXISTS session_pairs`);
		db.exec(`DROP TABLE IF EXISTS task_pairs`);
		db.exec(`DROP TABLE IF EXISTS rendered_prompts`);
		db.exec(`DROP TABLE IF EXISTS prompt_templates`);

		// Room runtime tables (rooms, tasks, goals, session_groups, etc.) are now
		// production tables with real data — do NOT drop them here.
		// createTables() uses CREATE TABLE IF NOT EXISTS, so they will be created
		// on first run and preserved on subsequent runs.

		if (!tableExists(db, 'sessions')) return;

		// Ensure sessions has the new columns
		if (!tableHasColumn(db, 'sessions', 'type')) {
			db.exec(`ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'worker'`);
		}
		if (!tableHasColumn(db, 'sessions', 'session_context')) {
			db.exec(`ALTER TABLE sessions ADD COLUMN session_context TEXT`);
		}

		// Test whether the type CHECK constraint already includes the final set of types
		const testId = '__migration_room_cleanup_test__';
		try {
			db.exec(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
				 VALUES ('${testId}', 'test', '/', datetime('now'), datetime('now'), 'active', '{}', '{}', 'planner')`
			);
			db.exec(`DELETE FROM sessions WHERE id = '${testId}'`);
			return; // Constraint is already correct — nothing more to do
		} catch {
			// Constraint is outdated — rebuild sessions below
		}

		// Remap dev-only type values before the rebuild
		db.exec(`PRAGMA ignore_check_constraints = 1`);
		db.exec(`UPDATE sessions SET type = 'coder' WHERE type IN ('craft', 'room_self')`);
		db.exec(`UPDATE sessions SET type = 'leader' WHERE type IN ('lead', 'manager')`);
		db.exec(`PRAGMA ignore_check_constraints = 0`);
		// Delete any remaining room-only session types (dev data, not present in production)
		db.exec(
			`DELETE FROM sessions WHERE type NOT IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby')`
		);

		db.exec(`
			CREATE TABLE sessions_new (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT NOT NULL,
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
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby')),
				session_context TEXT
			)
		`);
		db.exec(`
			INSERT INTO sessions_new
			SELECT id, title, workspace_path, created_at, last_active_at,
				status, config, metadata, is_worktree, worktree_path, main_repo_path,
				worktree_branch, git_branch, sdk_session_id, available_commands,
				processing_state, archived_at, parent_id, type, session_context
			FROM sessions
		`);
		db.exec(`DROP TABLE sessions`);
		db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 28: Add mission metadata columns to goals table and create
 * mission_metric_history and mission_executions tables.
 *
 * New columns on goals:
 * - mission_type, autonomy_level (with CHECK constraints)
 * - schedule (JSON), schedule_paused, next_run_at
 * - structured_metrics (JSON)
 * - max_consecutive_failures, max_planning_attempts, consecutive_failures
 *
 * New tables:
 * - mission_metric_history: metric data points per goal
 * - mission_executions: execution runs per goal (with partial unique index
 *   on (goal_id) WHERE status = 'running' for at-most-one-running invariant)
 *
 * Backfills existing goals: mission_type = 'one_shot', autonomy_level = 'supervised'
 */
function runMigration28(db: BunDatabase): void {
	// --- Add columns to goals table ---
	if (tableExists(db, 'goals')) {
		if (!tableHasColumn(db, 'goals', 'mission_type')) {
			db.exec(
				`ALTER TABLE goals ADD COLUMN mission_type TEXT NOT NULL DEFAULT 'one_shot'` +
					` CHECK(mission_type IN ('one_shot', 'measurable', 'recurring'))`
			);
			// Backfill existing rows (ALTER TABLE DEFAULT already handles it, but be explicit)
			db.exec(`UPDATE goals SET mission_type = 'one_shot' WHERE mission_type IS NULL`);
		}
		if (!tableHasColumn(db, 'goals', 'autonomy_level')) {
			db.exec(
				`ALTER TABLE goals ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'supervised'` +
					` CHECK(autonomy_level IN ('supervised', 'semi_autonomous'))`
			);
			db.exec(`UPDATE goals SET autonomy_level = 'supervised' WHERE autonomy_level IS NULL`);
		}
		if (!tableHasColumn(db, 'goals', 'schedule')) {
			db.exec(`ALTER TABLE goals ADD COLUMN schedule TEXT`);
		}
		if (!tableHasColumn(db, 'goals', 'schedule_paused')) {
			db.exec(`ALTER TABLE goals ADD COLUMN schedule_paused INTEGER NOT NULL DEFAULT 0`);
		}
		if (!tableHasColumn(db, 'goals', 'next_run_at')) {
			db.exec(`ALTER TABLE goals ADD COLUMN next_run_at INTEGER`);
		}
		if (!tableHasColumn(db, 'goals', 'structured_metrics')) {
			db.exec(`ALTER TABLE goals ADD COLUMN structured_metrics TEXT`);
		}
		if (!tableHasColumn(db, 'goals', 'max_consecutive_failures')) {
			db.exec(`ALTER TABLE goals ADD COLUMN max_consecutive_failures INTEGER NOT NULL DEFAULT 3`);
		}
		if (!tableHasColumn(db, 'goals', 'max_planning_attempts')) {
			db.exec(`ALTER TABLE goals ADD COLUMN max_planning_attempts INTEGER NOT NULL DEFAULT 0`);
		} else {
			// Reset old default sentinel 5 → 0. Zero means "use room config" (no per-goal override).
			// The prior migration used 5 as the column default, but that was never a meaningful
			// user-set value; it caused all goals to appear as if they had an explicit override.
			db.exec(`UPDATE goals SET max_planning_attempts = 0 WHERE max_planning_attempts = 5`);
		}
		if (!tableHasColumn(db, 'goals', 'consecutive_failures')) {
			db.exec(`ALTER TABLE goals ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
		}
		if (!tableHasColumn(db, 'goals', 'replan_count')) {
			db.exec(`ALTER TABLE goals ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0`);
		}
		// Composite index for efficient scheduler queries
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_goals_mission_scheduler` +
				` ON goals(mission_type, schedule_paused, next_run_at)`
		);
	}

	// --- Create mission_metric_history table ---
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
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mission_metric_history_lookup` +
			` ON mission_metric_history(goal_id, metric_name, recorded_at)`
	);

	// --- Create mission_executions table ---
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
	// Partial unique index: at most one running execution per goal
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running` +
			` ON mission_executions(goal_id) WHERE status = 'running'`
	);
}

/**
 * Migration 29: Create all Space system tables (fully consolidated schema)
 *
 * Creates the following tables in FK-safe order:
 * - spaces: workspace-first multi-agent container
 * - space_agents: custom agents per space (role/provider/inject_workflow_context included, no CHECK on role)
 * - space_workflows: workflow definitions per space (includes start_step_id)
 * - space_workflow_steps: ordered steps within a workflow
 * - space_workflow_transitions: directed edges between steps (graph navigation)
 * - space_workflow_runs: active/historical workflow executions (includes current_step_id)
 * - space_tasks: tasks with built-in custom_agent_id, workflow_run_id, workflow_step_id
 * - space_session_groups: named groups of related sessions (includes workflow_run_id, current_step_id, task_id)
 * - space_session_group_members: membership records with freeform role, agent_id, and status
 *
 * All tables are created with IF NOT EXISTS so the migration is idempotent.
 * CASCADE deletes propagate from spaces → all child tables.
 */
function runMigration29(db: BunDatabase): void {
	// -------------------------------------------------------------------------
	// spaces
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS spaces (
			id TEXT PRIMARY KEY,
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
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);
	// Note: workspace_path has a UNIQUE constraint which SQLite implements as an implicit
	// unique index — no explicit CREATE INDEX needed.

	// -------------------------------------------------------------------------
	// space_agents
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			system_prompt TEXT NOT NULL DEFAULT '',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			role TEXT NOT NULL DEFAULT '',
			provider TEXT,
			inject_workflow_context INTEGER NOT NULL DEFAULT 0,
			instructions TEXT,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);

	// -------------------------------------------------------------------------
	// space_workflows
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_step_id TEXT,
			config TEXT,
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`);

	// -------------------------------------------------------------------------
	// space_workflow_steps
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			agent_id TEXT,
			order_index INTEGER NOT NULL,
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_steps_workflow_id ON space_workflow_steps(workflow_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_steps_order ON space_workflow_steps(workflow_id, order_index)`
	);

	// -------------------------------------------------------------------------
	// space_workflow_transitions (directed edges between steps)
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_transitions (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			from_step_id TEXT NOT NULL,
			to_step_id TEXT NOT NULL,
			condition TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
			FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
			FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_workflow_id ON space_workflow_transitions(workflow_id)`
	);
	if (tableHasColumn(db, 'space_workflow_transitions', 'from_step_id')) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_from_step ON space_workflow_transitions(workflow_id, from_step_id)`
		);
	}

	// -------------------------------------------------------------------------
	// space_workflow_runs  (must be before space_tasks — FK dependency)
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			current_step_index INTEGER NOT NULL DEFAULT 0,
			current_step_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
			config TEXT,
			created_at INTEGER NOT NULL,
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
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
	);

	// -------------------------------------------------------------------------
	// space_tasks
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			task_type TEXT
				CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
			assigned_agent TEXT
				CHECK(assigned_agent IN ('coder', 'general')),
			custom_agent_id TEXT,
			workflow_run_id TEXT,
			workflow_step_id TEXT,
			created_by_task_id TEXT,
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			input_draft TEXT,
			active_session TEXT
				CHECK(active_session IN ('worker', 'leader')),
			task_agent_session_id TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			archived_at INTEGER,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
			FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
	);
	// Existing databases created by early Space previews may be missing this column.
	if (!tableHasColumn(db, 'space_tasks', 'custom_agent_id')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN custom_agent_id TEXT`);
	}
	if (tableHasColumn(db, 'space_tasks', 'custom_agent_id')) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
		);
	}
	if (tableHasColumn(db, 'space_tasks', 'workflow_step_id')) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_step_id ON space_tasks(workflow_step_id)`
		);
	}
	// Note: idx_space_tasks_task_agent_session_id is created by migration 32,
	// which first adds the column via ALTER TABLE for existing databases.
	// Note: goal_id column is added by migration 34 (ALTER TABLE for existing DBs).

	// -------------------------------------------------------------------------
	// space_session_groups
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_session_groups (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			workflow_run_id TEXT,
			current_step_id TEXT,
			task_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_session_groups_space_id ON space_session_groups(space_id)`
	);

	// -------------------------------------------------------------------------
	// space_session_group_members
	// -------------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_session_group_members (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			agent_id TEXT,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'completed', 'failed')),
			order_index INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE,
			UNIQUE(group_id, session_id)
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_group_id ON space_session_group_members(group_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_session_id ON space_session_group_members(session_id)`
	);

	// -------------------------------------------------------------------------
	// Idempotent column upgrades for existing databases
	//
	// The CREATE TABLE statements above include the final column set, so fresh
	// databases need nothing more. For databases that were created by an earlier
	// version of this migration (before all columns were consolidated), we add
	// any missing columns here.
	// -------------------------------------------------------------------------

	// space_agents: role/provider/inject_workflow_context (added by early Space previews)
	//
	// These idempotent upgrades live in the original Space schema migration, which
	// is re-run on every daemon startup. Later migrations (M74/M80) intentionally
	// remove `role` and `inject_workflow_context` and consolidate legacy
	// `system_prompt`/`instructions` into `custom_prompt`. Re-adding the removed
	// columns to an already-modern schema would cause M74 to rebuild the table on
	// every restart; before this guard, that rebuild dropped `custom_prompt` and
	// M80 repopulated it from stale `system_prompt`, silently downgrading preset
	// agent prompts. Only apply the legacy column upgrades to pre-M80 schemas.
	const spaceAgentsHaveCustomPrompt = tableHasColumn(db, 'space_agents', 'custom_prompt');
	if (!spaceAgentsHaveCustomPrompt) {
		// space_agents: role (added in former migration 30)
		try {
			db.prepare(`SELECT role FROM space_agents LIMIT 1`).all();
		} catch {
			db.exec(`ALTER TABLE space_agents ADD COLUMN role TEXT NOT NULL DEFAULT 'coder'`);
		}
	}

	// space_agents: provider (added in former migration 30; still part of the current schema)
	try {
		db.prepare(`SELECT provider FROM space_agents LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_agents ADD COLUMN provider TEXT`);
	}

	if (!spaceAgentsHaveCustomPrompt) {
		// space_agents: inject_workflow_context (added in former migration 33)
		try {
			db.prepare(`SELECT inject_workflow_context FROM space_agents LIMIT 1`).all();
		} catch {
			db.exec(
				`ALTER TABLE space_agents ADD COLUMN inject_workflow_context INTEGER NOT NULL DEFAULT 0`
			);
		}
	}

	// space_workflows: start_step_id (added in former migration 32)
	try {
		db.prepare(`SELECT start_step_id FROM space_workflows LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN start_step_id TEXT`);
	}

	// space_workflow_runs: current_step_id (added in former migration 32)
	try {
		db.prepare(`SELECT current_step_id FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN current_step_id TEXT`);
	}

	// space_workflow_transitions table (added in former migration 32) — CREATE TABLE
	// is already above with IF NOT EXISTS, so this is handled automatically.

	// Former migration 31 removed a CHECK constraint on space_agents.role that was
	// introduced by the old migration 30. On databases where that ALTER TABLE ran,
	// the constraint may still be present. Rebuild the table to remove it.
	const agentSchema = db
		.prepare<{ sql: string }, []>(
			`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_agents'`
		)
		.get();
	if (agentSchema?.sql.includes('CHECK(role IN')) {
		db.transaction(() => {
			db.exec(`
				CREATE TABLE space_agents_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					model TEXT,
					tools TEXT NOT NULL DEFAULT '[]',
					system_prompt TEXT NOT NULL DEFAULT '',
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					role TEXT NOT NULL DEFAULT 'coder',
					provider TEXT,
					inject_workflow_context INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

			// Copy all columns that existed before, filling inject_workflow_context with
			// the default for rows that pre-date that column.
			db.exec(`
				INSERT INTO space_agents_new
					(id, space_id, name, description, model, tools, system_prompt, config,
					 created_at, updated_at, role, provider, inject_workflow_context)
				SELECT
					id, space_id, name, description, model, tools, system_prompt, config,
					created_at, updated_at, role, provider,
					COALESCE(inject_workflow_context, 0)
				FROM space_agents
			`);

			db.exec(`DROP TABLE space_agents`);
			db.exec(`ALTER TABLE space_agents_new RENAME TO space_agents`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);
		})();
	}

	// -------------------------------------------------------------------------
	// Add 'spaces_global' to sessions type CHECK constraint
	// -------------------------------------------------------------------------
	// SQLite doesn't support ALTER CHECK, so we recreate the table.
	if (tableExists(db, 'sessions')) {
		try {
			const testId = '__migration_test_spaces_global_type__';
			db.prepare(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				testId,
				'Test',
				'/tmp',
				new Date().toISOString(),
				new Date().toISOString(),
				'active',
				'{}',
				'{}',
				0,
				'spaces_global'
			);
			db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
		} catch {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				db.exec(`
					CREATE TABLE sessions_new (
						id TEXT PRIMARY KEY,
						title TEXT NOT NULL,
						workspace_path TEXT NOT NULL,
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
						available_commands TEXT,
						processing_state TEXT,
						archived_at TEXT,
						parent_id TEXT,
						type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global')),
						session_context TEXT
					)
				`);
				db.exec(`
					INSERT INTO sessions_new
					SELECT id, title, workspace_path, created_at, last_active_at,
						status, config, metadata, is_worktree, worktree_path, main_repo_path,
						worktree_branch, git_branch, sdk_session_id, available_commands,
						processing_state, archived_at, parent_id, type, session_context
					FROM sessions
				`);
				db.exec(`DROP TABLE sessions`);
				db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}
}

/**
 * Migration 30: Add `layout` column to `space_workflows` for visual editor node positions.
 *
 * Stores node positions as JSON (`Record<stepId, {x, y}>`). Nullable — existing
 * workflows without layout data return NULL from the DB (mapped to undefined in code).
 */
function runMigration30(db: BunDatabase): void {
	try {
		db.prepare(`SELECT layout FROM space_workflows LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN layout TEXT`);
	}
}

/**
 * Migration 31: Add 'space_task_agent' to sessions type CHECK constraint.
 *
 * SQLite doesn't support ALTER CHECK, so we use the probe-insert + table-recreate
 * pattern: attempt to insert a row with type='space_task_agent'; if the constraint
 * rejects it, recreate the sessions table with the expanded CHECK list.
 */
function runMigration31(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) return;

	try {
		const testId = '__migration_test_space_task_agent_type__';
		db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			testId,
			'Test',
			'/tmp',
			new Date().toISOString(),
			new Date().toISOString(),
			'active',
			'{}',
			'{}',
			0,
			'space_task_agent'
		);
		db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
	} catch {
		db.exec('PRAGMA foreign_keys = OFF');
		try {
			db.exec(`
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
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
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT,
					parent_id TEXT,
					type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent')),
					session_context TEXT
				)
			`);
			db.exec(`
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at,
					status, config, metadata, is_worktree, worktree_path, main_repo_path,
					worktree_branch, git_branch, sdk_session_id, available_commands,
					processing_state, archived_at, parent_id, type, session_context
				FROM sessions
			`);
			db.exec(`DROP TABLE sessions`);
			db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 32: Add `task_agent_session_id` column to `space_tasks`.
 *
 * Stores the ID of the Task Agent session associated with this task. Nullable —
 * tasks without a Task Agent return NULL (mapped to undefined in code).
 */
function runMigration32(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;
	try {
		db.prepare(`SELECT task_agent_session_id FROM space_tasks LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN task_agent_session_id TEXT`);
	}
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
	);
}

/**
 * Migration 33: Add `autonomy_level` column to `spaces`.
 *
 * Controls how much the Space Agent can act autonomously:
 * - 'supervised' (default): notifies human of all judgment calls, waits for approval.
 * - 'semi_autonomous': retries/reassigns tasks autonomously; escalates after one failed retry.
 *
 * Default is 'supervised' so all existing spaces remain supervised after migration.
 */
function runMigration33(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;
	try {
		db.prepare(`SELECT autonomy_level FROM spaces LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE spaces ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'supervised'`);
	}
}

/**
 * Migration 34: Add goal_id column to space_tasks.
 *
 * Links space tasks to goals/missions for cross-workflow-run querying.
 * Nullable — existing tasks will have goal_id as NULL.
 */
function runMigration34(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;
	try {
		db.prepare(`SELECT goal_id FROM space_tasks LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN goal_id TEXT`);
	}
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
}

/**
 * Migration 35: Add iteration tracking columns to `space_workflow_runs`.
 *
 * - `iteration_count`: how many times the run has looped back (default 0).
 * - `max_iterations`: safety cap before escalating to needs_attention (default 5).
 */
function runMigration35(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_runs')) return;
	try {
		db.prepare(`SELECT iteration_count FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(
			`ALTER TABLE space_workflow_runs ADD COLUMN iteration_count INTEGER NOT NULL DEFAULT 0`
		);
	}
	try {
		db.prepare(`SELECT max_iterations FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 5`);
	}
}

/**
 * Migration 36: Add `max_iterations` column to `space_workflows`.
 *
 * Template-level default for the maximum number of cyclic iterations.
 * Nullable — workflows without cyclic transitions don't need a cap.
 */
function runMigration36(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;
	try {
		db.prepare(`SELECT max_iterations FROM space_workflows LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN max_iterations INTEGER`);
	}
}

/**
 * Migration 37: Add goal_id column to space_workflow_runs for goal/mission association.
 */
function runMigration37(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_runs')) return;
	try {
		db.prepare(`SELECT goal_id FROM space_workflow_runs LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN goal_id TEXT`);
	}
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_goal_id ON space_workflow_runs(goal_id)`
	);
}

/**
 * Migration 38: Add `is_cyclic` column to `space_workflow_transitions`.
 *
 * When a transition is marked as cyclic, following it increments `iterationCount`
 * on the workflow run. This enables explicit cycle detection for iterative workflows
 * without relying on heuristics that would misfire on DAG merge paths.
 *
 * Nullable INTEGER (SQLite boolean): 0 = not cyclic, 1 = cyclic, NULL = not cyclic.
 */
function runMigration38(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_transitions')) return;
	try {
		db.prepare(`SELECT is_cyclic FROM space_workflow_transitions LIMIT 1`).all();
	} catch {
		db.exec(`ALTER TABLE space_workflow_transitions ADD COLUMN is_cyclic INTEGER`);
	}
}

/**
 * Migration 39: Add 'archived' to the status CHECK constraint on `tasks` and `space_tasks`.
 *
 * Uses the SQLite table-rebuild pattern (same as migration 18) because SQLite does not
 * support ALTER TABLE … ALTER CONSTRAINT.
 *
 * After the rebuild, backfills any rows where `archived_at IS NOT NULL` to
 * `status = 'archived'` so the status column becomes the canonical source of truth.
 */
function runMigration39(db: BunDatabase): void {
	// --- tasks table ---
	if (tableExists(db, 'tasks')) {
		const tableInfo = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
			.get() as { sql: string } | null;
		const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'archived'");

		if (needsMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				db.exec(`DROP TABLE IF EXISTS tasks_new`);
				db.exec(`
					CREATE TABLE tasks_new (
						id TEXT PRIMARY KEY,
						room_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT DEFAULT '[]',
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						task_type TEXT DEFAULT 'coding'
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
						assigned_agent TEXT DEFAULT 'coder',
						created_by_task_id TEXT,
						archived_at INTEGER,
						active_session TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						input_draft TEXT,
						updated_at INTEGER,
						FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
					)
				`);

				const cols = [
					'id',
					'room_id',
					'title',
					'description',
					'status',
					'priority',
					'progress',
					'current_step',
					'result',
					'error',
					'depends_on',
					'created_at',
					'started_at',
					'completed_at',
				];
				const optionalCols = [
					'task_type',
					'assigned_agent',
					'created_by_task_id',
					'archived_at',
					'active_session',
					'pr_url',
					'pr_number',
					'pr_created_at',
					'input_draft',
					'updated_at',
				];
				for (const col of optionalCols) {
					if (tableHasColumn(db, 'tasks', col)) cols.push(col);
				}
				const selectCols = cols.join(', ');
				db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
				db.exec(`DROP TABLE tasks`);
				db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`
				);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}

		// Backfill: set status = 'archived' for rows with archived_at IS NOT NULL
		db.exec(
			`UPDATE tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'`
		);
	}

	// --- space_tasks table ---
	if (tableExists(db, 'space_tasks')) {
		const tableInfo = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
			.get() as { sql: string } | null;
		const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'archived'");

		if (needsMigration) {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				db.exec(`DROP TABLE IF EXISTS space_tasks_new`);
				db.exec(`
					CREATE TABLE space_tasks_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						task_type TEXT
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
						assigned_agent TEXT
							CHECK(assigned_agent IN ('coder', 'general')),
						custom_agent_id TEXT,
						workflow_run_id TEXT,
						workflow_step_id TEXT,
						created_by_task_id TEXT,
						goal_id TEXT,
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						input_draft TEXT,
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
						FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
					)
				`);

				const cols = ['id', 'space_id', 'title', 'description', 'status', 'priority'];
				const optionalCols = [
					'task_type',
					'assigned_agent',
					'custom_agent_id',
					'workflow_run_id',
					'workflow_step_id',
					'created_by_task_id',
					'goal_id',
					'progress',
					'current_step',
					'result',
					'error',
					'depends_on',
					'input_draft',
					'active_session',
					'task_agent_session_id',
					'pr_url',
					'pr_number',
					'pr_created_at',
					'archived_at',
					'created_at',
					'started_at',
					'completed_at',
					'updated_at',
				];
				for (const col of optionalCols) {
					if (tableHasColumn(db, 'space_tasks', col)) cols.push(col);
				}
				const selectCols = cols.join(', ');
				db.exec(
					`INSERT INTO space_tasks_new (${selectCols}) SELECT ${selectCols} FROM space_tasks`
				);
				db.exec(`DROP TABLE space_tasks`);
				db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_step_id ON space_tasks(workflow_step_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
				);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}

		// Backfill: set status = 'archived' for rows with archived_at IS NOT NULL
		db.exec(
			`UPDATE space_tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'`
		);
	}
}

/**
 * Migration 40: Flexible session groups.
 *
 * space_session_groups:
 *   - Add `task_id TEXT` (nullable) — links group to SpaceTask
 *   - Add `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed'))`
 *   - Add index on space_session_groups(task_id)
 *
 * space_session_group_members:
 *   - Drop the CHECK constraint on `role` so it accepts any freeform string
 *   - Add `agent_id TEXT` (nullable) — references SpaceAgent config
 *   - Add `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed'))`
 *
 * SQLite cannot drop CHECK constraints via ALTER TABLE, so space_session_group_members
 * uses the recreate-table pattern (same as migrations 18 and 39).
 * ALTER TABLE ADD COLUMN is used for the two new space_session_groups columns because
 * no constraint change is needed there.
 */
function runMigration40(db: BunDatabase): void {
	// -------------------------------------------------------------------------
	// space_session_groups — add task_id and status via ALTER TABLE (idempotent)
	// -------------------------------------------------------------------------
	if (tableExists(db, 'space_session_groups')) {
		if (!tableHasColumn(db, 'space_session_groups', 'task_id')) {
			db.exec(`ALTER TABLE space_session_groups ADD COLUMN task_id TEXT`);
		}
		if (!tableHasColumn(db, 'space_session_groups', 'status')) {
			db.exec(
				`ALTER TABLE space_session_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed'))`
			);
		}
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_session_groups_task_id ON space_session_groups(task_id)`
		);
	}

	// -------------------------------------------------------------------------
	// space_session_group_members — recreate table to drop role CHECK constraint
	// and add agent_id + status columns.
	//
	// Idempotency guard: if agent_id already exists the migration has already run.
	// -------------------------------------------------------------------------
	if (
		tableExists(db, 'space_session_group_members') &&
		!tableHasColumn(db, 'space_session_group_members', 'agent_id')
	) {
		db.exec('PRAGMA foreign_keys = OFF');
		try {
			db.exec(`DROP TABLE IF EXISTS space_session_group_members_new`);
			db.exec(`
				CREATE TABLE space_session_group_members_new (
					id TEXT PRIMARY KEY,
					group_id TEXT NOT NULL,
					session_id TEXT NOT NULL,
					role TEXT NOT NULL,
					agent_id TEXT,
					status TEXT NOT NULL DEFAULT 'active'
						CHECK(status IN ('active', 'completed', 'failed')),
					order_index INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE,
					UNIQUE(group_id, session_id)
				)
			`);

			// Copy existing columns; agent_id and status get their defaults
			const cols = ['id', 'group_id', 'session_id', 'role', 'order_index', 'created_at'];
			const selectCols = cols.join(', ');
			db.exec(
				`INSERT INTO space_session_group_members_new (${selectCols}) SELECT ${selectCols} FROM space_session_group_members`
			);
			db.exec(`DROP TABLE space_session_group_members`);
			db.exec(`ALTER TABLE space_session_group_members_new RENAME TO space_session_group_members`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_group_id ON space_session_group_members(group_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_session_id ON space_session_group_members(session_id)`
			);
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 41: Historical no-op.
 *
 * Kept for migration-number continuity. The former session_group_messages
 * projection table path was removed; canonical timeline data now comes from
 * sdk_messages + task_group_events.
 */
function runMigration41(_db: BunDatabase): void {
	// No-op.
}

/**
 * Migration 42: Clean up stale/zombie session groups and enforce uniqueness.
 *
 * Step 1: Mark active groups as completed when their task is in a terminal state
 *         (completed, cancelled, archived, needs_attention). These are zombie groups
 *         that were never cleaned up when the task finished.
 *
 * Step 2: For tasks that still have multiple active groups after step 1, keep the
 *         one with the highest rowid (the true insert order tiebreaker), and mark all
 *         others as completed. Uses rowid instead of created_at to avoid failures when
 *         two groups share an identical millisecond timestamp.
 *
 * Step 3: Add a partial unique index on session_groups(ref_id) WHERE completed_at IS NULL,
 *         scoped to task/task_pair group types, to enforce DB-level uniqueness.
 */
function runMigration42(db: BunDatabase): void {
	if (!tableExists(db, 'session_groups') || !tableExists(db, 'tasks')) {
		return;
	}

	const now = Date.now();

	// Step 1: Complete groups whose tasks are already in a terminal state.
	// Includes 'needs_attention' (the renamed 'failed' status from migration 24).
	db.prepare(
		`UPDATE session_groups
		 SET completed_at = ?, version = version + 1
		 WHERE completed_at IS NULL
		   AND group_type IN ('task', 'task_pair')
		   AND ref_id IN (
		     SELECT id FROM tasks
		     WHERE status IN ('completed', 'cancelled', 'archived', 'needs_attention')
		   )`
	).run(now);

	// Step 2: For tasks with multiple active groups, keep the one with the highest rowid
	// (true insert order, no timestamp tie risk) and complete all others.
	const duplicateTasks = db
		.prepare(
			`SELECT ref_id, MAX(rowid) AS max_rowid
			 FROM session_groups
			 WHERE completed_at IS NULL AND group_type IN ('task', 'task_pair')
			 GROUP BY ref_id
			 HAVING COUNT(*) > 1`
		)
		.all() as { ref_id: string; max_rowid: number }[];

	for (const { ref_id, max_rowid } of duplicateTasks) {
		db.prepare(
			`UPDATE session_groups
			 SET completed_at = ?, version = version + 1
			 WHERE ref_id = ? AND completed_at IS NULL AND rowid < ?`
		).run(now, ref_id, max_rowid);
	}

	// Step 3: Add partial unique index — only one active task/task_pair group per ref_id.
	// Scoped to task/task_pair so future group types with different semantics can share
	// ref_id values without violating this constraint.
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_active_ref
		 ON session_groups(ref_id) WHERE completed_at IS NULL AND (group_type = 'task' OR group_type = 'task_pair')`
	);
}

/**
 * Migration 43: Drop legacy session_group_messages projection table.
 *
 * The canonical group timeline now comes from sdk_messages + task_group_events.
 * Keeping this mirror table risks drift and confusion after daemon restarts.
 */
function runMigration43(db: BunDatabase): void {
	db.exec(`DROP INDEX IF EXISTS idx_sgm_group`);
	db.exec(`DROP TABLE IF EXISTS session_group_messages`);
}

/**
 * Migration 44: Rename sdk_messages.send_status values.
 *
 * Old values: saved, queued, sent, failed
 * New values: deferred, enqueued, consumed, failed
 */
function runMigration44(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}

	const tableInfo = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sdk_messages'`)
		.get() as { sql: string } | null;

	if (!tableInfo) {
		return;
	}

	// Already migrated
	if (tableInfo.sql.includes("'deferred'") && tableInfo.sql.includes("'consumed'")) {
		return;
	}

	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		db.exec(`PRAGMA ignore_check_constraints = 1`);
		db.exec(`
			UPDATE sdk_messages
			SET send_status = CASE
				WHEN send_status = 'saved' THEN 'deferred'
				WHEN send_status = 'queued' THEN 'enqueued'
				WHEN send_status = 'sent' THEN 'consumed'
				WHEN send_status IS NULL THEN 'consumed'
				ELSE send_status
			END
		`);
		db.exec(`PRAGMA ignore_check_constraints = 0`);

		db.exec(`
			CREATE TABLE sdk_messages_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
		db.exec(`INSERT INTO sdk_messages_new SELECT * FROM sdk_messages`);
		db.exec(`DROP TABLE sdk_messages`);
		db.exec(`ALTER TABLE sdk_messages_new RENAME TO sdk_messages`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_id ON sdk_messages(session_id)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
		);
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 45: Rename step-related columns and tables to node
 *
 * Renames:
 * - space_workflow_steps -> space_workflow_nodes
 * - space_workflows.start_step_id -> start_node_id
 * - space_workflow_transitions.from_step_id -> from_node_id
 * - space_workflow_transitions.to_step_id -> to_node_id
 * - space_tasks.workflow_step_id -> workflow_node_id
 * - space_workflow_runs.current_step_id -> current_node_id
 * - space_session_groups.current_step_id -> current_node_id
 *
 * Uses create-copy-drop-rename pattern for SQLite compatibility.
 */
function runMigration45(db: BunDatabase): void {
	// Skip if space_workflow_steps was already renamed to space_workflow_nodes,
	// or if the spaces feature was never enabled on this DB.
	// Also skip if space_workflow_nodes already exists (migration was already applied).
	if (!tableExists(db, 'space_workflow_steps') || tableExists(db, 'space_workflow_nodes')) {
		return;
	}

	// Issue PRAGMA before BEGIN so it takes effect (SQLite ignores PRAGMA inside a transaction)
	db.exec(`PRAGMA foreign_keys = OFF`);
	db.exec(`BEGIN`);
	try {
		// -------------------------------------------------------------------------
		// 1. Rename space_workflow_steps -> space_workflow_nodes
		// -------------------------------------------------------------------------
		db.exec(`DROP TABLE IF EXISTS space_workflow_nodes_new`);
		db.exec(`
				CREATE TABLE space_workflow_nodes_new (
					id TEXT PRIMARY KEY,
					workflow_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					agent_id TEXT,
					order_index INTEGER NOT NULL,
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
				)
			`);
		db.exec(`
				INSERT INTO space_workflow_nodes_new
				SELECT id, workflow_id, name, description, agent_id, order_index, config, created_at, updated_at
				FROM space_workflow_steps
			`);
		db.exec(`DROP TABLE space_workflow_steps`);
		db.exec(`ALTER TABLE space_workflow_nodes_new RENAME TO space_workflow_nodes`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_order ON space_workflow_nodes(workflow_id, order_index)`
		);

		// -------------------------------------------------------------------------
		// 2. Rename space_workflows.start_step_id -> start_node_id
		// Also preserve columns added by M30 (layout) and M36 (max_iterations)
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_workflows', 'start_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_workflows_new`);
			db.exec(`
					CREATE TABLE space_workflows_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						name TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						start_node_id TEXT,
						config TEXT,
						layout TEXT,
						max_iterations INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
			db.exec(`
					INSERT INTO space_workflows_new
					SELECT id, space_id, name, description, start_step_id, config, layout, max_iterations, created_at, updated_at
					FROM space_workflows
				`);
			db.exec(`DROP TABLE space_workflows`);
			db.exec(`ALTER TABLE space_workflows_new RENAME TO space_workflows`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 3. Rename space_workflow_transitions.from_step_id -> from_node_id
		//                          and space_workflow_transitions.to_step_id -> to_node_id
		// Also preserve is_cyclic column added by M38
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_workflow_transitions', 'from_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_workflow_transitions_new`);
			db.exec(`
					CREATE TABLE space_workflow_transitions_new (
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
					INSERT INTO space_workflow_transitions_new
					SELECT id, workflow_id, from_step_id, to_step_id, condition, order_index, is_cyclic, created_at, updated_at
					FROM space_workflow_transitions
				`);
			db.exec(`DROP TABLE space_workflow_transitions`);
			db.exec(`ALTER TABLE space_workflow_transitions_new RENAME TO space_workflow_transitions`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_workflow_id ON space_workflow_transitions(workflow_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_from_node ON space_workflow_transitions(workflow_id, from_node_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 4. Rename space_workflow_runs.current_step_id -> current_node_id
		// Also preserve columns added by M35 (iteration_count, max_iterations) and M37 (goal_id)
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_workflow_runs', 'current_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_workflow_runs_new`);
			db.exec(`
					CREATE TABLE space_workflow_runs_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						workflow_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						current_step_index INTEGER NOT NULL DEFAULT 0,
						current_node_id TEXT,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
						config TEXT,
						iteration_count INTEGER NOT NULL DEFAULT 0,
						max_iterations INTEGER NOT NULL DEFAULT 5,
						goal_id TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						completed_at INTEGER,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
					)
				`);
			db.exec(`
					INSERT INTO space_workflow_runs_new
					SELECT id, space_id, workflow_id, title, description, current_step_index, current_step_id, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at, completed_at
					FROM space_workflow_runs
				`);
			db.exec(`DROP TABLE space_workflow_runs`);
			db.exec(`ALTER TABLE space_workflow_runs_new RENAME TO space_workflow_runs`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_goal_id ON space_workflow_runs(goal_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 5. Rename space_tasks.workflow_step_id -> workflow_node_id
		// Also preserves goal_id column added by M34
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_tasks', 'workflow_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_tasks_new`);
			db.exec(`
					CREATE TABLE space_tasks_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						task_type TEXT
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
						assigned_agent TEXT
							CHECK(assigned_agent IN ('coder', 'general')),
						custom_agent_id TEXT,
						workflow_run_id TEXT,
						workflow_node_id TEXT,
						created_by_task_id TEXT,
						goal_id TEXT,
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						input_draft TEXT,
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
						FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
					)
				`);
			db.exec(`
					INSERT INTO space_tasks_new
					SELECT id, space_id, title, description, status, priority, task_type, assigned_agent,
								 custom_agent_id, workflow_run_id, workflow_step_id, created_by_task_id, goal_id,
								 progress, current_step, result, error, depends_on, input_draft, active_session,
								 task_agent_session_id, pr_url, pr_number, pr_created_at, archived_at,
								 created_at, started_at, completed_at, updated_at
					FROM space_tasks
				`);
			db.exec(`DROP TABLE space_tasks`);
			db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
			);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
			);
		}

		// -------------------------------------------------------------------------
		// 6. Rename space_session_groups.current_step_id -> current_node_id
		// Also preserves status column added by M40
		// -------------------------------------------------------------------------
		if (tableHasColumn(db, 'space_session_groups', 'current_step_id')) {
			db.exec(`DROP TABLE IF EXISTS space_session_groups_new`);
			db.exec(`
					CREATE TABLE space_session_groups_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						name TEXT NOT NULL,
						description TEXT,
						workflow_run_id TEXT,
						current_node_id TEXT,
						task_id TEXT,
						status TEXT NOT NULL DEFAULT 'active'
							CHECK(status IN ('active', 'completed', 'failed')),
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
			db.exec(`
					INSERT INTO space_session_groups_new
					SELECT id, space_id, name, description, workflow_run_id, current_step_id, task_id, status, created_at, updated_at
					FROM space_session_groups
				`);
			db.exec(`DROP TABLE space_session_groups`);
			db.exec(`ALTER TABLE space_session_groups_new RENAME TO space_session_groups`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_groups_space_id ON space_session_groups(space_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_session_groups_task_id ON space_session_groups(task_id)`
			);
		}

		db.exec(`COMMIT`);
	} catch (e) {
		db.exec(`ROLLBACK`);
		throw e;
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 46: Add slot_role column to space_tasks.
 *
 * Stores the `WorkflowNodeAgent.role` of the specific agent slot that spawned a task.
 * This allows `spawn_node_agent` to unambiguously identify the correct slot even when
 * the same `agentId` appears multiple times in a node with different slot roles and overrides.
 *
 * Existing rows get NULL for slot_role (backward compatible — the old lookup-by-agentId
 * path handles the null case by falling back to the first matching slot).
 */
function runMigration46(db: BunDatabase): void {
	if (!tableHasColumn(db, 'space_tasks', 'slot_role')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN slot_role TEXT`);
	}
}

/**
 * Migration 47: Add short_id columns to tasks and goals; create short_id_counters table.
 *
 * - `tasks.short_id TEXT` — nullable, unique within room (partial composite index).
 * - `goals.short_id TEXT` — nullable, unique within room (partial composite index).
 * - `short_id_counters` — per-(entity_type, scope_id) monotonic counter used by the
 *   ShortIdAllocator service when assigning short IDs to new or existing records.
 *
 * Idempotent: ALTER TABLE is guarded by tableHasColumn(); CREATE TABLE/INDEX use IF NOT EXISTS.
 *
 * NOTE: The original migration 47 accidentally created single-column global indexes
 * (idx_tasks_short_id, idx_goals_short_id) instead of room-scoped composite indexes.
 * Migration 48 corrects this on already-deployed DBs.
 */
export function runMigration47(db: BunDatabase): void {
	// On existing DBs, ALTER TABLE adds the column; on fresh DBs the column is already
	// present in the CREATE TABLE statement in createTables(), so tableHasColumn() guards
	// prevent a duplicate-column error.
	if (tableExists(db, 'tasks') && !tableHasColumn(db, 'tasks', 'short_id')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN short_id TEXT`);
	}
	if (tableExists(db, 'goals') && !tableHasColumn(db, 'goals', 'short_id')) {
		db.exec(`ALTER TABLE goals ADD COLUMN short_id TEXT`);
	}

	// Partial unique indexes — scoped to (room_id, short_id) so different rooms can each
	// have their own t-1, t-2, ... sequence without global uniqueness collisions.
	// Also created by createTables() via IF NOT EXISTS.
	if (tableExists(db, 'tasks')) {
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
		);
	}
	if (tableExists(db, 'goals')) {
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_room_short_id ON goals(room_id, short_id) WHERE short_id IS NOT NULL`
		);
	}

	// Counter table — also created by createTables() for fresh DBs; IF NOT EXISTS is idempotent.
	db.exec(`
		CREATE TABLE IF NOT EXISTS short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		)
	`);
}

/**
 * Migration 48: Replace global short_id unique indexes with room-scoped composite indexes.
 *
 * Migration 47 accidentally created single-column indexes:
 *   CREATE UNIQUE INDEX idx_tasks_short_id ON tasks(short_id)
 *   CREATE UNIQUE INDEX idx_goals_short_id ON goals(short_id)
 *
 * These are global: two tasks in different rooms both getting short_id='t-1' would violate
 * the constraint. Short IDs are scoped to their parent room, so the correct constraint is:
 *   (room_id, short_id) must be unique, not just (short_id).
 *
 * This migration drops the old global indexes (if they exist) and creates correct room-scoped
 * composite indexes. Idempotent via DROP IF EXISTS + CREATE IF NOT EXISTS.
 */
export function runMigration48(db: BunDatabase): void {
	if (tableExists(db, 'tasks')) {
		// Drop old global index if present (created by old migration 47 code)
		db.exec(`DROP INDEX IF EXISTS idx_tasks_short_id`);
		// Create correct room-scoped composite index
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
		);
	}
	if (tableExists(db, 'goals')) {
		// Drop old global index if present
		db.exec(`DROP INDEX IF EXISTS idx_goals_short_id`);
		// Create correct room-scoped composite index
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_room_short_id ON goals(room_id, short_id) WHERE short_id IS NOT NULL`
		);
	}
}

/**
 * Migration 49: Add restrictions column to tasks; expand status CHECK constraint.
 *
 * - `tasks.restrictions TEXT` — nullable JSON blob storing TaskRestriction data when a
 *   task is paused due to an API rate or usage limit. Cleared when the task resumes.
 *
 * - Status CHECK constraint gains two new values:
 *   - `rate_limited`  — task paused because of an HTTP 429 rate limit
 *   - `usage_limited` — task paused because of a daily/weekly usage cap with no fallback
 *
 * SQLite does not support ALTER TABLE to modify a CHECK constraint, so the new values
 * are added by recreating the tasks table with DROP/INSERT SELECT/RENAME. This is
 * idempotent: if the column or the new status values already exist the migration is a no-op.
 */
export function runMigration49(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) return;

	// Add the restrictions column if absent (new databases already have it via createTables).
	if (!tableHasColumn(db, 'tasks', 'restrictions')) {
		db.exec(`ALTER TABLE tasks ADD COLUMN restrictions TEXT`);
	}

	// Expand the status CHECK constraint to include the two new values.
	// SQLite cannot ALTER a CHECK constraint directly, so we recreate the table.
	// Guard: if the constraint already includes 'rate_limited' (detectable via sqlite_master),
	// skip the rebuild to avoid unnecessary work on already-migrated databases.
	const schemaSql = (
		db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as
			| { sql: string }
			| undefined
	)?.sql;

	if (schemaSql && schemaSql.includes('rate_limited')) {
		// Already migrated — constraint already contains new statuses.
		return;
	}

	// Recreate with expanded CHECK constraint.
	db.exec(`DROP TABLE IF EXISTS tasks_migration49_new`);
	db.exec(`
		CREATE TABLE tasks_migration49_new (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft','pending','in_progress','review','completed','needs_attention','cancelled','archived','rate_limited','usage_limited')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low','normal','high','urgent')),
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT DEFAULT '[]',
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			task_type TEXT DEFAULT 'coding'
				CHECK(task_type IN ('planning','coding','research','design','goal_review')),
			assigned_agent TEXT DEFAULT 'coder',
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
	// Build INSERT SELECT dynamically: only select columns that exist in the old table,
	// falling back to NULL for optional columns that may be absent in old-schema DBs.
	// This makes the migration safe against DBs created by migrations 16–48 that lacked
	// optional columns (e.g. created_by_task_id, archived_at, pr_url, short_id, etc.).
	const oldColumns = new Set(
		(db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((r) => r.name)
	);
	// All columns present in tasks_migration49_new, in order.
	const allNewColumns = [
		'id',
		'room_id',
		'title',
		'description',
		'status',
		'priority',
		'progress',
		'current_step',
		'result',
		'error',
		'depends_on',
		'created_at',
		'started_at',
		'completed_at',
		'task_type',
		'assigned_agent',
		'created_by_task_id',
		'archived_at',
		'active_session',
		'pr_url',
		'pr_number',
		'pr_created_at',
		'input_draft',
		'updated_at',
		'short_id',
		'restrictions',
	];
	const selectExpr = allNewColumns
		.map((col) => (oldColumns.has(col) ? col : `NULL AS ${col}`))
		.join(', ');
	db.exec(`INSERT INTO tasks_migration49_new SELECT ${selectExpr} FROM tasks`);
	db.exec(`DROP TABLE tasks`);
	db.exec(`ALTER TABLE tasks_migration49_new RENAME TO tasks`);

	// Restore indexes (IF NOT EXISTS is idempotent).
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
	);
}

/**
 * Migration 51: Rename space_tasks.slot_role → agent_name; add completion_summary column.
 *
 * As part of the agent-centric collaboration refactor:
 * - `slot_role` is renamed to `agent_name` — the field now stores the plain agent name
 *   that identifies which agent spawned this task, rather than a workflow-slot role label.
 * - `completion_summary TEXT` is added — a brief human-readable summary written by the agent
 *   when a task reaches a terminal state (completed/needs_attention/cancelled).
 *
 * Renaming requires a full table recreate (SQLite has limited ALTER TABLE support).
 * The INSERT SELECT maps slot_role → agent_name and sets completion_summary to NULL for
 * existing rows (backward compatible).
 *
 * Idempotent: guarded by tableHasColumn() checks.
 */
export function runMigration51(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;

	const hasSlotRole = tableHasColumn(db, 'space_tasks', 'slot_role');
	const hasAgentName = tableHasColumn(db, 'space_tasks', 'agent_name');
	const hasCompletionSummary = tableHasColumn(db, 'space_tasks', 'completion_summary');

	if (!hasSlotRole && hasAgentName && hasCompletionSummary) {
		// Already fully migrated — nothing to do.
		return;
	}

	// Post-M73 guard: if task_type column is absent, M73 has already rebuilt space_tasks
	// with the new schema (removing task_type, agent_name, slot_role, etc.) and new status
	// values. M51's table rebuild would fail because it uses the old CHECK constraint
	// (which rejects 'open', 'done', 'blocked'). Return early — M51 is superseded by M73.
	if (!tableHasColumn(db, 'space_tasks', 'task_type')) {
		return;
	}

	db.exec(`PRAGMA foreign_keys = OFF`);
	try {
		db.exec(`BEGIN`);

		if (hasSlotRole) {
			// Recreate the table, mapping slot_role → agent_name and adding completion_summary.
			db.exec(`DROP TABLE IF EXISTS space_tasks_m51_new`);
			db.exec(`
				CREATE TABLE space_tasks_m51_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					title TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL DEFAULT 'pending'
						CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
					priority TEXT NOT NULL DEFAULT 'normal'
						CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
					task_type TEXT
						CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
					assigned_agent TEXT
						CHECK(assigned_agent IN ('coder', 'general')),
					custom_agent_id TEXT,
					agent_name TEXT,
					workflow_run_id TEXT,
					workflow_node_id TEXT,
					created_by_task_id TEXT,
					goal_id TEXT,
					progress INTEGER,
					current_step TEXT,
					result TEXT,
					error TEXT,
					completion_summary TEXT,
					depends_on TEXT NOT NULL DEFAULT '[]',
					input_draft TEXT,
					active_session TEXT
						CHECK(active_session IN ('worker', 'leader')),
					task_agent_session_id TEXT,
					pr_url TEXT,
					pr_number INTEGER,
					pr_created_at INTEGER,
					archived_at INTEGER,
					created_at INTEGER NOT NULL,
					started_at INTEGER,
					completed_at INTEGER,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
					FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
					FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
				)
			`);

			// Build the INSERT SELECT dynamically to handle optional columns that may be absent
			// on databases created by very early migrations before certain ALTER TABLE additions.
			const existingCols = new Set(
				(db.prepare(`PRAGMA table_info(space_tasks)`).all() as Array<{ name: string }>).map(
					(r) => r.name
				)
			);
			const colOrNull = (col: string) => (existingCols.has(col) ? col : `NULL AS ${col}`);

			db.exec(`
				INSERT INTO space_tasks_m51_new
				SELECT
					id,
					space_id,
					title,
					description,
					status,
					priority,
					${colOrNull('task_type')},
					${colOrNull('assigned_agent')},
					${colOrNull('custom_agent_id')},
					slot_role AS agent_name,
					${colOrNull('workflow_run_id')},
					${colOrNull('workflow_node_id')},
					${colOrNull('created_by_task_id')},
					${colOrNull('goal_id')},
					${colOrNull('progress')},
					${colOrNull('current_step')},
					${colOrNull('result')},
					${colOrNull('error')},
					NULL AS completion_summary,
					depends_on,
					${colOrNull('input_draft')},
					${colOrNull('active_session')},
					${colOrNull('task_agent_session_id')},
					${colOrNull('pr_url')},
					${colOrNull('pr_number')},
					${colOrNull('pr_created_at')},
					${colOrNull('archived_at')},
					created_at,
					${colOrNull('started_at')},
					${colOrNull('completed_at')},
					updated_at
				FROM space_tasks
			`);

			db.exec(`DROP TABLE space_tasks`);
			db.exec(`ALTER TABLE space_tasks_m51_new RENAME TO space_tasks`);

			// Restore indexes.
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
			);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
			);
		} else if (!hasCompletionSummary) {
			// agent_name already exists (partial migration or fresh DB scenario);
			// just add the missing completion_summary column.
			db.exec(`ALTER TABLE space_tasks ADD COLUMN completion_summary TEXT`);
		}

		db.exec(`COMMIT`);
	} catch (e) {
		db.exec(`ROLLBACK`);
		throw e;
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 50: Create app_mcp_servers table for application-level MCP server registry.
 * This table stores MCP server configurations that are available globally to any room or session.
 * Idempotent via CREATE TABLE IF NOT EXISTS.
 */
export function runMigration50(db: BunDatabase): void {
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
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
}

/**
 * Migration 52: Create room_mcp_enablement table for per-room MCP enablement overrides.
 *
 * Stores which registry servers are explicitly enabled/disabled per room.
 * ON DELETE CASCADE on both FKs ensures orphaned rows are removed when a room or
 * app_mcp_servers entry is deleted.
 */
export function runMigration52(db: BunDatabase): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS room_mcp_enablement (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (room_id, server_id)
    )
  `);
}

/**

 * Migration 53: Add channels column to space_workflows.
 *
 * Channels move out of the config JSON blob into a dedicated TEXT column that stores a
 * JSON-serialized WorkflowChannel[] array. This makes the channel topology a first-class
 * column rather than a nested JSON field, simplifying repository reads/writes.
 *
 * For existing rows, channels are extracted from the config JSON and written to the new
 * column so that no data is lost. The config JSON is updated in-place with channels removed.
 *
 * Idempotent via tableHasColumn guard.
 */
export function runMigration53(db: BunDatabase): void {
	if (!tableHasColumn(db, 'space_workflows', 'channels')) {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN channels TEXT`);

		// Migrate existing rows: pull channels out of config JSON into the new column.
		const rows = db
			.prepare(`SELECT id, config FROM space_workflows WHERE config IS NOT NULL`)
			.all() as Array<{ id: string; config: string }>;

		for (const row of rows) {
			let cfg: Record<string, unknown>;
			try {
				cfg = JSON.parse(row.config) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (!cfg.channels) continue;

			const channelsJson = JSON.stringify(cfg.channels);
			delete cfg.channels;
			const updatedConfig = JSON.stringify(cfg);

			db.prepare(`UPDATE space_workflows SET channels = ?, config = ? WHERE id = ?`).run(
				channelsJson,
				updatedConfig,
				row.id
			);
		}
	}
}

/**
 * Migration 54: Add unique partial index on space_tasks for lazy node activation.
 *
 * Enforces at-most-one in-flight task per (workflow_run_id, workflow_node_id, agent_name)
 * tuple, preventing duplicate tasks when multiple concurrent ChannelRouter.activateNode()
 * calls race to activate the same node.
 *
 * The partial WHERE clause restricts the uniqueness guarantee to "active" statuses only:
 * pending, in_progress, review, rate_limited, usage_limited.
 *
 * Excluded statuses and rationale:
 * - completed / cancelled / needs_attention / archived: terminal statuses excluded so
 *   cyclic workflows can re-activate a node after tasks finish, and failed activations
 *   can be retried.
 * - draft: intentionally excluded because ChannelRouter never creates draft tasks and
 *   draft is reserved for externally-managed tasks not yet ready to run. Two draft
 *   tasks for the same slot may coexist; external callers own their uniqueness.
 *
 * The NULL exclusions preserve backward-compat with legacy tasks that predate the
 * channel/slot system (agentId-shorthand tasks with NULL workflow_node_id or agent_name).
 *
 * Idempotent via CREATE UNIQUE INDEX IF NOT EXISTS.
 */
export function runMigration54(db: BunDatabase): void {
	// Guard: only create the index when the required columns exist.
	// `workflow_node_id` may still be named `workflow_step_id` on DBs whose migration 39
	// rebuild ran after migration 45's rename (an uncommon but valid test-fixture path).
	// `agent_name` was added by migration 51 (renamed from slot_role added by migration 46);
	// guard prevents failure on older DB states.
	if (
		!tableExists(db, 'space_tasks') ||
		!tableHasColumn(db, 'space_tasks', 'workflow_node_id') ||
		!tableHasColumn(db, 'space_tasks', 'agent_name')
	) {
		return;
	}
	db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_space_tasks_run_node_agent
    ON space_tasks (workflow_run_id, workflow_node_id, agent_name)
    WHERE workflow_run_id IS NOT NULL
      AND workflow_node_id IS NOT NULL
      AND agent_name IS NOT NULL
      AND status IN ('pending', 'in_progress', 'review', 'rate_limited', 'usage_limited')
  `);
}

/**
 * Migration 55: Rename slot_role → agent_name on space_tasks.
 *
 * Aligns with the "no role" naming convention from the agent-centric refactor.
 * Note: completion_summary was already added and slot_role → agent_name was already renamed
 * by Migration 51 (which runs before this migration). This migration is kept for recovery:
 * if a prior migration left the table in a partially migrated state (e.g. crash between
 * M51's table rebuild and index recreation), this migration's idempotency check will detect
 * a pre-existing agent_name column and skip, or rebuild to restore indexes.
 *
 * Uses a table rebuild pattern because SQLite does not support DROP COLUMN on all versions.
 * Idempotent: checks for agent_name column before rebuilding.
 */
export function runMigration55(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) {
		return;
	}

	// Idempotency check: if agent_name already exists, migration is done
	try {
		db.prepare(`SELECT agent_name FROM space_tasks LIMIT 1`).all();
		return; // already migrated
	} catch {
		// agent_name doesn't exist — proceed with migration (unless M71 already cleaned up)
	}

	// Post-M71 guard: if task_type column is absent, M71 has already removed the columns
	// that this migration operates on. Nothing to do.
	if (!tableHasColumn(db, 'space_tasks', 'task_type')) {
		return;
	}

	// Issue PRAGMA before BEGIN so it takes effect (SQLite ignores PRAGMA inside a transaction)
	db.exec(`PRAGMA foreign_keys = OFF`);
	db.exec(`BEGIN`);
	try {
		// Crash-recovery guard: drop leftover temp table if a previous run crashed mid-migration
		db.exec(`DROP TABLE IF EXISTS space_tasks_new`);

		// Rebuild the table with agent_name instead of slot_role.
		// completion_summary already exists (added by M51) and is preserved via SELECT.
		db.exec(`
			CREATE TABLE space_tasks_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived', 'rate_limited', 'usage_limited')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
				custom_agent_id TEXT,
				agent_name TEXT,
				completion_summary TEXT,
				workflow_run_id TEXT,
				workflow_node_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
			)
		`);

		db.exec(`
			INSERT INTO space_tasks_new (
				id, space_id, title, description, status, priority, task_type, assigned_agent,
				custom_agent_id, agent_name, completion_summary, workflow_run_id, workflow_node_id,
				created_by_task_id, goal_id, progress, current_step, result, error, depends_on,
				input_draft, active_session, task_agent_session_id, pr_url, pr_number, pr_created_at,
				archived_at, created_at, started_at, completed_at, updated_at
			)
			SELECT
				id, space_id, title, description, status, priority, task_type, assigned_agent,
				custom_agent_id, slot_role, completion_summary, workflow_run_id, workflow_node_id,
				created_by_task_id, goal_id, progress, current_step, result, error, depends_on,
				input_draft, active_session, task_agent_session_id, pr_url, pr_number, pr_created_at,
				archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

		db.exec(`DROP TABLE space_tasks`);
		db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
		db.exec(`COMMIT`);
	} catch (err) {
		db.exec(`ROLLBACK`);
		throw err;
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}

	// Recreate all indexes that existed on space_tasks (dropped by DROP TABLE above)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
	);
	// Recreate the unique index from M54, now on agent_name instead of slot_role.
	db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_space_tasks_run_node_agent
    ON space_tasks (workflow_run_id, workflow_node_id, agent_name)
    WHERE workflow_run_id IS NOT NULL
      AND workflow_node_id IS NOT NULL
      AND agent_name IS NOT NULL
      AND status IN ('pending', 'in_progress', 'review', 'rate_limited', 'usage_limited')
  `);
}

/**
 * Migration 56: Expand assigned_agent CHECK constraint to include 'planner'.
 *
 * The tasks table CHECK constraint on assigned_agent was previously:
 *   CHECK(assigned_agent IN ('coder', 'general'))
 *
 * We now also allow 'planner' so that goal_review tasks can be assigned to the
 * Planner/Leader agent.
 *
 * SQLite cannot ALTER a CHECK constraint directly, so we recreate the table.
 */
export function runMigration56(db: BunDatabase): void {
	if (!tableExists(db, 'tasks')) return;

	// Guard: if the constraint already includes 'planner', skip the rebuild.
	const schemaSql = (
		db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as
			| { sql: string }
			| undefined
	)?.sql;

	if (schemaSql && schemaSql.includes('planner')) {
		return;
	}

	// Recreate with expanded CHECK constraint.
	db.exec(`DROP TABLE IF EXISTS tasks_migration56_new`);
	db.exec(`
		CREATE TABLE tasks_migration56_new (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft','pending','in_progress','review','completed','needs_attention','cancelled','archived','rate_limited','usage_limited')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low','normal','high','urgent')),
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT DEFAULT '[]',
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			task_type TEXT DEFAULT 'coding'
				CHECK(task_type IN ('planning','coding','research','design','goal_review')),
			assigned_agent TEXT DEFAULT 'coder'
				CHECK(assigned_agent IN ('coder','general','planner')),
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

	// Build INSERT SELECT dynamically: only select columns that exist in the old table.
	const oldColumns = new Set(
		(db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((r) => r.name)
	);
	const allNewColumns = [
		'id',
		'room_id',
		'title',
		'description',
		'status',
		'priority',
		'progress',
		'current_step',
		'result',
		'error',
		'depends_on',
		'created_at',
		'started_at',
		'completed_at',
		'task_type',
		'assigned_agent',
		'created_by_task_id',
		'archived_at',
		'active_session',
		'pr_url',
		'pr_number',
		'pr_created_at',
		'input_draft',
		'updated_at',
		'short_id',
		'restrictions',
	];
	const insertColumns = allNewColumns.filter((c) => oldColumns.has(c));
	const selectClause = insertColumns.map((c) => `"${c}"`).join(', ');
	db.exec(`INSERT INTO tasks_migration56_new (${selectClause}) SELECT ${selectClause} FROM tasks`);
	db.exec(`DROP TABLE tasks`);
	db.exec(`ALTER TABLE tasks_migration56_new RENAME TO tasks`);

	// Restore indexes (dropped by DROP TABLE). Matches the set created by migration 49.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
	);
}

/**
 * Migration 57: Create skills table for application-level Skills registry.
 * Skills are available globally to any room or session that enables them.
 * Idempotent via CREATE TABLE IF NOT EXISTS.
 */
export function runMigration57(db: BunDatabase): void {
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
}

/**
 * Migration 58: Create room_skill_overrides table for per-room skill enablement.
 * Mirrors the room_mcp_enablement pattern (migration 52) but references skills(id).
 * Idempotent via CREATE TABLE IF NOT EXISTS.
 */
export function runMigration58(db: BunDatabase): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS room_skill_overrides (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (skill_id, room_id)
    )
  `);
}

/**
 * Migration 59: Drop space_workflow_transitions table (replaced by channels).
 * Transitions have been removed in favor of the channel-based topology.
 * Idempotent via DROP TABLE IF EXISTS.
 */
export function runMigration59(db: BunDatabase): void {
	db.exec(`DROP TABLE IF EXISTS space_workflow_transitions`);
}

/**
 * Migration 60: Drop space_session_groups and space_session_group_members tables,
 * and drop current_node_id column from space_workflow_runs.
 *
 * Session groups are replaced by direct space_tasks queries:
 *   task.taskAgentSessionId = the session ID of the sub-session
 *   task.agentName           = the role/name of the agent
 *   task.workflowNodeId      = used to filter to the same node
 *
 * currentNodeId is replaced by the agent-centric model where tasks track state.
 */
export function runMigration62(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;

	// Check if column already exists (idempotent guard)
	const cols = db.prepare('PRAGMA table_info(space_tasks)').all() as Array<{ name: string }>;
	if (cols.some((c) => c.name === 'task_number')) return;

	// SQLite cannot ALTER a column to NOT NULL, so we:
	// 1. Add nullable column and backfill existing rows
	// 2. Rebuild table with NOT NULL constraint via rename pattern
	db.exec(`PRAGMA foreign_keys = OFF`);
	db.exec(`BEGIN`);
	try {
		// Step 1: Add nullable column and backfill
		db.exec(`ALTER TABLE space_tasks ADD COLUMN task_number INTEGER`);

		const spaces = db.prepare(`SELECT DISTINCT space_id FROM space_tasks`).all() as Array<{
			space_id: string;
		}>;
		for (const { space_id } of spaces) {
			const tasks = db
				.prepare(`SELECT id FROM space_tasks WHERE space_id = ? ORDER BY created_at ASC`)
				.all(space_id) as Array<{ id: string }>;
			const updateStmt = db.prepare(`UPDATE space_tasks SET task_number = ? WHERE id = ?`);
			let num = 1;
			for (const { id } of tasks) {
				updateStmt.run(num++, id);
			}
		}

		// Step 2: Rebuild table with NOT NULL on task_number
		db.exec(`DROP TABLE IF EXISTS space_tasks_m61_new`);
		db.exec(`
			CREATE TABLE space_tasks_m61_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed',
						'needs_attention', 'cancelled', 'archived', 'rate_limited', 'usage_limited')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general', 'planner')),
				custom_agent_id TEXT,
				agent_name TEXT,
				completion_summary TEXT,
				workflow_run_id TEXT,
				workflow_node_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
			)
		`);

		db.exec(`
			INSERT INTO space_tasks_m61_new
			SELECT id, space_id, task_number, title, description, status, priority, task_type,
				assigned_agent, custom_agent_id, agent_name, completion_summary,
				workflow_run_id, workflow_node_id, created_by_task_id, goal_id,
				progress, current_step, result, error, depends_on, input_draft,
				active_session, task_agent_session_id, pr_url, pr_number, pr_created_at,
				archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

		db.exec(`DROP TABLE space_tasks`);
		db.exec(`ALTER TABLE space_tasks_m61_new RENAME TO space_tasks`);

		// Recreate all indexes (dropped with the old table)
		db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
		);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
		);
		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS uq_space_tasks_run_node_agent
			ON space_tasks (workflow_run_id, workflow_node_id, agent_name)
			WHERE workflow_run_id IS NOT NULL
				AND workflow_node_id IS NOT NULL
				AND agent_name IS NOT NULL
				AND status IN ('pending', 'in_progress', 'review', 'rate_limited', 'usage_limited')
		`);
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_space_task_number ON space_tasks(space_id, task_number)`
		);

		db.exec(`COMMIT`);
	} catch (err) {
		db.exec(`ROLLBACK`);
		throw err;
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

export function runMigration60(db: BunDatabase): void {
	// Disable FK enforcement before any DDL so that:
	// - DROP TABLE space_workflow_runs does NOT fire ON DELETE SET NULL on space_tasks.workflow_run_id
	// - The table rebuild completes atomically without cascading side-effects
	// This matches the pattern used by M44, M45, M51, M55, etc.
	db.exec(`PRAGMA foreign_keys = OFF`);
	db.exec(`BEGIN`);
	try {
		// Drop member table first (FK constraint order)
		db.exec(`DROP TABLE IF EXISTS space_session_group_members`);
		db.exec(`DROP TABLE IF EXISTS space_session_groups`);

		// Drop indexes that may exist on those tables
		// (SQLite drops indexes with the table, but be explicit for safety)
		db.exec(`DROP INDEX IF EXISTS idx_space_session_groups_task_id`);
		db.exec(`DROP INDEX IF EXISTS idx_space_session_group_members_group`);
		db.exec(`DROP INDEX IF EXISTS idx_space_session_group_members_session`);

		// Drop current_node_id from space_workflow_runs using table rebuild (SQLite compatibility)
		// Check if column exists first — idempotent guard.
		if (tableExists(db, 'space_workflow_runs')) {
			const runTableInfo = db.prepare('PRAGMA table_info(space_workflow_runs)').all() as Array<{
				name: string;
			}>;
			if (runTableInfo.some((col) => col.name === 'current_node_id')) {
				db.exec(`DROP TABLE IF EXISTS space_workflow_runs_m60_new`);
				db.exec(`
					CREATE TABLE space_workflow_runs_m60_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						workflow_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
						config TEXT,
						iteration_count INTEGER NOT NULL DEFAULT 0,
						max_iterations INTEGER NOT NULL DEFAULT 10,
						goal_id TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						completed_at INTEGER,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
				db.exec(`
					INSERT INTO space_workflow_runs_m60_new (id, space_id, workflow_id, title, description, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at, completed_at)
					SELECT id, space_id, workflow_id, title, description, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at, completed_at
					FROM space_workflow_runs
				`);
				db.exec(`DROP TABLE space_workflow_runs`);
				db.exec(`ALTER TABLE space_workflow_runs_m60_new RENAME TO space_workflow_runs`);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space ON space_workflow_runs(space_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow ON space_workflow_runs(workflow_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
				);
			}
		}

		db.exec(`COMMIT`);
	} catch (err) {
		db.exec(`ROLLBACK`);
		throw err;
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Migration 61: Add gate_data table, gates column to space_workflows,
 * and failure_reason column to space_workflow_runs.
 *
 * Part of M1.1 — separated Channel + Gate types.
 *
 * - `gate_data`: Persistent data store for gates, keyed by `(run_id, gate_id)`.
 *   Stores JSON data that gate conditions evaluate against at runtime.
 * - `gates` column on `space_workflows`: JSON array of Gate definitions.
 * - `failure_reason` column on `space_workflow_runs`: Enum-like TEXT for run failure reasons.
 */
function runMigration61(db: BunDatabase): void {
	// Check all 3 schema additions for idempotency
	const hasGatesCol = db
		.prepare(
			"SELECT COUNT(*) as count FROM pragma_table_info('space_workflows') WHERE name = 'gates'"
		)
		.get() as { count: number } | null;
	const hasFailureReasonCol = db
		.prepare(
			"SELECT COUNT(*) as count FROM pragma_table_info('space_workflow_runs') WHERE name = 'failure_reason'"
		)
		.get() as { count: number } | null;
	const hasGateDataTable = db
		.prepare(
			"SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'gate_data'"
		)
		.get() as { count: number } | null;

	if (
		hasGatesCol &&
		hasGatesCol.count > 0 &&
		hasFailureReasonCol &&
		hasFailureReasonCol.count > 0 &&
		hasGateDataTable &&
		hasGateDataTable.count > 0
	) {
		return;
	}

	db.exec(`BEGIN TRANSACTION`);
	try {
		// 1. Create gate_data table
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

		// 2. Add gates column to space_workflows (if not already present)
		if (!hasGatesCol || hasGatesCol.count === 0) {
			db.exec(`ALTER TABLE space_workflows ADD COLUMN gates TEXT`);
		}

		// 3. Add failure_reason column to space_workflow_runs (if not already present)
		// CHECK constraint restricts values to the WorkflowRunFailureReason union.
		if (!hasFailureReasonCol || hasFailureReasonCol.count === 0) {
			db.exec(
				`ALTER TABLE space_workflow_runs ADD COLUMN failure_reason TEXT CHECK(failure_reason IN ('humanRejected', 'maxIterationsReached', 'nodeTimeout', 'agentCrash'))`
			);
		}

		db.exec(`COMMIT`);
	} catch (err) {
		db.exec(`ROLLBACK`);
		throw err;
	}
}

/**
 * Migration 63: Add slug column to spaces table.
 *
 * - Adds nullable `slug TEXT` column (required for ALTER TABLE ADD COLUMN in SQLite)
 * - Backfills existing spaces with slugs derived from their name
 * - Rebuilds table with `slug TEXT NOT NULL` to enforce the constraint
 * - Adds UNIQUE index on slug
 */
export function runMigration63(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;

	// Check if slug column already exists (idempotent guard)
	const tableInfo = db.prepare('PRAGMA table_info(spaces)').all() as Array<{
		name: string;
		notnull: number;
	}>;
	const slugCol = tableInfo.find((col) => col.name === 'slug');
	if (slugCol && slugCol.notnull === 1) return; // Already migrated with NOT NULL

	db.exec(`PRAGMA foreign_keys = OFF`);
	db.exec(`BEGIN`);

	try {
		// Step 1: Add nullable slug column if it doesn't exist yet
		if (!slugCol) {
			db.exec(`ALTER TABLE spaces ADD COLUMN slug TEXT`);
		}

		// Step 2: Backfill slugs only for rows that don't have one yet.
		// Use WHERE slug IS NULL so we don't overwrite slugs that were already set
		// (e.g., if a space was created between a partial migration run and this fix).
		const existingSlugs = db
			.prepare('SELECT slug FROM spaces WHERE slug IS NOT NULL')
			.all() as Array<{ slug: string }>;
		const usedSlugs = new Set<string>(existingSlugs.map((r) => r.slug));

		const rows = db.prepare('SELECT id, name FROM spaces WHERE slug IS NULL').all() as Array<{
			id: string;
			name: string;
		}>;

		const updateStmt = db.prepare('UPDATE spaces SET slug = ? WHERE id = ? AND slug IS NULL');

		for (const row of rows) {
			const base = generateBaseMigrationSlug(row.name);
			let slug = base;
			let counter = 2;
			while (usedSlugs.has(slug)) {
				slug = `${base}-${counter}`;
				counter++;
			}
			usedSlugs.add(slug);
			updateStmt.run(slug, row.id);
		}

		// Step 3: Table rebuild to enforce NOT NULL on slug
		// SQLite does not support ALTER COLUMN, so we recreate the table.
		db.exec(`DROP TABLE IF EXISTS spaces_m63_new`);
		db.exec(`
			CREATE TABLE spaces_m63_new (
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
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		db.exec(`
			INSERT INTO spaces_m63_new (id, slug, workspace_path, name, description,
				background_context, instructions, default_model, allowed_models,
				session_ids, status, autonomy_level, config, created_at, updated_at)
			SELECT id, slug, workspace_path, name, description,
				background_context, instructions, default_model, allowed_models,
				session_ids, status, COALESCE(autonomy_level, 'supervised'),
				config, created_at, updated_at
			FROM spaces
		`);
		db.exec(`DROP TABLE spaces`);
		db.exec(`ALTER TABLE spaces_m63_new RENAME TO spaces`);

		// Step 4: Recreate indexes
		db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);

		db.exec(`COMMIT`);
	} catch (err) {
		db.exec(`ROLLBACK`);
		throw err;
	} finally {
		db.exec(`PRAGMA foreign_keys = ON`);
	}
}

/**
 * Inline slugify for migration — avoids importing from slug.ts which may change.
 * Mirrors the same rules: lowercase, replace non-alphanumeric with hyphens,
 * collapse, strip, truncate to 60 chars.
 */
function generateBaseMigrationSlug(input: string): string {
	const fallback = 'unnamed-space';
	if (!input || !input.trim()) return fallback;

	let slug = input
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '-')
		.replace(/[\s]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+/, '')
		.replace(/-+$/, '');

	if (!slug) return fallback;

	if (slug.length > 60) {
		const truncated = slug.slice(0, 60);
		const lastHyphen = truncated.lastIndexOf('-');
		slug = lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated.replace(/-+$/, '');
	}

	return slug;
}

/**
 * Migration 64: Create space_worktrees table.
 *
 * Persists the mapping between space tasks and the git worktrees created for them.
 * Schema:
 *   id          - UUID primary key
 *   space_id    - owning space
 *   task_id     - the task this worktree was created for
 *   slug        - human-readable folder/branch slug (unique per space)
 *   path        - absolute filesystem path to the worktree directory
 *   created_at  - Unix epoch ms
 *
 * Constraints:
 *   UNIQUE(space_id, task_id)  — one worktree per task
 *   UNIQUE(space_id, slug)     — no two tasks share the same slug within a space
 */
function runMigration64(db: BunDatabase): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS space_worktrees (
			id         TEXT PRIMARY KEY,
			space_id   TEXT NOT NULL,
			task_id    TEXT NOT NULL,
			slug       TEXT NOT NULL,
			path       TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			UNIQUE(space_id, task_id),
			UNIQUE(space_id, slug),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_space_worktrees_space_id ON space_worktrees(space_id)`);
}

/**
 * Migration 65: Add completed_at to space_worktrees.
 *
 * Adds a nullable `completed_at` INTEGER column so the TTL-based reaper can
 * identify worktrees whose tasks have finished and remove them after 7 days.
 * NULL = task still active; non-NULL = Unix epoch ms when the task completed.
 */
function runMigration65(db: BunDatabase): void {
	try {
		db.prepare(`SELECT completed_at FROM space_worktrees LIMIT 1`).all();
	} catch {
		// Column doesn't exist yet — add it
		db.exec(`ALTER TABLE space_worktrees ADD COLUMN completed_at INTEGER`);
	}
}

/**
 * Migration 66: Add 'neo' to sessions type CHECK constraint and create neo_activity_log table.
 *
 * Two changes:
 * 1. Expands the sessions.type CHECK constraint to include 'neo'.
 *    Uses the probe-insert + table-recreate pattern (SQLite doesn't support ALTER CHECK).
 * 2. Creates the neo_activity_log table for auditing Neo agent actions.
 *    Idempotent via CREATE TABLE IF NOT EXISTS.
 *
 * neo_activity_log schema:
 *   id          - UUID primary key
 *   tool_name   - name of the Neo tool invoked
 *   input       - JSON-serialized tool input
 *   output      - JSON-serialized tool output
 *   status      - 'success' | 'error' | 'cancelled'
 *   error       - error message if status='error'
 *   target_type - type of entity the action targeted (e.g. 'room', 'space', 'skill')
 *   target_id   - ID of the targeted entity
 *   undoable    - 1 if the action can be undone, 0 otherwise
 *   undo_data   - JSON blob needed to reverse the action
 *   created_at  - ISO 8601 timestamp (default: current UTC time)
 */
export function runMigration66(db: BunDatabase): void {
	// Skip the entire migration if Neo support has already been removed by M131
	// (or the table was created fresh at the M131 tip without 'neo' in the CHECK).
	// Re-running the legacy probe-and-rebuild here would rebuild `sessions` with a
	// stale CHECK that rejects post-M66 types like 'space_chat', crashing startup
	// on any DB created or upgraded under the M131 schema.
	if (tableExists(db, 'sessions')) {
		const sessionsSql = tableCreateSql(db, 'sessions');
		if (sessionsSql && !sessionsSql.includes("'neo'")) {
			return;
		}
	}

	// --- Part 1: Expand sessions.type CHECK constraint to include 'neo' ---
	if (tableExists(db, 'sessions')) {
		try {
			const testId = '__migration_test_neo_type__';
			db.prepare(
				`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				testId,
				'Test',
				'/tmp',
				new Date().toISOString(),
				new Date().toISOString(),
				'active',
				'{}',
				'{}',
				0,
				'neo'
			);
			db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
		} catch {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				db.exec(`
					CREATE TABLE sessions_new (
						id TEXT PRIMARY KEY,
						title TEXT NOT NULL,
						workspace_path TEXT NOT NULL,
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
						available_commands TEXT,
						processing_state TEXT,
						archived_at TEXT,
						parent_id TEXT,
						type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'neo')),
						session_context TEXT
					)
				`);
				db.exec(`
					INSERT INTO sessions_new
					SELECT id, title, workspace_path, created_at, last_active_at,
						status, config, metadata, is_worktree, worktree_path, main_repo_path,
						worktree_branch, git_branch, sdk_session_id, available_commands,
						processing_state, archived_at, parent_id, type, session_context
					FROM sessions
				`);
				db.exec(`DROP TABLE sessions`);
				db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// --- Part 2: Create neo_activity_log table ---
	db.exec(`
		CREATE TABLE IF NOT EXISTS neo_activity_log (
			id          TEXT PRIMARY KEY,
			tool_name   TEXT NOT NULL,
			input       TEXT,
			output      TEXT,
			status      TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'cancelled')),
			error       TEXT,
			target_type TEXT,
			target_id   TEXT,
			undoable    INTEGER DEFAULT 0,
			undo_data   TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_neo_activity_log_created_at ON neo_activity_log(created_at)`
	);
}

/**
 * Migration 67: Add 'space_chat' to sessions type CHECK constraint.
 *
 * Uses the same probe-insert + table-recreate pattern as Migration 31.
 * Attempts to insert a row with type='space_chat'; if the constraint rejects it,
 * recreates the sessions table with the expanded CHECK list (including 'neo' from M66).
 */
function runMigration67(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) return;

	try {
		const testId = '__migration_test_space_chat_type__';
		db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			testId,
			'Test',
			'/tmp',
			new Date().toISOString(),
			new Date().toISOString(),
			'active',
			'{}',
			'{}',
			0,
			'space_chat'
		);
		db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
	} catch {
		db.exec('PRAGMA foreign_keys = OFF');
		try {
			db.exec(`
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
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
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT,
					parent_id TEXT,
					type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'neo', 'space_chat')),
					session_context TEXT
				)
			`);
			db.exec(`
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at,
					status, config, metadata, is_worktree, worktree_path, main_repo_path,
					worktree_branch, git_branch, sdk_session_id, available_commands,
					processing_state, archived_at, parent_id, type, session_context
				FROM sessions
			`);
			db.exec(`DROP TABLE sessions`);
			db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}
}

/**
 * Migration 68: Add 'origin' column to sdk_messages.
 *
 * This is an app-level metadata column alongside the opaque sdk_message blob.
 * It is NOT part of the SDK message format — room/space agents do not see it.
 * NULL (default) is treated as 'human' by the frontend.
 * 'neo' marks messages injected by the Neo global AI agent.
 * 'system' marks messages injected by the daemon system internally.
 */
/**
 * Migration 69: Per-channel cycle tracking.
 *
 * Creates a `channel_cycles` table that tracks how many times each backward
 * (cyclic) channel has been traversed in a workflow run. This replaces the
 * global `iteration_count` / `max_iterations` columns on `space_workflow_runs`
 * (which are left in place as dead columns to avoid expensive table recreation).
 */
export function runMigration69(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_runs')) return;
	if (tableExists(db, 'channel_cycles')) return;

	db.exec(`
		CREATE TABLE channel_cycles (
			run_id TEXT NOT NULL,
			channel_index INTEGER NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			max_cycles INTEGER NOT NULL DEFAULT 5,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, channel_index),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
}

export function runMigration68(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}
	// Use PRAGMA table_info() to check for the column — consistent with the rest of the codebase
	const columns = db.prepare(`PRAGMA table_info(sdk_messages)`).all() as Array<{ name: string }>;
	const hasOrigin = columns.some((col) => col.name === 'origin');
	if (!hasOrigin) {
		db.exec(
			`ALTER TABLE sdk_messages ADD COLUMN origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'neo', 'system'))`
		);
	}
}

/**
 * Migration 70: Backfill default_path for existing rooms where it is NULL.
 *
 * For each room with default_path IS NULL:
 *   - Parses the allowed_paths JSON column and sets default_path to the first entry's `path`.
 *   - If allowed_paths is also null/empty, sets default_path to the sentinel value
 *     '__NEEDS_WORKSPACE_PATH__'. This sentinel is replaced at startup in app.ts using
 *     config.workspaceRoot, so rooms get a real path as soon as the daemon boots.
 *
 * Idempotency: if no rooms have default_path IS NULL, the function returns early.
 */
export function runMigration70(db: BunDatabase): void {
	if (!tableExists(db, 'rooms')) return;

	// Ensure the default_path and allowed_paths columns exist — they were added in the base schema
	// but older DBs created before these columns were part of the schema may lack them.
	const roomColumns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
	const hasDefaultPath = roomColumns.some((col) => col.name === 'default_path');
	if (!hasDefaultPath) {
		db.exec(`ALTER TABLE rooms ADD COLUMN default_path TEXT`);
	}
	const hasAllowedPaths = roomColumns.some((col) => col.name === 'allowed_paths');
	if (!hasAllowedPaths) {
		db.exec(`ALTER TABLE rooms ADD COLUMN allowed_paths TEXT DEFAULT '[]'`);
	}

	// Check if any rooms still need backfill — idempotency guard
	const nullCount = (
		db.prepare(`SELECT COUNT(*) as cnt FROM rooms WHERE default_path IS NULL`).get() as {
			cnt: number;
		}
	).cnt;
	if (nullCount === 0) return;

	// Fetch all rooms that need backfill
	const rows = db
		.prepare(`SELECT id, allowed_paths FROM rooms WHERE default_path IS NULL`)
		.all() as Array<{ id: string; allowed_paths: string | null }>;

	const update = db.prepare(`UPDATE rooms SET default_path = ? WHERE id = ?`);

	for (const row of rows) {
		let newPath: string = '__NEEDS_WORKSPACE_PATH__';
		try {
			const parsed = JSON.parse(row.allowed_paths ?? '[]');
			if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.path) {
				newPath = parsed[0].path as string;
			}
		} catch {
			// JSON parse failed — fall through to sentinel
		}
		update.run(newPath, row.id);
	}
}

/**
 * Migration 71: Fix corrupted schedule values in goals table.
 *
 * Some rows may contain raw cron strings (e.g. "@daily", "0 9 * * *") instead
 * of the expected JSON object {"expression":"@daily","timezone":"UTC"}.
 * This migration detects such rows and wraps bare strings into the proper
 * CronSchedule shape.
 *
 * Idempotency: if no rows have non-JSON schedule values, the function returns early.
 */
export function runMigration71(db: BunDatabase): void {
	if (!tableExists(db, 'goals')) return;

	// Check if the schedule column exists (older DBs may not have it)
	const goalColumns = db.prepare(`PRAGMA table_info(goals)`).all() as Array<{ name: string }>;
	const hasSchedule = goalColumns.some((col) => col.name === 'schedule');
	if (!hasSchedule) return;

	const rows = db
		.prepare(`SELECT id, schedule FROM goals WHERE schedule IS NOT NULL`)
		.all() as Array<{ id: string; schedule: string }>;

	if (rows.length === 0) return;

	const update = db.prepare(`UPDATE goals SET schedule = ? WHERE id = ?`);

	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.schedule);
			// If it parses and is an object with expression field, it's already correct
			if (typeof parsed === 'object' && parsed !== null && typeof parsed.expression === 'string') {
				continue;
			}
			// If it parses but is a bare string (somehow valid JSON string), wrap it
			if (typeof parsed === 'string') {
				const fixedVal = JSON.stringify({ expression: parsed, timezone: 'UTC' });
				update.run(fixedVal, row.id);
			}
		} catch {
			// JSON parse failed — this is a raw cron string like "@daily"
			const fixedVal = JSON.stringify({ expression: row.schedule, timezone: 'UTC' });
			update.run(fixedVal, row.id);
		}
	}
}

/**
 * Migration 72: Add missing performance indexes.
 *
 * These indexes optimize the most common query patterns:
 * - room.list: SELECT * FROM rooms WHERE status = 'active' ORDER BY updated_at DESC
 * - listSessions: SELECT * FROM sessions WHERE status != 'archived' ORDER BY last_active_at DESC
 * - listSessionsByType: SELECT * FROM sessions WHERE type = ? ORDER BY last_active_at DESC
 * - findByRoomId: SELECT * FROM sessions WHERE type = 'room' AND json_extract(session_context, '$.roomId') = ?
 *
 * Idempotent: CREATE INDEX IF NOT EXISTS ensures safe re-runs.
 * Guards: tableHasColumn checks handle test-contrived partial schemas (e.g.,
 * migration-42 tests that create rooms without a status column) as well as
 * fresh in-memory databases where tables may not yet exist.
 */
export function runMigration72(db: BunDatabase): void {
	if (tableExists(db, 'rooms') && tableHasColumn(db, 'rooms', 'status')) {
		// Rooms: composite index for listRooms ORDER BY updated_at DESC WHERE status = 'active'
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_rooms_status_updated ON rooms(status, updated_at DESC)`
		);
	}

	if (tableExists(db, 'sessions') && tableHasColumn(db, 'sessions', 'type')) {
		// Sessions: index on type for listSessionsByType, findByRoomId
		db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(type)`);
	}

	if (tableExists(db, 'sessions') && tableHasColumn(db, 'sessions', 'status')) {
		// Sessions: composite index for listSessions ORDER BY last_active_at DESC WHERE status != 'archived'
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sessions_status_last_active ON sessions(status, last_active_at DESC)`
		);
	}
}

/**
 * Migration 73: Update space_tasks and space_workflow_runs to the new schema design.
 *
 * ### space_tasks
 *
 * Status changes (old → new):
 *   draft / pending           → open
 *   review / needs_attention /
 *     rate_limited / usage_limited → blocked
 *   completed                → done
 *   cancelled / archived / in_progress → unchanged
 *
 * Column changes:
 *   ADDED:   labels TEXT NOT NULL DEFAULT '[]'
 *   REMOVED: task_type, assigned_agent, custom_agent_id, agent_name,
 *            completion_summary, workflow_node_id, goal_id, progress,
 *            current_step, error, input_draft
 *   UPDATED: status CHECK constraint, DEFAULT 'open'
 *
 * ### space_workflow_runs
 *
 * Status changes:
 *   completed     → done
 *   needs_attention → blocked
 *   others          → unchanged
 *
 * Column changes:
 *   ADDED:   started_at INTEGER
 *   REMOVED: config, iteration_count, max_iterations, goal_id
 *   UPDATED: status CHECK constraint
 *
 * Idempotency: inspects the CHECK constraint and expected columns instead of
 * probe-inserting fake rows, so foreign key enforcement cannot trigger a
 * spurious rebuild on already-migrated databases.
 */
function runMigration73(db: BunDatabase): void {
	// ---- space_tasks ----
	if (tableExists(db, 'space_tasks')) {
		// Idempotency: inspect the CHECK constraint instead of probe-inserting a
		// fake row. With foreign_keys=ON, a probe using a non-existent space_id
		// fails even on already-migrated schemas, which would trigger a destructive
		// rebuild on every startup.
		const needsTasksUpdate =
			!statusCheckContains(db, 'space_tasks', 'open') ||
			!tableHasColumn(db, 'space_tasks', 'labels') ||
			tableHasColumn(db, 'space_tasks', 'task_type');

		if (needsTasksUpdate) {
			// pr_url/pr_number/pr_created_at may already be removed by M84.
			// Conditionally include them so this rebuild works on re-run.
			const hasPrCols = tableHasColumn(db, 'space_tasks', 'pr_url');

			db.exec('PRAGMA foreign_keys = OFF');
			db.exec('BEGIN');
			try {
				// Rebuild with new schema (adds labels, removes deprecated columns).
				// Status mapping is done inline via CASE WHEN to avoid running UPDATE
				// against the old CHECK constraint (which does not allow the new values).
				db.exec(`
					CREATE TABLE space_tasks_m71_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						task_number INTEGER NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'open'
							CHECK(status IN ('open', 'in_progress', 'done', 'blocked', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						labels TEXT NOT NULL DEFAULT '[]',
						workflow_run_id TEXT,
						created_by_task_id TEXT,
						result TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						${
							hasPrCols
								? `pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,`
								: ''
						}
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
					)
				`);

				// Use CASE WHEN to map old status values inline so we never write
				// an old→new value into the still-constrained old table.
				const prInsertCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
				const prSelectCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
				db.exec(`
					INSERT INTO space_tasks_m71_new
					  (id, space_id, task_number, title, description, status, priority, labels,
					   workflow_run_id, created_by_task_id, result, depends_on,
					   active_session, task_agent_session_id${prInsertCols},
					   archived_at, created_at, started_at, completed_at, updated_at)
					SELECT
					  id, space_id, task_number, title, description,
					  CASE status
					    WHEN 'draft'           THEN 'open'
					    WHEN 'pending'         THEN 'open'
					    WHEN 'completed'       THEN 'done'
					    WHEN 'review'          THEN 'blocked'
					    WHEN 'needs_attention' THEN 'blocked'
					    WHEN 'rate_limited'    THEN 'blocked'
					    WHEN 'usage_limited'   THEN 'blocked'
					    ELSE status
					  END,
					  priority, '[]',
					  workflow_run_id, created_by_task_id, result, depends_on,
					  active_session, task_agent_session_id${prSelectCols},
					  archived_at, created_at, started_at, completed_at, updated_at
					FROM space_tasks
				`);

				db.exec(`DROP TABLE space_tasks`);
				db.exec(`ALTER TABLE space_tasks_m71_new RENAME TO space_tasks`);
				db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
				);
				db.exec(
					`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_task_number ON space_tasks(space_id, task_number)`
				);
				db.exec('COMMIT');
			} catch (err) {
				db.exec('ROLLBACK');
				throw err;
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// ---- space_workflow_runs ----
	if (tableExists(db, 'space_workflow_runs')) {
		// Idempotency: inspect schema text instead of probe-inserting a fake row,
		// for the same foreign-key reason as the space_tasks check above.
		const needsRunsUpdate =
			!statusCheckContains(db, 'space_workflow_runs', 'done') ||
			!tableHasColumn(db, 'space_workflow_runs', 'started_at') ||
			tableHasColumn(db, 'space_workflow_runs', 'config');

		if (needsRunsUpdate) {
			db.exec('PRAGMA foreign_keys = OFF');
			db.exec('BEGIN');
			try {
				db.exec(`
					CREATE TABLE space_workflow_runs_m71_new (
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
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);

				// Use CASE WHEN to map old status values inline to avoid writing
				// new values into the still-constrained old table.
				db.exec(`
					INSERT INTO space_workflow_runs_m71_new
					  (id, space_id, workflow_id, title, description, status, failure_reason,
					   created_at, updated_at, completed_at)
					SELECT
					  id, space_id, workflow_id, title, description,
					  CASE status
					    WHEN 'completed'      THEN 'done'
					    WHEN 'needs_attention' THEN 'blocked'
					    ELSE status
					  END,
					  failure_reason,
					  created_at, updated_at, completed_at
					FROM space_workflow_runs
				`);

				db.exec(`DROP TABLE space_workflow_runs`);
				db.exec(`ALTER TABLE space_workflow_runs_m71_new RENAME TO space_workflow_runs`);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
				);
				db.exec(
					`CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
				);
				db.exec('COMMIT');
			} catch (err) {
				db.exec('ROLLBACK');
				throw err;
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// ---- space_workflows: add end_node_id ----
	if (tableExists(db, 'space_workflows') && !tableHasColumn(db, 'space_workflows', 'end_node_id')) {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN end_node_id TEXT`);
	}

	// ---- space_agents: add instructions ----
	if (tableExists(db, 'space_agents') && !tableHasColumn(db, 'space_agents', 'instructions')) {
		db.exec(`ALTER TABLE space_agents ADD COLUMN instructions TEXT`);
	}
}

/**
 * Migration 74: Remaining schema cleanup for end-node / workflow completion.
 *
 * ### node_executions (new table)
 *
 * Creates a dedicated table for tracking per-node agent execution state within
 * a workflow run. Separates workflow-internal state from user-facing space_tasks.
 *
 * ### space_workflows
 *
 * Drops `config` JSON blob (tags extracted to dedicated `tags` column) and
 * `max_iterations` column (no longer used by the runtime).
 *
 * ### space_workflow_nodes
 *
 * Drops `order_index` (node ordering is not significant in the graph model)
 * and `agent_id` (legacy single-agent shorthand; always use agents[] in config).
 *
 * ### space_agents
 *
 * Drops `role` (removed from type system), `config` (toolConfig, deprecated),
 * and `inject_workflow_context` (no longer used).
 *
 * ### Node config JSON migration
 *
 * Transforms WorkflowNodeAgent entries inside space_workflow_nodes.config:
 * plain string `systemPrompt` / `instructions` → `{ mode: 'override', value }`.
 * Guards: null/empty string → skip; already an object with `mode` → skip.
 *
 * Idempotency: each sub-migration checks for the presence of the column(s)
 * being dropped before proceeding.
 */
export function runMigration74(db: BunDatabase): void {
	// ---- node_executions: new table ----
	if (!tableExists(db, 'node_executions')) {
		try {
			db.exec('BEGIN');
			db.exec(`
				CREATE TABLE node_executions (
					id TEXT PRIMARY KEY,
					workflow_run_id TEXT NOT NULL,
					workflow_node_id TEXT NOT NULL,
					agent_name TEXT NOT NULL,
					agent_id TEXT,
					agent_session_id TEXT,
					status TEXT NOT NULL DEFAULT 'pending'
						CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
					result TEXT,
					created_at INTEGER NOT NULL,
					started_at INTEGER,
					completed_at INTEGER,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
					FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE SET NULL
				)
			`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
			);
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
	}

	// ---- space_workflows: drop config and max_iterations, add tags ----
	if (tableExists(db, 'space_workflows') && tableHasColumn(db, 'space_workflows', 'config')) {
		// Pre-extract tags from config JSON before dropping the column.
		const wfRows = db.prepare(`SELECT id, config FROM space_workflows`).all() as Array<{
			id: string;
			config: string | null;
		}>;
		const tagsMap = new Map<string, string>();
		for (const row of wfRows) {
			if (!row.config) {
				tagsMap.set(row.id, '[]');
				continue;
			}
			try {
				const cfg = JSON.parse(row.config) as Record<string, unknown>;
				const tags = Array.isArray(cfg.tags) ? cfg.tags : [];
				tagsMap.set(row.id, JSON.stringify(tags));
			} catch {
				tagsMap.set(row.id, '[]');
			}
		}

		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN');
		try {
			db.exec(`
				CREATE TABLE space_workflows_m74_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					start_node_id TEXT,
					end_node_id TEXT,
					tags TEXT NOT NULL DEFAULT '[]',
					layout TEXT,
					channels TEXT,
					gates TEXT,
					disabled INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

			db.exec(`
				INSERT INTO space_workflows_m74_new
				  (id, space_id, name, description, start_node_id, end_node_id, tags,
				   layout, channels, gates, created_at, updated_at)
				SELECT
				  id, space_id, name, description, start_node_id, end_node_id, '[]',
				  layout, channels, gates, created_at, updated_at
				FROM space_workflows
			`);

			db.exec(`DROP TABLE space_workflows`);
			db.exec(`ALTER TABLE space_workflows_m74_new RENAME TO space_workflows`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`
			);

			// Apply extracted tags
			const updateTags = db.prepare(`UPDATE space_workflows SET tags = ? WHERE id = ?`);
			for (const [id, tags] of tagsMap) {
				updateTags.run(tags, id);
			}

			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}

	// ---- space_workflow_nodes: drop order_index and agent_id ----
	if (
		tableExists(db, 'space_workflow_nodes') &&
		tableHasColumn(db, 'space_workflow_nodes', 'order_index')
	) {
		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN');
		try {
			db.exec(`
				CREATE TABLE space_workflow_nodes_m74_new (
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
				INSERT INTO space_workflow_nodes_m74_new
				  (id, workflow_id, name, description, config, created_at, updated_at)
				SELECT
				  id, workflow_id, name, description, config, created_at, updated_at
				FROM space_workflow_nodes
			`);

			db.exec(`DROP TABLE space_workflow_nodes`);
			db.exec(`ALTER TABLE space_workflow_nodes_m74_new RENAME TO space_workflow_nodes`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id)`
			);

			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}

	// ---- space_agents: drop role, config, inject_workflow_context ----
	if (tableExists(db, 'space_agents') && tableHasColumn(db, 'space_agents', 'role')) {
		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN');
		try {
			db.exec(`
				CREATE TABLE space_agents_m74_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					model TEXT,
					tools TEXT NOT NULL DEFAULT '[]',
					system_prompt TEXT NOT NULL DEFAULT '',
					provider TEXT,
					instructions TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

			db.exec(`
				INSERT INTO space_agents_m74_new
				  (id, space_id, name, description, model, tools, system_prompt, provider,
				   instructions, created_at, updated_at)
				SELECT
				  id, space_id, name, description, model, tools, system_prompt, provider,
				  instructions, created_at, updated_at
				FROM space_agents
			`);

			db.exec(`DROP TABLE space_agents`);
			db.exec(`ALTER TABLE space_agents_m74_new RENAME TO space_agents`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);

			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}

	// ---- Node config JSON migration ----
	// Transform WorkflowNodeAgent entries in space_workflow_nodes.config:
	// plain string systemPrompt/instructions → { mode: 'override', value: existingString }
	if (tableExists(db, 'space_workflow_nodes')) {
		const nodeRows = db
			.prepare(`SELECT id, config FROM space_workflow_nodes WHERE config IS NOT NULL`)
			.all() as Array<{ id: string; config: string }>;

		const updateNodeConfig = db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE id = ?`);

		for (const row of nodeRows) {
			let cfg: Record<string, unknown>;
			try {
				cfg = JSON.parse(row.config) as Record<string, unknown>;
			} catch {
				continue;
			}

			const agents = cfg.agents;
			if (!Array.isArray(agents)) continue;

			let changed = false;
			for (const agent of agents as Array<Record<string, unknown>>) {
				// Wrap string systemPrompt → { mode: 'override', value }
				if (typeof agent.systemPrompt === 'string' && agent.systemPrompt) {
					agent.systemPrompt = { mode: 'override', value: agent.systemPrompt };
					changed = true;
				}
				// typeof agent.systemPrompt === 'object' → already migrated, skip

				// Wrap string instructions → { mode: 'override', value }
				if (typeof agent.instructions === 'string' && agent.instructions) {
					agent.instructions = { mode: 'override', value: agent.instructions };
					changed = true;
				}
				// typeof agent.instructions === 'object' → already migrated, skip
			}

			if (changed) {
				updateNodeConfig.run(JSON.stringify(cfg), row.id);
			}
		}
	}
}

/**
 * Migration 75: Add UNIQUE constraint on node_executions.
 *
 * Adds a UNIQUE INDEX on (workflow_run_id, workflow_node_id, agent_name) to
 * prevent duplicate records from concurrent activateNode() calls. Uses
 * INSERT OR IGNORE in NodeExecutionRepository.createOrIgnore() for idempotent
 * activation.
 *
 * Before creating the unique index, deduplicates any existing records by
 * keeping only the earliest record (by created_at) for each unique key.
 */
function runMigration75(db: BunDatabase): void {
	if (!tableExists(db, 'node_executions')) return;

	db.transaction(() => {
		// Deduplicate existing records: keep the earliest by rowid for each unique key.
		db.prepare(`
			DELETE FROM node_executions
			WHERE rowid NOT IN (
				SELECT MIN(rowid)
				FROM node_executions
				GROUP BY workflow_run_id, workflow_node_id, agent_name
			)
		`).run();

		// Create the unique index. Idempotent — IF NOT EXISTS skips if already present.
		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_agent
			ON node_executions(workflow_run_id, workflow_node_id, agent_name)
		`);
	})();
}

/**
 * Migration 76: Add 'review' status to space_tasks CHECK constraint.
 *
 * In supervised mode, completed workflow tasks land in 'review' for human
 * approval before transitioning to 'done'. This requires the CHECK constraint
 * on the status column to allow the 'review' value.
 *
 * SQLite does not support ALTER CHECK CONSTRAINT, so the table is rebuilt.
 */
function runMigration76(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;

	// Idempotency: inspect schema text instead of probe-inserting a fake task.
	// The probe used to fail on already-migrated databases when foreign_keys=ON
	// because it referenced a non-existent space_id.
	const needsUpdate = !statusCheckContains(db, 'space_tasks', 'review');

	if (!needsUpdate) return;

	// pr_url/pr_number/pr_created_at may already be removed by M84.
	const hasPrCols = tableHasColumn(db, 'space_tasks', 'pr_url');

	db.exec('PRAGMA foreign_keys = OFF');
	db.exec('BEGIN');
	try {
		db.exec(`
			CREATE TABLE space_tasks_m76_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'open'
					CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				labels TEXT NOT NULL DEFAULT '[]',
				workflow_run_id TEXT,
				created_by_task_id TEXT,
				result TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				${
					hasPrCols
						? `pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,`
						: ''
				}
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
			)
		`);

		const prInsertCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
		const prSelectCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
		db.exec(`
			INSERT INTO space_tasks_m76_new
			  (id, space_id, task_number, title, description, status, priority, labels,
			   workflow_run_id, created_by_task_id, result, depends_on,
			   active_session, task_agent_session_id${prInsertCols},
			   archived_at, created_at, started_at, completed_at, updated_at)
			SELECT
			  id, space_id, task_number, title, description, status, priority, labels,
			  workflow_run_id, created_by_task_id, result, depends_on,
			  active_session, task_agent_session_id${prSelectCols},
			  archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

		db.exec(`DROP TABLE space_tasks`);
		db.exec(`ALTER TABLE space_tasks_m76_new RENAME TO space_tasks`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
		);
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_task_number ON space_tasks(space_id, task_number)`
		);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 77: Make sessions.workspace_path nullable.
 *
 * Enables unbound sessions that do not have an initial workspace binding.
 * SQLite does not support dropping NOT NULL directly, so this rebuilds the table.
 */
function runMigration77(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) return;

	const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
		name: string;
		notnull: number;
	}>;
	const workspaceCol = columns.find((c) => c.name === 'workspace_path');
	if (!workspaceCol || workspaceCol.notnull === 0) {
		return;
	}

	db.exec('PRAGMA foreign_keys = OFF');
	try {
		db.exec(`
			CREATE TABLE sessions_new (
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
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'space_chat', 'neo')),
				session_context TEXT
			)
		`);
		db.exec(`
			INSERT INTO sessions_new
			SELECT id, title, workspace_path, created_at, last_active_at,
				status, config, metadata, is_worktree, worktree_path, main_repo_path,
				worktree_branch, git_branch, sdk_session_id, available_commands,
				processing_state, archived_at, parent_id, type, session_context
			FROM sessions
		`);
		db.exec(`DROP TABLE sessions`);
		db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 78: Create workspace_history table.
 *
 * Persists recently-used workspace paths with usage metadata so the frontend
 * can show a backend-backed history list across devices/profiles.
 */
export function runMigration78(db: BunDatabase): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS workspace_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			path TEXT NOT NULL UNIQUE,
			last_used_at INTEGER NOT NULL,
			use_count INTEGER NOT NULL DEFAULT 1
		)
	`);
}

/**
 * Migration 79: Update node_executions for the new agent model.
 *
 * Changes:
 * 1. Add 'idle' status to the CHECK constraint (replaces 'done').
 *    'done' is kept in the constraint for backward compatibility with any
 *    existing rows; new code only writes 'idle'.
 * 2. Add `data TEXT` column for structured agent output from `save()`.
 *
 * SQLite does not support ALTER CHECK CONSTRAINT, so a table rebuild is used.
 */
function runMigration79(db: BunDatabase): void {
	if (!tableExists(db, 'node_executions')) return;

	// Idempotency: check if 'idle' status is already accepted and data column exists.
	// Use schema inspection instead of a probe insert so foreign_keys=ON cannot
	// mistake a fake workflow_run_id for a missing CHECK value.
	const needsStatusUpdate =
		!tableHasColumn(db, 'node_executions', 'data') ||
		!statusCheckContains(db, 'node_executions', 'idle');

	if (!needsStatusUpdate) return;

	db.exec('PRAGMA foreign_keys = OFF');
	db.exec('BEGIN');
	try {
		db.exec(`
			CREATE TABLE node_executions_m78_new (
				id TEXT PRIMARY KEY,
				workflow_run_id TEXT NOT NULL,
				workflow_node_id TEXT NOT NULL,
				agent_name TEXT NOT NULL,
				agent_id TEXT,
				agent_session_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'idle', 'done', 'blocked', 'cancelled')),
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

		db.exec(`
			INSERT INTO node_executions_m78_new
			  (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
			   agent_session_id, status, result, data, created_at, started_at,
			   completed_at, updated_at)
			SELECT
			  id, workflow_run_id, workflow_node_id, agent_name, agent_id,
			  agent_session_id, status, result, NULL, created_at, started_at,
			  completed_at, updated_at
			FROM node_executions
		`);

		db.exec(`DROP TABLE node_executions`);
		db.exec(`ALTER TABLE node_executions_m78_new RENAME TO node_executions`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
		);
		// Re-create the unique index added in migration 75.
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_slot
			   ON node_executions(workflow_run_id, workflow_node_id, agent_name)`
		);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 80: Consolidate space_agents system_prompt + instructions → custom_prompt.
 *
 * Adds a single `custom_prompt TEXT` column and populates it by merging the two
 * legacy columns:
 *   - Both non-empty: `system_prompt + '\n\n' + instructions`
 *   - Only system_prompt: `system_prompt`
 *   - Only instructions: `instructions`
 *   - Neither: NULL
 *
 * The old columns are kept for now to avoid a lossy table-rebuild migration.
 * They are no longer read by the application after this migration.
 */
function runMigration80(db: BunDatabase): void {
	if (!tableExists(db, 'space_agents')) return;
	if (tableHasColumn(db, 'space_agents', 'custom_prompt')) return;

	db.exec(`ALTER TABLE space_agents ADD COLUMN custom_prompt TEXT`);

	db.exec(`
		UPDATE space_agents
		SET custom_prompt = CASE
			WHEN (system_prompt IS NOT NULL AND system_prompt != '')
			     AND (instructions IS NOT NULL AND instructions != '')
				THEN system_prompt || char(10) || char(10) || instructions
			WHEN (system_prompt IS NOT NULL AND system_prompt != '')
				THEN system_prompt
			WHEN (instructions IS NOT NULL AND instructions != '')
				THEN instructions
			ELSE NULL
		END
	`);
}

/**
 * Migration 81: Add preferred_workflow_id column to space_tasks.
 *
 * Stores the caller-specified workflow template ID for standalone task workflow
 * attachment. When set via `create_standalone_task({ workflow_id })`, the
 * SpaceRuntime uses this workflow instead of the heuristic auto-selection.
 *
 * The column is nullable with no foreign key — workflows can be deleted
 * independently of tasks, and the runtime falls back gracefully when the
 * referenced workflow no longer exists.
 */
function runMigration81(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;
	if (tableHasColumn(db, 'space_tasks', 'preferred_workflow_id')) return;

	db.exec(`ALTER TABLE space_tasks ADD COLUMN preferred_workflow_id TEXT`);
}

function runMigration82(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;
	if (tableHasColumn(db, 'space_tasks', 'approval_source')) return;

	db.exec(`ALTER TABLE space_tasks ADD COLUMN approval_source TEXT`);
	db.exec(`ALTER TABLE space_tasks ADD COLUMN approval_reason TEXT`);
	db.exec(`ALTER TABLE space_tasks ADD COLUMN approved_at INTEGER`);
}

function runMigration83(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;
	if (tableHasColumn(db, 'space_tasks', 'block_reason')) return;

	db.exec(`ALTER TABLE space_tasks ADD COLUMN block_reason TEXT`);
}

/**
 * Migration 84: Workflow Run Artifacts + drop pr_* from space_tasks.
 *
 * Creates `workflow_run_artifacts` — a general-purpose typed artifact store
 * for workflow node outputs (PRs, commits, test results, etc.).
 *
 * Removes `pr_url`, `pr_number`, `pr_created_at` from `space_tasks` since
 * PR metadata is now tracked as artifacts on the workflow run, not on the task.
 */
function runMigration84(db: BunDatabase): void {
	// 1. Create workflow_run_artifacts table
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

	// 2. Drop pr_* columns from space_tasks (SQLite requires table rebuild)
	if (!tableExists(db, 'space_tasks')) return;
	if (!tableHasColumn(db, 'space_tasks', 'pr_url')) return;

	db.exec('PRAGMA foreign_keys = OFF');
	db.exec('BEGIN');
	try {
		db.exec(`
			CREATE TABLE space_tasks_m84_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'open'
					CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
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
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
			)
		`);

		db.exec(`
			INSERT INTO space_tasks_m84_new
			  (id, space_id, task_number, title, description, status, priority, labels,
			   workflow_run_id, preferred_workflow_id, created_by_task_id, result, depends_on,
			   active_session, task_agent_session_id,
			   approval_source, approval_reason, approved_at, block_reason,
			   archived_at, created_at, started_at, completed_at, updated_at)
			SELECT
			  id, space_id, task_number, title, description, status, priority, labels,
			  workflow_run_id, preferred_workflow_id, created_by_task_id, result, depends_on,
			  active_session, task_agent_session_id,
			  approval_source, approval_reason, approved_at, block_reason,
			  archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

		db.exec(`DROP TABLE space_tasks`);
		db.exec(`ALTER TABLE space_tasks_m84_new RENAME TO space_tasks`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
		);
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_task_number ON space_tasks(space_id, task_number)`
		);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 85: Add paused column to spaces table.
 *
 * Allows users to pause/resume space runtime execution without archiving.
 * Paused spaces skip task scheduling and workflow processing in the tick loop.
 * Default: 0 (not paused).
 */
function runMigration85(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;
	if (tableHasColumn(db, 'spaces', 'paused')) return;
	db.exec(`ALTER TABLE spaces ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
}

/**
 * Migration 86: 5-level numeric autonomy.
 *
 * 1. Rebuild `spaces` table: `autonomy_level` TEXT → INTEGER (1–5).
 *    Maps 'supervised' → 1, 'semi_autonomous' → 3.
 * 2. Add `pending_action_index` and `pending_checkpoint_type` to `space_tasks`.
 * 3. Migrate `approval_source` values: collapse agent sub-types → 'agent',
 *    'semi_auto' → 'auto_policy'.
 *
 * IMPORTANT — idempotency design:
 * Parts 1 (spaces rebuild) and 2+3 (space_tasks columns) are checked independently.
 * An older version of this migration only did Part 1; databases upgraded from that
 * version already have INTEGER autonomy_level but may be missing pending_checkpoint_type.
 * Using a single early-return on the spaces check would silently skip Parts 2+3 for
 * those databases. Instead: skip Part 1 if already done, but always run Parts 2+3.
 */
export function runMigration86(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;

	// ── Part 1: Rebuild spaces with numeric autonomy_level (if still needed) ──
	let spacesAlreadyNumeric = false;
	try {
		const row = db.prepare(`SELECT typeof(autonomy_level) as t FROM spaces LIMIT 1`).get() as
			| { t: string }
			| undefined;
		if (row && row.t === 'integer') spacesAlreadyNumeric = true;
	} catch {
		// Column might not exist yet — proceed with full spaces rebuild.
	}

	if (!spacesAlreadyNumeric) {
		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN');
		try {
			db.exec(`
				CREATE TABLE spaces_m86_new (
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
				)
			`);
			db.exec(`
				INSERT INTO spaces_m86_new (id, slug, workspace_path, name, description,
					background_context, instructions, default_model, allowed_models,
					session_ids, status, autonomy_level, config, paused, created_at, updated_at)
				SELECT id, slug, workspace_path, name, description,
					background_context, instructions, default_model, allowed_models,
					session_ids, status,
					CASE autonomy_level
						WHEN 'semi_autonomous' THEN 3
						ELSE 1
					END,
					config, paused, created_at, updated_at
				FROM spaces
			`);
			db.exec(`DROP TABLE spaces`);
			db.exec(`ALTER TABLE spaces_m86_new RENAME TO spaces`);
			db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}

	// ── Parts 2+3: space_tasks columns and approval_source migration ──
	// These run independently from Part 1 so databases where the spaces rebuild
	// already ran but task columns did not are caught up. Do not re-add
	// pending_action_index after M104 has removed the completion_action schema.
	if (tableExists(db, 'space_tasks')) {
		const taskSql = tableCreateSql(db, 'space_tasks') ?? '';
		const completionActionAlreadyRemoved =
			taskSql.includes("'task_completion'") && !taskSql.includes("'completion_action'");
		if (
			!tableHasColumn(db, 'space_tasks', 'pending_action_index') &&
			!completionActionAlreadyRemoved
		) {
			db.exec(`ALTER TABLE space_tasks ADD COLUMN pending_action_index INTEGER DEFAULT NULL`);
		}
		if (!tableHasColumn(db, 'space_tasks', 'pending_checkpoint_type')) {
			db.exec(
				`ALTER TABLE space_tasks ADD COLUMN pending_checkpoint_type TEXT DEFAULT NULL` +
					` CHECK(pending_checkpoint_type IN ('completion_action', 'gate'))`
			);
		}

		// ── 3. Migrate approval_source values ──
		db.exec(`
			UPDATE space_tasks SET approval_source = 'agent'
			WHERE approval_source IN ('neo_agent', 'space_agent', 'task_agent', 'node_agent')
		`);
		db.exec(`
			UPDATE space_tasks SET approval_source = 'auto_policy'
			WHERE approval_source = 'semi_auto'
		`);
	}
}

/**
 * Migration 87: Add stopped column to spaces table.
 *
 * Allows users to stop/start space runtime execution without archiving.
 * Stopped spaces have all active work killed on stop and will not auto-start
 * on daemon restart. Default: 0 (not stopped).
 */
function runMigration87(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;
	if (tableHasColumn(db, 'spaces', 'stopped')) return;
	db.exec(`ALTER TABLE spaces ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0`);
}

/**
 * Migration 88: Decouple `report_result` from canonical task status.
 *
 * Adds `reported_status` (TEXT NULL) and `reported_summary` (TEXT NULL) columns to
 * `space_tasks`. These record the end-node agent's claimed outcome separately from
 * `space_tasks.status`, which is the runtime's final decision after passing through
 * the completion-actions review gate (see `SpaceRuntime.resolveCompletionWithActions`).
 *
 * `reported_status` constrained to the same values as `TaskResultStatusSchema`:
 * `'done' | 'blocked' | 'cancelled'`.
 */
function runMigration88(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;

	if (!tableHasColumn(db, 'space_tasks', 'reported_status')) {
		db.exec(
			`ALTER TABLE space_tasks ADD COLUMN reported_status TEXT DEFAULT NULL ` +
				`CHECK(reported_status IS NULL OR reported_status IN ('done', 'blocked', 'cancelled'))`
		);
	}
	if (!tableHasColumn(db, 'space_tasks', 'reported_summary')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN reported_summary TEXT DEFAULT NULL`);
	}
}

/**
 * Migration 89: Strip reserved writer keywords from persisted gates.
 *
 * Pre-PR #1505 the gate system used magic writer strings (`'human'`,
 * `'reviewer'`) to mark external-approval fields. PR #1505 switched to
 * structural semantics: `writers: []` means "external-only" (RPC or
 * auto-approval via `requiredLevel`). Existing DBs may still contain the
 * old keywords inside `space_workflows.gates` and would silently lose
 * their human-approval behavior.
 *
 * For each gate field whose `name === 'approved'`, drop the legacy
 * keywords from `writers`. If only legacy keywords were present, the
 * resulting `writers: []` correctly preserves external-only semantics.
 */
export function runMigration89(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;
	if (!tableHasColumn(db, 'space_workflows', 'gates')) return;

	const rows = db
		.prepare(
			`SELECT id, gates FROM space_workflows ` +
				`WHERE gates IS NOT NULL AND (gates LIKE '%"human"%' OR gates LIKE '%"reviewer"%')`
		)
		.all() as { id: string; gates: string }[];

	const update = db.prepare(`UPDATE space_workflows SET gates = ? WHERE id = ?`);

	for (const row of rows) {
		let gates: unknown;
		try {
			gates = JSON.parse(row.gates);
		} catch {
			continue;
		}
		if (!Array.isArray(gates)) continue;

		let changed = false;
		for (const gate of gates) {
			if (!gate || typeof gate !== 'object') continue;
			const fields = (gate as { fields?: unknown }).fields;
			if (!Array.isArray(fields)) continue;
			for (const field of fields) {
				if (
					!field ||
					typeof field !== 'object' ||
					(field as { name?: unknown }).name !== 'approved'
				) {
					continue;
				}
				const writers = (field as { writers?: unknown }).writers;
				if (!Array.isArray(writers)) continue;
				const filtered = writers.filter((w) => w !== 'human' && w !== 'reviewer');
				if (filtered.length !== writers.length) {
					(field as { writers: unknown[] }).writers = filtered;
					changed = true;
				}
			}
		}

		if (changed) {
			update.run(JSON.stringify(gates), row.id);
		}
	}
}

/**
 * Migration 90: Add template tracking columns to space_workflows.
 *
 * - template_name TEXT — the stable name of the built-in template this workflow
 *   was created from or last synced to (e.g. "Fullstack QA Loop").
 *   NULL for user-created workflows not based on any template.
 *
 * - template_hash TEXT — SHA-256 hex hash of the template's canonical content
 *   fingerprint at the time of creation or last sync. Used for drift detection.
 *   NULL when template_name is NULL.
 */
function runMigration90(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;

	if (!tableHasColumn(db, 'space_workflows', 'template_name')) {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN template_name TEXT DEFAULT NULL`);
	}
	if (!tableHasColumn(db, 'space_workflows', 'template_hash')) {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN template_hash TEXT DEFAULT NULL`);
	}
}

/**
 * Migration 91: Add instructions column to space_workflows.
 *
 * - instructions TEXT — workflow-level instructions injected into every agent session
 *   in this workflow. NULL for workflows with no explicit instructions.
 */
function runMigration91(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;

	if (!tableHasColumn(db, 'space_workflows', 'instructions')) {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN instructions TEXT DEFAULT NULL`);
	}
}

/**
 * Migration 92: Create the `pending_agent_messages` table.
 *
 * Persistent, ordered queue for messages the Task Agent sends to peer agents
 * (node agents or the Space Agent) when the target session isn't active yet.
 * Queued rows are drained by `flushPendingMessagesForTarget()` the moment a
 * sub-session activates, by rehydration paths after daemon restart, and by a
 * periodic sweep. Rows carry bounded retry (`attempts <= max_attempts`) and
 * an `expires_at` TTL so stale entries are dropped instead of replayed forever.
 *
 * Observability: queued/delivered events are emitted on InternalEventBus<DaemonInternalEventMap>
 * (`space.pendingMessage.queued` / `space.pendingMessage.delivered`) so the UI
 * and tests can observe the queue without polling.
 */
export function runMigration92(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_runs')) return;
	if (tableExists(db, 'pending_agent_messages')) return;

	db.exec(`
		CREATE TABLE pending_agent_messages (
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
		`CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_run_target ` +
			`ON pending_agent_messages(workflow_run_id, target_agent_name, status, created_at)`
	);
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_agent_messages_idem ` +
			`ON pending_agent_messages(workflow_run_id, target_agent_name, idempotency_key) ` +
			`WHERE idempotency_key IS NOT NULL`
	);
}

/**
 * Migration 93: Add sdk_origin_path column to sessions for cross-workspace/worktree resume.
 *
 * Stores the resolved CWD used when the SDK session was first created, enabling
 * the daemon to locate the SDK session file even when the effective CWD changes
 * between daemon restarts (e.g. when a worktree is added/removed).
 */
export function runMigration93(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) return;
	try {
		db.prepare('SELECT sdk_origin_path FROM sessions LIMIT 1').all();
	} catch {
		db.exec('ALTER TABLE sessions ADD COLUMN sdk_origin_path TEXT');
	}
}

/**
 * Migration 95: Add completion_actions_fired_at column to space_workflow_runs.
 *
 * Used as an idempotency marker so that end-node `completionActions` on a
 * workflow run are fired at most once per physical completion. When a run is
 * reopened from `done` or `cancelled` back to `in_progress` (because a peer
 * agent sent a follow-up message, a gate was re-evaluated, or a user resumed
 * the task), and subsequently completes again, the runtime uses this marker
 * to skip re-firing its completion actions. The marker is never cleared on
 * reopen — once fired, always fired.
 */
export function runMigration95(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflow_runs')) return;
	if (!tableHasColumn(db, 'space_workflow_runs', 'completion_actions_fired_at')) {
		db.exec(
			`ALTER TABLE space_workflow_runs ADD COLUMN completion_actions_fired_at INTEGER DEFAULT NULL`
		);
	}
}

/**
 * Migration 98: Create `workflow_run_artifact_cache` table.
 *
 * Caches the JSON result of the expensive git subprocess calls that power the
 * TaskArtifactsPanel (merge-base probing, `git diff HEAD --numstat`, `git log
 * --numstat`, and per-file diffs). Rows are keyed by
 * `(run_id, task_id, cache_key)`; each cache_key encodes the RPC shape
 * ("gateArtifacts", "commits", "fileDiff:<path>", "commitFileDiff:<sha>:<path>").
 *
 * Writes come from background job handlers in
 * `packages/daemon/src/lib/job-handlers/space-workflow-run-artifact.handler.ts`
 * and from the RPC layer as a warm-cache optimisation. The handler emits a
 * `space.artifactCache.updated` InternalEventBus<DaemonInternalEventMap> event after each upsert so the
 * frontend TaskArtifactsPanel can refetch from the cache without polling.
 *
 * `status` tracks whether the current row is fresh data ('ok'), a best-effort
 * placeholder while a sync is in flight ('syncing'), or a failure from the
 * last sync attempt ('error'). `synced_at` is the wall-clock time the git
 * command finished, used by consumers to decide whether to re-enqueue a sync.
 */
export function runMigration98(db: BunDatabase): void {
	if (tableExists(db, 'workflow_run_artifact_cache')) return;

	db.exec(`
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
		)
	`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_wrac_run_task ON workflow_run_artifact_cache(run_id, task_id)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_wrac_run_task_key ON workflow_run_artifact_cache(run_id, task_id, cache_key)`
	);
}

/**
 * Migration 99 — Tool-contract refactor for Task #39.
 *
 * Adds:
 *   1. `space_workflows.completion_autonomy_level` (INTEGER, NOT NULL) — the
 *      minimum autonomy level at which `approve_task` (agent self-close) is
 *      registered on end-node agents.
 *   2. `space_tasks.pending_completion_submitted_by_node_id` (TEXT, nullable)
 *      `space_tasks.pending_completion_submitted_at` (INTEGER, nullable)
 *      `space_tasks.pending_completion_reason` (TEXT, nullable)
 *      Populated when an end-node agent calls `submit_for_approval`; cleared on
 *      approve or reject.
 *   3. `space_task_report_results` table — append-only audit of each
 *      `report_result` call. Does NOT replace `space_tasks.reported_summary`
 *      (which the UI caches as the latest); it adds history.
 *
 * Backfill policy for the new NOT NULL column on `space_workflows`:
 *   - Rows whose `name` matches a built-in template get a per-template level:
 *       Coding Workflow               → 3
 *       Research Workflow             → 2
 *       Review-Only Workflow          → 2
 *       Coding with QA Workflow       → 4
 *       Plan & Decompose Workflow     → 3
 *   - Any other row (user-created) gets level 3 as a reasonable default.
 *   These are picked to reflect the risk profile of each workflow's
 *   terminal action — merging a PR (Coding) is higher-risk than posting a
 *   review (Review-Only); Coding with QA's end step runs `gh pr merge`
 *   itself, so it requires the highest autonomy (4).
 *
 * SQLite does not allow an `ADD COLUMN ... NOT NULL` on a table that already
 * has rows without also supplying a DEFAULT. We add the column with
 * `NOT NULL DEFAULT 3`, then `UPDATE` per-name to apply the per-template
 * overrides. The default remains on the column (SQLite can't drop a default
 * without rebuilding the table); future inserts from the runtime layer will
 * always supply an explicit value, so the default only matters for any future
 * migration that inserts a row without specifying this column.
 */
export function runMigration99(db: BunDatabase): void {
	// 1. space_workflows.completion_autonomy_level ---------------------------
	if (
		tableExists(db, 'space_workflows') &&
		!tableHasColumn(db, 'space_workflows', 'completion_autonomy_level')
	) {
		db.exec(
			`ALTER TABLE space_workflows ADD COLUMN completion_autonomy_level INTEGER NOT NULL DEFAULT 3`
		);
		// Per-template backfill — override the default for built-in workflows
		// whose risk profile differs from the generic default of 3.
		const perTemplateLevels: Array<[string, number]> = [
			['Coding Workflow', 3],
			['Research Workflow', 2],
			['Review-Only Workflow', 2],
			['Coding with QA Workflow', 4],
			['Plan & Decompose Workflow', 3],
		];
		const update = db.prepare(
			`UPDATE space_workflows SET completion_autonomy_level = ? WHERE name = ?`
		);
		for (const [name, level] of perTemplateLevels) {
			update.run(level, name);
		}
	}

	// 2. space_tasks pending_completion_* columns ----------------------------
	if (tableExists(db, 'space_tasks')) {
		if (!tableHasColumn(db, 'space_tasks', 'pending_completion_submitted_by_node_id')) {
			db.exec(
				`ALTER TABLE space_tasks ADD COLUMN pending_completion_submitted_by_node_id TEXT DEFAULT NULL`
			);
		}
		if (!tableHasColumn(db, 'space_tasks', 'pending_completion_submitted_at')) {
			db.exec(
				`ALTER TABLE space_tasks ADD COLUMN pending_completion_submitted_at INTEGER DEFAULT NULL`
			);
		}
		if (!tableHasColumn(db, 'space_tasks', 'pending_completion_reason')) {
			db.exec(`ALTER TABLE space_tasks ADD COLUMN pending_completion_reason TEXT DEFAULT NULL`);
		}
	}

	// 3. space_task_report_results table -------------------------------------
	// Only create if the parent tables exist; otherwise this is a very fresh
	// DB that pre-dates the Space system, and the table will be (re)created
	// automatically once spaces tables come online via earlier migrations.
	if (tableExists(db, 'space_tasks') && tableExists(db, 'spaces')) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS space_task_report_results (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				space_id TEXT NOT NULL,
				workflow_node_id TEXT,
				agent_name TEXT,
				summary TEXT NOT NULL,
				evidence TEXT,
				recorded_at INTEGER NOT NULL,
				FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_task_report_results_task ON space_task_report_results(task_id, recorded_at)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_task_report_results_space ON space_task_report_results(space_id, recorded_at)`
		);
	}

	// 4. Widen `pending_checkpoint_type` CHECK constraint ---------------------
	// Migration 86 added this column with CHECK(... IN ('completion_action', 'gate')).
	// Task #39's new `submit_for_approval` tool writes 'task_completion', which
	// the old constraint blocks at SQLite level. SQLite cannot ALTER a CHECK
	// constraint, so rebuild the table with the widened enum. Detection: if the
	// raw CREATE TABLE sql lacks 'task_completion' we need to rebuild.
	if (tableExists(db, 'space_tasks')) {
		const master = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
			.get() as { sql?: string } | undefined;
		const currentSql = master?.sql ?? '';
		if (
			currentSql &&
			!currentSql.includes("'task_completion'") &&
			tableHasColumn(db, 'space_tasks', 'pending_checkpoint_type')
		) {
			// Build the INSERT/SELECT column list from the intersection of the
			// full post-M98 schema and the columns the existing table actually
			// has. This makes the rebuild safe when M98 is invoked against an
			// older/minimal schema (e.g. isolated migration tests that construct
			// a bare-bones space_tasks and then call runMigration98 directly).
			// In production every prior migration has already run so the source
			// table has all of these columns and the list is exhaustive.
			const fullColumnList = [
				'id',
				'space_id',
				'task_number',
				'title',
				'description',
				'status',
				'priority',
				'labels',
				'workflow_run_id',
				'preferred_workflow_id',
				'created_by_task_id',
				'result',
				'depends_on',
				'active_session',
				'task_agent_session_id',
				'approval_source',
				'approval_reason',
				'approved_at',
				'block_reason',
				'archived_at',
				'created_at',
				'started_at',
				'completed_at',
				'updated_at',
				'pending_action_index',
				'pending_checkpoint_type',
				'reported_status',
				'reported_summary',
				'pending_completion_submitted_by_node_id',
				'pending_completion_submitted_at',
				'pending_completion_reason',
			];
			const existingColumns = new Set(
				(db.prepare(`PRAGMA table_info('space_tasks')`).all() as Array<{ name: string }>).map(
					(r) => r.name
				)
			);
			const copyColumns = fullColumnList.filter((c) => existingColumns.has(c));
			const copyColsSql = copyColumns.join(', ');

			// Capture existing non-autoindex DDL so we can re-create exactly the
			// indexes the table had — no more, no less. Some earlier migrations
			// intentionally dropped indexes (e.g. M71 removed idx_space_tasks_status
			// when its column semantics changed); we must not silently re-add them.
			const existingIndexDdl = (
				db
					.prepare(
						`SELECT sql FROM sqlite_master
						 WHERE type='index' AND tbl_name='space_tasks' AND sql IS NOT NULL`
					)
					.all() as Array<{ sql: string }>
			)
				.map((r) => r.sql)
				.filter((sql) => !!sql);

			db.exec('PRAGMA foreign_keys = OFF');
			db.exec('BEGIN');
			try {
				db.exec(`
					CREATE TABLE space_tasks_m98_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						task_number INTEGER NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'open'
							CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
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
						pending_action_index INTEGER DEFAULT NULL,
						pending_checkpoint_type TEXT DEFAULT NULL
							CHECK(pending_checkpoint_type IN ('completion_action', 'gate', 'task_completion')),
						reported_status TEXT DEFAULT NULL
							CHECK(reported_status IS NULL OR reported_status IN ('done', 'blocked', 'cancelled')),
						reported_summary TEXT DEFAULT NULL,
						pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
						pending_completion_submitted_at INTEGER DEFAULT NULL,
						pending_completion_reason TEXT DEFAULT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
					)
				`);
				db.exec(
					`INSERT INTO space_tasks_m98_new (${copyColsSql}) SELECT ${copyColsSql} FROM space_tasks`
				);
				db.exec(`DROP TABLE space_tasks`);
				db.exec(`ALTER TABLE space_tasks_m98_new RENAME TO space_tasks`);
				// Re-create exactly the indexes that existed before the rebuild.
				// Using IF NOT EXISTS on each so a DDL that happens to use the
				// non-IF-EXISTS form still applies cleanly.
				for (const ddl of existingIndexDdl) {
					const normalized = ddl.replace(
						/^CREATE (UNIQUE )?INDEX /i,
						(_m, unique) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `
					);
					db.exec(normalized);
				}
				db.exec('COMMIT');
			} catch (err) {
				db.exec('ROLLBACK');
				throw err;
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}
}

/**
 * Migration 100: Add `source` and `source_path` columns to `app_mcp_servers`.
 *
 * Part of the MCP config unification work (docs/plans/unify-mcp-config-model).
 * Introduces provenance tracking so the registry can distinguish:
 *   - `builtin`  — seeded by `seedDefaultMcpEntries` on daemon startup.
 *   - `user`     — created via the MCP Servers UI / `mcp.registry.create` RPC.
 *   - `imported` — discovered by `McpImportService` scanning workspace and
 *                  user-level `.mcp.json` files. `source_path` records the
 *                  absolute path of the originating file so the import service
 *                  can upsert/prune rows keyed by `(source_path, name)`.
 *
 * Backfill policy:
 *   - Rows matching a known seed name are tagged `source='builtin'`. The seed
 *     list is inlined to avoid rewriting history as new builtins are added —
 *     subsequent seed runs upsert them with `source='builtin'`.
 *   - All remaining rows are tagged `source='user'`, matching the M2 scope
 *     note: before this migration every row was either seeded or user-authored.
 *
 * Imported rows get a partial unique index on `(source_path, name)` so the
 * import service can upsert idempotently and reject the same server being
 * imported twice from the same file. Imported rows still share the existing
 * global `name UNIQUE` constraint — two `.mcp.json` files can't both import a
 * server with the same name; the second is rejected at service level.
 *
 * Idempotent via `tableHasColumn` guards and `CREATE INDEX IF NOT EXISTS`.
 */
export function runMigration100(db: BunDatabase): void {
	if (!tableExists(db, 'app_mcp_servers')) {
		// Very fresh DB — `createTables` will create the table with the new
		// columns already present, so this migration has nothing to do.
		return;
	}

	// 1. Add `source` column. SQLite can't enforce NOT NULL on ALTER with no
	//    default, so we add it nullable, backfill, then rely on application-
	//    level validation (the repo requires `source` on writes).
	if (!tableHasColumn(db, 'app_mcp_servers', 'source')) {
		db.exec(`ALTER TABLE app_mcp_servers ADD COLUMN source TEXT`);

		// Backfill: rows with a seeded name → 'builtin'; everything else → 'user'.
		// Kept in sync with `seed-defaults.ts` at time of writing.
		const builtinSeedNames = ['fetch-mcp', 'chrome-devtools'];
		const placeholders = builtinSeedNames.map(() => '?').join(', ');
		db.prepare(
			`UPDATE app_mcp_servers SET source = 'builtin' WHERE name IN (${placeholders}) AND source IS NULL`
		).run(...builtinSeedNames);

		db.exec(`UPDATE app_mcp_servers SET source = 'user' WHERE source IS NULL`);
	}

	// 2. Add `source_path` column. NULL for `builtin`/`user`; absolute path for `imported`.
	if (!tableHasColumn(db, 'app_mcp_servers', 'source_path')) {
		db.exec(`ALTER TABLE app_mcp_servers ADD COLUMN source_path TEXT`);
	}

	// 3. Partial unique index on `(source_path, name)` WHERE source = 'imported'.
	//    Enables idempotent upserts from the import service: re-scanning the same
	//    `.mcp.json` finds the existing row instead of creating a duplicate.
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_mcp_servers_import
		 ON app_mcp_servers(source_path, name)
		 WHERE source = 'imported' AND source_path IS NOT NULL`
	);
}

/**
 * Migration 101 — MCP M3: Generalize per-scope MCP enablement.
 *
 * Goal: replace the room-only `room_mcp_enablement` table and the ad-hoc
 * `GlobalSettings.disabledMcpServers` / `SessionConfig.disabledMcpServers`
 * lists with a single table whose rows each encode one explicit override at a
 * specific scope (space / room / session). Missing rows mean "inherit" — the
 * most specific scope with an override wins, otherwise the registry default
 * is used.
 *
 * Steps:
 *   1. Create `mcp_enablement` with UNIQUE (scope_type, scope_id, server_id).
 *   2. Copy existing `room_mcp_enablement` rows as scope_type='room'.
 *   3. Seed scope_type='space', enabled=0 rows from
 *      `global_settings.disabledMcpServers` (string[] of server names) for
 *      every active space, resolving server name → server id via
 *      `app_mcp_servers`.
 *   4. Seed scope_type='session', enabled=0 rows from each session's
 *      `config.tools.disabledMcpServers` list. The legacy session config field
 *      is left untouched (M5 will drop it).
 *
 * The migration is fully idempotent:
 *   - Table creation uses IF NOT EXISTS.
 *   - All INSERTs use INSERT OR IGNORE so re-running after a partial run, or
 *     running on a DB where overrides were already applied, is a no-op.
 *   - Legacy `room_mcp_enablement` / `GlobalSettings.disabledMcpServers` /
 *     `SessionConfig.disabledMcpServers` are preserved for this milestone so
 *     rollback remains trivial. M5 will purge them.
 */
export function runMigration101(db: BunDatabase): void {
	// 1. Create the unified table -------------------------------------------
	// Schema matches docs/plans/unify-mcp-config-model/00-overview.md exactly:
	// composite PRIMARY KEY on (server_id, scope_type, scope_id). No surrogate
	// id / timestamps — callers identify rows by their natural key.
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

	// 2. Copy `room_mcp_enablement` rows as scope='room' --------------------
	if (tableExists(db, 'room_mcp_enablement')) {
		const rows = db
			.prepare(`SELECT room_id, server_id, enabled FROM room_mcp_enablement`)
			.all() as Array<{ room_id: string; server_id: string; enabled: number }>;
		const insert = db.prepare(
			`INSERT OR IGNORE INTO mcp_enablement
				(server_id, scope_type, scope_id, enabled)
			 VALUES (?, 'room', ?, ?)`
		);
		for (const row of rows) {
			insert.run(row.server_id, row.room_id, row.enabled ? 1 : 0);
		}
	}

	// 3. Seed scope='space' rows from GlobalSettings.disabledMcpServers ------
	// The legacy global list stores server *names*; resolve each to a server id
	// via the app_mcp_servers registry. Names with no matching registry entry
	// are silently skipped — the legacy list predates the registry so orphaned
	// names are expected.
	if (
		tableExists(db, 'global_settings') &&
		tableExists(db, 'spaces') &&
		tableExists(db, 'app_mcp_servers')
	) {
		try {
			const settingsRow = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
				| { settings?: string }
				| undefined;
			const raw = settingsRow?.settings ?? '{}';
			const parsed = JSON.parse(raw) as { disabledMcpServers?: unknown };
			const disabledNames = Array.isArray(parsed.disabledMcpServers)
				? (parsed.disabledMcpServers.filter(
						(n) => typeof n === 'string' && n.length > 0
					) as string[])
				: [];

			if (disabledNames.length > 0) {
				const spaceRows = db
					.prepare(`SELECT id FROM spaces WHERE status = 'active'`)
					.all() as Array<{ id: string }>;

				const serverByName = db.prepare(`SELECT id FROM app_mcp_servers WHERE name = ?`);
				const insert = db.prepare(
					`INSERT OR IGNORE INTO mcp_enablement
						(server_id, scope_type, scope_id, enabled)
					 VALUES (?, 'space', ?, 0)`
				);

				for (const { id: spaceId } of spaceRows) {
					for (const name of disabledNames) {
						const srv = serverByName.get(name) as { id?: string } | undefined;
						if (!srv?.id) continue;
						insert.run(srv.id, spaceId);
					}
				}
			}
		} catch {
			// Defensive: a malformed global_settings row should not break all
			// later migrations. Leaving the table empty is safe — sessions will
			// keep using the legacy list until the caller migrates overrides.
		}
	}

	// 4. Seed scope='session' rows from each session's disabledMcpServers ----
	if (tableExists(db, 'sessions') && tableExists(db, 'app_mcp_servers')) {
		const sessionRows = db.prepare(`SELECT id, config FROM sessions`).all() as Array<{
			id: string;
			config: string;
		}>;

		const serverByName = db.prepare(`SELECT id FROM app_mcp_servers WHERE name = ?`);
		const insert = db.prepare(
			`INSERT OR IGNORE INTO mcp_enablement
				(server_id, scope_type, scope_id, enabled)
			 VALUES (?, 'session', ?, 0)`
		);

		for (const row of sessionRows) {
			let disabledNames: string[] = [];
			try {
				const cfg = JSON.parse(row.config ?? '{}') as {
					tools?: { disabledMcpServers?: unknown };
					disabledMcpServers?: unknown;
				};
				const candidate = cfg.tools?.disabledMcpServers ?? cfg.disabledMcpServers;
				if (Array.isArray(candidate)) {
					disabledNames = candidate.filter(
						(n): n is string => typeof n === 'string' && n.length > 0
					);
				}
			} catch {
				continue;
			}

			for (const name of disabledNames) {
				const srv = serverByName.get(name) as { id?: string } | undefined;
				if (!srv?.id) continue;
				insert.run(srv.id, row.id);
			}
		}
	}
}

/**
 * Migration 102 — M5 of `unify-mcp-config-model`: strip legacy MCP keys from
 * the `global_settings` JSON blob.
 *
 * The keys removed here were the previous-generation MCP toggling surface:
 *   - `disabledMcpServers` (string[])           → enablement now lives in
 *   - `mcpServerSettings`  (allowed/defaultOn)  → `app_mcp_servers` +
 *   - `enabledMcpServers`  (string[])              `mcp_enablement` rows
 *   - `enableAllProjectMcpServers` (boolean)
 *
 * The corresponding TypeScript fields were dropped in M5 (see
 * `packages/shared/src/types/settings.ts`). On the next read after this
 * migration the JSON-shape settings won't carry these keys back in.
 *
 * Order matters: this runs *after* M101, which seeds the new
 * `mcp_enablement` table from these same legacy keys. If we stripped them
 * first, M101 would have nothing to seed from on a pre-M3 DB.
 *
 * No schema changes; failures are logged-and-swallowed to match the rest of
 * the JSON-blob migrations (autoScroll, etc.) — a malformed row should not
 * prevent the daemon from starting.
 */
export function runMigration102(db: BunDatabase): void {
	if (!tableExists(db, 'global_settings')) {
		return;
	}
	try {
		const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
			| { settings: string }
			| undefined;
		if (!row) return;

		const settings = JSON.parse(row.settings) as Record<string, unknown>;
		const legacyKeys = [
			'disabledMcpServers',
			'mcpServerSettings',
			'enabledMcpServers',
			'enableAllProjectMcpServers',
		] as const;

		let mutated = false;
		for (const key of legacyKeys) {
			if (key in settings) {
				delete settings[key];
				mutated = true;
			}
		}
		if (!mutated) return;

		db.prepare(
			`UPDATE global_settings SET settings = ?, updated_at = datetime('now') WHERE id = 1`
		).run(JSON.stringify(settings));
	} catch {
		// Swallow — same policy as runMigration12.
	}
}

/**
 * Migration 103 — PR 1/5 of the task-agent-as-post-approval-executor refactor.
 *
 * See `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * (§1.3 status, §4.4 migration). Schema-only — no runtime consumer reads the
 * `'approved'` value or the three new columns in this PR. PR 2 wires them up.
 *
 * Changes:
 *   1. Widen the `space_tasks.status` CHECK constraint so `'approved'` is a
 *      legal status value alongside the existing
 *      `open | in_progress | review | done | blocked | cancelled | archived`.
 *      SQLite cannot ALTER a CHECK constraint in place, so the full
 *      table-rebuild pattern used by M99 is reused here.
 *   2. Add `space_tasks.post_approval_session_id TEXT NULL`.
 *   3. Add `space_tasks.post_approval_started_at INTEGER NULL`.
 *   4. Add `space_tasks.post_approval_blocked_reason TEXT NULL`.
 *   5. Add `space_workflows.post_approval TEXT NULL` — stores the optional
 *      `PostApprovalRoute` as a JSON blob so workflow CRUD round-trips preserve
 *      the new field. Shape: `{"targetAgent": "...", "instructions": "..."}`.
 *
 * No backfill: at migration time all existing rows have statuses that do not
 * include `'approved'`, and the three new columns are nullable.
 *
 * Idempotent: re-running is a no-op — the rebuild is skipped when the current
 * CREATE TABLE SQL already advertises `'approved'`, and each ADD COLUMN is
 * guarded by `tableHasColumn`.
 */
export function runMigration103(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) {
		// No `space_tasks` yet — nothing to rebuild. In the full
		// `runMigrations` pipeline M29 creates this table long before M103
		// runs, so this branch only fires when `runMigration103` is invoked
		// standalone on a DB that has not had M29 applied (tests / dev
		// tooling). Skipping here is safe: once M29 creates the table any
		// later M103 invocation will enter the rebuild path below.
		return;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Step 1: rebuild `space_tasks` to widen the `status` CHECK constraint.
	// ─────────────────────────────────────────────────────────────────────────
	const master = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
		.get() as { sql?: string } | undefined;
	const currentSql = master?.sql ?? '';

	// Detection: rebuild needed if the CHECK clause does not already include
	// `'approved'`. We match on the substring so the migration is robust to
	// whitespace / ordering differences between older and newer table rebuilds.
	const hasApprovedInCheck =
		currentSql.includes('status IN (') && /status\s+IN\s*\([^)]*'approved'/.test(currentSql);

	if (currentSql && !hasApprovedInCheck) {
		// Rebuild from the live schema, changing only the status CHECK. Some
		// upgraded databases can already contain columns from later migrations
		// such as custom_agent_id, goal_id, or slot_role, and their indexes must
		// keep working after this rebuild.
		const newTableSql = widenSpaceTasksApprovedStatusCheck(
			replaceCreateTableName(currentSql, 'space_tasks_m103_new')
		);
		const copyColumns = tableColumnNames(db, 'space_tasks');
		const copyColsSql = copyColumns.map(quoteSqlIdent).join(', ');
		const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN');
		try {
			db.exec(newTableSql);
			db.exec(
				`INSERT INTO space_tasks_m103_new (${copyColsSql}) SELECT ${copyColsSql} FROM space_tasks`
			);
			db.exec(`DROP TABLE space_tasks`);
			db.exec(`ALTER TABLE space_tasks_m103_new RENAME TO space_tasks`);
			recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Steps 2–4: add the three post-approval columns. Nullable, no backfill.
	// ─────────────────────────────────────────────────────────────────────────
	if (!tableHasColumn(db, 'space_tasks', 'post_approval_session_id')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_session_id TEXT DEFAULT NULL`);
	}
	if (!tableHasColumn(db, 'space_tasks', 'post_approval_started_at')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_started_at INTEGER DEFAULT NULL`);
	}
	if (!tableHasColumn(db, 'space_tasks', 'post_approval_blocked_reason')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_blocked_reason TEXT DEFAULT NULL`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Step 5: add `space_workflows.post_approval` JSON column.
	//
	// Stores the optional `PostApprovalRoute` object as a JSON string. NULL
	// (the default) means the workflow has no post-approval route configured.
	// Guarded so re-runs are no-ops, and skipped when the parent table does
	// not yet exist (very fresh DB — the later seeders will pick up the new
	// column once migration 29 has created the table).
	// ─────────────────────────────────────────────────────────────────────────
	if (
		tableExists(db, 'space_workflows') &&
		!tableHasColumn(db, 'space_workflows', 'post_approval')
	) {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN post_approval TEXT DEFAULT NULL`);
	}
}

/**
 * Migration 104 — PR 5/5 of the task-agent-as-post-approval-executor refactor.
 *
 * Drops the completion-action schema fields. PR 4/5 already removed every
 * runtime path that wrote `pending_checkpoint_type='completion_action'`, but
 * we defensively rewrite any leftover rows to `'task_completion'` before
 * tightening the CHECK constraint. We then drop two now-unused columns:
 *   - `space_tasks.pending_action_index`
 *   - `space_workflow_runs.completion_actions_fired_at`
 *
 * The optional drop of the legacy `space_task_report_results` table (plan
 * §4.4 step 9) is intentionally deferred to a later migration — that step is
 * gated on auditing whether any writer paths still reach the table. Splitting
 * the audit out of this migration keeps M104 small and easy to roll forward.
 *
 * SQLite cannot drop columns or alter CHECK constraints in place, so the
 * migration uses the table-rebuild pattern (mirrors M99/M103). It is
 * idempotent: re-running it on a DB that has already been migrated is a no-op
 * because the rebuild detection checks the live CHECK clause.
 */
export function runMigration104(db: BunDatabase): void {
	// ─────────────────────────────────────────────────────────────────────────
	// Step 5: rewrite any live tasks paused at 'completion_action' to
	// 'task_completion'. Clear `pending_action_index` because the field is
	// about to be dropped and would otherwise survive in the rebuilt table.
	// ─────────────────────────────────────────────────────────────────────────
	if (tableExists(db, 'space_tasks')) {
		const hasCheckpointType = tableHasColumn(db, 'space_tasks', 'pending_checkpoint_type');
		const hasActionIndex = tableHasColumn(db, 'space_tasks', 'pending_action_index');
		if (hasCheckpointType && hasActionIndex) {
			db.prepare(
				`UPDATE space_tasks
				    SET pending_checkpoint_type = 'task_completion',
				        pending_action_index = NULL
				  WHERE pending_checkpoint_type = 'completion_action'`
			).run();
		} else if (hasCheckpointType) {
			db.prepare(
				`UPDATE space_tasks
				    SET pending_checkpoint_type = 'task_completion'
				  WHERE pending_checkpoint_type = 'completion_action'`
			).run();
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Steps 6 + 7: rebuild `space_tasks` to drop `pending_action_index` and
	// tighten the `pending_checkpoint_type` CHECK constraint.
	// ─────────────────────────────────────────────────────────────────────────
	if (tableExists(db, 'space_tasks')) {
		const master = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
			.get() as { sql?: string } | undefined;
		const currentSql = master?.sql ?? '';

		const hasLegacyCheckpointCheck =
			currentSql.includes("pending_checkpoint_type IN ('completion_action'") ||
			/pending_checkpoint_type\s+IN\s*\([^)]*'completion_action'/.test(currentSql);
		const hasActionIndexCol = tableHasColumn(db, 'space_tasks', 'pending_action_index');
		const needsRebuild = !!currentSql && (hasLegacyCheckpointCheck || hasActionIndexCol);

		if (needsRebuild) {
			// Rebuild from the live schema, dropping only pending_action_index
			// and tightening pending_checkpoint_type. This preserves optional
			// columns that may exist on real upgraded databases.
			const newTableSql = tightenPendingCheckpointTypeCheck(
				createTableSqlWithoutColumn(
					replaceCreateTableName(currentSql, 'space_tasks_m104_new'),
					'pending_action_index'
				)
			);
			const copyColumns = tableColumnNames(db, 'space_tasks').filter(
				(c) => c !== 'pending_action_index'
			);
			const copyColsSql = copyColumns.map(quoteSqlIdent).join(', ');
			const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

			db.exec('PRAGMA foreign_keys = OFF');
			db.exec('BEGIN');
			try {
				db.exec(newTableSql);
				db.exec(
					`INSERT INTO space_tasks_m104_new (${copyColsSql}) SELECT ${copyColsSql} FROM space_tasks`
				);
				db.exec(`DROP TABLE space_tasks`);
				db.exec(`ALTER TABLE space_tasks_m104_new RENAME TO space_tasks`);
				recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
				db.exec('COMMIT');
			} catch (err) {
				db.exec('ROLLBACK');
				throw err;
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Step 8: drop `completion_actions_fired_at` from `space_workflow_runs`.
	// SQLite has supported `ALTER TABLE … DROP COLUMN` since 3.35; Bun ships a
	// new-enough SQLite. Guarded so re-runs are no-ops.
	// ─────────────────────────────────────────────────────────────────────────
	if (
		tableExists(db, 'space_workflow_runs') &&
		tableHasColumn(db, 'space_workflow_runs', 'completion_actions_fired_at')
	) {
		db.exec(`ALTER TABLE space_workflow_runs DROP COLUMN completion_actions_fired_at`);
	}
}

/**
 * Migration 105: Add `template_name` and `template_hash` columns to
 * `space_agents` for preset-agent drift detection. Mirrors the workflow
 * template-tracking columns added in M90 — preset-seeded agents now carry
 * these fields so the daemon can detect when the source preset definition
 * has changed and the UI can surface a "Sync from template" action.
 *
 * Both columns are nullable: user-created agents always have NULL for both,
 * which is the marker the drift-detection RPC uses to ignore them.
 *
 * Idempotent: re-running on a DB that already has the columns is a no-op.
 */
export function runMigration105(db: BunDatabase): void {
	if (!tableExists(db, 'space_agents')) return;

	if (!tableHasColumn(db, 'space_agents', 'template_name')) {
		db.exec(`ALTER TABLE space_agents ADD COLUMN template_name TEXT DEFAULT NULL`);
	}
	if (!tableHasColumn(db, 'space_agents', 'template_hash')) {
		db.exec(`ALTER TABLE space_agents ADD COLUMN template_hash TEXT DEFAULT NULL`);
	}
}

/**
 * Migration 106 — delegated to m106-backfill-agent-templates.ts so the
 * frozen preset definitions don't bloat this file. Runs strictly *after*
 * M105 so the columns exist. The behaviour is documented in that module.
 * Exported for direct invocation from tests.
 */
export function runMigration106(db: BunDatabase): void {
	runMigration106External(db);
}

/**
 * Migration 107: Drop the legacy `space_task_report_results` table.
 *
 * Background: the `report_result` end-node tool (Task #39) wrote append-only
 * audit rows here. The tool has since been removed in favour of
 * `task.reportedStatus` plus `save_artifact({ append: true })`. M104's plan
 * §4.4 step 9 deferred dropping the table pending a writer audit; that audit
 * is now complete and no production code path still references the table —
 * the repository, helpers, and tests have all been deleted alongside this
 * migration.
 *
 * Idempotent: `DROP TABLE IF EXISTS` and `DROP INDEX IF EXISTS` make this a
 * safe no-op on databases that have already been migrated or that never had
 * the table.
 */
export function runMigration107(db: BunDatabase): void {
	db.exec(`DROP INDEX IF EXISTS idx_space_task_report_results_task`);
	db.exec(`DROP INDEX IF EXISTS idx_space_task_report_results_space`);
	db.exec(`DROP TABLE IF EXISTS space_task_report_results`);
}

/**
 * Migration 108: Remove stale Brave Search MCP registry data.
 *
 * Earlier builds seeded an application MCP server and a built-in skill for a
 * Brave-backed web search integration. Those seed definitions have been
 * removed, but existing SQLite databases can still contain the rows and their
 * per-room/space/session overrides. This migration removes only the known
 * legacy identifiers and rows whose MCP command/config explicitly points at
 * the removed package/API key, while leaving unrelated user-created MCP
 * servers intact.
 */
export function runMigration108(db: BunDatabase): void {
	const legacyServerNames = ['brave-search', 'web-search-brave'];
	const legacySkillNames = ['web-search-mcp', 'builtin-web-search-mcp'];

	const legacyServerIds = new Set<string>();
	if (tableExists(db, 'app_mcp_servers')) {
		const rows = db
			.prepare(
				`SELECT id, name, description, command, args, env
				   FROM app_mcp_servers`
			)
			.all() as Array<{
			id: string;
			name: string;
			description: string | null;
			command: string | null;
			args: string | null;
			env: string | null;
		}>;

		for (const row of rows) {
			const searchable = [
				row.name,
				row.description ?? '',
				row.command ?? '',
				row.args ?? '',
				row.env ?? '',
			]
				.join('\n')
				.toLowerCase();
			if (
				legacyServerNames.includes(row.name.toLowerCase()) ||
				searchable.includes('server-brave-search') ||
				searchable.includes('brave_api_key') ||
				searchable.includes('brave search')
			) {
				legacyServerIds.add(row.id);
			}
		}
	}

	const legacySkillIds = new Set<string>();
	if (tableExists(db, 'skills')) {
		const rows = db
			.prepare(`SELECT id, name, display_name, description, config FROM skills`)
			.all() as Array<{
			id: string;
			name: string;
			display_name: string;
			description: string;
			config: string;
		}>;

		for (const row of rows) {
			const lowerName = row.name.toLowerCase();
			const searchable = [row.name, row.display_name, row.description, row.config]
				.join('\n')
				.toLowerCase();
			const referencesLegacyServer = [...legacyServerIds].some((id) => row.config.includes(id));
			if (
				legacySkillNames.includes(lowerName) ||
				row.display_name.toLowerCase() === 'web search (mcp)' ||
				searchable.includes('brave search') ||
				searchable.includes('brave_api_key') ||
				referencesLegacyServer
			) {
				legacySkillIds.add(row.id);
			}
		}
	}

	if (legacySkillIds.size > 0) {
		if (tableExists(db, 'room_skill_overrides')) {
			const deleteOverride = db.prepare(`DELETE FROM room_skill_overrides WHERE skill_id = ?`);
			for (const id of legacySkillIds) deleteOverride.run(id);
		}
		const deleteSkill = db.prepare(`DELETE FROM skills WHERE id = ?`);
		for (const id of legacySkillIds) deleteSkill.run(id);
	}

	if (legacyServerIds.size > 0) {
		if (tableExists(db, 'mcp_enablement')) {
			const deleteEnablement = db.prepare(`DELETE FROM mcp_enablement WHERE server_id = ?`);
			for (const id of legacyServerIds) deleteEnablement.run(id);
		}
		if (tableExists(db, 'room_mcp_enablement')) {
			const deleteRoomEnablement = db.prepare(
				`DELETE FROM room_mcp_enablement WHERE server_id = ?`
			);
			for (const id of legacyServerIds) deleteRoomEnablement.run(id);
		}
		const deleteServer = db.prepare(`DELETE FROM app_mcp_servers WHERE id = ?`);
		for (const id of legacyServerIds) deleteServer.run(id);
	}

	const legacyNames = new Set([...legacyServerNames, ...legacySkillNames]);
	if (tableExists(db, 'global_settings')) {
		try {
			const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
				| { settings: string }
				| undefined;
			if (row) {
				const settings = JSON.parse(row.settings) as Record<string, unknown>;
				let mutated = false;
				for (const key of ['disabledMcpServers', 'enabledMcpServers'] as const) {
					const value = settings[key];
					if (!Array.isArray(value)) continue;
					const filtered = value.filter((name) => {
						return typeof name !== 'string' || !legacyNames.has(name.toLowerCase());
					});
					if (filtered.length !== value.length) {
						settings[key] = filtered;
						mutated = true;
					}
				}
				if (mutated) {
					db.prepare(
						`UPDATE global_settings SET settings = ?, updated_at = datetime('now') WHERE id = 1`
					).run(JSON.stringify(settings));
				}
			}
		} catch {
			// Malformed settings should not block startup; the registry rows above
			// are the authoritative availability surface.
		}
	}

	if (tableExists(db, 'sessions')) {
		const rows = db.prepare(`SELECT id, config FROM sessions`).all() as Array<{
			id: string;
			config: string | null;
		}>;
		const update = db.prepare(`UPDATE sessions SET config = ? WHERE id = ?`);
		for (const row of rows) {
			try {
				const config = JSON.parse(row.config ?? '{}') as Record<string, unknown> & {
					tools?: Record<string, unknown>;
				};
				let mutated = false;
				for (const holder of [config, config.tools].filter(Boolean) as Array<
					Record<string, unknown>
				>) {
					const value = holder.disabledMcpServers;
					if (!Array.isArray(value)) continue;
					const filtered = value.filter((name) => {
						return typeof name !== 'string' || !legacyNames.has(name.toLowerCase());
					});
					if (filtered.length !== value.length) {
						holder.disabledMcpServers = filtered;
						mutated = true;
					}
				}
				if (mutated) update.run(JSON.stringify(config), row.id);
			} catch {
				continue;
			}
		}
	}
}

/**
 * Migration 109: Durable Codex tool continuation recovery.
 *
 * Adds a recoverable `waiting_rebind` node execution state and creates durable
 * bridge tables used to map `tool_use_id` values back to workflow executions
 * after session timeout/restart races.
 */
export function runMigration109(db: BunDatabase): void {
	if (
		tableExists(db, 'node_executions') &&
		!statusCheckContains(db, 'node_executions', 'waiting_rebind')
	) {
		db.exec('PRAGMA foreign_keys = OFF');
		db.exec('BEGIN');
		try {
			db.exec(`
				CREATE TABLE node_executions_m109_new (
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

			db.exec(`
				INSERT INTO node_executions_m109_new
				  (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				   agent_session_id, status, result, data, created_at, started_at,
				   completed_at, updated_at)
				SELECT
				  id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				  agent_session_id, status, result,
				  ${tableHasColumn(db, 'node_executions', 'data') ? 'data' : 'NULL'},
				  created_at, started_at, completed_at, updated_at
				FROM node_executions
			`);

			db.exec(`DROP TABLE node_executions`);
			db.exec(`ALTER TABLE node_executions_m109_new RENAME TO node_executions`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
			);
			db.exec(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_slot
				 ON node_executions(workflow_run_id, workflow_node_id, agent_name)`
			);
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		} finally {
			db.exec('PRAGMA foreign_keys = ON');
		}
	}

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

/**
 * Migration 110: Limit pending-agent-message idempotency to live pending rows.
 *
 * The original M92 unique index covered every historical row with an
 * idempotency key, including delivered/failed/expired messages. Runtime retry
 * dedupe only needs to collapse currently pending rows; terminal history must
 * not suppress a legitimate later resend with the same message text.
 */
export function runMigration110(db: BunDatabase): void {
	if (!tableExists(db, 'pending_agent_messages')) return;

	db.exec('DROP INDEX IF EXISTS idx_pending_agent_messages_idem');
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_agent_messages_idem_pending
		 ON pending_agent_messages(workflow_run_id, target_agent_name, idempotency_key)
		 WHERE idempotency_key IS NOT NULL AND status = 'pending'`
	);
}

export function runMigration111(db: BunDatabase): void {
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
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_github_watched_repo_lookup ON space_github_watched_repos(owner, repo, enabled)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_github_events_task ON space_github_events(task_id, occurred_at)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_github_events_repo ON space_github_events(space_id, repo_owner, repo_name, pr_number)`
	);
}

export function runMigration112(db: BunDatabase): void {
	if (!tableExists(db, 'space_github_events')) return;

	db.exec(`
		DELETE FROM space_github_events
		WHERE rowid IN (
			SELECT rowid
			FROM (
				SELECT
					rowid,
					ROW_NUMBER() OVER (
						PARTITION BY space_id, lower(dedupe_key)
						ORDER BY
							CASE WHEN task_id IS NOT NULL THEN 0 ELSE 1 END,
							CASE state
								WHEN 'delivered' THEN 0
								WHEN 'routed' THEN 1
								WHEN 'processed' THEN 2
								WHEN 'ambiguous' THEN 3
								WHEN 'failed' THEN 4
								WHEN 'ignored' THEN 5
								ELSE 6
							END,
							updated_at DESC,
							occurred_at DESC,
							rowid ASC
					) AS rn
				FROM space_github_events
			)
			WHERE rn > 1
		)
	`);
	db.exec(`UPDATE space_github_events SET dedupe_key = lower(dedupe_key)`);
}

export function runMigration113(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) return;
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id
		ON sdk_messages(session_id, timestamp DESC, id DESC)`);
	// NOTE: idx_sdk_messages_parent_tool (json_extract function index) was
	// removed from here in migration 126. The column-based
	// idx_sdk_messages_parent_tool_use_id added by migration 122 replaces it.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_uuid_status
		ON sdk_messages(session_id, send_status, json_extract(sdk_message, '$.uuid'))`);
}

export function runMigration114(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;

	// Add 'draft' to the status CHECK constraint.
	// SQLite doesn't support ALTER TABLE ... ALTER CONSTRAINT, so we recreate the table.
	// We derive the new DDL from the live schema so all existing constraints
	// (FOREIGN KEYs, CHECKs on other columns) are preserved automatically.
	const master = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
		.get() as { sql?: string } | undefined;
	const currentSql = master?.sql ?? '';
	if (!currentSql) return;

	// Already has 'draft' in the CHECK? Idempotent — skip.
	if (statusCheckContains(db, 'space_tasks', 'draft')) return;

	// Build new DDL: rename table + widen status CHECK to include 'draft'.
	const newTableSql = addDraftToStatusCheck(
		replaceCreateTableName(currentSql, 'space_tasks_m114_new')
	);
	const copyColumns = tableColumnNames(db, 'space_tasks').map(quoteSqlIdent).join(', ');
	const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

	// CRITICAL: Disable foreign keys during table recreation to prevent
	// CASCADE deletes from wiping child rows when we DROP TABLE space_tasks.
	db.exec('PRAGMA foreign_keys = OFF');
	db.exec('BEGIN');
	try {
		db.exec(`DROP TABLE IF EXISTS space_tasks_m114_new`);
		db.exec(newTableSql);
		db.exec(
			`INSERT INTO space_tasks_m114_new (${copyColumns}) SELECT ${copyColumns} FROM space_tasks`
		);
		db.exec(`DROP TABLE space_tasks`);
		db.exec(`ALTER TABLE space_tasks_m114_new RENAME TO space_tasks`);
		recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Adds 'draft' to the status CHECK constraint in a CREATE TABLE statement.
 * The new table keeps all other constraints (FKs, CHECKs) untouched.
 */
function addDraftToStatusCheck(createSql: string): string {
	let matched = false;
	const result = createSql.replace(
		/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
		(match, values: string) => {
			matched = true;
			if (values.includes("'draft'")) {
				return match;
			}
			// Insert 'draft' as the first value
			return `CHECK(status IN ('draft', ${values.trim()}))`;
		}
	);
	if (!matched) {
		throw new Error('Unable to add draft to space_tasks.status CHECK constraint');
	}
	return result;
}

/**
 * Migration 115: Add `task_agent_config` column to `spaces` table.
 *
 * Stores per-space Task Agent overrides (model and custom prompt) as JSON.
 * Nullable — null means no overrides (use code defaults).
 */
export function runMigration115(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;

	// Idempotent: skip if column already exists.
	const columns = tableColumnNames(db, 'spaces');
	if (columns.includes('task_agent_config')) return;

	db.exec(`ALTER TABLE spaces ADD COLUMN task_agent_config TEXT DEFAULT NULL`);
}

/**
 * Migration 116: Add `thinking_level` column to `space_agents` table.
 *
 * Nullable — null means use the app default unless a workflow node slot overrides it.
 */
export function runMigration116(db: BunDatabase): void {
	if (!tableExists(db, 'space_agents')) return;

	const columns = tableColumnNames(db, 'space_agents');
	if (columns.includes('thinking_level')) return;

	db.exec(`ALTER TABLE space_agents ADD COLUMN thinking_level TEXT DEFAULT NULL`);
}

/**
 * Migration 117: Add `disabled` column to `space_workflows` table.
 *
 * When true (1), the workflow cannot be selected for new tasks.
 * Existing workflow runs continue unaffected.
 * Default 0 (enabled) so all existing workflows remain selectable.
 */
export function runMigration117(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;

	const columns = tableColumnNames(db, 'space_workflows');
	if (columns.includes('disabled')) return;

	db.exec(`ALTER TABLE space_workflows ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`);
}

/**
 * Migration 122: Replace the task-thread projection-table approach with a schema
 * fix.
 *
 * Two parallel concerns:
 *
 * 1. Derived columns on `sdk_messages`. The live-query handlers used to compute
 *    `is_renderable`, `is_terminal`, and `parent_tool_use_id` inline via
 *    `json_extract` / `json_each` on every read. Materialising them at write
 *    time keeps the live-query SQL flat and lets a plain B-tree index serve
 *    `parent_tool_use_id` lookups instead of a function index.
 *
 * 2. `task_id` column on `sdk_messages`. Mapping a `space_task` to its
 *    contributing sessions used to require a five-CTE join (target_task →
 *    orchestration → node_executions → space_agents → all_sessions), and a
 *    short-lived denormalised `task_session_map` table tried to short-circuit
 *    it. Stamping `task_id` directly on each persisted SDK message turns the
 *    primary read path (`get all messages for a task`) into a simple indexed
 *    `WHERE task_id = ?` lookup and makes the lookup table unnecessary.
 *
 *    The session already knows its task: `sessions.session_context` carries
 *    `taskId` for both the Task Agent (`type = 'space_task_agent'`) and node
 *    agent (`type = 'worker'`) sub-sessions — set by `task-agent.ts` and
 *    `custom-agent.ts` at session creation. The backfill mines that JSON to
 *    populate task_id for existing rows.
 *
 *    Display-time metadata (kind, role, label, node_execution_id) is derived at
 *    query time by joining `sessions` (for `type` → kind) and `node_executions`
 *    (for `agent_name`, `workflow_node_id`) when needed — there is no
 *    denormalised cache.
 *
 * The migration is idempotent end-to-end:
 * - column adds check `tableColumnNames`
 * - the backfill recomputes derived columns regardless of prior state (the work
 *   is deterministic from `sdk_message` JSON / `sessions.session_context`)
 * - DROP IF EXISTS makes the lookup-table cleanup safe to re-run.
 */
export function runMigration122(db: BunDatabase): void {
	// Step 1: add derived columns to sdk_messages.
	if (tableExists(db, 'sdk_messages')) {
		const columns = tableColumnNames(db, 'sdk_messages');
		const addedRenderable = !columns.includes('is_renderable');
		const addedTerminal = !columns.includes('is_terminal');
		const addedParentToolUseId = !columns.includes('parent_tool_use_id');
		const addedTaskId = !columns.includes('task_id');

		if (addedRenderable) {
			db.exec(`ALTER TABLE sdk_messages ADD COLUMN is_renderable INTEGER NOT NULL DEFAULT 1`);
		}
		if (addedTerminal) {
			db.exec(`ALTER TABLE sdk_messages ADD COLUMN is_terminal INTEGER NOT NULL DEFAULT 0`);
		}
		if (addedParentToolUseId) {
			db.exec(`ALTER TABLE sdk_messages ADD COLUMN parent_tool_use_id TEXT`);
		}
		if (addedTaskId) {
			db.exec(`ALTER TABLE sdk_messages ADD COLUMN task_id TEXT`);
		}

		// Backfill derived columns. The WHERE clause only targets rows whose
		// derived values are genuinely stale, so the migration converges after
		// the first successful run instead of rewriting most of the table on
		// every startup.
		//
		// is_terminal mirrors message_type = 'result'.
		// is_renderable encodes the same predicate the compact-feed used to
		//   apply at read time:
		//     - user rows whose content array contains any tool_result block
		//       render as null in the compact feed → is_renderable = 0
		//     - assistant rows with no tool_use, no non-empty text, and no
		//       non-empty thinking blocks have nothing to display → 0
		//     - everything else → 1 (the column DEFAULT)
		//
		// All json_* calls are guarded by `json_valid(sdk_message)` so a single
		// malformed historical row can't abort the migration. Invalid JSON
		// rows fall through to safe defaults: is_renderable = 1 (preserves the
		// column DEFAULT and keeps the row visible), parent_tool_use_id NULL.
		db.exec(`
			UPDATE sdk_messages
			SET
				is_terminal = CASE WHEN message_type = 'result' THEN 1 ELSE 0 END,
				parent_tool_use_id = CASE
					WHEN json_valid(sdk_message)
					THEN json_extract(sdk_message, '$.parent_tool_use_id')
					ELSE NULL
				END,
				is_renderable = CASE
					WHEN NOT json_valid(sdk_message) THEN 1
					WHEN message_type = 'user'
						AND json_type(sdk_message, '$.message.content') = 'array'
						AND EXISTS (
							SELECT 1
							FROM json_each(json_extract(sdk_message, '$.message.content')) je
							WHERE json_extract(je.value, '$.type') = 'tool_result'
						)
					THEN 0
					WHEN message_type = 'assistant'
						AND json_type(sdk_message, '$.message.content') = 'array'
						AND NOT EXISTS (
							SELECT 1
							FROM json_each(json_extract(sdk_message, '$.message.content')) je
							WHERE json_extract(je.value, '$.type') = 'tool_use'
								OR (
									json_extract(je.value, '$.type') = 'text'
									AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
								)
								OR (
									json_extract(je.value, '$.type') = 'thinking'
									AND TRIM(COALESCE(json_extract(je.value, '$.thinking'), '')) != ''
								)
						)
					THEN 0
					ELSE 1
				END
			WHERE
				-- is_terminal mismatch
				is_terminal != CASE WHEN message_type = 'result' THEN 1 ELSE 0 END
				OR
				-- parent_tool_use_id should be non-NULL but is NULL
				(
					json_valid(sdk_message)
					AND json_extract(sdk_message, '$.parent_tool_use_id') IS NOT NULL
					AND parent_tool_use_id IS NULL
				)
				OR
				-- parent_tool_use_id should be NULL but is non-NULL
				(
					parent_tool_use_id IS NOT NULL
					AND (
						NOT json_valid(sdk_message)
						OR json_extract(sdk_message, '$.parent_tool_use_id') IS NULL
					)
				)
				OR
				-- is_renderable mismatch for user/assistant messages
				(
					message_type IN ('user', 'assistant')
					AND is_renderable != CASE
						WHEN message_type = 'user'
							AND json_type(sdk_message, '$.message.content') = 'array'
							AND EXISTS (
								SELECT 1
								FROM json_each(json_extract(sdk_message, '$.message.content')) je
								WHERE json_extract(je.value, '$.type') = 'tool_result'
							)
						THEN 0
						WHEN message_type = 'assistant'
							AND json_type(sdk_message, '$.message.content') = 'array'
							AND NOT EXISTS (
								SELECT 1
								FROM json_each(json_extract(sdk_message, '$.message.content')) je
								WHERE json_extract(je.value, '$.type') = 'tool_use'
									OR (
										json_extract(je.value, '$.type') = 'text'
										AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
									)
									OR (
										json_extract(je.value, '$.type') = 'thinking'
										AND TRIM(COALESCE(json_extract(je.value, '$.thinking'), '')) != ''
									)
							)
						THEN 0
						ELSE 1
					END
				)
		`);

		// Plain B-tree index — supersedes the json_extract function index
		// (idx_sdk_messages_parent_tool) for parent-tool lookups by reading the
		// new column directly.
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id ON sdk_messages(session_id, parent_tool_use_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_renderable_terminal ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id)`
		);

		// Step 2: backfill `sdk_messages.task_id` from the writing session's
		// `session_context.taskId`. Both the Task Agent and node-agent sub-sessions
		// stamp this at creation, so a JOIN on `sessions` covers every Space
		// session that ever produced messages. Sessions without a task context
		// (worker sessions outside the Space system, lobby/neo, etc.) get NULL —
		// the column is nullable on purpose.
		//
		// Runs whenever rows with `task_id IS NULL` remain for an allowed session
		// type, so an interrupted migration is repaired on next boot. We restrict
		// the scan to rows whose session is an allowed type (space_task_agent,
		// worker) AND actually carries a taskId in context — this avoids re-
		// scanning permanently-NULL rows from ordinary non-Space worker sessions
		// on every startup.
		//
		// `json_valid(s.session_context)` guards against malformed JSON the same
		// way the sdk_message backfill does.
		if (tableExists(db, 'sessions')) {
			db.exec(`
				UPDATE sdk_messages
				SET task_id = (
					SELECT
						CASE
							WHEN s.session_context IS NULL THEN NULL
							WHEN NOT json_valid(s.session_context) THEN NULL
							ELSE json_extract(s.session_context, '$.taskId')
						END
					FROM sessions s
					WHERE s.id = sdk_messages.session_id
					  AND s.type IN ('space_task_agent', 'worker')
				)
				WHERE task_id IS NULL
				  AND session_id IN (
					  SELECT id FROM sessions
					  WHERE type IN ('space_task_agent', 'worker')
						AND session_context IS NOT NULL
						AND json_valid(session_context)
						AND json_extract(session_context, '$.taskId') IS NOT NULL
				  )
			`);
		}

		// Must match the fresh-schema bootstrap in schema/index.ts:
		// `CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id, timestamp)`.
		// Upgraded databases create this index here; fresh databases create it in
		// createIndexes(). Both use IF NOT EXISTS, so the first one wins. Keeping
		// the column list identical ensures upgraded and fresh databases have the
		// same index shape.
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id, timestamp)`
		);
		// Covers the `DISTINCT session_id` dedup in the contributing_sessions CTE.
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session ON sdk_messages(task_id, session_id)`
		);
	}

	// Step 3: drop the legacy `task_session_map` lookup table. It was a
	// denormalised cache of data that already exists on `sessions` +
	// `node_executions`; with `sdk_messages.task_id` populated the read path
	// no longer needs it. Idempotent — early development DBs that never created
	// the table skip cleanly.
	db.exec(`DROP TABLE IF EXISTS task_session_map`);
}

/**
 * Migration 118: Add `setting_sources` column to `space_agents` table.
 *
 * Stores per-agent setting source overrides as JSON (e.g. ["user","project"]).
 * Nullable — null means inherit from Space or global default.
 */
export function runMigration118(db: BunDatabase): void {
	if (!tableExists(db, 'space_agents')) return;

	const columns = tableColumnNames(db, 'space_agents');
	if (columns.includes('setting_sources')) return;

	db.exec(`ALTER TABLE space_agents ADD COLUMN setting_sources TEXT DEFAULT NULL`);
}

/**
 * Migration 119: Add `setting_sources` column to `spaces` table.
 *
 * Stores per-space default setting sources as JSON (e.g. ["user","project"]).
 * Nullable — null means inherit from global default.
 */
export function runMigration119(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;

	const columns = tableColumnNames(db, 'spaces');
	if (columns.includes('setting_sources')) return;

	db.exec(`ALTER TABLE spaces ADD COLUMN setting_sources TEXT DEFAULT NULL`);
}

/**
 * Migration 120: Add `created_by` and `created_by_session` columns to `space_tasks` table.
 *
 * Tracks which agent and session created a task for audit trail.
 * - `created_by`: agent name (e.g. 'space-agent', 'coder', 'task-agent')
 * - `created_by_session`: session ID of the creator
 * Both are nullable — existing rows get NULL.
 */
export function runMigration120(db: BunDatabase): void {
	if (!tableExists(db, 'space_tasks')) return;

	const columns = tableColumnNames(db, 'space_tasks');
	if (!columns.includes('created_by')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN created_by TEXT DEFAULT NULL`);
	}
	if (!columns.includes('created_by_session')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN created_by_session TEXT DEFAULT NULL`);
	}
}

/**
 * Migration 121: Create `mcp_audit_log` table.
 *
 * General audit trail for MCP write operations. Each entry records:
 * - timestamp, agent_name, session_id, tool_name
 * - params_summary: JSON summary of the tool call parameters
 * - space_id, task_id, workflow_run_id: optional context
 */
export function runMigration121(db: BunDatabase): void {
	if (!tableExists(db, 'mcp_audit_log')) {
		db.exec(`
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
			)
		`);
	}

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_space ON mcp_audit_log (space_id, timestamp)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_task ON mcp_audit_log (task_id, timestamp)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_session ON mcp_audit_log (session_id, timestamp)`
	);
}

/**
 * Migration 123: Add external-event lifecycle tables for the External Event Bus.
 *
 * space_external_events
 *   - One row per (space_id, source, dedupe_key) — the canonical source event.
 *   - State machine: published → routed → delivered | failed | ignored | ambiguous
 *   - Terminal states (delivered, failed, ignored, ambiguous) short-circuit
 *     duplicate source observations.
 *   - Retryable states (published, routed, delivery_failed) re-emit so delivery
 *     can retry.
 *
 * space_external_event_deliveries
 *   - Per-subscription delivery rows keyed by (event_id, delivery_key).
 *   - Terminal delivery states: delivered, failed.
 *   - The router advances the source event to terminal delivered only when
 *     every expected delivery is delivered.
 *   - A single terminal failed delivery keeps the source event failed forever.
 */
export function runMigration123(db: BunDatabase): void {
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
			pr_number INTEGER,
			repo_owner TEXT,
			repo_name TEXT,
			branch TEXT,
			summary TEXT NOT NULL,
			external_url TEXT,
			payload_json TEXT NOT NULL,
			routed_task_id TEXT,
			state TEXT NOT NULL DEFAULT 'published'
				CHECK(state IN ('published', 'routed', 'delivered', 'delivery_failed', 'failed', 'ignored', 'ambiguous')),
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
}

/**
 * Migration 124: Simplify external-event schema.
 *
 * The event pipeline is now intentionally agnostic to task-system concerns.
 * Source-specific metadata (PR number, repo owner, branch) lives in the opaque
 * payload_json column. The state machine is simplified from 7 states to 4.
 *
 * Changes to space_external_events:
 *   - DROP pr_number, repo_owner, repo_name, branch, routed_task_id columns.
 *   - Backfill legacy columns (pr_number, repo_owner, repo_name, branch,
 *     routed_task_id) into payload_json so subscribers retain source-specific
 *     metadata and historical routing data is preserved for forensic purposes.
 *   - Migrate existing rows: 'routed' → 'published', 'delivery_failed' → 'published',
 *     'ambiguous' → 'ignored'.
 *   - Update CHECK constraint to ('published', 'delivered', 'failed', 'ignored').
 *
 * Note: SQLite does not support DROP COLUMN directly. We recreate the table.
 * The rewrite is wrapped in a transaction with foreign keys disabled to prevent
 * the child table (space_external_event_deliveries) from being cascade-deleted.
 */
export function runMigration124(db: BunDatabase): void {
	// Crash-recovery: if a prior interrupted rewrite left the temp table
	// behind, recover the data before proceeding. Two cases:
	//   1. Old table missing, _new exists → rename _new to canonical.
	//   2. Both exist (e.g. runMigration123 recreated an empty old table)
	//      → drop the empty old table, rename _new to canonical.
	const hasOldTable = db
		.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_external_events'`)
		.get();
	const hasNewTable = db
		.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_external_events_new'`)
		.get();
	if (hasNewTable) {
		if (!hasOldTable) {
			db.exec(`ALTER TABLE space_external_events_new RENAME TO space_external_events`);
		} else {
			// Both exist: the old table may be empty (recreated by M123).
			// Check row counts to decide which has the real data.
			const oldCount = db.prepare(`SELECT COUNT(*) AS n FROM space_external_events`).get() as {
				n: number;
			};
			const newCount = db.prepare(`SELECT COUNT(*) AS n FROM space_external_events_new`).get() as {
				n: number;
			};
			if (newCount.n > 0 && oldCount.n === 0) {
				db.exec(`DROP TABLE space_external_events`);
				db.exec(`ALTER TABLE space_external_events_new RENAME TO space_external_events`);
			} else if (oldCount.n > 0 && newCount.n > 0) {
				// Both have data — this should not happen, but preserve the
				// canonical table and drop the temp table to avoid confusion.
				db.exec(`DROP TABLE space_external_events_new`);
			}
		}
	}

	// Check if the old schema still exists (has pr_number column).
	const hasOldSchema = db
		.prepare(`SELECT 1 FROM pragma_table_info('space_external_events') WHERE name = 'pr_number'`)
		.get();
	if (!hasOldSchema) {
		// Already migrated or fresh database with new schema.
		return;
	}

	// Clean up any leftover temp table from a previous interrupted migration.
	db.exec(`DROP TABLE IF EXISTS space_external_events_new`);

	// Capture the original foreign_keys setting so we can restore it after
	// the migration. This avoids side effects on callers that intentionally
	// disabled FK checks on the same connection.
	const originalFk = db.prepare(`PRAGMA foreign_keys`).get() as
		| { foreign_keys: number }
		| undefined;
	const fkWasOn = originalFk ? originalFk.foreign_keys === 1 : true;

	// Disable foreign keys before dropping the parent table so the child
	// table (space_external_event_deliveries) is not cascade-deleted.
	db.exec(`PRAGMA foreign_keys = OFF`);

	try {
		db.transaction(() => {
			// 1. Backfill legacy columns into payload_json so subscribers retain
			//    source-specific metadata after the columns are dropped.
			//    Guard against malformed JSON: coerce invalid payloads to '{}' first.
			//    Also coerce valid non-object roots (arrays, strings, numbers) to '{}'
			//    so json_set can write object keys. json_type returns 'object' for '{}'.
			//    Prefer existing payload values over legacy columns (payload was
			//    already normalized by the ingestion pipeline; legacy columns may
			//    contain padded/case-variant strings).
			db.exec(`
				UPDATE space_external_events
				SET payload_json = '{}'
				WHERE json_valid(payload_json) = 0
				   OR json_type(payload_json) != 'object'
			`);
			db.exec(`
				UPDATE space_external_events
				SET payload_json = json_set(
					payload_json,
					'$.prNumber', COALESCE(json_extract(payload_json, '$.prNumber'), pr_number),
					'$.repoOwner', COALESCE(json_extract(payload_json, '$.repoOwner'), NULLIF(repo_owner, '')),
					'$.repoName', COALESCE(json_extract(payload_json, '$.repoName'), NULLIF(repo_name, '')),
					'$.branch', COALESCE(json_extract(payload_json, '$.branch'), NULLIF(branch, ''))
				)
				WHERE json_valid(payload_json) = 1
				  AND json_type(payload_json) = 'object'
				  AND (pr_number IS NOT NULL
				   OR NULLIF(repo_owner, '') IS NOT NULL
				   OR NULLIF(repo_name, '') IS NOT NULL
				   OR NULLIF(branch, '') IS NOT NULL)
			`);

			// 2. Preserve routed_task_id in payload for forensic/audit purposes.
			//    The event pipeline is task-agnostic, but retaining the value aids
			//    historical debugging and prevents data loss during upgrade.
			db.exec(`
				UPDATE space_external_events
				SET payload_json = json_set(
					payload_json,
					'$.routedTaskId', COALESCE(json_extract(payload_json, '$.routedTaskId'), routed_task_id)
				)
				WHERE json_valid(payload_json) = 1
				  AND json_type(payload_json) = 'object'
				  AND routed_task_id IS NOT NULL
			`);

			// 3. Migrate state values.
			db.exec(`
				UPDATE space_external_events
				SET state = CASE state
					WHEN 'routed' THEN 'published'
					WHEN 'delivery_failed' THEN 'published'
					WHEN 'ambiguous' THEN 'ignored'
					ELSE state
				END
				WHERE state IN ('routed', 'delivery_failed', 'ambiguous')
			`);

			// 3. Recreate table without task-specific columns.
			db.exec(`
				CREATE TABLE space_external_events_new (
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

			// 4. Copy data from old table to new table.
			db.exec(`
				INSERT INTO space_external_events_new (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					summary, external_url, payload_json,
					state, created_at, updated_at
				)
				SELECT
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					summary, external_url, payload_json,
					state, created_at, updated_at
				FROM space_external_events
			`);

			// 5. Drop old table and rename new one.
			db.exec(`DROP TABLE space_external_events`);
			db.exec(`ALTER TABLE space_external_events_new RENAME TO space_external_events`);

			// 6. Recreate indexes.
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_space_external_events_lookup
				ON space_external_events(space_id, source, dedupe_key)
			`);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_space_external_events_state
				ON space_external_events(state, updated_at)
			`);
		})();
	} finally {
		// Restore the original foreign_keys setting instead of unconditionally
		// enabling it, to avoid side effects on callers that managed FK state.
		db.exec(`PRAGMA foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
	}
}

/**
 * Migration 125: Add `task_schedules` table for recurring/one-shot scheduled tasks.
 *
 * task_schedules
 *   - Stores template fields (title, description, priority, etc.) + trigger config.
 *   - triggerType: 'cron' for recurring (cronExpression), 'at' for one-shot (runAt).
 *   - pendingJobId: O(1) lookup of the pending job in job_queue for cancel/pause.
 *   - Status machine: active → paused → active (or completed for one-shot).
 *
 * Also adds created_by_task_schedule_id column to space_tasks so spawned tasks
 * can be linked back to their schedule.
 */
export function runMigration125(db: BunDatabase): void {
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

	// Add created_by_task_schedule_id column to space_tasks (nullable, no FK).
	const columns = db.prepare(`PRAGMA table_info(space_tasks)`).all() as { name: string }[];
	if (columns.length > 0 && !columns.some((c) => c.name === 'created_by_task_schedule_id')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN created_by_task_schedule_id TEXT DEFAULT NULL`);
	}
}

/**
 * Migration 126: Drop the legacy `idx_sdk_messages_parent_tool` function index.
 *
 * That index — `(session_id, json_extract(sdk_message, '$.parent_tool_use_id'))` —
 * was created before `parent_tool_use_id` was materialised as a column. All
 * call sites now use the column directly and the planner picks
 * `idx_sdk_messages_parent_tool_use_id (session_id, parent_tool_use_id)`,
 * making the JSON-extract index dead weight on every INSERT/UPDATE.
 *
 * Idempotent via `DROP INDEX IF EXISTS` — databases that never created it
 * (older dev branches, fresh installs after this migration) are unaffected.
 */
export function runMigration126(db: BunDatabase): void {
	db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_parent_tool`);
}

/**
 * Migration 127: Add `handle` column to `space_workflows` for human-readable
 * workflow identifiers (alternative to UUID). Unique per space.
 *
 * The handle is auto-generated from the workflow name at creation time
 * (slugify: lowercase, hyphens, truncate). Collision handling appends
 * -2, -3, etc. for duplicate names in the same space.
 *
 * Backfills `handle` for any row that still has `handle = NULL` — including
 * rows that were missed by a mid-upgrade crash. The backfill is safe to run
 * repeatedly: rows with a non-null handle are untouched (the SELECT filters
 * them out), so existing handles are always preserved across restarts.
 */
export function runMigration127(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;

	const columns = tableColumnNames(db, 'space_workflows');
	const columnJustAdded = !columns.includes('handle');
	if (columnJustAdded) {
		db.exec(`ALTER TABLE space_workflows ADD COLUMN handle TEXT DEFAULT NULL`);
	}

	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_workflows_handle
		ON space_workflows(space_id, handle)
		WHERE handle IS NOT NULL
	`);

	// Always backfill any remaining NULL-handle rows. This makes the migration
	// resumable: if a previous boot crashed between the ALTER TABLE and the
	// backfill loop, subsequent boots pick up where it left off. A NULL handle
	// is treated as "not yet generated" rather than an explicit user choice.
	// Group by space_id so collision resolution is scoped per space.
	interface WorkflowRow {
		id: string;
		space_id: string;
		name: string;
	}
	const rows = db
		.prepare(`SELECT id, space_id, name FROM space_workflows WHERE handle IS NULL`)
		.all() as WorkflowRow[];
	if (rows.length === 0) return;

	// Seed the dedup set with every handle that is already non-NULL in the DB.
	// Without this, a partial-upgrade state where one row already has handle='foo'
	// would cause a collision when the backfill tries to assign the same slug to
	// another row, aborting via the unique-index constraint.
	interface ExistingHandleRow {
		space_id: string;
		handle: string;
	}
	const existingHandleRows = db
		.prepare(`SELECT space_id, handle FROM space_workflows WHERE handle IS NOT NULL`)
		.all() as ExistingHandleRow[];
	const spaceHandles = new Map<string, string[]>();
	for (const row of existingHandleRows) {
		const handles = spaceHandles.get(row.space_id) ?? [];
		handles.push(row.handle);
		spaceHandles.set(row.space_id, handles);
	}

	const updateStmt = db.prepare(`UPDATE space_workflows SET handle = ? WHERE id = ?`);
	for (const row of rows) {
		const handles = spaceHandles.get(row.space_id) ?? [];
		const handle = generateValidHandle(row.name, handles);
		updateStmt.run(handle, row.id);
		handles.push(handle);
		spaceHandles.set(row.space_id, handles);
	}
}

/**
 * Migration 128: Add external-event extension configuration tables.
 *
 * external_event_source_configs stores global source enablement, capabilities,
 * secrets references, and source-level settings.
 *
 * space_external_event_source_configs stores per-space source enablement and
 * settings, with a cascading FK to spaces so deleting a space removes its
 * extension configuration.
 */
export function runMigration128(db: BunDatabase): void {
	const hadLegacyGlobalConfigTable = tableExists(db, 'external_event_source_configs');

	db.exec(`
		CREATE TABLE IF NOT EXISTS external_event_extension_configs (
			source TEXT PRIMARY KEY,
			globally_enabled INTEGER NOT NULL DEFAULT 0 CHECK(globally_enabled IN (0, 1)),
			capabilities_json TEXT NOT NULL DEFAULT '{}',
			secrets_ref TEXT DEFAULT NULL,
			settings_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	if (hadLegacyGlobalConfigTable) {
		db.exec(`
			INSERT OR IGNORE INTO external_event_extension_configs (
				source, globally_enabled, capabilities_json, secrets_ref,
				settings_json, created_at, updated_at
			)
			SELECT
				source,
				globally_enabled,
				json_set(
						CASE
							WHEN json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'
								THEN capabilities_json
							ELSE '{}'
						END,
						'$.rpcConfig',
						json('true')
					),
				secrets_ref,
				COALESCE(settings_json, '{}'),
				created_at,
				updated_at
			FROM external_event_source_configs
		`);
	}

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

	const now = Date.now();
	db.prepare(
		`INSERT OR IGNORE INTO external_event_extension_configs
		 (source, globally_enabled, capabilities_json, secrets_ref, settings_json, created_at, updated_at)
		 VALUES ('github', 1, ?, NULL, '{}', ?, ?)`
	).run(JSON.stringify({ webhooks: true, polling: false, rpcConfig: true }), now, now);
}

/**
 * Migration 129: Add per-space concurrent task execution limit.
 *
 * Backfills from legacy config.maxConcurrentTasks when present and valid, otherwise
 * defaults to 1. This preserves legacy SpaceConfig-based limits during upgrade.
 */
export function runMigration129(db: BunDatabase): void {
	if (!tableExists(db, 'spaces')) return;
	if (tableHasColumn(db, 'spaces', 'max_concurrent_tasks')) return;

	db.exec(`ALTER TABLE spaces ADD COLUMN max_concurrent_tasks INTEGER NOT NULL DEFAULT 1`);
	db.exec(`
		UPDATE spaces
		SET max_concurrent_tasks = CAST(json_extract(config, '$.maxConcurrentTasks') AS INTEGER)
		WHERE config IS NOT NULL
		  AND json_valid(config)
		  AND json_type(config, '$.maxConcurrentTasks') = 'integer'
		  AND CAST(json_extract(config, '$.maxConcurrentTasks') AS INTEGER) BETWEEN 1 AND 10
	`);
}

/**
 * Migration 130: Add `gate_open_state` table.
 *
 * Persists the gate-open cache so that already-opened gates skip re-evaluation
 * even after a daemon restart. Each row records the `workflow.updatedAt` timestamp
 * at the time the gate was cached open — if the workflow definition changes
 * (different `updatedAt`), the cache entry is stale and the gate is re-evaluated.
 *
 * Foreign key to `space_workflow_runs(id)` with `ON DELETE CASCADE` ensures rows
 * are cleaned up when the run itself is deleted.
 */
export function runMigration130(db: BunDatabase): void {
	if (tableExists(db, 'gate_open_state')) return;

	db.exec(`
		CREATE TABLE gate_open_state (
			run_id TEXT NOT NULL,
			gate_id TEXT NOT NULL,
			opened_workflow_updated_at INTEGER NOT NULL,
			opened_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, gate_id),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX idx_gate_open_state_run ON gate_open_state(run_id)`);
}

export function runMigration131(db: BunDatabase): void {
	if (tableExists(db, 'neo_activity_log')) {
		db.exec(`DROP TABLE neo_activity_log`);
	}

	migrateNeoSessions(db);
	migrateNeoMessageOrigins(db);

	// ── Space-native goals ───────────────────────────────────────────────────
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

	if (tableExists(db, 'space_tasks') && !tableHasColumn(db, 'space_tasks', 'goal_id')) {
		db.exec(`ALTER TABLE space_tasks ADD COLUMN goal_id TEXT DEFAULT NULL`);
	}
	if (tableExists(db, 'space_tasks')) {
		db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
	}

	if (tableExists(db, 'task_schedules') && !tableHasColumn(db, 'task_schedules', 'goal_id')) {
		db.exec(`ALTER TABLE task_schedules ADD COLUMN goal_id TEXT DEFAULT NULL`);
	}
	if (tableExists(db, 'task_schedules')) {
		db.exec(`CREATE INDEX IF NOT EXISTS idx_task_schedules_goal ON task_schedules(goal_id)`);
	}
}

/**
 * Migration 134: Add FTS5-backed message and Space task search.
 *
 * `message_search_fts` is a denormalized projection rather than an external-content table because
 * searched text is derived from SDK JSON. Repository writes maintain rows for new messages; this
 * migration backfills existing messages and task titles/descriptions.
 */
export function runMigration136(db: BunDatabase): void {
	if (!tableExists(db, 'space_agent_memory')) return;
	ensureAgentMemoryNamedPrimaryKey(db);

	if (!tableHasColumn(db, 'space_agent_memory', 'embedding_status')) {
		db.exec(
			`ALTER TABLE space_agent_memory ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'ready', 'failed'))`
		);
	}
	if (!tableHasColumn(db, 'space_agent_memory', 'embedding_model')) {
		db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_model TEXT`);
	}
	if (!tableHasColumn(db, 'space_agent_memory', 'embedding_updated_at')) {
		db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_updated_at INTEGER`);
	}
	if (!tableHasColumn(db, 'space_agent_memory', 'embedding_error')) {
		db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_error TEXT`);
	}
	if (!tableHasColumn(db, 'space_agent_memory', 'embedding_revision')) {
		db.exec(
			`ALTER TABLE space_agent_memory ADD COLUMN embedding_revision INTEGER NOT NULL DEFAULT 0`
		);
	}
	if (!tableHasColumn(db, 'space_agent_memory', 'embedding_token')) {
		db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_token TEXT NOT NULL DEFAULT ''`);
	}

	recreateMemoryVectorsWithNamedParentKey(db);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_space_agent_memory_embedding_status ON space_agent_memory(space_id, embedding_status)`
	);
}

function ensureAgentMemoryNamedPrimaryKey(db: BunDatabase): void {
	if (tableHasColumn(db, 'space_agent_memory', 'id')) return;

	db.exec(`DROP TRIGGER IF EXISTS space_agent_memory_ai`);
	db.exec(`DROP TRIGGER IF EXISTS space_agent_memory_ad`);
	db.exec(`DROP TRIGGER IF EXISTS space_agent_memory_au`);
	db.exec(`DROP TABLE IF EXISTS space_agent_memory_fts`);

	db.exec(`ALTER TABLE space_agent_memory RENAME TO space_agent_memory_old`);
	db.exec(`
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
			last_accessed_at INTEGER,
			UNIQUE(space_id, key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`
		INSERT INTO space_agent_memory (
			id, key, space_id, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at
		)
		SELECT rowid, key, space_id, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at
		FROM space_agent_memory_old
	`);
	db.exec(`DROP TABLE space_agent_memory_old`);
	createAgentMemoryTables(db);
}

function recreateMemoryVectorsWithNamedParentKey(db: BunDatabase): void {
	if (tableExists(db, 'memory_vectors') && tableHasColumn(db, 'memory_vectors', 'memory_id')) {
		return;
	}

	db.exec(`DROP TABLE IF EXISTS memory_vectors`);
	db.exec(`
		CREATE TABLE memory_vectors (
			memory_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			model TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		)
	`);
}

export function runMigration134(db: BunDatabase): void {
	const existed = tableExists(db, 'message_search_fts');
	createMessageSearchFtsTable(db);
	if (!existed || isMessageSearchFtsEmpty(db)) {
		backfillMessageSearchFts(db);
	}
}

export function runMigration137(db: BunDatabase): void {
	if (!tableExists(db, 'message_search_fts')) return;

	let prunedRows = 0;
	const recordPrune = (result: { changes?: number }): void => {
		prunedRows += result.changes ?? 0;
	};
	const terminalCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
	const terminalCutoffIso = new Date(terminalCutoffMs).toISOString();

	recordPrune(
		db
			.prepare(
				`DELETE FROM message_search_fts
				 WHERE kind = 'message'
				   AND COALESCE(message_type, '') NOT IN ('system', 'user', 'assistant')`
			)
			.run()
	);

	const deleteRoomNamespacedRows = db.prepare(`
		DELETE FROM message_search_fts
		WHERE kind = 'message'
		  AND (
			session_id LIKE 'room:chat:%'
			OR session_id LIKE 'planner:%'
			OR session_id LIKE 'coder:%'
			OR session_id LIKE 'leader:%'
			OR session_id LIKE 'general:%'
			OR (instr(session_id, ':') > 0 AND session_id NOT LIKE 'space:%')
		  )
	`);
	recordPrune(deleteRoomNamespacedRows.run());

	if (
		tableExists(db, 'sessions') &&
		tableHasColumn(db, 'sessions', 'status') &&
		tableHasColumn(db, 'sessions', 'type') &&
		tableHasColumn(db, 'sessions', 'last_active_at') &&
		tableHasColumn(db, 'sessions', 'session_context')
	) {
		recordPrune(
			db
				.prepare(
					`
					DELETE FROM message_search_fts
					WHERE kind = 'message'
					  AND session_id IN (
						SELECT id
						FROM sessions
						WHERE status = 'archived'
						   OR (status = 'ended' AND last_active_at < ?)
						   OR type IN ('room_chat', 'planner', 'coder', 'leader', 'general')
						   OR (json_valid(session_context) AND json_extract(session_context, '$.roomId') IS NOT NULL)
						   OR (id NOT LIKE 'space:%' AND instr(id, ':') > 0)
						   OR (id NOT LIKE 'space:%' AND type NOT IN ('worker', 'space_chat', 'space_task_agent'))
					  )
				`
				)
				.run(terminalCutoffIso)
		);
	}

	if (
		tableExists(db, 'space_tasks') &&
		tableHasColumn(db, 'space_tasks', 'status') &&
		tableHasColumn(db, 'space_tasks', 'completed_at') &&
		tableHasColumn(db, 'space_tasks', 'updated_at')
	) {
		recordPrune(
			db
				.prepare(
					`
					DELETE FROM message_search_fts
					WHERE kind = 'message'
					  AND task_id IN (
						SELECT id
						FROM space_tasks
						WHERE status = 'archived'
						   OR (status IN ('done', 'cancelled', 'completed')
						       AND COALESCE(completed_at, updated_at, 0) < ?)
					  )
				`
				)
				.run(terminalCutoffMs)
		);
	}

	if (prunedRows > 0) {
		db.exec(`INSERT INTO message_search_fts(message_search_fts) VALUES('optimize')`);
	}
}

function isMessageSearchFtsEmpty(db: BunDatabase): boolean {
	const row = db.prepare(`SELECT 1 AS present FROM message_search_fts LIMIT 1`).get() as
		| { present: number }
		| undefined;
	return !row;
}

function createMessageSearchFtsTable(db: BunDatabase): void {
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS message_search_fts USING fts5(
			kind UNINDEXED,
			source_id UNINDEXED,
			message_id UNINDEXED,
			session_id UNINDEXED,
			task_id UNINDEXED,
			space_id UNINDEXED,
			task_number UNINDEXED,
			message_type UNINDEXED,
			title,
			body,
			timestamp UNINDEXED,
			tokenize = 'unicode61'
		)
	`);
}

function backfillMessageSearchFts(db: BunDatabase): void {
	db.exec(`DELETE FROM message_search_fts`);

	if (tableExists(db, 'sdk_messages')) {
		const sessionTitleSelect = tableExists(db, 'sessions')
			? 'COALESCE(s.title, sm.session_id)'
			: 'sm.session_id';
		const sessionJoin = tableExists(db, 'sessions')
			? 'LEFT JOIN sessions s ON s.id = sm.session_id'
			: '';
		const taskSelect = tableExists(db, 'space_tasks')
			? 'st.space_id, st.task_number'
			: 'NULL, NULL';
		const taskJoin = tableExists(db, 'space_tasks')
			? 'LEFT JOIN space_tasks st ON st.id = sm.task_id'
			: '';
		db.exec(`
			INSERT INTO message_search_fts (
				kind, source_id, message_id, session_id, task_id, space_id, task_number,
				message_type, title, body, timestamp
			)
			SELECT
				'message',
				sm.id,
				json_extract(sm.sdk_message, '$.uuid'),
				sm.session_id,
				sm.task_id,
				${taskSelect},
				sm.message_type,
				${sessionTitleSelect},
				TRIM(COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND json_type(sm.sdk_message, '$.message.content') = 'text'
						THEN json_extract(sm.sdk_message, '$.message.content')
					END,
					''
				) || ' ' || COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND json_type(sm.sdk_message, '$.message.content') = 'array'
						THEN (
							SELECT group_concat(
								CASE
									WHEN json_extract(je.value, '$.type') = 'text'
									THEN json_extract(je.value, '$.text')
									WHEN json_extract(je.value, '$.type') = 'thinking'
									THEN json_extract(je.value, '$.thinking')
								END,
								' '
							)
							FROM json_each(json_extract(sm.sdk_message, '$.message.content')) je
							WHERE json_extract(je.value, '$.type') IN ('text', 'thinking')
						)
					END,
					''
				) || ' ' || COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND sm.message_type = 'result'
						THEN json_extract(sm.sdk_message, '$.result')
					END,
					''
				) || ' ' || COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND sm.message_type = 'neokai_action'
						THEN TRIM(COALESCE(json_extract(sm.sdk_message, '$.title'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.message'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.question'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.prompt'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.action'), ''))
					END,
					''
				)),
				CAST(strftime('%s', sm.timestamp) AS INTEGER) * 1000
						+ CAST(substr(strftime('%f', sm.timestamp), 4, 3) AS INTEGER)
			FROM sdk_messages sm
			${sessionJoin}
			${taskJoin}
			WHERE json_valid(sm.sdk_message)
			  AND sm.message_type IN ('system', 'user', 'assistant')
			  AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
		`);
	}

	if (tableExists(db, 'space_tasks')) {
		db.exec(`
			INSERT INTO message_search_fts (
				kind, source_id, task_id, space_id, task_number, title, body, timestamp
			)
			SELECT
				'task',
				id,
				id,
				space_id,
				task_number,
				title,
				TRIM(COALESCE(title, '') || ' ' || COALESCE(description, '')),
				updated_at
			FROM space_tasks
			WHERE TRIM(COALESCE(title, '') || ' ' || COALESCE(description, '')) != ''
		`);
	}
}

function migrateNeoSessions(db: BunDatabase): void {
	if (!tableExists(db, 'sessions')) return;

	const createSql = tableCreateSql(db, 'sessions');
	if (createSql && !createSql.includes("'neo'")) return;

	db.exec('PRAGMA foreign_keys = OFF');
	db.exec('BEGIN');
	try {
		db.exec(`
			CREATE TABLE sessions_m131_new (
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
		db.exec(`
			INSERT INTO sessions_m131_new (
				id, title, workspace_path, created_at, last_active_at, status, config, metadata,
				is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
				sdk_session_id, sdk_origin_path, available_commands, processing_state,
				archived_at, parent_id, type, session_context
			)
			SELECT
				id, title, workspace_path, created_at, last_active_at,
				CASE WHEN type = 'neo' THEN 'archived' ELSE status END,
				config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch,
				git_branch, sdk_session_id, sdk_origin_path, available_commands, processing_state,
				CASE WHEN type = 'neo' AND archived_at IS NULL THEN datetime('now') ELSE archived_at END,
				parent_id,
				CASE WHEN type = 'neo' THEN 'worker' ELSE type END,
				session_context
			FROM sessions
		`);
		db.exec(`DROP TABLE sessions`);
		db.exec(`ALTER TABLE sessions_m131_new RENAME TO sessions`);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Migration 133: Add append-only Space goal event history.
 *
 * Stores lifecycle and state-change events for Space goals so agents and
 * humans can inspect why the current rolling goal state changed.
 */
export function runMigration133(db: BunDatabase): void {
	if (!tableExists(db, 'space_goals')) return;

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

export function runMigration132(db: BunDatabase): void {
	createAgentMemoryTables(db);
}

function createAgentMemoryTables(db: BunDatabase): void {
	const shouldRebuildFts = !tableExists(db, 'space_agent_memory_fts');

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
	if (shouldRebuildFts) {
		db.exec(`INSERT INTO space_agent_memory_fts(space_agent_memory_fts) VALUES ('rebuild')`);
	}
}

/**
 * Migration 135: Add space-scoped pending message lookup index for actor registry.
 */
export function runMigration135(db: BunDatabase): void {
	if (!tableExists(db, 'pending_agent_messages')) return;

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_space_status ` +
			`ON pending_agent_messages(space_id, status, created_at)`
	);
}

function migrateNeoMessageOrigins(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) return;

	const createSql = tableCreateSql(db, 'sdk_messages');
	if (createSql && !createSql.includes("'neo'")) return;

	const columns = tableColumnNames(db, 'sdk_messages');
	const optionalColumns = ['is_renderable', 'is_terminal', 'parent_tool_use_id', 'task_id'].filter(
		(column) => columns.includes(column)
	);
	const insertColumns = [
		'id',
		'session_id',
		'message_type',
		'message_subtype',
		'sdk_message',
		'timestamp',
		'send_status',
		'origin',
		...optionalColumns,
	];

	db.exec('PRAGMA foreign_keys = OFF');
	db.exec('BEGIN');
	try {
		db.exec(`
			CREATE TABLE sdk_messages_m131_new (
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
		db.exec(`
			INSERT INTO sdk_messages_m131_new (${insertColumns.join(', ')})
			SELECT ${insertColumns
				.map((column) =>
					column === 'origin' ? "CASE WHEN origin = 'neo' THEN NULL ELSE origin END" : column
				)
				.join(', ')}
			FROM sdk_messages
		`);
		db.exec(`DROP TABLE sdk_messages`);
		db.exec(`ALTER TABLE sdk_messages_m131_new RENAME TO sdk_messages`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session ON sdk_messages(session_id, timestamp)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id ON sdk_messages(session_id, timestamp DESC, id DESC)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id ON sdk_messages(session_id, parent_tool_use_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_renderable_terminal ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_uuid_status ON sdk_messages(session_id, send_status, json_extract(sdk_message, '$.uuid'))`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_type ON sdk_messages(message_type, message_subtype)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id, timestamp)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session ON sdk_messages(task_id, session_id)`
		);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/**
 * Generate a handle that is guaranteed to pass validateSlug.
 * Progressively shortens the base on each iteration so collision
 * suffixes never push the result over the max length.
 */
function generateValidHandle(name: string, existingHandles: string[]): string {
	const maxLen = 60;
	let base = slugify(name, existingHandles);
	// If the initial slugify result is already valid, we're done.
	if (validateSlug(base) === null) return base;

	// Collision suffixing pushed the handle over the max length.
	// Progressively shorten the base and re-run collision resolution
	// until a valid handle is produced.
	for (let len = maxLen; len > 0; len--) {
		const truncated = base.slice(0, len);
		const cleaned = truncated.replace(/-+$/, '');
		const fallback = cleaned || 'workflow';
		const candidate = slugify(fallback, existingHandles);
		if (validateSlug(candidate) === null) {
			return candidate;
		}
	}
	// Absolute fallback — should never reach here in practice
	return 'workflow';
}
