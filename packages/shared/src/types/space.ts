/**
 * Space System Types
 *
 * Types for the Space multi-agent workflow system.
 * Spaces are distinct from Rooms — they are workspace-first, workflow-centric
 * contexts for orchestrating custom agents and automated pipelines.
 */

import type { ThinkingLevel } from '../types';
import type { SettingSource } from './settings';
import type { McpServerConfig } from './sdk-config';

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
 * The Task Agent is not a seeded SpaceAgent — it has no row in the `space_agents`
 * table. Its prompt is generated in code at `task-agent.ts`. This config allows
 * per-space customization of model and prompt additions without mutating code.
 */
export interface TaskAgentConfig {
	/** Model override for the Task Agent. Falls back to `space.defaultModel` then `DEFAULT_TASK_AGENT_MODEL`. */
	model?: string;
	/** Thinking-level override for the Task Agent. Falls back to the app default when unset. */
	thinkingLevel?: ThinkingLevel;
	/** Custom prompt additions appended after the contract sections (similar to SpaceAgent.customPrompt). */
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
	| 'archived';

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
	| 'gate_rejected'
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
	completedAt: number | null;
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
	 * - `gate`: paused at a gate requiring human approval
	 * - `task_completion`: paused awaiting human approval of a submit_for_approval request
	 */
	pendingCheckpointType: 'gate' | 'task_completion' | null;
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
	pendingCheckpointType?: 'gate' | 'task_completion' | null;
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
}

/**
 * Internal parameters for updating SpaceTask rows with system-owned linkage.
 */
export interface InternalUpdateSpaceTaskParams extends UpdateSpaceTaskParams {
	/** ID of the SpaceGoal this task is linked to; null to clear. */
	goalId?: string | null;
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
	/** ID of the SpaceAgent assigned to this slot; null when the agent has been deleted */
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
	/** Last update timestamp (milliseconds since epoch) */
	updatedAt: number;
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
}

// ============================================================================
// Space Workflow Run Types
// ============================================================================

/**
 * Status of a workflow run.
 *
 * - `pending`     — run created, awaiting Task Agent to start nodes
 * - `in_progress` — at least one node execution is active
 * - `done`        — end node set `task.reportedStatus` or all nodes completed
 * - `blocked`     — run requires human intervention (gate rejection, crash, etc.)
 * - `cancelled`   — run was cancelled before completion
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
// SpaceAgent Types (M2)
// ============================================================================

/**
 * A named agent configuration within a Space.
 * SpaceAgents can be referenced by name in SpaceWorkflow nodes.
 */
