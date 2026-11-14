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

export interface CronSchedule {
  expression: string;
  timezone: string;
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

export interface TaskRestriction {
  type: 'rate_limit' | 'usage_limit';
  limit: string;
  resetAt: number;
  sessionRole: 'worker' | 'leader';
  retryAfter?: number;
}

export type RuntimeState = 'running' | 'paused' | 'stopped';
