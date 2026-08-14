/**
 * Space System Types
 *
 * Types for the Space multi-agent workflow system.
 * Spaces are distinct from Rooms — they are workspace-first, workflow-centric
 * contexts for orchestrating worker agents and automated pipelines.
 */

import type { ThinkingLevel } from '../types';
import type { TaskRestriction } from './neo';
import type { McpServerConfig } from './sdk-config';
import type { SettingSource } from './settings';

// ============================================================================
// Space Types
// ============================================================================

/**
 * Space status
 */
export type SpaceStatus = 'active' | 'archived';

/**
 * Space autonomy level — a numeric risk-tolerance threshold (1–5).
 *
 * Every checkpoint (gate or completion action) declares a `requiredLevel`.
 * The space's autonomy level is compared: `space.autonomyLevel >= checkpoint.requiredLevel`
 * means auto-approved; otherwise, execution pauses for human sign-off.
 *
 * Levels have no prescribed names — workflow authors assign meaning per their domain.
 */
export type SpaceAutonomyLevel = 1 | 2 | 3 | 4 | 5;
export type SpaceAgentAutonomyLevel = SpaceAutonomyLevel;

export type SpaceLongHorizonAgentStatus = 'active' | 'paused' | 'disabled' | 'archived';
export type SpaceLongHorizonAgentRelationship = 'owner' | 'manager' | 'watcher';
export type SpaceLongHorizonAgentReminderStatus = 'active' | 'paused' | 'fired' | 'cancelled';
export type SpaceLongHorizonAgentReminderTriggerType = 'at' | 'cron';
export type SpaceLongHorizonAgentEventSubscriptionStatus = 'active' | 'paused' | 'disabled';

export interface SpaceLongHorizonAgentTemplateReminderDefault {
  title: string;
  body: string;
  triggerType: SpaceLongHorizonAgentReminderTriggerType;
  cronExpression: string | null;
  timezone: string;
}

export interface SpaceLongHorizonAgentTemplateEventSubscription {
  source: string;
  topic: string;
  filter: Record<string, unknown>;
}

export interface SpaceLongHorizonAgentTemplateOwnershipPattern {
  target: 'goal' | 'forge_scope';
  relationship: SpaceLongHorizonAgentRelationship;
  description: string;
}

export interface SpaceLongHorizonAgentTemplate {
  key: string;
  handle: string;
  displayName: string;
  description: string;
  instructions: string;
  suggestedAutonomyLevel: SpaceAgentAutonomyLevel;
  suggestedEventSubscriptions: SpaceLongHorizonAgentTemplateEventSubscription[];
  reminderDefaults: SpaceLongHorizonAgentTemplateReminderDefault[];
  ownershipPatterns: SpaceLongHorizonAgentTemplateOwnershipPattern[];
  toolPermissions: Record<string, unknown>;
}