export interface SpaceAgent {
	/** Unique identifier */
	id: string;
	/** Space this agent belongs to */
	spaceId: string;
	/** Human-readable name (unique within a space) */
	name: string;
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
	 * Appended AFTER the NeoKai system contract in the prompt so the contract cannot be overridden.
	 * Null when not set.
	 */
	customPrompt: string | null;
	/**
	 * Tool list override — which tools this agent may use.
	 * Any entry must be a name from KNOWN_TOOLS.
	 * When unset, role-based defaults apply.
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
 * Parameters for creating a new SpaceAgent
 */
export interface CreateSpaceAgentParams {
	spaceId: string;
	name: string;
	description?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	provider?: string;
	/** Operator-supplied custom prompt appended after the NeoKai contract; null when not set */
	customPrompt?: string | null;
	/** Tool list override — any entry must be a name from KNOWN_TOOLS */
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
 * Parameters for updating a SpaceAgent
 */
export interface UpdateSpaceAgentParams {
	name?: string;
	description?: string | null;
	model?: string | null;
	thinkingLevel?: ThinkingLevel | null;
	provider?: string | null;
	/** Operator-supplied custom prompt; null clears */
	customPrompt?: string | null;
	/** Tool list override — null clears (reverts to role defaults) */
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
 * Single entry in an {@link AgentDriftReport}.
 *
 * Each entry corresponds to one preset-seeded `SpaceAgent` row in a space.
 * Rows for user-created agents (no `templateName`) are not included in the
 * report at all.
 */
export interface AgentDriftEntry {
	/** Agent UUID. */
	agentId: string;
	/** Human-readable agent name (matches `SpaceAgent.name`). */
	agentName: string;
	/** Preset template name this agent was seeded from. */
	templateName: string;
	/**
	 * Hash captured the last time this row was seeded or synced.
	 * Null when the row predates template tracking and the backfill
	 * migration could not match the row to a preset.
	 */
	storedHash: string | null;
	/** Hash of the current preset definition in code. */
	currentHash: string;
	/** True when {@link storedHash} differs from {@link currentHash}. */
	drifted: boolean;
}

/**
 * Returned by `spaceAgent.getDriftReport`. Lists all preset-seeded agents in
 * a space with the comparison between their stored fingerprint and the
 * current preset definition. Callers typically filter by `drifted === true`
 * to surface a UI badge / sync button.
 */
export interface AgentDriftReport {
	/** Space the report was generated for. */
	spaceId: string;
	/** Per-agent drift entries — one row per preset-tracked SpaceAgent. */
	agents: AgentDriftEntry[];
}

// ============================================================================
// Workflow Types (M3)
// ============================================================================

// ============================================================================
// Gate System — field-based schema
// ============================================================================

/** Field type determines what values are valid and what check ops are available. */
export type GateFieldType = 'boolean' | 'string' | 'number' | 'map';

/**
 * Check operation for scalar fields (boolean, string, number).
 *
 *   - `'=='`     — passes when `data[field] === value`
 *   - `'!='`     — passes when `data[field] !== value`
 *   - `'exists'` — passes when the field is present in data (not `undefined`)
 */
export interface GateFieldScalarCheck {
	op: '==' | '!=' | 'exists';
	value?: unknown;
}

/**
 * Check operation for map fields (counts matching entries).
 *
 *   - `op: 'count'` — counts entries whose value equals `match`, passes when count >= `min`
 *
 * Example: require 3 "approved" reviews in a votes map:
 *   `{ op: 'count', match: 'approved', min: 3 }`
 */
export interface GateFieldMapCheck {
	op: 'count';
	/** Value to match in map entries. */
	match: unknown;
	/** Minimum count required for this field to be satisfied. */
	min: number;
}

/** Union of check operations — scalar or map. */
export type GateFieldCheck = GateFieldScalarCheck | GateFieldMapCheck;

/**
 * A single declared field in the gate schema.
 *
 * Fields define what data the gate stores, who can write it, and what check
 * must pass for the field to be satisfied. A gate opens when ALL fields pass.
 */
export interface GateField {
	/** Field name (key in the gate data store). */
	name: string;
	/** Field type. */
	type: GateFieldType;
	/** Who can write this field — node names, '*' (any agent), or [] (external-only: human via RPC or auto-approval). */
	writers: string[];
	/** Check that must pass for this field to be satisfied. */
	check: GateFieldCheck;
}

/**
 * A Gate — a declared data store with typed fields. Opens when ALL fields pass.
 *
 * Gates are referenced by channels via `gateId`. A gate has no back-reference
 * to any channel — the same gate can guard multiple channels.
 *
 * Gate runtime data is a key-value store persisted per `(run_id, gate_id)` in
 * the `gate_data` SQLite table. Default data is computed from the field
 * declarations (empty map `{}` for 'map' type, nothing for others). Agents
 * write to gate data via `write_gate`; the runtime evaluates field checks
 * against current data to decide passage.
 */
export interface GateScript {
	/** Script interpreter: 'bash', 'node', or 'python3' */
	interpreter: 'bash' | 'node' | 'python3';
	/** Script source code to execute */
	source: string;
	/** Timeout in milliseconds (default: 30000) */
	timeoutMs?: number;
}

/**
 * Gate Poll — periodic script execution that injects messages into workflow
 * node sessions when script output changes.
 *
 * When a gate has `poll` defined, the runtime starts a timer at `intervalMs`
 * once the workflow run becomes `in_progress`. On each tick, the script is
 * executed in the same sandboxed environment as gate scripts, with additional
 * context variables (TASK_ID, PR_URL, etc.) injected as environment variables.
 *
 * If the script's stdout changes AND is non-empty, a message is injected into
 * the target node's agent session using `TaskAgentManager.injectSubSessionMessage()`.
 * The message is formatted using `messageTemplate` (default: raw output).
 *
 * Polling stops when the workflow run reaches a terminal state (`done`,
 * `cancelled`, or `blocked`).
 */
export interface GatePoll {
	/** Poll interval in milliseconds (minimum 10_000 / 10 seconds) */
	intervalMs: number;
	/**
	 * Script to execute periodically. Runs in a sandboxed environment using
	 * the same infrastructure as gate scripts (bash interpreter only).
	 * Context is provided via environment variables — never hardcoded.
	 *
	 * Available env vars: TASK_ID, TASK_TITLE, SPACE_ID, PR_URL, PR_NUMBER,
	 * REPO_OWNER, REPO_NAME, WORKFLOW_RUN_ID
	 */
	script: string;
	/**
	 * Which side of the gate's channel to inject the message into.
	 * - `'from'` — inject into the source node's agent session
	 * - `'to'` — inject into the target node's agent session
	 */
	target: 'from' | 'to';
	/**
	 * Optional template wrapping script output. Use `{{output}}` as placeholder.
	 * When omitted, the raw script stdout is used as the message body.
	 *
	 * Example: `"New PR review comment:\n{{output}}"`
	 */
	messageTemplate?: string;
}

export interface Gate {
	/** Unique identifier */
	id: string;
	/** Human-readable description of what this gate checks. */
	description?: string;
	/** Custom label displayed on the gate badge in the workflow editor. */
	label?: string;
	/** Custom badge color (hex format `#rrggbb`). */
	color?: string;
	/** Declared fields with schema, permissions, and checks. */
	fields?: GateField[];
	/** Optional script-based pre-check executed before field evaluation. */
	script?: GateScript;
	/**
	 * When true, gate data is reset to defaults on cyclic channel traversal.
	 * Used for cyclic workflows where gate state should be cleared each loop.
	 */
	resetOnCycle: boolean;
	/**
	 * Minimum space autonomy level required to auto-approve this gate.
	 * When `space.autonomyLevel >= requiredLevel`, the gate is auto-approved after
	 * validation (script + fields) passes. When below, the gate blocks for human sign-off.
	 * Undefined = no approval needed beyond validation.
	 */
	requiredLevel?: SpaceAutonomyLevel;
	/**
	 * Optional poll configuration for periodic script execution and message injection.
	 * When defined, the runtime starts a timer that executes the script at the
	 * specified interval and injects messages into the target node when output changes.
	 * Undefined = no polling (default, backward compatible).
	 */
	poll?: GatePoll;
}

/**
 * Compute default data for a gate from its field declarations.
 * Map fields get `{}`, others get nothing (no key in defaults).
 */
export function computeGateDefaults(fields?: GateField[]): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};
	for (const field of fields ?? []) {
		if (field.type === 'map') {
			defaults[field.name] = {};
		}
	}
	return defaults;
}

/**
 * A Channel — a simple unidirectional pipe between agents in a workflow.
 *
 * Channels define messaging topology. A channel without a `gateId` is always open.
 * When `gateId` is set, the channel is gated — messages are held until the
 * referenced Gate's condition passes.
 *
 * This is the separated Channel type (M1.1). Uses `gateId` to reference Gate
 * entities rather than inlining gate conditions.
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
	 * Optional reference to a Gate entity. When absent, the channel is always open.
	 * When present, message delivery is blocked until the gate's condition passes.
	 */
	gateId?: string;
	/**
	 * Maximum number of times this channel may be traversed in a single workflow run
	 * before delivery is blocked. Only meaningful for backward (cyclic) channels —
	 * cyclicity is inferred from graph topology, not stored.
	 * Defaults to 5 at runtime when the channel is cyclic and this field is absent.
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
	 * Examples: 'github/owner/repo/pull_request.*', 'github/owner/repo/pull_request.review_*'
	 *
	 * The topic pattern IS the filter — the format encodes source identity,
	 * scope (e.g. owner/repo for GitHub), resource, and entity/action.
	 */
	topic: string;

