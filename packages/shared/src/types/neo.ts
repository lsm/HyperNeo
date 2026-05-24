/**
 * Legacy Room compatibility types
 *
 * These shapes are retained so the daemon can open and read old databases that
 * still contain Room-era rows. They are intentionally not exported from the
 * shared package root; active product surfaces should use Space contracts.
 */

// ============================================================================
// Room Types
// ============================================================================

/** Maximum number of concurrent task groups allowed per room */
export const MAX_CONCURRENT_GROUPS_LIMIT = 10;
/** Maximum number of review round iterations allowed per room */
export const MAX_REVIEW_ROUNDS_LIMIT = 20;

/**
 * Room status
 */
export type RoomStatus = 'active' | 'archived';

/**
 * A workspace path with optional description
 */
export interface WorkspacePath {
  /** The filesystem path */
  path: string;
  /** Optional description of what's in this path */
  description?: string;
}

/**
 * A conceptual workspace for organizing work
 * Rooms are long-running work dimensions that can span multiple sessions and workspaces
 *
 * @deprecated Legacy Room compatibility type retained for preserved database rows.
 * Use Space contracts for active product code.
 */
export interface Room {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Allowed workspace paths for this room (multi-path support) */
  allowedPaths: WorkspacePath[];
  /** Default workspace path for new sessions (must be in allowedPaths) */
  defaultPath?: string;
  /** Default model for sessions created in this room */
  defaultModel?: string;
  /** Allowed models for this room (empty/undefined = all models allowed) */
  allowedModels?: string[];
  /** IDs of sessions associated with this room */
  sessionIds: string[];
  /** Current status of the room */
  status: RoomStatus;
  /** Background context for the room - describes project, goals, constraints */
  background?: string;
  /** Custom instructions for how the room agent should behave */
  instructions?: string;
  /** Runtime configuration (maxConcurrentGroups, taskTimeout, etc.) */
  config?: Record<string, unknown>;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Room goal status
 */
export type GoalStatus = 'active' | 'needs_human' | 'completed' | 'archived';

/**
 * Room goal priority
 */
export type GoalPriority = 'low' | 'normal' | 'high' | 'urgent';

// ============================================================================
// Mission Types (Goal V2)
// ============================================================================

/**
 * Mission type — determines execution model for a goal
 */
export type MissionType = 'one_shot' | 'measurable' | 'recurring';

/**
 * Autonomy level — determines how much human oversight is required
 */
export type AutonomyLevel = 'supervised' | 'semi_autonomous';

/**
 * A structured metric tracked by a measurable mission
 */
export interface MissionMetric {
  name: string;
  target: number;
  current: number;
  unit?: string;
  /** Direction of improvement (default: 'increase') */
  direction?: 'increase' | 'decrease';
  /** Baseline value (required for 'decrease' direction) */
  baseline?: number;
}

/**
 * A single metric history data point
 */
export interface MetricHistoryEntry {
  metricName: string;
  value: number;
  /** Unix timestamp (seconds) */
  recordedAt: number;
}

/**
 * Cron schedule definition for recurring missions
 * nextRunAt is stored as a dedicated column on RoomGoal, not inside this JSON
 */
export interface CronSchedule {
  expression: string;
  timezone: string;
}

/**
 * Status of a mission execution run
 */
export type MissionExecutionStatus = 'running' | 'completed' | 'failed';

/**
 * A single execution run for a recurring or one-shot mission
 */
export interface MissionExecution {
  id: string;
  goalId: string;
  executionNumber: number;
  startedAt: number;
  completedAt?: number;
  status: MissionExecutionStatus;
  resultSummary?: string;
  taskIds: string[];
  planningAttempts: number;
}

/**
 * A structured objective for a room
 * Goals track progress via linked tasks
 *
 * @deprecated Legacy Room compatibility type retained for preserved database rows.
 * Use Space task/workflow contracts for active product code.
 */
export interface RoomGoal {
  /** Unique identifier */
  id: string;
  /** Human-readable short ID (e.g. 'g-42'), scoped to parent room */
  shortId?: string;
  /** Room this goal belongs to */
  roomId: string;
  /** Goal title */
  title: string;
  /** Detailed description */
  description: string;
  /** Current status */
  status: GoalStatus;
  /** Priority level */
  priority: GoalPriority;
  /** Progress percentage (0-100), aggregated from linked tasks */
  progress: number;
  /** IDs of tasks contributing to this goal */
  linkedTaskIds: string[];
  /** Custom progress metrics */
  metrics?: Record<string, number>;
  /** Number of planning attempts */
  planning_attempts?: number;
  /** Number of goal review attempts */
  goal_review_attempts?: number;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
  /** Completion timestamp (milliseconds since epoch) */
  completedAt?: number;
  // --- Mission V2 fields ---
  /** Mission execution model (default: 'one_shot') */
  missionType?: MissionType;
  /** Autonomy level for this mission (default: 'supervised') */
  autonomyLevel?: AutonomyLevel;
  /** Structured KPI metrics for measurable missions */
  structuredMetrics?: MissionMetric[];
  /** Cron schedule for recurring missions */
  schedule?: CronSchedule;
  /** Whether the recurring schedule is paused */
  schedulePaused?: boolean;
  /** Unix timestamp (seconds) of next scheduled run */
  nextRunAt?: number;
  /** Max consecutive failures before escalating to human */
  maxConsecutiveFailures?: number;
  /** Max planning attempts override (takes precedence over room config) */
  maxPlanningAttempts?: number;
  /** Current count of consecutive failures */
  consecutiveFailures?: number;
  /** Lifetime replan counter (distinct from per-execution planning_attempts) */
  replanCount?: number;
}

/**
 * Type alias for the UI and type layer — RoomGoal is the canonical type
 */
export type Mission = RoomGoal;

/**
 * Parameters for creating a new room
 *
 * @deprecated Legacy Room compatibility type retained for preserved database rows.
 * New code must not create Room records.
 */
export interface CreateRoomParams {
  name: string;
  /** Background context for the room - describes project, goals, constraints */
  background?: string;
  /** Workspace paths that can be accessed in this room */
  allowedPaths?: WorkspacePath[];
  /** Default workspace path for new sessions (required; must be an absolute path) */
  defaultPath: string;
  /** Default model for new sessions */
  defaultModel?: string;
  /** Allowed models for this room (empty/undefined = all models allowed) */
  allowedModels?: string[];
}

/**
 * Parameters for updating a room
 *
 * @deprecated Legacy Room compatibility type retained for preserved database rows.
 * New code must not update Room records.
 */
export interface UpdateRoomParams {
  name?: string;
  allowedPaths?: WorkspacePath[];
  defaultPath?: string | null;
  defaultModel?: string | null;
  /** Allowed models for this room (empty/undefined = all models allowed) */
  allowedModels?: string[];
  /** Background context for the room */
  background?: string | null;
  /** Custom instructions for the room agent */
  instructions?: string | null;
  /** Runtime configuration (reviewers, maxReviewRounds, etc.) */
  config?: Record<string, unknown>;
}

// ============================================================================
// Neo Task Types
// ============================================================================

/**
 * Task status
 */
export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'needs_attention'
  | 'cancelled'
  | 'archived'
  | 'rate_limited'
  | 'usage_limited';

/**
 * Restriction data for a task that has hit an API rate or usage limit.
 * Persisted on the task record so the UI can show reset time and the runtime
 * can auto-resume without manual intervention.
 */
export interface TaskRestriction {
  /** Type of limit that was hit */
  type: 'rate_limit' | 'usage_limit';
  /** Human-readable description of the limit (e.g. "100 req/min", "daily cap") */
  limit: string;
  /** Unix timestamp (ms) when the limit resets */
  resetAt: number;
  /** Which session hit the limit */
  sessionRole: 'worker' | 'leader';
  /** Seconds until retryable (for rate limits with explicit retry-after) */
  retryAfter?: number;
}

/**
 * Task priority
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Task type — determines which agent preset and tools are used
 */
export type TaskType = 'planning' | 'coding' | 'research' | 'design' | 'goal_review';

/**
 * Agent type that should execute a task.
 * 'planner' is used for goal review and planning-type tasks assigned to the Planner/Leader agent.
 */
export type AgentType = 'coder' | 'general' | 'planner';

/**
 * A task managed within a room
 *
 * @deprecated Legacy Room compatibility type retained for preserved database rows.
 * Use SpaceTask for active product code.
 */
export interface NeoTask {
  /** Unique identifier */
  id: string;
  /** Human-readable short ID (e.g. 't-42'), scoped to parent room */
  shortId?: string;
  /** Room this task belongs to */
  roomId: string;
  /** Task title */
  title: string;
  /** Detailed description */
  description: string;
  /** Current status */
  status: TaskStatus;
  /** Priority level */
  priority: TaskPriority;
  /** Task type — determines agent preset (default: 'coding') */
  taskType?: TaskType;
  /** Which agent type should execute this task (default: 'coder') */
  assignedAgent?: AgentType;
  /** ID of the planning task that created this task (for draft→pending promotion) */
  createdByTaskId?: string;
  /** Progress percentage (0-100) */
  progress?: number | null;
  /** Description of current step */
  currentStep?: string | null;
  /** Result of completed task */
  result?: string | null;
  /** Error message for failed task */
  error?: string | null;
  /** IDs of tasks this task depends on */
  dependsOn: string[];
  /** Draft input text for the human input area (persisted server-side) */
  inputDraft?: string | null;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Start timestamp (milliseconds since epoch) */
  startedAt?: number;
  /** Completion timestamp (milliseconds since epoch) */
  completedAt?: number;
  /** Archive timestamp (milliseconds since epoch) - derived from status='archived' */
  archivedAt?: number | null;
  /**
   * Which agent session is currently active (generating output).
   * Set when a human message is injected; cleared when the session reaches terminal state.
   * Allows the UI to show a "working" indicator even when status is 'review'.
   */
  activeSession?: 'worker' | 'leader' | null;
  /** Pull request URL (when task has associated PR) */
  prUrl?: string | null;
  /** Pull request number (extracted from URL for display) */
  prNumber?: number | null;
  /** When PR was created/submitted (milliseconds since epoch) */
  prCreatedAt?: number | null;
  /**
   * Active restriction when task is paused due to a rate or usage limit.
   * Cleared when the task resumes after the restriction expires.
   */
  restrictions?: TaskRestriction | null;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Filter options for querying tasks
 */
export interface TaskFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  /** Include archived tasks in results (default: false - archived tasks are hidden) */
  includeArchived?: boolean;
}

/**
 * Parameters for creating a new task
 */
export interface CreateTaskParams {
  roomId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  dependsOn?: string[];
  /** Task type — defaults to 'coding' */
  taskType?: TaskType;
  /** Which agent type should execute this task (default: 'coder') */
  assignedAgent?: AgentType;
  /** Initial status — defaults to 'pending'. Use 'draft' for planning-created tasks. */
  status?: TaskStatus;
  /** ID of planning task that created this task (for draft→pending promotion) */
  createdByTaskId?: string;
}

/**
 * Parameters for updating a task
 */
export interface UpdateTaskParams {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  progress?: number | null;
  currentStep?: string | null;
  result?: string | null;
  error?: string | null;
  dependsOn?: string[];
  /** Which session is actively generating output. null clears the indicator. */
  activeSession?: 'worker' | 'leader' | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prCreatedAt?: number | null;
  inputDraft?: string | null;
  /** Timestamp when the task was archived. Set to null to clear when unarchiving. */
  archivedAt?: number | null;
  /**
   * Active restriction for rate/usage limited tasks. Set to null to clear restriction.
   */
  restrictions?: TaskRestriction | null;
}

// ============================================================================
// Sub-Agent Configuration Types
// ============================================================================

/**
 * Configuration for a sub-agent entry in room.config.agentSubagents.
 *
 * Used for leader reviewers (.leader[]), leader analysis helpers (.leaderHelpers[]),
 * and coder worker helpers (.worker[]). The runtime builder functions convert these
 * configs into AgentDefinition objects for the SDK.
 */
export interface SubagentConfig {
  /** Model ID (e.g., 'claude-haiku-4-5', 'claude-sonnet-4-6') or CLI agent short name */
  model: string;
  /** Provider name (e.g., 'anthropic', 'openai', 'google') */
  provider?: string;
  /** Marks this as CLI-based (external tool orchestrated via Bash) */
  type?: 'cli';
  /** Full model ID when different from the short name in 'model' */
  modelId?: string;
  /** Model the CLI tool should use internally (e.g., copilot --model gpt-5.3-codex) */
  cliModel?: string;
  /** Optional display name override for this sub-agent */
  name?: string;
  /** Optional description of what this sub-agent specializes in */
  description?: string;
}

// ============================================================================
// Runtime Types
// ============================================================================

/**
 * Runtime state for a room's autonomous execution engine
 */
export type RuntimeState = 'running' | 'paused' | 'stopped';

// ============================================================================
// Summary Types (for API responses)
// ============================================================================

/**
 * Summary of a session for room overview
 */
export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  lastActiveAt: number;
}

/**
 * Summary of a task for room overview
 */
export interface TaskSummary {
  id: string;
  /** Human-readable short ID (e.g. 't-42'), scoped to parent room */
  shortId?: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress?: number | null;
  /** Description of current step (for worker summary in review cards) */
  currentStep?: string | null;
  /** IDs of tasks this task depends on */
  dependsOn: string[];
  /** Error message for failed tasks */
  error?: string | null;
  /** Which session is actively generating output (see NeoTask.activeSession) */
  activeSession?: 'worker' | 'leader' | null;
  /** Pull request URL (if available) */
  prUrl?: string | null;
  /** Pull request number (if available) */
  prNumber?: number | null;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Overview of a room with related data
 */
export interface RoomOverview {
  room: Room;
  sessions: SessionSummary[];
  /** Current runtime state */
  runtimeState?: RuntimeState;
}

/**
 * Legacy per-room override for a skill's enabled state.
 * Preserved only for old `room_skill_overrides` rows.
 *
 * @deprecated Legacy Room compatibility type retained for preserved database rows.
 * Use SkillEnablementOverride for active runtime code.
 */
export interface RoomSkillOverride {
  skillId: string;
  roomId: string;
  enabled: boolean;
}