export interface SpaceLongHorizonAgent {
  id: string;
  spaceId: string;
  handle: string;
  displayName: string;
  templateKey: string | null;
  status: SpaceLongHorizonAgentStatus;
  sessionId: string | null;
  instructions: string;
  autonomyLevel: SpaceAgentAutonomyLevel | null;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  provider: string | null;
  settingSources: SettingSource[] | null;
  toolPermissions: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSpaceLongHorizonAgentParams {
  id?: string;
  spaceId: string;
  handle: string;
  displayName?: string;
  templateKey?: string | null;
  status?: SpaceLongHorizonAgentStatus;
  sessionId?: string | null;
  instructions?: string;
  autonomyLevel?: SpaceAgentAutonomyLevel | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  provider?: string | null;
  settingSources?: SettingSource[] | null;
  toolPermissions?: Record<string, unknown>;
}

export interface UpdateSpaceLongHorizonAgentParams {
  handle?: string;
  displayName?: string;
  templateKey?: string | null;
  status?: SpaceLongHorizonAgentStatus;
  sessionId?: string | null;
  instructions?: string;
  autonomyLevel?: SpaceAgentAutonomyLevel | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  provider?: string | null;
  settingSources?: SettingSource[] | null;
  toolPermissions?: Record<string, unknown> | null;
}

export interface SpaceLongHorizonAgentGoal {
  agentId: string;
  goalId: string;
  relationship: SpaceLongHorizonAgentRelationship;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceLongHorizonAgentForgeScope {
  agentId: string;
  scopeId: string;
  relationship: SpaceLongHorizonAgentRelationship;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceLongHorizonAgentReminder {
  id: string;
  spaceId: string;
  agentId: string;
  title: string;
  body: string;
  status: SpaceLongHorizonAgentReminderStatus;
  triggerType: SpaceLongHorizonAgentReminderTriggerType;
  runAt: number | null;
  cronExpression: string | null;
  timezone: string;
  nextRunAt: number | null;
  lastFiredAt: number | null;
  createdBySession: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSpaceLongHorizonAgentReminderParams {
  spaceId: string;
  agentId: string;
  title: string;
  body?: string;
  status?: SpaceLongHorizonAgentReminderStatus;
  triggerType: SpaceLongHorizonAgentReminderTriggerType;
  runAt?: number | null;
  cronExpression?: string | null;
  timezone?: string;
  nextRunAt?: number | null;
  lastFiredAt?: number | null;
  createdBySession?: string | null;
}

export interface SpaceLongHorizonAgentEventSubscription {
  id: string;
  spaceId: string;
  agentId: string;
  source: string;
  topic: string;
  filter: Record<string, unknown>;
  status: SpaceLongHorizonAgentEventSubscriptionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSpaceLongHorizonAgentSubscriptionParams {
  spaceId: string;
  agentId: string;
  source: string;
  topic: string;
  filter?: Record<string, unknown>;
  status?: SpaceLongHorizonAgentEventSubscriptionStatus;
}

export interface UpdateSpaceLongHorizonAgentSubscriptionParams {
  source?: string;
  topic?: string;
  filter?: Record<string, unknown>;
  status?: SpaceLongHorizonAgentEventSubscriptionStatus;
}

export const MIN_SPACE_CONCURRENT_TASKS = 1;
export const MAX_SPACE_CONCURRENT_TASKS = 10;

/**
 * Who approved a task or gate — used for audit trail tracking.
 *
 * - `human`       — User approved via UI / RPC
 * - `auto_policy` — Runtime auto-approved because space autonomy level >= required level
 * - `agent`       — An agent approved via tool call (specific agent identity tracked in session metadata)
 */
export type SpaceApprovalSource = 'human' | 'auto_policy' | 'agent';

/**
 * Typed runtime configuration for a Space.
 */
export interface SpaceConfig {
  /**
   * @deprecated Use Space.maxConcurrentTasks instead. Retained for backward-compatible
   * imports of older Space configuration payloads.
   */
  maxConcurrentTasks?: number;
  /** Timeout for a single task in milliseconds */
  taskTimeoutMs?: number;
}

/**
 * Per-space overrides for the built-in Task Agent.
 *
 * The Task Agent is not a seeded SpaceWorkerAgent — it has no row in the `space_agents`
 * table. Its prompt is generated in code at `task-agent.ts`. This config allows
 * per-space customization of model and prompt additions without mutating code.
 */
export interface TaskAgentConfig {
  /** Model override for the Task Agent. Falls back to `space.defaultModel` then `DEFAULT_TASK_AGENT_MODEL`. */
  model?: string;
  /** Thinking-level override for the Task Agent. Falls back to the app default when unset. */
  thinkingLevel?: ThinkingLevel;
  /** Custom prompt additions appended after the contract sections (similar to SpaceWorkerAgent.customPrompt). */
  customPrompt?: string;
  /**
   * Setting sources to load for the Task Agent.
   * Falls back to the global default (['user', 'project', 'local']) when unset.
   */
  settingSources?: SettingSource[];
}

/**
 * A Space — a workspace-first context for multi-agent workflows.
 * Unlike Rooms, a Space has a single required workspace path and is
 * designed around workflow execution with customizable agents.
 */
export interface Space {
  /** Unique identifier */
  id: string;
  /** URL-safe, human-readable identifier (unique, auto-generated from name) */
  slug: string;
  /** Absolute path to the workspace this Space operates on (required, unique) */
  workspacePath: string;
  /** Human-readable name */
  name: string;
  /** Short description of this Space's purpose */
  description: string;
  /** Background context — describes project, codebase, conventions, constraints */
  backgroundContext: string;
  /** Custom instructions for how Space agents should behave */
  instructions: string;
  /** Default model for sessions and agents in this Space */
  defaultModel?: string;
  /** Allowed models for this Space (empty/undefined = all models allowed) */
  allowedModels?: string[];
  /** IDs of sessions associated with this Space */
  sessionIds: string[];
  /** Current status of the Space */
  status: SpaceStatus;
  /** Whether the space runtime is paused (no new tasks scheduled; running work continues) */
  paused: boolean;
  /**
   * Whether the space runtime is stopped (all active work killed; no auto-start on daemon restart).
   * A stopped space must be explicitly started again to resume. Takes precedence over `paused`.
   */
  stopped: boolean;
  /** Autonomy level — controls how much the Space Agent can act without human approval */
  autonomyLevel?: SpaceAutonomyLevel;
  /** Maximum number of Space tasks that may run concurrently */
  maxConcurrentTasks: number;
  /** Runtime configuration (taskTimeoutMs, legacy maxConcurrentTasks, etc.) */
  config?: SpaceConfig;
  /** Per-space overrides for the built-in Task Agent (model and custom prompt). */
  taskAgentConfig?: TaskAgentConfig;
  /**
   * Default setting sources for all agents in this Space.
   * Used as fallback when an agent (task or custom) does not define its own.
   */
  settingSources?: SettingSource[];
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Result of `space.create` RPC.
 *
 * Extends `Space` with an optional `seedWarnings` array that is present when
 * preset agents or built-in workflows failed to seed (partial or total).
 * The space is still usable — warnings are informational only.
 *
 * TODO: The frontend should display these warnings (e.g. toast notification
 * after space creation) so the user knows if seeding was incomplete.
 */
export interface SpaceCreateResult extends Space {
  seedWarnings?: string[];
}

/**
 * Parameters for creating a new Space
 */
export interface CreateSpaceParams {
  /** Absolute path to the workspace (required, must exist) */
  workspacePath: string;
  /** Human-readable name */
  name: string;
  /** Short description of this Space's purpose */
  description?: string;
  /** Background context for agents */
  backgroundContext?: string;
  /** Custom instructions for agents */
  instructions?: string;
  /** Default model for new sessions and agents */
  defaultModel?: string;
  /** Allowed models for this Space */
  allowedModels?: string[];
  /** Autonomy level for the Space Agent */
  autonomyLevel?: SpaceAutonomyLevel;
  /** Maximum number of Space tasks that may run concurrently (1–10, default 1) */
  maxConcurrentTasks?: number;
  /** Runtime configuration */
  config?: SpaceConfig;
  /** Per-space overrides for the built-in Task Agent */
  taskAgentConfig?: TaskAgentConfig;
  /**
   * Default setting sources for all agents in this Space.
   * Pass `null` to explicitly clear (revert to global default).
   */
  settingSources?: SettingSource[] | null;
}

/**
 * Parameters for updating a Space
 */
export interface UpdateSpaceParams {
  name?: string;
  description?: string;
  backgroundContext?: string;
  instructions?: string;
  defaultModel?: string | null;
  allowedModels?: string[];
  autonomyLevel?: SpaceAutonomyLevel;
  /** Maximum number of Space tasks that may run concurrently (1–10) */
  maxConcurrentTasks?: number;
  config?: SpaceConfig;
  /** Per-space overrides for the built-in Task Agent. Pass null to clear. */
  taskAgentConfig?: TaskAgentConfig | null;
  /**
   * Default setting sources for all agents in this Space.
   * Pass null to clear (revert to global default).
   */
  settingSources?: SettingSource[] | null;
}

// ============================================================================
// Space Task Types
// ============================================================================

/**
 * Space task status
 *
 * - `draft`       — task is a draft; never picked up by the orchestrator regardless of
 *                   workflow or priority. Only explicit user/API action (`publish`) can
 *                   promote it to `open`. No automated transition out of `draft` exists.
 * - `open`        — task is queued and waiting to be picked up
 * - `in_progress` — a Task Agent session is actively working on this task
 * - `review`      — workflow agents completed; awaiting human review/approval (supervised mode)
 * - `approved`    — work has been approved (human or auto_policy); a post-approval
 *                   executor (e.g. Task Agent running a `postApproval` route such
 *                   as a PR merge) may still be executing before the task reaches
 *                   its terminal `done` state. No runtime consumer exists yet —
 *                   PR 2 of the task-agent-as-post-approval-executor refactor
 *                   wires this status in. See
 *                   `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`.
 * - `done`        — task completed successfully
 * - `blocked`     — task requires human attention or intervention
 * - `cancelled`   — task was cancelled and will not be completed
 * - `archived`    — task is archived (soft-delete, `archivedAt` is stamped)
 * - `rate_limited`  — task paused because of a transient HTTP 429 rate limit; the
 *                     owning session is in a cooldown and auto-resumes (`restrictions.resetAt`)
 * - `usage_limited` — task paused because of a daily/weekly usage cap with no
 *                     fallback left; auto-resumes when the cap resets (`restrictions.resetAt`)
 */
export type SpaceTaskStatus =
  | 'draft'
  | 'open'
  | 'in_progress'
  | 'review'
  | 'approved'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'archived'
  | 'rate_limited'
  | 'usage_limited';

/**
 * Outcome an end-node agent reports via `task.reportedStatus`.
 *
 * This is the agent's claimed terminal state for the workflow — distinct from
 * `SpaceTask.status`, which is the runtime's final decision after the report
 * passes through completion-actions review (in supervised autonomy modes).
 */
export type SpaceReportedStatus = 'done' | 'blocked' | 'cancelled';

/**
 * Why a task is blocked — set when status transitions to `blocked`,
 * cleared when the task leaves `blocked`.
 */
export type SpaceBlockReason =
  | 'agent_crashed'
  | 'workflow_invalid'
  | 'execution_failed'
  | 'human_input_requested'
  | 'dependency_failed'
  | 'dependency_added';

/**
 * Space task priority
 *
 * Numeric priority values P0–P3 where lower number = higher priority.
 */
export type SpaceTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

// ============================================================================
// SpaceGoal Types
// ============================================================================

export type SpaceGoalStatus = 'active' | 'paused' | 'completed' | 'archived';
export type SpaceGoalType = 'one_shot' | 'measurable' | 'recurring';

export type SpaceGoalMetrics = Record<string, string | number | boolean | null>;

export type SpaceGoalEventType =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'task_triggered'
  | 'task_queued'
  | 'task_terminal'
  | 'schedule_updated';

export type SpaceGoalEventSource =
  | 'rpc'
  | 'space_agent_tool'
  | 'workflow_node_agent'
  | 'scheduler'
  | 'system';

export type SpaceGoalEventSnapshot = Partial<{
  title: string;
  description: string;
  status: SpaceGoalStatus;
  type: SpaceGoalType;
  priority: SpaceTaskPriority;
  labels: string[];
  metrics: SpaceGoalMetrics;
  summary: string;
  progress: number | null;
  nextSteps: string[];
  preferredWorkflowId: string | null;
  taskScheduleId: string | null;
  autoTriggerNext: boolean;
  pendingNextRun: boolean;
  activeTaskId: string | null;
  lastTaskId: string | null;
  lastCheckInAt: number | null;
  nextCheckInAt: number | null;
  completedAt: number | null;
  /**
   * Linked check-in schedule cadence, denormalized into the snapshot from the
   * linked TaskSchedule. Cadence edits mutate the schedule (not the goal row),
   * and for a paused goal `nextCheckInAt` is null before and after — so without
   * these fields a cadence change would record an audit event with an empty diff.
   */
  checkInCronExpression?: string | null;
  checkInTimezone?: string | null;
}>;

export type SpaceGoalEventDiff = Record<
  string,
  {
    previous: unknown;
    current: unknown;
  }
>;

export interface SpaceGoalEvent {
  id: string;
  spaceId: string;
  goalId: string;
  eventType: SpaceGoalEventType;
  source: SpaceGoalEventSource;
  sourceTaskId: string | null;
  sourceSessionId: string | null;
  previousState: SpaceGoalEventSnapshot | null;
  newState: SpaceGoalEventSnapshot | null;
  diff: SpaceGoalEventDiff | null;
  note: string | null;
  createdAt: number;
}

export interface CreateSpaceGoalEventParams {
  spaceId: string;
  goalId: string;
  eventType: SpaceGoalEventType;
  source: SpaceGoalEventSource;
  sourceTaskId?: string | null;
  sourceSessionId?: string | null;
  previousState?: SpaceGoalEventSnapshot | null;
  newState?: SpaceGoalEventSnapshot | null;
  diff?: SpaceGoalEventDiff | null;
  note?: string | null;
  createdAt?: number;
}

export interface SpaceGoalEventListParams {
  limit?: number;
  before?: number;
  beforeId?: string;
}

export interface SpaceGoal {
  id: string;
  spaceId: string;
  title: string;
  description: string;
  status: SpaceGoalStatus;
  type: SpaceGoalType;
  priority: SpaceTaskPriority;
  labels: string[];
  metrics: SpaceGoalMetrics;
  summary: string;
  progress: number;
  nextSteps: string[];
  preferredWorkflowId: string | null;
  taskScheduleId: string | null;
  autoTriggerNext: boolean;
  pendingNextRun: boolean;
  activeTaskId: string | null;
  lastTaskId: string | null;
  lastCheckInAt: number | null;
  nextCheckInAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface CreateSpaceGoalParams {
  spaceId: string;
  title: string;
  description?: string;
  type?: SpaceGoalType;
  priority?: SpaceTaskPriority;
  labels?: string[];
  metrics?: SpaceGoalMetrics;
  summary?: string;
  progress?: number;
  nextSteps?: string[];
  preferredWorkflowId?: string | null;
  autoTriggerNext?: boolean;
  checkInCronExpression?: string | null;
  checkInTimezone?: string;
  triggerImmediately?: boolean;
}

export interface UpdateSpaceGoalParams {
  title?: string;
  description?: string;
  status?: SpaceGoalStatus;
  type?: SpaceGoalType;
  priority?: SpaceTaskPriority;
  labels?: string[];
  metrics?: SpaceGoalMetrics;
  summary?: string;
  progress?: number;
  nextSteps?: string[];
  preferredWorkflowId?: string | null;
  autoTriggerNext?: boolean;
  /**
   * Edit the recurring check-in schedule in place (identity-preserving).
   * Omit to leave the schedule untouched. A non-empty value sets/updates the
   * linked schedule's cron expression (creating one if the goal has none);
   * `null` removes the linked schedule. Schedule edits never create or detach
   * tasks, never consume/clear `pendingNextRun`, and preserve `activeTaskId`/
   * `lastTaskId`/history.
   */
  checkInCronExpression?: string | null;
  /** IANA timezone applied with a `checkInCronExpression` set/update. */
  checkInTimezone?: string;
  pendingNextRun?: boolean;
  activeTaskId?: string | null;
  lastTaskId?: string | null;
  lastCheckInAt?: number | null;
  nextCheckInAt?: number | null;
  completedAt?: number | null;
}

export interface SpaceGoalListParams {
  spaceId: string;
  status?: SpaceGoalStatus;
  includeArchived?: boolean;
  label?: string;
  search?: string;
}

// ============================================================================
// TaskSchedule Types
// ============================================================================

/** Trigger type for a task schedule */
export type TaskScheduleTriggerType = 'cron' | 'at';

/** Status of a task schedule */
export type TaskScheduleStatus = 'active' | 'paused' | 'completed';

/**
 * A scheduled task template — defines a recurring (cron) or one-shot (at)
 * schedule that creates real SpaceTasks when it fires.
 */
export interface TaskSchedule {
  /** Unique identifier */
  id: string;
  /** Space this schedule belongs to */
  spaceId: string;
  /** Task title template */
  title: string;
  /** Task description template */
  description: string;
  /** Task priority to use when creating the task */
  priority: SpaceTaskPriority;
  /** Preferred workflow ID to attach to created tasks */
  preferredWorkflowId: string | null;
  /** Labels to apply to created tasks */
  labels: string[];
  /** System metadata for internal schedule routing. */
  metadata: Record<string, unknown>;
  /** Trigger type — 'cron' for recurring, 'at' for one-shot */
  triggerType: TaskScheduleTriggerType;
  /** Cron expression (e.g. '0 9 * * 1') — used when triggerType is 'cron' */
  cronExpression: string | null;
  /** Unix ms timestamp for one-shot triggers — used when triggerType is 'at' */
  runAt: number | null;
  /** IANA timezone string (default: 'UTC') */
  timezone: string;
  /** Computed timestamp of next scheduled fire (ms since epoch) */
  nextRunAt: number | null;
  /** Timestamp of last successful fire (ms since epoch) */
  lastRunAt: number | null;
  /** ID of the most recently spawned SpaceTask */
  lastCreatedTaskId: string | null;
  /** Job ID of the pending job in the queue (for O(1) cancel/pause) */
  pendingJobId: string | null;
  /** Current schedule status */
  status: TaskScheduleStatus;
  /** Agent name that created this schedule */
  createdByAgent: string | null;
  /** Session ID of the agent that created this schedule */
  createdBySession: string | null;
  /** Creation timestamp (ms since epoch) */
  createdAt: number;
  /** SpaceGoal this schedule belongs to, when used for recurring goal check-ins. */
  goalId?: string | null;
  /** Last update timestamp (ms since epoch) */
  updatedAt: number;
}

/**
 * Runtime activity state for a live task-agent member.
 * This is more user-facing than raw session processing states.
 */
export type SpaceTaskActivityState =
  | 'active'
  | 'queued'
  | 'idle'
  | 'cooldown'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'interrupted';

/**
 * A task managed within a Space.
 * User-facing orchestration unit — one task = one deliverable that may involve
 * multiple workflow node executions internally.
 */
export interface SpaceTask {
  /** Unique identifier */
  id: string;
  /** Space this task belongs to */
  spaceId: string;
  /** Human-friendly numeric ID, unique per space (auto-incremented, like GitHub issue numbers) */
  taskNumber: number;
  /** Task title */
  title: string;
  /** Detailed description */
  description: string;
  /** Current status */
  status: SpaceTaskStatus;
  /** Priority level */
  priority: SpaceTaskPriority;
  /** Free-form labels for filtering and categorisation */
  labels: string[];
  /** IDs of tasks this task depends on (prerequisites in the same space) */
  dependsOn: string[];
  /** Final output from the agent when the task reaches a terminal state; null until set */
  result: string | null;
  /** ID of the workflow run that orchestrates this task (links task to its workflow execution) */
  workflowRunId?: string | null;
  /**
   * Preferred workflow template ID for this task.
   * When set by the caller via `create_standalone_task({ workflow_id })`, the runtime
   * uses this workflow instead of the heuristic fallback when attaching a workflow run.
   */
  preferredWorkflowId?: string | null;
  /** ID of the planning task that created this task */
  createdByTaskId?: string | null;
  /**
   * Agent name that created this task (e.g. 'space-agent', 'coder', 'task-agent').
   * Set when a task is created via `create_standalone_task` tool.
   */
  createdBy?: string | null;
  /**
   * Session ID of the agent that created this task.
   * Set when a task is created via `create_standalone_task` tool.
   */
  createdBySession?: string | null;
  /**
   * ID of the TaskSchedule that spawned this task.
   * Set when a task is created by the task-schedule.fire job handler.
   * Null for manually created tasks.
   */
  createdByTaskScheduleId?: string | null;
  /** ID of the SpaceGoal this task is executing toward. */
  goalId?: string | null;
  /** ID of the EvolutionScope this task explicitly contributes evidence to. */
  evolutionScopeId?: string | null;
  /**
   * Per-task workflow node-agent model overrides. Keyed as `${workflowNodeId}:${agentName}`.
   * Applies only to this task's workflow run; does not mutate the workflow template.
   */
  workflowModelOverrides?: Record<string, string>;
  /**
   * Which agent session is currently active (generating output).
   * Cleared when the session reaches a terminal state.
   */
  activeSession?: 'worker' | 'leader' | null;
  /**
   * ID of the Task Agent session that orchestrates this task's workflow execution.
   * Set when the task transitions from `open` to `in_progress` and a Task Agent
   * session is created. Null when no Task Agent has been spawned yet.
   * Node-level tasks use `node_executions.agentSessionId` instead.
   */
  taskAgentSessionId?: string | null;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp when task transitioned to `in_progress` (milliseconds since epoch); null until started */
  startedAt: number | null;
  /** Timestamp when task reached a terminal state (milliseconds since epoch); null until completed */
  completedAt: number | null;
  /** Timestamp when task was archived (milliseconds since epoch); null until archived */
  archivedAt: number | null;
  /** Why this task is blocked; null when status is not `blocked` */
  blockReason: SpaceBlockReason | null;
  /** Who approved this task (set when transitioning from review → done or via auto_policy) */
  approvalSource: SpaceApprovalSource | null;
  /** Optional reason/comment for the approval or rejection */
  approvalReason: string | null;
  /** Timestamp when approval occurred (milliseconds since epoch); null until approved */
  approvedAt: number | null;
  /**
   * Type of checkpoint the task is currently paused at. Null when not paused.
   * - `task_completion`: paused awaiting human approval of a submit_for_approval request
   */
  pendingCheckpointType: 'task_completion' | null;
  /**
   * Node ID of the end-node agent that called `submit_for_approval`. Set when the
   * task enters `review` status via that tool; cleared on approve/reject.
   */
  pendingCompletionSubmittedByNodeId?: string | null;
  /**
   * Timestamp (ms) when `submit_for_approval` was called. Null when not pending.
   */
  pendingCompletionSubmittedAt?: number | null;
  /**
   * Agent-supplied rationale passed to `submit_for_approval`. Shown to the human
   * in the approval banner. Null when the agent did not provide one.
   */
  pendingCompletionReason?: string | null;
  /**
   * Status the end-node agent reported by writing this field. Null until the
   * agent reports. Recorded separately from `status` so the runtime can resolve
   * the final task status through the `submit_for_approval` review path
   * (supervised modes) without the agent bypassing the gate. Once recorded,
   * this field is preserved for audit even after `status` reaches a terminal
   * value.
   */
  reportedStatus: SpaceReportedStatus | null;
  /**
   * Summary the end-node agent provided alongside `reportedStatus`. Null until reported.
   */
  reportedSummary: string | null;
  /**
   * Session ID of the post-approval executor (e.g. the Task Agent session running
   * the workflow's `postApproval` route) while it is executing. Null when no
   * post-approval action is in progress.
   *
   * Schema only in PR 1 of the task-agent-as-post-approval-executor refactor; no
   * runtime consumer yet.
   */
  postApprovalSessionId?: string | null;
  /**
   * Timestamp (ms since epoch) when the post-approval executor started. Null when
   * no post-approval action has run for this task.
   *
   * Schema only in PR 1; no runtime consumer yet.
   */
  postApprovalStartedAt?: number | null;
  /**
   * Free-form reason captured when a post-approval executor cannot proceed (e.g.
   * human rejected, target agent unavailable, script failure). Null when not
   * blocked.
   *
   * Schema only in PR 1; no runtime consumer yet.
   */
  postApprovalBlockedReason?: string | null;
  /**
   * Durable workflow-node ID of the end-node that submitted/approved the task
   * (`submit_for_approval` / `approve_task`). The post-approval router reads
   * this — NOT `pendingCompletionSubmittedByNodeId` — for its informational
   * `sourceNodeId` (logging + the no-route audit write), the `approval_authority`
   * template token, and the sibling-quiesce source exclusion, because the
   * pending-completion fields are cleared atomically in the same UPDATE that
   * commits `approved` (task #851).
   *
   * Stamped when the task enters the pending/approval flow and cleared when the
   * task leaves `approved`, aborts `review`, or is reactivated. Surviving into
   * `approved` (rather than being one of the cleared pending fields) is what
   * makes the router crash-safe: a reconciliation retry can still resolve the
   * correct source even if the original dispatch crashed after the status commit.
   */
  postApprovalSourceNodeId?: string | null;
  /**
   * Restriction data when a task is paused due to an API rate or usage limit
   * (`status` is `rate_limited` or `usage_limited`). Null when the task is not
   * paused. Persisted so the UI can show the reset time and the runtime can
   * auto-resume when the limit lifts.
   */
  restrictions?: TaskRestriction | null;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Paginated result for `spaceTask.list` when called with pagination params
 * (`status` + `limit`/`offset`). Returned alongside the legacy bare-array shape
 * so callers can opt into pagination per-call without breaking existing consumers.
 */
export interface PaginatedSpaceTaskResult {
  tasks: SpaceTask[];
  total: number;
}

/**
 * One live participant in a task's execution.
 * This can be the orchestration Task Agent or a spawned node agent sub-session.
 */
export interface SpaceTaskActivityMember {
  /** Stable ID for rendering — usually the session ID */
  id: string;
  /** Session backing this activity row */
  sessionId: string;
  /** Whether this row represents the orchestration task agent or a node agent */
  kind: 'task_agent' | 'node_agent';
  /** Human-readable label for the activity row */
  label: string;
  /** Agent name or slot name (e.g. task-agent, reviewer, strict-reviewer). DB column: `role`. */
  role: string;
  /** Derived user-facing activity state */
  state: SpaceTaskActivityState;
  /** Raw session processing status when the session is live in memory */
  processingStatus?:
    | 'idle'
    | 'queued'
    | 'processing'
    | 'waiting_for_input'
    | 'rate_limit_cooldown'
    | 'interrupted'
    | null;
  /** Raw processing phase when the session is actively processing */
  processingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
  /**
   * Rate-limit cooldown details. Present (non-null) only when
   * `processingStatus === 'rate_limit_cooldown'`. Extracted from the same
   * `processing_state` JSON column the activity query reads, so the value
   * stays reactive without a separate subscription. Surfaces the countdown +
   * Retry/Cancel affordance in the Space task thread without forcing the
   * user into the chat container.
   */
  rateLimitCooldown?: { retryCount: number; maxRetries: number; retryAt: number } | null;
  /**
   * Active structured session error snapshot (persisted on the session row),
   * or null when the session has no active error. Mirrors the in-memory
   * `errorCache` lifecycle (set on `session.error`, cleared on
   * `session.errorClear`). `category` matches the daemon `ErrorCategory`
   * union (e.g. `'provider_auth_error'`). `providerId` is present for
   * provider errors so the task thread can render a re-authenticate affordance.
   */
  sessionError?: {
    category: string;
    message: string;
    providerId?: string | null;
  } | null;
  /** Number of persisted SDK messages seen in the backing session */
  messageCount: number;
  /** Linked SpaceTask when this member corresponds to a persisted step task */
  taskId?: string | null;
  /** Human-readable task title associated with this member */
  taskTitle?: string | null;
  /** Status of the linked SpaceTask, if any (uses new 6-value SpaceTaskStatus) */
  taskStatus?: SpaceTaskStatus | null;
  /**
   * Node execution context for node-agent members.
   * Provides workflow-internal state (node, agent slot, result) without polluting SpaceTask.
   */
  nodeExecution?: {
    /** Node execution ID for exact routing to this workflow sub-session */
    nodeExecutionId: string;
    /** Workflow node ID */
    nodeId: string;
    /** Human-readable node / agent slot name */
    agentName: string;
    /** Execution status */
    status: NodeExecutionStatus;
    /** Result output reported by the end-node agent, if set */
    result?: string | null;
    /**
     * True only for the latest post-approval worker session for this task
     * (execution-less workers from repeated approvals W1/W2/W3… all surface as
     * members; only the newest is current). Used to avoid binding the composer
     * to a finished historical worker.
     */
    isCurrentPostApproval?: boolean;
  } | null;
  /** Last update timestamp from the linked SpaceTask or backing session metadata */
  updatedAt?: number | null;
  /** Timestamp of the last persisted SDK message for this session */
  lastMessageAt?: number | null;
}

/**
 * Parameters for creating a new SpaceTask
 */
export interface CreateSpaceTaskParams {
  spaceId: string;
  title: string;
  description?: string;
  priority?: SpaceTaskPriority;
  /** Free-form labels for filtering and categorisation */
  labels?: string[];
  /** IDs of prerequisite tasks in the same space */
  dependsOn?: string[];
  /** Initial status — defaults to 'open'. Use 'draft' to create a draft task. */
  status?: SpaceTaskStatus;
  /** Workflow run that spawned this task */
  workflowRunId?: string | null;
  /**
   * Preferred workflow template ID.
   * When provided, the runtime uses this workflow for standalone task attachment
   * instead of the heuristic auto-selection.
   */
  preferredWorkflowId?: string | null;
  /** ID of planning task that created this task */
  createdByTaskId?: string | null;
  /**
   * Agent name that created this task (e.g. 'space-agent', 'coder', 'task-agent').
   * Set when a task is created via `create_standalone_task` tool.
   */
  createdBy?: string | null;
  /**
   * Session ID of the agent that created this task.
   * Set when a task is created via `create_standalone_task` tool.
   */
  createdBySession?: string | null;
  /**
   * ID of the Task Agent session that orchestrates this task's workflow execution.
   * Set when the task transitions from 'open' to 'in_progress'.
   */
  taskAgentSessionId?: string | null;
  /**
   * ID of the TaskSchedule that spawned this task.
   * Set by the task-schedule.fire job handler.
   */
  createdByTaskScheduleId?: string | null;
}

/**
 * Internal parameters for creating SpaceTask rows with system-owned linkage.
 */
export interface InternalCreateSpaceTaskParams extends CreateSpaceTaskParams {
  /** ID of the SpaceGoal this task should be linked to. */
  goalId?: string | null;
  /** ID of the EvolutionScope this task explicitly contributes evidence to. */
  evolutionScopeId?: string | null;
}

/**
 * Parameters for updating a SpaceTask
 */
export interface UpdateSpaceTaskParams {
  title?: string;
  description?: string;
  status?: SpaceTaskStatus;
  priority?: SpaceTaskPriority;
  labels?: string[];
  dependsOn?: string[];
  result?: string | null;
  workflowRunId?: string | null;
  preferredWorkflowId?: string | null;
  createdByTaskId?: string | null;
  activeSession?: 'worker' | 'leader' | null;
  /**
   * ID of the Task Agent session that orchestrates this task's workflow execution.
   * Set when spawning a Task Agent; null to clear the reference.
   */
  taskAgentSessionId?: string | null;
  /** Timestamp when task transitioned to `in_progress`; null to clear */
  startedAt?: number | null;
  /** Timestamp when task reached a terminal state; null to clear */
  completedAt?: number | null;
  /** Timestamp when task was archived; null to clear */
  archivedAt?: number | null;
  /** Why this task is blocked; null to clear */
  blockReason?: SpaceBlockReason | null;
  /** Who approved this task */
  approvalSource?: SpaceApprovalSource | null;
  /** Optional approval reason/comment */
  approvalReason?: string | null;
  /**
   * Optional cancellation/rejection reason. Stored into the same underlying
   * `approval_reason` column as `approvalReason`, but semantically paired with
   * transitions that abort work (e.g. review → cancelled, or rejecting a
   * `submit_for_approval` request). When both are provided, the runtime picks
   * the one that matches the transition direction.
   */
  cancelReason?: string | null;
  /** Timestamp when approval occurred; null to clear */
  approvedAt?: number | null;
  /** Type of checkpoint the task is paused at; null to clear */
  pendingCheckpointType?: 'task_completion' | null;
  /**
   * Node ID of the agent that called `submit_for_approval`; null to clear.
   * See `SpaceTask.pendingCompletionSubmittedByNodeId`.
   */
  pendingCompletionSubmittedByNodeId?: string | null;
  /** Timestamp (ms) when `submit_for_approval` was called; null to clear. */
  pendingCompletionSubmittedAt?: number | null;
  /** Agent-supplied rationale for `submit_for_approval`; null to clear. */
  pendingCompletionReason?: string | null;
  /** Agent-reported terminal status (written to `task.reportedStatus`); null to clear */
  reportedStatus?: SpaceReportedStatus | null;
  /** Agent-reported summary (written to `task.reportedSummary`); null to clear */
  reportedSummary?: string | null;
  /** Per-task workflow node-agent model overrides; null clears all overrides. */
  workflowModelOverrides?: Record<string, string> | null;
  /**
   * Session ID of the post-approval executor; null to clear.
   * Schema only in PR 1 of the post-approval refactor; no runtime consumer yet.
   */
  postApprovalSessionId?: string | null;
  /**
   * Timestamp (ms) when the post-approval executor started; null to clear.
   * Schema only in PR 1; no runtime consumer yet.
   */
  postApprovalStartedAt?: number | null;
  /**
   * Reason a post-approval action is blocked; null to clear.
   * Schema only in PR 1; no runtime consumer yet.
   */
  postApprovalBlockedReason?: string | null;
  /**
   * Durable source-node ID for post-approval routing; null to clear.
   * See `SpaceTask.postApprovalSourceNodeId`.
   */
  postApprovalSourceNodeId?: string | null;
  /**
   * Restriction data for a task paused on a rate/usage limit; null to clear
   * (restoring the task to in_progress). Set together with `status`
   * `rate_limited` / `usage_limited`.
   */
  restrictions?: TaskRestriction | null;
}

/**
 * Internal parameters for updating SpaceTask rows with system-owned linkage.
 */
export interface InternalUpdateSpaceTaskParams extends UpdateSpaceTaskParams {
  /** ID of the SpaceGoal this task is linked to; null to clear. */
  goalId?: string | null;
  /** ID of the EvolutionScope this task explicitly contributes evidence to; null to clear. */
  evolutionScopeId?: string | null;
  /** Per-task workflow node-agent model overrides; null clears all overrides. */
  workflowModelOverrides?: Record<string, string> | null;
  /**
   * Optimistic-concurrency guard: when provided, the UPDATE predicates on the
   * row's CURRENT status being one of these (`WHERE id = ? AND status IN (…)`),
   * making the check and the write one atomic SQL statement. A concurrent
   * status change yields a 0-row update (repository returns null) instead of a
   * lost update. Storage-only — never accepted from RPC/tool callers.
   */
  expectedStatuses?: SpaceTaskStatus[];
}

// ============================================================================
// Node Execution Types
// ============================================================================

/**
 * Status of a node execution slot within a workflow run.
 *
 * - `pending`     — slot has been created but the agent has not started yet
 * - `in_progress` — agent session is actively running
 * - `idle`        — agent session finished naturally (detected via session idle event)
 * - `waiting_rebind` — execution is paused while orphaned tool_result recovery rebinds/retries
 * - `blocked`     — execution requires human intervention or a gate has not passed
 * - `cancelled`   — execution was cancelled (workflow run cancelled or error path)
 */
export type NodeExecutionStatus =
  | 'pending'
  | 'in_progress'
  | 'idle'
  | 'waiting_rebind'
  | 'blocked'
  | 'cancelled';

/**
 * Records the execution of a single agent slot within a workflow run's node.
 * One row is created per `(workflowRunId, workflowNodeId, agentName)` triple.
 * This separates workflow-internal state from the user-facing `SpaceTask`.
 */
export interface NodeExecution {
  /** Unique identifier */
  id: string;
  /** Workflow run this execution belongs to */
  workflowRunId: string;
  /** ID of the workflow node in the workflow definition */
  workflowNodeId: string;
  /** Agent slot name (`WorkflowNodeAgent.name`) — channel routing address */
  agentName: string;
  /** ID of the SpaceWorkerAgent assigned to this slot; null when the agent has been deleted */
  agentId: string | null;
  /** Agent sub-session ID for liveness tracking; null until session is created */
  agentSessionId: string | null;
  /** Current execution status */
  status: NodeExecutionStatus;
  /** Human-readable summary from `save(summary)`; null until the agent saves output */
  result: string | null;
  /** Structured output from `save(data)`; null until the agent saves structured data */
  data: Record<string, unknown> | null;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp when execution transitioned to `in_progress`; null until started */
  startedAt: number | null;
  /** Timestamp when execution reached a terminal state; null until completed */
  completedAt: number | null;
  /** Last update timestamp — advances on every runtime state-write (status/session/data transition). */
  updatedAt: number;
  /**
   * Last observed agent activity timestamp (milliseconds since epoch).
   *
   * Refreshed independently of `updatedAt` by real agent work — SDK tool-call /
   * tool-result events, peer messages delivered to the session, and commits pushed
   * to the node's PR branch — so it stays fresh while an agent is plainly working
   * even when no runtime state transition occurs. This is the signal stall/timeout
   * detection and UI liveness displays should key off; `updatedAt` is not a
   * reliable liveness signal (it freezes at the last state change).
   */
  lastActivityAt: number | null;
}

/**
 * Parameters for creating a new NodeExecution record
 */
export interface CreateNodeExecutionParams {
  workflowRunId: string;
  workflowNodeId: string;
  agentName: string;
  agentId?: string | null;
  /** Initial status — defaults to 'pending' */
  status?: NodeExecutionStatus;
  /** Agent sub-session ID when the session is already known at creation time */
  agentSessionId?: string | null;
}

/**
 * Parameters for updating a NodeExecution record
 */
export interface UpdateNodeExecutionParams {
  status?: NodeExecutionStatus;
  agentSessionId?: string | null;
  result?: string | null;
  data?: Record<string, unknown> | null;
  startedAt?: number | null;
  completedAt?: number | null;
  /**
   * Last agent-activity timestamp. Rarely set explicitly through `update()` —
   * ongoing activity is recorded via the repository's dedicated activity-touch
   * method so `updatedAt` (state-write) semantics are preserved.
   */
  lastActivityAt?: number | null;
}

// ============================================================================
// Space Workflow Run Types
// ============================================================================

/**
 * Persisted status of a workflow execution attempt.
 *
 * UI labels should use execution-attempt vocabulary from `space-utils.ts`:
 * `pending` → Queued, `in_progress` → Running, `done` → Succeeded,
 * `blocked` → Waiting, and `cancelled` → Cancelled.
 *
 * - `pending`     — run created, awaiting Task Agent to start nodes
 * - `in_progress` — at least one node execution is active
 * - `done`        — execution attempt succeeded; persisted value remains `done`
 * - `blocked`     — run requires human intervention (gate rejection, crash, etc.)
 * - `cancelled`   — run was cancelled before succeeding
 */
export type WorkflowRunStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

/**
 * Tracks a single execution of a Space workflow.
 * A workflow run is created each time a workflow is triggered and tracks
 * the progress through each node of the workflow definition.
 */
export interface SpaceWorkflowRun {
  /** Unique identifier */
  id: string;
  /** Space this run belongs to */
  spaceId: string;
  /** ID of the workflow definition being executed */
  workflowId: string;
  /** Immutable definition version pinned when the run was created; null for legacy runs. */
  definitionVersion: string | null;
  /** Human-readable title for this run (e.g., "Deploy v2.1 — Run #3") */
  title: string;
  /** Optional description or goal for this run */
  description?: string;
  /** Current execution status */
  status: WorkflowRunStatus;
  /**
   * Reason for workflow run failure. Only set when the run reaches a terminal
   * failure state (`blocked` or `cancelled`).
   */
  failureReason?: WorkflowRunFailureReason;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp when the first node execution started; null until the run begins executing */
  startedAt: number | null;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
  /** Completion timestamp (milliseconds since epoch); null until the run reaches a terminal state */
  completedAt: number | null;
}

/**
 * Parameters for creating a new SpaceWorkflowRun
 */
export interface CreateWorkflowRunParams {
  spaceId: string;
  workflowId: string;
  title: string;
  description?: string;
}

// ============================================================================
// SpaceWorkerAgent Types (M2)
// ============================================================================

/**
 * A named agent configuration within a Space.
 * SpaceAgents can be referenced by name in SpaceWorkflow nodes.
 */
export type SpaceWorkerAgentStatus = 'active' | 'paused' | 'archived';

export interface SpaceWorkerAgent {
  /** Unique identifier */
  id: string;
  /** Space this agent belongs to */
  spaceId: string;
  /** Human-readable name (unique within a space) */
  name: string;
  /** URL-safe handle (unique within a space), used for @mentions and agent URLs */
  handle: string;
  /** Long-horizon agent lifecycle state */
  status?: SpaceWorkerAgentStatus;
  /** Optional description of this agent's specialization */
  description?: string;
  /** Model ID override (e.g., 'claude-haiku-4-5') — uses space default if unset */
  model?: string;
  /** Thinking-level override — uses app default if unset */
  thinkingLevel?: ThinkingLevel;
  /** Provider name override (e.g., 'anthropic', 'openai') */
  provider?: string;
  /**
   * Custom prompt — operator-supplied persona, context, and operating procedure for this agent.
   * Appended AFTER the HyperNeo system contract in the prompt so the contract cannot be overridden.
   * Null when not set.
   */
  customPrompt: string | null;
  /**
   * Explicit tool override list. Any entry must be a name from KNOWN_TOOLS.
   *
   * When unset or empty, the agent inherits all SDK built-in tools at runtime.
   * When set, the runtime denies Bash/Write/Edit/MultiEdit/NotebookEdit if
   * they are omitted; all other SDK built-ins remain inherited. This is a
   * visible profile, not an exhaustive allowlist.
   */
  tools?: string[];
  /**
   * Setting sources to load for this agent.
   * Falls back to the global default (['user', 'project', 'local']) when unset.
   */
  settingSources?: SettingSource[];
  /**
   * When this agent was seeded from a preset, the canonical preset name
   * (e.g. "Reviewer", "Coder"). Null/undefined for user-created agents and
   * for any preset row that predates template tracking.
   */
  templateName?: string | null;
  /**
   * SHA-256 fingerprint of the preset definition at the time it was last
   * seeded or synced. Compared against the live preset hash to detect drift.
   * Null/undefined when {@link templateName} is null.
   */
  templateHash?: string | null;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Parameters for creating a new SpaceWorkerAgent
 */
export interface SpaceWorkerAgentPromotionProfile {
  responsibility: string;
  standingInstructions: string;
  autonomy: string;
  managedGoals: string;
  managedScopes: string;
  reminders: string;
  eventSubscriptions: string;
  standingContext: string;
}

export interface SpaceWorkerAgentPromotionDraft {
  sourceSessionId: string;
  sourceSessionTitle: string;
  name: string;
  description?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
  customPrompt: string;
  tools?: string[];
  settingSources?: SettingSource[];
  profile: SpaceWorkerAgentPromotionProfile;
}

export interface CreateSpaceWorkerAgentParams {
  spaceId: string;
  name: string;
  /** Optional explicit handle. When omitted, backend auto-generates one from name. */
  handle?: string;
  status?: SpaceWorkerAgentStatus;
  description?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
  /** Operator-supplied custom prompt appended after the HyperNeo contract; null when not set */
  customPrompt?: string | null;
  /** Explicit tool override list — any entry must be a name from KNOWN_TOOLS. Empty/unset inherits all SDK built-ins. */
  tools?: string[];
  /**
   * Setting sources to load for this agent.
   * Falls back to the global default (['user', 'project', 'local']) when unset.
   * Pass `null` to explicitly clear (revert to inherited defaults).
   */
  settingSources?: SettingSource[] | null;
  /**
   * Optional preset template name. Set by `seedPresetAgents()` when seeding
   * built-in presets; left undefined for user-created agents.
   * When set, `templateHash` should also be supplied.
   */
  templateName?: string | null;
  /**
   * Optional template fingerprint hash captured at seed time. Used by
   * drift-detection to spot when the source preset definition has changed.
   */
  templateHash?: string | null;
}

/**
 * Parameters for updating a SpaceWorkerAgent
 */
export interface UpdateSpaceWorkerAgentParams {
  name?: string;
  /** Update the URL-safe handle. Omit to leave unchanged. */
  handle?: string;
  status?: SpaceWorkerAgentStatus;
  description?: string | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  provider?: string | null;
  /** Operator-supplied custom prompt; null clears */
  customPrompt?: string | null;
  /** Explicit tool override list — null clears. Empty inherits all SDK built-ins; omitted mutators (Bash/Write/Edit/MultiEdit/NotebookEdit) are denied when the list is non-empty. */
  tools?: string[] | null;
  /**
   * Setting sources to load for this agent.
   * Pass `null` to clear (revert to global default).
   */
  settingSources?: SettingSource[] | null;
  /**
   * Update the preset template name. Pass `null` to clear template tracking
   * (e.g. when a user converts a preset agent into a fully custom one).
   */
  templateName?: string | null;
  /**
   * Update the stored template fingerprint hash. Used by the
   * `spaceAgent.syncFromTemplate` RPC after re-stamping a preset row to
   * the current definition.
   */
  templateHash?: string | null;
}

/**
 * Single entry in an {@link SpaceWorkerAgentDriftReport}.
 *
 * Each entry corresponds to one preset-seeded `SpaceWorkerAgent` row in a space,
 * OR a row that lost preset tracking but whose name still matches a known preset
 * (see {@link orphaned}). Rows for genuinely user-created agents — no
 * `templateName` AND a name that matches no preset — are not included.
 */
export interface SpaceWorkerAgentDriftEntry {
  /** Agent UUID. */
  agentId: string;
  /** Human-readable agent name (matches `SpaceWorkerAgent.name`). */
  agentName: string;
  /**
   * Preset template name this agent was seeded from. For an {@link orphaned}
   * row (no stored `templateName`), this is the canonical preset name resolved
   * from the row's name.
   */
  templateName: string;
  /**
   * Hash captured the last time this row was seeded or synced.
   * Null when the row predates template tracking and the backfill
   * migration could not match the row to a preset.
   */
  storedHash: string | null;
  /** Hash of the current preset definition in code. */
  currentHash: string;
  /**
   * Hash of the row's CURRENT fingerprint fields
   * (`name`, `description`, `tools`, `customPrompt`). Compared against
   * {@link storedHash} to derive {@link customized}.
   */
  rowHash: string;
  /**
   * The TEMPLATE improved in code since this row was last seeded/synced
   * ({@link currentHash} !== {@link storedHash}). Safe to apply — applying it
   * loses no custom data unless {@link customized} is also true. Supersedes
   * the old `drifted` flag with the identical comparison, so a pristine row
   * has the same value it had under `drifted`.
   */
  updateAvailable: boolean;
  /**
   * The USER customized this row since it was last seeded/synced
   * ({@link rowHash} !== {@link storedHash}). Purely informational — it never
   * implies anything is wrong or needs action. Note: `name` is part of the
   * fingerprint, so renaming a seeded agent registers as `customized`; this is
   * harmless because {@link SpaceWorkerAgent} sync preserves the name.
   */
  customized: boolean;
  /**
   * The row lost preset tracking (`templateName` is null) but its name matches
   * a known preset, so it can be re-attached. The Apply / sync path re-stamps
   * tracking from the resolved preset; without this flag the row would be
   * invisible to drift detection entirely (the historical bug). When true,
   * {@link storedHash} is null, {@link updateAvailable} is true (a re-attach is
   * always available), and {@link customized} reflects whether the row's fields
   * already diverge from the current preset.
   */
  orphaned: boolean;
}

/**
 * Returned by `spaceAgent.getDriftReport`. Lists all preset-seeded agents in
 * a space with the comparison between their stored fingerprint and the
 * current preset definition. Callers surface a UI badge only when
 * {@link SpaceWorkerAgentDriftEntry.updateAvailable} is true; a quiet
 * "Customized" tag when only {@link SpaceWorkerAgentDriftEntry.customized}
 * is true.
 */
export interface SpaceWorkerAgentDriftReport {
  /** Space the report was generated for. */
  spaceId: string;
  /** Per-agent drift entries — one row per preset-tracked SpaceWorkerAgent. */
  agents: SpaceWorkerAgentDriftEntry[];
}

/**
 * Before/after for a single string field that differs between a seeded agent
 * row and its live preset definition.
 */
export interface SpaceWorkerAgentSyncFieldDiff {
  /** Current value stored on the agent row. */
  before: string;
  /** Value the live preset would write on sync. */
  after: string;
}

/**
 * Before/after (plus added/removed) for the tools list. `added`/`removed` are
 * derived from the two arrays so the UI can render a concise delta without
 * recomputing the set difference.
 */
export interface SpaceWorkerAgentSyncToolsDiff {
  /** Tools currently on the agent row. */
  before: string[];
  /** Tools the live preset would write on sync. */
  after: string[];
  /** Tools in the preset that are not on the current row. */
  added: string[];
  /** Tools on the current row that the preset no longer includes. */
  removed: string[];
}

/**
 * Per-field diff between a seeded SpaceWorkerAgent and its live preset
 * definition. Only fields that actually differ are present. An empty object
 * means the row's fields already match the preset (fields are in sync even if
 * the stored hash is stale or missing).
 *
 * Covers exactly the fields {@link SpaceWorkerAgent} sync overwrites —
 * `customPrompt`, `description`, `tools` — so the preview is an exact
 * predictor of the apply step. `thinkingLevel` is intentionally excluded: it
 * is not part of the template fingerprint and preset definitions never set
 * it, so sync never touches it.
 */
export interface SpaceWorkerAgentSyncDiff {
  customPrompt?: SpaceWorkerAgentSyncFieldDiff;
  description?: SpaceWorkerAgentSyncFieldDiff;
  tools?: SpaceWorkerAgentSyncToolsDiff;
}

/**
 * Returned by `spaceAgent.previewTemplateSync`. Describes what
 * `spaceAgent.syncFromTemplate` would change for a single preset-tracked
 * agent, without writing. {@link updateAvailable} / {@link customized} use the
 * same two-hash comparisons as the drift report; `diff` adds the field-level
 * before/after detail.
 */
export interface SpaceWorkerAgentSyncPreview {
  /** Agent UUID. */
  agentId: string;
  /** Human-readable agent name. */
  agentName: string;
  /** Preset template name this agent was seeded from. */
  templateName: string;
  /** Hash captured the last time this row was seeded or synced. */
  storedHash: string | null;
  /** Hash of the current preset definition in code. */
  liveHash: string;
  /** Hash of the row's current fingerprint fields. */
  rowHash: string;
  /** True when the template improved ({@link storedHash} !== {@link liveHash}). */
  updateAvailable: boolean;
  /** True when the user customized the row ({@link rowHash} !== {@link storedHash}). */
  customized: boolean;
  /** Per-field before/after diff; empty when the fields already match. */
  diff: SpaceWorkerAgentSyncDiff;
}

// ============================================================================
// Workflow template-sync preview (two-signal drift split)
// ============================================================================

/**
 * Before/after for a single text field that differs between a seeded workflow
 * row and its live built-in template. Mirrors {@link SpaceWorkerAgentSyncFieldDiff}.
 */
export interface SpaceWorkflowSyncFieldDiff {
  /** Current value stored on the workflow row. */
  before: string;
  /** Value the live template would write on sync. */
  after: string;
}

/**
 * Name-keyed set delta for a structural collection (node names, gate ids,
 * channel `from→to` keys). `added`/`removed` are derived from the two lists so
 * the UI can render a concise delta without recomputing the set difference.
 */
export interface SpaceWorkflowSyncNameDelta {
  /** Names currently on the workflow row. */
  before: string[];
  /** Names the live template would write on sync. */
  after: string[];
  /** Names in the template that are not on the current row. */
  added: string[];
  /** Names on the current row that the template no longer includes. */
  removed: string[];
}

/**
 * Per-field structural diff between a seeded {@link SpaceWorkflow} and its
 * live built-in template. Only fields that actually differ are present. An
 * empty object means the row's structure already matches the template (the row
 * is in sync even if the stored hash is stale or missing).
 *
 * Covers the highest-signal structural fields — `description`, `instructions`,
 * and the node set (by name). A full node-by-node deep diff is intentionally
 * out of scope: workflow sync overwrites the entire structure, so the modal
 * always states that explicitly regardless of which fields are enumerated here.
 */
export interface SpaceWorkflowSyncDiff {
  description?: SpaceWorkflowSyncFieldDiff;
  instructions?: SpaceWorkflowSyncFieldDiff;
  nodes?: SpaceWorkflowSyncNameDelta;
}

/**
 * Returned by `spaceWorkflow.previewTemplateSync`. Describes what
 * `spaceWorkflow.syncFromTemplate` would change for a single
 * template-tracked workflow, without writing. {@link updateAvailable} /
 * {@link customized} use the same two-hash comparisons as
 * `spaceWorkflow.detectDrift`; `diff` adds the structural before/after detail.
 */
export interface SpaceWorkflowSyncPreview {
  /** Workflow UUID. */
  workflowId: string;
  /** Human-readable workflow name. */
  workflowName: string;
  /** Built-in template name this workflow was seeded from. */
  templateName: string;
  /** Hash captured the last time this row was seeded or synced. */
  storedHash: string | null;
  /** Hash of the current built-in template definition in code. */
  liveHash: string;
  /** Hash of the row's current structure. */
  rowHash: string;
  /** True when the template improved ({@link storedHash} !== {@link liveHash}). */
  updateAvailable: boolean;
  /** True when the user customized the row ({@link rowHash} !== {@link storedHash}). */
  customized: boolean;
  /** Structural before/after diff; empty when the structure already matches. */
  diff: SpaceWorkflowSyncDiff;
}

// ============================================================================
// Workflow Types (M3)
// ============================================================================

export type WorkflowHookMcpMethod =
  | 'send_message'
  | 'save_artifact'
  | 'create_standalone_task'
  | 'mark_complete'
  | 'submit_for_approval'
  | 'approve_task';

export type WorkflowHookValidatorId =
  | 'pr_open'
  | 'pr_mergeable'
  | 'pr_ready'
  | 'pr_merged'
  | 'review_posted'
  | 'github_review_approved'
  | 'codex_review_approved'
  | 'artifact_exists'
  | 'task_reported_status'
  | 'post_approval_only';

/**
 * A connector id named in a script hook's `externalLookups`. The engine admits
 * any id that resolves to a registered connector (L2 registry, epic #2299); the
 * literal `'github'` is no longer special-cased in the type.
 *
 * `string & {}` keeps assignability from string literals while marking the type
 * as a distinct connector-id position (vs an arbitrary string) in signatures
 * and IDE hovers. The registry is the real source of truth; this is a nominal
 * cue, not an enforcement.
 */
export type WorkflowHookExternalLookup = string & {};

export interface WorkflowHookAuthorizedCaller {
  /** Source workflow node name authorized to invoke this hook. */
  sourceNode: string;
  /** Optional agent slot names within sourceNode. Omitted means any slot in sourceNode. */
  agentSlots?: string[];
}

export interface WorkflowHookRetrySettings {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier?: number;
}

export interface WorkflowHookPollSettings {
  intervalMs: number;
  maxDurationMs?: number;
}

export interface WorkflowHookScriptValidator {
  kind: 'script';
  interpreter: 'bash';
  source: string;
  timeoutMs?: number;
  externalLookups?: WorkflowHookExternalLookup[];
}

export interface WorkflowHookBuiltInValidator {
  kind: 'built_in';
  id: WorkflowHookValidatorId;
}

export type WorkflowHookValidator = WorkflowHookBuiltInValidator | WorkflowHookScriptValidator;

export interface WorkflowHookStateReference {
  hookId: string;
  key: string;
}

export interface WorkflowHookLocalStateConfig {
  defaults?: Record<string, unknown>;
  recentResultRef?: WorkflowHookStateReference;
}

export interface WorkflowHookBaseResult {
  message?: string;
  data?: Record<string, unknown>;
}

export interface WorkflowHookAllowResult extends WorkflowHookBaseResult {
  type: 'allow';
}

export interface WorkflowHookBlockResult extends WorkflowHookBaseResult {
  type: 'block';
  reason: string;
}

export interface WorkflowHookRetryableBlockResult extends WorkflowHookBaseResult {
  type: 'retryable_block';
  reason: string;
  retryAfterMs?: number;
}

export interface WorkflowHookPatchParamsResult extends WorkflowHookBaseResult {
  type: 'patch_params';
  patch: Record<string, unknown>;
}

export interface WorkflowHookEmitFollowUpResult extends WorkflowHookBaseResult {
  type: 'emit_follow_up';
  targetNode: string;
  message: string;
}

export interface WorkflowHookRecordStateResult extends WorkflowHookBaseResult {
  type: 'record_state';
  state?: Record<string, unknown>;
  stateForHook?: Record<string, Record<string, unknown>>;
}

export type WorkflowHookResult =
  | WorkflowHookAllowResult
  | WorkflowHookBlockResult
  | WorkflowHookRetryableBlockResult
  | WorkflowHookPatchParamsResult
  | WorkflowHookEmitFollowUpResult
  | WorkflowHookRecordStateResult;

export interface WorkflowHookStateSnapshot {
  runId: string;
  hookId: string;
  version: number;
  localState: Record<string, unknown>;
  lastResult?: WorkflowHookResult;
  retryCount: number;
  nextRetryAt?: number;
  voteMaps: Record<string, Record<string, unknown>>;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowHook {
  /** Stable hook identifier, unique inside a workflow. */
  id: string;
  enabled: boolean;
  /** Node whose MCP action or runtime event triggers this hook. */
  sourceNode: string;
  /** Optional node affected by this hook result. */
  targetNode?: string;
  method: WorkflowHookMcpMethod;
  templateData?: Record<string, unknown>;
  validator: WorkflowHookValidator;
  retry?: WorkflowHookRetrySettings;
  poll?: WorkflowHookPollSettings;
  localState?: WorkflowHookLocalStateConfig;
  /** Agents authorized to invoke this hook. Empty/absent fails closed unless humanOnly is true. */
  authorizedCallers?: WorkflowHookAuthorizedCaller[];
  /** Human-only hooks can only run from explicit UI approval/retry actions, never agent MCP sessions. */
  humanOnly?: boolean;
  /** Hook classification — determines execution order and failure semantics. Defaults to 'validation'. */
  classification?: 'validation' | 'side_effect';
  /** Execution order within classification (lower = earlier). Defaults to 0. */
  order?: number;
  /** Human-readable label for debugging and banner messages. */
  label?: string;
}

export interface WorkflowHookUserState {
  status:
    | 'allowed'
    | 'blocked_by_hook'
    | 'waiting_on_hook_retry'
    | 'patched'
    | 'follow_up_emitted'
    | 'state_recorded';
  hookId?: string;
  hookLabel?: string;
  method?: string;
  reason?: string;
  remediation?: string;
  sourceNode?: string;
  targetNode?: string;
  patchedKeys?: string[];
  emittedActionIds?: string[];
  retryAfterMs?: number;
  retryCount?: number;
  nextRetryAt?: number;
}

/**
 * A Channel — a simple unidirectional pipe between agents in a workflow.
 *
 * Channels define messaging topology. Delivery is not gated; action-level
 * policy is enforced by workflow hooks at the MCP-action boundary.
 */
export interface Channel {
  /** Unique identifier */
  id: string;
  /**
   * Source agent name string (`WorkflowNodeAgent.name`), node name,
   * or `'*'` for all agents. Cross-node format: `"nodeId/agentName"`.
   */
  from: string;
  /**
   * Target agent name string, array of name strings, or `'*'` for all agents.
   * An array enables fan-out or hub-spoke topologies.
   */
  to: string | string[];
  /**
   * Formerly the maximum number of times this cyclic channel could be traversed
   * per run before delivery was blocked.
   *
   * @deprecated Vestigial — no longer a blocking gate. Cyclic channels are now
   *   protected by rate-based dead-loop detection (`DEAD_LOOP_THRESHOLD`
   *   traversals within a rolling `DEAD_LOOP_WINDOW_MS` window), which catches a
   *   runaway tight ping-pong without false-tripping on a genuine extended
   *   review the way a lifetime cap did (see PR #2479 / task #942). A configured
   *   `maxCycles` value is **ignored** at runtime. The field is retained only so
   *   saved workflow configurations, template hashes, and imports stay
   *   backward-compatible; retiring it from the type and visual editor is a
   *   separate follow-up.
   */
  maxCycles?: number;
  /** Optional human-readable label for display in the visual editor. */
  label?: string;
}

/**
 * Failure reason for a workflow run that entered a terminal failure state.
 */
export type WorkflowRunFailureReason =
  | 'humanRejected'
  | 'maxIterationsReached'
  | 'nodeTimeout'
  | 'agentCrash';

/**
 * Expansion value for `customPrompt` in a workflow node agent slot.
 *
 * Always appended (expanded) to the agent's `customPrompt` — never replaces it.
 * This ensures the agent's base prompt is preserved when node-level context is added.
 */
export interface WorkflowNodeAgentOverride {
  value: string;
}

/**
 * A declarative tool guard that blocks or restricts specific tool invocations.
 *
 * Defined on a `WorkflowNodeAgent` slot and compiled into SDK hooks at runtime
 * by the query options builder. The builder has no hardcoded knowledge of specific
 * guards — it compiles whatever declarative rules the workflow provides.
 */
export interface DeclarativeToolGuard {
  /** Tool name to match (e.g., `'Bash'`) */
  matcher: string;
  /**
   * Regex pattern applied to the tool input's `command` field (for `Bash` matcher).
   * When the pattern matches, the `decision` is applied.
   * Use `^` to match all invocations of the tool regardless of input.
   */
  pattern: string;
  /** Decision when the pattern matches */
  decision: 'deny';
  /** Human-readable reason shown to the agent when the decision is applied */
  reason: string;
}

export interface EventInterest {
  /**
   * Glob pattern matching event topics.
   * Examples: 'github/owner/repo/pull_request/*.review_*', 'github/owner/repo/pull_request/42.*'
   *
   * The topic pattern IS the filter — the format encodes source identity,
   * scope (e.g. owner/repo for GitHub), resource, and entity/action.
   *
   * Exactly one of `topic` and {@link EventInterest.topicFrom} must be set.
   */
  topic?: string;

  /**
   * Resolve the subscription topic dynamically at subscription time from a
   * workflow run's durable state, rather than from a static literal.
   *
   * The `pattern` is a template whose placeholders are filled by the resolver
   * for the given `source`. For `'primaryLink'` the placeholders are
   * `{owner}`, `{repo}`, and `{number}` (the segments of the GitHub event topic
   * taxonomy), derived from the run's primary link (e.g. its PR URL) — example:
   * `'github/{owner}/{repo}/pull_request/{number}.*'`.
   *
   * This lets a static workflow definition subscribe to "this run's own PR"
   * without baking a PR number into the template. Design intent (the topic-trie
   * invariant): `topicFrom` is resolved to a concrete `topic` before any
   * subscription is registered, so the trie never stores templates. The
   * resolver itself (`resolveTopicFromInterest`) ships here, but wiring it into
   * registration is a follow-up PR — in this PR `topicFrom` is validated but
   * inert at registration time (see `SpaceRuntime.registerRunInterests`).
   *
   * Exactly one of {@link EventInterest.topic} and `topicFrom` must be set.
   */
  topicFrom?: { source: 'primaryLink'; pattern: string };

  /**
   * Optional label for diagnostics. Not used in matching logic.
   * Example: 'PR review comments', 'CI failures'
   */
  label?: string;
}

/**
 * A single agent entry within a multi-agent workflow node.
 * References a SpaceWorkerAgent by ID with an optional per-slot configuration override.
 */
export interface WorkflowNodeAgent {
  /** ID of the SpaceWorkerAgent assigned to this slot */
  agentId: string;
  /**
   * Agent slot label — must be unique within the node.
   * Derived from the SpaceWorkerAgent name. When the same agent is added to a node
   * multiple times, a numeric suffix is appended (e.g. `"Reviewer"` → `"Reviewer-2"`).
   * Used for gate `writers` lists and `node_executions.agent_name`.
   */
  name: string;
  /**
   * Optional model override for this agent slot.
   * When absent, the assigned SpaceWorkerAgent model is used.
   */
  model?: string;
  /**
   * Optional thinking-level override for this agent slot.
   * When absent, the assigned SpaceWorkerAgent thinking level is used.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Optional custom-prompt expansion for this agent slot.
   * Always appended to the agent's `customPrompt` (never replaces it) unless
   * `replaceAgentPrompt` is set, in which case it replaces the agent's base prompt.
   * Use this to add node-specific context or role focus on top of the agent's base prompt.
   */
  customPrompt?: WorkflowNodeAgentOverride;
  /**
   * When true, this slot's `customPrompt` REPLACES the assigned agent's `customPrompt`
   * for this slot — the agent's base prompt is not used. The `claude_code` SDK preset
   * is always applied first regardless. Default false = append (today's behavior).
   */
  replaceAgentPrompt?: boolean;
  /**
   * IDs of globally-enabled skills to disable for this agent slot.
   * Allows per-slot skill customization on top of the global skills registry.
   */
  disabledSkillIds?: string[];
  /**
   * Extra MCP servers to add for this agent slot (per-node config).
   * Merged with app-level MCP servers when building session options.
   */
  extraMcpServers?: Record<string, McpServerConfig>;
  /**
   * Static external event subscriptions for this workflow agent slot.
   * Each interest carries either a static `topic` glob or a `topicFrom` template
   * resolved at subscription time. Dynamic runtime subscriptions are managed
   * through node-agent MCP tools.
   */
  eventInterests?: EventInterest[];
  /**
   * Optional per-slot timeout (milliseconds) used by the runtime to decide
   * when an agent that is still alive but apparently stuck should be
   * auto-completed.
   *
   * When unset, the runtime falls back to its `DEFAULT_NODE_TIMEOUT_MS`
   * default. Per-node overrides belong with the workflow definition itself —
   * the runtime does not embed a role-name → timeout lookup. To give a
   * specific node a longer or shorter timeout than the default, set this on
   * the agent slot in the workflow definition.
   *
   * Must be a positive integer when present.
   */
  timeoutMs?: number;
  /**
   * Declarative tool guards compiled into SDK hooks at runtime.
   * The builder has no hardcoded knowledge of specific guards — it compiles
   * whatever rules the workflow provides.
   */
  toolGuards?: DeclarativeToolGuard[];
  /**
   * When true, the runtime resets this agent slot's SDK model context at the
   * start of each coder handoff (any node→node task input) so the agent starts
   * every turn with fresh context — no accumulation of prior conclusions
   * (useful for reviewers, who otherwise develop anchor bias across cycles).
   *
   * The clear happens at turn-start, only for task inputs (handoffs) — never
   * for human input, connection retry, rate-limit/watchdog re-enqueue, or
   * runtime recovery nags. The agent slot's first turn is skipped (no prior
   * context to clear). NeoKai's own message history (sdk_messages) is
   * preserved, so the UI still shows one continuous thread; only the SDK's
   * in-memory conversation context is wiped.
   *
   * Per-slot, data-driven — same philosophy as `timeoutMs`: the runtime does
   * NOT embed a role-name → behavior lookup. To give a specific slot fresh
   * eyes, set this on the agent slot in the workflow definition.
   */
  resetContextPerTurn?: boolean;
}

/**
 * A directed (one-way) messaging channel between two nodes in a workflow.
 *
 * Channels are always one-way. A relationship in both directions is represented as
 * two separate channels — each with its own independent gate and maxCycles.
 *
 * `from` and `to` reference node names (`WorkflowNode.name`). Node names must be
 * unique within a workflow. `to` may be an array to fan-out to multiple nodes.
 *
 * No channels = no messaging constraints (agents are fully isolated).
 */
export interface WorkflowChannel {
  /**
   * Stable identifier for this channel.
   * Should be present on all persisted channels. When absent the runtime
   * generates one at seed/migration time.
   */
  id?: string;
  /**
   * Source node name (`WorkflowNode.name`). Must match a node in this workflow.
   * Use `'*'` to match any node (rare).
   */
  from: string;
  /**
   * Target node name(s). `'*'` targets all nodes.
   * An array enables fan-out delivery to multiple nodes simultaneously.
   */
  to: string | string[];
  /**
   * Formerly the maximum number of times this cyclic channel could be traversed
   * per run before delivery was blocked.
   *
   * @deprecated Vestigial — no longer a blocking gate. This is the field
   *   persisted on workflow definitions and surfaced in the visual editor, but
   *   the runtime now ignores it: cyclic channels are protected by rate-based
   *   dead-loop detection (`DEAD_LOOP_THRESHOLD` traversals within a rolling
   *   `DEAD_LOOP_WINDOW_MS` window), which catches a runaway tight ping-pong
   *   without false-tripping on a genuine extended review the way a lifetime
   *   cap did (see PR #2479 / task #942). A configured `maxCycles` value has no
   *   effect. The field is retained only for backward-compatibility with saved
   *   configurations, template hashes, and imports; retiring it from the type
   *   and editor is a separate follow-up.
   */
  maxCycles?: number;
  /** Optional human-readable label for display in the visual editor */
  label?: string;
}

/**
 * The broadcast wildcard for a handoff {@link HandoffTransition.target} (and
 * for {@link HandoffOperation.target}). A transition whose `target` is `'*'`
 * hands off to every other node in the workflow; a sender reaches it by calling
 * `handoff({ target: '*' })`. It is a literal target, not a catch-all — a
 * `'*'` transition does not match a sender-supplied named target.
 */
export const HANDOFF_TARGET_WILDCARD = '*' as const;

/**
 * A declarative outbound handoff transition from a workflow node.
 *
 * A transition names ONE legal handoff target reachable from the node that
 * declares it. A first-class `handoff({ target, summary, data? })` issued by an
 * agent in that node must resolve to exactly one of its declared transitions —
 * see {@link resolveHandoffTransition}. A `target` that resolves to no
 * transition is rejected by the contract; it is never silently delivered as a
 * plain message.
 *
 * Relationship to {@link WorkflowChannel}: channels are messaging topology
 * (any agent-to-agent message). Transitions are control-flow handoffs — a
 * successful handoff completes the sender's current execution round, and the
 * target's context/reset policy is owned by the workflow and the target slot
 * (e.g. {@link WorkflowNodeAgent.resetContextPerTurn}), never by the sender.
 * The two coexist: a workflow may declare channels for peer discussion and
 * transitions for round-completing handoffs independently.
 *
 * `hookId` binds a transition to the SAME authorization primitive that
 * channels use. When `hookId` is set, the hook's validator must pass for the
 * handoff to complete.
 *
 * Runtime transition EXECUTION is not implemented in this contract phase — this
 * type is declarative, validated, and round-tripped through export/import only.
 */
export interface HandoffTransition {
  /**
   * Unique identifier for this transition within its node. Required so a
   * transition has a stable identity for diagnostics and export round-trips.
   */
  id: string;
  /** Optional human-readable label. Reserved for future UI use; not currently rendered by the visual editor. */
  label?: string;
  /**
   * Handoff target: a node name, an agent slot name, or
   * {@link HANDOFF_TARGET_WILDCARD} (`'*'`) for broadcast. Must resolve to a
   * declared node/agent at validation time. Targets must be unique within a
   * node so a `handoff({ target })` resolves unambiguously (at most one
   * transition per concrete name, at most one `'*'`).
   */
  target: string;
  /**
   * Optional hook whose validator must pass for this transition (e.g.
   * `pr_ready`). References a hook in `SpaceWorkflow.hooks`.
   */
  hookId?: string;
  /**
   * For cyclic transitions (target is an earlier node, closing a loop), the
   * maximum number of times this transition may be taken in a single workflow
   * run before it is blocked. Cyclicity is inferred from graph topology at
   * runtime, not stored. Mirrors {@link WorkflowChannel.maxCycles}. Must be a
   * positive integer when present.
   */
  maxCycles?: number;
}

/**
 * The minimal sender-facing shape of a first-class handoff operation:
 *
 *   handoff({ target, summary, data? })
 *
 * This is the contract an agent invokes; it is distinct from a generic
 * `send_message`. Semantics formalized by this contract (runtime execution is
 * a separate phase — not implemented here):
 *
 * - **target** MUST resolve to a declared outbound {@link HandoffTransition}
 *   on the sender's node. A target that resolves to no transition is rejected,
 *   not silently delivered as a plain message.
 * - **summary** is a NON-AUTHORITATIVE sender note. It is NOT the target's task
 *   description or input — the target's task/context is owned by the workflow
 *   and the target slot. Recipients may read it as context but must not treat
 *   it as an instruction channel, and the sender must not use it to direct the
 *   target's work or reset policy.
 * - **data** supplies the workflow-declared fields for the resolved transition
 *   (the template fields of its `hookId`). Keys outside the declared shape are
 *   rejected.
 * - A successful handoff COMPLETES the sender's current execution round; the
 *   sender does not continue after issuing one.
 * - Target context/reset policy (e.g. {@link WorkflowNodeAgent.resetContextPerTurn})
 *   is owned by the workflow and the target slot, NEVER by the sender.
 */
export interface HandoffOperation {
  /** Resolves to a declared outbound {@link HandoffTransition}. */
  target: string;
  /** Non-authoritative sender note. Not the target's task/input. */
  summary: string;
  /** Supplies the transition's workflow-declared hook fields. */
  data?: Record<string, unknown>;
}

/**
 * A single node in the workflow graph.
 * Nodes are the unit of workflow topology — they group one or more agents that
 * execute in parallel. Nodes are connected by WorkflowChannels.
 *
 * Node names must be unique within a workflow (used as channel addressing keys).
 * All agents are specified via `agents: WorkflowNodeAgent[]` — `agents` must be non-empty.
 */
export interface WorkflowNode {
  /** Unique identifier for this node (stable across renames) */
  id: string;
  /**
   * Human-readable name — must be unique within the workflow.
   * Used as the addressing key in `WorkflowChannel.from`/`to`.
   */
  name: string;
  /**
   * Agents for parallel execution within this node.
   * Must be non-empty. Each agent runs concurrently; the node completes when all agents complete.
   */
  agents: WorkflowNodeAgent[];
  /**
   * Optional post-approval route for this node. When this node is the completion
   * node that approves/submits the task for approval, the runtime dispatches
   * this route after the task becomes approved.
   */
  postApproval?: PostApprovalRoute;
  /**
   * Declared outbound handoff transitions from this node. A first-class
   * `handoff({ target, summary, data? })` issued by an agent in this node must
   * resolve to exactly one of these. Omitting it (or an empty array) means the
   * node declares no first-class handoffs — its agents may still communicate
   * over channels, but no round-completing handoff is available. See
   * {@link HandoffTransition} and {@link HandoffOperation}.
   */
  transitions?: HandoffTransition[];
}

/**
 * Input shape for a workflow node at creation time.
 * `id` is optional — if provided the backend uses it, otherwise a UUID is generated.
 * Providing an explicit `id` allows channels in the same CreateSpaceWorkflowParams
 * call to reference the node before it has been persisted.
 */
export interface WorkflowNodeInput {
  /** Optional pre-assigned node ID. Generated by backend when omitted. */
  id?: string;
  name: string;
  /**
   * Agents for parallel execution within this node. Must be non-empty.
   */
  agents: WorkflowNodeAgent[];
  /** Optional node-level post-approval route. See {@link WorkflowNode.postApproval}. */
  postApproval?: PostApprovalRoute;
  /** Declared outbound handoff transitions. See {@link WorkflowNode.transitions}. */
  transitions?: HandoffTransition[];
}

/**
 * Describes a post-approval route — a handoff from a node's approval
 * signal to a downstream executor that continues work **after** the task is
 * approved (e.g. merging a PR, publishing a release, running a verification
 * script). The route is declarative and usually lives on the workflow node; the
 * runtime routes the structured signal to `targetAgent` with a workflow-specific
 * `instructions` string that supports `{{identifier}}` template interpolation.
 * The runtime appends the universal `mark_complete` instruction separately.
 *
 * Added in PR 1 of the task-agent-as-post-approval-executor refactor. No
 * runtime consumer reads this field yet — PR 2 wires the
 * `PostApprovalRouter` and `mark_complete` tool. See
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §1.1 / §1.6.
 */
export interface PostApprovalRoute {
  /**
   * Name of the agent that should execute the post-approval action.
   *
   *   - `'task-agent'`                    — deliver to the orchestration Task Agent.
   *   - any `WorkflowNodeAgent.name` in  — deliver to the declared workflow
   *     this workflow's `nodes[*].agents`.
   *
   * The validator (`post-approval-validator.ts`) rejects unknown targets at
   * workflow create/update time and disables stale routes at load time.
   */
  targetAgent: string;
  /**
   * Workflow-specific instruction template delivered to `targetAgent` when the
   * end node signals approval. Supports `{{identifier}}` single-pass substitution
   * against the runtime context assembled by the PostApprovalRouter. See
   * `post-approval-template.ts` for the template grammar. Do not include the
   * final `mark_complete` instruction here; the runtime appends that for every
   * post-approval route.
   */
  instructions: string;
  /** Require the run's reviewed PR to be confirmed merged before mark_complete. */
  requirePrMerge?: boolean;
}

/**
 * Lightweight summary of a SpaceWorkflow for list views and payload-size-sensitive callers.
 * Excludes nodes, channels, gates, layout, and instructions.
 */
export interface SpaceWorkflowSummary {
  /** Unique identifier */
  id: string;
  /** Space this workflow belongs to */
  spaceId: string;
  /** Human-readable name */
  name: string;
  /** Optional description of what this workflow accomplishes */
  description?: string;
  /** Tags for organizational categorization */
  tags: string[];
  /** Name of the built-in template this workflow was created from or last synced to */
  templateName?: string;
  /** When true, the workflow is disabled and cannot be selected for new tasks */
  disabled?: boolean;
  /**
   * Short human-readable handle (e.g. 'coding-with-qa') used as an alternative
   * identifier for workflows within a space. Unique per space.
   */
  handle?: string;
  /** Number of nodes in the workflow graph */
  nodeCount: number;
  /**
   * Minimum space autonomy level at which `approve_task` is offered to end-node agents.
   * See `SpaceWorkflow.completionAutonomyLevel`.
   */
  completionAutonomyLevel: SpaceAutonomyLevel;
  /**
   * Hash of the canonical built-in template this workflow was derived from.
   * Used by drift detection to identify duplicate workflows that have diverged.
   */
  templateHash?: string | null;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * A named, reusable workflow definition within a Space.
 * Workflows are collaboration graphs: nodes are agent groups, channels are communication paths.
 * The SpaceRuntime executes workflows by creating SpaceWorkflowRun instances.
 */
export interface SpaceWorkflow {
  /** Unique identifier */
  id: string;
  /** Space this workflow belongs to */
  spaceId: string;
  /** Human-readable name */
  name: string;
  /** Optional description of what this workflow accomplishes */
  description?: string;
  /**
   * Workflow-level instructions injected into every agent session in this workflow.
   * Use this for context all agents need: project conventions, repo structure,
   * PR/branch naming rules, testing requirements, etc.
   *
   * Injection order: Space.instructions → Workflow.instructions → Agent.systemPrompt
   */
  instructions?: string;
  /** Nodes in the workflow graph */
  nodes: WorkflowNode[];
  /** ID of the node where execution begins */
  startNodeId: string;
  /**
   * ID of the node where execution ends.
   * When the end node's execution sets `task.reportedStatus`, the workflow run
   * is automatically marked `done`. If absent, completion relies on the
   * `CompletionDetector` all-agents-done check as a safety net.
   */
  endNodeId?: string;
  /**
   * Directed messaging channels between nodes in this workflow.
   * `from`/`to` reference node names (`WorkflowNode.name`).
   * Empty or absent means no messaging constraints (agents are fully isolated).
   */
  channels?: WorkflowChannel[];
  /**
   * Hook definitions for MCP action/runtime validation.
   * Persisted as JSON in the `hooks` column of `space_workflows`.
   */
  hooks?: WorkflowHook[];
  /**
   * Tags for organizational categorization.
   *
   * Primary workflow selection for standalone tasks is LLM-driven; tags are
   * exposed to the selector as context alongside the workflow name and
   * description. Two tag values are also recognized by the deterministic
   * fallback (used when the LLM selector is absent or declines to answer):
   *   - `default` — preferred fallback over any other workflow
   *   - `v2`      — preferred fallback over non-v2 workflows
   * Other tag values have no runtime meaning.
   */
  tags: string[];
  /** Visual editor node positions: maps node ID to {x, y} canvas coordinates */
  layout?: Record<string, { x: number; y: number }>;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
  /**
   * Minimum space autonomy level at which `approve_task` (agent-self-close) is
   * available to end-node agents. When `space.autonomyLevel < completionAutonomyLevel`,
   * end-node agents only see `submit_for_approval` (human review required).
   *
   * This is the workflow's threshold for auto-closing; it is independent of the
   * `requiredLevel` on individual gates and completion actions, which gate their
   * own execution steps. Required (no default) — set explicitly per workflow.
   */
  completionAutonomyLevel: SpaceAutonomyLevel;
  /**
   * Name of the built-in template this workflow was created from or last synced to.
   * `undefined` for user-created workflows not based on any template.
   */
  templateName?: string;
  /**
   * Canonical content hash of the template at the time of last sync.
   * Used to detect drift: if the current template's hash differs from this value,
   * the template has been updated (or the workflow has been modified) since last sync.
   * `undefined` when no template tracking is active.
   */
  templateHash?: string;
  /**
   * Legacy workflow-level post-approval route.
   *
   * New workflows should use `WorkflowNode.postApproval` so different completion
   * nodes can define different post-approval instructions. This field is kept as
   * a read/write fallback for persisted workflows that predate node-level routes.
   * See {@link PostApprovalRoute}.
   */
  postApproval?: PostApprovalRoute;
  /**
   * When true, the workflow is disabled and cannot be selected for new tasks.
   * Existing workflow runs continue unaffected.
   */
  disabled?: boolean;
  /**
   * Short human-readable handle (e.g. 'coding-with-qa') used as an alternative
   * identifier for workflows within a space. Unique per space. Auto-generated
   * from the workflow name via slugification when not explicitly provided.
   */
  handle?: string;
}

/**
 * Parameters for creating a new SpaceWorkflow
 */
export interface CreateSpaceWorkflowParams {
  spaceId: string;
  name: string;
  description?: string;
  instructions?: string;
  /**
   * Workflow nodes. Nodes may include an optional `id` field — if provided, the backend
   * uses it as the node's UUID so that `channels` in the same call can reference it.
   */
  nodes?: WorkflowNodeInput[];
  /**
   * ID of the node where execution begins.
   * Defaults to the first node in the `nodes` array when omitted.
   */
  startNodeId?: string;
  /**
   * ID of the node where execution ends.
   * When the end node's execution sets `task.reportedStatus`, the workflow run
   * auto-completes.
   */
  endNodeId?: string;
  /** Workflow-level messaging channels. */
  channels?: WorkflowChannel[];
  /** Hook definitions for MCP action/runtime validation. */
  hooks?: WorkflowHook[];
  /** Tags for organizational categorization (default: []). See `SpaceWorkflow.tags` for runtime semantics. */
  tags?: string[];
  /** Visual editor node positions: maps node ID to {x, y} canvas coordinates */
  layout?: Record<string, { x: number; y: number }>;
  /**
   * Minimum space autonomy level at which `approve_task` is offered to end-node
   * agents. See `SpaceWorkflow.completionAutonomyLevel`. Optional here so the
   * caller (builder, importer, template seeder) can omit it when the repository
   * layer supplies an explicit value.
   */
  completionAutonomyLevel?: SpaceAutonomyLevel;
  /**
   * Name of the built-in template this workflow is being created from.
   * When set, `templateHash` must also be provided.
   */
  templateName?: string;
  /**
   * Canonical content hash of the built-in template at creation time.
   * Stored for future drift detection.
   */
  templateHash?: string;
  /**
   * Legacy workflow-level post-approval route. New callers should set
   * `WorkflowNodeInput.postApproval` instead.
   */
  postApproval?: PostApprovalRoute;
  /** When true, create the workflow as disabled. */
  disabled?: boolean;
  /**
   * Optional explicit handle. When omitted, the backend auto-generates one
   * from the workflow name via slugification.
   */
  handle?: string;
}

/**
 * Parameters for updating an existing SpaceWorkflow.
 * All fields are optional — only provided fields are updated.
 *
 * For array fields (`nodes`, `channels`, `tags`):
 * - Pass a new array to replace the entire collection.
 * - Pass `null` to explicitly clear the field to an empty collection.
 * - Pass `[]` to clear all entries (equivalent to null for arrays).
 */
export interface UpdateSpaceWorkflowParams {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  /**
   * Replaces the entire node list. Pass `[]` or `null` to clear all nodes.
   */
  nodes?: WorkflowNode[] | null;
  /**
   * Updates the workflow entry point. Pass `null` to reset to first node.
   */
  startNodeId?: string | null;
  /**
   * Updates the workflow end node. Pass `null` to reset to the last node.
   */
  endNodeId?: string | null;
  /**
   * Replaces the channel list. Pass `[]` or `null` to clear all channels.
   */
  channels?: WorkflowChannel[] | null;
  /**
   * Replaces the hook list. Pass `[]` or `null` to clear all hooks.
   */
  hooks?: WorkflowHook[] | null;
  /**
   * Replaces the tag list. Pass `[]` or `null` to clear all tags.
   * See `SpaceWorkflow.tags` for runtime semantics (used by the deterministic fallback selector).
   */
  tags?: string[] | null;
  /** Visual editor node positions. Pass `null` to clear. */
  layout?: Record<string, { x: number; y: number }> | null;
  /**
   * Updates the workflow's `completionAutonomyLevel` (minimum space autonomy
   * level at which `approve_task` is offered on end-node agents). See
   * `SpaceWorkflow.completionAutonomyLevel`.
   */
  completionAutonomyLevel?: SpaceAutonomyLevel;
  /** Update template tracking (used when syncing from a template). */
  templateName?: string | null;
  templateHash?: string | null;
  /**
   * Update the legacy workflow-level post-approval route. Pass `null` to clear.
   * New callers should set `WorkflowNode.postApproval` through `nodes`.
   */
  postApproval?: PostApprovalRoute | null;
  /** Pass true/false to enable or disable the workflow. Pass null to leave unchanged. */
  disabled?: boolean | null;
  /**
   * Update the workflow's handle. Pass null to clear. Pass undefined to leave unchanged.
   */
  handle?: string | null;
}

/**
 * A single workflow row that participates in a duplicate-drift group.
 * Part of {@link DuplicateDriftReport}.
 */
export interface DuplicateDriftRow {
  /** Workflow UUID. */
  id: string;
  /** Canonical content hash at last sync. May be null for legacy rows. */
  templateHash: string | null;
  /** Creation timestamp (ms since epoch). Newest-first ordering is used for resync. */
  createdAt: number;
}

/**
 * One drift group surfaced by `spaceWorkflow.detectDuplicateDrift`.
 *
 * A drift group is formed by multiple workflow rows in the same space that
 * share a `templateName` but carry differing `templateHash` values. These
 * rows represent template drift — either duplicate seed passes left stale
 * versions behind, or the source built-in template changed after some rows
 * were seeded but before others were re-synced.
 */
export interface DuplicateDriftReport {
  /** Shared `templateName` for the group. Always non-empty. */
  templateName: string;
  /** Workflow rows in the group, newest-first. Always >= 2 entries. */
  rows: DuplicateDriftRow[];
}

// ============================================================================
// Export / Import Format Types (M8)
// ============================================================================

/**
 * A directed messaging channel in the portable export format.
 *
 * Differences from `WorkflowChannel`:
 * - `id` is stripped (regenerated on import)
 * - `from`/`to` use node names (portable across Space instances)
 */
export interface ExportedWorkflowChannel {
  /** Source node name */
  from: string;
  /** Target node name(s) */
  to: string | string[];
  maxCycles?: number;
  label?: string;
}

/**
 * A single agent entry within a multi-agent exported workflow node.
 * Mirrors `WorkflowNodeAgent` but uses a portable `agentRef` name instead of a UUID.
 */
export interface ExportedWorkflowNodeAgent {
  /** Name of the SpaceWorkerAgent (portable, not a UUID) */
  agentRef: string;
  /**
   * Unique identifier for this agent slot within the node.
   * Must be unique across all agents in the same exported node.
   * Mirrors `WorkflowNodeAgent.name`.
   */
  name: string;
  /** Optional model override for this agent slot. */
  model?: string;
  /** Optional thinking-level override for this agent slot. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Optional system-prompt override for this agent slot.
   * Accepts both plain strings (legacy export format) and `{ mode, value }` objects.
   * Plain strings are normalized to `{ mode: 'override', value }` during import.
   */
  systemPrompt?: WorkflowNodeAgentOverride | string;
  /**
   * Mirrors `WorkflowNodeAgent.replaceAgentPrompt`. When true, the slot's
   * `systemPrompt` REPLACES the agent's base prompt instead of appending to it.
   * Preserved through export/import round-trip.
   */
  replaceAgentPrompt?: boolean;
  /**
   * Optional instructions override for this agent slot.
   * Accepts both plain strings (legacy export format) and `{ mode, value }` objects.
   * Plain strings are normalized to `{ mode: 'override', value }` during import.
   */
  instructions?: WorkflowNodeAgentOverride | string;
  /**
   * IDs of globally-enabled skills to disable for this agent slot.
   * Preserved through export/import round-trip.
   */
  disabledSkillIds?: string[];
  /**
   * Extra MCP servers to add for this agent slot.
   * Typed loosely as `Record<string, unknown>` because this is an export/import
   * format — the Zod schema validates the shape at parse time for forward-compatibility,
   * and the data is cast to `McpServerConfig` only at runtime use.
   */
  extraMcpServers?: Record<string, unknown>;
  /**
   * Optional per-slot timeout (milliseconds) for runtime auto-completion of
   * stuck-but-alive agents. Mirrors `WorkflowNodeAgent.timeoutMs`. When unset,
   * the runtime applies its `DEFAULT_NODE_TIMEOUT_MS` default.
   *
   * Must be a positive integer when present.
   */
  timeoutMs?: number;
  /**
   * Declarative tool guards to carry through export/import round-trips.
   * Mirrors `WorkflowNodeAgent.toolGuards`.
   */
  toolGuards?: DeclarativeToolGuard[];
  /**
   * Static external event subscriptions for this exported agent slot.
   * Mirrors `WorkflowNodeAgent.eventInterests`.
   */
  eventInterests?: EventInterest[];
  /**
   * Per-slot fresh-context flag. Mirrors `WorkflowNodeAgent.resetContextPerTurn`.
   * Preserved through export/import round-trip.
   */
  resetContextPerTurn?: boolean;
}

/**
 * A declarative outbound handoff transition in the portable export format.
 * Mirrors {@link HandoffTransition}. Uses node/agent names (already portable
 * in the export) for `target`. `hookId` is checked against the exported
 * `hooks` list on import; a `hookId` whose hook was filtered out is stripped
 * at the export/import boundary so no dangling reference survives.
 */
export interface ExportedHandoffTransition {
  id: string;
  label?: string;
  target: string;
  hookId?: string;
  maxCycles?: number;
}

/**
 * A single workflow node (graph node) in the exported format.
 *
 * Differences from `WorkflowNode`:
 * - `id` is stripped (space-specific, regenerated on import)
 * - `agents[]` entries have their `agentId` UUIDs replaced by `agentRef` names.
 * - `channels[]` have moved to `ExportedSpaceWorkflow.channels` (workflow-level).
 *
 * Node names are used as cross-references throughout the exported format
 * (in `ExportedSpaceWorkflow.startNode` / `endNode`).
 * Node names must therefore be unique within an exported workflow.
 */
export interface ExportedWorkflowNode {
  /**
   * Multiple agents for parallel execution.
   * `agentId` UUIDs are replaced with portable `agentRef` names.
   */
  agents: ExportedWorkflowNodeAgent[];
  /** Human-readable node name — used as the stable cross-reference key in the export */
  name: string;
  /** Optional node-level post-approval route. */
  postApproval?: PostApprovalRoute;
  /**
   * Declared outbound handoff transitions for this node.
   * Mirrors {@link WorkflowNode.transitions}. Preserved through round-trip.
   */
  transitions?: ExportedHandoffTransition[];
}

/**
 * A Space agent in the portable export format.
 * Space-specific fields (`id`, `spaceId`, `createdAt`, `updatedAt`) are stripped.
 */
export interface ExportedSpaceWorkerAgent {
  /** Format version (1, 2, or 3; v2 adds optional `topicFrom` on eventInterests; v3 adds node handoff transitions and workflow gates). */
  version: 1 | 2 | 3;
  /** Discriminator for the exported entity type */
  type: 'agent';
  /** Human-readable name */
  name: string;
  /** URL-safe handle used for @mentions and agent URLs */
  handle?: string;
  /** Optional description of this agent's specialization */
  description?: string;
  /** Model ID override */
  model?: string;
  /** Thinking-level override */
  thinkingLevel?: ThinkingLevel;
  /** Provider name override */
  provider?: string;
  /** System prompt — persona and constraints for this agent */
  systemPrompt?: string;
  /**
   * Default operating procedure — describes HOW the agent performs its work.
   * Mirrors `SpaceWorkerAgent.instructions`.
   */
  instructions?: string;
  /**
   * Explicit tool override list — any entry must be a name from KNOWN_TOOLS.
   * When absent, the agent inherits all SDK built-in tools on import.
   * Mirrors `SpaceWorkerAgent.tools`.
   */
  tools?: string[];
  /**
   * Setting sources override — which on-disk settings files this agent loads.
   * When absent, the agent inherits from its parent Space on import.
   * Mirrors `SpaceWorkerAgent.settingSources`.
   */
  settingSources?: import('./settings').SettingSource[];
}

/**
 * A Space workflow in the portable export format.
 * Space-specific fields (`id`, `spaceId`, `createdAt`, `updatedAt`) are stripped.
 * Node IDs are stripped; cross-references use node names.
 * Channel IDs are stripped; `from`/`to` use node/agent names.
 */
export interface ExportedSpaceWorkflow {
  /** Format version (1, 2, or 3; v2 adds optional `topicFrom` on eventInterests; v3 adds node handoff transitions and workflow gates). */
  version: 1 | 2 | 3;
  /** Discriminator for the exported entity type */
  type: 'workflow';
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Graph nodes — node order in this array is not significant */
  nodes: ExportedWorkflowNode[];
  /** Name of the node where execution begins */
  startNode: string;
  /**
   * Name of the node where execution ends (optional — mirrors `SpaceWorkflow.endNodeId`).
   * When present, the end node setting `task.reportedStatus` auto-completes the
   * workflow run.
   */
  endNode?: string;
  /** Tags for categorization */
  tags: string[];
  /** Workflow-level instructions injected into every agent session */
  instructions?: string;
  /**
   * Directed messaging channels. `from`/`to` use node names. Channel `id` is stripped.
   */
  channels?: ExportedWorkflowChannel[];
  /** Workflow hooks in portable form. Node references use node/agent slot names. */
  hooks?: WorkflowHook[];
  /**
   * Minimum autonomy level (1-5) required for end-node agents to self-close
   * the task via `approve_task`. Below this threshold, `approve_task` becomes
   * a no-op and the agent must use `submit_for_approval` to request human
   * review. Optional for backward compat with pre-Design-v2 exports.
   */
  completionAutonomyLevel?: SpaceAutonomyLevel;
  /** When true, the workflow is disabled and cannot be selected for new tasks. */
  disabled?: boolean;
  /**
   * Human-readable handle for workflow identification (alternative to UUID).
   * Optional for backward compatibility with pre-handle exports.
   */
  handle?: string;
}

/**
 * A bundle containing one or more exported agents and/or workflows.
 * The bundle is the top-level unit of the export/import file format.
 */
export interface SpaceExportBundle {
  /** Format version (1, 2, or 3; v2 adds optional `topicFrom` on eventInterests; v3 adds node handoff transitions and workflow gates). */
  version: 1 | 2 | 3;
  /** Discriminator for the top-level type */
  type: 'bundle';
  /** Human-readable bundle name */
  name: string;
  /** Optional description of the bundle's purpose */
  description?: string;
  /** Exported agents (may be empty) */
  agents: ExportedSpaceWorkerAgent[];
  /** Exported workflows (may be empty) */
  workflows: ExportedSpaceWorkflow[];
  /** Export timestamp (milliseconds since epoch) */
  exportedAt: number;
  /** Source Space identifier (name or workspace path) for informational purposes */
  exportedFrom?: string;
}

// ── Workflow Run Artifacts ──────────────────────────────────────────────────

/**
 * Artifact type label. After the generic-shapes migration this holds a value
 * from the closed `ArtifactShape` vocabulary (`link`, `commit_set`, `check`,
 * `metric`, `decision`, `note`). `save_artifact` validates against that set and
 * rejects unknown values; pre-shape legacy rows are backfilled to a shape by the
 * migration. The field keeps its `artifactType` name for DB/record compatibility.
 *
 * The UI renders by shape, with the optional `data.kind` semantic hint supplying
 * the icon/label. See `artifact-shapes.ts` for the vocabulary and contracts.
 */
export type ArtifactType = string;

/** A typed artifact produced by a workflow node execution. */
export interface WorkflowRunArtifact {
  id: string;
  runId: string;
  nodeId: string;
  /** Generic shape from the closed `ArtifactShape` vocabulary. */
  artifactType: ArtifactType;
  /** Identity key derived from shape + kind (see `deriveArtifactKey`). */
  artifactKey: string;
  /** Shape-specific structured payload; carries the optional `kind` hint. */
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ── Approval Records ──────────────────────────────────────────────────────

/** Structured record of a checkpoint approval decision. */
export interface ApprovalRecord {
  /** Who/what approved */
  source: SpaceApprovalSource;
  /** The autonomy level the checkpoint required */
  requiredLevel: SpaceAutonomyLevel;
  /** The space's autonomy level at the time of the decision */
  spaceLevel: SpaceAutonomyLevel;
  /** When the decision was made (milliseconds since epoch) */
  timestamp: number;
  /** Optional reason provided by the approver */
  reason?: string;
  /** True if the human chose to skip this action instead of approving */
  skipped?: boolean;
}

// ── Active-turn activity summary ──────────────────────────────────────────────
//
// The Space task view's running roster ("what is the agent doing right now?")
// summarises the *currently active* turn for each agent session. Historically
// the client derived the roster from the same compacted feed rows used by the
// minimal thread renderer — capped at the last 5 non-terminal renderable rows
// per turn — so long turns under-reported their activity. The server now
// computes the full chronological activity list per active turn via the
// `spaceTaskActiveTurn.byTask` LiveQuery; the client display cap is applied at
// render time.

/** A single chronological activity entry within an active turn. */
export type ActivityEntry =
  /** Assistant `tool_use` block — surfaces tool name + an input preview. */
  | {
      kind: 'tool_use';
      toolName: string;
      preview: string;
      ts: number;
      uuid: string;
      /** The tool_use block `id` — links this entry to a matching `task_notification` (by `tool_use_id`) so the roster can render the task's terminal status (✓/✗) without a separate system row. */
      toolUseId?: string;
    }
  /** Assistant `text` block (non-empty) — surfaces the assistant's text. */
  | { kind: 'text'; text: string; ts: number; uuid: string }
  /** Assistant `thinking` block (non-empty) — surfaces a thinking preview. */
  | { kind: 'thinking'; preview: string; ts: number; uuid: string }
  /** Real human user input (`type: 'user'`, `isReplay` falsy). */
  | { kind: 'user_message'; text: string; ts: number; uuid: string }
  /** Synthetic agent→agent / system handoff (`type: 'user'`, `isReplay: true`). */
  | { kind: 'agent_handoff'; text: string; ts: number; uuid: string }
  /** A configured hook run within the turn (hook_started/progress/response collapsed to the latest per hook_id). Surfaces hook name + event + terminal status so the roster can render a spinner then a check/X without a standalone system row. */
  | {
      kind: 'hook';
      hookName: string;
      hookEvent: string;
      status: 'running' | 'completed' | 'failed';
      summary?: string;
      ts: number;
      uuid: string;
    }
  /** SDK `system:api_retry` row — preserves retry visibility in the active roster. */
  | {
      kind: 'api_retry';
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorStatus: number | null;
      ts: number;
      uuid: string;
    };

/**
 * Per-(session, turn) summary of activity entries within an active (incomplete)
 * turn. Derived client-side from `spaceTaskActiveTurn.byTask` rows.
 *
 * The server only emits a summary for the highest turnIndex per session that
 * has not yet seen a terminal `result` row. Closed turns are excluded —
 * they are not "active" for the purposes of the running roster.
 */
export interface ActiveTurnSummary {
  /** Agent session id whose active turn this summary describes. */
  sessionId: string;
  /** Server-computed turn index (1-based, mirrors compact feed `turnIndex`). */
  turnIndex: number;
  /** All activity entries in the active turn, chronological order preserved. */
  entries: ActivityEntry[];
}