	/**
	 * Optional label for diagnostics. Not used in matching logic.
	 * Example: 'PR review comments', 'CI failures'
	 */
	label?: string;
}

/**
 * A single agent entry within a multi-agent workflow node.
 * References a SpaceAgent by ID with an optional per-slot configuration override.
 */
export interface WorkflowNodeAgent {
	/** ID of the SpaceAgent assigned to this slot */
	agentId: string;
	/**
	 * Agent slot label — must be unique within the node.
	 * Derived from the SpaceAgent name. When the same agent is added to a node
	 * multiple times, a numeric suffix is appended (e.g. `"Reviewer"` → `"Reviewer-2"`).
	 * Used for gate `writers` lists and `node_executions.agent_name`.
	 */
	name: string;
	/**
	 * Optional model override for this agent slot.
	 * When absent, the assigned SpaceAgent model is used.
	 */
	model?: string;
	/**
	 * Optional thinking-level override for this agent slot.
	 * When absent, the assigned SpaceAgent thinking level is used.
	 */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Optional custom-prompt expansion for this agent slot.
	 * Always appended to the agent's `customPrompt` (never replaces it).
	 * Use this to add node-specific context or role focus on top of the agent's base prompt.
	 */
	customPrompt?: WorkflowNodeAgentOverride;
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
	 * Dynamic runtime subscriptions are managed through node-agent MCP tools.
	 */
	eventInterests?: Array<{ topic: string; label?: string }>;
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
	 * Maximum number of times this channel may be traversed in a single workflow run
	 * before delivery is blocked. Only meaningful for back-channels (cyclic edges).
	 * Defaults to 5 at runtime when the channel is cyclic and this field is absent.
	 */
	maxCycles?: number;
	/** Optional human-readable label for display in the visual editor */
	label?: string;
	/**
	 * Optional reference to a Gate entity in `SpaceWorkflow.gates`.
	 * When set, delivery is blocked until the gate's condition passes.
	 * Each gate belongs to exactly one channel.
	 */
	gateId?: string;
}

