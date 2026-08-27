import type { ThinkingLevel } from '../types.ts';
import type { TaskRestriction } from './neo.ts';
import type { McpServerConfig } from './sdk-config.ts';
import type { SettingSource } from './settings.ts';

export type SpaceStatus = 'active' | 'archived';

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

export type SpaceGoalOwnerAgentState = 'active' | 'missing' | 'paused' | 'disabled' | 'archived';

export interface SpaceGoalOwnerCandidate {
  agentId: string;
  relationship: SpaceLongHorizonAgentRelationship;
  createdAt: number;
}

export type SpaceGoalOwnerResolution =
  | {
      action: 'resolved';
      owner: SpaceGoalOwnerCandidate;
      conflicts: SpaceGoalOwnerCandidate[];
    }
  | {
      action: 'degraded';
      reason: SpaceGoalOwnerAgentState;
      owner: SpaceGoalOwnerCandidate;
      conflicts: SpaceGoalOwnerCandidate[];
    }
  | { action: 'coordinator_fallback'; coordinatorAgentId: string }
  | { action: 'no_recipient' };

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
export const MAX_SPACE_CONCURRENT_TASKS = 20;

export type SpaceApprovalSource = 'human' | 'auto_policy' | 'agent';

export interface SpaceConfig {
  maxConcurrentTasks?: number;
  taskTimeoutMs?: number;
}

export interface TaskAgentConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  customPrompt?: string;
  settingSources?: SettingSource[];
}

export interface Space {
  id: string;
  slug: string;
  workspacePath: string;
  name: string;
  description: string;
  backgroundContext: string;
  instructions: string;
  defaultModel?: string;
  allowedModels?: string[];
  sessionIds: string[];
  status: SpaceStatus;
  paused: boolean;
  stopped: boolean;
  autonomyLevel?: SpaceAutonomyLevel;
  maxConcurrentTasks: number;
  config?: SpaceConfig;
  taskAgentConfig?: TaskAgentConfig;
  settingSources?: SettingSource[];
  createdAt: number;
  updatedAt: number;
}

export interface SpaceCreateResult extends Space {
  seedWarnings?: string[];
}

export interface CreateSpaceParams {
  workspacePath: string;
  name: string;
  additionalWorkspaces?: { path: string; label?: string }[];
  description?: string;
  backgroundContext?: string;
  instructions?: string;
  defaultModel?: string;
  allowedModels?: string[];
  autonomyLevel?: SpaceAutonomyLevel;
  maxConcurrentTasks?: number;
  config?: SpaceConfig;
  taskAgentConfig?: TaskAgentConfig;
  settingSources?: SettingSource[] | null;
}

export interface UpdateSpaceParams {
  name?: string;
  description?: string;
  backgroundContext?: string;
  instructions?: string;
  defaultModel?: string | null;
  allowedModels?: string[];
  autonomyLevel?: SpaceAutonomyLevel;
  maxConcurrentTasks?: number;
  config?: SpaceConfig;
  taskAgentConfig?: TaskAgentConfig | null;
  settingSources?: SettingSource[] | null;
}

