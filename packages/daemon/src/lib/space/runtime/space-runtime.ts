import type {
  CreateNodeExecutionParams,
  NodeExecution,
  Space,
  SpaceApprovalSource,
  SpaceTask,
  SpaceTaskPriority,
  SpaceTaskStatus,
  SpaceWorkflow,
  SpaceWorkflowRun,
  UpdateSpaceTaskParams,
  WorkflowChannel,
  WorkflowNode,
} from '@hyperneo/shared';
import {
  isChannelCyclic,
  isRateOrUsageLimited,
  isWorkflowRunSucceeded,
  isWorkflowRunWaiting,
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  resolveNodeAgents,
} from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isSDKResultError, isSDKResultSuccess } from '@hyperneo/shared/sdk';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import {
  ChannelCycleRepository,
  DEAD_LOOP_THRESHOLD,
  DEAD_LOOP_WINDOW_MS,
} from '../../../storage/repositories/channel-cycle-repository.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository.ts';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { SpaceAgentInboxRepository } from '../../../storage/repositories/space-agent-inbox-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceWorkflowEventSubscriptionRepository } from '../../../storage/repositories/space-workflow-event-subscription-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { formatExternalEventEssence } from '../../external-events/event-essence.ts';
import {
  type ExternalEventPublishedPayload,
  isExternalEventDeliveryV2Enabled,
} from '../../external-events/external-event-service.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import { legacyGitHubTopic } from '../../external-events/github-subscription-pattern.ts';
import { composeLongHorizonSubscriptionPattern } from '../../external-events/long-horizon-subscription-pattern.ts';
import {
  computeQueueAgeStats,
  ExternalEventQueueMetrics,
  type QueueHealthGauges,
  type QueueHealthSnapshot,
} from '../../external-events/queue-health-metrics.ts';
import { TopicTrie } from '../../external-events/topic-trie.ts';
import { validateGlobPattern } from '../../external-events/topic-validator.ts';
import type { ExternalEvent } from '../../external-events/types.ts';
import {
  type DaemonCommandMap,
  type InternalCommandBus,
  MissingCommandHandlerError,
} from '../../internal-command-bus.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
  InternalEventPayload,
} from '../../internal-event-bus.ts';
import { Logger } from '../../logger.ts';
import type { SpaceActorRegistryAdapter } from '../actor-registry.ts';
import { MAX_AGENT_SLOT_EVENT_INTERESTS } from '../export-format.ts';
import type { SpaceAgentManager } from '../managers/space-agent-manager.ts';
import type { SpaceManager } from '../managers/space-manager.ts';
import {
  assertValidSpaceTaskTransition,
  isValidSpaceTaskTransition,
  SpaceTaskManager,
  VALID_SPACE_TASK_TRANSITIONS,
} from '../managers/space-task-manager.ts';
import {
  isReservedWorkflowAgentName,
  type SpaceWorkflowManager,
} from '../managers/space-workflow-manager.ts';
import { normalizeMeaningfulTaskResult } from '../task-result-utils.ts';
import type { WorkflowArtifactProfile } from './artifact-profile.ts';
import { CompletionDetector } from './completion-detector.ts';
import {
  DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS,
  DEFAULT_AGENT_STUCK_NAG_GRACE_MS,
  DEFAULT_SILENT_STALL_ATTENTION_THRESHOLD_MS,
  DEFAULT_TOOL_USE_ACTIVE_TTL_MS,
  MAX_AGENT_STUCK_NAGS,
  MAX_AGENT_STUCK_RESTARTS,
  MAX_BLOCKED_RUN_RETRIES,
  MAX_TASK_AGENT_CRASH_RETRIES,
  MAX_TERMINAL_ERROR_CONTINUE_RETRIES,
} from './constants.ts';
import { deliveryModeFromFailureReason } from './delivery-mode.ts';
import {
  buildQueueKey,
  DEFAULT_EXTERNAL_EVENT_QUEUE_TTL_MS,
  type ExternalEventTaskDecision,
  evaluateRequeueTaskLifecycle,
  hasAnyExecutionForTarget,
  hasTerminalExecutionForTarget,
  isPublishedExternalEventExpired,
  isQueuedExternalEventExpired,
  isWorkflowTargetOwnedBySpace,
  prepareExternalEventTask,
  resolveCurrentQueueableOrActiveExecution,
  resolveLiveDeliveryTarget,
  resolveSubscriptionTarget,
} from './external-event-admission-gates.ts';
import {
  decideExternalEventDelivery,
  decidePostActivationDelivery,
  type ExternalEventDeliveryDecision,
} from './external-event-delivery-pipeline.ts';
import {
  deliverImmediateEvent,
  type ImmediateEventDeliveryDeps,
} from './immediate-event-delivery-pipeline.ts';
import { classifyLastMessageForIdleAgent } from './last-message-classifier.ts';
import type { SelectWorkflowWithLlm } from './llm-workflow-selector.ts';
import {
  clearPendingCompletionState,
  type PostApprovalRouteContext,
  type PostApprovalRouteResult,
  PostApprovalRouter,
} from './post-approval-router.ts';
import {
  buildPromptTooLongContinueNag,
  COMPACT_RESULT_TIMEOUT_MS,
  createPromptTooLongRecoveryState,
  isPromptTooLongErrorMessage,
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
  type PromptTooLongRecoveryState,
} from './prompt-too-long-recovery.ts';
import type { TaskAgentManager } from './task-agent-manager.ts';
import { WorkflowExecutor } from './workflow-executor.ts';
import {
  findMissingNodeAgentReferences,
  formatMissingAgentReference,
  isMissingWorkflowAgentError,
  isPermanentSpawnError,
  isSpawnSupersededError,
  isTransientSpawnError,
  MissingWorkflowAgentError,
} from './workflow-node-execution-validation.ts';
import { canTransition as canTransitionRunStatus } from './workflow-run-status-machine.ts';
import { selectWorkflow } from './workflow-selector.ts';
import { decideRunTickAdmission, selectTimedOutExecutions } from './run-tick-admission-gates.ts';
import {
  resolveCompletionSummaries,
  isTaskAlreadyResolved,
  mapFinalTaskStatus,
  resolveSpawnedPostApprovalSession,
  isSettlementTerminal,
  resolveQuiesceSourceNodeId,
  selectSiblingsToQuiesce,
} from './run-completion-settlement.ts';
import {
  decideSpawnAdmission,
  selectPromotablePendingExecutions,
  classifySpawnFailure,
  hasDriveableExecution,
} from './run-spawn-decisions.ts';

const log = new Logger('space-runtime');
const PRIORITY_ORDER: Record<SpaceTaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};
const TASK_BLOCKABLE_FROM_STATUSES: readonly SpaceTaskStatus[] = (
  Object.keys(VALID_SPACE_TASK_TRANSITIONS) as SpaceTaskStatus[]
).filter((status) => VALID_SPACE_TASK_TRANSITIONS[status].includes('blocked'));

export interface SpaceRuntimeConfig {
  db: BunDatabase;
  dbPath?: string;
  channelCycleRepo?: ChannelCycleRepository;
  spaceManager: SpaceManager;
  spaceAgentManager: SpaceAgentManager;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  workflowEventSubscriptionRepo?: SpaceWorkflowEventSubscriptionRepository;
  spaceWorkflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  reactiveDb?: ReactiveDatabase;
  taskAgentManager?: TaskAgentManager;
  tickIntervalMs?: number;
  agentNoProgressThresholdMs?: number;
  silentStallAttentionThresholdMs?: number;
  agentStuckNagGraceMs?: number;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  commandBus?: InternalCommandBus<DaemonCommandMap>;
  externalEventStore?: ExternalEventStore;
  queueHealthMetrics?: ExternalEventQueueMetrics;
  externalEventDeliveryCooldownMs?: number;
  externalEventDeliveryCooldownMapCap?: number;
  completionDetector?: CompletionDetector;
  artifactRepo?: WorkflowRunArtifactRepository;
  artifactProfile?: WorkflowArtifactProfile;
  sdkMessageRepo?: SDKMessageRepository;
  pendingMessageRepo?: PendingAgentMessageRepository;
  onTaskUpdated?: (payload: {
    spaceId: string;
    task: SpaceTask;
    archiveSource?: 'user' | 'system_reconcile';
    fromStatus?: SpaceTaskStatus | null;
  }) => Promise<void> | void;
  onWorkflowRunCreated?: (payload: {
    spaceId: string;
    run: SpaceWorkflowRun;
  }) => Promise<void> | void;
  onWorkflowRunUpdated?: (payload: {
    spaceId: string;
    run: SpaceWorkflowRun;
  }) => Promise<void> | void;
  selectWorkflowWithLlm?: SelectWorkflowWithLlm;
  goalService?: Pick<
    import('../goals/goal-service.ts').SpaceGoalService,
    'handleTaskTerminal' | 'supersedeOutcomeNotificationsForTask' | 'retryQueuedRunsForSpace'
  >;
  evolutionScopeService?: import('../evolution-scope-service.ts').EvolutionScopeService;
  actorRegistry?: SpaceActorRegistryAdapter;
  spaceAgentInboxRepo?: SpaceAgentInboxRepository;
  deliverLongHorizonExternalEvent?: (args: {
    spaceId: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
  }) => Promise<{ delivered: boolean }>;
}

interface StartWorkflowRunOptions {
  parentTaskId?: string;
}

type WorkflowTaskRecoveryTargetStatus = 'open' | 'in_progress';

interface ExecutorMeta {
  workflow: SpaceWorkflow;
  spaceId: string;
  workspacePath: string;
}

interface WorkflowSubscriptionTarget {
  kind?: 'workflow';
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  topic?: string;
  subscriptionKind?: 'static' | 'dynamic';
  sessionId?: string;
}

interface LongHorizonSubscriptionTarget {
  kind: 'long_horizon_agent';
  spaceId: string;
  agentId: string;
  source: string;
  topic: string;
  subscriptionId: string;
}

type SubscriptionTarget = WorkflowSubscriptionTarget | LongHorizonSubscriptionTarget;

function isWorkflowSubscriptionTarget(
  target: SubscriptionTarget
): target is WorkflowSubscriptionTarget {
  return target.kind !== 'long_horizon_agent';
}

function isLongHorizonSubscriptionTarget(
  target: SubscriptionTarget
): target is LongHorizonSubscriptionTarget {
  return target.kind === 'long_horizon_agent';
}

interface SubscriptionDeclaredInterest {
  nodeId: string;
  nodeName: string;
  agentName: string;
  topic: string | null;
  topicFrom: { source: 'primaryLink'; pattern: string } | null;
  label: string | null;
  active: boolean;
}

interface SubscriptionPersistedRow {
  nodeId: string;
  agentName: string;
  taskId: string;
  topic: string;
  createdAt: number;
  updatedAt: number;
  active: boolean;
}

interface SubscriptionActiveEntry {
  nodeId: string;
  agentName: string;
  taskId: string;
  topic: string;
  subscriptionKind: 'static' | 'dynamic';
  source: 'declared' | 'persisted' | 'orphan' | 'unknown';
}

interface SubscriptionListResult {
  workflowRunId: string;
  nodeId: string | null;
  definitionResolved: boolean;
  declared: SubscriptionDeclaredInterest[];
  persisted: SubscriptionPersistedRow[];
  active: SubscriptionActiveEntry[];
  mismatches: {
    declaredNotActive: number;
    persistedNotActive: number;
    orphanActive: number;
  };
}

function subscriptionReconcileKey(
  nodeId: string,
  agentName: string,
  topic: string,
  taskId?: string
): string {
  return `${nodeId}|${agentName.toLowerCase()}|${topic.toLowerCase()}${taskId ? `|${taskId}` : ''}`;
}

interface PendingExternalEvent {
  event: ExternalEventPublishedPayload;
  deliveryKey: string;
  deliveryMode: 'immediate' | 'defer';
  createdAt: number;
}

interface ExternalEventDigestItem {
  target: WorkflowSubscriptionTarget;
  event: ExternalEventPublishedPayload;
  deliveryKey: string;
  deliveryMode: 'immediate' | 'defer';
  createdAt: number;
  allowTargetSessionFallback: boolean;
}

interface ExternalEventRateLimitState {
  timestamps: number[];
  pendingDigest: ExternalEventDigestItem[];
  digestTimer: Timer | null;
  cleanupTimer: Timer | null;
}

interface AgentStuckRecoveryState {
  nagCount: number;
  restartCount: number;
  lastAction: 'nag' | 'restart' | 'blocked' | null;
  lastActionAt: number | null;
  lastObservedMessageId: string | null;
  lastObservedMessageAt: number | null;
  lastObservedProgressMessageId: string | null;
  lastObservedProgressMessageAt: number | null;
  lastRuntimeNagMessageId: string | null;
  lastSessionId: string | null;
  pendingRestartNotice: string | null;
}

interface NonTerminalIdleState {
  lastSessionId: string | null;
  lastObservedMessageId: string | null;
  lastObservedProgressMessageId: string | null;
  lastObservedProgressMessageAt: number | null;
  lastRuntimeNudgeMessageId: string | null;
  nudgeCount: number;
  failedNudgeCount: number;
  lastNudgeAt: number | null;
  lastAttentionLogAt: number | null;
}

interface TerminalErrorContinueState {
  lastSessionId: string | null;
  continueCount: number;
  lastRetriedErrorSignature: string | null;
  lastContinueAt: number | null;
  failedInjectionCount: number;
}

const NON_TERMINAL_IDLE_FAILED_NUDGE_RETRY_MS = 60 * 1000;
const NON_TERMINAL_IDLE_ATTENTION_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const SILENT_STALL_ATTENTION_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const EXTERNAL_EVENT_RETRY_DELAY_MS = 1000;
const EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS = 5;
const EXTERNAL_EVENT_RATE_WINDOW_MS = 60_000;
const EXTERNAL_EVENT_RATE_LIMIT_PER_MIN = parsePositiveIntegerEnv(
  'EXTERNAL_EVENT_RATE_LIMIT_PER_MIN',
  10
);
const EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS = parsePositiveIntegerEnv(
  'HYPERNEO_EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS',
  30_000
);
const EXTERNAL_EVENT_DELIVERY_COOLDOWN_MAP_CAP = parsePositiveIntegerEnv(
  'HYPERNEO_EXTERNAL_EVENT_DELIVERY_COOLDOWN_MAP_CAP',
  4096
);
const EXTERNAL_EVENT_QUEUE_TTL_MS = parsePositiveIntegerEnv(
  'EXTERNAL_EVENT_QUEUE_TTL_MS',
  DEFAULT_EXTERNAL_EVENT_QUEUE_TTL_MS
);

export function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

type SpaceNotificationEvent =
  | {
      kind: 'task_blocked';
      spaceId: string;
      taskId: string;
      reason: string;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_blocked';
      spaceId: string;
      runId: string;
      reason: string;
      timestamp: string;
    }
  | {
      kind: 'task_timeout';
      spaceId: string;
      taskId: string;
      elapsedMs: number;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_completed';
      spaceId: string;
      runId: string;
      status: 'done' | 'cancelled' | 'blocked';
      summary?: string;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_reopened';
      spaceId: string;
      runId: string;
      fromStatus: 'done' | 'cancelled';
      reason: string;
      by: string;
      timestamp: string;
    }
  | {
      kind: 'agent_crash';
      spaceId: string;
      taskId: string;
      timestamp: string;
    }
  | {
      kind: 'task_retry';
      spaceId: string;
      taskId: string;
      runId: string;
      originalReason: string;
      attemptNumber: number;
      maxAttempts: number;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_needs_attention';
      spaceId: string;
      runId: string;
      taskId: string;
      reason: string;
      retriesExhausted: number;
      timestamp: string;
    }
  | {
      kind: 'task_awaiting_approval';
      spaceId: string;
      taskId: string;
      actionId: string;
      actionName: string;
      actionDescription?: string;
      actionType: 'script' | 'instruction' | 'mcp_call';
      requiredLevel: number;
      spaceLevel: number;
      autonomyLevel: number;
      timestamp: string;
    };

function formatCommandError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

function longHorizonSpaceIdFromWorkflowRunId(workflowRunId: string): string | null {
  const prefix = 'long_horizon:';
  return workflowRunId.startsWith(prefix) ? workflowRunId.slice(prefix.length) : null;
}

function parseSubscriptionQueueKey(
  key: string
): Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'> | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [workflowRunId, taskId, nodeId, agentName] = parsed;
    if (
      typeof workflowRunId !== 'string' ||
      typeof taskId !== 'string' ||
      typeof nodeId !== 'string' ||
      typeof agentName !== 'string'
    ) {
      return null;
    }
    return { workflowRunId, taskId, nodeId, agentName };
  } catch {
    return null;
  }
}

function mapNotificationEventToInternalEvent(event: SpaceNotificationEvent): {
  event: keyof DaemonInternalEventMap;
  payload: DaemonInternalEventMap[keyof DaemonInternalEventMap];
} | null {
  const namespaceId = 'global';
  switch (event.kind) {
    case 'task_blocked':
      return {
        event: 'space.task.blocked',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          reason: event.reason,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_blocked':
      return {
        event: 'space.workflowRun.blocked',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          reason: event.reason,
          timestamp: event.timestamp,
        },
      };
    case 'task_timeout':
      return {
        event: 'space.task.timeout',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          elapsedMs: event.elapsedMs,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_completed':
      return {
        event: 'space.workflowRun.completed',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          status: event.status,
          summary: event.summary,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_reopened':
      return {
        event: 'space.workflowRun.reopened',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          fromStatus: event.fromStatus,
          reason: event.reason,
          by: event.by,
          timestamp: event.timestamp,
        },
      };
    case 'agent_crash':
      return {
        event: 'space.agent.crashed',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          timestamp: event.timestamp,
        },
      };
    case 'task_retry':
      return {
        event: 'space.workflowRun.retry',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          runId: event.runId,
          originalReason: event.originalReason,
          attemptNumber: event.attemptNumber,
          maxAttempts: event.maxAttempts,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_needs_attention':
      return {
        event: 'space.workflowRun.needsAttention',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          taskId: event.taskId,
          reason: event.reason,
          retriesExhausted: event.retriesExhausted,
          timestamp: event.timestamp,
        },
      };
    case 'task_awaiting_approval':
      return {
        event: 'space.task.awaitingApproval',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          actionId: event.actionId,
          actionName: event.actionName,
          actionDescription: event.actionDescription,
          actionType: event.actionType,
          requiredLevel: event.requiredLevel,
          spaceLevel: event.spaceLevel,
          autonomyLevel: event.autonomyLevel,
          timestamp: event.timestamp,
        },
      };
    default:
      return null;
  }
}

export class SpaceRuntime {
  private executors = new Map<string, WorkflowExecutor>();

  private executorMeta = new Map<string, ExecutorMeta>();

  private taskManagers = new Map<string, SpaceTaskManager>();

  private rehydrated = false;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private lastGlobalCyclePruneAt = 0;

  private internalEventBus: InternalEventBus<DaemonInternalEventMap> | undefined;

  private sdkMessageRepo: SDKMessageRepository | null = null;
  private jobQueueRepo: JobQueueRepository | null = null;

  private completionDetector: CompletionDetector;

  private notifiedTaskSet = new Set<string>();

  private taskCrashCounts = new Map<string, number>();

  private blockedRetryCounts = new Map<string, number>();

  private workflowChannelsMap = new Map<string, WorkflowChannel[]>();

  private nonTerminalIdleStates = new Map<string, NonTerminalIdleState>();

  private silentStallAttentionLogAt = new Map<string, number>();

  private terminalErrorContinueStates = new Map<string, TerminalErrorContinueState>();

  private agentStuckRecovery = new Map<string, AgentStuckRecoveryState>();

  private promptTooLongRecovery = new Map<string, PromptTooLongRecoveryState>();
  private readonly toolContinuationRepo: ToolContinuationRecoveryRepository;
  private readonly workflowEventSubscriptionRepo: SpaceWorkflowEventSubscriptionRepository;
  private readonly topicTrie = new TopicTrie<SubscriptionTarget>();
  private readonly pendingExternalEventQueue = new Map<string, PendingExternalEvent[]>();
  private readonly externalEventRetryTimers = new Map<string, Timer>();
  private readonly externalEventRetryCounts = new Map<string, number>();
  private readonly externalEventDeliveriesInFlight = new Set<string>();
  private readonly cancelledLongHorizonDeliveries = new Set<string>();
  private readonly longHorizonSubscriptionPatterns = new Map<string, string>();
  private readonly externalEventRateLimits = new Map<string, ExternalEventRateLimitState>();
  private readonly externalEventDeliveryCooldowns = new Map<string, number>();
  private readonly deliveryCooldownMs: number;
  private readonly deliveryCooldownMapCap: number;
  private readonly queueHealthMetrics: ExternalEventQueueMetrics;
  private unsubscribeExternalEventPublished?: () => void;
  private unsubscribeSdkToolUseCreated?: () => void;
  private unsubscribeSdkToolUseConsumed?: () => void;
  private unsubscribeSpaceResumed?: () => void;
  private unsubscribeSpacePaused?: () => void;
  private unsubscribeSpaceStopped?: () => void;
  private acceptingExternalEvents = false;
  private runtimeGeneration = 0;
  private reconciliationDone = true;
  private isStopped = false;
  private pausedSpaceIds = new Set<string>();
  private externalEventHandlingDepth = 0;
  private retainedEventRedispatchPending = false;

  constructor(private config: SpaceRuntimeConfig) {
    this.internalEventBus = config.internalEventBus;
    this.completionDetector = config.completionDetector ?? new CompletionDetector(config.taskRepo);
    this.sdkMessageRepo = config.sdkMessageRepo ?? null;
    this.toolContinuationRepo = new ToolContinuationRecoveryRepository(config.db);
    if (hasSqlExec(config.db)) {
      this.toolContinuationRepo.ensureSchema();
    }
    this.workflowEventSubscriptionRepo =
      config.workflowEventSubscriptionRepo ??
      new SpaceWorkflowEventSubscriptionRepository(config.db);
    if (hasSqlExec(config.db)) {
      this.workflowEventSubscriptionRepo.ensureSchema();
    }
    this.queueHealthMetrics = config.queueHealthMetrics ?? new ExternalEventQueueMetrics();
    this.deliveryCooldownMs =
      config.externalEventDeliveryCooldownMs ?? EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS;
    this.deliveryCooldownMapCap =
      config.externalEventDeliveryCooldownMapCap ?? EXTERNAL_EVENT_DELIVERY_COOLDOWN_MAP_CAP;
    this.subscribeExternalEventPublished();
    this.subscribeSdkToolUseCreated();
    this.unsubscribeSpaceResumed = this.config.spaceManager.onSpaceResumedRegister?.((spaceId) =>
      this.onSpaceResumed(spaceId)
    );
    this.unsubscribeSpacePaused = this.config.spaceManager.onSpacePausedRegister?.((spaceId) => {
      this.pausedSpaceIds.add(spaceId);
    });
    this.unsubscribeSpaceStopped = this.config.spaceManager.onSpaceStoppedRegister?.((spaceId) => {
      this.pausedSpaceIds.add(spaceId);
    });
  }

  private subscribeSdkToolUseCreated(): void {
    if (
      !this.config.internalEventBus ||
      this.unsubscribeSdkToolUseCreated ||
      this.unsubscribeSdkToolUseConsumed
    ) {
      return;
    }
    this.unsubscribeSdkToolUseCreated = this.config.internalEventBus.subscribe(
      'sdk.toolUse.created',
      (payload) => {
        if (typeof payload.toolUseId !== 'string' || typeof payload.sessionId !== 'string') {
          return;
        }
        this.toolContinuationRepo.recordToolUse({
          toolUseId: payload.toolUseId,
          sessionId: payload.sessionId,
          ttlMs: DEFAULT_TOOL_USE_ACTIVE_TTL_MS,
        });
      },
      { subscriberName: 'SpaceRuntime.toolUseRecovery' }
    );
    this.unsubscribeSdkToolUseConsumed = this.config.internalEventBus.subscribe(
      'sdk.toolUse.consumed',
      (payload) => {
        if (typeof payload.toolUseId !== 'string') return;
        this.toolContinuationRepo.markConsumed(payload.toolUseId);
      },
      { subscriberName: 'SpaceRuntime.toolUseRecovery' }
    );
  }

  private subscribeExternalEventPublished(): void {
    if (this.unsubscribeExternalEventPublished || !this.config.internalEventBus) return;
    this.unsubscribeExternalEventPublished = this.config.internalEventBus.subscribe(
      'externalEvent.published',
      (payload) => this.handleExternalEvent(payload),
      { subscriberName: 'SpaceRuntime.externalEvents' }
    );
  }

  private getSdkMessageRepo(): SDKMessageRepository {
    if (!this.sdkMessageRepo) {
      this.sdkMessageRepo = new SDKMessageRepository(this.config.db, this.config.reactiveDb);
    }
    return this.sdkMessageRepo;
  }

  private getJobQueueRepo(): JobQueueRepository {
    if (!this.jobQueueRepo) {
      this.jobQueueRepo = new JobQueueRepository(this.config.db);
    }
    return this.jobQueueRepo;
  }

  private createNodeExecutionOrIgnore(params: CreateNodeExecutionParams): NodeExecution {
    if (isReservedWorkflowAgentName(params.agentName)) {
      throw new Error(`Agent name "${params.agentName}" is reserved for a built-in agent`);
    }
    this.assertAgentReferenceExists(params);
    return this.config.nodeExecutionRepo.createOrIgnore(params);
  }

  private assertAgentReferenceExists(params: CreateNodeExecutionParams): void {
    const agentId = params.agentId;
    if (!agentId) return;
    if (this.config.spaceAgentManager.getById(agentId)) return;
    throw new MissingWorkflowAgentError(
      formatMissingAgentReference({
        runId: params.workflowRunId,
        nodeLabel: params.workflowNodeId,
        agentName: params.agentName,
        agentId,
      }),
      { agentName: params.agentName, agentId }
    );
  }

