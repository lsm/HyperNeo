import type {
  McpServerConfig,
  MessageContent,
  MessageHub,
  MessageImage,
  MessageInputKind,
  MessageOrigin,
  NodeExecution,
  Session,
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowNode,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import { generateUUID, isRateOrUsageLimited, resolveNodeAgents } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { ActorResolver } from '../../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { AgentSessionInit } from '../../../lib/agent/agent-session.ts';
import { AgentSession, ClearConversationCancelledError } from '../../../lib/agent/agent-session.ts';
import {
  deliverMessage,
  isMessageDeliveryV2Enabled,
  withSessionResetCoordination,
} from '../../../lib/agent/message-delivery.ts';
import { decideInjectDelivery } from '../../../lib/agent/message-delivery-pipeline.ts';
import {
  type DeferredEventOverflowFoldResult,
  DEFERRED_EXTERNAL_EVENT_ROW_CAP,
  deferredExternalEventEntryEvents,
  type ExternalEventEssenceEntry,
  foldDeferredExternalEventOverflow,
  parseDeferredExternalEventText,
} from '../../../lib/external-events/deferred-event-digest.ts';
import {
  decideExternalEventSteerAdmission,
  type DirectSteerEventClass,
} from './external-event-steer-admission-pipeline.ts';

import {
  type DirectSteerBufferEntry,
  type DirectSteerFlushDeps,
  type DirectSteerSkipReason,
  runDirectSteerFlush,
} from './direct-steer-flush-pipeline.ts';
import { classifyExternalEventDirectSteer } from '../../../lib/external-events/event-tiers.ts';

import { validateImageSizes } from '../../session/message-persistence.ts';
import type { Database } from '../../../storage/database.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import type { AppMcpServerRepository } from '../../../storage/repositories/app-mcp-server-repository.ts';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository.ts';
import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type {
  PendingAgentMessageRecord,
  PendingAgentMessageRepository,
} from '../../../storage/repositories/pending-agent-message-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import type { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import type { SessionManager } from '../../session-manager.ts';
import type { SkillsManager } from '../../skills-manager.ts';
import type { SpaceAgentManager } from '../managers/space-agent-manager.ts';
import type { SpaceManager } from '../managers/space-manager.ts';
import { SpaceTaskManager } from '../managers/space-task-manager.ts';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager.ts';
import type { SpaceWorktreeManager } from '../managers/space-worktree-manager.ts';
import {
  activateModelPoolReservation,
  applyModelPoolToSlot,
  type ModelPoolAssignmentMap,
  raiseModelPoolDeferred,
  releaseModelPoolReservation,
  reserveModelPoolSlot,
} from './model-pool-scheduler.ts';
import type { SpaceRuntimeService } from './space-runtime-service.ts';
export interface SubSessionMemberInfo {
  agentId?: string;
  agentName?: string;
  nodeId?: string;
  deferFreshExecutionBind?: boolean;
  freshSessionOnly?: boolean;
}

export interface VerifiedSessionStop {
  sessionId: string;
  stopped: boolean;
  detail?: string;
}

import type { AgentMemoryRepository } from '../../../storage/repositories/agent-memory-repository.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository.ts';
import { validateGlobPattern } from '../../external-events/topic-validator.ts';
import { Logger } from '../../logger.ts';
import { sanitizeAssistantUsageInSDKSessionFile } from '../../sdk-session-file-manager.ts';
import { extractReplyToSessionId } from '../agent-message-envelope.ts';
import {
  buildCustomAgentTaskMessage,
  DEFAULT_CUSTOM_AGENT_MODEL,
  resolveAgentInit,
} from '../agents/custom-agent.ts';
import type { EvolutionScopeService } from '../evolution-scope-service.ts';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager.ts';
import { createAgentMemoryMcpServer } from '../tools/agent-memory-tools.ts';
import {
  createEndNodeHandlers,
  createMarkCompleteHandler,
  createPrMergedGate,
} from '../tools/end-node-handlers.ts';
import { createNodeAgentMcpServer } from '../tools/node-agent-tools.ts';
import { jsonResult } from '../tools/tool-result.ts';
import { builtInWorkflowRequiresPrMerge } from '../workflows/built-in-workflows.ts';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator.ts';
import { decideActivationRouting, selectWorkflowNodeForAgent } from './activation-routing.ts';
import { AgentMessageRouter } from './agent-message-router.ts';
import type { WorkflowArtifactProfile } from './artifact-profile.ts';
import { ChannelResolver } from './channel-resolver.ts';
import { ChannelRouter } from './channel-router.ts';
import { createGithubConnector } from './connectors/github-connector.ts';
import { HookExecutor } from './hook-executor.ts';
import type { InjectionDeliveryRowDeps } from './injection-delivery-steps.ts';
import {
  deliverInjectedMessage,
  flipDeliveryRowToDeferred,
  reopenFailedDeliveryRow,
  settleDeliveryRowStatus,
} from './injection-delivery-steps.ts';
import { decidePendingDrainAdmission } from './pending-drain-decision-pipeline.ts';
import { SpaceAgentLateSettlements } from './space-agent-message-delivery.ts';
import {
  collectActiveSpaceDeliveryIds,
  runSpaceAgentPendingDrain,
  type SpaceAgentPendingDrainDeps,
} from './space-agent-pending-drain.ts';
import { derivePendingQueueTargetNames } from './pending-drain-gates.ts';
import {
  formatPendingRowForNodeAgent,
  formatPendingRowForSpaceAgent,
  isHumanPendingSource,
} from './pending-envelope.ts';
import { collectDispatchablePostApprovalRoutes } from './post-approval-router.ts';
import type { ReplyRoutingRegistry } from './reply-routing-registry.ts';
import {
  isSpawnFlowReusedSession,
  isSpawnFlowWaitConcurrent,
  runSpawnExecutionFlow,
  type SpawnExecutionFlowDeps,
} from './spawn-flow.ts';
import {
  assembleNodeAgentSessionInit,
  buildExecutionBaseSessionId,
  buildSlotOverrides,
  findAvailableSessionId,
  resolveSpawnWorkspace,
  resolveWorkflowNodeSlot,
} from './spawn-slot-resolution.ts';
import { runVerifiedStopFlow, type VerifiedStopFlowDeps } from './verified-stop-flow.ts';
import {
  clearAllRetryableHookActionTimers,
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  WorkflowHookEngine,
} from './workflow-hook-engine.ts';
import {
  assertExecutionValidAgainstWorkflow,
  isSpawnSupersededError,
  PermanentSpawnError,
  SPAWN_BINDABLE_EXECUTION_STATUSES,
  SPAWN_RESERVABLE_TASK_STATUSES,
  SpawnSupersededError,
  validateTaskAllowsSpawn,
} from './workflow-node-execution-validation.ts';

const log = new Logger('task-agent-manager');

const WORKFLOW_ESCALATION_TARGET = 'space-agent';

export function isWorkflowTerminalNode(
  workflow: SpaceWorkflow | null | undefined,
  workflowNodeId: string
): boolean {
  if (!workflow) return false;
  if (workflow.endNodeId === workflowNodeId) return true;

  const node = workflow.nodes.find((candidate) => candidate.id === workflowNodeId);
  if (!node) return false;

  const nodeAgents = resolveNodeAgents(node);
  const fromRefs = new Set([
    node.name,
    node.id,
    ...nodeAgents.flatMap((agent) => [agent.name, agent.agentId, `${node.id}/${agent.name}`]),
  ]);
  const outgoingChannels = (workflow.channels ?? []).filter(
    (channel) => channel.from === '*' || fromRefs.has(channel.from)
  );
  if (outgoingChannels.some((channel) => channel.from === '*')) return false;
  if (outgoingChannels.length === 0) return true;

  const startNode = workflow.nodes.find((candidate) => candidate.id === workflow.startNodeId);
  const startAgents = startNode ? resolveNodeAgents(startNode) : [];
  const startRefs = new Set(
    [
      workflow.startNodeId,
      startNode?.name,
      ...startAgents.flatMap((agent) => [
        agent.name,
        agent.agentId,
        `${workflow.startNodeId}/${agent.name}`,
      ]),
    ].filter(Boolean)
  );

  return outgoingChannels.every((channel) => {
    const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
    return targets.every((target) => startRefs.has(target));
  });
}

function formatWorkflowNodeSessionTitle(task: SpaceTask, agentName?: string): string {
  const agentDisplayName = agentName ? agentName[0].toUpperCase() + agentName.slice(1) : '';
  const agentLabel = agentDisplayName ? ` — ${agentDisplayName}` : '';
  return `Task #${task.taskNumber}: ${task.title}${agentLabel}`;
}

export interface TaskAgentManagerConfig {
  db: Database;
  sessionManager: SessionManager;
  reactiveDb?: ReactiveDatabase;
  spaceManager: SpaceManager;
  spaceAgentManager: SpaceAgentManager;
  spaceWorkflowManager: SpaceWorkflowManager;
  spaceRuntimeService: SpaceRuntimeService;
  taskRepo: SpaceTaskRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  channelCycleRepo: ChannelCycleRepository;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  messageHub: MessageHub;
  getApiKey: () => Promise<string | null>;
  defaultModel: string;
  worktreeManager?: SpaceWorktreeManager;
  skillsManager: SkillsManager;
  appMcpServerRepo: AppMcpServerRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  dbPath?: string;
  artifactRepo?: WorkflowRunArtifactRepository;
  artifactProfile?: WorkflowArtifactProfile;
  pendingMessageRepo?: PendingAgentMessageRepository;
  toolContinuationRepo?: ToolContinuationRecoveryRepository;
  spaceAgentInjector?: (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null,
    explicitMessageId?: string,
    options?: {
      onConsumed?: (settledSessionId: string) => void;
      lateSettlement?: import('./space-agent-message-delivery.ts').SpaceAgentLateSettlementOwner;
      onLateFailure?: () => void;
      disposeSignal?: AbortSignal;
    }
  ) => Promise<import('./space-agent-message-delivery.ts').SpaceAgentInjectionOutcome>;
  scheduleService?: import('../schedule/schedule-service.ts').ScheduleService;
  replyRoutingRegistry?: ReplyRoutingRegistry;
  memoryRepo?: AgentMemoryRepository;
  messageResolverFactory?: (
    spaceId: string,
    context?: { workflowRunId?: string; nodeId?: string; agentName?: string }
  ) => ActorResolver | undefined;
  longTermAgentDelivery?: {
    deliverToSession?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
    queueForActivation?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
  };
  goalService?: import('../goals/goal-service.ts').SpaceGoalService;
  evolutionScopeService?: EvolutionScopeService;
  externalEventStore?: import('../../external-events/external-event-store.ts').ExternalEventStore;
  directSteerDebounceMs?: number;
  directSteerMaxBurstWaitMs?: number;
}

export const DIRECT_STEER_DEBOUNCE_MS = 20_000;

export const DIRECT_STEER_MAX_BURST_WAIT_MS = 60_000;

export const DIRECT_STEER_BUFFER_MAX_ENTRIES = 200;

export const DIRECT_STEER_SNIPPET_MAX_CHARS = 2_000;

function directSteerBufferKey(sessionId: string, eventClass: DirectSteerEventClass): string {
  return `${sessionId}\u0000${eventClass}`;
}

const DIRECT_STEER_HYDRATABLE_FIELDS = [
  'eventType',
  'action',
  'actor',
  'body',
  'title',
  'state',
  'checkName',
  'conclusion',
  'commentId',
  'inReplyToId',
  'path',
  'line',
  'reviewId',
  'threadId',
  'context',
  'environment',
  'description',
] as const;

type CompletionCallbackMap = Map<string, Array<() => Promise<void>>>;

interface RateLimitSessionEntry {
  resetAt: number;
  kind: 'rate_limit' | 'usage_limit';
  reason: string;
}

const RATE_LIMIT_FALLBACK_RESET_AT_MS = 60 * 60 * 1000;

const VERIFIED_STOP_PROCESS_EXIT_SETTLE_MS = 500;

const VERIFIED_STOP_ESCALATION_FORCE_KILL_MS = 2000;

interface SpawnTaskAgentOptions {
  kickoff?: boolean;
}

export function resolvePostApprovalTargetAgentName(
  workflow: SpaceWorkflow | null | undefined
): string | undefined {
  if (!workflow) return undefined;
  for (const node of workflow.nodes) {
    const targetAgent = node.postApproval?.targetAgent;
    if (targetAgent && targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) return targetAgent;
  }
  const legacy = workflow.postApproval?.targetAgent;
  return legacy && legacy !== POST_APPROVAL_TASK_AGENT_TARGET ? legacy : undefined;
}

export function resolvePostApprovalRouteNodeId(
  workflow: SpaceWorkflow | null | undefined
): string | undefined {
  if (!workflow) return undefined;
  const targetAgent = resolvePostApprovalTargetAgentName(workflow);
  if (!targetAgent) return undefined;
  return workflow.nodes.find((n) => n.agents.some((a) => a.name === targetAgent))?.id;
}

export class TaskAgentManager {
  private readonly lateSettlements = new SpaceAgentLateSettlements();
  private readonly spaceAgentDrainsInFlight = new Set<string>();
  private readonly spaceAgentDrainRerunQueued = new Set<string>();

  attachToolContinuationRepo(repo: ToolContinuationRecoveryRepository): void {
    this.config.toolContinuationRepo = repo;
  }

  private subSessions = new Map<string, Map<string, AgentSession>>();

  private agentSessionIndex = new Map<string, AgentSession>();

  private cancellingSessions = new Set<string>();

  private readonly sessionRestoreLocks = new Map<string, Promise<void>>();

  private readonly rehydrateInFlight = new Map<string, Promise<AgentSession | null>>();

  private spawningExecutionIds = new Set<string>();
  private concurrentSpawnWaiters = new Map<
    string,
    Array<(outcome: { status: 'resolved'; sessionId: string } | { status: 'failed' }) => void>
  >();

  private modelPoolAssignments: ModelPoolAssignmentMap = new Map();

  private completionCallbacks: CompletionCallbackMap = new Map();

  private sessionListeners = new Map<string, () => void>();

  private taskWorktreePaths = new Map<string, string>();

  private readonly auditLogRepo: McpAuditLogRepository;

  private taskArchiveListenerUnsub: (() => void) | null = null;
  private rateLimitListenerUnsubs: Array<() => void> = [];
  private activityListenerUnsubs: Array<() => void> = [];
  private limitedSessionsByTask = new Map<string, Map<string, RateLimitSessionEntry>>();
  private readonly directSteerBuffers = new Map<string, DirectSteerBufferEntry[]>();
  private readonly directSteerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly directSteerBurstStarts = new Map<string, number>();
  private readonly directSteerDebounceMs: number;
  private readonly directSteerMaxBurstWaitMs: number;

  constructor(private readonly config: TaskAgentManagerConfig) {
    this.auditLogRepo = new McpAuditLogRepository(this.config.db.getDatabase());
    this.directSteerDebounceMs = this.config.directSteerDebounceMs ?? DIRECT_STEER_DEBOUNCE_MS;
    this.directSteerMaxBurstWaitMs =
      this.config.directSteerMaxBurstWaitMs ?? DIRECT_STEER_MAX_BURST_WAIT_MS;
    this.subscribeToTaskArchiveEvents();
    this.subscribeToRateLimitEvents();
    this.subscribeToActivityTracking();
  }

  *getTrackedAgentRootPids(): Iterable<number> {
    for (const [, nodeSessions] of this.subSessions) {
      for (const [, session] of nodeSessions) {
        yield* session.getTrackedAgentRootPids();
      }
    }
  }

  getTrackedAgentRootPidsSplit(): { live: number[]; exited: number[] } {
    const live: number[] = [];
    const exited: number[] = [];
    for (const [, nodeSessions] of this.subSessions) {
      for (const [, session] of nodeSessions) {
        const split = session.getTrackedAgentRootPidsSplit();
        live.push(...split.live);
        exited.push(...split.exited);
      }
    }
    return { live, exited };
  }

  private subscribeToTaskArchiveEvents(): void {
    if (this.taskArchiveListenerUnsub) return;
    this.taskArchiveListenerUnsub = this.config.internalEventBus.subscribe(
      'space.task.updated',
      (event) => {
        if (event.task?.status !== 'archived') return;
        if (event.archiveSource === 'system_reconcile') return;
        const taskId = event.taskId;
        void this.archiveOnTaskArchived(taskId).catch((err) => {
          log.warn(
            `TaskAgentManager: failed to archive resources for archived task ${taskId}:`,
            err
          );
        });
      },
      { subscriberName: 'TaskAgentManager.taskArchive' }
    );
  }

  private subscribeToRateLimitEvents(): void {
    if (this.rateLimitListenerUnsubs.length > 0) return;

    this.rateLimitListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'session.rate_limit_pause',
        (event) => {
          const taskId = this.findParentTaskIdForSubSession(event.sessionId);
          if (!taskId) return;
          let entries = this.limitedSessionsByTask.get(taskId);
          if (!entries) {
            entries = new Map();
            this.limitedSessionsByTask.set(taskId, entries);
          }
          entries.set(event.sessionId, {
            resetAt: event.resetAt ?? Date.now() + RATE_LIMIT_FALLBACK_RESET_AT_MS,
            kind: event.kind,
            reason: event.reason,
          });
          try {
            this.recomputeTaskRestriction(taskId);
          } catch (err) {
            log.warn(
              `TaskAgentManager: failed to mark task ${taskId} limited for session ${event.sessionId}:`,
              err
            );
          }
        },
        { subscriberName: 'TaskAgentManager.rateLimitPause' }
      )
    );

    this.rateLimitListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'session.rate_limit_resume',
        (event) => {
          const taskId = this.findParentTaskIdForSubSession(event.sessionId);
          if (!taskId) return;
          const entries = this.limitedSessionsByTask.get(taskId);
          if (entries) {
            entries.delete(event.sessionId);
            if (entries.size === 0) {
              this.limitedSessionsByTask.delete(taskId);
              void this.restoreTaskFromRateLimit(taskId).catch((err) => {
                log.warn(
                  `TaskAgentManager: failed to restore task ${taskId} from rate limit for session ${event.sessionId}:`,
                  err
                );
              });
              return;
            }
            try {
              this.recomputeTaskRestriction(taskId);
            } catch (err) {
              log.warn(
                `TaskAgentManager: failed to recompute task ${taskId} restriction after session ${event.sessionId} resumed:`,
                err
              );
            }
            return;
          }
          void this.restoreTaskFromRateLimit(taskId).catch((err) => {
            log.warn(
              `TaskAgentManager: failed to restore task ${taskId} from rate limit for session ${event.sessionId}:`,
              err
            );
          });
        },
        { subscriberName: 'TaskAgentManager.rateLimitResume' }
      )
    );
  }

  private subscribeToActivityTracking(): void {
    if (this.activityListenerUnsubs.length > 0) return;

    this.activityListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'sdk.toolUse.created',
        (event) => {
          this.recordActivityForSession(event.sessionId, event.timestamp);
        },
        { subscriberName: 'TaskAgentManager.activityToolUseCreated' }
      )
    );

    this.activityListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'sdk.toolUse.consumed',
        (event) => {
          this.recordActivityForSession(event.sessionId, event.timestamp);
        },
        { subscriberName: 'TaskAgentManager.activityToolUseConsumed' }
      )
    );
  }

  private recordActivityForSession(sessionId: string, at: number = Date.now()): void {
    try {
      const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
      if (execution) {
        this.config.nodeExecutionRepo.touchLastActivity(execution.id, at);
      }
    } catch (err) {
      log.debug(`TaskAgentManager: failed to record activity for session ${sessionId}:`, err);
    }
  }

  private recomputeTaskRestriction(taskId: string): void {
    const entries = this.limitedSessionsByTask.get(taskId);
    if (!entries || entries.size === 0) {
      return;
    }
    let resetAt = -Infinity;
    let reason = '';
    let hasUsageLimit = false;
    let hasBillingTerminal = false;
    for (const entry of entries.values()) {
      if (entry.kind === 'usage_limit') hasUsageLimit = true;
      if (entry.reason === 'billing-terminal') hasBillingTerminal = true;
      if (entry.resetAt > resetAt) {
        resetAt = entry.resetAt;
        reason = entry.reason;
      }
    }
    if (hasBillingTerminal) {
      reason = 'billing-terminal';
    }
    const status: 'rate_limited' | 'usage_limited' = hasUsageLimit
      ? 'usage_limited'
      : 'rate_limited';
    const restrictions = {
      type: status === 'usage_limited' ? ('usage_limit' as const) : ('rate_limit' as const),
      limit: reason,
      resetAt,
      sessionRole: 'worker' as const,
    };

    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return;

    const isLimited = isRateOrUsageLimited(task.status);
    if (task.status !== 'in_progress' && !isLimited) return;
    if (
      isLimited &&
      task.status === status &&
      task.restrictions?.resetAt === resetAt &&
      task.restrictions?.type === restrictions.type &&
      task.restrictions?.limit === reason
    ) {
      return;
    }
    const outcome = this.config.taskRepo.casStatusWithPayload(
      taskId,
      ['in_progress', 'rate_limited', 'usage_limited'],
      status,
      { restrictions }
    );
    if (outcome === 'won') {
      this.emitTaskUpdatedEvent(taskId);
    }
  }

  private async restoreTaskFromRateLimit(taskId: string): Promise<void> {
    const outcome = this.config.taskRepo.casStatusWithPayload(
      taskId,
      ['rate_limited', 'usage_limited'],
      'in_progress',
      { restrictions: null }
    );
    if (outcome === 'won') {
      this.emitTaskUpdatedEvent(taskId);
    }
  }

  private emitTaskUpdatedEvent(taskId: string): void {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return;
    this.config.internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId: task.spaceId,
        taskId: task.id,
        task,
      })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for rate-limit pause/resume of task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  private async archiveOnTaskArchived(taskId: string): Promise<void> {
    const task = this.config.taskRepo.getTask(taskId);
    const sessionIds = new Set<string>();
    const nodeMap = this.subSessions.get(taskId);
    if (nodeMap) {
      for (const [sid] of nodeMap) sessionIds.add(sid);
    }

    if (task?.taskAgentSessionId) {
      sessionIds.add(task.taskAgentSessionId);
    }

    try {
      await this.cleanup(taskId, 'done');
    } catch (err) {
      log.warn(`TaskAgentManager.archiveOnTaskArchived: cleanup failed for task ${taskId}:`, err);
    }

    for (const sessionId of sessionIds) {
      try {
        await this.config.sessionManager.archiveSessionResources(sessionId, 'ui_task_archive');
      } catch (err) {
        log.warn(
          `TaskAgentManager.archiveOnTaskArchived: failed to archive session ${sessionId} for task ${taskId}:`,
          err
        );
      }
    }

    if (this.config.worktreeManager && task?.spaceId) {
      try {
        await this.config.worktreeManager.removeTaskWorktree(task.spaceId, taskId);
        log.info(`TaskAgentManager: removed worktree for archived task ${taskId}`);
      } catch (err) {
        log.warn(
          `TaskAgentManager: failed to remove worktree for archived task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  async spawnWorkflowNodeAgentForExecution(
    task: SpaceTask,
    space: Space,
    workflow: SpaceWorkflow,
    workflowRun: SpaceWorkflowRun,
    execution: NodeExecution,
    options: SpawnTaskAgentOptions = {}
  ): Promise<string> {
    const spawnState: {
      reservationHeld: boolean;
      reservedExecution: boolean;
      appliedSlot?: WorkflowNodeAgent;
    } = { reservationHeld: false, reservedExecution: false };
    const outcome = await runSpawnExecutionFlow(this.buildSpawnExecutionFlowDeps(spawnState), {
      task,
      space,
      workflow,
      workflowRun,
      execution,
      kickoff: options.kickoff ?? true,
    });
    if (outcome.status === 'error') {
      releaseModelPoolReservation(this.modelPoolAssignments, execution);
      if (spawnState.reservedExecution) {
        this.settleConcurrentSpawnWaiters(execution.id, { status: 'failed' });
      }
      throw outcome.error;
    }
    if (outcome.status === 'superseded') {
      releaseModelPoolReservation(this.modelPoolAssignments, execution);
      if (spawnState.reservedExecution) {
        this.settleConcurrentSpawnWaiters(execution.id, { status: 'failed' });
      }
      throw new SpawnSupersededError(execution.id, outcome.stage ?? null);
    }
    const result = outcome.result;
    if (isSpawnFlowWaitConcurrent(result)) {
      return this.waitForConcurrentSpawnSession(execution);
    }
    if (isSpawnFlowReusedSession(result)) {
      return result.sessionId;
    }
    this.spawningExecutionIds.delete(execution.id);
    this.settleConcurrentSpawnWaiters(execution.id, {
      status: 'resolved',
      sessionId: result as string,
    });
    return result as string;
  }

  private waitForConcurrentSpawnSession(execution: NodeExecution): Promise<string> {
    const CONCURRENT_SPAWN_TIMEOUT_MS = 30_000;
    const fresh = this.config.nodeExecutionRepo.getById(execution.id);
    if (fresh?.agentSessionId) {
      return Promise.resolve(fresh.agentSessionId);
    }
    if (!this.spawningExecutionIds.has(execution.id)) {
      return Promise.reject(
        new Error(
          `Concurrent spawn for execution ${execution.id} failed before session was created`
        )
      );
    }
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let waiter:
        | ((outcome: { status: 'resolved'; sessionId: string } | { status: 'failed' }) => void)
        | undefined;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        finish();
      };
      const removeWaiter = () => {
        if (!waiter) return;
        const current = this.concurrentSpawnWaiters.get(execution.id);
        if (!current) return;
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) this.concurrentSpawnWaiters.delete(execution.id);
      };
      timer = setTimeout(() => {
        removeWaiter();
        settle(() => {
          reject(
            new Error(
              `Concurrent spawn for execution ${execution.id} timed out after ${CONCURRENT_SPAWN_TIMEOUT_MS}ms`
            )
          );
        });
      }, CONCURRENT_SPAWN_TIMEOUT_MS);
      waiter = (outcome) => {
        settle(() => {
          if (outcome.status === 'resolved') {
            resolve(outcome.sessionId);
            return;
          }
          const bound = this.config.nodeExecutionRepo.getById(execution.id)?.agentSessionId;
          if (bound) {
            resolve(bound);
            return;
          }
          reject(
            new Error(
              `Concurrent spawn for execution ${execution.id} failed before session was created`
            )
          );
        });
      };
      const waiters = this.concurrentSpawnWaiters.get(execution.id) ?? [];
      waiters.push(waiter);
      this.concurrentSpawnWaiters.set(execution.id, waiters);
    });
  }

  private settleConcurrentSpawnWaiters(
    executionId: string,
    outcome: { status: 'resolved'; sessionId: string } | { status: 'failed' }
  ): void {
    const waiters = this.concurrentSpawnWaiters.get(executionId);
    if (!waiters) return;
    this.concurrentSpawnWaiters.delete(executionId);
    for (const waiter of waiters) waiter(outcome);
  }

  private buildSpawnExecutionFlowDeps(spawnState: {
    reservationHeld: boolean;
    reservedExecution: boolean;
    appliedSlot?: WorkflowNodeAgent;
  }): SpawnExecutionFlowDeps {
    return {
      getFreshTask: (taskId) => this.config.taskRepo.getTask(taskId),
      getNodeExecution: (executionId) => this.config.nodeExecutionRepo.getById(executionId),
      isSpawningExecution: (executionId) => this.spawningExecutionIds.has(executionId),
      inspectIndexedSession: (agentSessionId) => {
        if (agentSessionId && this.agentSessionIndex.has(agentSessionId)) {
          if (this.isSessionAlive(agentSessionId)) {
            return { sessionId: agentSessionId, alive: true };
          }
          this.agentSessionIndex.delete(agentSessionId);
        }
        return { sessionId: agentSessionId, alive: false };
      },
      reserveExecution: (executionId) => {
        spawnState.reservedExecution = true;
        this.spawningExecutionIds.add(executionId);
      },
      releaseExecution: (executionId) => {
        this.spawningExecutionIds.delete(executionId);
      },
      reserveTaskSpawn: (taskId) => {
        const outcome = this.config.taskRepo.reserveSpawnForTick(
          taskId,
          SPAWN_RESERVABLE_TASK_STATUSES
        );
        if (outcome === 'won') spawnState.reservationHeld = true;
        return outcome;
      },
      releaseTaskSpawn: (taskId) => {
        if (!spawnState.reservationHeld) return;
        spawnState.reservationHeld = false;
        this.config.taskRepo.releaseSpawnReservation(taskId);
      },
      cancelSpawnedSession: (sessionId) => {
        this.cancelBySessionId(sessionId);
      },
      rebindLiveExecution: (execution, sessionId) => {
        const startedAt = execution.startedAt ?? Date.now();
        const expected = SPAWN_BINDABLE_EXECUTION_STATUSES.includes(execution.status)
          ? ([execution.status] as const)
          : ([] as const);
        return this.config.nodeExecutionRepo.casExecutionStatus(
          execution.id,
          expected,
          'in_progress',
          {
            agentSessionId: sessionId,
            startedAt,
            completedAt: null,
          }
        );
      },
      raiseSpawnRejection: (freshTask, rejectedExecution, rejectedWorkflow) => {
        validateTaskAllowsSpawn(freshTask);
        assertExecutionValidAgainstWorkflow(rejectedExecution, rejectedWorkflow);
        throw new Error(
          `No agent slot found for agent name "${rejectedExecution.agentName}" in node "${rejectedExecution.workflowNodeId}"`
        );
      },
      resolveSpawnSessionId: (space, task, execution) =>
        this.resolveSessionId(buildExecutionBaseSessionId(space.id, task.id, execution.id)),
      resolveWorkspacePath: async (task, space) => {
        const workspace = resolveSpawnWorkspace({
          cachedTaskWorktreePath: this.taskWorktreePaths.get(task.id),
          hasWorktreeManager: Boolean(this.config.worktreeManager),
          spaceWorkspacePath: space.workspacePath,
        });
        let workspacePath = workspace.workspacePath;
        if (workspace.createWorktree && this.config.worktreeManager) {
          try {
            const result = await this.config.worktreeManager.createTaskWorktree(
              space.id,
              task.id,
              task.title,
              task.taskNumber
            );
            workspacePath = result.path;
            this.taskWorktreePaths.set(task.id, result.path);
          } catch (err) {
            log.warn(
              `TaskAgentManager: failed to create worktree for workflow task ${task.id}, falling back to space workspace: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        return workspacePath;
      },
      resolveSlot: (_space, workflow, execution, _task) =>
        resolveWorkflowNodeSlot(workflow, execution.workflowNodeId, execution.agentName) ?? null,
      createSpawnedSession: async (request) => {
        const customAgent = this.config.spaceAgentManager.getById(request.slot.agentId);
        let slot = request.slot;
        let poolProvider: string | undefined;
        if (customAgent) {
          const poolApplication = applyModelPoolToSlot({
            slot: request.slot,
            task: request.task,
            node: request.node,
            agent: customAgent,
            spaceId: request.space.id,
            assignments: this.modelPoolAssignments,
            getSessionStatus: (sessionId: string) =>
              this.agentSessionIndex.get(sessionId)?.getProcessingState().status,
            now: Date.now(),
          });
          if ('deferred' in poolApplication) {
            raiseModelPoolDeferred(customAgent.name, request.space.id);
          }
          slot = poolApplication.slot;
          poolProvider = poolApplication.provider;
        }
        spawnState.appliedSlot = slot;
        const assignedModel =
          slot.model ??
          customAgent?.model ??
          request.space.defaultModel ??
          DEFAULT_CUSTOM_AGENT_MODEL;
        const assignment = {
          spaceId: request.space.id,
          taskId: request.task.id,
          model: assignedModel,
        };
        reserveModelPoolSlot(this.modelPoolAssignments, request.execution, assignment);

        try {
          const slotOverrides = {
            ...buildSlotOverrides(slot, {
              task: request.task,
              node: request.node,
              workflow: request.workflow,
              workflowRun: request.workflowRun,
            }),
            ...(poolProvider ? { provider: poolProvider } : {}),
          };

          let init = resolveAgentInit({
            task: request.task,
            space: request.space,
            agentManager: this.config.spaceAgentManager,
            sessionId: request.sessionId,
            workspacePath: request.workspacePath,
            workflowRun: request.workflowRun,
            workflow: request.workflow,
            slotOverrides,
            agentId: slot.agentId,
          });

          if (request.kickoff && !customAgent) {
            throw new PermanentSpawnError(`Agent not found: ${slot.agentId}`);
          }

          const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
            request.task.id,
            request.sessionId,
            request.execution.agentName,
            request.space.id,
            request.workflowRun.id,
            request.workspacePath,
            request.execution.workflowNodeId
          );

          init = assembleNodeAgentSessionInit({
            baseInit: init,
            title: formatWorkflowNodeSessionTitle(request.task, request.execution.agentName),
            nodeAgentMcpServer: nodeAgentMcpServer as unknown as McpServerConfig,
            agentMemoryMcpServers: this.buildAgentMemoryMcpServers(
              request.space.id,
              request.sessionId
            ),
          });

          const actualSessionId = await this.createSubSession(
            request.task.id,
            request.sessionId,
            init,
            {
              agentId: slot.agentId,
              agentName: request.execution.agentName,
              nodeId: request.execution.workflowNodeId,
              deferFreshExecutionBind: true,
              freshSessionOnly: true,
            }
          );

          const spawned = this.getSubSession(actualSessionId);
          if (!spawned) {
            throw new Error(`Spawned node session ${actualSessionId} is not registered in memory`);
          }
          return actualSessionId;
        } catch (err) {
          releaseModelPoolReservation(this.modelPoolAssignments, request.execution);
          throw err;
        }
      },
      bindExecutionToSession: (execution, sessionId) => {
        const expected = SPAWN_BINDABLE_EXECUTION_STATUSES.includes(execution.status)
          ? ([execution.status] as const)
          : ([] as const);
        const outcome = this.config.nodeExecutionRepo.casExecutionStatus(
          execution.id,
          expected,
          'in_progress',
          {
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          },
          { expectAgentSessionId: execution.agentSessionId ?? null }
        );
        if (outcome === 'won') {
          this.settleConcurrentSpawnWaiters(execution.id, {
            status: 'resolved',
            sessionId,
          });
        }
        return outcome;
      },
      flushPendingMessagesForTarget: (workflowRunId, agentName, sessionId) => {
        void this.flushPendingMessagesForTarget(workflowRunId, agentName, sessionId).catch(
          (err) => {
            log.warn(
              `TaskAgentManager: flushPendingMessagesForTarget failed for ${agentName} (session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        );
      },
      attachNodeAgent: async (request) => {
        const spawned = this.getSubSession(request.sessionId);
        if (!spawned) {
          throw new Error(`Spawned node session ${request.sessionId} is not registered in memory`);
        }
        await this.ensureNodeAgentAttached(spawned, {
          taskId: request.task.id,
          subSessionId: request.sessionId,
          agentName: request.execution.agentName,
          spaceId: request.space.id,
          workflowRunId: request.workflowRun.id,
          workspacePath: request.workspacePath,
          workflowNodeId: request.execution.workflowNodeId,
          phase: 'spawn',
        });
      },
      registerSpawnCompletionCallback: (taskId, workflowNodeId, sessionId) => {
        this.registerCompletionCallback(sessionId, async () => {
          await this.handleSubSessionComplete(taskId, workflowNodeId, sessionId);
        });
      },
      buildKickoffMessage: async (request) => {
        const goal = request.task.goalId
          ? this.config.goalService?.getGoal(request.task.goalId)
          : null;
        const linkedGoal = goal?.spaceId === request.task.spaceId ? goal : null;

        const memoryQuery = `${request.task.title}\n${request.task.description}`;
        const coreMemories = this.config.memoryRepo
          ? this.config.memoryRepo.listCoreMemories(request.space.id, 10)
          : [];
        const relevantMemories = this.config.memoryRepo
          ? await this.config.memoryRepo.search(request.space.id, memoryQuery, 5)
          : [];
        const relevantScopeLessons = this.config.evolutionScopeService
          ? this.config.evolutionScopeService.selectActiveLessonsForTask({
              taskId: request.task.id,
              limit: 3,
            })
          : [];

        const customAgent = this.config.spaceAgentManager.getById(request.slot.agentId);
        const initialMessage = buildCustomAgentTaskMessage({
          customAgent: customAgent!,
          task: request.task,
          workflowRun: request.workflowRun,
          workflow: request.workflow,
          space: request.space,
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          goal: linkedGoal,
          relevantScopeLessons,
          slotOverrides: buildSlotOverrides(spawnState.appliedSlot ?? request.slot, {
            task: request.task,
            node: request.node,
            workflow: request.workflow,
            workflowRun: request.workflowRun,
          }),
          nodeId: request.execution.workflowNodeId,
          agentSlotName: request.execution.agentName,
          coreMemories,
          relevantMemories,
        });
        const runtimeContract = this.buildNodeExecutionRuntimeContract(
          request.workflow,
          request.execution,
          request.space
        );
        return runtimeContract ? `${initialMessage}\n\n${runtimeContract}` : initialMessage;
      },
      injectKickoffMessage: async (sessionId, message) => {
        const spawned = this.getSubSession(sessionId);
        if (!spawned) {
          throw new Error(`Spawned node session ${sessionId} is not registered in memory`);
        }
        await this.withSessionInjectLock(spawned.session.id, () =>
          this.injectMessageIntoSession(spawned, message)
        );
      },
      activateSpawnedSessionPoolAssignment: (executionId, sessionId) => {
        activateModelPoolReservation(this.modelPoolAssignments, { id: executionId }, sessionId);
      },
    };
  }

  private sanitizeAgentNameForId(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'agent'
    );
  }

  async createSubSession(
    taskId: string,
    sessionId: string,
    init: AgentSessionInit,
    memberInfo?: SubSessionMemberInfo
  ): Promise<string> {
    if (memberInfo?.agentName) {
      const parentTask = this.config.taskRepo.getTask(taskId);
      if (parentTask?.workflowRunId) {
        const prevExec = this.config.nodeExecutionRepo
          .listByWorkflowRun(parentTask.workflowRunId)
          .filter((e) => e.agentName === memberInfo.agentName && e.agentSessionId)
          .at(-1);
        if (prevExec?.agentSessionId && !memberInfo.freshSessionOnly) {
          const existing =
            this.agentSessionIndex.get(prevExec.agentSessionId) ??
            (await this.rehydrateSubSession(prevExec.agentSessionId));
          if (existing) {
            const existingSessionId = prevExec.agentSessionId;
            log.info(
              `TaskAgentManager: reusing session ${existingSessionId} for agent "${memberInfo.agentName}" (task ${taskId}); skipping new session ${sessionId}`
            );

            if (memberInfo.nodeId) {
              const nodeExecs = this.config.nodeExecutionRepo.listByNode(
                parentTask.workflowRunId,
                memberInfo.nodeId
              );
              const match =
                nodeExecs.find((e) => e.agentName === memberInfo.agentName && !e.agentSessionId) ??
                nodeExecs.find(
                  (e) =>
                    e.agentName === memberInfo.agentName && e.agentSessionId === existingSessionId
                );
              if (match) {
                const expected = SPAWN_BINDABLE_EXECUTION_STATUSES.includes(match.status)
                  ? ([match.status] as const)
                  : ([] as const);
                const outcome = this.config.nodeExecutionRepo.casExecutionStatus(
                  match.id,
                  expected,
                  'in_progress',
                  {
                    agentSessionId: existingSessionId,
                    startedAt: match.startedAt ?? Date.now(),
                    completedAt: null,
                  }
                );
                if (outcome === 'superseded') {
                  if (!match.agentSessionId) {
                    throw new SpawnSupersededError(match.id, 'reuse-target-bind');
                  }
                  log.info(
                    `TaskAgentManager: skipped rebinding execution ${match.id} to reused session ${existingSessionId} — status moved concurrently`
                  );
                }
              }
              if (memberInfo.nodeId) {
                const staleCoOwners = this.config.nodeExecutionRepo
                  .listByWorkflowRun(parentTask.workflowRunId)
                  .filter(
                    (e) =>
                      e.agentSessionId === existingSessionId &&
                      e.workflowNodeId !== memberInfo.nodeId
                  );
                for (const stale of staleCoOwners) {
                  const mustPreserve =
                    stale.status === 'blocked' ||
                    stale.status === 'cancelled' ||
                    stale.status === 'waiting_rebind' ||
                    stale.status === 'pending';
                  if (mustPreserve) {
                    this.config.nodeExecutionRepo.update(stale.id, {
                      agentSessionId: null,
                    });
                  } else {
                    this.config.nodeExecutionRepo.casExecutionStatus(
                      stale.id,
                      [stale.status],
                      'idle',
                      {
                        agentSessionId: null,
                        completedAt: Date.now(),
                      }
                    );
                  }
                }
              }
            }

            existing.skillOverrides = init.skillOverrides;
            existing.toolGuards = init.toolGuards;
            await existing.updateConfig({
              model: init.model,
              provider: init.provider as Session['config']['provider'],
              thinkingLevel: init.thinkingLevel,
              systemPrompt: init.systemPrompt,
              features: init.features,
              sdkToolsPreset: init.sdkToolsPreset,
              allowedTools: init.allowedTools,
              disallowedTools: init.disallowedTools,
              agent: init.agent,
              agents: init.agents,
              settingSources: init.settingSources,
              toolGuards: init.toolGuards,
            });

            if (memberInfo.nodeId) {
              const reuseWorkspacePath = this.taskWorktreePaths.get(taskId) ?? init.workspacePath;
              const reuseCtx = {
                taskId,
                subSessionId: existingSessionId,
                agentName: memberInfo.agentName,
                spaceId: parentTask.spaceId,
                workflowRunId: parentTask.workflowRunId,
                workspacePath: reuseWorkspacePath,
                workflowNodeId: memberInfo.nodeId,
              };
              await this.reinjectNodeAgentMcpServer(existing, reuseCtx);
              await this.ensureRequiredMcpServersAttached(existing, {
                ...reuseCtx,
                phase: 'spawn',
              });
            }

            if (memberInfo.nodeId) {
              this.completionCallbacks.delete(existingSessionId);
              this.registerCompletionCallback(existingSessionId, async () => {
                await this.handleSubSessionComplete(taskId, memberInfo.nodeId!, existingSessionId);
              });
            }

            existing.onMissingWorkflowMcpServers = async (
              target: AgentSession,
              missing: string[]
            ) => {
              await this.mcpSelfHeal(target, missing);
            };

            if (!memberInfo.deferFreshExecutionBind) {
              const runId = parentTask.workflowRunId;
              void this.flushPendingMessagesForTarget(
                runId,
                memberInfo.agentName,
                existingSessionId
              ).catch((err) => {
                log.warn(
                  `TaskAgentManager: flushPendingMessagesForTarget failed for ${memberInfo.agentName} (session ${existingSessionId}): ${err instanceof Error ? err.message : String(err)}`
                );
              });
            }

            return existingSessionId;
          }
        }
      }
    }

    const parentTask = this.config.taskRepo.getTask(taskId);
    const subSessionInit =
      parentTask && !init.title
        ? { ...init, title: formatWorkflowNodeSessionTitle(parentTask, memberInfo?.agentName) }
        : init;
    const subSession = AgentSession.fromInit(
      subSessionInit,
      this.config.db,
      this.config.messageHub,
      this.config.internalEventBus,
      this.config.getApiKey,
      this.config.defaultModel,
      this.config.skillsManager,
      this.config.appMcpServerRepo
    );

    if (subSessionInit.mcpServers && Object.keys(subSessionInit.mcpServers).length > 0) {
      subSession.mergeRuntimeMcpServers(subSessionInit.mcpServers);
    }

    this.reattachSlotContextReset(subSession);

    if (!this.subSessions.has(taskId)) {
      this.subSessions.set(taskId, new Map());
    }
    this.subSessions.get(taskId)!.set(sessionId, subSession);
    this.agentSessionIndex.set(sessionId, subSession);

    this.config.sessionManager.registerSession(subSession);

    if (memberInfo?.nodeId && memberInfo.agentName) {
      const parentTask = this.config.taskRepo.getTask(taskId);
      if (parentTask?.workflowRunId) {
        const nodeExecs = this.config.nodeExecutionRepo.listByNode(
          parentTask.workflowRunId,
          memberInfo.nodeId
        );
        const match = nodeExecs.find((e) => e.agentName === memberInfo.agentName);
        if (match && !match.agentSessionId && !memberInfo.deferFreshExecutionBind) {
          const expected = SPAWN_BINDABLE_EXECUTION_STATUSES.includes(match.status)
            ? ([match.status] as const)
            : ([] as const);
          const outcome = this.config.nodeExecutionRepo.casExecutionStatus(
            match.id,
            expected,
            'in_progress',
            {
              agentSessionId: sessionId,
              startedAt: match.startedAt ?? Date.now(),
              completedAt: null,
            }
          );
          if (outcome === 'superseded') {
            this.subSessions.get(taskId)?.delete(sessionId);
            this.agentSessionIndex.delete(sessionId);
            this.cancelBySessionId(sessionId);
            try {
              this.config.db
                .getDatabase()
                .prepare('DELETE FROM sessions WHERE id = ?')
                .run(sessionId);
            } catch (err) {
              log.warn(
                `TaskAgentManager: failed to delete never-streamed session row ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
            throw new SpawnSupersededError(match.id, 'fresh-create-bind');
          }
        } else if (match && match.agentSessionId) {
          log.warn(
            `TaskAgentManager: NodeExecution ${match.id} already has agentSessionId ${match.agentSessionId}; skipping update for new session ${sessionId}`
          );
        } else if (!memberInfo.deferFreshExecutionBind) {
          log.warn(
            `TaskAgentManager: no matching NodeExecution found for (run=${parentTask.workflowRunId}, node=${memberInfo.nodeId}, agent=${memberInfo.agentName})`
          );
        }
      }
    }

    subSession.onMissingWorkflowMcpServers = async (target: AgentSession, missing: string[]) => {
      await this.mcpSelfHeal(target, missing);
    };

    await subSession.startStreamingQuery();

    if (memberInfo?.agentName && !memberInfo.deferFreshExecutionBind) {
      const parentTask = this.config.taskRepo.getTask(taskId);
      const runId = parentTask?.workflowRunId;
      if (runId) {
        void this.flushPendingMessagesForTarget(runId, memberInfo.agentName, sessionId).catch(
          (err) => {
            log.warn(
              `TaskAgentManager: flushPendingMessagesForTarget failed for ${memberInfo.agentName} (session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        );
      }
    }

    log.info(`TaskAgentManager: created sub-session ${sessionId} for task ${taskId}`);
    return sessionId;
  }

  async flushPendingMessagesForTarget(
    workflowRunId: string,
    targetAgentName: string,
    sessionId: string
  ): Promise<void> {
    const repo = this.config.pendingMessageRepo;
    if (!repo) return;

    const activeDeliveryIds = this.activeSpaceDeliveryIdsForRun(workflowRunId);
    repo.enforceRetention({ runId: workflowRunId, excludeIds: activeDeliveryIds });
    repo.expireStale(workflowRunId, activeDeliveryIds);

    const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
    const workflowNodeName = execution
      ? this.workflowNodeNameForRun(workflowRunId, execution.workflowNodeId)
      : null;
    const drainWorkflowNodeId = execution?.workflowNodeId ?? null;
    const drain = decidePendingDrainAdmission({
      listings: derivePendingQueueTargetNames(targetAgentName, workflowNodeName).map(
        (targetName) => ({
          targetName,
          rows:
            drainWorkflowNodeId != null
              ? repo.listPendingForTarget(workflowRunId, targetName, drainWorkflowNodeId)
              : repo.listPendingForTarget(workflowRunId, targetName),
        })
      ),
      admission: { executionPresent: !!execution, targetKind: 'node_agent' },
    });
    if (drain.action === 'skip') return;

    log.info(
      `TaskAgentManager: flushing ${drain.rows.length} pending message(s) for agent=${targetAgentName} session=${sessionId}`
    );

    for (const row of drain.rows) {
      const isSyntheticMessage = !isHumanPendingSource(row.sourceAgentName);
      const message = formatPendingRowForNodeAgent(row, targetAgentName);
      try {
        await this.injectSubSessionMessage(
          sessionId,
          message,
          isSyntheticMessage,
          undefined,
          row.deliveryMode ?? undefined,
          undefined,
          row.id
        );
        this.recordActivityForSession(sessionId);
        repo.markDelivered(row.id, sessionId);
        this.emitPendingDelivered(row.id, sessionId, row);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          `TaskAgentManager: pending message ${row.id} delivery to ${sessionId} failed: ${errMsg}`
        );
        repo.markAttemptFailed(row.id, errMsg);
      }
    }
  }

  async tryResumeNodeAgentSession(
    workflowRunId: string,
    agentName: string,
    workflowNodeId?: string
  ): Promise<void> {
    const repo = this.config.pendingMessageRepo;
    if (!repo) return;

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
    const exec = executions
      .filter(
        (e) =>
          e.agentName === agentName &&
          e.agentSessionId &&
          (!workflowNodeId || e.workflowNodeId === workflowNodeId)
      )
      .at(-1);
    if (!exec?.agentSessionId) return;

    const sessionId = exec.agentSessionId;

    if (this.agentSessionIndex.has(sessionId)) {
      await this.flushPendingMessagesForTarget(workflowRunId, agentName, sessionId);
    } else {
      await this.rehydrateSubSession(sessionId);
    }
  }

  async flushPendingMessagesForSpaceAgent(spaceId: string, workflowRunId: string): Promise<void> {
    const repo = this.config.pendingMessageRepo;
    const inject = this.config.spaceAgentInjector;
    if (!repo || !inject) return;
    if (this.spaceAgentDrainsInFlight.has(workflowRunId)) {
      this.spaceAgentDrainRerunQueued.add(workflowRunId);
      return;
    }
    this.spaceAgentDrainsInFlight.add(workflowRunId);
    try {
      do {
        this.spaceAgentDrainRerunQueued.delete(workflowRunId);
        await this.flushSpaceAgentDrainLocked(spaceId, workflowRunId);
      } while (this.spaceAgentDrainRerunQueued.has(workflowRunId));
    } finally {
      this.spaceAgentDrainsInFlight.delete(workflowRunId);
      this.spaceAgentDrainRerunQueued.delete(workflowRunId);
    }
  }

  private async flushSpaceAgentDrainLocked(spaceId: string, workflowRunId: string): Promise<void> {
    const repo = this.config.pendingMessageRepo;
    const inject = this.config.spaceAgentInjector;
    if (!repo || !inject) return;

    const spaceChatSessionId = `space:chat:${spaceId}`;
    const resolveReplySession = (row: PendingAgentMessageRecord): string | null =>
      this.resolveSpaceAgentReplySession(row);
    const drainDeps: SpaceAgentPendingDrainDeps = {
      repo,
      resolveReplySession,
      probeDeliveryStatus: (sessionId, messageId) =>
        this.config.db.getSDKMessageRepo?.()?.getDeliveryContent(sessionId, messageId)?.sendStatus,
      onSettled: (row, deliveredSessionId) =>
        this.emitPendingDelivered(row.id, deliveredSessionId, row),
      watchActiveDelivery: (row) => {
        const replyToSession = this.resolveSpaceAgentReplySession(row);
        const candidates =
          replyToSession && replyToSession !== spaceChatSessionId
            ? [replyToSession, spaceChatSessionId]
            : [spaceChatSessionId];
        const probe = (sessionId: string) =>
          this.config.db.getSDKMessageRepo?.()?.getDeliveryContent(sessionId, row.id)?.sendStatus;
        const handles: import('./space-agent-message-delivery.ts').SpaceAgentLateSettlementHandle[] =
          [];
        let done = false;
        const stopWatchers = () => {
          done = true;
          for (const handle of handles) handle.cancel();
        };
        const settleFrom = (settledSessionId: string) => {
          if (done) return;
          done = true;
          stopWatchers();
          if (repo.getById(row.id)?.status !== 'pending') return;
          repo.markDelivered(row.id, settledSessionId);
          this.emitPendingDelivered(row.id, settledSessionId, row);
        };
        const scheduleReconciliation = () => {
          void this.flushPendingMessagesForSpaceAgent(spaceId, workflowRunId).catch(() => {});
        };
        const onWatcherFailed = () => {
          if (done) return;
          done = true;
          stopWatchers();
          scheduleReconciliation();
        };
        for (const sessionId of candidates) {
          handles.push(
            this.lateSettlements.arm({
              sessionId,
              messageId: row.id,
              onConsumed: (settledSessionId) => {
                settleFrom(settledSessionId);
                scheduleReconciliation();
              },
              onFailed: onWatcherFailed,
            })
          );
        }
        for (const sessionId of candidates) {
          if (probe(sessionId) === 'consumed') {
            settleFrom(sessionId);
            return;
          }
        }
      },
    };

    const drainOutcome = await runSpaceAgentPendingDrain(drainDeps, {
      workflowRunId,
      spaceChatSessionId,
    });
    if (drainOutcome.action === 'skip') return;

    log.info(
      `TaskAgentManager: flushing ${drainOutcome.rows.length} pending message(s) for Space Agent session=${spaceChatSessionId}`
    );

    for (const row of drainOutcome.rows) {
      if (row.attempts >= row.maxAttempts) {
        repo.markFailed(row.id, `space-agent delivery attempts exhausted (${row.maxAttempts})`);
        continue;
      }
      const message = formatPendingRowForSpaceAgent(row);
      const replyTo = resolveReplySession(row);
      try {
        const deliveredSessionId = replyTo || spaceChatSessionId;
        const settleDelivered = (settledSessionId?: string): void => {
          const targetSessionId = settledSessionId ?? deliveredSessionId;
          if (repo.getById(row.id)?.status !== 'pending') return;
          repo.markDelivered(row.id, targetSessionId);
          this.emitPendingDelivered(row.id, targetSessionId, row);
        };
        const scheduleReconciliation = () => {
          void this.flushPendingMessagesForSpaceAgent(spaceId, workflowRunId).catch(() => {});
        };
        const outcome = await inject(spaceId, message, replyTo, row.id, {
          onConsumed: settleDelivered,
          lateSettlement: this.lateSettlements,
          disposeSignal: this.lateSettlements.disposeSignal(),
        });
        const recorded = repo.recordDeliveryAttempt(
          row.id,
          outcome.state === 'failed' ? outcome.error : null
        );
        if (outcome.state === 'delivered') {
          settleDelivered(outcome.sessionId);
        } else if (outcome.state === 'failed') {
          repo.deferExpiration([row.id]);
          scheduleReconciliation();
          if ((recorded?.attempts ?? 0) >= row.maxAttempts) {
            repo.markFailed(row.id, `space-agent delivery attempts exhausted (${row.maxAttempts})`);
          }
          log.warn(
            `TaskAgentManager: Space Agent delivery for ${row.id} failed: ${outcome.error}; ` +
              `scheduling reconciliation to charge and retry the attempt`
          );
        } else {
          repo.deferExpiration([row.id]);
          log.info(
            `TaskAgentManager: Space Agent delivery for ${row.id} queued pending consumption ` +
              `by ${spaceChatSessionId}; the pending row settles when consumption completes`
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const recorded = repo.recordDeliveryAttempt(row.id, errMsg);
        if ((recorded?.attempts ?? 0) >= row.maxAttempts) {
          repo.markFailed(row.id, `space-agent delivery attempts exhausted (${row.maxAttempts})`);
        }
        log.warn(`TaskAgentManager: Space Agent delivery for ${row.id} failed: ${errMsg}`);
      }
    }
  }

  activeSpaceDeliveryIdsForRun(workflowRunId: string): string[] {
    const repo = this.config.pendingMessageRepo;
    if (!repo) return [];
    return collectActiveSpaceDeliveryIds({
      repo,
      workflowRunId,
      spaceChatSessionId: `space:chat:${this.config.workflowRunRepo?.getRun?.(workflowRunId)?.spaceId ?? ''}`,
      resolveReplySession: (row) => this.resolveSpaceAgentReplySession(row),
      probeDeliveryStatus: (sessionId, messageId) =>
        this.config.db.getSDKMessageRepo?.()?.getDeliveryContent(sessionId, messageId)?.sendStatus,
    });
  }

  private resolveSpaceAgentReplySession(row: PendingAgentMessageRecord): string | null {
    const message = formatPendingRowForSpaceAgent(row);
    const registry = this.config.replyRoutingRegistry;
    return (
      extractReplyToSessionId(message) ?? (registry && row.taskId ? registry.get(row.taskId) : null)
    );
  }

  private emitPendingDelivered(
    messageId: string,
    sessionId: string,
    row: { spaceId: string; workflowRunId: string; targetAgentName: string; targetKind: string }
  ): void {
    if (!this.config.internalEventBus) return;
    void this.config.internalEventBus
      .publish('space.pendingMessage.delivered', {
        sessionId: 'global',
        spaceId: row.spaceId,
        workflowRunId: row.workflowRunId,
        targetAgentName: row.targetAgentName,
        targetKind: row.targetKind,
        messageId,
        deliveredSessionId: sessionId,
      })
      .catch(() => {});
  }

  async injectSubSessionMessage(
    subSessionId: string,
    message: string,
    isSyntheticMessage = true,
    images?: MessageImage[],
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    inputKindOverride?: MessageInputKind,
    messageId?: string
  ): Promise<string> {
    const inputKind: MessageInputKind =
      inputKindOverride ?? (isSyntheticMessage ? 'task' : 'human');
    return await this.injectSubSessionMessageWithOrigin(
      subSessionId,
      message,
      undefined,
      isSyntheticMessage,
      images,
      deliveryMode,
      inputKind,
      messageId
    );
  }

  async injectRuntimeRecoveryMessage(subSessionId: string, message: string): Promise<string> {
    return await this.injectSubSessionMessageWithOrigin(
      subSessionId,
      message,
      'system',
      true,
      undefined,
      'immediate',
      'system'
    );
  }

  private async injectSubSessionMessageWithOrigin(
    subSessionId: string,
    message: string,
    origin: MessageOrigin | undefined,
    isSyntheticMessage = true,
    images?: MessageImage[],
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    inputKind: MessageInputKind = 'task',
    messageId?: string
  ): Promise<string> {
    const guardExecution = this.resolveNodeExecutionForSubSession(subSessionId);
    if (guardExecution) {
      const guardStatus = this.resolveTerminalInjectionStatus(guardExecution.workflowRunId);
      if (guardStatus) {
        log.warn(
          `TaskAgentManager.injectSubSessionMessageWithOrigin: rejecting inject to session ${subSessionId} — task/run is terminal (${guardStatus})`
        );
        throw new Error(
          `Cannot inject message to session ${subSessionId} — task/run is terminal (${guardStatus})`
        );
      }
    }

    const resolveSessionTarget = async (): Promise<AgentSession | null> => {
      const indexed = this.agentSessionIndex.get(subSessionId);
      if (indexed) return indexed;

      for (const [, nodeMap] of this.subSessions) {
        const session = nodeMap.get(subSessionId);
        if (session) return session;
      }

      return await this.rehydrateSubSession(subSessionId);
    };

    const target = await resolveSessionTarget();
    if (!target) {
      throw new Error(`Sub-session not found: ${subSessionId}`);
    }

    return this.withSessionInjectLock(subSessionId, async () => {
      const lockedExecution = this.resolveNodeExecutionForSubSession(subSessionId);
      if (lockedExecution) {
        const lockedStatus = this.resolveTerminalInjectionStatus(lockedExecution.workflowRunId);
        if (lockedStatus) {
          log.warn(
            `TaskAgentManager.injectSubSessionMessageWithOrigin: rejecting inject to session ${subSessionId} after lock acquisition — task/run is terminal (${lockedStatus})`
          );
          throw new Error(
            `Cannot inject message to session ${subSessionId} — task/run is terminal (${lockedStatus})`
          );
        }
      }

      const currentTarget =
        this.agentSessionIndex.get(subSessionId) ??
        Array.from(this.subSessions.values())
          .map((nodeMap) => nodeMap.get(subSessionId))
          .find((session) => session !== undefined);
      if (!currentTarget) {
        throw new Error(`Sub-session not found: ${subSessionId}`);
      }

      return await this.injectMessageIntoSession(
        currentTarget,
        message,
        deliveryMode,
        origin,
        isSyntheticMessage,
        images,
        inputKind,
        messageId
      );
    });
  }

  private resolveTerminalInjectionStatus(workflowRunId: string): string | null {
    const guardTask =
      this.config.taskRepo?.listByWorkflowRunIncludingArchived?.(workflowRunId)?.[0] ?? null;
    const guardRun = this.config.workflowRunRepo?.getRun?.(workflowRunId) ?? null;
    if (
      guardTask?.status === 'cancelled' ||
      guardTask?.status === 'archived' ||
      guardRun?.status === 'cancelled'
    ) {
      return guardTask?.status ?? guardRun?.status ?? 'terminal';
    }
    return null;
  }

  private withSessionInjectLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return withSessionResetCoordination(sessionId, fn);
  }

  private async withSessionRestoreLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionRestoreLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => held);
    this.sessionRestoreLocks.set(sessionId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionRestoreLocks.get(sessionId) === tail) {
        this.sessionRestoreLocks.delete(sessionId);
      }
    }
  }

  async getSubSessionByAgentName(
    taskId: string,
    agentName: string,
    workflowNodeId?: string
  ): Promise<AgentSession | null> {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return null;

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
    const exec = executions
      .filter(
        (e) =>
          e.agentName === agentName &&
          e.agentSessionId &&
          e.status !== 'cancelled' &&
          e.status !== 'pending' &&
          (!workflowNodeId || e.workflowNodeId === workflowNodeId)
      )
      .at(-1);
    if (!exec?.agentSessionId) return null;

    const cached = this.agentSessionIndex.get(exec.agentSessionId);
    if (cached) return cached;

    return this.rehydrateSubSession(exec.agentSessionId);
  }

  async getAgentNamesForTask(taskId: string): Promise<string[]> {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return [];
    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
    const names = new Set(executions.filter((e) => e.agentSessionId).map((e) => e.agentName));
    return [...names];
  }

  isAgentDeclaredOnNode(taskId: string, workflowNodeId: string, agentName: string): boolean {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return false;
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    if (!workflow) return false;
    const node = workflow.nodes.find((n) => n.id === workflowNodeId);
    if (!node) return false;
    try {
      const slots = resolveNodeAgents(node);
      return slots.some((slot) => slot.name === agentName);
    } catch {
      return false;
    }
  }

  getWorkflowDeclaredAgentNamesForTask(taskId: string): string[] {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return [];
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return [];
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    if (!workflow) return [];
    const names = new Set<string>();
    for (const node of workflow.nodes) {
      let slots: ReturnType<typeof resolveNodeAgents>;
      try {
        slots = resolveNodeAgents(node);
      } catch {
        continue;
      }
      for (const slot of slots) {
        names.add(slot.name);
      }
    }
    return [...names];
  }

  getPostApprovalWorkerSession(
    taskId: string,
    hintSessionId?: string
  ): { sessionId: string; agentName: string; nodeId?: string | null } | null {
    if (hintSessionId) {
      return this.validateWorkerSessionForTask(taskId, hintSessionId);
    }
    const identity = this.readPostApprovalWorkerIdentity(taskId);
    return identity
      ? {
          sessionId: identity.sessionId,
          agentName: identity.agentName,
          nodeId: identity.nodeId ?? null,
        }
      : null;
  }

  private validateWorkerSessionForTask(
    taskId: string,
    sessionId: string
  ): { sessionId: string; agentName: string; nodeId?: string | null } | null {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return null;
    if (task.status === 'cancelled' || task.status === 'archived') return null;
    if (!this.sessionIsWorkerForTask(sessionId, taskId)) return null;
    const provenance = this.readProvenanceFromSessionRow(sessionId);
    const agentName = provenance?.agentName ?? this.legacyWorkflowRouteAgentName(task);
    return agentName
      ? {
          sessionId,
          agentName,
          nodeId: provenance?.nodeId ?? this.legacyWorkflowRouteNodeId(task) ?? null,
        }
      : null;
  }

  private legacyWorkflowRouteAgentName(
    task: {
      workflowRunId?: string | null;
    } | null
  ): string | undefined {
    if (!task?.workflowRunId) return undefined;
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return undefined;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    return resolvePostApprovalTargetAgentName(workflow);
  }

  private legacyWorkflowRouteNodeId(
    task: {
      workflowRunId?: string | null;
    } | null
  ): string | undefined {
    if (!task?.workflowRunId) return undefined;
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return undefined;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    return resolvePostApprovalRouteNodeId(workflow);
  }

  private sessionIsWorkerForTask(sessionId: string, taskId: string): boolean {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare(
          `SELECT 1 AS ok
             FROM sessions s
            WHERE s.id = ?
              AND s.type = 'worker'
              AND s.task_id = ?
              AND NOT EXISTS (SELECT 1 FROM node_executions ne WHERE ne.agent_session_id = s.id)`
        )
        .get(sessionId, taskId) as { ok?: number } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private readPostApprovalWorkerIdentity(
    taskId: string,
    hintSessionId?: string
  ): {
    sessionId: string;
    agentName: string;
    nodeId?: string;
    agentId?: string;
  } | null {
    const task = this.config.taskRepo.getTask(taskId);
    if (task?.status === 'cancelled' || task?.status === 'archived') return null;
    if (hintSessionId) {
      if (!this.sessionIsWorkerForTask(hintSessionId, taskId)) return null;
      const provenance = this.readProvenanceFromSessionRow(hintSessionId);
      const agentName = provenance?.agentName ?? this.legacyWorkflowRouteAgentName(task);
      if (!agentName) return null;
      const nodeId = provenance?.nodeId ?? this.legacyWorkflowRouteNodeId(task);
      return {
        sessionId: hintSessionId,
        agentName,
        ...(nodeId ? { nodeId } : {}),
        ...(provenance?.agentId ? { agentId: provenance.agentId } : {}),
      };
    }
    let sessionId = task?.postApprovalSessionId;
    let provenance = sessionId ? this.readProvenanceFromSessionRow(sessionId) : null;
    if (!provenance && !sessionId && task?.status === 'done') {
      const durableId = this.findDurableWorkerSessionId(taskId);
      if (durableId) {
        sessionId = durableId;
        provenance = this.readProvenanceFromSessionRow(durableId);
      }
    }
    if (!sessionId) return null;
    let agentName = provenance?.agentName;
    const agentId = provenance?.agentId;
    const nodeId = provenance?.nodeId ?? this.legacyWorkflowRouteNodeId(task);
    if (!agentName) {
      agentName = this.legacyWorkflowRouteAgentName(task);
      if (!agentName) return null;
    }
    return { sessionId, agentName, ...(nodeId ? { nodeId } : {}), ...(agentId ? { agentId } : {}) };
  }

  private readProvenanceFromSessionRow(sessionId: string): {
    agentName?: string;
    nodeId?: string;
    agentId?: string;
  } | null {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare('SELECT metadata FROM sessions WHERE id = ?')
        .get(sessionId) as { metadata?: string | null } | undefined;
      if (!row?.metadata) return null;
      const provenance = (JSON.parse(row.metadata) as { promptProvenance?: unknown })
        ?.promptProvenance as { agentName?: string; nodeId?: string; agentId?: string } | undefined;
      return provenance ?? null;
    } catch {
      return null;
    }
  }

  private findDurableWorkerSessionId(taskId: string): string | undefined {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare(
          `SELECT s.id AS id
             FROM sessions s
            WHERE s.type = 'worker'
              AND s.task_id = ?
              AND NOT EXISTS (SELECT 1 FROM node_executions ne WHERE ne.agent_session_id = s.id)
            ORDER BY s.last_active_at DESC
            LIMIT 1`
        )
        .get(taskId) as { id?: string } | undefined;
      return row?.id;
    } catch {
      return undefined;
    }
  }

  private readPersistedRateLimitCooldown(sessionId: string): { retryAt: number } | null {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare('SELECT processing_state FROM sessions WHERE id = ?')
        .get(sessionId) as { processing_state?: string | null } | undefined;
      if (!row?.processing_state) return null;
      const state = JSON.parse(row.processing_state) as { status?: string; retryAt?: unknown };
      if (state.status !== 'rate_limit_cooldown') return null;
      const retryAt = typeof state.retryAt === 'number' ? state.retryAt : null;
      if (retryAt === null || retryAt <= Date.now()) return null;
      return { retryAt };
    } catch {
      return null;
    }
  }

  async restorePostApprovalWorkerSession(
    taskId: string,
    hintSessionId?: string
  ): Promise<string | null> {
    const identity = this.readPostApprovalWorkerIdentity(taskId, hintSessionId);
    if (!identity) return null;

    if (this.agentSessionIndex.has(identity.sessionId)) return identity.sessionId;

    return this.withSessionRestoreLock(identity.sessionId, () =>
      this.performPostApprovalWorkerRestore(taskId, identity)
    );
  }

  private async performPostApprovalWorkerRestore(
    taskId: string,
    identity: { sessionId: string; agentName: string; nodeId?: string; agentId?: string }
  ): Promise<string | null> {
    const { sessionId, agentName, nodeId, agentId } = identity;

    if (this.agentSessionIndex.has(sessionId)) return sessionId;

    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return null;
    if (task.status === 'cancelled' || task.status === 'archived') return null;
    const workflowRun = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (workflowRun?.status === 'cancelled') return null;

    const cooldown = this.readPersistedRateLimitCooldown(sessionId);
    if (cooldown) {
      throw new Error(
        `Post-approval worker "${agentName}" is rate-limited until ${new Date(cooldown.retryAt).toISOString()}; retry after the cooldown expires.`
      );
    }

    const space = await this.config.spaceManager.getSpace(task.spaceId);
    if (!space) return null;
    const workspacePath = this.getTaskWorktreePath(taskId) ?? space.workspacePath;

    const workflow = workflowRun?.workflowId
      ? this.config.spaceWorkflowManager.getWorkflowForRun(workflowRun)
      : null;

    let matchedSlot: ReturnType<typeof resolveNodeAgents>[number] | null = null;
    let matchedNode: WorkflowNode | undefined;
    if (workflow && nodeId) {
      matchedNode = workflow.nodes.find((n) => n.id === nodeId);
      if (matchedNode) {
        for (const slot of resolveNodeAgents(matchedNode)) {
          if (slot.name === agentName || (agentId && slot.agentId === agentId)) {
            matchedSlot = slot;
            break;
          }
        }
      }
    }

    const cached = this.config.sessionManager.getCachedSession(sessionId);
    const createdNow = !cached;
    const agentSession =
      cached ??
      AgentSession.restore(
        sessionId,
        this.config.db,
        this.config.messageHub,
        this.config.internalEventBus,
        this.config.getApiKey,
        this.config.skillsManager,
        this.config.appMcpServerRepo,
        { autoReplayPendingMessages: false }
      );
    if (!agentSession) return null;

    let slotInit: AgentSessionInit | null = null;
    if (matchedSlot?.agentId && matchedNode) {
      const slotOverrides = buildSlotOverrides(matchedSlot, {
        task,
        node: matchedNode,
        workflow: workflow ?? undefined,
        workflowRun: workflowRun ?? undefined,
      });
      slotInit = resolveAgentInit({
        task,
        space,
        agentManager: this.config.spaceAgentManager,
        sessionId,
        workspacePath,
        workflowRun: workflowRun ?? undefined,
        workflow: workflow ?? undefined,
        slotOverrides,
        agentId: matchedSlot.agentId,
      });
      if (slotInit.systemPrompt) agentSession.setRuntimeSystemPrompt(slotInit.systemPrompt);
      agentSession.toolGuards = slotInit.toolGuards;
      agentSession.skillOverrides = slotInit.skillOverrides;
    }

    const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
      taskId,
      sessionId,
      agentName,
      task.spaceId,
      task.workflowRunId,
      workspacePath,
      nodeId ?? ''
    );
    const mergedMcpServers: Record<string, McpServerConfig> = {
      ...slotInit?.mcpServers,
      'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
      'space-agent-tools': this.config.spaceRuntimeService.buildMemberSpaceToolsMcpServer(
        space,
        sessionId
      ),
      ...this.buildAgentMemoryMcpServers(task.spaceId, sessionId),
    };
    agentSession.mergeRuntimeMcpServers(mergedMcpServers);

    await this.ensureNodeAgentAttached(agentSession, {
      taskId,
      subSessionId: sessionId,
      agentName,
      spaceId: task.spaceId,
      workflowRunId: task.workflowRunId,
      workspacePath,
      workflowNodeId: nodeId ?? '',
      phase: 'rehydrate',
    });

    agentSession.onMissingMemberSpaceMcpServers = async (sid: string) => {
      await this.config.spaceRuntimeService.reattachMemberSpaceTools(sid);
    };
    agentSession.onMissingWorkflowMcpServers = async (target: AgentSession, missing: string[]) => {
      await this.mcpSelfHeal(target, missing);
    };
    this.reattachSlotContextReset(agentSession);

    if (!this.subSessions.has(taskId)) {
      this.subSessions.set(taskId, new Map());
    }
    this.subSessions.get(taskId)!.set(sessionId, agentSession);
    this.agentSessionIndex.set(sessionId, agentSession);
    if (createdNow) this.config.sessionManager.registerSession(agentSession);

    try {
      this.sanitizeSDKSessionTranscriptForRehydration(agentSession, workspacePath);
      await agentSession.startStreamingQuery();
      await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);
    } catch (err) {
      this.subSessions.get(taskId)?.delete(sessionId);
      this.agentSessionIndex.delete(sessionId);
      if (createdNow) {
        await this.config.sessionManager.unregisterSession(sessionId).catch(() => {});
      }
      throw err;
    }
    void this.flushPendingMessagesForTarget(task.workflowRunId, agentName, sessionId).catch(
      (err) => {
        log.warn(
          `restorePostApprovalWorkerSession: flushPendingMessagesForTarget failed for ${agentName} (session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );

    log.info(
      `TaskAgentManager.restorePostApprovalWorkerSession: restored worker ${sessionId} (agent ${agentName}${agentId ? `/${agentId}` : ''}) for task ${taskId}`
    );
    return sessionId;
  }

  async activateTargetSessionsForMessage(
    taskId: string,
    workflowRunId: string,
    agentName: string,
    options?: { reopenReason?: string; reopenBy?: string; workflowNodeId?: string }
  ): Promise<Array<{ agentName: string; sessionId: string }>> {
    await this.tryResumeNodeAgentSession(workflowRunId, agentName, options?.workflowNodeId);
    const matchesNode = (workflowNodeId: string) =>
      !options?.workflowNodeId || workflowNodeId === options.workflowNodeId;
    const existing = this.config.nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .filter(
        (execution) =>
          execution.agentName === agentName &&
          matchesNode(execution.workflowNodeId) &&
          (execution.status === 'in_progress' || execution.status === 'blocked')
      )
      .at(-1);
    const route = decideActivationRouting({
      existingExecution: existing
        ? {
            status: existing.status,
            agentSessionId: existing.agentSessionId,
            sessionAlive: existing.agentSessionId
              ? this.isSessionAlive(existing.agentSessionId)
              : false,
          }
        : null,
    });
    if (route.action === 'reuse_existing') {
      return [{ agentName, sessionId: route.sessionId }];
    }
    if (route.action === 'reset_pending_and_continue' && existing) {
      if (existing.agentSessionId) {
        this.agentSessionIndex.delete(existing.agentSessionId);
      }
      const outcome = this.config.nodeExecutionRepo.casExecutionStatus(
        existing.id,
        [existing.status],
        'pending'
      );
      if (outcome === 'superseded') {
        log.info(
          `TaskAgentManager.activateTargetSessionsForMessage: execution ${existing.id} moved concurrently (${existing.status} no longer current); skipping activation for this call`
        );
        return [];
      }
    }

    const gateRoute = decideActivationRouting({
      workflowNodeId: options?.workflowNodeId,
      agentDeclaredOnNode: this.resolveAgentDeclaredOnNode(
        taskId,
        agentName,
        options?.workflowNodeId
      ),
    });
    if (gateRoute.action === 'reject_undeclared') return [];

    await this.ensureWorkflowNodeActivationForAgent(taskId, agentName, options);

    const task = this.config.taskRepo.getTask(taskId);
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    const workflow = run?.workflowId
      ? this.config.spaceWorkflowManager.getWorkflowForRun(run)
      : null;
    const space = task ? await this.config.spaceManager.getSpace(task.spaceId) : null;
    const execution = this.config.nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .find(
        (candidate) => candidate.agentName === agentName && matchesNode(candidate.workflowNodeId)
      );
    const postRoute = decideActivationRouting({
      taskRunWorkflowResolvable: !!(task && run && workflow && space),
      executionResolvable: !!execution,
    });
    if (
      postRoute.action !== 'spawn_with_timeout' ||
      !task ||
      !run ||
      !workflow ||
      !space ||
      !execution
    ) {
      return [];
    }

    const spawnPromise = this.spawnWorkflowNodeAgentForExecution(
      task,
      space,
      workflow,
      run,
      execution
    );
    const timeoutMs = 30_000;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutTimer = setTimeout(() => resolve(null), timeoutMs);
      timeoutTimer.unref();
    });
    spawnPromise.catch((err) => {
      log.warn(
        `TaskAgentManager.activateTargetSessionsForMessage: spawn of agent "${agentName}" for run ${workflowRunId} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    let sessionId: string | null;
    try {
      sessionId = await Promise.race([spawnPromise, timeoutPromise]);
    } catch (err) {
      if (isSpawnSupersededError(err)) {
        log.info(
          `TaskAgentManager.activateTargetSessionsForMessage: spawn of agent "${agentName}" for run ${workflowRunId} superseded; skipping activation for this call`
        );
        return [];
      }
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
    }
    if (!sessionId) {
      log.warn(
        `TaskAgentManager.activateTargetSessionsForMessage: timed out after ${timeoutMs}ms activating agent "${agentName}" for run ${workflowRunId}`
      );
      return [];
    }
    return [{ agentName, sessionId }];
  }

  private resolveAgentDeclaredOnNode(
    taskId: string,
    agentName: string,
    workflowNodeId: string | undefined
  ): boolean {
    if (!workflowNodeId) return true;
    const task = this.config.taskRepo.getTask(taskId);
    const run = task?.workflowRunId ? this.config.workflowRunRepo.getRun(task.workflowRunId) : null;
    if (!run?.workflowId) return true;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    const node = workflow?.nodes.find((candidate) => candidate.id === workflowNodeId);
    const slots = node ? resolveNodeAgents(node) : [];
    return slots.some((slot) => slot.name === agentName);
  }

  async ensureWorkflowNodeActivationForAgent(
    taskId: string,
    agentName: string,
    options?: { reopenReason?: string; reopenBy?: string; workflowNodeId?: string }
  ): Promise<boolean> {
    try {
      const task = this.config.taskRepo.getTask(taskId);
      if (!task?.workflowRunId) return false;
      const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
      if (!run?.workflowId) return false;
      const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
      if (!workflow) return false;
      const space = await this.config.spaceManager.getSpace(task.spaceId);
      if (!space) return false;

      const targetNode = selectWorkflowNodeForAgent(
        workflow.nodes,
        agentName,
        options?.workflowNodeId
      );
      if (!targetNode) return false;

      const channelRouter = new ChannelRouter({
        taskRepo: this.config.taskRepo,
        workflowRunRepo: this.config.workflowRunRepo,
        workflowManager: this.config.spaceWorkflowManager,
        agentManager: this.config.spaceAgentManager,
        nodeExecutionRepo: this.config.nodeExecutionRepo,
        channelCycleRepo: this.config.channelCycleRepo,
        isSessionAlive: (sid) => this.isSessionAlive(sid),
        cancelSessionById: (sid) => this.cancelBySessionId(sid),
        internalEventBus: this.config.internalEventBus,
      });

      await channelRouter.activateNode(run.id, targetNode.id, {
        allowTerminalReopen: true,
        reopenReason: options?.reopenReason ?? `lazy activation of agent "${agentName}"`,
        reopenBy: options?.reopenBy ?? 'task-agent',
        targetAgentName: agentName,
      });
      return true;
    } catch (err) {
      log.warn(
        `TaskAgentManager.ensureWorkflowNodeActivationForAgent: ` +
          `failed for taskId=${taskId} agentName=${agentName}: ` +
          (err instanceof Error ? err.message : String(err))
      );
      return false;
    }
  }

  isExecutionSpawning(executionId: string): boolean {
    return this.spawningExecutionIds.has(executionId);
  }

  isSessionAlive(sessionId: string): boolean {
    const indexed = this.agentSessionIndex.get(sessionId);
    if (indexed) return this.isAgentSessionAlive(indexed);

    const session = this.config.sessionManager.getSession(sessionId);
    return session ? this.isAgentSessionAlive(session) : false;
  }

  isSessionInMemory(sessionId: string): boolean {
    const indexed = this.agentSessionIndex.get(sessionId);
    return !!indexed && this.isAgentSessionAlive(indexed);
  }

  private isAgentSessionAlive(session: AgentSession): boolean {
    const state = session.getProcessingState();
    return (
      state.status === 'idle' ||
      state.status === 'queued' ||
      state.status === 'processing' ||
      state.status === 'waiting_for_input' ||
      state.status === 'interrupted' ||
      state.status === 'rate_limit_cooldown'
    );
  }

  getTaskWorktreePath(taskId: string): string | undefined {
    const cached = this.taskWorktreePaths.get(taskId);
    if (cached) return cached;
    if (!this.config.worktreeManager) return undefined;
    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return undefined;
    const stored = this.config.worktreeManager.getTaskWorktreePathSync(task.spaceId, task.id);
    if (stored) {
      this.taskWorktreePaths.set(taskId, stored);
      return stored;
    }
    return undefined;
  }

  getSubSession(subSessionId: string): AgentSession | undefined {
    for (const [, nodeMap] of this.subSessions) {
      const session = nodeMap.get(subSessionId);
      if (session) return session;
    }
    return undefined;
  }

  getAgentSessionById(sessionId: string): AgentSession | undefined {
    const indexed = this.agentSessionIndex.get(sessionId);
    if (indexed) return indexed;

    return this.config.sessionManager.getSession(sessionId) ?? undefined;
  }

  getCachedAgentSessionById(sessionId: string): AgentSession | undefined {
    return this.agentSessionIndex.get(sessionId);
  }

  getLiveSubSessionIdsForTasks(taskIds: string[]): string[] {
    const ids = new Set<string>();
    for (const taskId of taskIds) {
      const nodeMap = this.subSessions.get(taskId);
      if (!nodeMap) continue;
      for (const [sid, session] of nodeMap) {
        if (session.getProcessingState().status === 'idle') continue;
        ids.add(sid);
      }
    }
    return [...ids];
  }

  async prepareSubSessionForWorkflowResume(sessionId: string): Promise<boolean> {
    if (!this.isSessionAlive(sessionId)) return false;
    const session = this.getAgentSessionById(sessionId);
    if (!session) return false;
    await this.mcpSelfHeal(session, ['node-agent']);
    return true;
  }

  async resumeRateLimitedSubSession(sessionId: string): Promise<'retried' | 'respawned' | 'noop'> {
    const session = this.getAgentSessionById(sessionId);
    if (!session) return 'noop';
    try {
      const fired = await session.retryNowAfterRateLimit();
      if (fired) return 'retried';
      if (!session.isRateLimitBannerCancelled()) return 'noop';
      await this.respawnRateLimitedExecution(sessionId);
      return 'respawned';
    } catch (err) {
      log.warn(
        `TaskAgentManager: failed to resume rate-limited sub-session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return 'noop';
    }
  }

  private async respawnRateLimitedExecution(sessionId: string): Promise<void> {
    const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
    if (execution) {
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        agentSessionId: null,
        result: null,
        startedAt: null,
        completedAt: null,
      });
    } else {
      log.warn(
        `TaskAgentManager.respawnRateLimitedExecution: no NodeExecution bound to session ${sessionId}; resetting nothing.`
      );
    }
    const session =
      this.agentSessionIndex.get(sessionId) ??
      this.config.sessionManager.getCachedSession(sessionId);
    if (!session) return;
    try {
      await this.stopSessionPreserveDb(sessionId, session, { strict: true });
    } catch (err) {
      log.warn(
        `TaskAgentManager.respawnRateLimitedExecution: failed to stop session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.agentSessionIndex.delete(sessionId);
    for (const [, nodeMap] of this.subSessions) {
      nodeMap.delete(sessionId);
    }
    try {
      await this.config.sessionManager.unregisterSession(sessionId);
    } catch (err) {
      log.warn(
        `TaskAgentManager.respawnRateLimitedExecution: failed to unregister session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  cancelBySessionId(agentSessionId: string): void {
    const session =
      this.agentSessionIndex.get(agentSessionId) ??
      this.config.sessionManager.getCachedSession(agentSessionId);
    this.agentSessionIndex.delete(agentSessionId);
    if (!session) {
      void this.config.sessionManager.unregisterSession?.(agentSessionId).catch(() => {});
      return;
    }
    if (this.cancellingSessions.has(agentSessionId)) return;
    this.cancellingSessions.add(agentSessionId);
    void this.stopSessionPreserveDb(agentSessionId, session, { strict: true })
      .then(() => {
        for (const [, nodeMap] of this.subSessions) nodeMap.delete(agentSessionId);
        return this.config.sessionManager.unregisterSession?.(agentSessionId);
      })
      .catch((err) => {
        log.warn(
          `TaskAgentManager.cancelBySessionId: failed to stop session ${agentSessionId}:`,
          err
        );
      })
      .finally(() => {
        this.cancellingSessions.delete(agentSessionId);
      });
  }

  getSubSessionIdsForTasks(taskIds: string[]): string[] {
    const ids: string[] = [];
    for (const taskId of taskIds) {
      const nodeMap = this.subSessions.get(taskId);
      if (!nodeMap) continue;
      for (const sessionId of nodeMap.keys()) ids.push(sessionId);
    }
    return ids;
  }

  async stopSessionsVerified(sessionIds: string[]): Promise<VerifiedSessionStop[]> {
    return Promise.all(
      sessionIds.map((sessionId) =>
        this.stopSessionVerified(sessionId).catch((err) => ({
          sessionId,
          stopped: false,
          detail: `verified stop crashed: ${err instanceof Error ? err.message : String(err)}`,
        }))
      )
    );
  }

  private async stopSessionVerified(sessionId: string): Promise<VerifiedSessionStop> {
    this.cancellingSessions.add(sessionId);
    try {
      const outcome = await runVerifiedStopFlow(this.buildVerifiedStopFlowDeps(), sessionId);
      if (outcome.status === 'error') {
        throw outcome.error;
      }
      if (outcome.status === 'superseded') {
        throw new Error(
          `TaskAgentManager.stopSessionVerified: verified stop for session ${sessionId} superseded at stage ${outcome.stage ?? 'unknown'}`
        );
      }
      return outcome.result as VerifiedSessionStop;
    } finally {
      this.cancellingSessions.delete(sessionId);
    }
  }

  private buildVerifiedStopFlowDeps(): VerifiedStopFlowDeps {
    return {
      claimSession: (sessionId) => {
        const session =
          this.agentSessionIndex.get(sessionId) ??
          this.config.sessionManager?.getCachedSession(sessionId) ??
          null;
        this.agentSessionIndex.delete(sessionId);
        return session;
      },
      stopSessionStrict: (sessionId, session) =>
        this.stopSessionPreserveDb(sessionId, session, { strict: true }),
      readProcessingStatus: (session) => session.getProcessingState().status,
      isInterruptInProgress: (session) => session.isInterruptInProgress(),
      awaitProcessExitSettle: (session) =>
        this.awaitSessionProcessExit(session, VERIFIED_STOP_PROCESS_EXIT_SETTLE_MS),
      readLivePids: (session) => session.getTrackedAgentRootPidsSplit().live,
      terminateTrackedProcesses: (session) =>
        session.terminateTrackedAgentProcesses({
          forceDelayMs: VERIFIED_STOP_ESCALATION_FORCE_KILL_MS,
        }),
      unregisterSession: async (sessionId) => {
        await this.config.sessionManager?.unregisterSession?.(sessionId);
      },
      detachSessionBookkeeping: (sessionId) => this.detachSessionBookkeeping(sessionId),
      warn: (message, err) => {
        if (err === undefined) {
          log.warn(message);
          return;
        }
        log.warn(message, err);
      },
    };
  }

  private async awaitSessionProcessExit(session: AgentSession, timeoutMs: number): Promise<void> {
    const exitPromise = session.processExitedPromise;
    if (!exitPromise) return;
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  private detachSessionBookkeeping(sessionId: string): void {
    for (const [, nodeMap] of this.subSessions) nodeMap.delete(sessionId);
    this.completionCallbacks.delete(sessionId);
    const unsub = this.sessionListeners.get(sessionId);
    if (unsub) {
      unsub();
      this.sessionListeners.delete(sessionId);
    }
  }

  async interruptBySessionId(agentSessionId: string): Promise<void> {
    const session = this.agentSessionIndex.get(agentSessionId);
    if (!session) return;
    try {
      await session.handleInterrupt({ skipDeferredReplay: true });
    } catch (err) {
      log.warn(
        `TaskAgentManager.interruptBySessionId: failed to interrupt session ${agentSessionId}:`,
        err
      );
    }
  }

  async restartStuckSubSession(agentSessionId: string): Promise<void> {
    const session = this.getAgentSessionById(agentSessionId);
    if (!session) {
      throw new Error(`Cannot restart stuck sub-session; session not found: ${agentSessionId}`);
    }
    await this.stopSessionPreserveDb(agentSessionId, session, { strict: true });
    this.agentSessionIndex.delete(agentSessionId);
    for (const [, nodeMap] of this.subSessions) {
      nodeMap.delete(agentSessionId);
    }
    await this.config.sessionManager.unregisterSession(agentSessionId);
  }

  async rehydrate(): Promise<void> {
    const activeTasks = this.config.taskRepo.listActive();

    let selfHealed = 0;
    const processedRunIds = new Set<string>();

    for (const task of activeTasks) {
      if (task.taskAgentSessionId) {
        log.info(
          `TaskAgentManager.rehydrate: clearing legacy task_agent_session_id for task ${task.id}`
        );
        try {
          this.config.taskRepo.updateTask(task.id, { taskAgentSessionId: null });
          selfHealed++;
        } catch (err) {
          log.warn(
            `TaskAgentManager.rehydrate: failed to clear task_agent_session_id for task ${task.id}:`,
            err
          );
        }
      }

      if (task.workflowRunId && !processedRunIds.has(task.workflowRunId)) {
        processedRunIds.add(task.workflowRunId);
        try {
          await this.rehydrateSubSessionsForRun(task.workflowRunId);
        } catch (err) {
          log.warn(
            `TaskAgentManager.rehydrate: failed to rehydrate sub-sessions for run ${task.workflowRunId}:`,
            err
          );
        }
      }
    }

    log.info(
      `TaskAgentManager.rehydrate: processed ${processedRunIds.size} run(s), selfHealed=${selfHealed}`
    );
  }

  async cleanupAll(): Promise<void> {
    this.lateSettlements.dispose();
    clearAllRetryableHookActionTimers();
    this.clearDirectSteerState();
    for (const executionId of this.concurrentSpawnWaiters.keys()) {
      this.settleConcurrentSpawnWaiters(executionId, { status: 'failed' });
    }
    if (this.taskArchiveListenerUnsub) {
      this.taskArchiveListenerUnsub();
      this.taskArchiveListenerUnsub = null;
    }
    for (const unsub of this.rateLimitListenerUnsubs) unsub();
    this.rateLimitListenerUnsubs = [];
    for (const unsub of this.activityListenerUnsubs) unsub();
    this.activityListenerUnsubs = [];
    const taskIds = Array.from(this.subSessions.keys());
    await Promise.allSettled(taskIds.map((taskId) => this.shutdownTask(taskId)));
    log.info(`TaskAgentManager: cleanupAll complete (${taskIds.length} tasks shut down)`);
  }

  private async shutdownTask(taskId: string): Promise<void> {
    const nodeMap = this.subSessions.get(taskId);
    if (nodeMap) {
      for (const [subSessionId, session] of nodeMap) {
        await this.stopSessionPreserveDb(subSessionId, session, {
          preserveDeliveryJobs: true,
        });
        this.agentSessionIndex.delete(subSessionId);
      }
      this.subSessions.delete(taskId);
    }

    this.taskWorktreePaths.delete(taskId);

    log.info(`TaskAgentManager: shutdown complete for task ${taskId} (DB state preserved)`);
  }

  listLiveSessionTaskIdsForSpace(spaceId: string): string[] {
    const prefix = `space:${spaceId}:task:`;
    const taskIds: string[] = [];
    for (const [taskId, nodeMap] of this.subSessions) {
      for (const subSessionId of nodeMap.keys()) {
        if (subSessionId.startsWith(prefix)) {
          taskIds.push(taskId);
          break;
        }
      }
    }
    return taskIds;
  }

  async cleanup(taskId: string, reason: 'done' | 'cancelled' | 'stopped' = 'done'): Promise<void> {
    const sessionIdsToClean = new Set<string>();

    const nodeMap = this.subSessions.get(taskId);
    if (nodeMap) {
      for (const [subSessionId, session] of nodeMap) {
        sessionIdsToClean.add(subSessionId);
        await this.stopSessionPreserveDb(subSessionId, session);
      }
      this.subSessions.delete(taskId);
      for (const sid of sessionIdsToClean) {
        this.agentSessionIndex.delete(sid);
      }
    }

    for (const sessionId of sessionIdsToClean) {
      this.completionCallbacks.delete(sessionId);
      const unsub = this.sessionListeners.get(sessionId);
      if (unsub) {
        unsub();
        this.sessionListeners.delete(sessionId);
      }
    }

    this.taskWorktreePaths.delete(taskId);

    log.info(
      `TaskAgentManager: cleaned up in-memory state for task ${taskId} (reason: ${reason}, DB + worktree preserved)`
    );
  }

  registerCompletionCallback(subSessionId: string, callback: () => Promise<void>): void {
    if (!this.completionCallbacks.has(subSessionId)) {
      this.completionCallbacks.set(subSessionId, []);
    }
    this.completionCallbacks.get(subSessionId)!.push(callback);

    if (this.sessionListeners.has(subSessionId)) return;

    let fired = false;

    const unsubscribeUpdated = this.config.internalEventBus.subscribe(
      'session.updated',
      (event) => {
        if (fired) return;
        if (!event.processingState) return;
        const status = event.processingState.status;

        if (status === 'idle') {
          const session = this.getSubSession(subSessionId);
          if (!session) return;

          const sdkCount = session.getSDKMessageCount();
          if (sdkCount === 0) return;

          fired = true;
          const unsub = this.sessionListeners.get(subSessionId);
          if (unsub) {
            unsub();
            this.sessionListeners.delete(subSessionId);
          }

          const callbacks = this.completionCallbacks.get(subSessionId) ?? [];
          this.completionCallbacks.delete(subSessionId);
          for (const cb of callbacks) {
            cb().catch((err) => {
              log.error(
                `TaskAgentManager: completion callback error for session ${subSessionId}:`,
                err
              );
            });
          }
        }
      },
      { sessionId: subSessionId, subscriberName: 'TaskAgentManager.subSessionCompletion' }
    );

    const unsubscribeError = this.config.internalEventBus.subscribe(
      'session.error',
      (event) => {
        if (fired) return;
        fired = true;

        void this.handleSubSessionError(subSessionId, event.error).catch((err) => {
          log.warn(
            `TaskAgentManager: failed to handle sub-session error for ${subSessionId}:`,
            err
          );
        });

        const unsub = this.sessionListeners.get(subSessionId);
        if (unsub) {
          unsub();
          this.sessionListeners.delete(subSessionId);
        }
      },
      { sessionId: subSessionId, subscriberName: 'TaskAgentManager.subSessionError' }
    );

    this.sessionListeners.set(subSessionId, () => {
      unsubscribeUpdated();
      unsubscribeError();
    });
  }

  private async handleSubSessionComplete(
    taskId: string,
    nodeId: string,
    subSessionId: string
  ): Promise<void> {
    log.info(
      `TaskAgentManager: sub-session complete — task ${taskId}, node ${nodeId}, session ${subSessionId}`
    );

    const workflowRunId = this.getWorkflowRunId(taskId);
    let execution = workflowRunId
      ? this.config.nodeExecutionRepo
          .listByWorkflowRun(workflowRunId)
          .find((candidate) => candidate.agentSessionId === subSessionId)
      : null;

    if (execution && execution.status === 'in_progress') {
      this.config.nodeExecutionRepo.update(execution.id, { status: 'idle' });
      execution = this.config.nodeExecutionRepo.getById(execution.id);
    }
  }

  private async handleSubSessionError(subSessionId: string, error: string): Promise<void> {
    const parentTaskId = this.findParentTaskIdForSubSession(subSessionId);
    if (!parentTaskId) return;

    const workflowRunId = this.getWorkflowRunId(parentTaskId);
    const failedExecution = workflowRunId
      ? this.config.nodeExecutionRepo
          .listByWorkflowRun(workflowRunId)
          .find((candidate) => candidate.agentSessionId === subSessionId)
      : null;
    if (failedExecution && !TERMINAL_NODE_EXECUTION_STATUSES.has(failedExecution.status)) {
      this.config.nodeExecutionRepo.update(failedExecution.id, {
        status: 'blocked',
        result: error,
      });
    }

    const failedNodeId = failedExecution?.workflowNodeId ?? 'unknown-node';
    log.warn(
      `TaskAgentManager: node "${failedNodeId}" sub-session (${subSessionId}) failed: ${error}. ` +
        `Execution marked blocked; runtime tick will handle escalation.`
    );
  }

  private buildNodeExecutionRuntimeContract(
    workflow: SpaceWorkflow | null,
    execution: NodeExecution,
    space: Space | null
  ): string {
    const isEndNode = this.isTerminalNode(workflow, execution.workflowNodeId);

    const spaceLevel = space?.autonomyLevel ?? 1;
    const requiredLevel = workflow?.completionAutonomyLevel ?? 5;
    const approveUnlocked = spaceLevel >= requiredLevel;

    const endNodeContractLines = (indent: string): string[] => {
      if (!isEndNode) return [];
      const lines: string[] = [];
      if (approveUnlocked) {
        lines.push(
          `${indent}- approve_task({}) — Close this task as done (self-approval). Unlocked for this space (autonomy ${spaceLevel} >= required ${requiredLevel}). Use as your FINAL action when you are satisfied the work is complete.`
        );
      } else {
        lines.push(
          `${indent}- approve_task({}) — NOT AVAILABLE: space autonomy ${spaceLevel} < workflow completionAutonomyLevel ${requiredLevel}. Do NOT call this tool; use submit_for_approval instead.`
        );
      }
      lines.push(
        `${indent}- submit_for_approval({ reason? }) — Request human sign-off. Always available to end-node agents. Use when autonomy blocks self-close OR the outcome is risky enough to escalate.`
      );
      return lines;
    };

    const fallback = [
      '## Runtime Execution Contract',
      `Role: "${execution.agentName}"`,
      'Tools available:',
      '  - send_message({ target, message, data? }) — communicate with peers; `data` is passed through to the target agent',
      '  - save_artifact({ shape, kind?, key?, summary?, data? }) — persist a STRUCTURED FACT as a generic shape (link/commit_set/check/metric/decision/note) with a freeform `kind` hint. Use shape="note" for rolling status, shape="decision" for verdicts/outcomes. Do not re-narrate the chat thread into artifacts.',
      ...endNodeContractLines('  '),
      '  - list_artifacts({ nodeId?, type? }) — list artifacts for the current workflow run',
      '  - restore_node_agent({ reason? }) — self-heal fallback: if a previous mcp__node-agent__* call returned "No such tool available", call this once and then retry the original tool',
      `Escalation: send_message({ target: "${WORKFLOW_ESCALATION_TARGET}", message }) requests human/space-level judgment (use for misrouted no-code tasks or hard blockers).`,
      'Only contact the task-agent via send_message if you are blocked or need human input.',
    ].join('\n');

    if (!workflow) {
      return fallback;
    }

    const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) {
      return fallback;
    }

    const lines: string[] = [
      '## Runtime Execution Contract',
      `Node: "${node.name}" (${node.id})`,
      `Agent: "${execution.agentName}"`,
      'Tools available:',
      '  - send_message({ target, message, data? }) — communicate with peers; `data` is passed through to the target agent',
      '  - save_artifact({ shape, kind?, key?, summary?, data? }) — persist a STRUCTURED FACT as a generic shape (link/commit_set/check/metric/decision/note) with a freeform `kind` hint. Use shape="note" for rolling status, shape="decision" for verdicts/outcomes.',
      '  - list_artifacts ({ nodeId?, type? }) — list artifacts for the current workflow run',
      '  - list_peers / list_reachable_agents — discovery',
      '  - restore_node_agent({ reason? }) — self-heal fallback: if a previous mcp__node-agent__* call ever returned "No such tool available", call this once and then retry the original tool',
    ];

    lines.push(
      `Escalation: send_message({ target: "${WORKFLOW_ESCALATION_TARGET}", message }) requests human/space-level judgment (use for misrouted no-code tasks or hard blockers).`
    );
    lines.push(
      'Only contact the task-agent via send_message if you are blocked or need human input.'
    );
    if (isEndNode) {
      if (approveUnlocked) {
        lines.push(
          'When your work is complete: (1) call save_artifact({ shape: "decision", key: "outcome", summary: "...", data: { recommendation: "completed" } }) to record the outcome, then (2) call approve_task({}) as your FINAL action to close the task. The runtime — not your artifact — decides the terminal status via completion actions.'
        );
      } else {
        lines.push(
          'When your work is complete: (1) call save_artifact({ shape: "decision", key: "outcome", summary: "...", data: { recommendation: "completed" } }) to record the outcome, then (2) call submit_for_approval({ reason: "..." }) as your FINAL action. approve_task is NOT available at this autonomy level; only a human can finalize.'
        );
      }
    }
    return lines.join('\n');
  }

  private agentNameVariants(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const variants = new Set<string>([trimmed]);
    const kebab = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (kebab) variants.add(kebab);
    return [...variants];
  }

  private isTerminalNode(
    workflow: SpaceWorkflow | null | undefined,
    workflowNodeId: string
  ): boolean {
    return isWorkflowTerminalNode(workflow, workflowNodeId);
  }

  private workflowNodeNameForRun(workflowRunId: string, workflowNodeId: string): string | null {
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run?.workflowId) return null;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    return workflow?.nodes.find((node) => node.id === workflowNodeId)?.name ?? null;
  }

  private slotResetsContextForSession(sessionId: string): boolean {
    const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
    if (!execution?.workflowRunId || !execution.workflowNodeId) return false;
    const run = this.config.workflowRunRepo.getRun(execution.workflowRunId);
    if (!run?.workflowId) return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    const node = workflow?.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) return false;
    let slots: WorkflowNodeAgent[];
    try {
      slots = resolveNodeAgents(node);
    } catch {
      return false;
    }
    const slot =
      slots.length === 1
        ? slots[0]
        : slots.find((candidate) => candidate.name === execution.agentName);
    return slot?.resetContextPerTurn === true;
  }

  reattachSlotContextReset(agentSession: AgentSession): void {
    const sessionId = agentSession.session.id;
    agentSession.slotResetsContext = () => this.slotResetsContextForSession(sessionId);
  }

  private buildAgentNameAliasesForExecution(
    workflow: SpaceWorkflow | null,
    execution: NodeExecution
  ): string[] {
    const aliases = new Set<string>(this.agentNameVariants(execution.agentName));
    if (!workflow) return [...aliases];

    const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) return [...aliases];

    if (node.name) {
      for (const variant of this.agentNameVariants(node.name)) {
        aliases.add(variant);
      }
    }

    const nodeAgents = resolveNodeAgents(node);
    const slot =
      nodeAgents.find((agent) => agent.name === execution.agentName) ??
      (execution.agentId
        ? nodeAgents.find((agent) => agent.agentId === execution.agentId)
        : undefined);
    if (slot?.name) {
      for (const variant of this.agentNameVariants(slot.name)) {
        aliases.add(variant);
      }
    }

    const spaceAgentId = execution.agentId ?? slot?.agentId;
    if (spaceAgentId) {
      const spaceAgent = this.config.spaceAgentManager.getById(spaceAgentId);
      if (spaceAgent?.name) {
        for (const variant of this.agentNameVariants(spaceAgent.name)) {
          aliases.add(variant);
        }
      }
    }

    return [...aliases];
  }

  private resolveSessionId(baseId: string): string {
    return findAvailableSessionId(baseId, (candidateId) =>
      Boolean(this.config.db.getSession(candidateId))
    );
  }

  private async rehydrateSubSessionsForRun(workflowRunId: string | null): Promise<void> {
    if (!workflowRunId) return;

    const parentTask = this.config.taskRepo.listByWorkflowRun(workflowRunId)[0];
    if (parentTask) {
      const space = await this.config.spaceManager.getSpace(parentTask.spaceId);
      if (space?.stopped) {
        log.info(
          `TaskAgentManager.rehydrateSubSessionsForRun: skipping run ${workflowRunId} because space ${parentTask.spaceId} is stopped`
        );
        return;
      }
    }

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
    for (const execution of executions) {
      const subSessionId = execution.agentSessionId;
      if (!subSessionId) continue;

      if (execution.status !== 'in_progress' && execution.status !== 'blocked') {
        if (!this.hasQueuedRetryableHookAction(workflowRunId, execution)) continue;
      }

      if (this.agentSessionIndex.has(subSessionId)) continue;

      try {
        await this.rehydrateSubSession(subSessionId);
      } catch (err) {
        log.warn(
          `TaskAgentManager.rehydrateSubSessionsForRun: failed to rehydrate sub-session ${subSessionId} ` +
            `(run=${workflowRunId}, exec=${execution.id}, agent=${execution.agentName}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private hasQueuedRetryableHookAction(workflowRunId: string, execution: NodeExecution): boolean {
    const task = this.config.taskRepo.listByWorkflowRun(workflowRunId)[0];
    if (!task || task.status === 'done' || task.status === 'cancelled') return false;
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run || run.status === 'done' || run.status === 'cancelled') return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    const hookStateRepo = new WorkflowHookStateRepository(this.config.db.getDatabase());
    for (const hook of workflow?.hooks ?? []) {
      const state = hookStateRepo.get(workflowRunId, hook.id)?.localState;
      const queued = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
      if (!queued || typeof queued !== 'object') continue;
      const meta = (queued as Record<string, unknown>).meta;
      if (!meta || typeof meta !== 'object') continue;
      const record = meta as Record<string, unknown>;
      if (
        record.sessionId === execution.agentSessionId &&
        record.agentName === execution.agentName &&
        record.nodeId === execution.workflowNodeId
      ) {
        return true;
      }
    }
    return false;
  }

  private sanitizeSDKSessionTranscriptForRehydration(
    agentSession: AgentSession,
    workspacePath: string
  ): void {
    const session = agentSession.getSessionData();
    if (!session.sdkSessionId) return;

    const result = sanitizeAssistantUsageInSDKSessionFile(workspacePath, session.sdkSessionId);
    if (!result.success) {
      log.warn(
        `TaskAgentManager.rehydrate: failed to sanitize SDK transcript for session ${session.id} ` +
          `(sdkSessionId=${session.sdkSessionId}): ${result.errors.join('; ')}`
      );
      return;
    }
    if (result.sanitizedCount > 0) {
      log.info(
        `TaskAgentManager.rehydrate: sanitized ${result.sanitizedCount} assistant message(s) ` +
          `in SDK transcript for session ${session.id}`
      );
    }
  }

  private async rehydrateSubSession(subSessionId: string): Promise<AgentSession | null> {
    const indexed = this.agentSessionIndex.get(subSessionId);
    if (indexed) return indexed;

    const inFlight = this.rehydrateInFlight.get(subSessionId);
    if (inFlight) return inFlight;

    const rehydrateTask = this.withSessionRestoreLock(subSessionId, () =>
      this.performSubSessionRehydrate(subSessionId)
    );
    this.rehydrateInFlight.set(subSessionId, rehydrateTask);
    try {
      return await rehydrateTask;
    } finally {
      if (this.rehydrateInFlight.get(subSessionId) === rehydrateTask) {
        this.rehydrateInFlight.delete(subSessionId);
      }
    }
  }

  private async performSubSessionRehydrate(subSessionId: string): Promise<AgentSession | null> {
    const alreadyIndexed = this.agentSessionIndex.get(subSessionId);
    if (alreadyIndexed) return alreadyIndexed;

    log.warn(`TaskAgentManager: rehydrating ghost sub-session ${subSessionId} from DB...`);

    const execution = this.resolveNodeExecutionForSubSession(subSessionId);
    if (!execution) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: no NodeExecution found with agentSessionId=${subSessionId}`
      );
      return null;
    }

    const tasks = this.config.taskRepo.listByWorkflowRunIncludingArchived(execution.workflowRunId);
    const parentTask = tasks[0] ?? null;
    if (!parentTask) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: no parent task found for workflowRunId=${execution.workflowRunId}`
      );
      return null;
    }

    const taskId = parentTask.id;
    const spaceId = parentTask.spaceId;

    if (
      parentTask.status === 'cancelled' ||
      parentTask.status === 'archived' ||
      parentTask.status === 'stopped'
    ) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: refusing to rehydrate session ${subSessionId} — parent task ${taskId} is ${parentTask.status}`
      );
      return null;
    }

    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: space ${spaceId} not found for task ${taskId}`
      );
      return null;
    }

    const workflowRun = this.config.workflowRunRepo.getRun(execution.workflowRunId);
    if (workflowRun?.status === 'cancelled') {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: refusing to rehydrate session ${subSessionId} — run ${execution.workflowRunId} is cancelled`
      );
      return null;
    }
    const workflow = workflowRun?.workflowId
      ? this.config.spaceWorkflowManager.getWorkflowForRun(workflowRun)
      : null;
    const workflowRunId = execution.workflowRunId;

    const cached = this.config.sessionManager.getCachedSession(subSessionId);
    const agentSession =
      cached ??
      AgentSession.restore(
        subSessionId,
        this.config.db,
        this.config.messageHub,
        this.config.internalEventBus,
        this.config.getApiKey,
        this.config.skillsManager,
        this.config.appMcpServerRepo,
        { autoReplayPendingMessages: false }
      );
    if (!agentSession) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: AgentSession.restore() returned null for ${subSessionId} — session not in DB`
      );
      return null;
    }

    const workspacePath =
      this.getTaskWorktreePath(taskId) ??
      agentSession.getSessionData().workspacePath ??
      space.workspacePath;

    const currentInit = this.resolveCurrentNodeAgentInitForExecution({
      task: parentTask,
      space,
      workflow,
      workflowRun,
      execution,
      sessionId: subSessionId,
      workspacePath,
    });
    if (currentInit?.systemPrompt) {
      agentSession.setRuntimeSystemPrompt(currentInit.systemPrompt);
    }

    const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
      taskId,
      subSessionId,
      execution.agentName,
      spaceId,
      workflowRunId,
      workspacePath,
      execution.workflowNodeId
    );

    const mergedMcpServers: Record<string, McpServerConfig> = {
      'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
      ...this.buildAgentMemoryMcpServers(spaceId, subSessionId),
    };

    agentSession.mergeRuntimeMcpServers(mergedMcpServers);

    const rehydrateCtx = {
      taskId,
      subSessionId,
      agentName: execution.agentName,
      spaceId,
      workflowRunId,
      workspacePath,
      workflowNodeId: execution.workflowNodeId,
    };

    await this.ensureNodeAgentAttached(agentSession, {
      ...rehydrateCtx,
      phase: 'rehydrate',
    });

    if (!this.subSessions.has(taskId)) {
      this.subSessions.set(taskId, new Map());
    }
    this.subSessions.get(taskId)!.set(subSessionId, agentSession);
    this.agentSessionIndex.set(subSessionId, agentSession);

    this.config.sessionManager.registerSession(agentSession);

    this.registerCompletionCallback(subSessionId, async () => {
      await this.handleSubSessionComplete(taskId, execution.workflowNodeId, subSessionId);
    });

    agentSession.onMissingWorkflowMcpServers = async (target: AgentSession, missing: string[]) => {
      await this.mcpSelfHeal(target, missing);
    };
    this.reattachSlotContextReset(agentSession);

    const pendingToolContinuations =
      this.config.toolContinuationRepo?.listPendingInboxForSession(subSessionId) ?? [];
    if (pendingToolContinuations.length > 0) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: session ${subSessionId} has ` +
          `${pendingToolContinuations.length} queued tool_result continuation(s); ` +
          `starting query only after runtime provisioning is complete`
      );
    }

    this.sanitizeSDKSessionTranscriptForRehydration(agentSession, workspacePath);

    try {
      await agentSession.startStreamingQuery();
      await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);
    } catch (err) {
      this.detachSessionBookkeeping(subSessionId);
      this.agentSessionIndex.delete(subSessionId);
      if (this.config.sessionManager.getCachedSession(subSessionId) === agentSession) {
        await this.config.sessionManager.unregisterSession(subSessionId).catch(() => {});
      }
      throw err;
    }

    void this.flushPendingMessagesForTarget(workflowRunId, execution.agentName, subSessionId).catch(
      (err) => {
        log.warn(
          `TaskAgentManager.rehydrateSubSession: flushPendingMessagesForTarget failed for ${execution.agentName} (session ${subSessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );

    log.info(
      `TaskAgentManager.rehydrateSubSession: rehydrated sub-session ${subSessionId} for task ${taskId} (node ${execution.workflowNodeId})`
    );

    return agentSession;
  }

  private resolveCurrentNodeAgentInitForExecution(args: {
    task: SpaceTask;
    space: Space;
    workflow: SpaceWorkflow | null;
    workflowRun: SpaceWorkflowRun | null;
    execution: NodeExecution;
    sessionId: string;
    workspacePath: string;
  }): AgentSessionInit | null {
    const { task, space, workflow, workflowRun, execution, sessionId, workspacePath } = args;
    const node = workflow?.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: workflow node ${execution.workflowNodeId} ` +
          `not found for session ${sessionId}; keeping persisted system prompt`
      );
      return null;
    }

    const nodeAgents = resolveNodeAgents(node);
    const slot =
      nodeAgents.length === 1
        ? nodeAgents[0]
        : nodeAgents.find((agentSlot) => agentSlot.name === execution.agentName);
    if (!slot?.agentId) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: no agent slot found for agent ${execution.agentName} ` +
          `in node ${execution.workflowNodeId}; keeping persisted system prompt`
      );
      return null;
    }

    return resolveAgentInit({
      task,
      space,
      agentManager: this.config.spaceAgentManager,
      sessionId,
      workspacePath,
      workflowRun,
      workflow,
      slotOverrides: buildSlotOverrides(slot, {
        task,
        node,
        workflow: workflow ?? undefined,
        workflowRun: workflowRun ?? undefined,
      }),
      agentId: slot.agentId,
    });
  }

  private resolveNodeExecutionForSubSession(subSessionId: string): NodeExecution | null {
    const bySessionId = this.config.nodeExecutionRepo.listByAgentSessionId(subSessionId);
    const embeddedExecutionId = this.parseExecutionIdFromSubSessionId(subSessionId);
    const embedded = embeddedExecutionId
      ? this.config.nodeExecutionRepo.getById(embeddedExecutionId)
      : null;

    if (embedded && !embedded.agentSessionId) {
      const repaired = this.config.nodeExecutionRepo.updateSessionId(embedded.id, subSessionId);
      if (repaired) {
        log.warn(
          `TaskAgentManager.resolveNodeExecutionForSubSession: repaired missing agent_session_id ` +
            `for execution ${embedded.id} from sub-session id ${subSessionId}`
        );
        return this.pickBestNodeExecution([repaired, ...bySessionId]);
      }
    }

    const candidates =
      embedded?.agentSessionId === subSessionId ? [embedded, ...bySessionId] : bySessionId;
    return this.pickBestNodeExecution(candidates);
  }

  private parseExecutionIdFromSubSessionId(subSessionId: string): string | null {
    const marker = ':exec:';
    const markerIndex = subSessionId.indexOf(marker);
    if (markerIndex === -1) return null;
    const rest = subSessionId.slice(markerIndex + marker.length);
    const executionId = rest.split(':')[0];
    return executionId || null;
  }

  private pickBestNodeExecution(candidates: NodeExecution[]): NodeExecution | null {
    if (candidates.length === 0) return null;
    const statusRank = (execution: NodeExecution): number => {
      switch (execution.status) {
        case 'in_progress':
          return 0;
        case 'blocked':
          return 1;
        case 'pending':
          return 2;
        default:
          return 3;
      }
    };
    return [...candidates].sort((a, b) => {
      const rankDiff = statusRank(a) - statusRank(b);
      if (rankDiff !== 0) return rankDiff;
      const updatedDiff = b.updatedAt - a.updatedAt;
      if (updatedDiff !== 0) return updatedDiff;
      return b.createdAt - a.createdAt;
    })[0]!;
  }

  private async replayPendingMessagesAfterRuntimeProvisioning(
    session: AgentSession
  ): Promise<void> {
    const replay = (
      session as AgentSession & {
        replayPendingMessagesForImmediateMode?: () => Promise<void>;
      }
    ).replayPendingMessagesForImmediateMode;
    if (typeof replay === 'function') {
      await replay.call(session);
    }
  }

  private hasActiveDeliveryJob(sessionId: string): boolean {
    return this.config.db.getJobQueueRepo().activeDeliveryMessageUuids(sessionId).size > 0;
  }

  private hasUnconsumedDeliveredWork(sessionId: string, excludeMessageId?: string): boolean {
    return (['enqueued', 'deferred'] as const).some((status) =>
      this.config.db
        .getUserMessageIdsByStatus(sessionId, status)
        .some(
          (row) =>
            typeof row.uuid === 'string' && row.uuid.length > 0 && row.uuid !== excludeMessageId
        )
    );
  }

  private clearStillBlocked(session: AgentSession): boolean {
    const state = session.getProcessingState();
    if (
      state.status === 'processing' ||
      state.status === 'queued' ||
      state.status === 'waiting_for_input' ||
      state.status === 'interrupted' ||
      state.status === 'rate_limit_cooldown'
    ) {
      return true;
    }
    return this.hasActiveDeliveryJob(session.session.id);
  }

  private async injectMessageIntoSession(
    session: AgentSession,
    message: string,
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    origin?: MessageOrigin,
    isSyntheticMessage = true,
    images?: MessageImage[],
    inputKind: MessageInputKind = 'task',
    explicitMessageId?: string
  ): Promise<string> {
    const sessionId = session.session.id;
    const state = session.getProcessingState();
    const isBusy =
      state.status === 'processing' ||
      state.status === 'queued' ||
      state.status === 'waiting_for_input' ||
      state.status === 'interrupted' ||
      state.status === 'rate_limit_cooldown';

    const messageId = explicitMessageId ?? generateUUID();
    const hasImages = !!images && images.length > 0;
    if (hasImages) {
      validateImageSizes(images!);
    }
    const sdkContent: MessageContent[] = hasImages
      ? [
          ...images!.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.media_type,
              data: img.data,
            },
          })),
          { type: 'text' as const, text: message },
        ]
      : [{ type: 'text' as const, text: message }];

    const sdkUserMessage: SDKUserMessage & { isSynthetic: boolean; inputKind: MessageInputKind } = {
      type: 'user' as const,
      uuid: messageId as UUID,
      session_id: sessionId,
      parent_tool_use_id: null,
      isSynthetic: isSyntheticMessage,
      inputKind,
      message: {
        role: 'user' as const,
        content: sdkContent,
      },
    };

    const v2Enabled = isMessageDeliveryV2Enabled();
    const existing = v2Enabled
      ? this.config.db.getSDKMessageRepo().getDeliveryContent(sessionId, messageId)
      : null;
    const inRateLimitCooldown = state.status === 'rate_limit_cooldown';
    const parentTaskId = this.findParentTaskIdForSubSession(sessionId);
    const parentTask = parentTaskId ? this.config.taskRepo.getTask(parentTaskId) : null;
    const parentLimited = parentTask ? isRateOrUsageLimited(parentTask.status) : false;
    const outcome = decideInjectDelivery({
      existingSendStatus: existing?.sendStatus ?? null,
      deliveryMode,
      isBusy,
      inRateLimitCooldown,
      parentTaskLimited: parentLimited,
      inputKind,
      hasPriorContext: !!session.session.sdkSessionId,
      slotResetsContext: this.slotResetsContextForSession(sessionId),
      hasActiveDeliveryJob: this.hasActiveDeliveryJob(sessionId),
      hasUnconsumedDeliveredWork: this.hasUnconsumedDeliveredWork(sessionId, messageId),
    });

    const deliveryRows = this.injectDeliveryRowDeps();

    if (outcome.decision.action === 'noop') {
      return messageId;
    }
    if (outcome.decision.action === 'defer') {
      if (outcome.reopenFailedDelivery) {
        await reopenFailedDeliveryRow(deliveryRows, sessionId, messageId);
      }
      if (v2Enabled && existing && existing.sendStatus !== 'deferred') {
        this.config.db.getSDKMessageRepo().markDeliveryDeferredByUuid(sessionId, messageId);
      }
      const deferredDbId = await settleDeliveryRowStatus(deliveryRows, {
        sessionId,
        message: sdkUserMessage,
        messageId,
        rowExists: !!existing,
        status: 'deferred',
        origin,
      });
      const capFold = await this.enforceDeferredExternalEventCap(sessionId, message);
      const supersededThisRow =
        capFold !== null && capFold.supersededUuids.includes(String(messageId));
      if (capFold) {
        this.pruneSupersededDirectSteerEntries(sessionId, capFold.supersededUuids);
      }
      if (!supersededThisRow) {
        this.maybeBufferDirectSteer({
          sessionId,
          messageId,
          deferredDbId,
          messageText: message,
          processingStatus: state.status,
          inRateLimitCooldown,
          parentTaskLimited: parentLimited,
          inputKind,
          isSynthetic: isSyntheticMessage,
        });
      }
      if (capFold) {
        this.maybeBufferDirectSteer({
          sessionId,
          messageId: String(capFold.envelopeMessage.uuid),
          deferredDbId: capFold.envelopeDbId,
          messageText: capFold.envelopeText,
          processingStatus: state.status,
          inRateLimitCooldown,
          parentTaskLimited: parentLimited,
          inputKind,
          isSynthetic: isSyntheticMessage,
        });
      }
      return deferredDbId;
    }
    if (
      outcome.decision.action === 'clear_before_deliver' &&
      !this.hasActiveDeliveryJob(sessionId)
    ) {
      try {
        await session.clearConversationContext();
      } catch (err) {
        if (err instanceof ClearConversationCancelledError) {
          throw err;
        }
        log.warn(
          `TaskAgentManager: resetContextPerTurn clear failed for session ${sessionId}: ` +
            `${err instanceof Error ? err.message : String(err)} — delivering without clear`
        );
      }
    }

    if (outcome.reopenFailedDelivery) {
      await reopenFailedDeliveryRow(deliveryRows, sessionId, messageId);
    }

    if (!isBusy) {
      const clearSuppressedByPendingWork =
        outcome.decision.action === 'deliver_without_clear' &&
        outcome.decision.reason === 'unconsumed_work_pending';
      let clearedUpstream = false;
      let backlogReplayFailed = false;
      const sendEnqueued = (
        session as AgentSession & {
          sendEnqueuedMessagesOnTurnEnd?: (options?: {
            pendingTaskInput?: boolean;
            skipResetCoordination?: boolean;
          }) => Promise<{ replayedWork: boolean; clearedContext: boolean; replayFailed: boolean }>;
        }
      ).sendEnqueuedMessagesOnTurnEnd;
      if (clearSuppressedByPendingWork && typeof sendEnqueued === 'function') {
        const replayed = await sendEnqueued.call(session, {
          pendingTaskInput: true,
          skipResetCoordination: true,
        });
        clearedUpstream = replayed.clearedContext;
        backlogReplayFailed = replayed.replayFailed;
      }
      const replay = await session.handleQueryTrigger({
        deliverIndividually: true,
        excludeMessageUuid: messageId,
        skipResetCoordination: true,
        skipContextReset: clearedUpstream,
        pendingTaskInput: clearSuppressedByPendingWork && !clearedUpstream,
      });
      if (!replay.success) {
        log.warn(
          `TaskAgentManager: deferred backlog replay for session ${sessionId} failed: ` +
            `${replay.error ?? 'unknown error'} — delivering current message only`
        );
      }
      if (
        clearSuppressedByPendingWork &&
        !clearedUpstream &&
        (backlogReplayFailed || !replay.success || this.clearStillBlocked(session))
      ) {
        if (existing) {
          const flippedDbId = await flipDeliveryRowToDeferred(deliveryRows, sessionId, messageId);
          return flippedDbId ?? messageId;
        }
        return settleDeliveryRowStatus(deliveryRows, {
          sessionId,
          message: sdkUserMessage,
          messageId,
          rowExists: false,
          status: 'deferred',
          origin,
        });
      }
    }

    return deliverInjectedMessage(
      { ...deliveryRows, jobQueue: this.config.db.getJobQueueRepo() },
      {
        session,
        sessionId,
        messageId,
        sdkUserMessage,
        enqueuePayload: hasImages ? sdkContent : message,
        deliveryV2Enabled: v2Enabled,
        rowExists: !!existing,
        origin,
      }
    );
  }

  private async enforceDeferredExternalEventCap(
    sessionId: string,
    deferredMessageText: string
  ): Promise<DeferredEventOverflowFoldResult | null> {
    if (!parseDeferredExternalEventText(deferredMessageText)) return null;
    const { messages } = this.config.db.getUserMessagesByStatus(sessionId, 'deferred');
    const capFold = await foldDeferredExternalEventOverflow({
      sessionId,
      rows: messages,
      cap: DEFERRED_EXTERNAL_EVENT_ROW_CAP,
      ops: {
        findByUuid: async (uuid) => {
          const repo = this.config.db.getSDKMessageRepo();
          return (
            repo.getMessageByStatusAndUuid(sessionId, 'deferred', uuid) ??
            repo.getMessageByStatusAndUuid(sessionId, 'enqueued', uuid)
          );
        },
        saveRow: async (message, sendStatus) => {
          const dbId = this.config.db.saveUserMessage(sessionId, message, sendStatus);
          await this.publishMessageStatusChanged(sessionId, dbId, sendStatus);
          return dbId;
        },
        markSuperseded: async (dbIds) => {
          this.config.db.updateMessageStatus(dbIds, 'consumed');
          await this.config.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: dbIds,
              status: 'consumed',
            })
            .catch(() => {});
        },
      },
    });
    if (capFold) {
      log.warn(
        `TaskAgentManager: deferred external-event backlog exceeded ` +
          `${DEFERRED_EXTERNAL_EVENT_ROW_CAP} for session ${sessionId}; folded ` +
          `${capFold.foldedRows} oldest rows into an early digest`
      );
    }
    return capFold;
  }

  private pruneSupersededDirectSteerEntries(sessionId: string, supersededUuids: string[]): void {
    if (supersededUuids.length === 0) return;
    const gone = new Set(supersededUuids);
    for (const [key, entries] of this.directSteerBuffers) {
      if (!key.startsWith(`${sessionId}\u0000`)) continue;
      const kept = entries.filter((entry) => !gone.has(entry.messageId));
      if (kept.length === entries.length) continue;
      if (kept.length === 0) this.directSteerBuffers.delete(key);
      else this.directSteerBuffers.set(key, kept);
    }
  }

  private maybeBufferDirectSteer(args: {
    sessionId: string;
    messageId: string;
    deferredDbId: string;
    messageText: string;
    processingStatus: string;
    inRateLimitCooldown: boolean;
    parentTaskLimited: boolean;
    inputKind: MessageInputKind;
    isSynthetic: boolean;
  }): void {
    const parsed = parseDeferredExternalEventText(args.messageText);
    if (!parsed) return;
    const droppedEventCount = parsed.kind === 'fold' ? parsed.droppedCount : undefined;
    const essences = deferredExternalEventEntryEvents(parsed);
    const admission = decideExternalEventSteerAdmission({
      deliveryV2Enabled: isMessageDeliveryV2Enabled(),
      isSynthetic: args.isSynthetic,
      inputKind: args.inputKind,
      processingStatus: args.processingStatus,
      inRateLimitCooldown: args.inRateLimitCooldown,
      parentTaskLimited: args.parentTaskLimited,
      essences,
      ...(droppedEventCount ? { droppedEventCount } : {}),
      bufferedDirectEventCount: this.sessionBufferedDirectEventCount(args.sessionId),
      bufferMaxEntries: DIRECT_STEER_BUFFER_MAX_ENTRIES,
      hydrate: (essence: ExternalEventEssenceEntry) => this.hydrateDirectSteerEssence(essence),
    });
    const decision = admission.decision;
    if (decision === null) return;
    if (decision.action === 'suppressBufferCap') {
      this.config.spaceRuntimeService?.queueHealthMetrics?.recordDirectSteerSuppressedByBufferCap();
      log.warn(
        `TaskAgentManager: direct steer buffer for session ${args.sessionId} at its ` +
          `${DIRECT_STEER_BUFFER_MAX_ENTRIES}-event capacity; event stays deferred`
      );
      return;
    }
    if (decision.action !== 'admit') return;
    const { eventClass, droppedEventCount: admittedDropped } = decision;
    const settledRow = this.config.db
      .getSDKMessageRepo()
      .getMessageByStatusAndUuid(args.sessionId, 'deferred', args.messageId);
    const claimDbId = settledRow?.dbId ?? args.deferredDbId;
    const key = directSteerBufferKey(args.sessionId, eventClass);
    const buffer = this.directSteerBuffers.get(key) ?? [];
    if (buffer.some((item) => item.messageId === args.messageId)) return;
    const now = Date.now();
    buffer.push({
      essences: decision.essences,
      messageId: args.messageId,
      dbId: claimDbId,
      receivedAt: now,
      ...(admittedDropped ? { droppedEventCount: admittedDropped } : {}),
    });
    this.directSteerBuffers.set(key, buffer);
    if (!this.directSteerBurstStarts.has(key)) this.directSteerBurstStarts.set(key, now);
    this.armDirectSteerTimer(key);
  }

  private sessionBufferedDirectEventCount(sessionId: string): number {
    let total = 0;
    for (const [key, entries] of this.directSteerBuffers) {
      if (!key.startsWith(`${sessionId}\u0000`)) continue;
      total += entries.reduce(
        (sum, item) =>
          sum +
          item.essences.filter((essence) => classifyExternalEventDirectSteer(essence) !== null)
            .length,
        0
      );
    }
    return total;
  }

  private hydrateDirectSteerEssence(essence: ExternalEventEssenceEntry): ExternalEventEssenceEntry {
    if (this.directSteerEssenceHydrated(essence) || !this.config.externalEventStore) {
      return essence;
    }
    const record = this.config.externalEventStore.getById(essence.eventId);
    const payload = record?.event.payload;
    if (!record || !payload) return essence;
    const hydrated: Record<string, unknown> = { ...essence };
    let changed = false;
    if (hydrated.occurredAt === undefined && typeof record.event.occurredAt === 'number') {
      hydrated.occurredAt = record.event.occurredAt;
      changed = true;
    }
    if (hydrated.externalUrl === undefined && typeof record.event.externalUrl === 'string') {
      hydrated.externalUrl = record.event.externalUrl;
      changed = true;
    }
    for (const field of DIRECT_STEER_HYDRATABLE_FIELDS) {
      if (hydrated[field] !== undefined) continue;
      const value = payload[field];
      if (
        (typeof value === 'string' && value.length > 0) ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        hydrated[field] = value;
        changed = true;
      }
    }
    return changed ? (hydrated as unknown as ExternalEventEssenceEntry) : essence;
  }

  private directSteerEssenceHydrated(essence: ExternalEventEssenceEntry): boolean {
    return DIRECT_STEER_HYDRATABLE_FIELDS.every((field) => essence[field] !== undefined);
  }

  private armDirectSteerTimer(key: string): void {
    const burstStart = this.directSteerBurstStarts.get(key);
    if (burstStart === undefined) return;
    const delay = Math.min(
      this.directSteerDebounceMs,
      Math.max(0, this.directSteerMaxBurstWaitMs - (Date.now() - burstStart))
    );
    const existing = this.directSteerTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.directSteerTimers.delete(key);
      void this.flushDirectSteerBuffer(key).catch((err) => {
        log.warn(
          `TaskAgentManager: direct steer flush failed for session ${key.split('\u0000')[0]}: ` +
            `${err instanceof Error ? err.message : String(err)}; rows stay deferred`
        );
      });
    }, delay);
    this.directSteerTimers.set(key, timer);
  }

  private async flushDirectSteerBuffer(key: string): Promise<void> {
    const entries = this.directSteerBuffers.get(key) ?? [];
    this.directSteerBuffers.delete(key);
    this.directSteerBurstStarts.delete(key);
    const pendingTimer = this.directSteerTimers.get(key);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.directSteerTimers.delete(key);
    }
    if (entries.length === 0) return;
    const separator = key.indexOf('\u0000');
    const sessionId = key.slice(0, separator);
    await withSessionResetCoordination(sessionId, async () => {
      await this.deliverDirectSteerUnderCoordination(sessionId, entries);
    });
  }

  private directSteerSkipLogMessage(sessionId: string, reason: DirectSteerSkipReason): string {
    const messages: Record<DirectSteerSkipReason, string> = {
      session_not_tracked: `skipping direct steer — session ${sessionId} no longer tracked; rows stay deferred`,
      session_not_processing: `skipping direct steer for session ${sessionId} — no longer processing at flush time; rows stay deferred for turn-end delivery`,
      parent_task_limited: `skipping direct steer for session ${sessionId} — parent task became rate/usage-limited while the burst was pending; rows stay deferred`,
      no_deferred_rows: `direct steer for session ${sessionId} found no still-deferred rows (turn likely ended first); rows already flushed`,
      no_direct_events: `direct steer for session ${sessionId} has no direct-class events after filtering; rows stay deferred`,
    };
    return `TaskAgentManager: ${messages[reason]}`;
  }

  private buildDirectSteerFlushDeps(): DirectSteerFlushDeps {
    return {
      getSessionTracked: (sessionId) => this.getTrackedSession(sessionId) !== null,
      getSessionProcessing: (sessionId) =>
        this.getTrackedSession(sessionId)?.getProcessingState().status === 'processing',
      isParentTaskLimited: (sessionId) => this.parentTaskLimitedForSession(sessionId),
      getDeferredUuids: (sessionId) => {
        const { messages: deferredRows } = this.config.db.getUserMessagesByStatus(
          sessionId,
          'deferred'
        );
        return new Set(deferredRows.map((row) => String(row.uuid)));
      },
      savePassenger: async (sessionId, message) => {
        const dbId = this.config.db.saveUserMessage(sessionId, message, 'deferred');
        await this.publishMessageStatusChanged(sessionId, dbId, 'deferred');
        return dbId;
      },
      discardPassenger: async (sessionId, dbId) => {
        if (!dbId) return;
        this.config.db.updateMessageStatus([dbId], 'consumed');
        await this.config.internalEventBus
          .publish('messages.statusChanged', {
            sessionId,
            messageIds: [dbId],
            status: 'consumed',
          })
          .catch(() => {});
      },
      saveSteer: (sessionId, message) =>
        this.config.db.saveUserMessage(sessionId, message, 'enqueued'),
      discardSteer: async (sessionId, messageId) => {
        const failedDbId = this.config.db
          .getSDKMessageRepo()
          .markDeliveryFailedByUuid(sessionId, messageId);
        if (failedDbId) await this.publishMessageStatusChanged(sessionId, failedDbId, 'failed');
      },
      enqueueSteer: (sessionId, messageId) => {
        deliverMessage(this.config.db.getJobQueueRepo(), sessionId, messageId, {
          origin: 'space_inject',
          role: 'steer',
        });
      },
      consumeSources: (_sessionId, dbIds) => {
        this.config.db.updateMessageStatus(dbIds, 'consumed');
      },
      recordHealthMetrics: (steeredClasses) => {
        this.config.spaceRuntimeService?.queueHealthMetrics?.recordDirectSteerEnqueued();
        for (const eventClass of steeredClasses) {
          this.config.spaceRuntimeService?.queueHealthMetrics?.recordDirectSteerEnqueuedClass(
            eventClass
          );
        }
      },
      publishStatusChanged: (sessionId, dbId, status) =>
        this.publishMessageStatusChanged(
          sessionId,
          dbId,
          status as 'enqueued' | 'deferred' | 'failed'
        ),
      publishStatusesChanged: async (sessionId, dbIds, status) => {
        await this.config.internalEventBus
          .publish('messages.statusChanged', {
            sessionId,
            messageIds: dbIds,
            status,
          })
          .catch(() => {});
      },
    };
  }

  private async deliverDirectSteerUnderCoordination(
    sessionId: string,
    entries: DirectSteerBufferEntry[]
  ): Promise<void> {
    const outcome = await runDirectSteerFlush(this.buildDirectSteerFlushDeps(), {
      sessionId,
      entries,
      snippetMaxChars: DIRECT_STEER_SNIPPET_MAX_CHARS,
    });
    if (outcome.action === 'skip') {
      log.debug(this.directSteerSkipLogMessage(sessionId, outcome.reason));
      return;
    }

    if (outcome.action === 'failed') {
      log.warn(
        `TaskAgentManager: direct steer flush failed for session ${sessionId} at stage ` +
          `${outcome.stage}: ` +
          `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}; ` +
          `rows stay deferred`
      );
      return;
    }

    log.info(
      `TaskAgentManager: injected direct steer for session ${sessionId} covering ` +
        `${outcome.eventCount} event(s) across ${outcome.steerableCount} row(s)`
    );
  }
  private parentTaskLimitedForSession(sessionId: string): boolean {
    const parentTaskId = this.findParentTaskIdForSubSession(sessionId);
    const parentTask = parentTaskId ? this.config.taskRepo.getTask(parentTaskId) : null;
    return parentTask ? isRateOrUsageLimited(parentTask.status) : false;
  }

  private getTrackedSession(sessionId: string): AgentSession | null {
    const indexed = this.agentSessionIndex.get(sessionId);
    if (indexed) return indexed;
    for (const [, nodeMap] of this.subSessions) {
      const session = nodeMap.get(sessionId);
      if (session) return session;
    }
    return null;
  }

  private clearDirectSteerState(): void {
    for (const timer of this.directSteerTimers.values()) clearTimeout(timer);
    this.directSteerTimers.clear();
    this.directSteerBuffers.clear();
    this.directSteerBurstStarts.clear();
  }

  private injectDeliveryRowDeps(): InjectionDeliveryRowDeps {
    return {
      publishStatusChanged: (sessionId, dbId, status) =>
        this.publishMessageStatusChanged(sessionId, dbId, status),
      saveUserMessage: (sessionId, message, sendStatus, origin) =>
        this.config.db.saveUserMessage(sessionId, message, sendStatus, origin),
      reopenDeliveryByUuid: (sessionId, uuid) =>
        this.config.db.getSDKMessageRepo().reopenDeliveryByUuid(sessionId, uuid),
      markDeliveryDeferredByUuid: (sessionId, uuid) =>
        this.config.db.getSDKMessageRepo().markDeliveryDeferredByUuid(sessionId, uuid),
      markDeliveryFailedByUuid: (sessionId, uuid) =>
        this.config.db.getSDKMessageRepo().markDeliveryFailedByUuid(sessionId, uuid),
    };
  }

  private async publishMessageStatusChanged(
    sessionId: string,
    dbId: string,
    status: 'enqueued' | 'deferred' | 'failed'
  ): Promise<void> {
    await this.config.internalEventBus
      .publish('messages.statusChanged', {
        sessionId,
        messageIds: [dbId],
        status,
      })
      .catch(() => {});
  }

  private async stopSessionPreserveDb(
    sessionId: string,
    session: AgentSession,
    options: { strict?: boolean; preserveDeliveryJobs?: boolean } = {}
  ): Promise<void> {
    const unsub = this.sessionListeners.get(sessionId);
    if (!options.strict && unsub) {
      unsub();
      this.sessionListeners.delete(sessionId);
    }
    if (!options.strict) {
      this.completionCallbacks.delete(sessionId);
    }

    let stopError: unknown;
    try {
      await session.handleInterrupt({
        ...(options.preserveDeliveryJobs ? { preserveDeliveryJobs: true } : {}),
        skipDeferredReplay: true,
      });
    } catch (err) {
      stopError = err;
      log.warn(`TaskAgentManager: failed to interrupt session ${sessionId}:`, err);
    }

    try {
      await session.cleanup();
    } catch (err) {
      stopError = stopError ?? err;
      log.warn(`TaskAgentManager: failed to cleanup session ${sessionId}:`, err);
    }

    if (options.strict && stopError) {
      throw new Error(
        `Failed to stop session ${sessionId}: ${stopError instanceof Error ? stopError.message : String(stopError)}`
      );
    }

    if (options.strict && unsub) {
      unsub();
      this.sessionListeners.delete(sessionId);
      this.completionCallbacks.delete(sessionId);
    }
  }

  private getWorkflowRunId(taskId: string): string | null {
    const task = this.config.taskRepo.getTask(taskId);
    return task?.workflowRunId ?? null;
  }

  private findParentTaskIdForSubSession(subSessionId: string): string | null {
    for (const [taskId, nodeMap] of this.subSessions) {
      if (nodeMap.has(subSessionId)) {
        return taskId;
      }
    }
    return null;
  }

  private static readonly REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS = ['node-agent'] as const;

  requiredWorkflowSubSessionMcpServers(): string[] {
    return this.config.memoryRepo
      ? [...TaskAgentManager.REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS, 'agent-memory']
      : [...TaskAgentManager.REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS];
  }

  async ensureNodeAgentAttached(
    session: AgentSession,
    ctx: {
      taskId: string;
      subSessionId: string;
      agentName: string;
      spaceId: string;
      workflowRunId: string;
      workspacePath: string;
      workflowNodeId: string;
      phase: 'spawn' | 'rehydrate';
    }
  ): Promise<void> {
    const currentMcpServers =
      (session.session.config?.mcpServers as Record<string, McpServerConfig> | undefined) ?? {};

    const required = this.requiredWorkflowSubSessionMcpServers();
    const missing = required.filter((name) => !currentMcpServers[name]);

    if (missing.length === 0) {
      log.debug(
        `TaskAgentManager.ensureNodeAgentAttached: all required MCP servers present on session ${ctx.subSessionId} (phase=${ctx.phase}): [${required.join(', ')}]`
      );
      return;
    }

    log.error(
      `TaskAgentManager.ensureNodeAgentAttached: required MCP servers MISSING on workflow sub-session ${ctx.subSessionId} ` +
        `(task=${ctx.taskId}, agent=${ctx.agentName}, phase=${ctx.phase}). ` +
        `Missing: [${missing.join(', ')}]. ` +
        `Visible servers: [${Object.keys(currentMcpServers).sort().join(', ')}]. ` +
        `Self-healing by re-injecting before first turn — but this indicates a regression in the spawn/rehydrate merge logic.`
    );

    for (const name of missing) {
      if (name === 'node-agent') {
        await this.reinjectNodeAgentMcpServer(session, ctx);
      } else if (name === 'agent-memory') {
        await this.reinjectAgentMemoryMcpServer(session, ctx);
      }
    }

    const verifyMcpServers =
      (session.session.config?.mcpServers as Record<string, McpServerConfig> | undefined) ?? {};
    const stillMissing = required.filter((name) => !verifyMcpServers[name]);
    if (stillMissing.length > 0) {
      throw new Error(
        `TaskAgentManager.ensureNodeAgentAttached: failed to re-attach required MCP servers [${stillMissing.join(', ')}] to session ${ctx.subSessionId} after self-heal attempt`
      );
    }
    log.info(
      `TaskAgentManager.ensureNodeAgentAttached: successfully re-attached MCP servers [${missing.join(', ')}] to session ${ctx.subSessionId} (phase=${ctx.phase})`
    );
  }

  async mcpSelfHeal(target: AgentSession, missing: string[]): Promise<void> {
    const sessionId = target.getSessionData().id;
    log.warn(
      `TaskAgentManager.mcpSelfHeal: triggered for session ${sessionId}, missing [${missing.join(', ')}]`
    );

    const execution = this.resolveNodeExecutionForSubSession(sessionId);
    if (!execution) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: no NodeExecution found for agentSessionId=${sessionId} — cannot self-heal`
      );
      return;
    }

    const tasks = this.config.taskRepo.listByWorkflowRun(execution.workflowRunId);
    const parentTask = tasks[0] ?? null;
    if (!parentTask) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: no parent task found for workflowRunId=${execution.workflowRunId} — cannot self-heal`
      );
      return;
    }
    const space = await this.config.spaceManager.getSpace(parentTask.spaceId);
    if (!space) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: space ${parentTask.spaceId} not found for task ${parentTask.id} — cannot self-heal`
      );
      return;
    }

    const agentSession = target;
    if (this.agentSessionIndex.get(sessionId) !== agentSession) {
      const displaced = this.agentSessionIndex.get(sessionId);
      log.warn(
        `TaskAgentManager.mcpSelfHeal: adopting the started session instance for ${sessionId} ` +
          `as the canonical in-memory sub-session before healing`
      );
      if (displaced) {
        this.detachSessionBookkeeping(sessionId);
        void displaced.handleInterrupt({ skipDeferredReplay: true }).catch((err) => {
          log.warn(
            `TaskAgentManager.mcpSelfHeal: failed to interrupt displaced session instance ` +
              `${sessionId}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
      if (!this.subSessions.has(parentTask.id)) {
        this.subSessions.set(parentTask.id, new Map());
      }
      this.subSessions.get(parentTask.id)!.set(sessionId, agentSession);
      this.agentSessionIndex.set(sessionId, agentSession);
      this.config.sessionManager.registerSession(agentSession);
      this.reattachSlotContextReset(agentSession);
      this.registerCompletionCallback(sessionId, async () => {
        await this.handleSubSessionComplete(parentTask.id, execution.workflowNodeId, sessionId);
      });
    }

    await this.ensureRequiredMcpServersAttached(agentSession, {
      taskId: parentTask.id,
      subSessionId: sessionId,
      agentName: execution.agentName,
      spaceId: parentTask.spaceId,
      workflowRunId: execution.workflowRunId,
      workspacePath:
        this.getTaskWorktreePath(parentTask.id) ??
        agentSession.getSessionData().workspacePath ??
        space.workspacePath,
      workflowNodeId: execution.workflowNodeId,
      phase: 'rehydrate',
    });
  }

  async ensureRequiredMcpServersAttached(
    session: AgentSession,
    ctx: {
      taskId: string;
      subSessionId: string;
      agentName: string;
      spaceId: string;
      workflowRunId: string;
      workspacePath: string;
      workflowNodeId: string;
      phase: 'spawn' | 'rehydrate';
    }
  ): Promise<void> {
    return this.ensureNodeAgentAttached(session, ctx);
  }

  async reinjectNodeAgentMcpServer(
    session: AgentSession,
    ctx: {
      taskId: string;
      subSessionId: string;
      agentName: string;
      spaceId: string;
      workflowRunId: string;
      workspacePath: string;
      workflowNodeId: string;
    }
  ): Promise<void> {
    const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
      ctx.taskId,
      ctx.subSessionId,
      ctx.agentName,
      ctx.spaceId,
      ctx.workflowRunId,
      ctx.workspacePath,
      ctx.workflowNodeId
    );

    session.mergeRuntimeMcpServers({
      'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
    });

    await session.restartQuery();
  }

  async reinjectAgentMemoryMcpServer(
    session: AgentSession,
    ctx: { subSessionId: string; spaceId: string }
  ): Promise<void> {
    const mcpServers = this.buildAgentMemoryMcpServers(ctx.spaceId, ctx.subSessionId);
    if (Object.keys(mcpServers).length === 0) return;
    session.mergeRuntimeMcpServers(mcpServers);
    await session.restartQuery();
  }

  buildAgentMemoryMcpServers(spaceId: string, sessionId: string): Record<string, McpServerConfig> {
    if (!this.config.memoryRepo) return {};
    return {
      'agent-memory': createAgentMemoryMcpServer({
        spaceId,
        memoryRepo: this.config.memoryRepo,
        mySessionId: sessionId,
      }) as unknown as McpServerConfig,
    };
  }

  buildNodeAgentMcpServerForSession(
    taskId: string,
    subSessionId: string,
    agentName: string,
    spaceId: string,
    workflowRunId: string,
    workspacePath: string,
    workflowNodeIdHint?: string
  ) {
    const nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
    const bySession = nodeExecutions.find((exec) => exec.agentSessionId === subSessionId);
    const byAgentName = nodeExecutions.find((exec) => exec.agentName === agentName);
    const execution = bySession ?? byAgentName;
    const workflowNodeId = workflowNodeIdHint ?? execution?.workflowNodeId ?? '';
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    const workflow = run?.workflowId
      ? (this.config.spaceWorkflowManager.getWorkflowForRun(run) ?? null)
      : null;
    const channels = workflow?.channels ?? [];
    const channelResolver = new ChannelResolver(channels);

    const nodeGroups = workflow
      ? Object.fromEntries(
          workflow.nodes.map((node) => [
            node.name,
            resolveNodeAgents(node).map((agent) => agent.name),
          ])
        )
      : undefined;

    const nodeAgentChannelRouter = new ChannelRouter({
      taskRepo: this.config.taskRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      workflowManager: this.config.spaceWorkflowManager,
      agentManager: this.config.spaceAgentManager,
      nodeExecutionRepo: this.config.nodeExecutionRepo,
      channelCycleRepo: this.config.channelCycleRepo,
      isSessionAlive: (sid) => this.isSessionAlive(sid),
      cancelSessionById: (sid) => this.cancelBySessionId(sid),
      findPostApprovalSessionId: (runId) =>
        runId === workflowRunId
          ? (this.config.taskRepo.getTask(taskId)?.postApprovalSessionId ?? undefined)
          : undefined,
      isPostApprovalSessionInMemory: (sid) => this.isSessionInMemory(sid),
      internalEventBus: this.config.internalEventBus,
    });
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: this.config.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: async (targetSessionId, message) => {
        await this.injectSubSessionMessage(targetSessionId, message, true);
        this.recordActivityForSession(targetSessionId);
      },
      activateTargetSession: (targetAgentName) =>
        this.activateTargetSessionsForMessage(taskId, workflowRunId, targetAgentName, {
          reopenReason: `node-agent send_message to activate "${targetAgentName}"`,
          reopenBy: `agent:${agentName}`,
        }),
      channelRouter: nodeAgentChannelRouter,
      nodeGroups,
      spaceAgentInjector: this.config.spaceAgentInjector,
      findPostApprovalSessionId: () => {
        const task = this.config.taskRepo.getTask(taskId);
        const sid = task?.postApprovalSessionId;
        return sid && this.isSessionInMemory(sid) ? sid : undefined;
      },
      findPostApprovalTargetAgentName: () => resolvePostApprovalTargetAgentName(workflow),
      replyRoutingLookup: (fromAgentName) => {
        const registry = this.config.replyRoutingRegistry;
        return registry ? registry.get(taskId, fromAgentName) : null;
      },
      workflowNodeNameById: Object.fromEntries(
        (workflow?.nodes ?? []).map((node) => [node.id, node.name])
      ),
      pendingMessageRepo: this.config.pendingMessageRepo,
      messageResolver: this.config.messageResolverFactory?.(spaceId, {
        workflowRunId,
        nodeId: workflowNodeId,
        agentName,
      }),
      longTermAgentDelivery: this.config.longTermAgentDelivery,
      spaceId,
      taskId,
      taskNumber: this.config.taskRepo.getTask(taskId)?.taskNumber ?? null,
      onMessageQueued: (targetAgentName, queuedWorkflowNodeId) => {
        void this.tryResumeNodeAgentSession(
          workflowRunId,
          targetAgentName,
          queuedWorkflowNodeId
        ).catch((err) => {
          log.warn(
            `AgentMessageRouter.onMessageQueued: tryResumeNodeAgentSession failed for "${targetAgentName}": ${err instanceof Error ? err.message : String(err)}`
          );
        });
        const declaredAgentNames = this.getWorkflowDeclaredAgentNamesForTask(taskId);
        if (declaredAgentNames.includes(targetAgentName)) {
          log.info(
            `agent-message-router.onMessageQueued: lazy-activated peer ${targetAgentName} for task ${taskId}`
          );
          void this.ensureWorkflowNodeActivationForAgent(taskId, targetAgentName, {
            reopenReason: `node-agent send_message to lazily activate "${targetAgentName}"`,
            reopenBy: `agent:${agentName}`,
            workflowNodeId: queuedWorkflowNodeId,
          }).catch((err) => {
            log.warn(
              `AgentMessageRouter.onMessageQueued: ensureWorkflowNodeActivationForAgent failed for "${targetAgentName}": ${err instanceof Error ? err.message : String(err)}`
            );
          });
        }
      },
    });

    const agentNameAliases = execution
      ? this.buildAgentNameAliasesForExecution(workflow, execution)
      : this.agentNameVariants(agentName);

    const isEndNode = this.isTerminalNode(workflow, workflowNodeId);
    const boundTaskManager = new SpaceTaskManager(
      this.config.db.getDatabase(),
      spaceId,
      this.config.reactiveDb,
      this.config.evolutionScopeService,
      (taskId) => this.config.goalService?.supersedeOutcomeNotificationsForTask(taskId),
      (taskId, fromStatus) =>
        this.config.goalService?.handleTaskTerminal(taskId, {
          fromStatus,
          deferPostCommitEffects: true,
        })
    );
    const endNodeHandlers = isEndNode
      ? createEndNodeHandlers({
          taskId,
          spaceId,
          workflow,
          workflowNodeId,
          agentName,
          taskRepo: this.config.taskRepo,
          taskManager: boundTaskManager,
          spaceManager: this.config.spaceManager,
          internalEventBus: this.config.internalEventBus,
        })
      : undefined;
    const onApproveTask = endNodeHandlers?.onApproveTask;
    const onSubmitForApproval = endNodeHandlers?.onSubmitForApproval;

    const dispatchedPostApprovalRoute = collectDispatchablePostApprovalRoutes(workflow ?? null)[0];
    const isCoderOwnedMergeWorkflow =
      dispatchedPostApprovalRoute?.requirePrMerge === true ||
      builtInWorkflowRequiresPrMerge(workflow?.templateName);
    const onMarkComplete = createMarkCompleteHandler({
      taskId,
      spaceId,
      taskRepo: this.config.taskRepo,
      taskManager: boundTaskManager,
      internalEventBus: this.config.internalEventBus,
      goalService: this.config.goalService,
      callerSessionId: subSessionId,
      requiresPostApprovalOwner: dispatchedPostApprovalRoute !== undefined,
      resolveResultArtifactSummary: (task) => {
        if (!task.workflowRunId) return null;
        return this.config.artifactProfile?.summarizeRunOutcome(task.workflowRunId) ?? null;
      },
      assertPrMerged: isCoderOwnedMergeWorkflow
        ? createPrMergedGate({
            requirePrUrl: true,
            resolvePrUrl: (task) =>
              task.workflowRunId
                ? (this.config.artifactProfile?.resolveInitialPrimaryLinkUrl?.(
                    task.workflowRunId
                  ) ?? '')
                : '',
            getPrState: async (prUrl) => {
              const outcome = await createGithubConnector().ops.getPr(
                { prUrl },
                { workspacePath: '', params: {}, rawParams: {}, hookLocalState: {} }
              );
              if (!outcome.ok) throw new Error(outcome.error);
              const state = (outcome.data as { state?: unknown } | null)?.state;
              return typeof state === 'string' ? state : 'UNKNOWN';
            },
          })
        : undefined,
    });

    const onRestoreNodeAgent = async (args: { reason?: string }): Promise<void> => {
      const liveSession = this.getSubSession(subSessionId);
      if (!liveSession) {
        log.warn(
          `TaskAgentManager.onRestoreNodeAgent: no live AgentSession found for sub-session ${subSessionId} ` +
            `(task=${taskId}, agent=${agentName}). Reason: ${args.reason ?? '<unspecified>'}`
        );
        return;
      }
      try {
        await this.reinjectNodeAgentMcpServer(liveSession, {
          taskId,
          subSessionId,
          agentName,
          spaceId,
          workflowRunId,
          workspacePath,
          workflowNodeId,
        });
        log.info(
          `TaskAgentManager.onRestoreNodeAgent: re-attached node-agent for sub-session ${subSessionId} ` +
            `(task=${taskId}, agent=${agentName}, reason=${args.reason ?? '<unspecified>'})`
        );
      } catch (err) {
        log.error(
          `TaskAgentManager.onRestoreNodeAgent: failed to re-attach node-agent for sub-session ${subSessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    const onSubscribeExternalEvent = async (args: { topicPattern: string; label?: string }) => {
      const validation = validateGlobPattern(args.topicPattern.trim());
      if (!validation.valid) {
        return jsonResult({ success: false, error: validation.reason });
      }
      try {
        const result = this.config.spaceRuntimeService.registerSubscription(
          workflowRunId,
          taskId,
          workflowNodeId,
          agentName,
          args.topicPattern
        );
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };
    const onUnsubscribeExternalEvent = async (args: { topicPattern: string }) => {
      const validation = validateGlobPattern(args.topicPattern.trim());
      if (!validation.valid) {
        return jsonResult({ success: false, error: validation.reason });
      }
      const result = this.config.spaceRuntimeService.unregisterSubscription(
        workflowRunId,
        taskId,
        workflowNodeId,
        agentName,
        args.topicPattern
      );
      return jsonResult(result);
    };
    const onListSubscriptions = async (args: { workflowRunId?: string; nodeId?: string }) => {
      try {
        const result = this.config.spaceRuntimeService.listSubscriptions(
          args.workflowRunId ?? workflowRunId,
          spaceId,
          args.nodeId
        );
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };
    const onCreateStandaloneTask = async (args: {
      title: string;
      description: string;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      custom_agent_id?: string;
      workflow_id?: string;
      depends_on?: string[];
      draft?: boolean;
    }) => {
      try {
        const task = await boundTaskManager.createTask({
          title: args.title,
          description: args.description,
          priority: args.priority,
          preferredWorkflowId: args.workflow_id ?? null,
          dependsOn: args.depends_on,
          status: args.draft ? 'draft' : undefined,
          createdBy: agentName,
          createdBySession: subSessionId,
        });
        return jsonResult({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const onPublishTask = async (args: { task_id: string }) => {
      try {
        const updated = await boundTaskManager.publishTask(args.task_id);
        this.config.internalEventBus
          ?.publish('space.task.updated', {
            sessionId: 'global',
            spaceId,
            taskId: updated.id,
            task: updated,
          })
          .catch((err: unknown) => {
            log.warn(
              `Failed to emit space.task.updated (publish) for task ${updated.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const onArchiveTask = async (args: { task_id: string }) => {
      try {
        const task = await boundTaskManager.getTask(args.task_id);
        if (
          task?.workflowRunId &&
          this.config.spaceRuntimeService.isWorkflowRunActive(task.workflowRunId)
        ) {
          return jsonResult({
            success: false,
            error:
              `Cannot archive task ${args.task_id}: it belongs to an active workflow run ` +
              `(${task.workflowRunId}). Cancel the run instead so its agents and ` +
              `lifecycle are torn down — archiving would leave the run stranded.`,
          });
        }
        const updated = await boundTaskManager.archiveTask(args.task_id);
        this.config.internalEventBus
          ?.publish('space.task.updated', {
            sessionId: 'global',
            spaceId,
            taskId: updated.id,
            task: updated,
          })
          .catch((err: unknown) => {
            log.warn(
              `Failed to emit space.task.updated (archive) for task ${updated.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    let hookEngine: WorkflowHookEngine | undefined;
    if (workflow?.hooks && workflow.hooks.length > 0) {
      const hookExecutor = new HookExecutor({ workspacePath });
      hookEngine = new WorkflowHookEngine({
        workflow,
        workflowRunId,
        workflowRunCreatedAt: this.config.workflowRunRepo.getRun(workflowRunId)?.createdAt,
        nodeExecutionRepo: this.config.nodeExecutionRepo,
        artifactRepo: this.config.artifactRepo,
        hookStateRepo: new WorkflowHookStateRepository(this.config.db.getDatabase()),
        hookExecutor,
        workspacePath,
        getWorkflowRunStatus: (runId) => this.config.workflowRunRepo.getRun(runId)?.status,
        getTaskStatus: (tid) => this.config.taskRepo.getTask(tid)?.status,
        getSourceNodeExecutionStatus: (actionMeta) =>
          this.config.nodeExecutionRepo
            .listByWorkflowRun(workflowRunId)
            .find(
              (execution) =>
                execution.agentSessionId === actionMeta.sessionId &&
                execution.agentName === actionMeta.agentName &&
                execution.workflowNodeId === actionMeta.nodeId
            )?.status,
        notifySourceSession: async (sessionId, message) => {
          await this.injectSubSessionMessage(
            sessionId,
            message,
            true,
            undefined,
            'immediate',
            'system'
          );
        },
        onHookStateUpdated: (hookId, hookState) => {
          this.config.internalEventBus
            ?.publish('space.hookState.updated', {
              sessionId: 'global',
              spaceId,
              runId: workflowRunId,
              hookId,
              hookState,
            })
            .catch((err: unknown) => {
              log.warn(
                `Failed to emit space.hookState.updated for hook ${hookId}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
        },
      });
    }

    return createNodeAgentMcpServer({
      mySessionId: subSessionId,
      myAgentName: agentName,
      myAgentNameAliases: agentNameAliases,
      taskId,
      spaceId,
      channelResolver,
      workflowRunId,
      workflowNodeId,
      nodeExecutionRepo: this.config.nodeExecutionRepo,
      agentMessageRouter,
      internalEventBus: this.config.internalEventBus,
      workflow,
      onApproveTask,
      onSubmitForApproval,
      onMarkComplete,
      onCreateStandaloneTask,
      onPublishTask,
      onArchiveTask,
      onSubscribeExternalEvent,
      onUnsubscribeExternalEvent,
      onListSubscriptions,
      artifactRepo: this.config.artifactRepo,
      artifactProfile: this.config.artifactProfile,
      taskRepo: this.config.taskRepo,
      auditLogRepo: this.auditLogRepo,
      externalEventStore: this.config.externalEventStore,
      onRestoreNodeAgent,
      replyRoutingLookup: (fromAgentName) => {
        const registry = this.config.replyRoutingRegistry;
        return registry ? registry.get(taskId, fromAgentName) : null;
      },
      hookEngine,
    });
  }

  async spawnPostApprovalSubSession(args: {
    task: SpaceTask;
    workflow: SpaceWorkflow;
    targetAgent: string;
    kickoffMessage: string;
  }): Promise<{ sessionId: string }> {
    const { task, workflow, targetAgent, kickoffMessage } = args;
    const taskId = task.id;
    const spaceId = task.spaceId;

    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      throw new Error(`spawnPostApprovalSubSession: space ${spaceId} not found for task ${taskId}`);
    }

    let matchedSlot: ReturnType<typeof resolveNodeAgents>[number] | null = null;
    let matchedNodeId: string | null = null;
    for (const node of workflow.nodes) {
      for (const slot of resolveNodeAgents(node)) {
        if (slot.name === targetAgent || slot.agentId === targetAgent) {
          matchedSlot = slot;
          matchedNodeId = node.id;
          break;
        }
      }
      if (matchedSlot) break;
    }
    if (!matchedSlot?.agentId || !matchedNodeId) {
      throw new Error(
        `spawnPostApprovalSubSession: no agent slot "${targetAgent}" declared in workflow ${workflow.id}`
      );
    }

    const existingSessionId = this.findLiveSubSessionForAgent(task, matchedSlot.name);
    if (existingSessionId) {
      const existing = this.getSubSession(existingSessionId);
      if (!existing) {
        throw new Error(
          `spawnPostApprovalSubSession: live session ${existingSessionId} for agent "${matchedSlot.name}" vanished before injection (task ${taskId})`
        );
      }
      await this.withSessionInjectLock(existing.session.id, async () => {
        const terminalStatus = task.workflowRunId
          ? this.resolveTerminalInjectionStatus(task.workflowRunId)
          : null;
        if (terminalStatus) {
          log.warn(
            `TaskAgentManager.spawnPostApprovalSubSession: skipping inject to live session ` +
              `${existingSessionId} — task/run is terminal (${terminalStatus})`
          );
          return;
        }
        await this.injectMessageIntoSession(existing, kickoffMessage);
      });
      log.info(
        `TaskAgentManager.spawnPostApprovalSubSession: reused live session ${existingSessionId} for agent "${matchedSlot.name}" (task ${taskId}, node ${matchedNodeId})`
      );
      return { sessionId: existingSessionId };
    }

    const workflowRunId = task.workflowRunId;
    const workflowRun = workflowRunId ? this.config.workflowRunRepo.getRun(workflowRunId) : null;

    const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

    const matchedNode = workflow.nodes.find((node) => node.id === matchedNodeId);
    const poolAgent = this.config.spaceAgentManager.getById(matchedSlot.agentId);
    let slot = matchedSlot;
    let poolProvider: string | undefined;
    if (poolAgent) {
      const poolApplication = applyModelPoolToSlot({
        slot: matchedSlot,
        task,
        node: { id: matchedNodeId },
        agent: poolAgent,
        spaceId,
        assignments: this.modelPoolAssignments,
        getSessionStatus: (sessionId: string) =>
          this.agentSessionIndex.get(sessionId)?.getProcessingState().status,
        now: Date.now(),
      });
      if ('deferred' in poolApplication) {
        raiseModelPoolDeferred(poolAgent.name, spaceId);
      }
      slot = poolApplication.slot;
      poolProvider = poolApplication.provider;
    }
    const assignedModel =
      slot.model ?? poolAgent?.model ?? space.defaultModel ?? DEFAULT_CUSTOM_AGENT_MODEL;
    const reservationKey = { id: `post-approval:${taskId}:${slot.name}:${generateUUID()}` };
    const assignment = { spaceId, taskId, model: assignedModel };
    reserveModelPoolSlot(this.modelPoolAssignments, reservationKey, assignment);

    try {
      const slotOverrides = {
        ...buildSlotOverrides(slot, {
          task,
          node: matchedNode,
          workflow,
          workflowRun: workflowRun ?? undefined,
        }),
        ...(poolProvider ? { provider: poolProvider } : {}),
      };

      const baseSessionId = `space:${spaceId}:task:${taskId}:post-approval:${this.sanitizeAgentNameForId(slot.name)}`;
      const sessionId = this.resolveSessionId(baseSessionId);

      let init = resolveAgentInit({
        task,
        space,
        agentManager: this.config.spaceAgentManager,
        sessionId,
        workspacePath,
        workflowRun: workflowRun ?? undefined,
        workflow,
        slotOverrides,
        agentId: slot.agentId,
      });

      const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
        taskId,
        sessionId,
        matchedSlot.name,
        spaceId,
        workflowRunId ?? '',
        workspacePath,
        matchedNodeId
      );
      init = {
        ...init,
        title: formatWorkflowNodeSessionTitle(task, matchedSlot.name),
        mcpServers: {
          ...init.mcpServers,
          'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
          'space-agent-tools': this.config.spaceRuntimeService.buildMemberSpaceToolsMcpServer(
            space,
            sessionId
          ),
          ...this.buildAgentMemoryMcpServers(spaceId, sessionId),
        },
      };

      const actualSessionId = await this.createSubSession(taskId, sessionId, init, {
        agentId: matchedSlot.agentId,
        agentName: matchedSlot.name,
        nodeId: matchedNodeId,
      });

      const spawned = this.getSubSession(actualSessionId);
      if (!spawned) {
        throw new Error(
          `spawnPostApprovalSubSession: spawned session ${actualSessionId} not registered in memory`
        );
      }

      spawned.onMissingMemberSpaceMcpServers = async (sid: string) => {
        await this.config.spaceRuntimeService.reattachMemberSpaceTools(sid);
      };

      await this.ensureNodeAgentAttached(spawned, {
        taskId,
        subSessionId: actualSessionId,
        agentName: matchedSlot.name,
        spaceId,
        workflowRunId: workflowRunId ?? '',
        workspacePath,
        workflowNodeId: matchedNodeId,
        phase: 'spawn',
      });

      await this.withSessionInjectLock(spawned.session.id, () =>
        this.injectMessageIntoSession(spawned, kickoffMessage)
      );

      log.info(
        `TaskAgentManager.spawnPostApprovalSubSession: spawned session ${actualSessionId} for agent "${slot.name}" (task ${taskId}, node ${matchedNodeId})`
      );
      activateModelPoolReservation(this.modelPoolAssignments, reservationKey, actualSessionId);
      return { sessionId: actualSessionId };
    } catch (err) {
      releaseModelPoolReservation(this.modelPoolAssignments, reservationKey);
      throw err;
    }
  }

  private findLiveSubSessionForAgent(task: SpaceTask, agentName: string): string | null {
    if (!task.workflowRunId) return null;
    const prevExec = this.config.nodeExecutionRepo
      .listByWorkflowRun(task.workflowRunId)
      .filter((e) => e.agentName === agentName && e.agentSessionId)
      .at(-1);
    const candidateId = prevExec?.agentSessionId ?? null;
    if (!candidateId) return null;
    return this.getSubSession(candidateId) ? candidateId : null;
  }
}