export interface SpaceWorkspace {
  id: string;
  spaceId: string;
  path: string;
  label: string;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceWorkspaceAddParams {
  spaceId: string;
  path: string;
  label?: string;
}

export interface SpaceWorkspaceRemoveParams {
  spaceId: string;
  workspaceId: string;
}

export interface SpaceWorkspaceUpdateLabelParams {
  spaceId: string;
  workspaceId: string;
  label: string;
}

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
  | 'usage_limited'
  | 'stopped';

export type SpaceReportedStatus = 'done' | 'blocked' | 'cancelled';

export type SpaceBlockReason =
  | 'agent_crashed'
  | 'workflow_invalid'
  | 'execution_failed'
  | 'human_input_requested'
  | 'dependency_failed'
  | 'dependency_added';

export type SpaceTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

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
  workspacePath?: string | null;
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
  workspacePath?: string | null;
  revision: number;
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
  workspacePath?: string | null;
  triggerImmediately?: boolean;
  primaryOwnerAgentId?: string | null;
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
  checkInCronExpression?: string | null;
  checkInTimezone?: string;
  workspacePath?: string | null;
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

export type TaskScheduleTriggerType = 'cron' | 'at';

export type TaskScheduleStatus = 'active' | 'paused' | 'completed';

export interface TaskSchedule {
  id: string;
  spaceId: string;
  title: string;
  description: string;
  priority: SpaceTaskPriority;
  preferredWorkflowId: string | null;
  labels: string[];
  metadata: Record<string, unknown>;
  triggerType: TaskScheduleTriggerType;
  cronExpression: string | null;
  runAt: number | null;
  timezone: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastCreatedTaskId: string | null;
  pendingJobId: string | null;
  status: TaskScheduleStatus;
  createdByAgent: string | null;
  createdBySession: string | null;
  createdAt: number;
  goalId?: string | null;
  updatedAt: number;
}

export type SpaceTaskActivityState =
  | 'active'
  | 'queued'
  | 'idle'
  | 'cooldown'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface SpaceTask {
  id: string;
  spaceId: string;
  taskNumber: number;
  title: string;
  description: string;
  status: SpaceTaskStatus;
  priority: SpaceTaskPriority;
  labels: string[];
  dependsOn: string[];
  result: string | null;
  workflowRunId?: string | null;
  preferredWorkflowId?: string | null;
  createdByTaskId?: string | null;
  createdBy?: string | null;
  createdBySession?: string | null;
  createdByTaskScheduleId?: string | null;
  goalId?: string | null;
  evolutionScopeId?: string | null;
  workspacePath?: string | null;
  workflowModelOverrides?: Record<string, string>;
  activeSession?: 'worker' | 'leader' | null;
  taskAgentSessionId?: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  blockReason: SpaceBlockReason | null;
  approvalSource: SpaceApprovalSource | null;
  approvalReason: string | null;
  approvedAt: number | null;
  pendingCheckpointType: 'task_completion' | null;
  pendingCompletionSubmittedByNodeId?: string | null;
  pendingCompletionSubmittedAt?: number | null;
  pendingCompletionReason?: string | null;
  reportedStatus: SpaceReportedStatus | null;
  reportedSummary: string | null;
  postApprovalSessionId?: string | null;
  postApprovalStartedAt?: number | null;
  postApprovalBlockedReason?: string | null;
  postApprovalSourceNodeId?: string | null;
  restrictions?: TaskRestriction | null;
  updatedAt: number;
  terminalGeneration: number;
}

export interface PaginatedSpaceTaskResult {
  tasks: SpaceTask[];
  total: number;
}

export type SpaceGoalOutcomeNotificationStatus =
  | 'pending'
  | 'superseded'
  | 'acknowledged'
  | 'rejected';

export interface SpaceGoalOutcomeNotification {
  id: string;
  spaceId: string;
  goalId: string;
  taskId: string;
  terminalGeneration: number;
  goalRevision: number;
  status: SpaceGoalOutcomeNotificationStatus;
  payload: SpaceGoalOutcomeNotificationPayload;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceGoalOutcomeNotificationPayload {
  summary: string;
  taskStatus: SpaceTaskStatus;
  taskTitle: string;
  goalTitle: string;
}

export interface SpaceTaskCompact {
  id: string;
  taskNumber: number;
  title: string;
  status: SpaceTaskStatus;
  priority: SpaceTaskPriority;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceTaskActivityMember {
  id: string;
  sessionId: string;
  kind: 'task_agent' | 'node_agent';
  label: string;
  role: string;
  state: SpaceTaskActivityState;
  processingStatus?:
    | 'idle'
    | 'queued'
    | 'processing'
    | 'waiting_for_input'
    | 'rate_limit_cooldown'
    | 'interrupted'
    | null;
  processingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
  rateLimitCooldown?: { retryCount: number; maxRetries: number; retryAt: number } | null;
  sessionError?: {
    category: string;
    message: string;
    providerId?: string | null;
  } | null;
  messageCount: number;
  taskId?: string | null;
  taskTitle?: string | null;
  taskStatus?: SpaceTaskStatus | null;
  nodeExecution?: {
    nodeExecutionId: string;
    nodeId: string;
    agentName: string;
    status: NodeExecutionStatus;
    result?: string | null;
    isCurrentPostApproval?: boolean;
  } | null;
  updatedAt?: number | null;
  lastMessageAt?: number | null;
}

export interface CreateSpaceTaskParams {
  spaceId: string;
  title: string;
  description?: string;
  priority?: SpaceTaskPriority;
  labels?: string[];
  dependsOn?: string[];
  status?: SpaceTaskStatus;
  workflowRunId?: string | null;
  preferredWorkflowId?: string | null;
  createdByTaskId?: string | null;
  createdBy?: string | null;
  createdBySession?: string | null;
  taskAgentSessionId?: string | null;
  createdByTaskScheduleId?: string | null;
  workspacePath?: string | null;
}

export interface InternalCreateSpaceTaskParams extends CreateSpaceTaskParams {
  goalId?: string | null;
  evolutionScopeId?: string | null;
}

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
  workspacePath?: string | null;
  activeSession?: 'worker' | 'leader' | null;
  taskAgentSessionId?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  blockReason?: SpaceBlockReason | null;
  approvalSource?: SpaceApprovalSource | null;
  approvalReason?: string | null;
  cancelReason?: string | null;
  approvedAt?: number | null;
  pendingCheckpointType?: 'task_completion' | null;
  pendingCompletionSubmittedByNodeId?: string | null;
  pendingCompletionSubmittedAt?: number | null;
  pendingCompletionReason?: string | null;
  reportedStatus?: SpaceReportedStatus | null;
  reportedSummary?: string | null;
  workflowModelOverrides?: Record<string, string> | null;
  postApprovalSessionId?: string | null;
  postApprovalStartedAt?: number | null;
  postApprovalBlockedReason?: string | null;
  postApprovalSourceNodeId?: string | null;
  restrictions?: TaskRestriction | null;
}

export interface InternalUpdateSpaceTaskParams extends UpdateSpaceTaskParams {
  goalId?: string | null;
  evolutionScopeId?: string | null;
  workflowModelOverrides?: Record<string, string> | null;
}

export type NodeExecutionStatus =
  | 'pending'
  | 'in_progress'
  | 'idle'
  | 'waiting_rebind'
  | 'blocked'
  | 'cancelled';

export interface NodeExecution {
  id: string;
  workflowRunId: string;
  workflowNodeId: string;
  agentName: string;
  agentId: string | null;
  agentSessionId: string | null;
  status: NodeExecutionStatus;
  result: string | null;
  data: Record<string, unknown> | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  lastActivityAt: number | null;
}

export interface CreateNodeExecutionParams {
  workflowRunId: string;
  workflowNodeId: string;
  agentName: string;
  agentId?: string | null;
  status?: NodeExecutionStatus;
  agentSessionId?: string | null;
}

export interface UpdateNodeExecutionParams {
  status?: NodeExecutionStatus;
  agentSessionId?: string | null;
  result?: string | null;
  data?: Record<string, unknown> | null;
  startedAt?: number | null;
  completedAt?: number | null;
  lastActivityAt?: number | null;
}

export type WorkflowRunStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

export interface SpaceWorkflowRun {
  id: string;
  spaceId: string;
  workflowId: string;
  definitionVersion: string | null;
  title: string;
  description?: string;
  status: WorkflowRunStatus;
  failureReason?: WorkflowRunFailureReason;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
}

export interface CreateWorkflowRunParams {
  spaceId: string;
  workflowId: string;
  title: string;
  description?: string;
}

export type SpaceWorkerAgentStatus = 'active' | 'paused' | 'archived';

export interface SpaceWorkerAgent {
  id: string;
  spaceId: string;
  name: string;
  handle: string;
  status?: SpaceWorkerAgentStatus;
  description?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
  customPrompt: string | null;
  tools?: string[];
  settingSources?: SettingSource[];
  templateName?: string | null;
  templateHash?: string | null;
  modelPool?: WorkerAgentModelPoolEntry[];
  createdAt: number;
  updatedAt: number;
}

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
  handle?: string;
  status?: SpaceWorkerAgentStatus;
  description?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
  customPrompt?: string | null;
  tools?: string[];
  settingSources?: SettingSource[] | null;
  templateName?: string | null;
  templateHash?: string | null;
  modelPool?: WorkerAgentModelPoolEntry[];
}

export interface UpdateSpaceWorkerAgentParams {
  name?: string;
  handle?: string;
  status?: SpaceWorkerAgentStatus;
  description?: string | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  provider?: string | null;
  customPrompt?: string | null;
  tools?: string[] | null;
  settingSources?: SettingSource[] | null;
  templateName?: string | null;
  templateHash?: string | null;
  modelPool?: WorkerAgentModelPoolEntry[] | null;
}

export interface SpaceWorkerAgentDriftEntry {
  agentId: string;
  agentName: string;
  templateName: string;
  storedHash: string | null;
  currentHash: string;
  rowHash: string;
  updateAvailable: boolean;
  customized: boolean;
  orphaned: boolean;
}

export interface SpaceWorkerAgentDriftReport {
  spaceId: string;
  agents: SpaceWorkerAgentDriftEntry[];
}

export interface SpaceWorkerAgentSyncFieldDiff {
  before: string;
  after: string;
}

export interface SpaceWorkerAgentSyncToolsDiff {
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
}

export interface SpaceWorkerAgentSyncDiff {
  customPrompt?: SpaceWorkerAgentSyncFieldDiff;
  description?: SpaceWorkerAgentSyncFieldDiff;
  tools?: SpaceWorkerAgentSyncToolsDiff;
}

export interface SpaceWorkerAgentSyncPreview {
  agentId: string;
  agentName: string;
  templateName: string;
  storedHash: string | null;
  liveHash: string;
  rowHash: string;
  updateAvailable: boolean;
  customized: boolean;
  diff: SpaceWorkerAgentSyncDiff;
}

export interface SpaceWorkflowSyncFieldDiff {
  before: string;
  after: string;
}

export interface SpaceWorkflowSyncNameDelta {
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
}

export interface SpaceWorkflowSyncDiff {
  description?: SpaceWorkflowSyncFieldDiff;
  instructions?: SpaceWorkflowSyncFieldDiff;
  nodes?: SpaceWorkflowSyncNameDelta;
}

export interface SpaceWorkflowSyncPreview {
  workflowId: string;
  workflowName: string;
  templateName: string;
  storedHash: string | null;
  liveHash: string;
  rowHash: string;
  updateAvailable: boolean;
  customized: boolean;
  diff: SpaceWorkflowSyncDiff;
}

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

export type WorkflowHookExternalLookup = string & {};

export interface WorkflowHookAuthorizedCaller {
  sourceNode: string;
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
  id: string;
  enabled: boolean;
  sourceNode: string;
  targetNode?: string;
  method: WorkflowHookMcpMethod;
  templateData?: Record<string, unknown>;
  validator: WorkflowHookValidator;
  retry?: WorkflowHookRetrySettings;
  poll?: WorkflowHookPollSettings;
  localState?: WorkflowHookLocalStateConfig;
  authorizedCallers?: WorkflowHookAuthorizedCaller[];
  humanOnly?: boolean;
  classification?: 'validation' | 'side_effect';
  order?: number;
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

export interface Channel {
  id: string;
  from: string;
  to: string | string[];
  maxCycles?: number;
  label?: string;
}

export type WorkflowRunFailureReason =
  | 'humanRejected'
  | 'maxIterationsReached'
  | 'nodeTimeout'
  | 'agentCrash';

export interface WorkflowNodeAgentOverride {
  value: string;
}

export interface DeclarativeToolGuard {
  matcher: string;
  pattern: string;
  decision: 'deny';
  reason: string;
}

export interface EventInterest {
  topic?: string;