  registerRunInterests(
    workflowRunId: string,
    taskId: string,
    nodes: WorkflowNode[],
    options: { clearQueuedDeliveries?: boolean } = {}
  ): void {
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.subscriptionKind === 'static'
    );
    if (options.clearQueuedDeliveries) {
      this.clearQueuedDeliveriesForRun(workflowRunId, 'run_interests_rebuilt');
    }
    for (const node of nodes) {
      for (const agentEntry of resolveNodeAgents(node)) {
        for (const interest of agentEntry.eventInterests ?? []) {
          if (typeof interest.topic !== 'string') continue;
          const result = this.registerSubscription(
            workflowRunId,
            taskId,
            node.id,
            agentEntry.name,
            interest.topic,
            {
              subscriptionKind: 'static',
            }
          );
          if (!result.success) {
            throw new Error(
              `Invalid static external event interest for ${workflowRunId}/${node.id}/${agentEntry.name}: ` +
                (result.error ?? 'invalid pattern')
            );
          }
        }
      }
    }
  }

  private registerRunInterestsFromWorkflow(run: SpaceWorkflowRun, workflow: SpaceWorkflow): void {
    const task = this.pickCanonicalTaskForRun(run, this.config.taskRepo.listByWorkflowRun(run.id));
    if (!task) return;
    if (task.status === 'cancelled' || task.status === 'done' || task.status === 'archived') {
      return;
    }
    this.registerRunInterests(run.id, task.id, workflow.nodes);
  }

  registerSubscription(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    topic: string,
    options: { subscriptionKind?: 'static' | 'dynamic' } = {}
  ): { success: boolean; error?: string } {
    const trimmed = topic?.trim();
    if (!trimmed) return { success: false, error: 'Topic pattern is required.' };
    const validation = validateGlobPattern(trimmed);
    if (!validation.valid) {
      log.warn(
        `SpaceRuntime: skipping invalid subscription topic "${trimmed}" for ` +
          `${workflowRunId}/${nodeId}/${agentName}: ${validation.reason ?? 'invalid pattern'}`
      );
      return { success: false, error: validation.reason ?? 'invalid pattern' };
    }
    const normalized = trimmed.toLowerCase();
    const subscriptionKind = options.subscriptionKind ?? 'dynamic';
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run) {
      return { success: false, error: `Workflow run not found: ${workflowRunId}` };
    }
    if (subscriptionKind === 'dynamic') {
      const taskError = this.validateSubscriptionTargetTask(run, taskId);
      if (taskError) return { success: false, error: taskError };
    }
    const displaced = this.findExactWorkflowSubscriptionTarget(
      workflowRunId,
      taskId,
      nodeId,
      agentName,
      normalized,
      subscriptionKind
    );
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.taskId === taskId &&
        target.nodeId === nodeId &&
        target.agentName === agentName &&
        target.subscriptionKind === subscriptionKind &&
        target.topic?.toLowerCase() === normalized
    );
    const existingInterests = this.topicTrie.count(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.nodeId === nodeId &&
        target.agentName === agentName
    );
    if (existingInterests >= MAX_AGENT_SLOT_EVENT_INTERESTS) {
      if (displaced) this.topicTrie.insert(displaced.topic ?? trimmed, displaced);
      throw new Error(
        `Agent slot ${workflowRunId}/${nodeId}/${agentName} cannot register more than ` +
          `${MAX_AGENT_SLOT_EVENT_INTERESTS} event interests`
      );
    }
    this.topicTrie.insert(trimmed, {
      workflowRunId,
      taskId,
      nodeId,
      agentName,
      topic: trimmed,
      subscriptionKind,
    });
    if (subscriptionKind === 'dynamic') {
      try {
        this.workflowEventSubscriptionRepo.upsert({
          spaceId: run.spaceId,
          workflowRunId,
          taskId,
          nodeId,
          agentName,
          topic: trimmed,
          subscriptionKind,
        });
      } catch (err) {
        this.topicTrie.remove(
          (target) =>
            isWorkflowSubscriptionTarget(target) &&
            target.workflowRunId === workflowRunId &&
            target.taskId === taskId &&
            target.nodeId === nodeId &&
            target.agentName === agentName &&
            target.subscriptionKind === subscriptionKind &&
            target.topic?.toLowerCase() === normalized
        );
        if (displaced) this.topicTrie.insert(displaced.topic ?? trimmed, displaced);
        log.warn(
          `SpaceRuntime: failed to persist subscription for ${workflowRunId}/${nodeId}/${agentName}: ` +
            (err instanceof Error ? err.message : String(err))
        );
        return { success: false, error: 'Failed to persist subscription.' };
      }
    }
    if (subscriptionKind === 'dynamic') {
      this.redispatchRetainedExternalEvents();
    }
    return { success: true };
  }

  private validateSubscriptionTargetTask(run: SpaceWorkflowRun, taskId: string): string | null {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task || task.workflowRunId !== run.id) {
      return `Task ${taskId} does not belong to workflow run ${run.id}`;
    }
    if (task.status === 'done' || task.status === 'archived' || task.status === 'cancelled') {
      return `Task ${taskId} is terminal (${task.status}); cannot register subscriptions`;
    }
    return null;
  }

  private findExactWorkflowSubscriptionTarget(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    normalizedTopic: string,
    subscriptionKind: 'static' | 'dynamic'
  ): WorkflowSubscriptionTarget | undefined {
    return this.topicTrie
      .lookup(normalizedTopic)
      .find(
        (target): target is WorkflowSubscriptionTarget =>
          isWorkflowSubscriptionTarget(target) &&
          target.workflowRunId === workflowRunId &&
          target.taskId === taskId &&
          target.nodeId === nodeId &&
          target.agentName === agentName &&
          target.subscriptionKind === subscriptionKind &&
          (target.topic ?? '').toLowerCase() === normalizedTopic
      );
  }

  listSubscriptions(
    workflowRunId: string,
    spaceId: string,
    nodeId?: string
  ): { success: true; result: SubscriptionListResult } | { success: false; error: string } {
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run) {
      return { success: false, error: `Workflow run not found: ${workflowRunId}` };
    }
    if (run.spaceId !== spaceId) {
      return { success: false, error: `Workflow run ${workflowRunId} is not in this space.` };
    }
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run) ?? null;
    const definitionResolved = workflow !== null;
    const nodeFilter = nodeId ?? null;
    const canonicalTask = this.pickCanonicalTaskForRun(
      run,
      this.config.taskRepo.listByWorkflowRun(run.id)
    );
    const staticMaterializable =
      !!canonicalTask &&
      canonicalTask.status !== 'done' &&
      canonicalTask.status !== 'archived' &&
      canonicalTask.status !== 'cancelled';

    const declared: SubscriptionDeclaredInterest[] = [];
    if (workflow) {
      for (const node of workflow.nodes) {
        if (nodeFilter && node.id !== nodeFilter) continue;
        let agents: ReturnType<typeof resolveNodeAgents>;
        try {
          agents = resolveNodeAgents(node);
        } catch {
          continue;
        }
        for (const agent of agents) {
          for (const interest of agent.eventInterests ?? []) {
            const topic = typeof interest.topic === 'string' ? interest.topic : null;
            declared.push({
              nodeId: node.id,
              nodeName: node.name,
              agentName: agent.name,
              topic,
              topicFrom: interest.topicFrom ?? null,
              label: interest.label ?? null,
              active: false,
            });
          }
        }
      }
    }

    const persisted: SubscriptionPersistedRow[] = this.workflowEventSubscriptionRepo
      .listByRun(workflowRunId)
      .filter((row) => !nodeFilter || row.nodeId === nodeFilter)
      .map((row) => ({
        nodeId: row.nodeId,
        agentName: row.agentName,
        taskId: row.taskId,
        topic: row.topic,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        active: false,
      }));

    const active: SubscriptionActiveEntry[] = this.topicTrie
      .values()
      .filter(
        (target): target is WorkflowSubscriptionTarget =>
          isWorkflowSubscriptionTarget(target) &&
          target.workflowRunId === workflowRunId &&
          (!nodeFilter || target.nodeId === nodeFilter)
      )
      .map((target) => ({
        nodeId: target.nodeId,
        agentName: target.agentName,
        taskId: target.taskId,
        topic: target.topic ?? '',
        subscriptionKind: target.subscriptionKind ?? 'dynamic',
        source: 'orphan' as const,
      }));

    const canonicalTaskId = canonicalTask?.id ?? null;
    const activeStaticKeys = new Set<string>();
    const activeDynamicKeys = new Set<string>();
    for (const entry of active) {
      if (entry.subscriptionKind === 'static') {
        if (
          definitionResolved &&
          staticMaterializable &&
          (!canonicalTaskId || entry.taskId === canonicalTaskId)
        ) {
          activeStaticKeys.add(
            subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic)
          );
        }
      } else {
        activeDynamicKeys.add(
          subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic, entry.taskId)
        );
      }
    }
    const declaredKeys = new Set<string>();
    for (const d of declared) {
      if (d.topic === null) continue;
      const key = subscriptionReconcileKey(d.nodeId, d.agentName, d.topic);
      declaredKeys.add(key);
      d.active = activeStaticKeys.has(key);
    }
    const persistedKeys = new Set<string>();
    for (const p of persisted) {
      const key = subscriptionReconcileKey(p.nodeId, p.agentName, p.topic, p.taskId);
      persistedKeys.add(key);
      p.active = activeDynamicKeys.has(key);
    }
    let orphanActive = 0;
    for (const entry of active) {
      if (entry.subscriptionKind === 'static') {
        if (!definitionResolved) {
          entry.source = 'unknown';
          continue;
        }
        const canonicalOwned = !canonicalTaskId || entry.taskId === canonicalTaskId;
        const backed =
          staticMaterializable &&
          canonicalOwned &&
          declaredKeys.has(subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic));
        entry.source = backed ? 'declared' : 'orphan';
        if (!backed) orphanActive += 1;
      } else {
        const backed = persistedKeys.has(
          subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic, entry.taskId)
        );
        entry.source = backed ? 'persisted' : 'orphan';
        if (!backed) orphanActive += 1;
      }
    }

    return {
      success: true,
      result: {
        workflowRunId,
        nodeId: nodeFilter,
        definitionResolved,
        declared,
        persisted,
        active,
        mismatches: {
          declaredNotActive: staticMaterializable
            ? declared.filter((d) => d.topic !== null && !d.active).length
            : 0,
          persistedNotActive: persisted.filter((p) => !p.active).length,
          orphanActive,
        },
      },
    };
  }

  refreshLongHorizonSubscription(
    spaceId: string,
    subscriptionId: string
  ): { success: boolean; error?: string } {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return { success: false, error: 'Long-horizon agent repository unavailable.' };
    this.topicTrie.remove(
      (target) =>
        isLongHorizonSubscriptionTarget(target) &&
        target.spaceId === spaceId &&
        target.subscriptionId === subscriptionId
    );
    const previousPattern = this.longHorizonSubscriptionPatterns.get(subscriptionId);
    const subscription = repo.getSubscription(subscriptionId);
    if (!subscription || subscription.spaceId !== spaceId || subscription.status !== 'active') {
      this.longHorizonSubscriptionPatterns.delete(subscriptionId);
      this.clearLongHorizonRetries(
        (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
      );
      return { success: true };
    }
    const agent = repo.getById(subscription.agentId);
    if (!agent || agent.spaceId !== spaceId || agent.status !== 'active') {
      this.longHorizonSubscriptionPatterns.delete(subscriptionId);
      this.clearLongHorizonRetries(
        (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
      );
      return { success: true };
    }
    let pattern: string;
    try {
      pattern = composeLongHorizonSubscriptionPattern(subscription.source, subscription.topic);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const validation = validateGlobPattern(pattern);
    if (!validation.valid) return { success: false, error: validation.reason ?? 'invalid pattern' };
    if (previousPattern && previousPattern.toLowerCase() !== pattern.toLowerCase()) {
      this.clearLongHorizonRetries(
        (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
      );
    }
    this.longHorizonSubscriptionPatterns.set(subscriptionId, pattern);
    this.topicTrie.insert(pattern, {
      kind: 'long_horizon_agent',
      spaceId: subscription.spaceId,
      agentId: subscription.agentId,
      source: subscription.source,
      topic: pattern,
      subscriptionId: subscription.id,
    });
    return { success: true };
  }

  hasPendingRetriesForAgent(spaceId: string, agentId: string): boolean {
    for (const deliveryKey of this.externalEventRetryTimers.keys()) {
      const target = this.parseLongHorizonDeliveryKey(deliveryKey);
      if (target?.spaceId === spaceId && target.agentId === agentId) return true;
    }
    return false;
  }

  refreshLongHorizonAgentSubscriptions(
    spaceId: string,
    agentId: string
  ): { success: boolean; error?: string } {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return { success: false, error: 'Long-horizon agent repository unavailable.' };
    const subscriptions = repo
      .listSubscriptions(agentId)
      .filter((subscription) => subscription.spaceId === spaceId);
    for (const subscription of subscriptions) {
      this.refreshLongHorizonSubscription(spaceId, subscription.id);
    }
    return { success: true };
  }

  removeLongHorizonSubscription(spaceId: string, subscriptionId: string): void {
    this.topicTrie.remove(
      (target) =>
        isLongHorizonSubscriptionTarget(target) &&
        target.spaceId === spaceId &&
        target.subscriptionId === subscriptionId
    );
    this.longHorizonSubscriptionPatterns.delete(subscriptionId);
    this.clearLongHorizonRetries(
      (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
    );
  }

  removeLongHorizonAgentSubscriptions(spaceId: string, agentId: string): void {
    this.topicTrie.remove((target) => {
      const matches =
        isLongHorizonSubscriptionTarget(target) &&
        target.spaceId === spaceId &&
        target.agentId === agentId;
      if (matches) this.longHorizonSubscriptionPatterns.delete(target.subscriptionId);
      return matches;
    });
    this.clearLongHorizonRetries(
      (target) => target.spaceId === spaceId && target.agentId === agentId
    );
  }

  unregisterSubscription(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    topic: string
  ): { success: boolean; error?: string } {
    const trimmed = topic?.trim();
    if (!trimmed) return { success: false, error: 'Topic pattern is required.' };
    const validation = validateGlobPattern(trimmed);
    if (!validation.valid) {
      return { success: false, error: validation.reason ?? 'invalid pattern' };
    }
    const normalized = trimmed.toLowerCase();
    this.workflowEventSubscriptionRepo.deleteBySlotTopic(
      workflowRunId,
      taskId,
      nodeId,
      agentName,
      trimmed,
      'dynamic'
    );
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.taskId === taskId &&
        target.nodeId === nodeId &&
        target.agentName === agentName &&
        target.subscriptionKind === 'dynamic' &&
        target.topic?.toLowerCase() === normalized
    );
    return { success: true };
  }

  unregisterExecution(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string
  ): void {
    this.workflowEventSubscriptionRepo.deleteBySlot(workflowRunId, taskId, nodeId, agentName);
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.taskId === taskId &&
        target.nodeId === nodeId &&
        target.agentName === agentName
    );
    this.failQueuedDeliveriesForTarget(
      { workflowRunId, taskId, nodeId, agentName },
      'node_execution_cancelled'
    );
  }

  clearRunInterests(workflowRunId: string): void {
    this.workflowEventSubscriptionRepo.deleteByRun(workflowRunId);
    this.topicTrie.remove(
      (target) => isWorkflowSubscriptionTarget(target) && target.workflowRunId === workflowRunId
    );
    this.clearQueuedDeliveriesForRun(workflowRunId, 'run_terminal_cleanup');
  }

  clearRunInterestsPreservingDynamic(workflowRunId: string): void {
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.subscriptionKind !== 'dynamic'
    );
    this.clearQueuedDeliveriesForRun(workflowRunId, 'run_terminal_cleanup');
  }

  holdSpaceDeliveries(spaceId: string): void {
    this.pausedSpaceIds.add(spaceId);
  }

  clearTaskInterests(taskId: string): void {
    this.workflowEventSubscriptionRepo.deleteByTask(taskId);
    this.topicTrie.remove(
      (target) => isWorkflowSubscriptionTarget(target) && target.taskId === taskId
    );
    this.clearQueuedDeliveriesForTask(taskId);
  }

  clearTaskInterestsPreservingDynamic(taskId: string): void {
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.taskId === taskId &&
        target.subscriptionKind !== 'dynamic'
    );
    this.clearQueuedDeliveriesForTask(taskId);
  }

  resetBlockedExecutionsForRun(runId: string): void {
    try {
      const executions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
      for (const execution of executions) {
        if (execution.status !== 'blocked') continue;
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'pending',
          completedAt: null,
        });
      }
    } catch (err) {
      log.warn(
        `SpaceRuntime: resetBlockedExecutionsForRun failed for run ${runId}: ${formatCommandError(err)}`
      );
    }
  }

  redispatchRetainedExternalEvents(): void {
    if (this.externalEventHandlingDepth > 0) {
      if (!this.isStopped) {
        this.retainedEventRedispatchPending = true;
      }
      return;
    }
    this.expirePublishedExternalEventsPastTtl();
    this.redispatchPublishedEventsWithoutDeliveries();
  }

  flushPendingNodeQueue(target: WorkflowSubscriptionTarget, excludeDeliveryKey?: string): void {
    const prepared = this.preparePendingNodeQueueDispatchable(target, excludeDeliveryKey);
    if (!prepared) return;
    const { targetWithExecution, dispatchable } = prepared;

    let dispatched = 0;
    for (const item of dispatchable) {
      const deliveryTerminal = this.config.externalEventStore?.isDeliveryTerminal(
        item.event.eventId,
        item.deliveryKey
      );
      const targetStillSubscribed = this.isTargetStillSubscribed(target, item.event.topic);
      if (deliveryTerminal || !targetStillSubscribed) {
        if (!deliveryTerminal && !targetStillSubscribed) {
          this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
            terminal: true,
            reason: 'subscription_no_longer_active',
          });
          this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(
            item.event.eventId
          );
        }
        this.clearExternalEventRetry(item.deliveryKey);
        continue;
      }
      this.clearExternalEventRetry(item.deliveryKey);
      dispatched += 1;
      void this.enqueueDeliverableExternalEvent(
        targetWithExecution,
        item.event,
        item.deliveryKey,
        item.deliveryMode,
        item.createdAt,
        true
      );
    }
    this.queueHealthMetrics.recordFlushAttempt(dispatched);
  }

  private async flushPendingNodeQueueAsync(
    target: WorkflowSubscriptionTarget,
    excludeDeliveryKey?: string,
    includeCurrent?: PendingExternalEvent
  ): Promise<void> {
    const prepared = this.preparePendingNodeQueueDispatchable(target, excludeDeliveryKey);
    if (!prepared) return;
    const { targetWithExecution, dispatchable } = prepared;

    if (includeCurrent) {
      dispatchable.push(includeCurrent);
    }

    if (dispatchable.length > 1) {
      dispatchable.sort(
        (a, b) => a.createdAt - b.createdAt || a.event.occurredAt - b.event.occurredAt
      );
    }

    let dispatched = 0;
    for (const item of dispatchable) {
      const deliveryTerminal = this.config.externalEventStore?.isDeliveryTerminal(
        item.event.eventId,
        item.deliveryKey
      );
      const targetStillSubscribed = this.isTargetStillSubscribed(target, item.event.topic);
      if (deliveryTerminal || !targetStillSubscribed) {
        if (!deliveryTerminal && !targetStillSubscribed) {
          this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
            terminal: true,
            reason: 'subscription_no_longer_active',
          });
          this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(
            item.event.eventId
          );
        }
        this.clearExternalEventRetry(item.deliveryKey);
        continue;
      }
      this.clearExternalEventRetry(item.deliveryKey);
      dispatched += 1;
      await this.enqueueDeliverableExternalEvent(
        targetWithExecution,
        item.event,
        item.deliveryKey,
        item.deliveryMode,
        item.createdAt,
        true
      );
    }
    this.queueHealthMetrics.recordFlushAttempt(dispatched);
  }

  private preparePendingNodeQueueDispatchable(
    target: WorkflowSubscriptionTarget,
    excludeDeliveryKey?: string
  ): {
    targetWithExecution: WorkflowSubscriptionTarget;
    dispatchable: PendingExternalEvent[];
  } | null {
    if (!target.sessionId) return null;
    const targetWithExecution = this.resolveSubscriptionTarget(target);
    const key = this.buildQueueKey(target);
    const queued = this.pendingExternalEventQueue.get(key);
    const inMemoryDeliveryKeys = new Set(queued?.map((item) => item.deliveryKey) ?? []);

    const dispatchable: PendingExternalEvent[] = [];

    if (queued) {
      this.pendingExternalEventQueue.delete(key);
      const now = Date.now();
      for (const item of queued) {
        if (item.deliveryKey === excludeDeliveryKey) continue;
        if (this.isQueuedExternalEventExpired(item, now)) {
          this.failQueuedDeliveryForTtl(item, key);
          continue;
        }
        dispatchable.push(item);
      }
    }

    this.collectPersistedPendingDeliveries(
      targetWithExecution,
      inMemoryDeliveryKeys,
      dispatchable,
      excludeDeliveryKey
    );

    if (dispatchable.length === 0) return { targetWithExecution, dispatchable };

    dispatchable.sort(
      (a, b) => a.createdAt - b.createdAt || a.event.occurredAt - b.event.occurredAt
    );

    return { targetWithExecution, dispatchable };
  }

  private collectPersistedPendingDeliveries(
    target: WorkflowSubscriptionTarget,
    skipDeliveryKeys: Set<string>,
    dispatchable: PendingExternalEvent[],
    excludeDeliveryKey?: string
  ): void {
    const store = this.config.externalEventStore;
    if (!store || !target.sessionId) return;

    const deliveries = store
      .listPendingDeliveries(target.workflowRunId)
      .filter(
        (delivery) =>
          delivery.taskId === target.taskId &&
          delivery.nodeId === target.nodeId &&
          delivery.agentName === target.agentName &&
          delivery.deliveryKey !== excludeDeliveryKey &&
          !skipDeliveryKeys.has(delivery.deliveryKey) &&
          delivery.failureReason !== null
      )
      .map((delivery) => {
        const eventRecord = store.getById(delivery.eventId);
        return eventRecord ? { delivery, eventRecord } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter(({ eventRecord }) => eventRecord.state === 'published')
      .sort(
        (a, b) =>
          a.eventRecord.createdAt - b.eventRecord.createdAt ||
          a.delivery.updatedAt - b.delivery.updatedAt ||
          a.delivery.deliveryKey.localeCompare(b.delivery.deliveryKey)
      );

    for (const { delivery, eventRecord } of deliveries) {
      if (store.isDeliveryTerminal(delivery.eventId, delivery.deliveryKey)) continue;
      if (this.externalEventDeliveriesInFlight.has(delivery.deliveryKey)) {
        this.queueHealthMetrics.recordClaimConflict();
        log.debug('SpaceRuntime: external event delivery already in flight; skipped flush', {
          runId: delivery.workflowRunId,
          deliveryKey: delivery.deliveryKey,
        });
        continue;
      }
      if (!this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        this.clearExternalEventRetry(delivery.deliveryKey);
        log.debug('SpaceRuntime: external event delivery skipped — subscription removed', {
          runId: delivery.workflowRunId,
          deliveryKey: delivery.deliveryKey,
        });
        continue;
      }

      const mode = deliveryModeFromFailureReason(delivery.failureReason);
      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      const queuedItem: PendingExternalEvent = {
        event: eventPayload,
        deliveryKey: delivery.deliveryKey,
        deliveryMode: mode,
        createdAt: eventRecord.createdAt,
      };
      if (this.isQueuedExternalEventExpired(queuedItem)) {
        this.failQueuedDeliveryForTtl(queuedItem, this.buildQueueKey(target));
        continue;
      }
      dispatchable.push(queuedItem);
    }
  }

  private async handleExternalEvent(payload: ExternalEventPublishedPayload): Promise<void> {
    this.externalEventHandlingDepth += 1;
    try {
      await this.handleExternalEventImpl(payload);
    } finally {
      this.externalEventHandlingDepth -= 1;
      if (this.externalEventHandlingDepth === 0 && this.retainedEventRedispatchPending) {
        this.retainedEventRedispatchPending = false;
        if (!this.isStopped) {
          this.redispatchRetainedExternalEvents();
        }
      }
    }
  }

  private async handleExternalEventImpl(payload: ExternalEventPublishedPayload): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    const matches = this.lookupSubscriptionTargets(payload.topic).filter((target) => {
      if (isLongHorizonSubscriptionTarget(target)) return target.spaceId === payload.spaceId;
      return this.isWorkflowTargetOwnedBySpace(target, payload.spaceId);
    });

    if (matches.length === 0) {
      if (this.acceptingExternalEvents && this.isPublishedExternalEventExpired(payload)) {
        try {
          store.markEventFailed(payload.eventId, {
            terminal: true,
            reason: 'ttl_expired',
          });
        } catch (err) {
          log.warn(
            `SpaceRuntime: markEventFailed for ${payload.eventId} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return;
    }

    const workflowDeliveries = new Map<
      string,
      { target: WorkflowSubscriptionTarget; deliveryKey: string }
    >();
    const longHorizonDeliveries = new Map<
      string,
      { target: LongHorizonSubscriptionTarget; deliveryKey: string }
    >();
    for (const match of matches) {
      try {
        if (isLongHorizonSubscriptionTarget(match)) {
          const deliveryKey = this.buildLongHorizonDeliveryKey(match, payload);
          store.registerExpectedDelivery(payload.eventId, deliveryKey, {
            workflowRunId: `long_horizon:${match.spaceId}`,
            taskId: match.subscriptionId,
            nodeId: match.agentId,
            agentName: match.agentId,
          });
          longHorizonDeliveries.set(deliveryKey, { target: match, deliveryKey });
          continue;
        }
        const target = this.resolveSubscriptionTarget(match);
        const deliveryKey = this.buildDeliveryKey(target, payload);
        store.registerExpectedDelivery(payload.eventId, deliveryKey, target);
        workflowDeliveries.set(deliveryKey, { target, deliveryKey });
      } catch (err) {
        const targetDescription = isLongHorizonSubscriptionTarget(match)
          ? `${match.spaceId}/${match.agentId}`
          : `${match.workflowRunId}/${match.nodeId}/${match.agentName}`;
        log.warn(
          `SpaceRuntime: failed to register external event ${payload.eventId} for ` +
            `${targetDescription}: ${formatCommandError(err)}`
        );
      }
    }

    for (const { target, deliveryKey } of longHorizonDeliveries.values()) {
      if (store.isDeliveryTerminal(payload.eventId, deliveryKey)) {
        continue;
      }
      if (this.externalEventDeliveriesInFlight.has(deliveryKey)) {
        this.queueHealthMetrics.recordClaimConflict();
        continue;
      }
      await this.deliverToLongHorizonAgent(target, payload, deliveryKey);
    }

    const immediateRecord = isExternalEventDeliveryV2Enabled()
      ? store.getById(payload.eventId)
      : null;
    const routeImmediateTier = immediateRecord?.event.urgency === 'immediate';

    for (const { target, deliveryKey } of workflowDeliveries.values()) {
      if (this.isDeliveryInDeliveryCooldown(deliveryKey)) {
        this.queueHealthMetrics.recordCooldownSkip();
        continue;
      }
      if (routeImmediateTier) {
        await this.deliverImmediateTierEvent(
          target,
          payload,
          deliveryKey,
          immediateRecord?.event.render ?? null
        );
        continue;
      }
      await this.deliverExternalEventToWorkflowTarget(target, payload, deliveryKey);
    }
  }

  private async deliverExternalEventToWorkflowTarget(
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    const resolved = this.resolveSubscriptionTarget(target);
    try {
      const targetRun = this.config.workflowRunRepo.getRun(resolved.workflowRunId);
      const currentExecution = this.getCurrentQueueableOrActiveExecution(resolved);
      const decision = decideExternalEventDelivery({
        deliveryTerminal: store.isDeliveryTerminal(payload.eventId, deliveryKey),
        deliveryInFlight: this.externalEventDeliveriesInFlight.has(deliveryKey),
        subscriptionActive: this.isTargetStillSubscribed(resolved, payload.topic),
        taskDecision: this.prepareExternalEventTask(resolved, payload),
        targetHasSession: !!resolved.sessionId,
        targetSessionLive: resolved.sessionId
          ? this.isTargetSessionLive(resolved.sessionId)
          : false,
        targetSpacePaused: !!targetRun && this.pausedSpaceIds.has(targetRun.spaceId),
        executionPendingActivation:
          currentExecution?.status === 'pending' || currentExecution?.status === 'waiting_rebind',
      });
      await this.executeExternalEventDeliveryDecision(decision, resolved, payload, deliveryKey);
    } catch (err) {
      log.warn(
        `SpaceRuntime: failed to process external event ${payload.eventId} for ` +
          `${resolved.workflowRunId}/${resolved.nodeId}/${resolved.agentName}: ${formatCommandError(err)}`
      );
    }
  }

  private async executeExternalEventDeliveryDecision(
    decision: ExternalEventDeliveryDecision,
    resolved: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    if (decision.action === 'skip') {
      return;
    }
    if (decision.action === 'skipClaimConflict') {
      this.queueHealthMetrics.recordClaimConflict();
      log.debug('SpaceRuntime: external event delivery already in flight; skipped dispatch', {
        runId: resolved.workflowRunId,
        deliveryKey,
      });
      return;
    }
    if (decision.action === 'failDelivery') {
      store.markDeliveryFailed(payload.eventId, deliveryKey, {
        terminal: true,
        reason: decision.reason,
      });
      store.markEventFailedIfAllDeliveriesTerminal(payload.eventId);
      this.clearExternalEventRetry(deliveryKey);
      this.clearQueuedDelivery(resolved, deliveryKey);
      return;
    }
    if (decision.action === 'deferStoppedTask') {
      this.queueHealthMetrics.recordPausedSpaceSkip();
      store.markDeliveryFailed(payload.eventId, deliveryKey, {
        terminal: false,
        reason: 'deliveryMode:defer; task_stopped',
      });
      return;
    }
    if (decision.action === 'deferPausedSpace') {
      this.queueHealthMetrics.recordPausedSpaceSkip();
      store.markDeliveryFailed(payload.eventId, deliveryKey, {
        terminal: false,
        reason: 'deliveryMode:defer; space_paused',
      });
      return;
    }
    if (decision.action === 'deliverLiveSession') {
      await this.deliverToLiveSessionTarget(resolved, payload, deliveryKey);
      return;
    }
    if (decision.action === 'deliverStaleSession') {
      await this.deliverToStaleSessionTarget(resolved, payload, deliveryKey);
      return;
    }
    if (decision.action === 'queueForActivation') {
      await this.queueDeliveryForActivation(decision, resolved, payload, deliveryKey);
      return;
    }
    await this.deliverViaActivation(resolved, payload, deliveryKey);
  }

  private async deliverImmediateTierEvent(
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string,
    render: string | null
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    try {
      const deps: ImmediateEventDeliveryDeps = {
        getTask: (taskId) => this.config.taskRepo.getTask(taskId),
        getRun: (workflowRunId) => this.config.workflowRunRepo.getRun(workflowRunId),
        listExecutions: (workflowRunId) =>
          this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId),
        isDeliveryInFlight: (key) => this.externalEventDeliveriesInFlight.has(key),
        isSubscriptionActive: (candidate, topic) => this.isTargetStillSubscribed(candidate, topic),
        isTargetSpacePaused: (candidate) => {
          const run = this.config.workflowRunRepo.getRun(candidate.workflowRunId);
          return !!run && this.pausedSpaceIds.has(run.spaceId);
        },
        isTargetSessionLive: (sessionId) => this.isTargetSessionLive(sessionId),
        isSessionInterruptInProgress: (sessionId) => this.isTargetSessionInterrupted(sessionId),
        getSessionStatus: (sessionId) =>
          this.config.taskAgentManager?.getAgentSessionById(sessionId)?.getProcessingState()
            .status ?? '',
        withinRateBudget: () => this.consumeImmediateTierRateBudget(target),
        setQueuedIfIdle: (sessionId, messageUuid) => {
          const session = this.config.taskAgentManager?.getAgentSessionById(sessionId);
          return session
            ? session.stateManager.setQueuedIfIdle(messageUuid)
            : Promise.resolve(false);
        },
        messages: this.getSdkMessageRepo(),
        jobQueue: this.getJobQueueRepo(),
        eventStore: store,
      };
      const outcome = await deliverImmediateEvent(deps, {
        event: payload,
        render,
        target,
        deliveryKey,
      });
      if (outcome.action === 'skip' && outcome.reason === 'claim_conflict') {
        this.queueHealthMetrics.recordClaimConflict();
      }
      if (outcome.action === 'error') {
        log.warn(
          `SpaceRuntime: immediate-tier delivery for ${payload.eventId} failed at ` +
            `${outcome.stage}: ${formatCommandError(outcome.error)}`
        );
      }
    } catch (err) {
      log.warn(
        `SpaceRuntime: failed to process immediate-tier event ${payload.eventId} for ` +
          `${target.workflowRunId}/${target.nodeId}/${target.agentName}: ${formatCommandError(err)}`
      );
    }
  }

  private consumeImmediateTierRateBudget(target: WorkflowSubscriptionTarget): boolean {
    const rateLimitKey = this.buildRateLimitKey(target);
    const state = this.getExternalEventRateLimitState(rateLimitKey);
    const now = Date.now();
    state.timestamps = state.timestamps.filter(
      (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
    );
    state.timestamps.push(now);
    this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
    return state.timestamps.length <= EXTERNAL_EVENT_RATE_LIMIT_PER_MIN;
  }

  private async deliverToLiveSessionTarget(
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store || !target.sessionId) return;
    const createdAt = this.externalEventCreatedAt(payload);
    await this.normalizeStaleInterruptedSession(target.sessionId);
    if (this.parkDeliveryForInterruptedSession(target, payload, deliveryKey, createdAt)) {
      return;
    }
    await this.flushPendingNodeQueueAsync(target, deliveryKey, {
      event: payload,
      deliveryKey,
      deliveryMode: 'defer',
      createdAt,
    });
  }

  private async deliverToStaleSessionTarget(
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    this.queueHealthMetrics.recordStaleSessionSkip();
    await this.flushPendingNodeQueueAsync(target, deliveryKey, {
      event: payload,
      deliveryKey,
      deliveryMode: 'defer',
      createdAt: this.externalEventCreatedAt(payload),
    });
  }

  private externalEventCreatedAt(payload: ExternalEventPublishedPayload): number {
    return this.config.externalEventStore?.getById(payload.eventId)?.createdAt ?? Date.now();
  }

  private async queueDeliveryForActivation(
    decision: Extract<ExternalEventDeliveryDecision, { action: 'queueForActivation' }>,
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    this.queueForPendingNode(
      target,
      payload,
      deliveryKey,
      'defer',
      this.externalEventCreatedAt(payload)
    );
    if (decision.retryUnlessPaused && (await this.isTargetSpacePausedOrStopped(target))) {
      return;
    }
    this.scheduleActivationRetry(
      target,
      payload,
      deliveryKey,
      decision.reason,
      decision.preserveAttemptCount ? { preserveAttemptCount: true } : {}
    );
  }

  private async deliverViaActivation(
    resolved: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    let activatedTarget: WorkflowSubscriptionTarget | null = null;
    let activationError: string | null = null;
    try {
      activatedTarget = await this.activateSubscribedTargetForExternalEvent(resolved);
    } catch (err) {
      activationError = err instanceof Error ? err.message : String(err);
    }
    const decision = decidePostActivationDelivery({
      activationError,
      activatedTargetFound: activatedTarget !== null,
      activatedHasSession: !!activatedTarget?.sessionId,
      activatedSessionLive: activatedTarget?.sessionId
        ? this.isTargetSessionLive(activatedTarget.sessionId)
        : false,
    });
    await this.executePostActivationDecision(
      decision,
      resolved,
      activatedTarget,
      payload,
      deliveryKey
    );
  }

  private async executePostActivationDecision(
    decision: ExternalEventDeliveryDecision,
    resolved: WorkflowSubscriptionTarget,
    activatedTarget: WorkflowSubscriptionTarget | null,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    if (decision.action === 'queueForActivation') {
      await this.queueDeliveryForActivation(decision, resolved, payload, deliveryKey);
      return;
    }
    if (decision.action === 'deliverLiveSession') {
      await this.deliverToLiveSessionTarget(activatedTarget!, payload, deliveryKey);
      return;
    }
    if (decision.action === 'deliverStaleSession') {
      await this.deliverToStaleSessionTarget(activatedTarget!, payload, deliveryKey);
      return;
    }
    if (decision.action === 'deferNotActive') {
      store.markDeliveryFailed(payload.eventId, deliveryKey, {
        terminal: false,
        reason: 'deliveryMode:defer; node_execution_not_active',
      });
      if (!(await this.isTargetSpacePausedOrStopped(activatedTarget!))) {
        this.scheduleActivationRetry(
          activatedTarget!,
          payload,
          deliveryKey,
          'deliveryMode:defer; node_execution_not_active'
        );
      }
    }
  }

  private async isTargetSpacePausedOrStopped(target: WorkflowSubscriptionTarget): Promise<boolean> {
    const task = this.config.taskRepo.getTask(target.taskId);
    if (!task) return true;
    const space = await this.config.spaceManager.getSpace(task.spaceId);
    return !space || space.paused || space.stopped;
  }

  private async activateSubscribedTargetForExternalEvent(
    target: WorkflowSubscriptionTarget
  ): Promise<WorkflowSubscriptionTarget | null> {
    const task = this.config.taskRepo.getTask(target.taskId);
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    if (
      !task ||
      !run ||
      task.workflowRunId !== run.id ||
      task.spaceId !== run.spaceId ||
      task.status === 'cancelled' ||
      task.status === 'archived'
    ) {
      return null;
    }
    if (this.hasTerminalExecutionForTarget(target)) return null;
    const currentExecution = this.getCurrentQueueableOrActiveExecution(target);
    if (currentExecution?.status === 'blocked') return null;
    if (!this.hasAnyExecutionForTarget(target)) return null;
    const space = await this.config.spaceManager.getSpace(task.spaceId);
    if (!space || space.paused || space.stopped || task.status === 'stopped') return target;
    const activate = this.config.taskAgentManager?.activateTargetSessionsForMessage;
    if (!activate) return null;

    const activated = await activate.call(
      this.config.taskAgentManager,
      target.taskId,
      target.workflowRunId,
      target.agentName,
      {
        reopenReason: `external event delivery to subscribed agent "${target.agentName}"`,
        reopenBy: 'external-event',
        workflowNodeId: target.nodeId,
      }
    );
    if (activated.length === 0) return target;

    return this.resolveSubscriptionTarget(target);
  }

  private externalEventDeliveryMessage(event: ExternalEventPublishedPayload): string {
    if (isExternalEventDeliveryV2Enabled()) {
      const record = this.config.externalEventStore?.getById(event.eventId);
      if (record?.event.urgency === 'immediate' && record.event.render) {
        return record.event.render;
      }
    }
    return formatExternalEventEssence(event);
  }

  private async deliverToLongHorizonAgent(
    target: LongHorizonSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    this.externalEventDeliveriesInFlight.add(deliveryKey);
    try {
      if (!this.config.deliverLongHorizonExternalEvent) {
        throw new Error('long-horizon event delivery unavailable');
      }
      const result = await this.config.deliverLongHorizonExternalEvent({
        spaceId: target.spaceId,
        agentId: target.agentId,
        message: this.externalEventDeliveryMessage(event),
        idempotencyKey: deliveryKey,
      });
      if (this.cancelledLongHorizonDeliveries.has(deliveryKey)) return;
      if (!result.delivered) throw new Error('long-horizon agent unavailable');
      this.clearExternalEventRetry(deliveryKey);
      store.markDeliveryDelivered(event.eventId, deliveryKey);
      store.markEventDeliveredIfAllDeliveriesDelivered(event.eventId);
      store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
    } catch (err) {
      if (this.cancelledLongHorizonDeliveries.has(deliveryKey)) return;
      const failureReason = err instanceof Error ? err.message : String(err);
      store.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: false,
        reason: failureReason,
      });
      this.scheduleLongHorizonEventRetry(target, event, deliveryKey, failureReason);
      log.warn(
        `SpaceRuntime: failed to deliver external event ${event.eventId} to long-horizon agent ` +
          `${target.agentId}: ${failureReason}`
      );
    } finally {
      this.externalEventDeliveriesInFlight.delete(deliveryKey);
      this.cancelledLongHorizonDeliveries.delete(deliveryKey);
    }
  }

  private clearLongHorizonRetries(
    predicate: (target: LongHorizonSubscriptionTarget) => boolean
  ): void {
    for (const deliveryKey of Array.from(this.externalEventRetryTimers.keys())) {
      const target = this.parseLongHorizonDeliveryKey(deliveryKey);
      if (!target || !predicate(target)) continue;
      this.markLongHorizonRetryCancelled(deliveryKey);
      this.clearExternalEventRetry(deliveryKey);
    }
    for (const deliveryKey of Array.from(this.externalEventDeliveriesInFlight)) {
      const target = this.parseLongHorizonDeliveryKey(deliveryKey);
      if (!target || !predicate(target)) continue;
      this.cancelledLongHorizonDeliveries.add(deliveryKey);
      this.markLongHorizonRetryCancelled(deliveryKey);
    }
  }

  private markLongHorizonRetryCancelled(deliveryKey: string): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    try {
      const eventId = store.getEventIdForDeliveryKey(deliveryKey);
      store.markDeliveryFailed(eventId, deliveryKey, {
        terminal: true,
        reason: 'subscription_no_longer_active',
      });
      store.markEventFailedIfAllDeliveriesTerminal(eventId);
    } catch {
      return;
    }
  }

  private scheduleLongHorizonEventRetry(
    target: LongHorizonSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    failureReason: string
  ): void {
    if (this.externalEventRetryTimers.has(deliveryKey)) return;
    const attempts = (this.externalEventRetryCounts.get(deliveryKey) ?? 0) + 1;
    this.externalEventRetryCounts.set(deliveryKey, attempts);
    if (attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS) {
      this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: true,
        reason: `retry_exhausted; ${failureReason}`,
      });
      this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(event.eventId);
      this.clearExternalEventRetry(deliveryKey);
      return;
    }
    const timer = setTimeout(() => {
      this.externalEventRetryTimers.delete(deliveryKey);
      if (this.config.externalEventStore?.isDeliveryTerminal(event.eventId, deliveryKey)) {
        this.clearExternalEventRetry(deliveryKey);
        return;
      }
      if (this.externalEventDeliveriesInFlight.has(deliveryKey)) {
        this.queueHealthMetrics.recordClaimConflict();
        this.scheduleLongHorizonEventRetry(target, event, deliveryKey, failureReason);
        return;
      }
      void this.deliverToLongHorizonAgent(target, event, deliveryKey);
    }, EXTERNAL_EVENT_RETRY_DELAY_MS);
    this.externalEventRetryTimers.set(deliveryKey, timer);
  }

  private async enqueueDeliverableExternalEvent(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    createdAt = Date.now(),
    allowTargetSessionFallback = false
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (
      !store ||
      store.isDeliveryTerminal(event.eventId, deliveryKey) ||
      this.externalEventDeliveriesInFlight.has(deliveryKey)
    ) {
      return;
    }
    this.externalEventDeliveriesInFlight.add(deliveryKey);
    let retainClaim = false;
    try {
      if (!this.isTargetStillSubscribed(target, event.topic)) {
        store.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        return;
      }

      const now = Date.now();
      const rateLimitKey = this.buildRateLimitKey(target);
      const state = this.getExternalEventRateLimitState(rateLimitKey);
      state.timestamps = state.timestamps.filter(
        (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
      );
      state.timestamps.push(now);
      if (state.timestamps.length > EXTERNAL_EVENT_RATE_LIMIT_PER_MIN) {
        state.pendingDigest.push({
          target,
          event,
          deliveryKey,
          deliveryMode,
          createdAt,
          allowTargetSessionFallback,
        });
        retainClaim = true;
        if (!state.digestTimer) {
          state.digestTimer = setTimeout(() => {
            state.digestTimer = null;
            void this.flushExternalEventDigest(rateLimitKey);
          }, 0);
        }
        return;
      }

      const taskDecision = this.prepareExternalEventTask(target, event);
      if (taskDecision.action === 'fail') {
        store.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: taskDecision.reason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        return;
      }
      if (taskDecision.action === 'hold') {
        this.queueHealthMetrics.recordPausedSpaceSkip();
        this.queueForPendingNode(target, event, deliveryKey, deliveryMode, createdAt);
        return;
      }

      await this.deliverToSession(target, event, deliveryKey, deliveryMode, createdAt);
      this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
    } finally {
      if (!retainClaim) this.externalEventDeliveriesInFlight.delete(deliveryKey);
    }
  }

  private async flushExternalEventDigest(rateLimitKey: string): Promise<void> {
    const state = this.externalEventRateLimits.get(rateLimitKey);
    if (!state || state.pendingDigest.length === 0) return;
    const now = Date.now();
    const digestItems = state.pendingDigest.splice(0);
    state.timestamps = state.timestamps.filter(
      (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
    );
    if (state.digestTimer) {
      clearTimeout(state.digestTimer);
      state.digestTimer = null;
    }
    this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
    await this.deliverDigestToSession(digestItems);
  }

  private async deliverDigestToSession(items: ExternalEventDigestItem[]): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store || items.length === 0) return;
    const dispatchable: ExternalEventDigestItem[] = [];
    for (const item of items) {
      if (store.isDeliveryTerminal(item.event.eventId, item.deliveryKey)) {
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      if (!this.isTargetStillSubscribed(item.target, item.event.topic)) {
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      const taskDecision = this.prepareExternalEventTask(item.target, item.event);
      if (taskDecision.action === 'fail') {
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: true,
          reason: taskDecision.reason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      if (taskDecision.action === 'hold') {
        this.queueHealthMetrics.recordPausedSpaceSkip();
        this.preservePendingDigestItem(item);
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      dispatchable.push(item);
    }
    if (dispatchable.length === 0) return;
    items = dispatchable;
    const target = this.resolveDigestDeliveryTarget(items[0]!);
    const pausedRun = target.workflowRunId
      ? this.config.workflowRunRepo.getRun(target.workflowRunId)
      : null;
    const spacePaused = !!(pausedRun && this.pausedSpaceIds.has(pausedRun.spaceId));
    if (!target.sessionId || spacePaused) {
      const sessionLoss = !target.sessionId;
      const reason = spacePaused ? 'space_paused' : 'session loss';
      for (const item of items) {
        if (sessionLoss) this.queueHealthMetrics.recordStaleSessionSkip();
        else this.queueHealthMetrics.recordPausedSpaceSkip();
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: false,
          reason: `deliveryMode:${item.deliveryMode}; digest requeued after ${reason}`,
        });
        this.queueForPendingNode(
          item.target,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          item.createdAt
        );
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
      }
      if (sessionLoss) {
        log.debug('SpaceRuntime: external event digest requeued — target session not live', {
          runId: target.workflowRunId,
          count: items.length,
        });
      }
      return;
    }
    const deliveryKeys = items.map((item) => item.deliveryKey);
    for (const deliveryKey of deliveryKeys) {
      this.externalEventDeliveriesInFlight.add(deliveryKey);
    }
    try {
      if (!this.config.commandBus) {
        throw new MissingCommandHandlerError('agent.message.inject');
      }
      const digestMessage = this.formatExternalEventDigestMessage(items);
      const result = await this.config.commandBus.dispatch('agent.message.inject', {
        sessionId: target.sessionId,
        message: digestMessage,
        deliveryMode: items.some((item) => item.deliveryMode === 'immediate')
          ? 'immediate'
          : 'defer',
        metadata: {
          workflowRunId: target.workflowRunId,
          taskId: target.taskId,
          nodeId: target.nodeId,
          agentName: target.agentName,
          source: 'external_event_digest',
          eventIds: items.map((item) => item.event.eventId),
          topics: [...new Set(items.map((item) => item.event.topic))],
        },
      });
      if (!result?.ok) {
        throw new Error(formatCommandError(result?.error ?? 'agent.message.inject unavailable'));
      }
      for (const item of items) {
        this.clearExternalEventRetry(item.deliveryKey);
        this.clearQueuedDelivery(item.target, item.deliveryKey);
        store.markDeliveryDelivered(item.event.eventId, item.deliveryKey);
        store.markEventDeliveredIfAllDeliveriesDelivered(item.event.eventId);
        store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
      }
    } catch (err) {
      const rawFailureReason = err instanceof Error ? err.message : String(err);
      const terminal = err instanceof MissingCommandHandlerError;
      for (const item of items) {
        const failureReason = `deliveryMode:${item.deliveryMode}; digest; ${rawFailureReason}`;
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal,
          reason: failureReason,
        });
        if (terminal) {
          this.clearExternalEventRetry(item.deliveryKey);
          this.clearQueuedDelivery(item.target, item.deliveryKey);
          store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
          continue;
        }
        this.queueForRetry(
          target,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          failureReason,
          item.createdAt
        );
      }
    } finally {
      for (const deliveryKey of deliveryKeys) {
        this.externalEventDeliveriesInFlight.delete(deliveryKey);
      }
    }
  }

  private resolveDigestDeliveryTarget(item: ExternalEventDigestItem): WorkflowSubscriptionTarget {
    const target = item.target;
    const liveTarget = this.resolveLiveDeliveryTarget({
      workflowRunId: target.workflowRunId,
      taskId: target.taskId,
      nodeId: target.nodeId,
      agentName: target.agentName,
    });
    if (liveTarget?.sessionId) return liveTarget;
    if (
      item.allowTargetSessionFallback &&
      target.sessionId &&
      this.isTargetSessionLive(target.sessionId)
    ) {
      return target;
    }
    return {
      workflowRunId: target.workflowRunId,
      taskId: target.taskId,
      nodeId: target.nodeId,
      agentName: target.agentName,
    };
  }

  private async deliverToSession(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    fallbackCreatedAt?: number
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store || !target.sessionId) return;
    const pausedRun = this.config.workflowRunRepo.getRun(target.workflowRunId);
    if (pausedRun && this.pausedSpaceIds.has(pausedRun.spaceId)) {
      this.queueHealthMetrics.recordPausedSpaceSkip();
      return;
    }
    this.externalEventDeliveriesInFlight.add(deliveryKey);
    try {
      if (!this.config.commandBus) {
        throw new MissingCommandHandlerError('agent.message.inject');
      }
      const result = await this.config.commandBus.dispatch('agent.message.inject', {
        sessionId: target.sessionId,
        message: formatExternalEventEssence(event),
        deliveryMode,
        metadata: {
          workflowRunId: target.workflowRunId,
          taskId: target.taskId,
          nodeId: target.nodeId,
          agentName: target.agentName,
          source: 'external_event',
          eventId: event.eventId,
          topic: event.topic,
        },
      });
      if (!result?.ok) {
        throw new Error(formatCommandError(result?.error ?? 'agent.message.inject unavailable'));
      }
      this.clearExternalEventRetry(deliveryKey);
      this.clearQueuedDelivery(target, deliveryKey);
      store.markDeliveryDelivered(event.eventId, deliveryKey);
      store.markEventDeliveredIfAllDeliveriesDelivered(event.eventId);
      store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
    } catch (err) {
      const rawFailureReason = err instanceof Error ? err.message : String(err);
      const failureReason = `deliveryMode:${deliveryMode}; ${rawFailureReason}`;
      const terminal = err instanceof MissingCommandHandlerError;
      store.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal,
        reason: failureReason,
      });
      if (terminal) {
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        return;
      }
      this.armDeliveryCooldown(deliveryKey);
      const queued = this.getQueuedDelivery(target, deliveryKey);
      this.queueForRetry(
        target,
        event,
        deliveryKey,
        deliveryMode,
        failureReason,
        queued?.createdAt ?? fallbackCreatedAt
      );
    } finally {
      this.externalEventDeliveriesInFlight.delete(deliveryKey);
    }
  }

  private scheduleActivationRetry(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    failureReason: string,
    options: { preserveAttemptCount?: boolean; markFailure?: boolean } = {}
  ): void {
    if (this.externalEventRetryTimers.has(deliveryKey)) return;
    let attempts = this.externalEventRetryCounts.get(deliveryKey) ?? 0;
    if (!options.preserveAttemptCount) {
      attempts += 1;
      this.externalEventRetryCounts.set(deliveryKey, attempts);
    }
    if (options.markFailure !== false) {
      this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS,
        reason: failureReason,
      });
    }
    if (attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS) {
      this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(event.eventId);
      this.clearExternalEventRetry(deliveryKey);
      this.clearQueuedDelivery(target, deliveryKey);
      return;
    }
    const timer = setTimeout(() => {
      this.externalEventRetryTimers.delete(deliveryKey);
      if (this.config.externalEventStore?.isDeliveryTerminal(event.eventId, deliveryKey)) {
        this.clearExternalEventRetry(deliveryKey);
        return;
      }
      const eventRecord = this.config.externalEventStore?.getById(event.eventId);
      const queuedItem = this.getQueuedDelivery(target, deliveryKey) ?? {
        event,
        deliveryKey,
        deliveryMode: 'immediate',
        createdAt: eventRecord?.createdAt ?? Date.now(),
      };
      const ttlAnchor = eventRecord?.createdAt ?? queuedItem.createdAt;
      if (this.isQueuedExternalEventExpired({ ...queuedItem, createdAt: ttlAnchor })) {
        this.failQueuedDeliveryForTtl(
          { ...queuedItem, createdAt: ttlAnchor },
          this.buildQueueKey(target)
        );
        return;
      }
      void this.deliverExternalEventToWorkflowTarget(target, event, deliveryKey);
    }, EXTERNAL_EVENT_RETRY_DELAY_MS);
    this.externalEventRetryTimers.set(deliveryKey, timer);
  }

  private queueForRetry(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    failureReason: string,
    createdAt = Date.now()
  ): void {
    const queuedItem = { event, deliveryKey, deliveryMode, createdAt };
    if (this.isQueuedExternalEventExpired(queuedItem)) {
      this.failQueuedDeliveryForTtl(queuedItem, this.buildQueueKey(target));
      return;
    }
    this.queueForPendingNode(target, event, deliveryKey, deliveryMode, createdAt);
    this.scheduleExternalEventRetry(target, event, deliveryKey, deliveryMode, failureReason, {
      createdAt,
    });
  }

  private scheduleExternalEventRetry(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    failureReason: string,
    options: { preserveAttemptCount?: boolean; createdAt?: number } = {}
  ): void {
    if (!target.sessionId || this.externalEventRetryTimers.has(deliveryKey)) return;
    const currentAttempts = this.externalEventRetryCounts.get(deliveryKey) ?? 0;
    const attempts = options.preserveAttemptCount ? currentAttempts : currentAttempts + 1;
    this.externalEventRetryCounts.set(deliveryKey, attempts);
    if (attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS) {
      this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: true,
        reason: failureReason,
      });
      this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(event.eventId);
      this.clearQueuedDelivery(target, deliveryKey);
      this.clearExternalEventRetry(deliveryKey);
      return;
    }

    const timer = setTimeout(() => {
      this.externalEventRetryTimers.delete(deliveryKey);
      if (this.config.externalEventStore?.isDeliveryTerminal(event.eventId, deliveryKey)) {
        this.clearExternalEventRetry(deliveryKey);
        return;
      }
      if (this.externalEventDeliveriesInFlight.has(deliveryKey)) {
        this.queueHealthMetrics.recordClaimConflict();
        this.scheduleExternalEventRetry(target, event, deliveryKey, deliveryMode, failureReason, {
          preserveAttemptCount: true,
          createdAt: options.createdAt,
        });
        return;
      }
      const eventRecord = this.config.externalEventStore?.getById(event.eventId);
      const queued = this.getQueuedDelivery(target, deliveryKey);
      const queuedItem = queued ?? {
        event,
        deliveryKey,
        deliveryMode,
        createdAt: eventRecord?.createdAt ?? options.createdAt ?? Date.now(),
      };
      const ttlAnchor = eventRecord?.createdAt ?? queuedItem.createdAt;
      if (this.isQueuedExternalEventExpired({ ...queuedItem, createdAt: ttlAnchor })) {
        this.failQueuedDeliveryForTtl(
          { ...queuedItem, createdAt: ttlAnchor },
          this.buildQueueKey(target)
        );
        return;
      }
      void this.deliverExternalEventToWorkflowTarget(target, event, deliveryKey);
    }, EXTERNAL_EVENT_RETRY_DELAY_MS);
    this.externalEventRetryTimers.set(deliveryKey, timer);
  }

  private rescheduleQueuedExternalEventRetries(): void {
    for (const [queueKey, queue] of Array.from(this.pendingExternalEventQueue.entries())) {
      const target = parseSubscriptionQueueKey(queueKey);
      if (!target) continue;
      for (const item of queue) {
        const eventRecord = this.config.externalEventStore?.getById(item.event.eventId);
        const ttlAnchor = eventRecord?.createdAt ?? item.createdAt;
        if (this.isQueuedExternalEventExpired({ ...item, createdAt: ttlAnchor })) {
          this.failQueuedDeliveryForTtl({ ...item, createdAt: ttlAnchor }, queueKey);
          continue;
        }
        const resolved = this.resolveSubscriptionTarget(target);
        if (!resolved.sessionId) continue;
        this.scheduleExternalEventRetry(
          resolved,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          `deliveryMode:${item.deliveryMode}; retry rescheduled after runtime restart`,
          { preserveAttemptCount: true, createdAt: ttlAnchor }
        );
      }
    }
  }

  private clearExternalEventRetry(deliveryKey: string): void {
    const timer = this.externalEventRetryTimers.get(deliveryKey);
    if (timer) clearTimeout(timer);
    this.externalEventRetryTimers.delete(deliveryKey);
    this.externalEventRetryCounts.delete(deliveryKey);
  }

  private getQueuedDelivery(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>,
    deliveryKey: string
  ): PendingExternalEvent | undefined {
    return this.pendingExternalEventQueue
      .get(this.buildQueueKey(target))
      ?.find((item) => item.deliveryKey === deliveryKey);
  }

  private clearQueuedDelivery(target: WorkflowSubscriptionTarget, deliveryKey: string): void {
    this.clearQueuedDeliveryByKey(this.buildQueueKey(target), deliveryKey);
  }

  private clearQueuedDeliveryByKey(key: string, deliveryKey: string): void {
    const queue = this.pendingExternalEventQueue.get(key);
    if (!queue) return;
    const remaining = queue.filter((item) => item.deliveryKey !== deliveryKey);
    if (remaining.length === 0) {
      this.pendingExternalEventQueue.delete(key);
    } else {
      this.pendingExternalEventQueue.set(key, remaining);
    }
  }

  private preservePendingDigestItem(item: ExternalEventDigestItem): void {
    const key = this.buildQueueKey(item.target);
    const queue = this.pendingExternalEventQueue.get(key) ?? [];
    if (queue.some((queued) => queued.deliveryKey === item.deliveryKey)) return;
    queue.push({
      event: item.event,
      deliveryKey: item.deliveryKey,
      deliveryMode: item.deliveryMode,
      createdAt: item.createdAt,
    });
    this.pendingExternalEventQueue.set(key, queue);
    this.queueHealthMetrics.recordEnqueue(
      item.event.source,
      this.describeEnqueueTargetState(item.target)
    );
  }

  private queueForPendingNode(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    createdAt = Date.now()
  ): void {
    const key = this.buildQueueKey(target);
    const queue = this.pendingExternalEventQueue.get(key) ?? [];
    if (queue.some((item) => item.deliveryKey === deliveryKey)) return;
    if (queue.length >= 50) {
      const dropped = queue.shift();
      if (dropped && this.config.externalEventStore) {
        this.config.externalEventStore.markDeliveryFailed(
          dropped.event.eventId,
          dropped.deliveryKey,
          {
            terminal: true,
            reason: 'pending_node_queue_overflow',
          }
        );
        this.config.externalEventStore.markEventFailedIfAllDeliveriesTerminal(
          dropped.event.eventId
        );
        this.clearExternalEventRetry(dropped.deliveryKey);
      }
      log.warn(
        `SpaceRuntime: pending external event queue overflow for ${key}; dropped oldest event`
      );
    }
    queue.push({ event, deliveryKey, deliveryMode, createdAt });
    this.pendingExternalEventQueue.set(key, queue);
    this.queueHealthMetrics.recordEnqueue(event.source, this.describeEnqueueTargetState(target));
  }

  private describeEnqueueTargetState(target: WorkflowSubscriptionTarget): string {
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    const nodeStatus = this.getCurrentQueueableOrActiveExecution(target)?.status ?? 'none';
    return `run=${run?.status ?? 'unknown'};node=${nodeStatus}`;
  }

  getQueueHealthSnapshot(): QueueHealthSnapshot {
    const now = Date.now();
    let queueDepth = 0;
    const inMemoryAges: number[] = [];
    for (const queue of this.pendingExternalEventQueue.values()) {
      queueDepth += queue.length;
      for (const item of queue) inMemoryAges.push(now - item.createdAt);
    }
    let digestBacklog = 0;
    for (const state of this.externalEventRateLimits.values()) {
      digestBacklog += state.pendingDigest.length;
    }
    const store = this.config.externalEventStore;
    const persisted = store ? store.summarizePendingDeliveries(now) : null;
    const gauges: QueueHealthGauges = {
      queueDepth,
      queueKeys: this.pendingExternalEventQueue.size,
      inFlight: this.externalEventDeliveriesInFlight.size,
      digestBacklog,
      retryTimers: this.externalEventRetryTimers.size,
      persistedPending: persisted?.count ?? 0,
      queueAgeMs: computeQueueAgeStats(inMemoryAges),
      persistedAgeMs: persisted,
    };
    return this.queueHealthMetrics.snapshot(gauges, now);
  }

  private isQueuedExternalEventExpired(item: PendingExternalEvent, now = Date.now()): boolean {
    return isQueuedExternalEventExpired(item.createdAt, now, EXTERNAL_EVENT_QUEUE_TTL_MS);
  }

  private isPublishedExternalEventExpired(
    payload: ExternalEventPublishedPayload,
    now = Date.now()
  ): boolean {
    const createdAt = this.config.externalEventStore?.getById(payload.eventId)?.createdAt;
    return isPublishedExternalEventExpired(createdAt, now, EXTERNAL_EVENT_QUEUE_TTL_MS);
  }

  private failQueuedDeliveryForTtl(item: PendingExternalEvent, queueKey: string): void {
    this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
      terminal: true,
      reason: 'ttl_expired',
    });
    this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
    this.clearExternalEventRetry(item.deliveryKey);
    this.clearQueuedDeliveryByKey(queueKey, item.deliveryKey);
    log.warn(
      `SpaceRuntime: dropped expired external event ${item.event.eventId} from pending queue ${queueKey}`
    );
  }

  private failQueuedDeliveriesForTarget(
    target: Omit<WorkflowSubscriptionTarget, 'sessionId'>,
    reason: string
  ): void {
    const key = this.buildQueueKey(target);
    const queued = this.pendingExternalEventQueue.get(key);
    if (queued) {
      this.failQueuedDeliveries(queued, reason);
      for (const item of queued) {
        this.clearExternalEventRetry(item.deliveryKey);
      }
      this.pendingExternalEventQueue.delete(key);
    }

    const store = this.config.externalEventStore;
    if (!store) return;
    for (const delivery of store.listPendingDeliveries(target.workflowRunId)) {
      if (
        delivery.taskId !== target.taskId ||
        delivery.nodeId !== target.nodeId ||
        delivery.agentName !== target.agentName
      ) {
        continue;
      }
      const eventRecord = store.getById(delivery.eventId);
      if (eventRecord?.event && this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        continue;
      }
      store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, { terminal: true, reason });
      store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
      this.clearExternalEventRetry(delivery.deliveryKey);
    }
  }

  private clearQueuedDeliveriesForRun(workflowRunId: string, reason: string): void {
    const store = this.config.externalEventStore;
    for (const [queueKey, queued] of this.pendingExternalEventQueue) {
      const parsed = parseSubscriptionQueueKey(queueKey);
      if (!parsed || parsed.workflowRunId !== workflowRunId) continue;
      this.failQueuedDeliveries(queued, reason);
      for (const item of queued) {
        this.clearExternalEventRetry(item.deliveryKey);
      }
      this.pendingExternalEventQueue.delete(queueKey);
    }
    if (!store) return;
    for (const delivery of store.listPendingDeliveries(workflowRunId)) {
      store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, { terminal: true, reason });
      store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
      this.clearExternalEventRetry(delivery.deliveryKey);
    }
  }

  private clearQueuedDeliveriesForTask(taskId: string): void {
    const store = this.config.externalEventStore;
    for (const [queueKey, queued] of this.pendingExternalEventQueue) {
      const parsed = parseSubscriptionQueueKey(queueKey);
      if (!parsed || parsed.taskId !== taskId) continue;
      this.failQueuedDeliveries(queued, 'task_terminal_cleanup');
      for (const item of queued) {
        this.clearExternalEventRetry(item.deliveryKey);
      }
      this.pendingExternalEventQueue.delete(queueKey);
    }
    if (!store) return;
    for (const delivery of store.listPendingDeliveries()) {
      if (delivery.taskId !== taskId) continue;
      store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
        terminal: true,
        reason: 'task_terminal_cleanup',
      });
      store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
      this.clearExternalEventRetry(delivery.deliveryKey);
    }
  }

  private failQueuedDeliveries(queued: PendingExternalEvent[], reason: string): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    for (const item of queued) {
      store.markDeliveryFailed(item.event.eventId, item.deliveryKey, { terminal: true, reason });
      store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
    }
  }

  private resolveSubscriptionTarget(
    target: WorkflowSubscriptionTarget
  ): WorkflowSubscriptionTarget {
    return resolveSubscriptionTarget(
      this.config.nodeExecutionRepo.listByNode(target.workflowRunId, target.nodeId),
      target
    );
  }

  private resolveLiveDeliveryTarget(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): WorkflowSubscriptionTarget | null {
    return resolveLiveDeliveryTarget(
      this.config.nodeExecutionRepo.listByNode(target.workflowRunId, target.nodeId),
      target
    );
  }

  private isRunInterestRebuildEligible(run: SpaceWorkflowRun): boolean {
    return this.isRunInterestRebuildEligibleWithTasks(
      run,
      this.config.taskRepo.listByWorkflowRunIncludingArchived(run.id)
    );
  }

  private isRunInterestRebuildEligibleWithTasks(
    run: SpaceWorkflowRun,
    runTasks: SpaceTask[]
  ): boolean {
    if (run.status === 'cancelled' || isWorkflowRunSucceeded(run.status)) {
      return false;
    }
    const task = this.pickCanonicalTaskForRun(run, runTasks);
    return (
      !!task && task.status !== 'cancelled' && task.status !== 'archived' && task.status !== 'done'
    );
  }

  private isWorkflowTargetOwnedBySpace(
    target: WorkflowSubscriptionTarget,
    spaceId: string
  ): boolean {
    const task = this.config.taskRepo.getTask(target.taskId);
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    return isWorkflowTargetOwnedBySpace(task, run, spaceId);
  }

  private prepareExternalEventTask(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ): ExternalEventTaskDecision {
    const task = this.config.taskRepo.getTask(target.taskId);
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    return prepareExternalEventTask(task, run, event);
  }

  private evaluateRequeueTaskLifecycle(
    target: Pick<WorkflowSubscriptionTarget, 'taskId'>,
    event: { topic: string; source: string }
  ): string | null {
    const task = this.config.taskRepo.getTask(target.taskId);
    return evaluateRequeueTaskLifecycle(task, event);
  }

  private getCurrentQueueableOrActiveExecution(
    target: WorkflowSubscriptionTarget
  ): NodeExecution | undefined {
    return resolveCurrentQueueableOrActiveExecution(
      this.config.nodeExecutionRepo.listByNode(target.workflowRunId, target.nodeId),
      target
    );
  }

  private isTargetSessionLive(sessionId: string): boolean {
    return this.config.taskAgentManager?.isSessionAlive(sessionId) ?? false;
  }

  private async normalizeStaleInterruptedSession(sessionId: string): Promise<void> {
    const session = this.config.taskAgentManager?.getAgentSessionById?.(sessionId);
    await session?.normalizeStaleInterruptedState();
  }

  private isTargetSessionInterrupted(sessionId: string): boolean {
    const session = this.config.taskAgentManager?.getAgentSessionById?.(sessionId);
    if (session?.getProcessingState().status !== 'interrupted') return false;
    return session.isInterruptInProgress();
  }

  private parkDeliveryForInterruptedSession(
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string,
    createdAt: number
  ): boolean {
    if (!target.sessionId || !this.isTargetSessionInterrupted(target.sessionId)) return false;
    this.queueForPendingNode(target, payload, deliveryKey, 'defer', createdAt);
    this.scheduleActivationRetry(
      target,
      payload,
      deliveryKey,
      'deliveryMode:defer; target_session_interrupted',
      {
        preserveAttemptCount: true,
      }
    );
    return true;
  }

  private hasTerminalExecutionForTarget(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): boolean {
    return hasTerminalExecutionForTarget(
      this.config.nodeExecutionRepo.listByNode(target.workflowRunId, target.nodeId),
      target
    );
  }

  private hasAnyExecutionForTarget(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): boolean {
    return hasAnyExecutionForTarget(
      this.config.nodeExecutionRepo.listByNode(target.workflowRunId, target.nodeId),
      target
    );
  }

  private buildQueueKey(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): string {
    return buildQueueKey(target);
  }

  private isDeliveryInDeliveryCooldown(deliveryKey: string): boolean {
    const lastFailureAt = this.externalEventDeliveryCooldowns.get(deliveryKey);
    if (lastFailureAt === undefined) return false;
    if (Date.now() - lastFailureAt < this.deliveryCooldownMs) return true;
    this.externalEventDeliveryCooldowns.delete(deliveryKey);
    return false;
  }

  private armDeliveryCooldown(deliveryKey: string): void {
    const map = this.externalEventDeliveryCooldowns;
    map.set(deliveryKey, Date.now());
    if (map.size > this.deliveryCooldownMapCap) {
      const now = Date.now();
      for (const [key, lastFailureAt] of map) {
        if (now - lastFailureAt >= this.deliveryCooldownMs) map.delete(key);
      }
    }
  }

  private getExternalEventRateLimitState(rateLimitKey: string): ExternalEventRateLimitState {
    const existing = this.externalEventRateLimits.get(rateLimitKey);
    if (existing) {
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = null;
      }
      return existing;
    }
    const created = {
      timestamps: [],
      pendingDigest: [],
      digestTimer: null,
      cleanupTimer: null,
    };
    this.externalEventRateLimits.set(rateLimitKey, created);
    return created;
  }

  private scheduleExternalEventRateLimitCleanup(rateLimitKey: string): void {
    const state = this.externalEventRateLimits.get(rateLimitKey);
    if (!state || state.pendingDigest.length > 0 || state.cleanupTimer) return;
    const now = Date.now();
    state.timestamps = state.timestamps.filter(
      (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
    );
    if (state.timestamps.length === 0) {
      this.externalEventRateLimits.delete(rateLimitKey);
      return;
    }
    const oldest = Math.min(...state.timestamps);
    state.cleanupTimer = setTimeout(
      () => {
        const current = this.externalEventRateLimits.get(rateLimitKey);
        if (!current) return;
        current.cleanupTimer = null;
        if (current.pendingDigest.length > 0) return;
        const cleanupNow = Date.now();
        current.timestamps = current.timestamps.filter(
          (timestamp) => cleanupNow - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
        );
        if (current.timestamps.length === 0) {
          this.externalEventRateLimits.delete(rateLimitKey);
        } else {
          this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
        }
      },
      Math.max(0, EXTERNAL_EVENT_RATE_WINDOW_MS - (now - oldest) + 1)
    );
  }

  private buildRateLimitKey(target: WorkflowSubscriptionTarget): string {
    const executionId = this.getCurrentQueueableOrActiveExecution(target)?.id;
    return executionId ?? `${target.workflowRunId}:${target.nodeId}:${target.agentName}`;
  }

  private buildDeliveryKey(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ): string {
    return JSON.stringify([
      event.source,
      event.dedupeKey,
      target.taskId,
      target.nodeId,
      target.agentName,
      target.workflowRunId,
    ]);
  }

  private buildLongHorizonDeliveryKey(
    target: LongHorizonSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ): string {
    return JSON.stringify([
      'long_horizon_agent',
      event.source,
      event.dedupeKey,
      target.spaceId,
      target.agentId,
      target.subscriptionId,
    ]);
  }

  private parseLongHorizonDeliveryKey(deliveryKey: string): LongHorizonSubscriptionTarget | null {
    try {
      const parsed = JSON.parse(deliveryKey) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== 'long_horizon_agent') {
        return null;
      }
      const [, , , spaceId, agentId, subscriptionId] = parsed;
      if (
        typeof spaceId !== 'string' ||
        typeof agentId !== 'string' ||
        typeof subscriptionId !== 'string'
      ) {
        return null;
      }
      return {
        kind: 'long_horizon_agent',
        spaceId,
        agentId,
        source: '',
        topic: '',
        subscriptionId,
      };
    } catch {
      return null;
    }
  }

  private formatExternalEventDigestMessage(items: ExternalEventDigestItem[]): string {
    const topics = [...new Set(items.map((item) => item.event.topic))].sort();
    const occurredAtValues = items.map((item) => item.event.occurredAt);
    const oldest = new Date(Math.min(...occurredAtValues)).toISOString();
    const newest = new Date(Math.max(...occurredAtValues)).toISOString();
    const eventIds = JSON.stringify(
      items.map((item) => ({ id: item.event.eventId, topic: item.event.topic }))
    );
    return (
      `${items.length} events received for topics: ${topics.join(', ')} ` +
      `(oldest: ${oldest}, newest: ${newest}). ` +
      `Event IDs: ${eventIds}. ` +
      `Use get_external_event(eventId) for full details.`
    );
  }

  emitTaskThreadEvent(sessionId: string, subtype: string, payload: Record<string, unknown>): void {
    try {
      const message = {
        type: 'system',
        subtype,
        session_id: sessionId,
        uuid: `${subtype}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...payload,
      } as unknown as Parameters<SDKMessageRepository['saveSDKMessage']>[1];
      this.getSdkMessageRepo().saveSDKMessage(sessionId, message);
    } catch (err) {
      log.warn(
        `[SpaceRuntime] Failed to emit thread event ${subtype} on session ${sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  getNotifiedTaskSet(): ReadonlySet<string> {
    return new Set(this.notifiedTaskSet);
  }

  setTaskAgentManager(manager: TaskAgentManager): void {
    this.config.taskAgentManager = manager;
    manager.attachToolContinuationRepo?.(this.toolContinuationRepo);
  }

  private postApprovalRouter: PostApprovalRouter | null = null;

  private getPostApprovalRouter(): PostApprovalRouter | null {
    if (this.postApprovalRouter) return this.postApprovalRouter;
    const manager = this.config.taskAgentManager;
    if (!manager) return null;
    this.postApprovalRouter = new PostApprovalRouter({
      taskRepo: this.config.taskRepo,
      resolveCompletionOutcome: (task) => {
        const artifactSummary = task.workflowRunId
          ? this.resolvePrimaryResultArtifactSummary(task.workflowRunId)
          : undefined;
        return this.buildTaskOutcomeUpdates(
          task,
          artifactSummary ??
            normalizeMeaningfulTaskResult(task.result) ??
            normalizeMeaningfulTaskResult(task.reportedSummary),
          artifactSummary ?? normalizeMeaningfulTaskResult(task.reportedSummary)
        );
      },
      spawner: {
        spawnPostApprovalSubSession: (args) => manager.spawnPostApprovalSubSession(args),
      },
      livenessProbe: {
        isSessionAlive: (sessionId) => manager.isSessionAlive(sessionId),
      },
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
    });
    return this.postApprovalRouter;
  }

  async dispatchPostApproval(
    taskId: string,
    approvalSource: SpaceApprovalSource,
    contextExtras: Omit<PostApprovalRouteContext, 'approvalSource'> = {}
  ): Promise<PostApprovalRouteResult> {
    const router = this.getPostApprovalRouter();
    if (!router) {
      const reason = `PostApprovalRouter not wired yet (taskAgentManager missing); task=${taskId}`;
      log.warn(`dispatchPostApproval: ${reason}`);
      return { mode: 'skipped', reason };
    }

    const current = this.config.taskRepo.getTask(taskId);
    if (!current) {
      const reason = `task ${taskId} not found`;
      log.warn(`dispatchPostApproval: ${reason}`);
      return { mode: 'skipped', reason };
    }

    if (current.status !== 'approved' && !isValidSpaceTaskTransition(current.status, 'approved')) {
      const reason = `task ${taskId} in status '${current.status}' cannot transition to approved`;
      log.warn(`dispatchPostApproval: ${reason}`);
      return { mode: 'skipped', reason };
    }

    const spaceId = current.spaceId;
    const space = await this.config.spaceManager.getSpace(spaceId);
    const run = current.workflowRunId
      ? this.config.workflowRunRepo.getRun(current.workflowRunId)
      : null;
    const workflow = run ? (this.config.spaceWorkflowManager.getWorkflowForRun(run) ?? null) : null;

    const resolvedApprovalReason =
      typeof contextExtras.approvalReason === 'string'
        ? contextExtras.approvalReason
        : contextExtras.approvalReason === null
          ? null
          : undefined;
    let approvedTask: SpaceTask = current;
    if (current.status !== 'approved') {
      const taskManager = this.getOrCreateTaskManager(spaceId);
      approvedTask = await taskManager.setTaskStatus(taskId, 'approved', {
        approvalSource,
        approvalReason: resolvedApprovalReason,
      });
      await this.safeOnTaskUpdated(spaceId, approvedTask);
      log.info(
        `task.status-transition: taskId=${taskId} from=${current.status} to=approved source=${approvalSource}`
      );
    }

    let resolvedPrUrl: string | undefined;
    if (approvedTask.workflowRunId) {
      resolvedPrUrl =
        this.config.artifactProfile?.resolveInitialPrimaryLinkUrl?.(approvedTask.workflowRunId) ||
        undefined;
    }
    const overridePrUrl =
      typeof contextExtras.pr_url === 'string' ? contextExtras.pr_url : undefined;
    if (overridePrUrl && resolvedPrUrl && overridePrUrl !== resolvedPrUrl) {
      throw new Error(
        `Post-approval PR URL override ${overridePrUrl} does not match the reviewed run PR ${resolvedPrUrl}`
      );
    }
    const approvalAuthorityNodeId =
      approvedTask.postApprovalSourceNodeId ?? workflow?.endNodeId ?? null;
    const approvalAuthorityNode =
      approvalAuthorityNodeId !== null
        ? (workflow?.nodes.find((n) => n.id === approvalAuthorityNodeId) ?? null)
        : null;
    const approvalAuthorityName = approvalAuthorityNode?.name;
    const routeContext: PostApprovalRouteContext = {
      ...contextExtras,
      ...(resolvedPrUrl ? { pr_url: resolvedPrUrl } : {}),
      task_id: taskId,
      approvalSource,
      approval_source: approvalSource,
      spaceId,
      space_id: spaceId,
      autonomyLevel: space?.autonomyLevel,
      autonomy_level: space?.autonomyLevel,
      workspacePath: space?.workspacePath,
      workspace_path: space?.workspacePath,
      ...(approvalAuthorityName ? { approval_authority: approvalAuthorityName } : {}),
    };
    let routeResult: PostApprovalRouteResult;
    try {
      routeResult = await router.route(approvedTask, workflow, routeContext);
    } finally {
      clearPendingCompletionState(this.config.taskRepo, taskId);
    }

    if (routeResult.mode !== 'skipped') {
      const final = this.config.taskRepo.getTask(taskId);
      if (final) await this.safeOnTaskUpdated(spaceId, final);

      if (routeResult.mode === 'no-route' && final?.status === 'done') {
        try {
          const taskManager = this.getOrCreateTaskManager(spaceId);
          const unblocked = await taskManager.unblockDependentTasks(taskId);
          for (const dep of unblocked) {
            await this.safeOnTaskUpdated(spaceId, dep);
          }
        } catch {}
      }
    }
    return routeResult;
  }

  private async safeNotify(event: SpaceNotificationEvent): Promise<void> {
    if (!this.internalEventBus) return;
    const mapped = mapNotificationEventToInternalEvent(event);
    if (!mapped) return;
    try {
      await this.internalEventBus.publish(
        mapped.event,
        mapped.payload as DaemonInternalEventMap[typeof mapped.event] & InternalEventPayload
      );
    } catch (err) {
      log.warn(
        `[SpaceRuntime] internalEventBus.publish() threw for event "${mapped.event}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async safeOnTaskUpdated(
    spaceId: string,
    task: SpaceTask,
    opts?: { archiveSource?: 'user' | 'system_reconcile'; fromStatus?: SpaceTaskStatus | null }
  ): Promise<void> {
    const handler = this.config.onTaskUpdated;
    if (!handler) return;
    try {
      await handler({
        spaceId,
        task,
        archiveSource: opts?.archiveSource,
        fromStatus: opts?.fromStatus,
      });
    } catch (err) {
      log.warn(
        `[SpaceRuntime] onTaskUpdated threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async safeOnWorkflowRunCreated(spaceId: string, run: SpaceWorkflowRun): Promise<void> {
    const handler = this.config.onWorkflowRunCreated;
    if (!handler) return;
    try {
      await handler({ spaceId, run });
    } catch (err) {
      log.warn(
        `[SpaceRuntime] onWorkflowRunCreated threw for run "${run.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async safeOnWorkflowRunUpdated(spaceId: string, run: SpaceWorkflowRun): Promise<void> {
    const handler = this.config.onWorkflowRunUpdated;
    if (!handler) return;
    try {
      await handler({ spaceId, run });
    } catch (err) {
      log.warn(
        `[SpaceRuntime] onWorkflowRunUpdated threw for run "${run.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async listActiveSpaces(): Promise<import('@hyperneo/shared').Space[]> {
    const spaces = await this.config.spaceManager.listSpaces(false);
    return spaces.filter((s) => !s.paused && !s.stopped);
  }

  private async stopBlockedWorkflowTask(
    spaceId: string,
    task: SpaceTask,
    reason: string
  ): Promise<SpaceTask> {
    if (!task.workflowRunId) return task;

    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (run && canTransitionRunStatus(run.status, 'blocked')) {
      await this.transitionRunStatusAndEmit(run.id, 'blocked');
    }

    const now = Date.now();
    for (const execution of this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId)) {
      if (
        !execution.agentSessionId ||
        execution.status === 'idle' ||
        execution.status === 'cancelled'
      ) {
        continue;
      }
      this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        agentSessionId: null,
        result: reason,
        completedAt: now,
      });
    }

    if (task.taskAgentSessionId) {
      this.config.taskAgentManager?.cancelBySessionId(task.taskAgentSessionId);
    }
    const cleared = this.config.taskRepo.updateTask(task.id, {
      workflowRunId: task.workflowRunId,
      taskAgentSessionId: null,
    });
    if (cleared) {
      await this.safeOnTaskUpdated(spaceId, cleared);
    }
    this.clearAgentStuckStateForRun(task.workflowRunId);
    return cleared ?? task;
  }

  private async stopActiveWorkflowTaskAgents(task: SpaceTask, reason: string): Promise<SpaceTask> {
    if (!task.workflowRunId) return task;

    const now = Date.now();
    const isTerminalCancel = task.status === 'cancelled';
    const cancelledSessionIds = new Set<string>();
    for (const execution of this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId)) {
      if (
        !execution.agentSessionId ||
        execution.status === 'cancelled' ||
        (!isTerminalCancel && execution.status === 'idle')
      ) {
        continue;
      }
      if (!cancelledSessionIds.has(execution.agentSessionId)) {
        this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
        cancelledSessionIds.add(execution.agentSessionId);
      }
      if (execution.status !== 'idle') {
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'cancelled',
          agentSessionId: null,
          result: reason,
          completedAt: now,
        });
      }
    }

    const runTaskIds = this.config.taskRepo.listByWorkflowRun(task.workflowRunId).map((t) => t.id);
    for (const sid of this.config.taskAgentManager?.getLiveSubSessionIdsForTasks?.(runTaskIds) ??
      []) {
      if (cancelledSessionIds.has(sid)) continue;
      this.config.taskAgentManager?.cancelBySessionId(sid);
    }

    if (task.taskAgentSessionId && !cancelledSessionIds.has(task.taskAgentSessionId)) {
      this.config.taskAgentManager?.cancelBySessionId(task.taskAgentSessionId);
    }
    this.clearAgentStuckStateForRun(task.workflowRunId);
    return (
      this.config.taskRepo.updateTask(task.id, {
        workflowRunId: task.workflowRunId,
        taskAgentSessionId: null,
      }) ?? task
    );
  }

  private collectLiveSessionIdsForTask(task: SpaceTask): string[] {
    const tam = this.config.taskAgentManager;
    const ids = new Set<string>();
    const collect = (sessionId: string | null | undefined): void => {
      if (!sessionId || ids.has(sessionId)) return;
      if (tam && !tam.isSessionAlive(sessionId)) return;
      ids.add(sessionId);
    };
    if (task.workflowRunId) {
      for (const execution of this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId)) {
        collect(execution.agentSessionId);
      }
    }
    collect(task.taskAgentSessionId);
    for (const sessionId of tam?.getSubSessionIdsForTasks([task.id]) ?? []) {
      collect(sessionId);
    }
    return [...ids];
  }

  async parkStoppedWorkflowTask(spaceId: string, taskId: string): Promise<SpaceTask | null> {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task || task.spaceId !== spaceId) return null;
    if (!isValidSpaceTaskTransition(task.status, 'stopped')) {
      throw new Error(`Invalid status transition from '${task.status}' to 'stopped'.`);
    }

    const updated = await this.getOrCreateTaskManager(spaceId).setTaskStatus(taskId, 'stopped');
    await this.safeOnTaskUpdated(spaceId, updated);

    const tam = this.config.taskAgentManager;
    const liveSessionIds = this.collectLiveSessionIdsForTask(task);
    let verifiedTotal = 0;
    let verifiedStopped = 0;
    if (tam) {
      if (liveSessionIds.length > 0) {
        try {
          const results = await tam.stopSessionsVerified(liveSessionIds);
          verifiedTotal = results.length;
          verifiedStopped = results.filter((result) => result.stopped).length;
          const failures = results.filter((result) => !result.stopped);
          if (failures.length > 0) {
            log.warn(
              `parkStoppedWorkflowTask: ${failures.length}/${results.length} session(s) for task ${taskId} not confirmed stopped: ` +
                failures
                  .map((failure) => `${failure.sessionId} (${failure.detail ?? 'unknown reason'})`)
                  .join('; ')
            );
          }
        } catch (err) {
          log.error(
            `parkStoppedWorkflowTask: verified session stop failed for task ${taskId}:`,
            err
          );
        }
      }
      await tam.cleanup(taskId, 'stopped').catch((err: unknown) => {
        log.warn(
          `parkStoppedWorkflowTask: failed to cleanup agent session for task ${taskId}:`,
          err
        );
      });
    }

    const parkedRunId = this.parkInFlightExecutionsForTask(taskId);

    log.info(
      `parkStoppedWorkflowTask: task ${taskId} set to stopped first; verified-stopped ` +
        `${verifiedStopped}/${verifiedTotal} session(s) and parked ` +
        `${parkedRunId ? `in-flight executions for run ${parkedRunId}` : 'no run executions'} ` +
        `— run status preserved`
    );
    return updated;
  }

  async stopWorkflowBackedTaskForStatus(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ): Promise<SpaceTask | null> {
    const previous = this.config.taskRepo.getTask(taskId);
    if (!previous) return null;
    const nextStatus = params.status;
    if (nextStatus && previous.status !== nextStatus) {
      assertValidSpaceTaskTransition(previous.status, nextStatus);
      const taskManager = this.getOrCreateTaskManager(spaceId);
      if (Object.hasOwn(params, 'workspacePath')) {
        await taskManager.updateTask(
          taskId,
          { workspacePath: params.workspacePath },
          {
            onCascadedTasks: async () => {},
          }
        );
        delete (params as Record<string, unknown>).workspacePath;
      }
      let updated = await taskManager.setTaskStatus(taskId, nextStatus, {
        result: params.result ?? undefined,
        approvalReason:
          nextStatus === 'cancelled'
            ? (params.cancelReason ?? params.approvalReason ?? undefined)
            : (params.approvalReason ?? undefined),
      });

      const {
        status: _status,
        result: _result,
        approvalReason: _approvalReason,
        cancelReason: _cancelReason,
        ...otherFields
      } = params;
      if (Object.keys(otherFields).length > 0) {
        updated = await taskManager.updateTask(taskId, otherFields);
      }
      if (
        nextStatus === 'cancelled' &&
        (params.cancelReason ?? params.approvalReason) &&
        updated.approvalReason !== (params.cancelReason ?? params.approvalReason)
      ) {
        updated =
          this.config.taskRepo.updateTask(taskId, {
            approvalReason: params.cancelReason ?? params.approvalReason ?? null,
          }) ?? updated;
      }
      if (!previous.workflowRunId) {
        await this.safeOnTaskUpdated(spaceId, updated);
        return updated;
      }

      const reason = params.result ?? updated.result ?? `Task ${nextStatus}`;
      updated = await this.stopActiveWorkflowTaskAgents(
        {
          ...updated,
          workflowRunId: previous.workflowRunId,
          taskAgentSessionId: previous.taskAgentSessionId,
        },
        reason
      );
      await this.safeOnTaskUpdated(spaceId, updated);

      if (nextStatus === 'cancelled') {
        const run = this.config.workflowRunRepo.getRun(previous.workflowRunId);
        if (run && canTransitionRunStatus(run.status, 'cancelled')) {
          await this.transitionRunStatusAndEmit(previous.workflowRunId, 'cancelled');
          updated = await this.stopActiveWorkflowTaskAgents(
            {
              ...updated,
              workflowRunId: previous.workflowRunId,
              taskAgentSessionId: null,
            },
            reason
          );
        }
      } else if (previous.status === 'stopped') {
        this.requeuePendingDeliveriesForRun(previous.workflowRunId);
      }
      return updated;
    }

    const updated = this.config.taskRepo.updateTask(taskId, params);
    if (updated) await this.safeOnTaskUpdated(spaceId, updated);
    return updated;
  }

  async cancelWorkflowRun(spaceId: string, runId: string): Promise<SpaceWorkflowRun> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) throw new Error(`WorkflowRun not found: ${runId}`);
    for (const task of this.config.taskRepo.listByWorkflowRun(runId)) {
      if (task.status === 'approved') {
        await this.stopWorkflowBackedTaskForStatus(spaceId, task.id, { status: 'in_progress' });
        await this.stopWorkflowBackedTaskForStatus(spaceId, task.id, { status: 'cancelled' });
      } else if (isValidSpaceTaskTransition(task.status, 'cancelled')) {
        await this.stopWorkflowBackedTaskForStatus(spaceId, task.id, { status: 'cancelled' });
      } else if (task.status === 'cancelled' && task.workflowRunId) {
        await this.stopActiveWorkflowTaskAgents(task, 'workflow run cancelled');
      }
    }
    const updated = this.config.workflowRunRepo.getRun(runId) ?? run;
    if (updated.status === 'cancelled') {
      this.clearRunInterests(runId);
      return updated;
    }
    if (canTransitionRunStatus(updated.status, 'cancelled')) {
      const cancelled = await this.transitionRunStatusAndEmit(runId, 'cancelled');
      this.clearRunInterests(runId);
      return cancelled;
    }
    return updated;
  }

  async blockWorkflowBackedTask(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ): Promise<SpaceTask | null> {
    return this.updateTaskAndEmit(spaceId, taskId, params);
  }

  private async updateTaskAndEmit(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams,
    opts?: { archiveSource?: 'user' | 'system_reconcile' }
  ): Promise<SpaceTask | null> {
    const previous = this.config.taskRepo.getTask(taskId);
    if (previous && params.status !== undefined && params.status !== previous.status) {
      assertValidSpaceTaskTransition(previous.status, params.status);
    }
    const isTerminal = (status: SpaceTaskStatus): boolean =>
      status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived';
    const reopensFromTerminal =
      previous &&
      params.status !== undefined &&
      isTerminal(previous.status) &&
      !isTerminal(params.status);
    let updated: SpaceTask | null;
    if (reopensFromTerminal) {
      this.config.reactiveDb?.beginTransaction();
      try {
        updated = this.config.db.transaction(() => {
          const result = this.config.taskRepo.updateTask(taskId, params);
          this.config.goalService?.supersedeOutcomeNotificationsForTask(taskId);
          return result;
        })();
        this.config.reactiveDb?.commitTransaction();
      } catch (err) {
        this.config.reactiveDb?.abortTransaction();
        throw err;
      }
    } else {
      updated = this.config.taskRepo.updateTask(taskId, params);
    }
    if (updated) {
      let emitUpdated = true;

      if (params.status === 'blocked') {
        const reason = params.result ?? updated.result ?? 'Task blocked';
        if (params.blockReason === 'dependency_added') {
          updated = await this.stopBlockedWorkflowTask(
            spaceId,
            {
              ...updated,
              workflowRunId: previous?.workflowRunId ?? updated.workflowRunId,
              taskAgentSessionId: previous?.taskAgentSessionId,
            },
            reason
          );
          emitUpdated = false;
          await this.safeNotify({
            kind: 'task_blocked',
            spaceId,
            taskId: updated.id,
            reason,
            timestamp: new Date().toISOString(),
          });
          if (updated.workflowRunId) {
            await this.safeNotify({
              kind: 'workflow_run_blocked',
              spaceId,
              runId: updated.workflowRunId,
              reason,
              timestamp: new Date().toISOString(),
            });
          }
        }
        const taskManager = this.getOrCreateTaskManager(spaceId);
        const cascaded = await taskManager.blockDependentTasks(taskId);
        for (const blocked of cascaded) {
          await this.safeOnTaskUpdated(spaceId, blocked);
        }
      } else if (params.status === 'cancelled') {
        const taskManager = this.getOrCreateTaskManager(spaceId);
        const cascaded = await taskManager.cancelDependentTasks(taskId);
        for (const cancelled of cascaded) {
          await this.safeOnTaskUpdated(spaceId, cancelled);
          if (cancelled.workflowRunId) {
            const run = this.config.workflowRunRepo.getRun(cancelled.workflowRunId);
            if (run && canTransitionRunStatus(run.status, 'cancelled')) {
              await this.transitionRunStatusAndEmit(cancelled.workflowRunId, 'cancelled');
            }
          }
        }
      }
      if (emitUpdated) {
        await this.safeOnTaskUpdated(spaceId, updated, {
          ...opts,
          fromStatus: previous?.status ?? null,
        });
      }
    }
    return updated;
  }

  private async transitionRunStatusAndEmit(
    runId: string,
    nextStatus: SpaceWorkflowRun['status']
  ): Promise<SpaceWorkflowRun> {
    const updated = this.config.workflowRunRepo.transitionStatus(runId, nextStatus);
    await this.safeOnWorkflowRunUpdated(updated.spaceId, updated);
    return updated;
  }

  private pickCanonicalTaskForRun(run: SpaceWorkflowRun, runTasks: SpaceTask[]): SpaceTask | null {
    if (runTasks.length === 0) return null;

    const normalize = (value: string | null | undefined): string =>
      (value ?? '').trim().toLowerCase();
    const runTitle = normalize(run.title);
    const titleMatches = runTasks.filter((task) => normalize(task.title) === runTitle);
    const pool = titleMatches.length > 0 ? titleMatches : runTasks;

    const sorted = [...pool].sort((a, b) => {
      if (a.taskNumber !== b.taskNumber) return a.taskNumber - b.taskNumber;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });

    return sorted[0] ?? null;
  }

  private async archiveDuplicateRunTasks(
    spaceId: string,
    run: SpaceWorkflowRun,
    canonicalTask: SpaceTask,
    runTasks: SpaceTask[],
    reason: 'active_run' | 'terminal_reconcile'
  ): Promise<void> {
    const duplicates = runTasks.filter((task) => task.id !== canonicalTask.id);
    if (duplicates.length === 0) return;

    log.warn(
      `SpaceRuntime: run ${run.id} has ${runTasks.length} tasks; archiving ${duplicates.length} duplicate task(s) in ${reason} repair`
    );

    const now = Date.now();
    for (const duplicate of duplicates) {
      if (duplicate.taskAgentSessionId && this.config.taskAgentManager) {
        this.config.taskAgentManager.cancelBySessionId(duplicate.taskAgentSessionId);
      }

      this.clearTaskInterests(duplicate.id);

      const live = this.config.taskRepo.getTask(duplicate.id);
      if (
        live &&
        live.status !== 'archived' &&
        !isValidSpaceTaskTransition(live.status, 'archived') &&
        isValidSpaceTaskTransition(live.status, 'stopped')
      ) {
        await this.updateTaskAndEmit(
          spaceId,
          duplicate.id,
          { status: 'stopped' },
          { archiveSource: 'system_reconcile' }
        );
      }

      await this.updateTaskAndEmit(
        spaceId,
        duplicate.id,
        {
          status: 'archived',
          archivedAt: duplicate.archivedAt ?? now,
          completedAt: duplicate.completedAt ?? now,
          workflowRunId: null,
          taskAgentSessionId: null,
        },
        { archiveSource: 'system_reconcile' }
      );

      this.notifiedTaskSet.delete(`${duplicate.id}:blocked`);
      this.notifiedTaskSet.delete(`${duplicate.id}:timeout`);
    }
  }

  private async reconcileTerminalRunTasks(run: SpaceWorkflowRun): Promise<void> {
    const runTasks = this.config.taskRepo.listByWorkflowRun(run.id);
    if (runTasks.length === 0) return;

    const canonicalTask = this.pickCanonicalTaskForRun(run, runTasks);
    if (!canonicalTask) return;

    if (runTasks.length > 1) {
      await this.archiveDuplicateRunTasks(
        run.spaceId,
        run,
        canonicalTask,
        runTasks,
        'terminal_reconcile'
      );
    }

    if (isWorkflowRunSucceeded(run.status)) {
      const workflow =
        this.executorMeta.get(run.id)?.workflow ??
        this.config.spaceWorkflowManager.getWorkflowForRun(run) ??
        null;
      const summaryFromArtifact = this.resolvePrimaryResultArtifactSummary(run.id);
      const summaryFromWorkflow = workflow
        ? this.resolveCompletionSummary(run.id, workflow)
        : undefined;
      const summaryFromSibling = runTasks
        .filter((task) => task.id !== canonicalTask.id)
        .map((task) => normalizeMeaningfulTaskResult(task.result))
        .find((result) => result !== null);
      const reportedSummary = normalizeMeaningfulTaskResult(canonicalTask.reportedSummary);
      const existingResult = normalizeMeaningfulTaskResult(canonicalTask.result);
      const freshSummary = summaryFromArtifact ?? summaryFromWorkflow ?? null;
      const nextResult =
        freshSummary ?? existingResult ?? reportedSummary ?? summaryFromSibling ?? null;
      const nextReportedSummary = freshSummary ?? reportedSummary ?? summaryFromSibling ?? null;

      if (
        canonicalTask.status !== 'done' &&
        canonicalTask.status !== 'review' &&
        canonicalTask.status !== 'cancelled' &&
        canonicalTask.status !== 'approved' &&
        canonicalTask.status !== 'blocked' &&
        canonicalTask.status !== 'stopped'
      ) {
        const updates = this.buildTaskOutcomeUpdates(
          canonicalTask,
          nextResult,
          nextReportedSummary
        );
        if (updates) {
          await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, updates);
        }
        await this.dispatchPostApproval(canonicalTask.id, 'agent');
      } else {
        const updates = this.buildTaskOutcomeUpdates(
          canonicalTask,
          nextResult,
          nextReportedSummary
        );
        if (updates) {
          await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, updates);
        }
      }
      return;
    }

    if (
      run.status === 'cancelled' &&
      canonicalTask.status !== 'cancelled' &&
      isValidSpaceTaskTransition(canonicalTask.status, 'cancelled')
    ) {
      await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
        status: 'cancelled',
        completedAt: canonicalTask.completedAt ?? run.completedAt ?? Date.now(),
      });
    }
  }

  private async reconcileTerminalRunsWithoutExecutors(): Promise<void> {
    const spaces = await this.listActiveSpaces();
    for (const space of spaces) {
      const finishedRuns = this.config.workflowRunRepo
        .listBySpace(space.id)
        .filter((run) => isWorkflowRunSucceeded(run.status) || run.status === 'cancelled');
      for (const run of finishedRuns) {
        if (this.executors.has(run.id)) continue;
        await this.reconcileTerminalRunTasks(run);
      }
    }
  }

  start(): void {
    if (this.tickTimer !== null) return;
    this.isStopped = false;

    const generation = this.runtimeGeneration;
    this.subscribeSdkToolUseCreated();
    this.unsubscribeSpaceResumed ??= this.config.spaceManager.onSpaceResumedRegister?.((spaceId) =>
      this.onSpaceResumed(spaceId)
    );
    this.unsubscribeSpacePaused ??= this.config.spaceManager.onSpacePausedRegister?.((spaceId) => {
      this.pausedSpaceIds.add(spaceId);
    });
    this.unsubscribeSpaceStopped ??= this.config.spaceManager.onSpaceStoppedRegister?.(
      (spaceId) => {
        this.pausedSpaceIds.add(spaceId);
      }
    );
    this.acceptingExternalEvents = this.rehydrated;
    const interval = this.config.tickIntervalMs ?? 5_000;
    this.tickTimer = setInterval(() => {
      this.executeTick().catch((err: unknown) => {
        log.error('SpaceRuntime: tick failed:', err);
      });
    }, interval);
    if (this.rehydrated) {
      this.reconciliationDone = false;
      void (async () => {
        const pausedSpaceIds = new Set<string>();
        try {
          for (const space of await this.config.spaceManager.listSpaces(false)) {
            if (space.paused || space.stopped) {
              pausedSpaceIds.add(space.id);
              this.pausedSpaceIds.add(space.id);
            } else {
              this.pausedSpaceIds.delete(space.id);
            }
          }
        } catch (err) {
          log.warn(
            `SpaceRuntime: start() could not list spaces for paused-deferral: ${formatCommandError(err)}`
          );
        }
        if (generation !== this.runtimeGeneration) return;
        this.rescheduleQueuedExternalEventRetries();
        this.requeuePersistedPendingDeliveries(pausedSpaceIds);
        this.subscribeExternalEventPublished();
        this.reconciliationDone = true;
        this.redispatchRetainedExternalEvents();
        this.executeTick().catch((err: unknown) => {
          log.error('SpaceRuntime: initial tick failed:', err);
        });
      })();
    } else {
      this.rescheduleQueuedExternalEventRetries();
      this.subscribeExternalEventPublished();
      this.redispatchRetainedExternalEvents();
      this.executeTick().catch((err: unknown) => {
        log.error('SpaceRuntime: initial tick failed:', err);
      });
    }
  }

  async stop(): Promise<void> {
    this.runtimeGeneration += 1;
    this.isStopped = true;
    this.retainedEventRedispatchPending = false;
    this.unsubscribeExternalEventPublished?.();
    this.unsubscribeExternalEventPublished = undefined;
    this.unsubscribeSdkToolUseCreated?.();
    this.unsubscribeSdkToolUseCreated = undefined;
    this.unsubscribeSdkToolUseConsumed?.();
    this.unsubscribeSdkToolUseConsumed = undefined;
    this.unsubscribeSpaceResumed?.();
    this.unsubscribeSpaceResumed = undefined;
    this.unsubscribeSpacePaused?.();
    this.unsubscribeSpacePaused = undefined;
    this.unsubscribeSpaceStopped?.();
    this.unsubscribeSpaceStopped = undefined;
    for (const timer of this.externalEventRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.externalEventRetryTimers.clear();
    this.externalEventRetryCounts.clear();
    for (const state of this.externalEventRateLimits.values()) {
      if (state.digestTimer) clearTimeout(state.digestTimer);
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      for (const item of state.pendingDigest) {
        this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: false,
          reason: `deliveryMode:${item.deliveryMode}; digest pending during runtime stop`,
        });
        this.preservePendingDigestItem(item);
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
      }
    }
    this.externalEventRateLimits.clear();
    this.externalEventDeliveryCooldowns.clear();
    this.acceptingExternalEvents = false;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.tickInFlight) {
      const MAX_TICK_DRAIN_MS = 30_000;
      const start = Date.now();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.tickInFlight) {
            resolve();
          } else if (Date.now() - start > MAX_TICK_DRAIN_MS) {
            log.warn(
              `SpaceRuntime: timed out waiting for in-flight tick after ${MAX_TICK_DRAIN_MS}ms — proceeding with shutdown`
            );
            resolve();
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });
    }
  }

  async executeTick(): Promise<void> {
    if (this.tickInFlight || !this.reconciliationDone) return;
    this.tickInFlight = true;
    try {
      if (hasSqlExec(this.config.db)) {
        this.toolContinuationRepo.markExpired();
      }

      const justRehydrated = !this.rehydrated;
      if (!this.rehydrated) {
        this.config.taskRepo.clearAllSpawnReservations();
        await this.rehydrateExecutors();
        await this.recoverStalledRuns();
        this.rehydrated = true;
        this.acceptingExternalEvents = true;
      }

      if (justRehydrated) {
        this.redispatchRetainedExternalEvents();
      }

      await this.attachStandaloneTasksToWorkflows();
      await this.processCompletedTasks();
      await this.cleanupTerminalExecutors();
      await this.reconcileTerminalRunsWithoutExecutors();
      await this.checkStandaloneTasks();
      await this.recoverRateLimitedTasks();

      this.expirePublishedExternalEventsPastTtl();

      this.pruneExpiredCycleEvents();
    } finally {
      this.tickInFlight = false;
    }
  }

  async startWorkflowRun(
    spaceId: string,
    workflowId: string,
    title: string,
    description?: string,
    options: StartWorkflowRunOptions = {}
  ): Promise<{ run: SpaceWorkflowRun; tasks: SpaceTask[] }> {
    const workflowResult = this.config.spaceWorkflowManager.getWorkflowForRunStart(workflowId);
    if (!workflowResult) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    const { rawWorkflow, workflow } = workflowResult;
    if (workflow.disabled) {
      throw new Error(`Workflow "${workflow.name}" is disabled and cannot be used for new runs.`);
    }
    if (!workflow.endNodeId) {
      throw new Error(`Workflow "${workflowId}" is missing endNodeId and cannot be executed.`);
    }

    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    const pendingRun = this.config.workflowRunRepo.createPinnedRun({
      spaceId,
      workflowId,
      title,
      description,
      rawWorkflow,
    });

    const run = this.config.workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
    await this.safeOnWorkflowRunCreated(spaceId, run);

    const meta: ExecutorMeta = { workflow, spaceId, workspacePath: space.workspacePath };
    this.executorMeta.set(run.id, meta);
    const executor = this.buildExecutor(workflow, run, spaceId, space.workspacePath);
    this.executors.set(run.id, executor);

    const startNode = workflow.nodes.find((s) => s.id === workflow.startNodeId);
    if (!startNode) {
      this.executors.delete(run.id);
      this.executorMeta.delete(run.id);
      await this.transitionRunStatusAndEmit(run.id, 'cancelled');
      throw new Error(`Start node "${workflow.startNodeId}" not found in workflow "${workflowId}"`);
    }

    const taskManager = this.getOrCreateTaskManager(spaceId);
    let canonicalTask: SpaceTask | null = null;
    let startAgents: ReturnType<typeof resolveNodeAgents>;
    try {
      if (options.parentTaskId) {
        const parent = this.config.taskRepo.getTask(options.parentTaskId);
        if (!parent) {
          throw new Error(`Parent task not found: ${options.parentTaskId}`);
        }
        if (parent.spaceId !== spaceId) {
          throw new Error(
            `Parent task ${options.parentTaskId} belongs to a different space (${parent.spaceId})`
          );
        }
        canonicalTask = await this.updateTaskAndEmit(spaceId, parent.id, {
          workflowRunId: run.id,
        });
      } else {
        canonicalTask = await taskManager.createTask({
          title,
          description: description ?? '',
          workflowRunId: run.id,
          status: 'open',
        });
      }
      if (!canonicalTask) {
        throw new Error(`Failed to initialize canonical task for run ${run.id}`);
      }
      await this.safeOnTaskUpdated(spaceId, canonicalTask);

      startAgents = resolveNodeAgents(startNode);
      for (const agentEntry of startAgents) {
        this.createNodeExecutionOrIgnore({
          workflowRunId: run.id,
          workflowNodeId: startNode.id,
          agentName: agentEntry.name,
          agentId: agentEntry.agentId ?? null,
          status: 'pending',
        });
      }
    } catch (err) {
      this.executors.delete(run.id);
      this.executorMeta.delete(run.id);
      await this.transitionRunStatusAndEmit(run.id, 'cancelled');
      throw err;
    }

    this.storeWorkflowChannels(run.id, workflow.channels ?? []);

    return { run, tasks: canonicalTask ? [canonicalTask] : [] };
  }

  resolveWorkflowForRun(spaceId: string, workflowId?: string): SpaceWorkflow | null {
    const availableWorkflows = this.config.spaceWorkflowManager
      .listWorkflows(spaceId)
      .filter((w) => !w.disabled);
    return selectWorkflow({ spaceId, availableWorkflows, workflowId });
  }

  getExecutor(runId: string): WorkflowExecutor | undefined {
    return this.executors.get(runId);
  }

  getApprovedPrUrlForRun(runId: string): string | null {
    const url = this.resolvePrUrlForRun(runId);
    return typeof url === 'string' && url.length > 0 ? url : null;
  }

  async recoverWorkflowBackedTask(
    spaceId: string,
    taskId: string,
    targetStatus: WorkflowTaskRecoveryTargetStatus,
    options: { workflowNodeId?: string; agentName?: string; description?: string } = {}
  ): Promise<{ task: SpaceTask; run: SpaceWorkflowRun }> {
    if (targetStatus !== 'open' && targetStatus !== 'in_progress') {
      throw new Error(
        `Workflow task recovery only supports active target statuses: open, in_progress`
      );
    }

    const preTxTask = this.config.taskRepo.getTask(taskId);
    const preTxRunId = preTxTask?.workflowRunId;
    const preTxRun = preTxRunId ? this.config.workflowRunRepo.getRun(preTxRunId) : null;
    if (preTxRunId && preTxTask.spaceId === spaceId && preTxRun?.spaceId === spaceId) {
      if (this.config.pendingMessageRepo) {
        this.config.pendingMessageRepo.clearTerminalForRun(preTxRunId);
      }
      this.blockedRetryCounts.delete(preTxRunId);
      for (const key of this.nonTerminalIdleStates.keys()) {
        if (key.startsWith(preTxRunId + ':')) {
          this.nonTerminalIdleStates.delete(key);
        }
      }
      this.clearAgentStuckStateForRun(preTxRunId);
    }

    const liveSessionIds = new Set<string>();
    const recoverTx = this.config.db.transaction(() => {
      const task = this.config.taskRepo.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.spaceId !== spaceId) throw new Error(`Task not found: ${taskId}`);
      if (!task.workflowRunId) {
        throw new Error(`Task ${taskId} is not backed by a workflow run`);
      }
      if (task.status !== targetStatus && !isValidSpaceTaskTransition(task.status, targetStatus)) {
        throw new Error(`Invalid status transition from '${task.status}' to '${targetStatus}'.`);
      }

      const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
      if (!run) throw new Error(`WorkflowRun not found: ${task.workflowRunId}`);
      if (run.spaceId !== spaceId) throw new Error(`WorkflowRun not found: ${task.workflowRunId}`);

      const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
      if (!workflow) {
        throw new Error(`Workflow not found: ${run.workflowId}`);
      }

      let updatedRun =
        run.status === 'in_progress'
          ? run
          : this.config.workflowRunRepo.transitionStatus(run.id, 'in_progress');
      updatedRun =
        this.config.workflowRunRepo.updateRun(run.id, {
          failureReason: null,
          completedAt: null,
        }) ?? updatedRun;

      const updatedTask = this.config.taskRepo.updateTask(task.id, {
        status: targetStatus,
        completedAt: null,
        result: null,
        blockReason: null,
        approvalSource: null,
        approvalReason: null,
        approvedAt: null,
        pendingCheckpointType: null,
        pendingCompletionSubmittedByNodeId: null,
        pendingCompletionSubmittedAt: null,
        pendingCompletionReason: null,
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
        postApprovalSourceNodeId: null,
        reportedStatus: null,
        reportedSummary: null,
        ...(targetStatus === 'open' ? { startedAt: null } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
      });
      if (!updatedTask) throw new Error(`Failed to update task: ${task.id}`);

      let executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
      if (executions.length === 0) {
        const startNode = workflow.nodes.find((node) => node.id === workflow.startNodeId);
        if (!startNode) {
          throw new Error(
            `Start node "${workflow.startNodeId}" not found in workflow "${workflow.id}"`
          );
        }
        for (const agentEntry of resolveNodeAgents(startNode)) {
          this.createNodeExecutionOrIgnore({
            workflowRunId: run.id,
            workflowNodeId: startNode.id,
            agentName: agentEntry.name,
            agentId: agentEntry.agentId ?? null,
            status: 'pending',
          });
        }
        executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
      }

      const byRecency = (a: NodeExecution, b: NodeExecution) => {
        const aTime = a.updatedAt ?? a.startedAt ?? a.createdAt;
        const bTime = b.updatedAt ?? b.startedAt ?? b.createdAt;
        if (aTime !== bTime) return bTime - aTime;
        return b.id.localeCompare(a.id);
      };
      let currentExecution: NodeExecution | undefined;
      let currentNodeExecutions: NodeExecution[];
      if (options.workflowNodeId) {
        const slotExecutions = executions.filter(
          (execution) =>
            execution.workflowNodeId === options.workflowNodeId &&
            (!options.agentName || execution.agentName === options.agentName)
        );
        if (slotExecutions.length === 0) {
          const slotNode = workflow.nodes.find((node) => node.id === options.workflowNodeId);
          const slot =
            slotNode && options.agentName
              ? resolveNodeAgents(slotNode).find((agent) => agent.name === options.agentName)
              : undefined;
          if (!slotNode || (options.agentName && !slot)) {
            throw new Error(
              `Subscribed slot ${options.workflowNodeId}/${options.agentName ?? ''} is not recoverable`
            );
          }
          this.createNodeExecutionOrIgnore({
            workflowRunId: run.id,
            workflowNodeId: slotNode.id,
            agentName: options.agentName ?? slot?.name ?? '',
            agentId: slot?.agentId ?? null,
            status: 'pending',
          });
          executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
          currentExecution = executions.find(
            (execution) =>
              execution.workflowNodeId === slotNode.id &&
              (!options.agentName || execution.agentName === options.agentName)
          );
        } else {
          currentExecution = [...slotExecutions].sort(byRecency)[0];
        }
        currentNodeExecutions = currentExecution
          ? executions.filter(
              (execution) =>
                execution.workflowNodeId === currentExecution!.workflowNodeId &&
                (!options.agentName || execution.agentName === options.agentName)
            )
          : [];
      } else {
        currentExecution = [...executions].sort(byRecency)[0];
        currentNodeExecutions = currentExecution
          ? executions.filter(
              (execution) => execution.workflowNodeId === currentExecution!.workflowNodeId
            )
          : [];
      }

      for (const execution of currentNodeExecutions) {
        const sessionId = execution.agentSessionId;
        const hasLiveSession =
          !!sessionId && (this.config.taskAgentManager?.isSessionAlive(sessionId) ?? false);

        if (hasLiveSession && sessionId) {
          this.config.nodeExecutionRepo.update(execution.id, {
            status: 'in_progress',
            completedAt: null,
          });
          liveSessionIds.add(sessionId);
        } else {
          this.config.nodeExecutionRepo.update(execution.id, {
            status: 'pending',
            result: null,
            data: null,
            startedAt: null,
            completedAt: null,
          });
        }
      }

      this.config.goalService?.supersedeOutcomeNotificationsForTask(taskId);
      return { task: updatedTask, run: updatedRun };
    });

    this.config.reactiveDb?.beginTransaction();
    let recovered: { task: SpaceTask; run: SpaceWorkflowRun };
    try {
      recovered = recoverTx();
      this.config.reactiveDb?.commitTransaction();
    } catch (err) {
      this.config.reactiveDb?.abortTransaction();
      throw err;
    }
    await this.ensureExecutorRegistered(recovered.run);
    const recoveredWorkflow = this.config.spaceWorkflowManager.getWorkflowForRun(recovered.run);
    if (recoveredWorkflow) {
      this.registerRunInterestsFromWorkflow(recovered.run, recoveredWorkflow);
    }
    this.requeuePendingDeliveriesForRun(recovered.run.id);
    for (const sessionId of liveSessionIds) {
      const tam = this.config.taskAgentManager;
      const resumeOutcome: 'retried' | 'respawned' | 'noop' =
        tam && typeof tam.resumeRateLimitedSubSession === 'function'
          ? await tam.resumeRateLimitedSubSession(sessionId).catch((err: unknown) => {
              log.warn(
                `Workflow resume: failed to resume rate-limited session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
              );
              return 'noop' as const;
            })
          : 'noop';
      if (resumeOutcome === 'respawned') continue;
      const prepared =
        (await this.config.taskAgentManager?.prepareSubSessionForWorkflowResume(sessionId)) ?? true;
      if (!prepared) {
        log.warn(
          `Workflow resume could not prepare MCP tools for live node-agent session ${sessionId}`
        );
      }
    }
    await this.safeOnWorkflowRunUpdated(
      spaceId,
      this.config.workflowRunRepo.getRun(recovered.run.id)!
    );
    await this.safeOnTaskUpdated(spaceId, this.config.taskRepo.getTask(recovered.task.id)!);
    return {
      run: this.config.workflowRunRepo.getRun(recovered.run.id) ?? recovered.run,
      task: this.config.taskRepo.getTask(recovered.task.id) ?? recovered.task,
    };
  }

  get executorCount(): number {
    return this.executors.size;
  }

  private async ensureExecutorRegistered(
    run: SpaceWorkflowRun,
    knownSpace?: Space
  ): Promise<boolean> {
    if (this.executors.has(run.id)) return true;

    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    if (!workflow) return false;

    const space = knownSpace ?? (await this.config.spaceManager.getSpace(run.spaceId));
    if (!space) return false;

    const meta: ExecutorMeta = {
      workflow,
      spaceId: space.id,
      workspacePath: space.workspacePath,
    };
    this.executorMeta.set(run.id, meta);
    this.executors.set(run.id, this.buildExecutor(workflow, run, space.id, space.workspacePath));
    try {
      this.registerRunInterestsFromWorkflow(run, workflow);
    } catch (err) {
      log.warn(
        `SpaceRuntime: failed to rebuild static interests for run ${run.id} during executor registration: ${formatCommandError(err)}`
      );
    }
    return true;
  }

  private requeuePersistedPendingDeliveries(pausedSpaceIds: Set<string> = new Set()): void {
    const store = this.config.externalEventStore;
    if (!store) return;

    for (const delivery of store.listPendingDeliveries()) {
      const eventRecord = store.getById(delivery.eventId);
      if (!eventRecord || eventRecord.state !== 'published') continue;
      const longHorizonSpaceId = longHorizonSpaceIdFromWorkflowRunId(delivery.workflowRunId);
      if (longHorizonSpaceId) {
        const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
        const subscription = this.config.longHorizonAgentRepo?.getSubscription(delivery.taskId);
        const agent = subscription
          ? this.config.longHorizonAgentRepo?.getById(subscription.agentId)
          : null;
        let target: LongHorizonSubscriptionTarget | null = null;
        if (subscription) {
          try {
            target = {
              kind: 'long_horizon_agent',
              spaceId: longHorizonSpaceId,
              agentId: subscription.agentId,
              source: subscription.source,
              topic: composeLongHorizonSubscriptionPattern(subscription.source, subscription.topic),
              subscriptionId: subscription.id,
            };
          } catch (err) {
            store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
              terminal: true,
              reason: err instanceof Error ? err.message : String(err),
            });
            store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
            continue;
          }
        }
        if (
          !subscription ||
          subscription.spaceId !== longHorizonSpaceId ||
          subscription.status !== 'active' ||
          !agent ||
          agent.spaceId !== longHorizonSpaceId ||
          agent.status !== 'active' ||
          !target ||
          !this.lookupSubscriptionTargets(eventPayload.topic).some(
            (match) =>
              isLongHorizonSubscriptionTarget(match) &&
              match.spaceId === target.spaceId &&
              match.subscriptionId === target.subscriptionId
          )
        ) {
          store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
            terminal: true,
            reason: 'subscription_no_longer_active',
          });
          store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
          continue;
        }
        void this.deliverToLongHorizonAgent(target, eventPayload, delivery.deliveryKey);
        continue;
      }

      const run = this.config.workflowRunRepo.getRun(delivery.workflowRunId);
      const target = {
        workflowRunId: delivery.workflowRunId,
        taskId: delivery.taskId,
        nodeId: delivery.nodeId,
        agentName: delivery.agentName,
      };
      if (run && pausedSpaceIds.has(run.spaceId)) {
        continue;
      }

      if (!this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        continue;
      }

      const lifecycleReason = this.evaluateRequeueTaskLifecycle(target, eventRecord.event);
      if (lifecycleReason) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: lifecycleReason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        this.clearExternalEventRetry(delivery.deliveryKey);
        continue;
      }

      const mode = deliveryModeFromFailureReason(delivery.failureReason);
      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      const queuedItem = {
        event: eventPayload,
        deliveryKey: delivery.deliveryKey,
        deliveryMode: mode,
        createdAt: eventRecord.createdAt,
      };
      if (this.isQueuedExternalEventExpired(queuedItem)) {
        this.failQueuedDeliveryForTtl(queuedItem, this.buildQueueKey(target));
        continue;
      }
      this.queueForPendingNode(
        target,
        eventPayload,
        delivery.deliveryKey,
        mode,
        eventRecord.createdAt
      );
      const resolved = this.resolveSubscriptionTarget(target);
      if (resolved.sessionId) {
        this.scheduleExternalEventRetry(
          resolved,
          eventPayload,
          delivery.deliveryKey,
          mode,
          delivery.failureReason ?? `deliveryMode:${mode}; retry requeued after runtime rehydrate`,
          { preserveAttemptCount: true, createdAt: eventRecord.createdAt }
        );
      } else {
        this.scheduleActivationRetry(
          target,
          eventPayload,
          delivery.deliveryKey,
          delivery.failureReason ?? 'node_execution_not_active'
        );
      }
    }
  }

  private requeuePendingDeliveriesForRun(runId: string): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    for (const delivery of store.listPendingDeliveries(runId)) {
      const target = {
        workflowRunId: delivery.workflowRunId,
        taskId: delivery.taskId,
        nodeId: delivery.nodeId,
        agentName: delivery.agentName,
      };
      const eventRecord = store.getById(delivery.eventId);
      if (!eventRecord || eventRecord.state !== 'published') continue;
      const mode = deliveryModeFromFailureReason(delivery.failureReason);
      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      const ttlItem = {
        event: eventPayload,
        deliveryKey: delivery.deliveryKey,
        deliveryMode: mode,
        createdAt: eventRecord.createdAt,
      };
      if (this.isQueuedExternalEventExpired(ttlItem)) {
        this.failQueuedDeliveryForTtl(ttlItem, this.buildQueueKey(target));
        continue;
      }
      if (!this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        continue;
      }
      this.queueForPendingNode(
        target,
        eventPayload,
        delivery.deliveryKey,
        mode,
        eventRecord.createdAt
      );
      const resolved = this.resolveSubscriptionTarget(target);
      if (resolved.sessionId) {
        this.scheduleExternalEventRetry(
          resolved,
          eventPayload,
          delivery.deliveryKey,
          mode,
          delivery.failureReason ?? `deliveryMode:${mode}; retry requeued after task resume`,
          { preserveAttemptCount: true, createdAt: eventRecord.createdAt }
        );
      } else {
        this.scheduleActivationRetry(
          target,
          eventPayload,
          delivery.deliveryKey,
          delivery.failureReason ?? 'node_execution_not_active'
        );
      }
    }
  }

  onSpaceResumed(spaceId: string): void {
    const store = this.config.externalEventStore;
    this.pausedSpaceIds.delete(spaceId);
    try {
      this.config.goalService?.retryQueuedRunsForSpace(spaceId);
    } catch (err) {
      log.warn(
        `Goal queued-run retry threw for space ${spaceId} on resume: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!store) return;

    const reactiveRuns = this.config.workflowRunRepo
      .listBySpace(spaceId)
      .filter((run) => this.isRunInterestRebuildEligible(run));
    for (const run of reactiveRuns) {
      const staticWorkflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
      if (staticWorkflow) {
        try {
          this.registerRunInterestsFromWorkflow(run, staticWorkflow);
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to rebuild static interests for run ${run.id} on resume: ${formatCommandError(err)}`
          );
        }
      }
    }

    for (const delivery of store.listPendingDeliveries()) {
      const task = this.config.taskRepo.getTask(delivery.taskId);
      if (!task || task.spaceId !== spaceId) continue;

      const target = {
        workflowRunId: delivery.workflowRunId,
        taskId: delivery.taskId,
        nodeId: delivery.nodeId,
        agentName: delivery.agentName,
      };
      const eventRecord = store.getById(delivery.eventId);
      if (!eventRecord || eventRecord.state !== 'published') continue;
      const mode = deliveryModeFromFailureReason(delivery.failureReason);
      const ttlItem = {
        event: this.externalEventPayloadFromRecord(eventRecord.event),
        deliveryKey: delivery.deliveryKey,
        deliveryMode: mode,
        createdAt: eventRecord.createdAt,
      };
      if (this.isQueuedExternalEventExpired(ttlItem)) {
        this.failQueuedDeliveryForTtl(ttlItem, this.buildQueueKey(target));
        continue;
      }
      if (!this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        continue;
      }

      const lifecycleReason = this.evaluateRequeueTaskLifecycle(target, eventRecord.event);
      if (lifecycleReason) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: lifecycleReason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        this.clearExternalEventRetry(delivery.deliveryKey);
        continue;
      }

      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      this.queueForPendingNode(
        target,
        eventPayload,
        delivery.deliveryKey,
        mode,
        eventRecord.createdAt
      );
      const resolved = this.resolveSubscriptionTarget(target);
      if (resolved.sessionId) {
        this.scheduleExternalEventRetry(
          resolved,
          eventPayload,
          delivery.deliveryKey,
          mode,
          delivery.failureReason ?? `deliveryMode:${mode}; retry requeued after space resume`,
          { preserveAttemptCount: true, createdAt: eventRecord.createdAt }
        );
      } else {
        this.scheduleActivationRetry(
          target,
          eventPayload,
          delivery.deliveryKey,
          delivery.failureReason ?? 'node_execution_not_active'
        );
      }
    }

    this.redispatchRetainedExternalEvents();
  }

  private redispatchPublishedEventsWithoutDeliveries(): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    for (const eventRecord of store.listPublishedEventsWithoutDeliveries()) {
      void this.handleExternalEvent(this.externalEventPayloadFromRecord(eventRecord.event));
    }
  }

  private expirePublishedExternalEventsPastTtl(now = Date.now()): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    try {
      store.markPublishedEventsFailedBefore(now - EXTERNAL_EVENT_QUEUE_TTL_MS, now);
    } catch (err) {
      log.warn(
        `SpaceRuntime: TTL sweep failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private rehydrateLongHorizonSubscriptions(spaceId: string): void {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return;
    this.topicTrie.remove(
      (target) => isLongHorizonSubscriptionTarget(target) && target.spaceId === spaceId
    );
    for (const subscription of repo.listActiveSubscriptionsBySpace(spaceId)) {
      const result = this.refreshLongHorizonSubscription(spaceId, subscription.id);
      if (!result.success) {
        log.warn(
          `SpaceRuntime: skipping invalid long-horizon subscription ${subscription.id}: ` +
            (result.error ?? 'invalid pattern')
        );
      }
    }
  }

  private groupTasksByRun(tasks: SpaceTask[]): Map<string, SpaceTask[]> {
    const byRun = new Map<string, SpaceTask[]>();
    for (const task of tasks) {
      if (!task.workflowRunId) continue;
      const list = byRun.get(task.workflowRunId);
      if (list) list.push(task);
      else byRun.set(task.workflowRunId, [task]);
    }
    return byRun;
  }

  private rehydrateWorkflowSubscriptions(
    spaceId: string,
    runs: SpaceWorkflowRun[],
    tasksByRun: Map<string, SpaceTask[]>
  ): void {
    const runById = new Map(runs.map((run) => [run.id, run]));
    const cancelledRunIds = new Set(
      runs.filter((run) => run.status === 'cancelled').map((run) => run.id)
    );
    const terminalTaskIds = new Set<string>();
    for (const runTasks of tasksByRun.values()) {
      for (const task of runTasks) {
        if (task.status === 'done' || task.status === 'archived') {
          terminalTaskIds.add(task.id);
        }
      }
    }
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        runById.has(target.workflowRunId) &&
        target.subscriptionKind === 'dynamic'
    );
    const purgedRuns = new Set<string>();
    const purgedTasks = new Set<string>();
    for (const sub of this.workflowEventSubscriptionRepo.listBySpace(spaceId)) {
      if (cancelledRunIds.has(sub.workflowRunId)) {
        if (!purgedRuns.has(sub.workflowRunId)) {
          this.workflowEventSubscriptionRepo.deleteByRun(sub.workflowRunId);
          purgedRuns.add(sub.workflowRunId);
        }
        continue;
      }
      if (terminalTaskIds.has(sub.taskId)) {
        if (!purgedTasks.has(sub.taskId)) {
          this.workflowEventSubscriptionRepo.deleteByTask(sub.taskId);
          purgedTasks.add(sub.taskId);
        }
        continue;
      }
      try {
        this.topicTrie.insert(sub.topic, {
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
          topic: sub.topic,
          subscriptionKind: sub.subscriptionKind,
        });
      } catch (err) {
        log.warn(
          `SpaceRuntime: skipping malformed workflow subscription ${sub.id} ` +
            `(${sub.workflowRunId}/${sub.nodeId}/${sub.agentName} ${sub.topic}) during rehydrate: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }
  }

  private isTargetStillSubscribed(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>,
    topic: string
  ): boolean {
    return this.lookupSubscriptionTargets(topic).some(
      (match) =>
        isWorkflowSubscriptionTarget(match) &&
        match.workflowRunId === target.workflowRunId &&
        match.taskId === target.taskId &&
        match.nodeId === target.nodeId &&
        match.agentName === target.agentName
    );
  }

  private lookupSubscriptionTargets(topic: string): SubscriptionTarget[] {
    const matches = this.topicTrie.lookup(topic);
    const legacyTopic = legacyGitHubTopic(topic);
    if (!legacyTopic) return matches;
    return matches.concat(this.topicTrie.lookup(legacyTopic));
  }

  private externalEventPayloadFromRecord(event: ExternalEvent): ExternalEventPublishedPayload {
    return {
      namespaceId: event.spaceId,
      spaceId: event.spaceId,
      eventId: event.id,
      source: event.source,
      topic: event.topic,
      dedupeKey: event.dedupeKey,
      summary: event.summary,
      externalUrl: event.externalUrl,
      payload: event.payload,
      occurredAt: event.occurredAt,
      ingestedAt: event.ingestedAt,
    };
  }

  async rehydrateExecutors(): Promise<void> {
    const spaces = await this.config.spaceManager.listSpaces(false);
    const pausedSpaceIds = new Set<string>();

    for (const space of spaces) {
      const activeRuns = this.config.workflowRunRepo.getRehydratableRuns(space.id);
      const reviewRuns = this.config.workflowRunRepo
        .listBySpace(space.id)
        .filter(
          (run) =>
            !activeRuns.some((activeRun) => activeRun.id === run.id) &&
            run.status !== 'cancelled' &&
            this.config.taskRepo
              .listByWorkflowRun(run.id)
              .some((task) => task.status === 'review' || task.status === 'approved')
        );
      if (reviewRuns.length > 0) {
        log.info(
          `SpaceRuntime.rehydrateExecutors: found ${reviewRuns.length} review/approved-pending run(s) in space ${space.id}`
        );
      }
      activeRuns.push(...reviewRuns);

      for (const run of activeRuns) {
        if (this.executors.has(run.id)) continue;
        await this.ensureExecutorRegistered(run, space);
      }
      this.rehydrateLongHorizonSubscriptions(space.id);
      const spaceRuns = this.config.workflowRunRepo.listBySpace(space.id);
      const tasksByRun = this.groupTasksByRun(
        this.config.taskRepo.listByWorkflowRunIdsIncludingArchived(spaceRuns.map((run) => run.id))
      );
      this.rehydrateWorkflowSubscriptions(space.id, spaceRuns, tasksByRun);
      if (space.paused || space.stopped) {
        pausedSpaceIds.add(space.id);
        this.pausedSpaceIds.add(space.id);
        continue;
      }
      for (const run of spaceRuns) {
        if (!this.isRunInterestRebuildEligibleWithTasks(run, tasksByRun.get(run.id) ?? [])) {
          continue;
        }
        const staticWorkflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
        if (staticWorkflow) {
          try {
            this.registerRunInterestsFromWorkflow(run, staticWorkflow);
          } catch (err) {
            log.warn(
              `SpaceRuntime: failed to rebuild static interests for run ${run.id} during rehydrate: ${formatCommandError(err)}`
            );
          }
        }
      }
    }

    this.requeuePersistedPendingDeliveries(pausedSpaceIds);

    if (this.config.taskAgentManager) {
      await this.config.taskAgentManager.rehydrate();
    }
  }

  private recoveryDone = false;

  async recoverStalledRunsForSpace(spaceId: string): Promise<void> {
    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space || space.paused || space.stopped) return;

    let blockedCount = 0;
    let completionPendingCount = 0;
    const inProgressRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
    for (const run of inProgressRuns) {
      try {
        const outcome = await this.recoverSingleRun(run);
        if (outcome === 'blocked') blockedCount++;
        else if (outcome === 'completion-pending') completionPendingCount++;
      } catch (err) {
        log.error(
          `SpaceRuntime.recoverStalledRunsForSpace: failed to recover run ${run.id} (space ${space.id}):`,
          err
        );
      }
    }

    if (blockedCount + completionPendingCount > 0) {
      log.info(
        `SpaceRuntime.recoverStalledRunsForSpace: space=${space.id} blocked=${blockedCount} completion-pending=${completionPendingCount}`
      );
    }
  }

  async recoverStalledRuns(): Promise<void> {
    if (this.recoveryDone) return;
    this.recoveryDone = true;

    try {
      this.getCycleRepo().pruneAllOldEvents();
    } catch (err) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: failed to prune old cycle events: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const spaces = await this.config.spaceManager.listSpaces(false);
    let blockedCount = 0;
    let completionPendingCount = 0;
    let skippedPausedCount = 0;

    for (const space of spaces) {
      if (space.paused || space.stopped) {
        if (this.config.workflowRunRepo.getActiveRuns(space.id).length > 0) skippedPausedCount += 1;
        continue;
      }
      const inProgressRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
      for (const run of inProgressRuns) {
        try {
          const outcome = await this.recoverSingleRun(run);
          if (outcome === 'blocked') blockedCount++;
          else if (outcome === 'completion-pending') completionPendingCount++;
        } catch (err) {
          log.error(
            `SpaceRuntime.recoverStalledRuns: failed to recover run ${run.id} (space ${space.id}):`,
            err
          );
        }
      }
    }

    if (skippedPausedCount > 0) {
      this.recoveryDone = false;
    }

    if (blockedCount + completionPendingCount > 0) {
      log.info(
        `SpaceRuntime.recoverStalledRuns: blocked=${blockedCount} completion-pending=${completionPendingCount}`
      );
    }
  }

  private async recoverSingleRun(
    run: SpaceWorkflowRun
  ): Promise<'completion-pending' | 'blocked' | 'skipped'> {
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
    if (!workflow) {
      await this.blockRunWithMissingWorkflow(run, executions);
      return 'blocked';
    }
    const space = await this.config.spaceManager.getSpace(run.spaceId);
    if (executions.length === 0) return 'skipped';

    const pendingMessageRepo = this.config.pendingMessageRepo;
    pendingMessageRepo?.enforceRetention({ runId: run.id });
    const hasQueuedNodeHandoff =
      pendingMessageRepo
        ?.listPendingForRun(run.id)
        .some((row) => row.targetKind === 'node_agent') ?? false;
    if (hasDriveableExecution(executions) || hasQueuedNodeHandoff) return 'skipped';

    const tasks = this.config.taskRepo.listByWorkflowRun(run.id);
    const canonicalTask = this.pickCanonicalTaskForRun(run, tasks);
    if (canonicalTask?.status === 'stopped') return 'skipped';

    const completionSignalled =
      canonicalTask !== null &&
      (canonicalTask.status === 'done' ||
        canonicalTask.status === 'cancelled' ||
        canonicalTask.status === 'review' ||
        canonicalTask.status === 'approved' ||
        canonicalTask.reportedStatus !== null);

    if (!completionSignalled && canonicalTask) {
      const nonTerminalIdleOutcome = await this.handleNonTerminalIdleExecutions(
        run.id,
        run.spaceId,
        canonicalTask,
        workflow,
        undefined,
        space ?? null
      );
      if (nonTerminalIdleOutcome === 'blocked') return 'blocked';
      if (nonTerminalIdleOutcome === 'retried' || nonTerminalIdleOutcome === 'preserved') {
        return 'skipped';
      }
    }

    if (completionSignalled) {
      return 'completion-pending';
    }

    let activated: boolean;
    try {
      activated = await this.activateRestartRecoveryDownstreamNodes(run, executions);
    } catch (err) {
      if (isMissingWorkflowAgentError(err)) {
        await this.blockRunForMissingAgent(run, err);
        return 'blocked';
      }
      throw err;
    }
    if (activated) return 'skipped';

    await this.transitionRunStatusAndEmit(run.id, 'blocked');
    if (canonicalTask) {
      const result =
        'Workflow run stalled across daemon restart: all node executions ' +
        'terminated (idle/cancelled) without a completion signal. The run ' +
        'will auto-retry or escalate for human attention.';
      await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
        status: 'blocked',
        blockReason: 'execution_failed',
        result,
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId: run.spaceId,
        taskId: canonicalTask.id,
        reason: result,
        timestamp: new Date().toISOString(),
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId: run.spaceId,
      runId: run.id,
      reason: 'Daemon restart left workflow run stalled with no completion signal',
      timestamp: new Date().toISOString(),
    });
    log.warn(
      `SpaceRuntime.recoverStalledRuns: run ${run.id} (space ${run.spaceId}) was in_progress ` +
        `with all node executions idle/cancelled and no completion signal — flagged blocked`
    );
    return 'blocked';
  }

  private async blockRunWithMissingWorkflow(
    run: SpaceWorkflowRun,
    executions: NodeExecution[]
  ): Promise<void> {
    const reason = `Workflow ${run.workflowId} no longer exists; workflow run cannot continue`;
    const now = Date.now();
    for (const execution of executions) {
      if (execution.status === 'cancelled') continue;
      if (execution.agentSessionId) {
        this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
      }
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        result: reason,
        completedAt: now,
      });
    }
    await this.transitionRunStatusAndEmit(run.id, 'blocked');
    const canonicalTask = this.pickCanonicalTaskForRun(
      run,
      this.config.taskRepo.listByWorkflowRun(run.id)
    );
    if (canonicalTask) {
      await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
        status: 'blocked',
        blockReason: 'workflow_invalid',
        result: reason,
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId: run.spaceId,
        taskId: canonicalTask.id,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId: run.spaceId,
      runId: run.id,
      reason,
      timestamp: new Date().toISOString(),
    });
    log.warn(`SpaceRuntime.recoverStalledRuns: blocked run ${run.id}: ${reason}`);
  }

  private async blockRunForMissingAgent(
    run: SpaceWorkflowRun,
    err: MissingWorkflowAgentError
  ): Promise<void> {
    const reason = err.message;
    await this.transitionRunStatusAndEmit(run.id, 'blocked');
    const canonicalTask = this.pickCanonicalTaskForRun(
      run,
      this.config.taskRepo.listByWorkflowRun(run.id)
    );
    if (canonicalTask) {
      await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
        status: 'blocked',
        blockReason: 'workflow_invalid',
        result: reason,
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId: run.spaceId,
        taskId: canonicalTask.id,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId: run.spaceId,
      runId: run.id,
      reason,
      timestamp: new Date().toISOString(),
    });
    log.warn(`SpaceRuntime.recoverStalledRuns: blocked run ${run.id}: ${reason}`);
  }

  private async activateRestartRecoveryDownstreamNodes(
    run: SpaceWorkflowRun,
    executions: NodeExecution[]
  ): Promise<boolean> {
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    if (!workflow) return false;
    const channels = workflow.channels ?? [];
    if (channels.length === 0) return false;

    const nodeByName = new Map(workflow.nodes.map((node) => [node.name, node]));
    const idleExecutions = executions.filter((execution) => execution.status === 'idle');
    const stalledTransitions: Array<{
      sourceExecution: NodeExecution;
      sourceNode: SpaceWorkflow['nodes'][number];
      channel: WorkflowChannel;
      channelIndex: number;
      targetNames: string[];
    }> = [];
    for (const execution of idleExecutions) {
      const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
      if (!node) continue;
      for (const [channelIndex, channel] of channels.entries()) {
        if (!this.matchesRestartRecoveryChannelSource(channel, node, execution.agentName)) continue;
        const targetNames = this.resolveRestartRecoveryTargetNames(channel, workflow).filter(
          (targetName) => {
            const targetNode = nodeByName.get(targetName);
            return (
              !targetNode ||
              this.shouldRecoverRestartRecoveryTarget(targetNode, executions, workflow.endNodeId)
            );
          }
        );
        if (targetNames.length === 0) continue;
        stalledTransitions.push({
          sourceExecution: execution,
          sourceNode: node,
          channel,
          channelIndex,
          targetNames,
        });
      }
    }

    const createdOrReset: string[] = [];
    const blockedReasons: string[] = [];
    const notifiedDeadLoopChannels = new Set<number>();

    for (const {
      sourceExecution,
      sourceNode,
      channel,
      channelIndex,
      targetNames,
    } of stalledTransitions) {
      const cycleResult = this.evaluateRestartRecoveryCycle(
        run.id,
        workflow,
        channel,
        channelIndex
      );
      if (!cycleResult.open) {
        blockedReasons.push(cycleResult.reason);
        if (cycleResult.deadLoop && !notifiedDeadLoopChannels.has(channelIndex)) {
          const notified = await this.notifyRecoveryDeadLoop(
            run,
            channel,
            channelIndex,
            sourceExecution.agentName,
            targetNames,
            cycleResult.recentCount
          );
          if (notified) notifiedDeadLoopChannels.add(channelIndex);
        }
        continue;
      }
      let activatedOnChannel = false;
      for (const targetName of targetNames) {
        const targetNode = nodeByName.get(targetName);
        if (!targetNode || targetNode.id === sourceNode.id) continue;

        const missing = findMissingNodeAgentReferences(
          targetNode,
          (id) => this.config.spaceAgentManager.getById(id) !== null
        );
        if (missing.length > 0) {
          const first = missing[0];
          throw new MissingWorkflowAgentError(
            formatMissingAgentReference({
              runId: run.id,
              nodeLabel: targetNode.name,
              agentName: first.agentName,
              agentId: first.agentId,
            }),
            first
          );
        }

        let activatedForTarget = false;
        let resetExistingTarget = false;
        for (const agentEntry of resolveNodeAgents(targetNode)) {
          const existing = this.config.nodeExecutionRepo
            .listByNode(run.id, targetNode.id)
            .find((execution) => execution.agentName === agentEntry.name);
          if (existing) {
            if (existing.status === 'idle' || existing.status === 'cancelled') {
              this.config.nodeExecutionRepo.update(existing.id, {
                status: 'pending',
                result: null,
                startedAt: null,
                completedAt: null,
              });
              activatedForTarget = true;
              resetExistingTarget = true;
            }
            continue;
          }
          this.createNodeExecutionOrIgnore({
            workflowRunId: run.id,
            workflowNodeId: targetNode.id,
            agentName: agentEntry.name,
            agentId: agentEntry.agentId ?? null,
            status: 'pending',
          });
          activatedForTarget = true;
        }
        if (activatedForTarget) {
          createdOrReset.push(targetNode.name);
          activatedOnChannel = true;
          this.enqueueRestartRecoveryMessage(
            run,
            sourceExecution.agentName,
            targetNode,
            resetExistingTarget
          );
        }
      }
      if (activatedOnChannel) {
        this.recordRestartRecoveryCycleTraversal(run.id, workflow, channel, channelIndex);
      }
    }

    if (createdOrReset.length > 0) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: recovered run ${run.id} by activating downstream node(s): ${[
          ...new Set(createdOrReset),
        ].join(', ')}`
      );
      return true;
    }
    if (blockedReasons.length > 0) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: run ${run.id} has downstream transition(s) that cannot proceed: ${[
          ...new Set(blockedReasons),
        ].join('; ')}`
      );
    }
    return false;
  }

  private getCycleRepo(): ChannelCycleRepository {
    return this.config.channelCycleRepo ?? new ChannelCycleRepository(this.config.db);
  }

  pruneExpiredCycleEvents(now: number = Date.now()): void {
    if (now - this.lastGlobalCyclePruneAt < DEAD_LOOP_WINDOW_MS) return;
    this.lastGlobalCyclePruneAt = now;
    try {
      this.getCycleRepo().pruneAllOldEvents(now);
    } catch (err) {
      log.warn(
        `[SpaceRuntime] periodic channel_cycle_events prune failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private evaluateRestartRecoveryCycle(
    runId: string,
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    channelIndex: number
  ): { open: true } | { open: false; deadLoop: true; reason: string; recentCount: number } {
    if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) {
      return { open: true };
    }
    const cycleRepo = this.getCycleRepo();
    const recentCount = cycleRepo.countRecentCycleEvents(runId, channelIndex);
    if (recentCount >= DEAD_LOOP_THRESHOLD) {
      return {
        open: false,
        deadLoop: true,
        recentCount,
        reason: `Cyclic channel "${channel.id ?? channelIndex}" is in a dead loop (too many round-trips within the rate window).`,
      };
    }
    return { open: true };
  }

  private async notifyRecoveryDeadLoop(
    run: SpaceWorkflowRun,
    channel: WorkflowChannel,
    channelIndex: number,
    fromAgent: string,
    toTargets: string[],
    recentCount: number
  ): Promise<boolean> {
    if (!this.internalEventBus) return false;
    const channelLabel = channel.id ?? channelIndex;
    try {
      await this.internalEventBus.publish('space.workflowRun.deadLoop', {
        namespaceId: 'global',
        spaceId: run.spaceId,
        runId: run.id,
        fromAgent,
        toTarget: toTargets.length > 0 ? toTargets.join(',') : String(channelLabel),
        channelIndex,
        recentCount,
        threshold: DEAD_LOOP_THRESHOLD,
        windowMs: DEAD_LOOP_WINDOW_MS,
        reason: `Cyclic channel "${channelLabel}" is in a dead loop (detected during restart recovery): ${recentCount} message round-trips within the rate window.`,
        timestamp: new Date().toISOString(),
      } satisfies DaemonInternalEventMap['space.workflowRun.deadLoop'] & InternalEventPayload);
      return true;
    } catch (err) {
      log.warn(
        `[SpaceRuntime] deadLoop notify threw during recovery: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    }
  }

  private recordRestartRecoveryCycleTraversal(
    runId: string,
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    channelIndex: number
  ): void {
    if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) return;
    const cycleRepo = this.getCycleRepo();
    cycleRepo.recordCycleEvent(runId, channelIndex);
  }

  private matchesRestartRecoveryChannelSource(
    channel: WorkflowChannel,
    sourceNode: SpaceWorkflow['nodes'][number],
    sourceAgentName: string
  ): boolean {
    return (
      channel.from === '*' || channel.from === sourceNode.name || channel.from === sourceAgentName
    );
  }

  private shouldRecoverRestartRecoveryTarget(
    targetNode: SpaceWorkflow['nodes'][number],
    executions: NodeExecution[],
    endNodeId?: string
  ): boolean {
    if (targetNode.id === endNodeId) return true;
    const executionsByAgent = new Map(
      executions
        .filter((execution) => execution.workflowNodeId === targetNode.id)
        .map((execution) => [execution.agentName, execution])
    );
    return resolveNodeAgents(targetNode).some((agentEntry) => {
      const execution = executionsByAgent.get(agentEntry.name);
      return !execution || execution.status !== 'idle';
    });
  }

  private resolveRestartRecoveryTargetNames(
    channel: WorkflowChannel,
    workflow: SpaceWorkflow
  ): string[] {
    const rawTargets = Array.isArray(channel.to) ? channel.to : [channel.to];
    const resolvedTargets = new Set<string>();
    for (const rawTarget of rawTargets) {
      const targetNode = workflow.nodes.find(
        (node) =>
          node.name === rawTarget ||
          node.id === rawTarget ||
          resolveNodeAgents(node).some((agent) => agent.name === rawTarget)
      );
      resolvedTargets.add(targetNode?.name ?? rawTarget);
    }
    return [...resolvedTargets];
  }

  private enqueueRestartRecoveryMessage(
    run: SpaceWorkflowRun,
    lastAgentName: string,
    targetNode: SpaceWorkflow['nodes'][number],
    resetExistingTarget: boolean
  ): void {
    const repo = this.config.pendingMessageRepo;
    if (!repo) return;
    const tasks = this.config.taskRepo.listByWorkflowRun(run.id);
    const task = this.pickCanonicalTaskForRun(run, tasks);
    const message = resetExistingTarget
      ? `[Daemon restart recovery] The ${targetNode.name} node's previous session ended before completing the workflow. Please check the PR and review status, then continue.`
      : `[Daemon restart recovery] The previous agent (${lastAgentName}) completed but the handoff message was not delivered. Please check the PR and review status, then continue.`;
    for (const agentEntry of resolveNodeAgents(targetNode)) {
      repo.enqueue({
        workflowRunId: run.id,
        spaceId: run.spaceId,
        taskId: task?.id ?? null,
        sourceAgentName: lastAgentName,
        targetKind: 'node_agent',
        targetAgentName: agentEntry.name,
        workflowNodeId: targetNode.id,
        message,
        idempotencyKey: `daemon-restart-recovery:${targetNode.id}:${agentEntry.name}`,
      });
    }
  }

  private async processCompletedTasks(): Promise<void> {
    let firstError: unknown = null;

    for (const [runId] of this.executors) {
      try {
        await this.processRunTick(runId);
      } catch (err) {
        if (firstError === null) firstError = err;
      }
    }

    if (firstError !== null) throw firstError;
  }

  private makeAgentStuckKey(runId: string, executionId: string): string {
    return `${runId}:${executionId}`;
  }

  private getAgentStuckState(runId: string, execution: NodeExecution): AgentStuckRecoveryState {
    const key = this.makeAgentStuckKey(runId, execution.id);
    const existing = this.agentStuckRecovery.get(key);
    if (existing) return existing;
    const created: AgentStuckRecoveryState = {
      nagCount: 0,
      restartCount: 0,
      lastAction: null,
      lastActionAt: null,
      lastObservedMessageId: null,
      lastObservedMessageAt: null,
      lastObservedProgressMessageId: null,
      lastObservedProgressMessageAt: null,
      lastRuntimeNagMessageId: null,
      lastSessionId: execution.agentSessionId,
      pendingRestartNotice: null,
    };
    this.agentStuckRecovery.set(key, created);
    return created;
  }

  private consumeAgentRestartNotice(runId: string, execution: NodeExecution): string | null {
    const state = this.agentStuckRecovery.get(this.makeAgentStuckKey(runId, execution.id));
    if (!state?.pendingRestartNotice) return null;
    const notice = state.pendingRestartNotice;
    state.pendingRestartNotice = null;
    return notice;
  }

  private clearAgentStuckState(runId: string, executionId: string): void {
    this.agentStuckRecovery.delete(this.makeAgentStuckKey(runId, executionId));
  }

  private clearAgentStuckStateForRun(runId: string): void {
    for (const key of this.agentStuckRecovery.keys()) {
      if (key.startsWith(runId + ':')) {
        this.agentStuckRecovery.delete(key);
      }
    }
    for (const key of this.nonTerminalIdleStates.keys()) {
      if (key.startsWith(runId + ':')) {
        this.nonTerminalIdleStates.delete(key);
      }
    }
    for (const key of this.promptTooLongRecovery.keys()) {
      if (key.startsWith(runId + ':')) {
        this.promptTooLongRecovery.delete(key);
      }
    }
    for (const key of this.terminalErrorContinueStates.keys()) {
      if (key.startsWith(runId + ':')) {
        this.terminalErrorContinueStates.delete(key);
      }
    }
    this.silentStallAttentionLogAt.delete(runId);
  }

  private getAgentNoProgressThresholdMs(workflow: SpaceWorkflow, execution: NodeExecution): number {
    const configuredDefault =
      this.config.agentNoProgressThresholdMs ?? DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS;
    const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    const slot = node?.agents?.find((agent) => agent.name === execution.agentName);
    const slotTimeoutMs = slot?.timeoutMs;
    if (typeof slotTimeoutMs === 'number' && slotTimeoutMs > 0) {
      return slotTimeoutMs;
    }
    return configuredDefault;
  }

  private buildRuntimeNagMessage(
    runId: string,
    execution: NodeExecution,
    lastMessageAt: number,
    reason: string
  ): string {
    return [
      '[Runtime recovery notice]',
      '',
      `No observable progress has been recorded for workflow run ${runId}, node ${execution.workflowNodeId}, agent ${execution.agentName} since ${new Date(lastMessageAt).toISOString()}.`,
      `The last SDK message is non-terminal: ${reason}.`,
      '',
      'Please continue your assigned work from the current state. If work is complete, report completion through the workflow tools. If you are blocked, report the blocker clearly through the available tools. Do not wait silently.',
    ].join('\n');
  }

  private buildNonTerminalIdleNudgeMessage(): string {
    return 'Runtime noticed no recent progress. Continue current work, or report a blocker.';
  }

  private buildRuntimeRestartNotice(execution: NodeExecution): string {
    return [
      '[Runtime session recovery]',
      '',
      `Your previous agent session for node ${execution.workflowNodeId}, agent ${execution.agentName}, stopped making observable progress and was restarted by the runtime.`,
      'Continue the same task from the current repository and workflow state. Inspect task/workflow status, recent messages, git state, PR state, and artifacts as needed before acting. Do not start from scratch blindly.',
      'If you are blocked, report the blocker clearly through the available workflow tools.',
    ].join('\n');
  }

  private async recoverPromptTooLongIdleExecution(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    execution: NodeExecution,
    lastMessage: SDKMessage | null | undefined,
    manager: TaskAgentManager | undefined
  ): Promise<'handled' | 'blocked'> {
    const key = `${runId}:${execution.id}`;
    const sessionId = execution.agentSessionId;
    const now = Date.now();
    const state = this.promptTooLongRecovery.get(key) ?? createPromptTooLongRecoveryState();
    this.promptTooLongRecovery.set(key, state);

    const lastMessageDbId = (lastMessage as { dbId?: string } | null | undefined)?.dbId ?? null;
    const lastMessageIsResult =
      !!lastMessage && (lastMessage as { type?: string }).type === 'result';
    const overflowed = isPromptTooLongErrorMessage(lastMessage);
    const lastMessageIsSuccessResult =
      lastMessageIsResult && !(lastMessage as { is_error?: boolean }).is_error;

    let compactJustFailed = false;
    if (
      state.awaitingContinue &&
      state.awaitingContinueAfterDbId !== null &&
      lastMessageDbId !== state.awaitingContinueAfterDbId &&
      (lastMessageIsResult || overflowed)
    ) {
      state.awaitingContinue = false;
      state.awaitingContinueAfterDbId = null;
      state.awaitingContinueSince = null;
      if (lastMessageIsSuccessResult) {
        state.continueNagPending = true;
        state.awaitingResumeAfterDbId = lastMessageDbId;
      } else if (!overflowed) {
        compactJustFailed = true;
      }
    }

    if (state.awaitingResume && state.awaitingResumeAfterDbId !== null) {
      if (
        lastMessageDbId !== state.awaitingResumeAfterDbId &&
        (lastMessageIsResult || overflowed)
      ) {
        state.awaitingResume = false;
        state.awaitingResumeAfterDbId = null;
        state.awaitingResumeSince = null;
        state.awaitingResumeLastProgressDbId = null;
        if (lastMessageIsSuccessResult) {
          this.promptTooLongRecovery.delete(key);
          return 'handled';
        }
        if (!overflowed) {
          compactJustFailed = true;
        }
      } else {
        if (
          lastMessageDbId !== state.awaitingResumeAfterDbId &&
          lastMessageDbId !== state.awaitingResumeLastProgressDbId &&
          state.awaitingResumeSince !== null
        ) {
          state.awaitingResumeSince = now;
          state.awaitingResumeLastProgressDbId = lastMessageDbId;
        }
        if (
          state.awaitingResumeSince !== null &&
          now - state.awaitingResumeSince > COMPACT_RESULT_TIMEOUT_MS
        ) {
          const reason = `Context-overflow recovery timed out: the resumed turn did not produce a result within ${COMPACT_RESULT_TIMEOUT_MS / 1000}s for agent ${execution.agentName}.`;
          await this.escalatePromptTooLongBlocked(
            runId,
            spaceId,
            canonicalTask,
            execution,
            now,
            reason,
            manager
          );
          return 'blocked';
        }
        return 'handled';
      }
    }

    if (
      state.awaitingContinue &&
      state.awaitingContinueSince !== null &&
      now - state.awaitingContinueSince > COMPACT_RESULT_TIMEOUT_MS
    ) {
      const reason = `Context-overflow recovery timed out: the /compact turn did not produce a result within ${COMPACT_RESULT_TIMEOUT_MS / 1000}s for agent ${execution.agentName}.`;
      await this.escalatePromptTooLongBlocked(
        runId,
        spaceId,
        canonicalTask,
        execution,
        now,
        reason,
        manager
      );
      return 'blocked';
    }

    if (overflowed || compactJustFailed || state.compactRetryPending) {
      state.compactRetryPending = false;
      if (state.awaitingContinue) {
        return 'handled';
      }
      if (state.compactAttempts >= MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS) {
        const reason =
          compactJustFailed || state.compactRetryPending
            ? `Context-overflow recovery: /compact failed (non-overflow error) after ${state.compactAttempts} attempt(s) for agent ${execution.agentName}.`
            : `Context overflow ("prompt is too long") could not be resolved after ${state.compactAttempts} compaction attempt(s); agent ${execution.agentName} cannot make progress.`;
        await this.escalatePromptTooLongBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          now,
          reason,
          manager
        );
        return 'blocked';
      }
      state.compactAttempts += 1;
      let injectedDbId: string | null = null;
      try {
        injectedDbId =
          (await manager?.injectRuntimeRecoveryMessage(sessionId!, '/compact')) ?? null;
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to inject /compact for overflowed execution ${execution.id} ` +
            `(session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (injectedDbId !== null) {
        state.awaitingContinue = true;
        state.awaitingContinueAfterDbId = lastMessageDbId;
        state.awaitingContinueSince = now;
        log.warn(
          `SpaceRuntime: injected /compact for overflowed execution ${execution.id} ` +
            `(agent ${execution.agentName}, session ${sessionId}, attempt ${state.compactAttempts}/${MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS})`
        );
      } else {
        state.compactRetryPending = true;
        log.warn(
          `SpaceRuntime: could not inject /compact for overflowed execution ${execution.id} ` +
            `(session ${sessionId}); will retry or escalate on the next tick`
        );
      }
      return 'handled';
    }

    if (state.awaitingContinue) {
      return 'handled';
    }

    if (state.continueNagPending) {
      let nagDelivered = false;
      try {
        nagDelivered =
          !!(await manager?.injectRuntimeRecoveryMessage(
            sessionId!,
            buildPromptTooLongContinueNag()
          )) && !!manager;
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to inject continue nag for execution ${execution.id} ` +
            `(session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (nagDelivered) {
        state.continueNagPending = false;
        state.continueNagAttempts = 0;
        state.awaitingResume = true;
        state.awaitingResumeSince = now;
        log.warn(
          `SpaceRuntime: injected continue nag after compaction for execution ${execution.id} (agent ${execution.agentName}, session ${sessionId})`
        );
      } else {
        state.continueNagAttempts += 1;
        if (state.continueNagAttempts >= MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS) {
          const reason = `Context-overflow recovery could not deliver the resume nag to agent ${execution.agentName} after ${state.continueNagAttempts} attempts (session unavailable).`;
          await this.escalatePromptTooLongBlocked(
            runId,
            spaceId,
            canonicalTask,
            execution,
            now,
            reason,
            manager
          );
          return 'blocked';
        }
        log.warn(
          `SpaceRuntime: continue nag delivery failed for execution ${execution.id} ` +
            `(session ${sessionId}); will retry (attempt ${state.continueNagAttempts}/${MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS})`
        );
      }
      return 'handled';
    }

    this.promptTooLongRecovery.delete(key);
    return 'handled';
  }

  private async escalatePromptTooLongBlocked(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    execution: NodeExecution,
    now: number,
    reason: string,
    manager: TaskAgentManager | undefined
  ): Promise<void> {
    const key = `${runId}:${execution.id}`;
    if (execution.agentSessionId) {
      try {
        manager?.cancelBySessionId?.(execution.agentSessionId);
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to cancel session ${execution.agentSessionId} during prompt-too-long escalation: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    this.promptTooLongRecovery.delete(key);
    this.config.nodeExecutionRepo.update(execution.id, {
      status: 'blocked',
      result: reason,
      agentSessionId: null,
    });
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
      status: 'blocked',
      result: reason,
      blockReason: 'execution_failed',
      completedAt: null,
    });
    await this.safeNotify({
      kind: 'task_blocked',
      spaceId,
      taskId: canonicalTask.id,
      reason,
      timestamp: new Date(now).toISOString(),
    });
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason,
      timestamp: new Date(now).toISOString(),
    });
    log.warn(
      `SpaceRuntime: blocked execution ${execution.id} (agent ${execution.agentName}) — ${reason}`
    );
  }

  private async handleAliveStuckExecutions(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    nodeExecutions: NodeExecution[],
    tam: TaskAgentManager,
    workflow: SpaceWorkflow,
    space?: Space | null
  ): Promise<'none' | 'restarted' | 'blocked'> {
    if (space?.paused || space?.stopped) return 'none';

    const nagGraceMs = this.config.agentStuckNagGraceMs ?? DEFAULT_AGENT_STUCK_NAG_GRACE_MS;
    const now = Date.now();
    for (const execution of nodeExecutions) {
      if (execution.status !== 'in_progress' || !execution.agentSessionId) {
        if (execution.status !== 'pending') {
          this.clearAgentStuckState(runId, execution.id);
        }
        continue;
      }

      if (!tam.isSessionInMemory(execution.agentSessionId)) continue;
      const session = tam.getAgentSessionById?.(execution.agentSessionId);
      const processingState = session?.getProcessingState();
      if (processingState?.status === 'waiting_for_input') continue;

      if (canonicalTask.pendingCheckpointType === 'task_completion') continue;
      if (
        execution.result &&
        (canonicalTask.status === 'review' || canonicalTask.status === 'approved')
      )
        continue;

      const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(execution.agentSessionId);
      const classification = classifyLastMessageForIdleAgent(lastMessage);
      const state = this.getAgentStuckState(runId, execution);
      const isRuntimeNagMessage =
        lastMessage?.type === 'user' && lastMessage.dbId === state.lastRuntimeNagMessageId;
      const progressMessage = lastMessage && !isRuntimeNagMessage ? lastMessage : null;
      const progressSignals = [execution.lastActivityAt, progressMessage?.timestamp].filter(
        (t): t is number => typeof t === 'number'
      );
      const observedAt =
        progressSignals.length > 0
          ? Math.max(...progressSignals)
          : (execution.startedAt ?? state.lastActionAt ?? now);
      const thresholdMs = this.getAgentNoProgressThresholdMs(workflow, execution);

      if (state.lastSessionId !== execution.agentSessionId) {
        state.lastSessionId = execution.agentSessionId;
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        state.lastObservedMessageAt = lastMessage?.timestamp ?? null;
        state.lastObservedProgressMessageId = progressMessage?.dbId ?? null;
        state.lastObservedProgressMessageAt = progressMessage?.timestamp ?? null;
        state.lastRuntimeNagMessageId = null;
        state.lastAction = null;
        state.lastActionAt = null;
        state.nagCount = 0;
        state.restartCount = 0;
        state.pendingRestartNotice = null;
      } else if (state.lastObservedMessageId !== (lastMessage?.dbId ?? null)) {
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        state.lastObservedMessageAt = lastMessage?.timestamp ?? null;
        if (progressMessage && state.lastObservedProgressMessageId !== progressMessage.dbId) {
          state.lastObservedProgressMessageId = progressMessage.dbId;
          state.lastObservedProgressMessageAt = progressMessage.timestamp;
          state.lastAction = null;
          state.lastActionAt = null;
          state.nagCount = 0;
          state.restartCount = 0;
          state.pendingRestartNotice = null;
        }
      }

      if (classification.terminal) {
        this.clearAgentStuckState(runId, execution.id);
        continue;
      }

      if (this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id)) {
        continue;
      }

      if (now - observedAt <= thresholdMs) continue;

      if (state.nagCount < MAX_AGENT_STUCK_NAGS) {
        const nagMessageId = await tam.injectRuntimeRecoveryMessage(
          execution.agentSessionId,
          this.buildRuntimeNagMessage(runId, execution, observedAt, classification.reason)
        );
        state.lastRuntimeNagMessageId = nagMessageId;
        state.nagCount += 1;
        state.lastAction = 'nag';
        state.lastActionAt = now;
        log.warn(
          `SpaceRuntime: sent runtime nag to stuck agent execution ${execution.id} ` +
            `(agent ${execution.agentName}, session ${execution.agentSessionId})`
        );
        continue;
      }

      if (state.lastAction === 'nag' && state.lastActionAt !== null) {
        const elapsedSinceNag = now - state.lastActionAt;
        if (elapsedSinceNag < nagGraceMs) {
          log.debug(
            `SpaceRuntime: delaying restart for stuck agent execution ${execution.id}; ` +
              `runtime nag grace has ${nagGraceMs - elapsedSinceNag}ms remaining`
          );
          continue;
        }
      }

      if (state.restartCount < MAX_AGENT_STUCK_RESTARTS) {
        await tam.restartStuckSubSession(execution.agentSessionId);
        state.restartCount += 1;
        state.lastAction = 'restart';
        state.lastActionAt = now;
        state.pendingRestartNotice = this.buildRuntimeRestartNotice(execution);
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'pending',
          agentSessionId: null,
          startedAt: null,
          completedAt: null,
          result: 'Runtime restarted agent session after no observable progress.',
        });
        log.warn(
          `SpaceRuntime: restarted stuck agent execution ${execution.id} ` +
            `(agent ${execution.agentName}, session ${execution.agentSessionId})`
        );
        return 'restarted';
      }

      const reason = `Agent stuck without observable progress after runtime nag/restart recovery: ${classification.reason}`;
      state.lastAction = 'blocked';
      state.lastActionAt = now;
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: reason,
      });
      await this.transitionRunStatusAndEmit(runId, 'blocked');
      if (
        this.config.taskRepo.casStatus(
          canonicalTask.id,
          TASK_BLOCKABLE_FROM_STATUSES,
          'blocked'
        ) === 'superseded'
      ) {
        log.warn(
          `SpaceRuntime: skipped blocking task ${canonicalTask.id} for execution ${execution.id} ` +
            `in run ${runId}; task status changed concurrently — keeping the concurrent status`
        );
        return 'blocked';
      }
      await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
        status: 'blocked',
        result: reason,
        blockReason: 'execution_failed',
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId,
        taskId: canonicalTask.id,
        reason,
        timestamp: new Date(now).toISOString(),
      });
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId,
        runId,
        reason,
        timestamp: new Date(now).toISOString(),
      });
      return 'blocked';
    }
    return 'none';
  }

  private resetWorkflowNodeExecutionForSpawnRetry(
    runId: string,
    execution: NodeExecution,
    reason: string,
    sessionId: string | null = execution.agentSessionId
  ): boolean {
    const crashKey = `${runId}:${execution.id}`;
    const crashCount = (this.taskCrashCounts.get(crashKey) ?? 0) + 1;
    this.taskCrashCounts.set(crashKey, crashCount);
    const exhausted = crashCount > MAX_TASK_AGENT_CRASH_RETRIES;
    if (exhausted) {
      log.warn(
        `SpaceRuntime: workflow node agent spawn/retry failed for execution ${execution.id} ` +
          `(session ${sessionId ?? 'none'}); marking blocked after ${crashCount} failures ` +
          `(limit: ${MAX_TASK_AGENT_CRASH_RETRIES}): ${reason}`
      );
      this.config.nodeExecutionRepo.update(execution.id, {
        startedAt: null,
        status: 'blocked',
        result: `Agent session failed to spawn or crashed ${crashCount} times consecutively: ${reason}`,
      });
      return true;
    }

    log.warn(
      `SpaceRuntime: workflow node agent spawn/retry failed for execution ${execution.id} ` +
        `(session ${sessionId ?? 'none'}); resetting execution to pending ` +
        `(failure ${crashCount}/${MAX_TASK_AGENT_CRASH_RETRIES}): ${reason}`
    );
    this.config.nodeExecutionRepo.update(execution.id, {
      startedAt: null,
      status: 'pending',
      result: null,
      completedAt: null,
    });
    return false;
  }

  private async processRunTick(runId: string): Promise<void> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return;
    if (run.status === 'cancelled' || isWorkflowRunSucceeded(run.status)) {
      this.clearAgentStuckStateForRun(runId);
      return;
    }

    if (isWorkflowRunWaiting(run.status)) {
      await this.attemptBlockedRunRecovery(runId, run);
      return;
    }

    const meta = this.executorMeta.get(runId);
    if (!meta) return;

    const allRunTasks = this.config.taskRepo.listByWorkflowRun(runId);
    if (allRunTasks.length === 0) return;

    let canonicalTask = this.pickCanonicalTaskForRun(run, allRunTasks);
    if (!canonicalTask) return;
    if (allRunTasks.length > 1) {
      await this.archiveDuplicateRunTasks(
        meta.spaceId,
        run,
        canonicalTask,
        allRunTasks,
        'active_run'
      );
    }
    if (canonicalTask.workflowRunId !== runId) {
      const refreshed = await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
        workflowRunId: runId,
      });
      canonicalTask = refreshed ?? canonicalTask;
    }

    let cachedNodeExecutions: NodeExecution[] | null = null;
    const loadNodeExecutions = (): NodeExecution[] =>
      (cachedNodeExecutions ??= this.config.nodeExecutionRepo.listByWorkflowRun(runId));
    let cachedRunIsComplete: boolean | null = null;
    const resolveRunIsComplete = (): boolean =>
      (cachedRunIsComplete ??= this.completionDetector.isComplete({ workflowRunId: runId }));

    const admission = decideRunTickAdmission({
      runStatus: run.status,
      hasExecutorMeta: true,
      runTaskCount: allRunTasks.length,
      hasCanonicalTask: true,
      hasEndNodeId: !!meta.workflow.endNodeId,
      canonicalTaskStatus: canonicalTask.status,
      executionCount: () => loadNodeExecutions().length,
      runIsComplete: resolveRunIsComplete,
      hasBlockedExecution: () =>
        !resolveRunIsComplete() &&
        loadNodeExecutions().some((execution) => execution.status === 'blocked'),
      firstBlockedResult: () =>
        loadNodeExecutions().find((execution) => execution.status === 'blocked')?.result ?? null,
      availableTaskSlots: Number.MAX_SAFE_INTEGER,
    });

    if (admission.action === 'skip') return;

    if (admission.action === 'blockInvalidWorkflow') {
      await this.transitionRunStatusAndEmit(runId, 'blocked');
      if (canonicalTask.status !== 'blocked') {
        await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
          status: 'blocked',
          result: 'Workflow is missing endNodeId and cannot be executed safely.',
          blockReason: 'workflow_invalid',
          completedAt: null,
        });
      }
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId: meta.spaceId,
        runId,
        reason: 'Workflow is missing endNodeId',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (canonicalTask.status !== 'blocked') {
      this.notifiedTaskSet.delete(`${canonicalTask.id}:blocked`);
    }
    if (canonicalTask.status !== 'in_progress') {
      this.notifiedTaskSet.delete(`${canonicalTask.id}:timeout`);
    }

    if (admission.action === 'blockOnBlockedExecutions') {
      const blockedReason = admission.blockedReason;
      const dedupKey = `${canonicalTask.id}:blocked`;
      if (!this.notifiedTaskSet.has(dedupKey)) {
        this.notifiedTaskSet.add(dedupKey);
        await this.safeNotify({
          kind: 'task_blocked',
          spaceId: meta.spaceId,
          taskId: canonicalTask.id,
          reason: blockedReason,
          timestamp: new Date().toISOString(),
        });
      }
      await this.transitionRunStatusAndEmit(runId, 'blocked');
      if (canonicalTask.status !== 'blocked') {
        await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
          status: 'blocked',
          result: blockedReason,
          blockReason: 'execution_failed',
          completedAt: null,
        });
      }
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId: meta.spaceId,
        runId,
        reason: 'One or more tasks require attention',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    let nodeExecutions = loadNodeExecutions();
    const runIsComplete = resolveRunIsComplete();

    const space = await this.config.spaceManager.getSpace(meta.spaceId);

    if (!runIsComplete) {
      const taskTimeoutMs = space?.config?.taskTimeoutMs;
      if (taskTimeoutMs !== undefined) {
        const now = Date.now();
        const { timedOutExecutions, maxElapsedMs } = selectTimedOutExecutions(
          nodeExecutions,
          taskTimeoutMs,
          now
        );
        const dedupKey = `${canonicalTask.id}:timeout`;
        if (timedOutExecutions.length === 0) {
          this.notifiedTaskSet.delete(dedupKey);
        } else if (!this.notifiedTaskSet.has(dedupKey)) {
          this.notifiedTaskSet.add(dedupKey);
          await this.safeNotify({
            kind: 'task_timeout',
            spaceId: meta.spaceId,
            taskId: canonicalTask.id,
            elapsedMs: maxElapsedMs,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    if (canonicalTask.status === 'open' && this.getAvailableTaskSlots(space) <= 0) return;

    const tam = this.config.taskAgentManager;
    if (!tam) return;
    let blockedByCrash = false;

    const preTickPendingIds = new Set(
      nodeExecutions
        .filter((execution) => execution.status === 'pending')
        .map((execution) => execution.id)
    );

    if (!space?.stopped) {
      for (const execution of nodeExecutions) {
        if (
          !execution.agentSessionId ||
          (execution.status !== 'in_progress' && execution.status !== 'pending')
        ) {
          continue;
        }

        if (tam.isSessionInMemory(execution.agentSessionId)) {
          continue;
        }

        try {
          const liveSession = tam.getAgentSessionById(execution.agentSessionId);
          if (liveSession) {
            await liveSession.markPendingQuestionOrphaned('agent_session_terminated');
          }
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to clean up pending question for crashed session ${execution.agentSessionId}:`,
            err
          );
        }

        const exhausted = this.resetWorkflowNodeExecutionForSpawnRetry(
          runId,
          execution,
          'agent session is no longer alive',
          execution.agentSessionId
        );
        if (exhausted) {
          blockedByCrash = true;
          await this.safeNotify({
            kind: 'agent_crash',
            spaceId: meta.spaceId,
            taskId: canonicalTask.id,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

    if (blockedByCrash) {
      await this.blockRunForAgentCrash(runId, meta.spaceId, canonicalTask, nodeExecutions);
      return;
    }

    const aliveStuckOutcome = await this.handleAliveStuckExecutions(
      runId,
      meta.spaceId,
      canonicalTask,
      nodeExecutions,
      tam,
      meta.workflow,
      space
    );
    if (aliveStuckOutcome === 'restarted' || aliveStuckOutcome === 'blocked') {
      return;
    }

    const stoppedAfterWaitingRebind = await this.handleWaitingRebindExecutions(
      runId,
      run,
      meta.spaceId,
      canonicalTask
    );
    if (stoppedAfterWaitingRebind) {
      return;
    }
    nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

    const nonTerminalIdleOutcome = await this.handleNonTerminalIdleExecutions(
      runId,
      meta.spaceId,
      canonicalTask,
      meta.workflow,
      tam,
      space
    );
    if (nonTerminalIdleOutcome === 'blocked') {
      return;
    }
    nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

    const terminalErrorOutcome = await this.handleTerminalErrorIdleExecutions(
      runId,
      meta.spaceId,
      canonicalTask,
      tam,
      space
    );
    if (terminalErrorOutcome === 'blocked') {
      return;
    }
    nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

    this.detectSilentStallForAttention(runId, canonicalTask, space);

    if (
      canonicalTask.status === 'done' ||
      canonicalTask.status === 'cancelled' ||
      canonicalTask.status === 'archived'
    ) {
      const stoppedAfterTerminalHandoffCleanup = await this.repairQueuedWorkflowNodeHandoffs(
        runId,
        run,
        meta,
        canonicalTask,
        space
      );
      if (stoppedAfterTerminalHandoffCleanup) {
        return;
      }
    }

    if (space?.stopped) return;

    if (runIsComplete) {
      await this.transitionRunStatusAndEmit(runId, 'done');
      const summaryFromArtifact = this.resolvePrimaryResultArtifactSummary(runId);
      const computedSummary = this.resolveCompletionSummary(runId, meta.workflow);
      const reportedSummary = normalizeMeaningfulTaskResult(canonicalTask.reportedSummary);
      const existingResult = normalizeMeaningfulTaskResult(canonicalTask.result);
      const { nextTaskResult, nextReportedSummary } = resolveCompletionSummaries({
        summaryFromArtifact: summaryFromArtifact ?? null,
        computedSummary: computedSummary ?? null,
        existingResult,
        reportedSummary,
      });

      const alreadyResolved = isTaskAlreadyResolved(canonicalTask.status);
      let finalTaskStatus: SpaceTask['status'] = canonicalTask.status;
      let spawnedPostApprovalSessionId: string | undefined;

      if (!alreadyResolved) {
        const updates = this.buildTaskOutcomeUpdates(
          canonicalTask,
          nextTaskResult,
          nextReportedSummary
        );
        if (updates) {
          await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, updates);
        }
        const result = await this.dispatchPostApproval(canonicalTask.id, 'agent');
        const postApprovalSessionId =
          result.mode === 'spawn' || result.mode === 'already-routed'
            ? result.postApprovalSessionId
            : undefined;
        spawnedPostApprovalSessionId = resolveSpawnedPostApprovalSession(
          result.mode,
          postApprovalSessionId
        );
        finalTaskStatus = mapFinalTaskStatus(result.mode, canonicalTask.status);
      } else {
        const updates = this.buildTaskOutcomeUpdates(
          canonicalTask,
          nextTaskResult,
          nextReportedSummary
        );
        if (updates) {
          await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, updates);
        }
      }

      if (isSettlementTerminal(finalTaskStatus)) {
        const sourceNodeId = resolveQuiesceSourceNodeId(canonicalTask, meta.workflow.endNodeId);
        const siblingsToQuiesce = selectSiblingsToQuiesce(
          this.config.nodeExecutionRepo.listByWorkflowRun(runId),
          spawnedPostApprovalSessionId,
          sourceNodeId
        );
        for (const sibling of siblingsToQuiesce) {
          this.config.nodeExecutionRepo.updateStatus(sibling.id, 'idle');
          if (this.config.taskAgentManager) {
            void this.config.taskAgentManager
              .interruptBySessionId(sibling.agentSessionId!)
              .catch((err) => {
                log.warn(
                  `SpaceRuntime: failed to interrupt sibling session ${sibling.agentSessionId}:`,
                  err
                );
              });
          }
          log.info(
            `SpaceRuntime: quiesced sibling node execution ${sibling.id} ` +
              `(node ${sibling.workflowNodeId}, agent ${sibling.agentName}) ` +
              `to idle for finished execution attempt ${runId}; session kept alive for post-completion messaging`
          );
        }
      }

      return;
    }

    if (space?.paused || space?.stopped) return;

    const hasQueuedNodeHandoff =
      this.config.pendingMessageRepo
        ?.listPendingForRun(runId)
        .some((row) => row.targetKind === 'node_agent') ?? false;
    if (!space && !hasQueuedNodeHandoff) return;

    const stoppedAfterQueuedHandoffRepair = await this.repairQueuedWorkflowNodeHandoffs(
      runId,
      run,
      meta,
      canonicalTask,
      space
    );
    if (stoppedAfterQueuedHandoffRepair) {
      return;
    }

    nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

    const aliveSessionIds = new Set<string>();
    for (const execution of nodeExecutions) {
      if (
        execution.status === 'pending' &&
        preTickPendingIds.has(execution.id) &&
        execution.agentSessionId &&
        tam.isSessionInMemory(execution.agentSessionId)
      ) {
        aliveSessionIds.add(execution.agentSessionId);
      }
    }
    const promotable = selectPromotablePendingExecutions(
      nodeExecutions,
      preTickPendingIds,
      aliveSessionIds
    );
    for (const execution of promotable) {
      log.warn(
        `SpaceRuntime: repaired pending execution ${execution.id} with live session ${execution.agentSessionId}`
      );
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: execution.agentSessionId,
        startedAt: execution.startedAt ?? Date.now(),
        completedAt: null,
      });
    }
    nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

    const pendingExecutions = nodeExecutions.filter((execution) => execution.status === 'pending');

    const freshCanonicalTask = this.config.taskRepo.getTask(canonicalTask.id);
    if (freshCanonicalTask) canonicalTask = freshCanonicalTask;

    const spawnAdmission = decideSpawnAdmission({
      pendingExecutionCount: pendingExecutions.length,
      canonicalTaskStatus: canonicalTask.status,
      pendingExecutions,
      hasSpace: !!space,
    });

    if (spawnAdmission.action === 'skipSpawn') {
      if (
        spawnAdmission.reason === 'canonical_task_terminal' ||
        spawnAdmission.reason === 'parked_awaiting_approval'
      ) {
        log.info(
          `SpaceRuntime: skipping agent spawn for run ${runId} — canonical task ${canonicalTask.id} status is ${canonicalTask.status}`
        );
      } else if (spawnAdmission.reason === 'space_missing') {
        log.warn(
          `SpaceRuntime: cannot spawn workflow node agents for run ${runId} — space ${meta.spaceId} not found`
        );
      }
    } else if (spawnAdmission.action === 'spawn' && space) {
      let permanentSpawnFailureReason: string | null = null;
      for (const execution of pendingExecutions) {
        if (tam.isExecutionSpawning(execution.id)) continue;
        try {
          const sessionId = await tam.spawnWorkflowNodeAgentForExecution(
            canonicalTask,
            space,
            meta.workflow,
            run,
            execution,
            { kickoff: true }
          );
          this.flushPendingNodeQueue({
            workflowRunId: runId,
            taskId: canonicalTask.id,
            nodeId: execution.workflowNodeId,
            agentName: execution.agentName,
            sessionId,
          });
          const restartNotice = this.consumeAgentRestartNotice(runId, execution);
          if (restartNotice) {
            void tam.injectRuntimeRecoveryMessage(sessionId, restartNotice).catch((err) => {
              log.warn(
                `SpaceRuntime: failed to deliver restart recovery notice to session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }
        } catch (err) {
          if (isSpawnSupersededError(err)) {
            log.info(
              `SpaceRuntime: spawn for execution ${execution.id} superseded at ${err.stage ?? 'unknown'} — concurrent writer moved a guarded row; skipping for this tick`
            );
            continue;
          }
          if (this.cancelExecutionForPermanentSpawnError(execution, err)) {
            permanentSpawnFailureReason = err instanceof Error ? err.message : String(err);
            continue;
          }
          if (isTransientSpawnError(err)) {
            log.warn(
              `SpaceRuntime: deferring spawn for limited-task execution ${execution.id}: ${err instanceof Error ? err.message : String(err)}`
            );
            continue;
          }
          const stale = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
          const classification = classifySpawnFailure({
            isPermanent: isPermanentSpawnError(err),
            isTransient: isTransientSpawnError(err),
            staleExecutionStatus: stale.status,
          });
          if (classification === 'preserve_stale_terminal') {
            log.warn(
              `SpaceRuntime: preserving terminal execution ${execution.id} (${stale.status}) after spawn failure: ${err instanceof Error ? err.message : String(err)}`
            );
            continue;
          }
          if (stale.agentSessionId) {
            tam.cancelBySessionId(stale.agentSessionId);
          }
          if (
            this.resetWorkflowNodeExecutionForSpawnRetry(
              runId,
              stale,
              err instanceof Error ? err.message : String(err),
              stale.agentSessionId
            )
          ) {
            blockedByCrash = true;
          }
          log.warn(
            `SpaceRuntime: transient spawn failure for workflow node execution ${execution.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (permanentSpawnFailureReason) {
        const refreshedExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
        if (!hasDriveableExecution(refreshedExecutions)) {
          await this.blockRunForPermanentSpawnFailure(
            runId,
            meta.spaceId,
            canonicalTask,
            permanentSpawnFailureReason
          );
          return;
        }
      }
      if (blockedByCrash) {
        nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
        await this.blockRunForAgentCrash(runId, meta.spaceId, canonicalTask, nodeExecutions);
        return;
      }
      if (canonicalTask.status === 'open') {
        const outcome = this.config.taskRepo.casStatus(canonicalTask.id, ['open'], 'in_progress');
        if (outcome === 'won') {
          const nowTs = Date.now();
          await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
            startedAt: canonicalTask.startedAt ?? nowTs,
            completedAt: null,
            pendingCheckpointType: null,
          });
        } else {
          log.info(
            `SpaceRuntime: skipping trailing open→in_progress for task ${canonicalTask.id} — status moved concurrently during the spawn pass`
          );
        }
      }
    }

    return;
  }

  private async blockRunForPermanentSpawnFailure(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    reason: string
  ): Promise<void> {
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
      status: 'blocked',
      result: reason,
      blockReason: 'workflow_invalid',
      completedAt: null,
    });
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private cancelExecutionForPermanentSpawnError(execution: NodeExecution, err: unknown): boolean {
    if (!isPermanentSpawnError(err)) return false;
    const run = this.config.workflowRunRepo.getRun(execution.workflowRunId);
    const task = run
      ? this.pickCanonicalTaskForRun(
          run,
          this.config.taskRepo.listByWorkflowRun(execution.workflowRunId)
        )
      : null;
    if (task) {
      this.unregisterExecution(
        execution.workflowRunId,
        task.id,
        execution.workflowNodeId,
        execution.agentName
      );
    }
    this.config.nodeExecutionRepo.update(execution.id, {
      status: 'cancelled',
      result: err.message,
      completedAt: Date.now(),
    });
    log.warn(
      `SpaceRuntime: cancelled workflow node execution ${execution.id} after permanent spawn failure: ${err.message}`
    );
    return true;
  }

  private async repairQueuedWorkflowNodeHandoffs(
    runId: string,
    run: SpaceWorkflowRun,
    meta: ExecutorMeta,
    canonicalTask: SpaceTask,
    space: Space | null
  ): Promise<boolean> {
    const repo = this.config.pendingMessageRepo;
    const tam = this.config.taskAgentManager;
    if (!repo || !tam) return false;

    repo.expireStale(runId);
    const pending = repo.listPendingForRun(runId).filter((row) => row.targetKind === 'node_agent');
    const isTerminalTask =
      canonicalTask.status === 'done' ||
      canonicalTask.status === 'cancelled' ||
      canonicalTask.status === 'archived';

    if (isTerminalTask) {
      const expiredNodeHandoffs = repo
        .listByRunAndStatus(runId, 'expired')
        .filter((row) => row.targetKind === 'node_agent');
      const reason = `Queued workflow handoff cannot be delivered because task ${canonicalTask.id} is terminal (${canonicalTask.status})`;
      for (const row of pending) repo.markFailed(row.id, reason);
      if (pending.length > 0 || expiredNodeHandoffs.length > 0) {
        log.warn(
          `SpaceRuntime: ignored ${pending.length + expiredNodeHandoffs.length} queued handoff(s) for terminal task: ${reason}`
        );
      }
      return false;
    }

    if (pending.length === 0) {
      const expiredNodeHandoffs = repo
        .listByRunAndStatus(runId, 'expired')
        .filter((row) => row.targetKind === 'node_agent');
      if (expiredNodeHandoffs.length > 0) {
        const first = expiredNodeHandoffs[0];
        const reason = `Queued workflow handoff to ${first.targetAgentName} expired before delivery after ${first.attempts} attempt(s)`;
        await this.blockRunForQueuedHandoffFailure(runId, meta.spaceId, canonicalTask, reason);
        return true;
      }
      return false;
    }

    if (!space) {
      let blockedReason: string | null = null;
      const reason = `Cannot activate queued handoff target: space ${meta.spaceId} not found`;
      for (const row of pending) {
        const updated = repo.markAttemptFailed(row.id, reason);
        if (updated?.status === 'failed') {
          blockedReason = `Queued workflow handoff to ${updated.targetAgentName} failed after ${updated.attempts} attempt(s): ${reason}`;
        }
      }
      if (blockedReason) {
        await this.blockRunForQueuedHandoffFailure(
          runId,
          meta.spaceId,
          canonicalTask,
          blockedReason
        );
        return true;
      }
      return false;
    }

    let blockedReason: string | null = null;
    const groups = new Map<string, Map<string, typeof pending>>();
    for (const row of pending) {
      const nodeId = row.workflowNodeId ?? '';
      let nodeMap = groups.get(row.targetAgentName);
      if (!nodeMap) {
        nodeMap = new Map();
        groups.set(row.targetAgentName, nodeMap);
      }
      let rows = nodeMap.get(nodeId);
      if (!rows) {
        rows = [];
        nodeMap.set(nodeId, rows);
      }
      rows.push(row);
    }
    const recordBlockedFlushFailure = (
      targetAgentName: string,
      rowsForCurrentAttempt: typeof pending
    ): void => {
      const targetRows = [
        ...rowsForCurrentAttempt,
        ...pending.filter((row) => row.targetAgentName === targetAgentName),
      ];
      const first = targetRows
        .map((row) => repo.getById(row.id))
        .find((row) => row?.status === 'failed');
      if (!first) return;
      blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${first.attempts} attempt(s): ${first.lastError ?? 'delivery failed'}`;
    };

    const attemptedLegacyIds = new Set<string>();
    for (const [targetAgentName, nodeMap] of groups) {
      for (const [workflowNodeIdRaw, rowsForTarget] of nodeMap) {
        const workflowNodeId = workflowNodeIdRaw || undefined;
        try {
          const remainingForGroup = repo
            .listPendingForRun(runId)
            .filter(
              (row) =>
                row.targetAgentName === targetAgentName &&
                (row.workflowNodeId ?? '') === workflowNodeIdRaw &&
                (row.workflowNodeId || !attemptedLegacyIds.has(row.id))
            );
          if (remainingForGroup.length === 0) continue;

          const rescopedTarget = this.resolveQueuedHandoffTarget(
            meta.workflow,
            targetAgentName,
            workflowNodeId
          );
          if (
            rescopedTarget &&
            (targetAgentName !== rescopedTarget.agentName ||
              (workflowNodeId ?? null) !== rescopedTarget.nodeId)
          ) {
            for (const row of remainingForGroup) {
              repo.rescopeTarget(row.id, rescopedTarget.agentName, rescopedTarget.nodeId);
            }
          }

          let execution = this.resolveQueuedHandoffExecution(
            runId,
            meta.workflow,
            targetAgentName,
            workflowNodeId
          );

          if (!execution) {
            if (!rescopedTarget) {
              throw new Error(
                `Queued workflow handoff target "${targetAgentName}" is not declared in workflow "${meta.workflow.id}"`
              );
            }
            execution = this.createNodeExecutionOrIgnore({
              workflowRunId: runId,
              workflowNodeId: rescopedTarget.nodeId,
              agentName: rescopedTarget.agentName,
              agentId: rescopedTarget.agentId,
              status: 'pending',
            });
          }

          if (execution.status === 'waiting_rebind') {
            continue;
          }

          await tam.tryResumeNodeAgentSession(
            runId,
            execution.agentName,
            execution.workflowNodeId ?? undefined
          );
          execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
          if (execution.status === 'waiting_rebind') {
            continue;
          }

          if (execution.agentSessionId && tam.isSessionInMemory(execution.agentSessionId)) {
            await tam.flushPendingMessagesForTarget(
              runId,
              execution.agentName,
              execution.agentSessionId
            );
            recordBlockedFlushFailure(targetAgentName, rowsForTarget);
            for (const row of pending) {
              if (row.targetAgentName === targetAgentName && !row.workflowNodeId) {
                attemptedLegacyIds.add(row.id);
              }
            }
            continue;
          }

          if (execution.agentSessionId && !tam.isSessionInMemory(execution.agentSessionId)) {
            this.resetWorkflowNodeExecutionForSpawnRetry(
              runId,
              execution,
              'queued handoff execution referenced a dead session before spawn',
              execution.agentSessionId
            );
            execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
            if (execution.status === 'blocked') {
              blockedReason = execution.result ?? 'Queued workflow handoff target failed to spawn';
              continue;
            }
          }

          if (execution.status === 'blocked') {
            this.config.nodeExecutionRepo.update(execution.id, {
              status: 'pending',
              result: null,
              completedAt: null,
            });
            execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
          }

          if (tam.isExecutionSpawning(execution.id)) {
            continue;
          }

          const sessionId = await tam.spawnWorkflowNodeAgentForExecution(
            canonicalTask,
            space,
            meta.workflow,
            run,
            execution,
            { kickoff: true }
          );
          this.flushPendingNodeQueue({
            workflowRunId: runId,
            taskId: canonicalTask.id,
            nodeId: execution.workflowNodeId,
            agentName: execution.agentName,
            sessionId,
          });
          await tam.flushPendingMessagesForTarget(runId, execution.agentName, sessionId);
          recordBlockedFlushFailure(targetAgentName, rowsForTarget);
          for (const row of pending) {
            if (row.targetAgentName === targetAgentName && !row.workflowNodeId) {
              attemptedLegacyIds.add(row.id);
            }
          }
        } catch (err) {
          if (isSpawnSupersededError(err)) {
            log.info(
              `SpaceRuntime: queued handoff spawn for target ${targetAgentName} superseded at ${err.stage ?? 'unknown'} — concurrent writer moved a guarded row; skipping for this pass`
            );
            continue;
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          if (isPermanentSpawnError(err)) {
            log.warn(
              `SpaceRuntime: queued workflow handoff target ${targetAgentName} has permanent spawn failure: ${errMsg}`
            );
          } else {
            log.warn(
              `SpaceRuntime: queued workflow handoff repair failed for target ${targetAgentName}: ${errMsg}`
            );
          }
          const maybeExecution = this.resolveQueuedHandoffExecution(
            runId,
            meta.workflow,
            targetAgentName,
            workflowNodeId
          );
          if (maybeExecution) this.cancelExecutionForPermanentSpawnError(maybeExecution, err);
          for (const row of rowsForTarget) {
            const updated = repo.markAttemptFailed(row.id, errMsg);
            if (updated?.status === 'failed') {
              blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${updated.attempts} attempt(s): ${errMsg}`;
            }
          }
          for (const row of pending) {
            if (row.targetAgentName === targetAgentName && !row.workflowNodeId) {
              attemptedLegacyIds.add(row.id);
            }
          }
        }
      }
    }

    if (blockedReason) {
      await this.blockRunForQueuedHandoffFailure(runId, meta.spaceId, canonicalTask, blockedReason);
      return true;
    }

    return false;
  }

  private resolveQueuedHandoffExecution(
    runId: string,
    workflow: SpaceWorkflow,
    targetAgentName: string,
    workflowNodeId?: string
  ): NodeExecution | undefined {
    const resolved = this.resolveQueuedHandoffTarget(workflow, targetAgentName, workflowNodeId);
    if (resolved) {
      const nodeExecution = this.config.nodeExecutionRepo
        .listByNode(runId, resolved.nodeId)
        .filter((candidate) => candidate.agentName === resolved.agentName)
        .at(-1);
      if (nodeExecution) return nodeExecution;
    }

    return this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter(
        (candidate) =>
          candidate.agentName === targetAgentName &&
          (!workflowNodeId || candidate.workflowNodeId === workflowNodeId)
      )
      .at(-1);
  }

  private resolveQueuedHandoffTarget(
    workflow: SpaceWorkflow,
    targetAgentName: string,
    workflowNodeId?: string
  ): { nodeId: string; agentName: string; agentId: string | null } | null {
    if (!workflowNodeId && targetAgentName.includes('/')) {
      for (const node of workflow.nodes) {
        const exact = resolveNodeAgents(node).find((slot) => slot.name === targetAgentName);
        if (exact)
          return { nodeId: node.id, agentName: exact.name, agentId: exact.agentId ?? null };
      }
    }
    for (const node of workflow.nodes) {
      if (workflowNodeId != null && node.id !== workflowNodeId) continue;
      const slots = resolveNodeAgents(node);

      if (workflowNodeId != null) {
        const direct = slots.find((slot) => slot.name === targetAgentName);
        if (direct)
          return { nodeId: node.id, agentName: direct.name, agentId: direct.agentId ?? null };
        continue;
      }

      let nodeFormMatched = false;
      for (const nodeForm of [node.name, node.id]) {
        const prefix = `${nodeForm}/`;
        if (!targetAgentName.startsWith(prefix)) continue;
        nodeFormMatched = true;
        const direct = slots.find((slot) => slot.name === targetAgentName.slice(prefix.length));
        if (direct)
          return { nodeId: node.id, agentName: direct.name, agentId: direct.agentId ?? null };
      }
      if (nodeFormMatched) continue;

      const nodeNameMatch = node.name === targetAgentName || node.id === targetAgentName;
      const direct = slots.find(
        (slot) => slot.name === targetAgentName || (nodeNameMatch && slot.name === node.name)
      );
      if (direct)
        return { nodeId: node.id, agentName: direct.name, agentId: direct.agentId ?? null };
      if (nodeNameMatch && slots[0]) {
        return { nodeId: node.id, agentName: slots[0].name, agentId: slots[0].agentId ?? null };
      }
      if (nodeNameMatch) {
        return { nodeId: node.id, agentName: targetAgentName, agentId: null };
      }
    }
    return null;
  }

  private async blockRunForAgentCrash(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    nodeExecutions: NodeExecution[]
  ): Promise<void> {
    const blockedReason =
      nodeExecutions.find((execution) => execution.status === 'blocked')?.result ??
      'One or more workflow agents are blocked';
    const dedupKey = `${canonicalTask.id}:blocked`;
    if (!this.notifiedTaskSet.has(dedupKey)) {
      this.notifiedTaskSet.add(dedupKey);
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId,
        taskId: canonicalTask.id,
        reason: blockedReason,
        timestamp: new Date().toISOString(),
      });
    }
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    if (canonicalTask.status !== 'blocked') {
      await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
        status: 'blocked',
        result: blockedReason,
        blockReason: 'agent_crashed',
        completedAt: null,
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason: 'One or more tasks require attention',
      timestamp: new Date().toISOString(),
    });
  }

  private async blockRunForQueuedHandoffFailure(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    reason: string
  ): Promise<void> {
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
      status: 'blocked',
      result: reason,
      blockReason: 'execution_failed',
      completedAt: null,
    });
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleNonTerminalIdleExecutions(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    workflow?: SpaceWorkflow,
    tam?: TaskAgentManager,
    space?: Space | null
  ): Promise<'none' | 'retried' | 'blocked' | 'preserved'> {
    if (space?.paused || space?.stopped) return 'none';

    if (
      canonicalTask.reportedStatus !== null ||
      canonicalTask.status === 'review' ||
      canonicalTask.status === 'approved' ||
      canonicalTask.status === 'done' ||
      canonicalTask.status === 'cancelled' ||
      canonicalTask.status === 'archived' ||
      canonicalTask.status === 'stopped'
    ) {
      return 'none';
    }

    let preservedAny = false;
    const idleExecutions = this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((execution) => execution.status === 'idle' && !!execution.agentSessionId);
    for (const execution of idleExecutions) {
      const sessionId = execution.agentSessionId;
      if (!sessionId) continue;
      const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(sessionId);
      const classification = classifyLastMessageForIdleAgent(lastMessage);
      const key = `${runId}:${execution.id}`;
      const ptlState = this.promptTooLongRecovery.get(key);
      if (
        isPromptTooLongErrorMessage(lastMessage) ||
        ptlState?.awaitingContinue ||
        ptlState?.continueNagPending ||
        ptlState?.awaitingResume ||
        ptlState?.compactRetryPending
      ) {
        const manager = tam ?? this.config.taskAgentManager;
        const outcome = await this.recoverPromptTooLongIdleExecution(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          manager
        );
        if (outcome === 'blocked') return 'blocked';
        preservedAny = true;
        continue;
      }
      if (classification.terminal) {
        this.nonTerminalIdleStates.delete(key);
        this.promptTooLongRecovery.delete(key);
        continue;
      }

      preservedAny = true;
      const state = this.nonTerminalIdleStates.get(key) ?? {
        lastSessionId: sessionId,
        lastObservedMessageId: null,
        lastObservedProgressMessageId: null,
        lastObservedProgressMessageAt: null,
        lastRuntimeNudgeMessageId: null,
        nudgeCount: 0,
        failedNudgeCount: 0,
        lastNudgeAt: null,
        lastAttentionLogAt: null,
      };
      this.nonTerminalIdleStates.set(key, state);

      const isRuntimeNudgeMessage =
        lastMessage?.type === 'user' && lastMessage.dbId === state.lastRuntimeNudgeMessageId;
      const progressMessage = lastMessage && !isRuntimeNudgeMessage ? lastMessage : null;
      if (state.lastSessionId !== sessionId) {
        state.lastSessionId = sessionId;
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        state.lastObservedProgressMessageId = progressMessage?.dbId ?? null;
        state.lastObservedProgressMessageAt = progressMessage?.timestamp ?? null;
        state.lastRuntimeNudgeMessageId = null;
        state.nudgeCount = 0;
        state.failedNudgeCount = 0;
        state.lastNudgeAt = null;
        state.lastAttentionLogAt = null;
      } else if (state.lastObservedMessageId !== (lastMessage?.dbId ?? null)) {
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        if (progressMessage && state.lastObservedProgressMessageId !== progressMessage.dbId) {
          state.lastObservedProgressMessageId = progressMessage.dbId;
          state.lastObservedProgressMessageAt = progressMessage.timestamp;
          state.lastRuntimeNudgeMessageId = null;
          state.nudgeCount = 0;
          state.lastNudgeAt = null;
        }
      }

      const progressSignals = [
        execution.lastActivityAt,
        state.lastObservedProgressMessageAt,
        progressMessage?.timestamp,
      ].filter((t): t is number => typeof t === 'number');
      const observedAt =
        progressSignals.length > 0
          ? Math.max(...progressSignals)
          : (execution.startedAt ?? Date.now());
      const thresholdMs = workflow
        ? this.getAgentNoProgressThresholdMs(workflow, execution)
        : (this.config.agentNoProgressThresholdMs ?? DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS);
      const now = Date.now();
      const reason = `Agent went idle without completing — non-terminal last message (${classification.reason})`;
      if (now - observedAt <= thresholdMs) {
        log.debug(
          `Node ${execution.workflowNodeId} is idle with non-terminal last message but within threshold; preserving idle session: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
        );
        continue;
      }
      if (this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id)) {
        log.debug(
          `Node ${execution.workflowNodeId} is idle with non-terminal last message but has active tool use; preserving idle session: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId}`
        );
        continue;
      }
      if (this.toolContinuationRepo.listPendingInboxForExecution(execution.id).length > 0) {
        log.debug(
          `Node ${execution.workflowNodeId} is idle with non-terminal last message but has pending tool continuation; preserving idle session: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId}`
        );
        continue;
      }
      if (state.nudgeCount > 0) {
        if (state.failedNudgeCount > 0 && state.lastNudgeAt !== null) {
          const retryAfter = state.lastNudgeAt + NON_TERMINAL_IDLE_FAILED_NUDGE_RETRY_MS;
          if (now < retryAfter) {
            if (
              state.lastAttentionLogAt === null ||
              now - state.lastAttentionLogAt >= NON_TERMINAL_IDLE_ATTENTION_LOG_COOLDOWN_MS
            ) {
              state.lastAttentionLogAt = now;
              log.warn(
                `Node ${execution.workflowNodeId} remains idle with non-terminal last message after failed runtime nudge; needs attention: ` +
                  `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
              );
            }
            continue;
          }
        } else {
          if (
            state.lastAttentionLogAt === null ||
            now - state.lastAttentionLogAt >= NON_TERMINAL_IDLE_ATTENTION_LOG_COOLDOWN_MS
          ) {
            state.lastAttentionLogAt = now;
            log.warn(
              `Node ${execution.workflowNodeId} remains idle with non-terminal last message after runtime nudge; needs attention: ` +
                `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
            );
          }
          continue;
        }
      }
      const manager = tam ?? this.config.taskAgentManager;
      if (!manager) {
        log.warn(
          `Node ${execution.workflowNodeId} qualified as idle with non-terminal last message, but TaskAgentManager is unavailable; needs attention: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
        );
        continue;
      }
      state.nudgeCount += 1;
      state.lastNudgeAt = now;
      try {
        state.lastRuntimeNudgeMessageId = await manager.injectRuntimeRecoveryMessage(
          sessionId,
          this.buildNonTerminalIdleNudgeMessage()
        );
        state.failedNudgeCount = 0;
        log.warn(
          `Node ${execution.workflowNodeId} went idle with non-terminal last message; sent direct runtime nudge: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
        );
      } catch (error) {
        state.failedNudgeCount += 1;
        state.lastAttentionLogAt = now;
        log.warn(
          `Failed to nudge idle non-terminal node ${execution.workflowNodeId}; needs attention: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${reason}: ${formatCommandError(error)}`
        );
      }
    }
    return preservedAny ? 'preserved' : 'none';
  }

  private async handleTerminalErrorIdleExecutions(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    tam: TaskAgentManager,
    space?: Space | null
  ): Promise<'none' | 'continued' | 'blocked'> {
    if (space?.paused || space?.stopped) return 'none';

    if (
      canonicalTask.reportedStatus !== null ||
      canonicalTask.status === 'review' ||
      canonicalTask.status === 'approved' ||
      canonicalTask.status === 'done' ||
      canonicalTask.status === 'cancelled' ||
      canonicalTask.status === 'archived'
    ) {
      return 'none';
    }
    if (canonicalTask.status !== 'in_progress') return 'none';

    const graceMs = this.config.agentStuckNagGraceMs ?? DEFAULT_AGENT_STUCK_NAG_GRACE_MS;
    const now = Date.now();

    const allExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
    const idleExecutions = allExecutions.filter(
      (execution) => execution.status === 'idle' && !!execution.agentSessionId
    );

    const executionsBySession = new Map<string, NodeExecution[]>();
    for (const ex of allExecutions) {
      if (!ex.agentSessionId) continue;
      const list = executionsBySession.get(ex.agentSessionId);
      if (list) list.push(ex);
      else executionsBySession.set(ex.agentSessionId, [ex]);
    }

    const activeSessions = new Set<string>();
    for (const ex of allExecutions) {
      if (ex.agentSessionId && (ex.status === 'in_progress' || ex.status === 'pending')) {
        activeSessions.add(ex.agentSessionId);
      }
    }

    const newestPerSession = new Map<string, NodeExecution>();
    for (const execution of idleExecutions) {
      const sid = execution.agentSessionId!;
      if (activeSessions.has(sid)) continue;
      const existing = newestPerSession.get(sid);
      if (!existing || (execution.createdAt ?? 0) >= (existing.createdAt ?? 0)) {
        newestPerSession.set(sid, execution);
      }
    }

    for (const execution of newestPerSession.values()) {
      const sessionId = execution.agentSessionId!;
      const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(sessionId);
      const key = `${runId}:${execution.id}`;
      if (!lastMessage || !this.isRecoverableTerminalErrorResult(lastMessage)) continue;
      const sessionExecutions = executionsBySession.get(sessionId) ?? [execution];

      if (sessionExecutions.some((e) => this.promptTooLongRecovery.has(`${runId}:${e.id}`))) {
        continue;
      }
      if (this.isPromptTooLongResultError(lastMessage)) continue;

      if (this.isRecoveryInterceptedResult(lastMessage)) continue;

      if (
        sessionExecutions.some(
          (e) =>
            this.toolContinuationRepo.hasActiveToolUseForExecution(e.id) ||
            this.toolContinuationRepo.listPendingInboxForExecution(e.id).length > 0
        )
      ) {
        continue;
      }

      if (!tam.isSessionAlive(sessionId)) {
        const crashExhausted = this.resetWorkflowNodeExecutionForSpawnRetry(
          runId,
          execution,
          `terminal-error session is no longer alive (subtype ${lastMessage.subtype})`,
          sessionId
        );
        if (crashExhausted) {
          await this.escalateTerminalErrorToBlocked(
            runId,
            spaceId,
            canonicalTask,
            execution,
            lastMessage,
            tam,
            `terminal-error session died and crash-retries exhausted (subtype ${lastMessage.subtype}, signature ${this.computeTerminalErrorSignature(lastMessage)})`
          );
          return 'blocked';
        }
        this.detachSessionFromAllExecutions(runId, sessionId);
        continue;
      }

      const state =
        this.terminalErrorContinueStates.get(key) ??
        ({
          lastSessionId: sessionId,
          continueCount: 0,
          lastRetriedErrorSignature: null,
          lastContinueAt: null,
          failedInjectionCount: 0,
        } satisfies TerminalErrorContinueState);
      this.terminalErrorContinueStates.set(key, state);

      if (state.lastSessionId !== sessionId) {
        state.lastSessionId = sessionId;
        state.continueCount = 0;
        state.lastRetriedErrorSignature = null;
        state.lastContinueAt = null;
        state.failedInjectionCount = 0;
      }

      const signature = this.computeTerminalErrorSignature(lastMessage);

      if (state.lastContinueAt !== null && now - state.lastContinueAt < graceMs) {
        continue;
      }

      if (state.failedInjectionCount >= MAX_TERMINAL_ERROR_CONTINUE_RETRIES) {
        await this.escalateTerminalErrorToBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          tam,
          `runtime continue injection failed ${state.failedInjectionCount} consecutive time(s) for a live session (${signature})`
        );
        return 'blocked';
      }

      if (
        state.lastRetriedErrorSignature === signature &&
        (lastMessage.subtype === 'error_during_execution' ||
          this.isApiErrorTerminalResult(lastMessage))
      ) {
        await this.escalateTerminalErrorToBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          tam,
          `Terminal error recurred with an identical signature after a runtime continue (${signature})`
        );
        return 'blocked';
      }

      if (state.continueCount >= MAX_TERMINAL_ERROR_CONTINUE_RETRIES) {
        await this.escalateTerminalErrorToBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          tam,
          `Terminal error persisted after ${state.continueCount} runtime continue(s) (${signature})`
        );
        return 'blocked';
      }

      try {
        await tam.injectRuntimeRecoveryMessage(
          sessionId,
          this.buildTerminalErrorContinueMessage(execution, lastMessage)
        );
        state.continueCount += 1;
        state.lastContinueAt = now;
        state.lastRetriedErrorSignature = signature;
        state.failedInjectionCount = 0;
        log.warn(
          `Node ${execution.workflowNodeId} ended idle on a terminal error result; ` +
            `sent runtime continue ${state.continueCount}/${MAX_TERMINAL_ERROR_CONTINUE_RETRIES}: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} ` +
            `subtype=${lastMessage.subtype} signature=${signature}`
        );
      } catch (error) {
        state.lastContinueAt = now;
        state.failedInjectionCount += 1;
        log.warn(
          `Failed to send runtime continue for terminal-error idle node ${execution.workflowNodeId} ` +
            `(failure ${state.failedInjectionCount}/${MAX_TERMINAL_ERROR_CONTINUE_RETRIES}); ` +
            `needs attention: execution=${execution.id} agent=${execution.agentName} ` +
            `session=${sessionId} signature=${signature}: ${formatCommandError(error)}`
        );
      }
    }
    return 'none';
  }

  private detectSilentStallForAttention(
    runId: string,
    canonicalTask: SpaceTask,
    space?: Space | null
  ): void {
    if (space?.paused || space?.stopped) return;
    if (
      canonicalTask.reportedStatus !== null ||
      canonicalTask.status === 'review' ||
      canonicalTask.status === 'approved' ||
      canonicalTask.status === 'done' ||
      canonicalTask.status === 'blocked' ||
      canonicalTask.status === 'cancelled' ||
      canonicalTask.status === 'archived' ||
      canonicalTask.status === 'rate_limited' ||
      canonicalTask.status === 'usage_limited' ||
      canonicalTask.status === 'stopped'
    ) {
      return;
    }

    const hasQueuedNodeHandoff =
      this.config.pendingMessageRepo
        ?.listPendingForRun(runId)
        .some((row) => row.targetKind === 'node_agent') ?? false;
    if (hasQueuedNodeHandoff) return;

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
    if (executions.length === 0) return;
    if (!executions.every((execution) => execution.status === 'idle')) return;
    if (
      executions.some(
        (execution) =>
          this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id) ||
          this.toolContinuationRepo.listPendingInboxForExecution(execution.id).length > 0
      )
    ) {
      return;
    }

    const now = Date.now();
    const continueGraceMs = this.config.agentStuckNagGraceMs ?? DEFAULT_AGENT_STUCK_NAG_GRACE_MS;
    const silenceSignals: number[] = [];
    for (const execution of executions) {
      if (typeof execution.lastActivityAt === 'number') {
        silenceSignals.push(execution.lastActivityAt);
      }
      const sessionId = execution.agentSessionId;
      if (!sessionId) {
        if (typeof execution.startedAt === 'number') silenceSignals.push(execution.startedAt);
        if (typeof execution.completedAt === 'number') {
          silenceSignals.push(execution.completedAt);
        }
        continue;
      }
      const continueState = this.terminalErrorContinueStates.get(`${runId}:${execution.id}`);
      if (
        continueState?.lastContinueAt !== null &&
        continueState?.lastContinueAt !== undefined &&
        now - continueState.lastContinueAt < continueGraceMs
      ) {
        return;
      }
      const promptTooLongState = this.promptTooLongRecovery.get(`${runId}:${execution.id}`);
      if (
        promptTooLongState?.awaitingContinue ||
        promptTooLongState?.continueNagPending ||
        promptTooLongState?.awaitingResume ||
        promptTooLongState?.compactRetryPending
      ) {
        return;
      }
      const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(sessionId);
      if (lastMessage) silenceSignals.push(lastMessage.timestamp);
      if (!classifyLastMessageForIdleAgent(lastMessage).terminal) return;
    }
    if (silenceSignals.length === 0) return;
    const lastActivityAt = Math.max(...silenceSignals);
    const thresholdMs =
      this.config.silentStallAttentionThresholdMs ?? DEFAULT_SILENT_STALL_ATTENTION_THRESHOLD_MS;
    if (now - lastActivityAt <= thresholdMs) return;

    const lastLogAt = this.silentStallAttentionLogAt.get(runId);
    if (lastLogAt !== undefined && now - lastLogAt < SILENT_STALL_ATTENTION_LOG_COOLDOWN_MS) {
      return;
    }
    this.silentStallAttentionLogAt.set(runId, now);

    const idleMinutes = Math.round((now - lastActivityAt) / 60_000);
    const executionSummary = executions
      .map(
        (execution) =>
          `${execution.id}(node=${execution.workflowNodeId} agent=${execution.agentName} ` +
          `session=${execution.agentSessionId ?? 'none'})`
      )
      .join(' ');
    log.warn(
      `Run ${runId} task ${canonicalTask.id} (${canonicalTask.status}) has every node execution idle for ` +
        `${idleMinutes}m while the task never reached a terminal status, even though each idle session's last ` +
        `message looks terminal; needs attention: lastActivityAt=${new Date(lastActivityAt).toISOString()} ` +
        `executions=${executionSummary}`
    );
  }

  private detachSessionFromAllExecutions(runId: string, sessionId: string): void {
    for (const ex of this.config.nodeExecutionRepo.listByWorkflowRun(runId)) {
      if (ex.agentSessionId === sessionId) {
        this.config.nodeExecutionRepo.update(ex.id, { agentSessionId: null });
      }
    }
  }

  private async escalateTerminalErrorToBlocked(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    execution: NodeExecution,
    errorResult: { subtype: string; errors?: string[]; result?: string },
    tam: TaskAgentManager,
    detail: string
  ): Promise<void> {
    const errorDetails = (errorResult.errors ?? []).join('; ');
    const fallbackText = typeof errorResult.result === 'string' ? errorResult.result : '';
    const errorSnippet = (errorDetails !== '' ? errorDetails : fallbackText).slice(0, 280);
    const reason =
      `Agent session ended on a terminal error result and exhausted runtime auto-continue recovery ` +
      `(node ${execution.workflowNodeId}, agent ${execution.agentName}, subtype ${errorResult.subtype}): ` +
      `${detail}${errorSnippet ? ` — ${errorSnippet}` : ''}`;
    if (execution.agentSessionId) {
      try {
        tam.cancelBySessionId(execution.agentSessionId);
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to cancel stale terminal-error session ${execution.agentSessionId} during block escalation: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      this.detachSessionFromAllExecutions(runId, execution.agentSessionId);
    }
    this.config.nodeExecutionRepo.update(execution.id, {
      status: 'blocked',
      result: reason,
      agentSessionId: null,
      startedAt: null,
      completedAt: null,
    });
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
      status: 'blocked',
      result: reason,
      blockReason: 'execution_failed',
      completedAt: null,
    });
    const dedupKey = `${canonicalTask.id}:blocked`;
    if (!this.notifiedTaskSet.has(dedupKey)) {
      this.notifiedTaskSet.add(dedupKey);
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId,
        taskId: canonicalTask.id,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private isRecoverableTerminalErrorResult(
    message: SDKMessage
  ): message is Extract<SDKMessage, { type: 'result' }> {
    if (isSDKResultError(message)) {
      return message.subtype === 'error_during_execution' || message.subtype === 'error_max_turns';
    }
    return this.isApiErrorTerminalResult(message);
  }

  private isApiErrorTerminalResult(
    message: SDKMessage
  ): message is Extract<SDKMessage, { type: 'result'; subtype: 'success' }> {
    return (
      isSDKResultSuccess(message) &&
      message.is_error === true &&
      (message.terminal_reason === 'api_error' ||
        message.terminal_reason === 'blocking_limit' ||
        message.terminal_reason === 'rapid_refill_breaker' ||
        typeof message.api_error_status === 'number')
    );
  }

  private isRecoveryInterceptedResult(message: {
    subtype: string;
    recovery_intercepted?: boolean | number;
  }): boolean {
    return message.recovery_intercepted === true || message.recovery_intercepted === 1;
  }

  private computeTerminalErrorSignature(message: {
    subtype: string;
    terminal_reason?: string;
    errors?: string[];
    result?: string;
    api_error_status?: number | null;
  }): string {
    const terminalReason =
      typeof message.terminal_reason === 'string' ? message.terminal_reason : '';
    const errors = (message.errors ?? []).map((entry) => entry.trim().slice(0, 200));
    const resultText =
      typeof message.result === 'string' ? message.result.trim().slice(0, 200) : '';
    const status =
      typeof message.api_error_status === 'number' ? String(message.api_error_status) : '';
    return `${message.subtype}|${terminalReason}|${errors.join('\n')}${resultText}|${status}`;
  }

  private isPromptTooLongResultError(message: {
    terminal_reason?: string;
    errors?: string[];
    result?: string;
  }): boolean {
    if (message.terminal_reason === 'prompt_too_long') return true;
    const text = [
      ...(message.errors ?? []),
      typeof message.result === 'string' ? message.result : '',
    ].join('\n');
    return /prompt is too long/i.test(text);
  }

  private buildTerminalErrorContinueMessage(
    execution: NodeExecution,
    errorResult: { subtype: string; errors?: string[]; result?: string }
  ): string {
    const errorDetails = (errorResult.errors ?? []).join('; ');
    const fallbackText = typeof errorResult.result === 'string' ? errorResult.result : '';
    const errorSummary = (errorDetails !== '' ? errorDetails : fallbackText).slice(0, 280);
    return [
      '[Runtime recovery — terminal error]',
      '',
      `Your previous turn ended with a terminal error result (${errorResult.subtype})` +
        `${errorSummary ? `: ${errorSummary}` : ''}.`,
      `The error appears transient. Resume your assigned task for node ${execution.workflowNodeId}` +
        ` (agent ${execution.agentName}) from the current repository and workflow state.`,
      'Inspect task/workflow status, recent messages, and any partial work before continuing.',
      'If the same error recurs, report the blocker clearly through the available workflow tools.',
    ].join('\n');
  }

  private async handleWaitingRebindExecutions(
    runId: string,
    run: SpaceWorkflowRun,
    spaceId: string,
    canonicalTask: SpaceTask
  ): Promise<boolean> {
    const waitingExecutions = this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((execution) => execution.status === 'waiting_rebind');
    if (waitingExecutions.length === 0) return false;

    const recoveryStates = waitingExecutions.map((execution) => {
      const data = parseNodeExecutionData(execution.data);
      const recoveryData = isRecord(data.orphanedToolContinuation)
        ? data.orphanedToolContinuation
        : {};
      const retryCount = typeof recoveryData.retryCount === 'number' ? recoveryData.retryCount : 0;
      const pendingInbox = this.toolContinuationRepo.listPendingInboxForExecution(execution.id);
      const hasActiveTool = this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id);
      const hasLiveSession = execution.agentSessionId
        ? (this.config.taskAgentManager?.isSessionAlive(execution.agentSessionId) ?? false)
        : false;
      return {
        execution,
        data,
        recoveryData,
        retryCount,
        pendingInbox,
        hasActiveTool,
        hasLiveSession,
      };
    });

    for (const state of recoveryStates) {
      const {
        execution,
        data,
        recoveryData,
        retryCount,
        pendingInbox,
        hasActiveTool,
        hasLiveSession,
      } = state;
      if (hasActiveTool || hasLiveSession) {
        continue;
      }

      if (pendingInbox.length > 0 && retryCount < 1) {
        continue;
      }

      const reason =
        retryCount >= 1
          ? 'orphaned tool_result recovery exhausted its single automatic retry'
          : 'orphaned tool_result recovery expired before a continuation arrived';
      data.orphanedToolContinuation = {
        ...recoveryData,
        state: 'failed',
        retryCount,
        reason,
        updatedAt: Date.now(),
      };
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: reason,
        data,
        completedAt: Date.now(),
      });
      await this.transitionRunStatusAndEmit(run.id, 'blocked');
      await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
        status: 'blocked',
        result: reason,
        blockReason: 'execution_failed',
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId,
        runId,
        reason,
        timestamp: new Date().toISOString(),
      });
      log.warn(
        `SpaceRuntime: failed orphaned tool_result recovery for execution ${execution.id}: ${reason}`
      );
      return true;
    }

    for (const state of recoveryStates) {
      const { execution, data, recoveryData, retryCount, pendingInbox, hasLiveSession } = state;
      if (hasLiveSession || pendingInbox.length === 0 || retryCount >= 1) {
        continue;
      }

      const reason =
        pendingInbox[0]?.recoveryReason ??
        'orphaned tool_result continuation queued for deterministic retry';
      data.orphanedToolContinuation = {
        ...recoveryData,
        state: 'rebound',
        retryCount: retryCount + 1,
        reason,
        queuedContinuations: pendingInbox.length,
        updatedAt: Date.now(),
      };
      this.toolContinuationRepo.markInboxReboundForExecution(
        execution.id,
        'queued orphaned tool_result rebound by restarting workflow node execution'
      );
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        result: null,
        data,
        startedAt: null,
        completedAt: null,
      });
      if (run.status !== 'in_progress') {
        await this.transitionRunStatusAndEmit(run.id, 'in_progress');
      }
      if (canonicalTask.status === 'blocked' || canonicalTask.status === 'open') {
        await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
          status: 'in_progress',
          completedAt: null,
          result: null,
          blockReason: null,
        });
      }
      await this.safeNotify({
        kind: 'task_retry',
        spaceId,
        taskId: canonicalTask.id,
        runId,
        originalReason: reason,
        attemptNumber: retryCount + 1,
        maxAttempts: 1,
        timestamp: new Date().toISOString(),
      });
      log.info(
        `SpaceRuntime: rebound orphaned tool_result continuation for execution ${execution.id}; ` +
          `reset to pending for retry ${retryCount + 1}/1`
      );
    }
    return false;
  }

  private async attemptBlockedRunRecovery(runId: string, run: SpaceWorkflowRun): Promise<void> {
    const meta = this.executorMeta.get(runId);
    if (!meta) return;

    const allRunTasks = this.config.taskRepo.listByWorkflowRun(runId);
    if (allRunTasks.length === 0) return;
    const canonicalTask = this.pickCanonicalTaskForRun(run, allRunTasks);
    if (!canonicalTask) return;
    if (canonicalTask.status === 'stopped') return;

    const retryCount = this.blockedRetryCounts.get(runId) ?? 0;
    const blockedExecutions = this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((e) => e.status === 'blocked');

    if (blockedExecutions.length === 0) return;

    const space = await this.config.spaceManager.getSpace(meta.spaceId);
    if (space?.paused || space?.stopped) return;

    const blockedReason = blockedExecutions[0].result ?? 'Unknown blocked reason';

    const taskReopenedOutsideRuntime =
      canonicalTask.status === 'in_progress' || canonicalTask.status === 'open';
    let effectiveRetryCount = retryCount;
    if (taskReopenedOutsideRuntime && retryCount >= MAX_BLOCKED_RUN_RETRIES) {
      effectiveRetryCount = 0;
      this.blockedRetryCounts.set(runId, 0);
      log.info(
        `SpaceRuntime: canonical task ${canonicalTask.id} was reopened while run ${runId} ` +
          `is blocked; resetting the blocked-run retry budget and repairing executions before resume`
      );
    }

    if (effectiveRetryCount < MAX_BLOCKED_RUN_RETRIES) {
      if (!taskReopenedOutsideRuntime && this.getAvailableTaskSlots(space) <= 0) return;

      for (const execution of blockedExecutions) {
        const bindingAlive =
          !!execution.agentSessionId &&
          (this.config.taskAgentManager?.isSessionInMemory(execution.agentSessionId) ?? false) &&
          !this.isFailedSessionBinding(execution.agentSessionId);
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'pending',
          result: null,
          startedAt: null,
          completedAt: null,
          ...(bindingAlive ? {} : { agentSessionId: null }),
        });
      }
      this.blockedRetryCounts.set(runId, effectiveRetryCount + 1);

      await this.transitionRunStatusAndEmit(runId, 'in_progress');
      if (canonicalTask.status === 'blocked') {
        await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
          status: 'in_progress',
          completedAt: null,
        });
      }

      this.notifiedTaskSet.delete(`${canonicalTask.id}:blocked`);

      await this.safeNotify({
        kind: 'task_retry',
        spaceId: meta.spaceId,
        taskId: canonicalTask.id,
        runId,
        originalReason: blockedReason,
        attemptNumber: effectiveRetryCount + 1,
        maxAttempts: MAX_BLOCKED_RUN_RETRIES,
        timestamp: new Date().toISOString(),
      });
      log.info(
        `SpaceRuntime: auto-retrying blocked run ${runId} ` +
          `(attempt ${effectiveRetryCount + 1}/${MAX_BLOCKED_RUN_RETRIES})`
      );
    } else {
      await this.safeNotify({
        kind: 'workflow_run_needs_attention',
        spaceId: meta.spaceId,
        runId,
        taskId: canonicalTask.id,
        reason: blockedReason,
        retriesExhausted: retryCount,
        timestamp: new Date().toISOString(),
      });
      log.warn(
        `SpaceRuntime: blocked run ${runId} exhausted ${retryCount} retries, ` +
          `emitted workflow_run_needs_attention`
      );
    }
  }

  private isFailedSessionBinding(sessionId: string): boolean {
    const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(sessionId);
    if (!lastMessage || !isSDKResultError(lastMessage)) return false;
    return (
      lastMessage.subtype === 'error_during_execution' || lastMessage.subtype === 'error_max_turns'
    );
  }

  private resolvePrUrlForRun(runId: string): string {
    return this.config.artifactProfile?.resolvePrimaryLinkUrl(runId) ?? '';
  }

  private resolvePrimaryResultArtifactSummary(runId: string): string | undefined {
    return this.config.artifactProfile?.summarizeRunOutcome(runId) ?? undefined;
  }

  private buildTaskOutcomeUpdates(
    task: SpaceTask,
    result: string | null,
    reportedSummary: string | null
  ): UpdateSpaceTaskParams | null {
    const updates: UpdateSpaceTaskParams = {};
    if (result && task.result !== result) {
      updates.result = result;
    }
    if (reportedSummary && task.reportedSummary !== reportedSummary) {
      updates.reportedSummary = reportedSummary;
    }
    return Object.keys(updates).length > 0 ? updates : null;
  }

  private resolveCompletionSummary(runId: string, workflow: SpaceWorkflow): string | undefined {
    const channels = workflow.channels ?? [];
    const nodes = workflow.nodes;

    const nameToNodeId = new Map<string, string>();
    for (const node of nodes) {
      nameToNodeId.set(node.name, node.id);
      if (node.agents) {
        for (const agent of node.agents) {
          nameToNodeId.set(agent.name, node.id);
        }
      }
    }

    const resolveRef = (ref: string): string | undefined => {
      if (ref === '*') return undefined;
      const slashIdx = ref.indexOf('/');
      if (slashIdx !== -1) {
        return ref.slice(0, slashIdx);
      }
      return nameToNodeId.get(ref);
    };

    const nodesWithOutbound = new Set<string>();
    for (const ch of channels) {
      const fromId = resolveRef(ch.from);
      if (fromId) nodesWithOutbound.add(fromId);
    }

    const terminalNodeIds = new Set<string>();
    for (const node of nodes) {
      if (!nodesWithOutbound.has(node.id)) {
        terminalNodeIds.add(node.id);
      }
    }

    if (terminalNodeIds.size === 0) return undefined;

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
    for (const execution of executions) {
      if (
        terminalNodeIds.has(execution.workflowNodeId) &&
        execution.status === 'idle' &&
        execution.result
      ) {
        return execution.result;
      }
    }

    return undefined;
  }

  private async cleanupTerminalExecutors(): Promise<void> {
    for (const [runId] of this.executors) {
      const run = this.config.workflowRunRepo.getRun(runId);

      if (run?.status === 'blocked') {
        continue;
      }

      if (!run || run.status === 'done' || run.status === 'cancelled') {
        this.clearAgentStuckStateForRun(runId);
        if (run?.status === 'done') {
          const meta = this.executorMeta.get(runId);
          if (meta) {
            const summary = this.resolveCompletionSummary(runId, meta.workflow);
            await this.safeNotify({
              kind: 'workflow_run_completed',
              spaceId: meta.spaceId,
              runId,
              status: 'done',
              summary,
              timestamp: new Date().toISOString(),
            });
          }
        }
        const currentRun = this.config.workflowRunRepo.getRun(runId);
        if (currentRun && currentRun.status !== 'done' && currentRun.status !== 'cancelled') {
          continue;
        }
        if (run) {
          await this.reconcileTerminalRunTasks(run);
        }
        const postReconcileRun = this.config.workflowRunRepo.getRun(runId);
        if (
          postReconcileRun &&
          postReconcileRun.status !== 'done' &&
          postReconcileRun.status !== 'cancelled'
        ) {
          continue;
        }
        for (const task of this.config.taskRepo.listByWorkflowRun(runId)) {
          this.notifiedTaskSet.delete(`${task.id}:blocked`);
          this.notifiedTaskSet.delete(`${task.id}:timeout`);
        }
        this.executors.delete(runId);
        this.executorMeta.delete(runId);
      }
    }
  }

  getTaskManagerForSpace(spaceId: string): SpaceTaskManager {
    return this.getOrCreateTaskManager(spaceId);
  }

  parkInFlightExecutionsForSpace(spaceId: string): void {
    for (const run of this.config.workflowRunRepo.listBySpace(spaceId)) {
      this.parkInFlightExecutionsForRun(run.id);
    }
  }

  parkInFlightExecutionsForTask(taskId: string): string | null {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return null;
    this.parkInFlightExecutionsForRun(task.workflowRunId);
    return task.workflowRunId;
  }

  parkInFlightExecutionsForRun(runId: string): void {
    const inFlightExecutions = this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((execution) => execution.status === 'in_progress');
    for (const execution of inFlightExecutions) {
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        result: null,
        agentSessionId: null,
      });
      this.taskCrashCounts.delete(`${runId}:${execution.id}`);
    }
    this.clearAgentStuckStateForRun(runId);
    this.blockedRetryCounts.delete(runId);
  }

  private async recoverRateLimitedTasks(): Promise<void> {
    const spaces = await this.listActiveSpaces();
    const now = Date.now();
    for (const space of spaces) {
      for (const task of this.config.taskRepo.listRateLimitedBySpace(space.id)) {
        if (task.restrictions?.limit === 'billing-terminal') continue;
        const resetAt = task.restrictions?.resetAt;
        if (resetAt !== undefined && resetAt > now) continue;
        try {
          const tam = this.config.taskAgentManager;
          const liveSessionForTask =
            !!task.workflowRunId &&
            this.config.nodeExecutionRepo
              .listByWorkflowRun(task.workflowRunId)
              .some(
                (e) =>
                  e.status === 'in_progress' &&
                  !!e.agentSessionId &&
                  (tam?.isSessionInMemory(e.agentSessionId) ?? false)
              );
          if (liveSessionForTask) continue;
          if (task.workflowRunId) {
            for (const exec of this.config.nodeExecutionRepo.listByWorkflowRun(
              task.workflowRunId
            )) {
              if (exec.status === 'in_progress') {
                this.config.nodeExecutionRepo.update(exec.id, {
                  status: 'pending',
                  result: null,
                  agentSessionId: null,
                });
              }
            }
          }
          await this.updateTaskAndEmit(space.id, task.id, {
            status: 'in_progress',
            restrictions: null,
          });
          log.info(
            `SpaceRuntime: auto-resumed ${task.status} task ${task.id} (resetAt ${resetAt ?? 'none'} ≤ now) — rehydration will restart the worker.`
          );
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to auto-resume paused task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  private async checkStandaloneTasks(): Promise<void> {
    const spaces = await this.listActiveSpaces();

    for (const space of spaces) {
      const allStandalone = this.config.taskRepo.listStandaloneBySpace(space.id, true);
      const activeStandalone = allStandalone.filter((t) => !t.archivedAt);

      for (const task of allStandalone) {
        const archived = !!task.archivedAt;
        if (archived || task.status !== 'blocked') {
          this.notifiedTaskSet.delete(`${task.id}:blocked`);
        }
        if (archived || task.status !== 'in_progress') {
          this.notifiedTaskSet.delete(`${task.id}:timeout`);
        }
      }

      for (const task of activeStandalone) {
        if (task.status !== 'blocked') continue;
        const dedupKey = `${task.id}:blocked`;
        if (!this.notifiedTaskSet.has(dedupKey)) {
          this.notifiedTaskSet.add(dedupKey);
          await this.safeNotify({
            kind: 'task_blocked',
            spaceId: space.id,
            taskId: task.id,
            reason: 'Task requires attention',
            timestamp: new Date().toISOString(),
          });
        }
      }

      const taskTimeoutMs = space.config?.taskTimeoutMs;
      if (taskTimeoutMs !== undefined) {
        const now = Date.now();
        for (const task of activeStandalone) {
          if (task.status !== 'in_progress' || !task.startedAt) continue;
          const elapsedMs = now - task.startedAt;
          if (elapsedMs > taskTimeoutMs) {
            const dedupKey = `${task.id}:timeout`;
            if (!this.notifiedTaskSet.has(dedupKey)) {
              this.notifiedTaskSet.add(dedupKey);
              await this.safeNotify({
                kind: 'task_timeout',
                spaceId: space.id,
                taskId: task.id,
                elapsedMs,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      }
    }
  }

  private normalizeConcurrentTaskLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return MIN_SPACE_CONCURRENT_TASKS;
    return Math.min(
      MAX_SPACE_CONCURRENT_TASKS,
      Math.max(MIN_SPACE_CONCURRENT_TASKS, Math.trunc(limit))
    );
  }

  private getConcurrentTaskLimit(space: Space): number {
    return this.normalizeConcurrentTaskLimit(
      space.maxConcurrentTasks ?? space.config?.maxConcurrentTasks
    );
  }

  private getRunningTaskCount(spaceId: string): number {
    return this.config.taskRepo
      .listBySpace(spaceId, false)
      .filter(
        (task) =>
          task.status === 'in_progress' ||
          task.status === 'approved' ||
          isRateOrUsageLimited(task.status)
      ).length;
  }

  private getAvailableTaskSlots(space: Space | null): number {
    if (!space) return 0;
    return Math.max(0, this.getConcurrentTaskLimit(space) - this.getRunningTaskCount(space.id));
  }

  private sortTasksByPriority(tasks: SpaceTask[]): SpaceTask[] {
    return [...tasks].sort((a, b) => {
      const priorityDelta = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDelta !== 0) return priorityDelta;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
  }

  private async attachStandaloneTasksToWorkflows(): Promise<void> {
    const spaces = await this.listActiveSpaces();

    for (const space of spaces) {
      const workflows = this.config.spaceWorkflowManager
        .listWorkflows(space.id)
        .filter((w) => !w.disabled);
      if (workflows.length === 0) continue;

      let availableSlots = this.getAvailableTaskSlots(space);
      if (availableSlots <= 0) continue;

      const standaloneOpenTasks = this.sortTasksByPriority(
        this.config.taskRepo
          .listStandaloneBySpace(space.id, false)
          .filter((task) => task.status === 'open')
      );

      const taskManager = this.getOrCreateTaskManager(space.id);

      for (const task of standaloneOpenTasks) {
        if (availableSlots <= 0) break;
        const fresh = this.config.taskRepo.getTask(task.id);
        if (!fresh || fresh.workflowRunId) continue;
        if (fresh.status !== 'open') continue;
        if (!(await taskManager.areDependenciesMet(fresh))) continue;

        const selected = await this.selectWorkflowForStandaloneTask(fresh, workflows);
        if (!selected) continue;

        const current = this.config.taskRepo.getTask(fresh.id);
        if (!current || current.workflowRunId) continue;
        if (current.status !== 'open') continue;
        if (this.getAvailableTaskSlots(space) <= 0) {
          availableSlots = 0;
          break;
        }

        try {
          const { run } = await this.startWorkflowRun(
            space.id,
            selected.id,
            current.title,
            current.description,
            { parentTaskId: current.id }
          );

          await this.updateTaskAndEmit(space.id, current.id, {
            workflowRunId: run.id,
            status: 'in_progress',
            startedAt: current.startedAt ?? Date.now(),
            completedAt: null,
          });
          availableSlots--;
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to attach standalone task ${current.id} to workflow ${selected.id}:`,
            err
          );
        }
      }
    }
  }

  private async selectWorkflowForStandaloneTask(
    task: SpaceTask,
    workflows: SpaceWorkflow[]
  ): Promise<SpaceWorkflow | null> {
    if (workflows.length === 0) return null;

    if (task.preferredWorkflowId) {
      const explicit = this.config.spaceWorkflowManager.getWorkflow(task.preferredWorkflowId);
      if (explicit && !explicit.disabled) return explicit;
      log.warn(
        `SpaceRuntime: preferred_workflow_id "${task.preferredWorkflowId}" not found or disabled for task ${task.id}; selecting a workflow automatically`
      );
    }

    if (workflows.length === 1) return workflows[0];

    const llmSelector = this.config.selectWorkflowWithLlm;
    if (llmSelector) {
      let llmResult: string | null = null;
      try {
        llmResult = await llmSelector(task, workflows);
      } catch (err) {
        log.warn(
          `SpaceRuntime: LLM workflow selector threw for task ${task.id}; using deterministic fallback:`,
          err
        );
        llmResult = null;
      }

      if (llmResult) {
        const hit = workflows.find((w) => w.id === llmResult);
        if (hit) return hit;
        log.warn(
          `SpaceRuntime: LLM workflow selector returned unknown id "${llmResult}" for task ${task.id}; using deterministic fallback`
        );
      }
    }

    return this.selectDeterministicWorkflowFallback(workflows);
  }

  private selectDeterministicWorkflowFallback(workflows: SpaceWorkflow[]): SpaceWorkflow | null {
    if (workflows.length === 0) return null;
    if (workflows.length === 1) return workflows[0];

    const scored = workflows.map((workflow) => {
      const tags = workflow.tags ?? [];
      return {
        workflow,
        isDefault: tags.includes('default') ? 1 : 0,
        isV2: tags.includes('v2') ? 1 : 0,
      };
    });

    scored.sort((a, b) => {
      if (b.isDefault !== a.isDefault) return b.isDefault - a.isDefault;
      if (b.isV2 !== a.isV2) return b.isV2 - a.isV2;
      return b.workflow.updatedAt - a.workflow.updatedAt;
    });

    return scored[0]?.workflow ?? null;
  }

  private getOrCreateTaskManager(spaceId: string): SpaceTaskManager {
    let manager = this.taskManagers.get(spaceId);
    if (!manager) {
      manager = new SpaceTaskManager(
        this.config.db,
        spaceId,
        this.config.reactiveDb,
        this.config.evolutionScopeService,
        (taskId) => this.config.goalService?.supersedeOutcomeNotificationsForTask(taskId),
        (taskId, fromStatus) =>
          this.config.goalService?.handleTaskTerminal(taskId, {
            fromStatus,
            deferPostCommitEffects: true,
          }),
        (rawPath) => this.config.spaceManager.resolveRegisteredWorkspacePath(spaceId, rawPath)
      );
      this.taskManagers.set(spaceId, manager);
    }
    return manager;
  }

  private buildExecutor(
    workflow: SpaceWorkflow,
    run: SpaceWorkflowRun,
    _spaceId: string,
    _workspacePath: string
  ): WorkflowExecutor {
    return new WorkflowExecutor(workflow, run);
  }

  storeWorkflowChannels(runId: string, channels: WorkflowChannel[]): void {
    this.workflowChannelsMap.set(runId, channels);
  }

  getRunWorkflowChannels(runId: string): WorkflowChannel[] {
    return this.workflowChannelsMap.get(runId) ?? [];
  }

  getWorkflowChannels(runId: string): WorkflowChannel[] {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return [];
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    return workflow?.channels ?? [];
  }
}

function parseNodeExecutionData(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (isRecord(value)) return { ...value };
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasSqlExec(value: unknown): value is { exec: (sql: string) => void } {
  return isRecord(value) && typeof value.exec === 'function';
}