/**
 * A single node in the workflow graph.
 * Nodes run one or more agents (in parallel when multiple are specified).
 * Nodes are connected by WorkflowChannels.
 *
 * All agents are specified via `agents: WorkflowNodeAgent[]` — there is no
 * single-agent `agentId` shorthand. `agents` must be non-empty.
 */
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
	 * Gate definitions for this workflow.
	 * Gates are independent entities referenced by channels via `gateId`.
	 * Persisted as JSON in the `gates` column of `space_workflows`.
	 */
	gates?: Gate[];
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
	/** Gate definitions for this workflow. */
	gates?: Gate[];
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
	 * Replaces the gate list. Pass `[]` or `null` to clear all gates.
	 */
	gates?: Gate[] | null;
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
	gateId?: string;
}

/**
 * A single agent entry within a multi-agent exported workflow node.
 * Mirrors `WorkflowNodeAgent` but uses a portable `agentRef` name instead of a UUID.
 */
export interface ExportedWorkflowNodeAgent {
	/** Name of the SpaceAgent (portable, not a UUID) */
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
}

/**
 * A Space agent in the portable export format.
 * Space-specific fields (`id`, `spaceId`, `createdAt`, `updatedAt`) are stripped.
 */
export interface ExportedSpaceAgent {
	/** Format version — always 1 for this revision */
	version: 1;
	/** Discriminator for the exported entity type */
	type: 'agent';
	/** Human-readable name */
	name: string;
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
	 * Mirrors `SpaceAgent.instructions`.
	 */
	instructions?: string;
	/**
	 * Tool name overrides — list of tool names from KNOWN_TOOLS this agent may use.
	 * When absent, defaults apply on import.
	 * Mirrors `SpaceAgent.tools`.
	 */
	tools?: string[];
	/**
	 * Setting sources override — which on-disk settings files this agent loads.
	 * When absent, the agent inherits from its parent Space on import.
	 * Mirrors `SpaceAgent.settingSources`.
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
	/** Format version — always 1 for this revision */
	version: 1;
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
	/** Format version — always 1 for this revision */
	version: 1;
	/** Discriminator for the top-level type */
	type: 'bundle';
	/** Human-readable bundle name */
	name: string;
	/** Optional description of the bundle's purpose */
	description?: string;
	/** Exported agents (may be empty) */
	agents: ExportedSpaceAgent[];
	/** Exported workflows (may be empty) */
	workflows: ExportedSpaceWorkflow[];
	/** Export timestamp (milliseconds since epoch) */
	exportedAt: number;
	/** Source Space identifier (name or workspace path) for informational purposes */
	exportedFrom?: string;
}

// ── Workflow Run Artifacts ──────────────────────────────────────────────────

/**
 * Artifact type label — a generic string tag agents use to categorise their
 * output (e.g. 'pr', 'result', 'progress', 'review').  The UI renders
 * artifacts based on the **shape of `data`**, not this string, so no fixed
 * enum is needed.  The type is still displayed as a badge on each artifact
 * card for human scanning.
 */
export type ArtifactType = string;

/** A typed artifact produced by a workflow node execution. */
export interface WorkflowRunArtifact {
	id: string;
	runId: string;
	nodeId: string;
	artifactType: ArtifactType;
	artifactKey: string;
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
	| { kind: 'tool_use'; toolName: string; preview: string; ts: number; uuid: string }
	/** Assistant `text` block (non-empty) — surfaces the assistant's text. */
	| { kind: 'text'; text: string; ts: number; uuid: string }
	/** Assistant `thinking` block (non-empty) — surfaces a thinking preview. */
	| { kind: 'thinking'; preview: string; ts: number; uuid: string }
	/** Real human user input (`type: 'user'`, `isReplay` falsy). */
	| { kind: 'user_message'; text: string; ts: number; uuid: string }
	/** Synthetic agent→agent / system handoff (`type: 'user'`, `isReplay: true`). */
	| { kind: 'agent_handoff'; text: string; ts: number; uuid: string };

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