  topicFrom?: { source: 'primaryLink'; pattern: string };

  label?: string;
}

export interface WorkerAgentModelPoolEntry {
  model: string;
  provider?: string;
  maxConcurrent: number;
  weight: number;
}

export interface WorkflowNodeAgent {
  agentId: string;
  name: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  customPrompt?: WorkflowNodeAgentOverride;
  replaceAgentPrompt?: boolean;
  disabledSkillIds?: string[];
  extraMcpServers?: Record<string, McpServerConfig>;
  eventInterests?: EventInterest[];
  timeoutMs?: number;
  toolGuards?: DeclarativeToolGuard[];
  resetContextPerTurn?: boolean;
}

export interface WorkflowChannel {
  id?: string;
  from: string;
  to: string | string[];
  maxCycles?: number;
  label?: string;
}

export const HANDOFF_TARGET_WILDCARD = '*' as const;

export interface HandoffTransition {
  id: string;
  label?: string;
  target: string;
  hookId?: string;
  maxCycles?: number;
}

export interface HandoffOperation {
  target: string;
  summary: string;
  data?: Record<string, unknown>;
}

export interface WorkflowNode {
  id: string;
  name: string;
  agents: WorkflowNodeAgent[];
  postApproval?: PostApprovalRoute;
  transitions?: HandoffTransition[];
}

export interface WorkflowNodeInput {
  id?: string;
  name: string;
  agents: WorkflowNodeAgent[];
  postApproval?: PostApprovalRoute;
  transitions?: HandoffTransition[];
}

export interface PostApprovalRoute {
  targetAgent: string;
  instructions: string;
  requirePrMerge?: boolean;
}

export interface SpaceWorkflowSummary {
  id: string;
  spaceId: string;
  name: string;
  description?: string;
  tags: string[];
  templateName?: string;
  disabled?: boolean;
  handle?: string;
  nodeCount: number;
  completionAutonomyLevel: SpaceAutonomyLevel;
  templateHash?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceWorkflow {
  id: string;
  spaceId: string;
  name: string;
  description?: string;
  instructions?: string;
  nodes: WorkflowNode[];
  startNodeId: string;
  endNodeId?: string;
  channels?: WorkflowChannel[];
  hooks?: WorkflowHook[];
  tags: string[];
  layout?: Record<string, { x: number; y: number }>;
  createdAt: number;
  updatedAt: number;
  completionAutonomyLevel: SpaceAutonomyLevel;
  templateName?: string;
  templateHash?: string;
  postApproval?: PostApprovalRoute;
  disabled?: boolean;
  handle?: string;
}

export interface CreateSpaceWorkflowParams {
  spaceId: string;
  name: string;
  description?: string;
  instructions?: string;
  nodes?: WorkflowNodeInput[];
  startNodeId?: string;
  endNodeId?: string;
  channels?: WorkflowChannel[];
  hooks?: WorkflowHook[];
  tags?: string[];
  layout?: Record<string, { x: number; y: number }>;
  completionAutonomyLevel?: SpaceAutonomyLevel;
  templateName?: string;
  templateHash?: string;
  postApproval?: PostApprovalRoute;
  disabled?: boolean;
  handle?: string;
}

export interface UpdateSpaceWorkflowParams {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  nodes?: WorkflowNode[] | null;
  startNodeId?: string | null;
  endNodeId?: string | null;
  channels?: WorkflowChannel[] | null;
  hooks?: WorkflowHook[] | null;
  tags?: string[] | null;
  layout?: Record<string, { x: number; y: number }> | null;
  completionAutonomyLevel?: SpaceAutonomyLevel;
  templateName?: string | null;
  templateHash?: string | null;
  postApproval?: PostApprovalRoute | null;
  disabled?: boolean | null;
  handle?: string | null;
}

export interface DuplicateDriftRow {
  id: string;
  templateHash: string | null;
  createdAt: number;
}

export interface DuplicateDriftReport {
  templateName: string;
  rows: DuplicateDriftRow[];
}

export interface ExportedWorkflowChannel {
  from: string;
  to: string | string[];
  maxCycles?: number;
  label?: string;
}

export interface ExportedWorkflowNodeAgent {
  agentRef: string;
  name: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: WorkflowNodeAgentOverride | string;
  replaceAgentPrompt?: boolean;
  instructions?: WorkflowNodeAgentOverride | string;
  disabledSkillIds?: string[];
  extraMcpServers?: Record<string, unknown>;
  timeoutMs?: number;
  toolGuards?: DeclarativeToolGuard[];
  eventInterests?: EventInterest[];
  resetContextPerTurn?: boolean;
}

export interface ExportedHandoffTransition {
  id: string;
  label?: string;
  target: string;
  hookId?: string;
  maxCycles?: number;
}

export interface ExportedWorkflowNode {
  agents: ExportedWorkflowNodeAgent[];
  name: string;
  postApproval?: PostApprovalRoute;
  transitions?: ExportedHandoffTransition[];
}

export interface ExportedSpaceWorkerAgent {
  version: 1 | 2 | 3 | 4;
  type: 'agent';
  name: string;
  handle?: string;
  description?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
  systemPrompt?: string;
  instructions?: string;
  tools?: string[];
  settingSources?: import('./settings.ts').SettingSource[];
  modelPool?: WorkerAgentModelPoolEntry[];
}

export interface ExportedSpaceWorkflow {
  version: 1 | 2 | 3 | 4;
  type: 'workflow';
  name: string;
  description?: string;
  nodes: ExportedWorkflowNode[];
  startNode: string;
  endNode?: string;
  tags: string[];
  instructions?: string;
  channels?: ExportedWorkflowChannel[];
  hooks?: WorkflowHook[];
  completionAutonomyLevel?: SpaceAutonomyLevel;
  disabled?: boolean;
  handle?: string;
}

export interface SpaceExportBundle {
  version: 1 | 2 | 3 | 4;
  type: 'bundle';
  name: string;
  description?: string;
  agents: ExportedSpaceWorkerAgent[];
  workflows: ExportedSpaceWorkflow[];
  exportedAt: number;
  exportedFrom?: string;
}

export type ArtifactType = string;

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

export interface ApprovalRecord {
  source: SpaceApprovalSource;
  requiredLevel: SpaceAutonomyLevel;
  spaceLevel: SpaceAutonomyLevel;
  timestamp: number;
  reason?: string;
  skipped?: boolean;
}

export type ActivityEntry =
  | {
      kind: 'tool_use';
      toolName: string;
      preview: string;
      ts: number;
      uuid: string;
      toolUseId?: string;
    }
  | { kind: 'text'; text: string; ts: number; uuid: string }
  | { kind: 'thinking'; preview: string; ts: number; uuid: string }
  | { kind: 'user_message'; text: string; ts: number; uuid: string }
  | { kind: 'agent_handoff'; text: string; ts: number; uuid: string }
  | {
      kind: 'hook';
      hookName: string;
      hookEvent: string;
      status: 'running' | 'completed' | 'failed';
      summary?: string;
      ts: number;
      uuid: string;
    }
  | {
      kind: 'api_retry';
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorStatus: number | null;
      ts: number;
      uuid: string;
    };

export interface ActiveTurnSummary {
  sessionId: string;
  turnIndex: number;
  entries: ActivityEntry[];
}
