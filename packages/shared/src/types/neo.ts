export const MAX_CONCURRENT_GROUPS_LIMIT = 10;
export const MAX_REVIEW_ROUNDS_LIMIT = 20;

export type RoomStatus = 'active' | 'archived';

export interface WorkspacePath {
  path: string;
  description?: string;
}

export interface Room {
  id: string;
  name: string;
  allowedPaths: WorkspacePath[];
  defaultPath?: string;
  defaultModel?: string;
  allowedModels?: string[];
  sessionIds: string[];
  status: RoomStatus;
  background?: string;
  instructions?: string;
  config?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type GoalStatus = 'active' | 'needs_human' | 'completed' | 'archived';

export type GoalPriority = 'low' | 'normal' | 'high' | 'urgent';

export type MissionType = 'one_shot' | 'measurable' | 'recurring';

export type AutonomyLevel = 'supervised' | 'semi_autonomous';

export interface MissionMetric {
  name: string;
  target: number;
  current: number;
  unit?: string;
  direction?: 'increase' | 'decrease';
  baseline?: number;
}

export interface MetricHistoryEntry {
  metricName: string;
  value: number;
  recordedAt: number;
}

export interface CronSchedule {
  expression: string;
  timezone: string;
}

export type MissionExecutionStatus = 'running' | 'completed' | 'failed';

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

export interface RoomGoal {
  id: string;
  shortId?: string;
  roomId: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  progress: number;
  linkedTaskIds: string[];
  metrics?: Record<string, number>;
  planning_attempts?: number;
  goal_review_attempts?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  missionType?: MissionType;
  autonomyLevel?: AutonomyLevel;
  structuredMetrics?: MissionMetric[];
  schedule?: CronSchedule;
  schedulePaused?: boolean;
  nextRunAt?: number;
  maxConsecutiveFailures?: number;
  maxPlanningAttempts?: number;
  consecutiveFailures?: number;
  replanCount?: number;
}

export type Mission = RoomGoal;

export interface CreateRoomParams {
  name: string;
  background?: string;
  allowedPaths?: WorkspacePath[];
  defaultPath: string;
  defaultModel?: string;
  allowedModels?: string[];
}

export interface UpdateRoomParams {
  name?: string;
  allowedPaths?: WorkspacePath[];
  defaultPath?: string | null;
  defaultModel?: string | null;
  allowedModels?: string[];
  background?: string | null;
  instructions?: string | null;
  config?: Record<string, unknown>;
}

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

export interface TaskRestriction {
  type: 'rate_limit' | 'usage_limit';
  limit: string;
  resetAt: number;
  sessionRole: 'worker' | 'leader';
  retryAfter?: number;
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type TaskType = 'planning' | 'coding' | 'research' | 'design' | 'goal_review';

export type AgentType = 'coder' | 'general' | 'planner';

export interface NeoTask {
  id: string;
  shortId?: string;
  roomId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  taskType?: TaskType;
  assignedAgent?: AgentType;
  createdByTaskId?: string;
  progress?: number | null;
  currentStep?: string | null;
  result?: string | null;
  error?: string | null;
  dependsOn: string[];
  inputDraft?: string | null;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  archivedAt?: number | null;
  activeSession?: 'worker' | 'leader' | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prCreatedAt?: number | null;
  restrictions?: TaskRestriction | null;
  updatedAt: number;
}

export interface TaskFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  includeArchived?: boolean;
}

export interface CreateTaskParams {
  roomId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  dependsOn?: string[];
  taskType?: TaskType;
  assignedAgent?: AgentType;
  status?: TaskStatus;
  createdByTaskId?: string;
}

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
  activeSession?: 'worker' | 'leader' | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prCreatedAt?: number | null;
  inputDraft?: string | null;
  archivedAt?: number | null;
  restrictions?: TaskRestriction | null;
}

export interface SubagentConfig {
  model: string;
  provider?: string;
  type?: 'cli';
  modelId?: string;
  cliModel?: string;
  name?: string;
  description?: string;
}

export type RuntimeState = 'running' | 'paused' | 'stopped';

export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  lastActiveAt: number;
}

export interface TaskSummary {
  id: string;
  shortId?: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress?: number | null;
  currentStep?: string | null;
  dependsOn: string[];
  error?: string | null;
  activeSession?: 'worker' | 'leader' | null;
  prUrl?: string | null;
  prNumber?: number | null;
  updatedAt: number;
}

export interface RoomOverview {
  room: Room;
  sessions: SessionSummary[];
  runtimeState?: RuntimeState;
}

export interface RoomSkillOverride {
  skillId: string;
  roomId: string;
  enabled: boolean;
}
