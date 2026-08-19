import { generateUUID, isRateOrUsageLimited, resolveNodeAgents } from '@hyperneo/shared';
import type {
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  NodeExecution,
  MessageHub,
  McpServerConfig,
  MessageContent,
  MessageImage,
  MessageInputKind,
  MessageOrigin,
  WorkflowNode,
  WorkflowNodeAgent,
  Session,
} from '@hyperneo/shared';
import type { SkillsManager } from '../../skills-manager';
import type { AppMcpServerRepository } from '../../../storage/repositories/app-mcp-server-repository';
import type { UUID } from 'crypto';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { AgentSessionInit } from '../../../lib/agent/agent-session';
import { AgentSession } from '../../../lib/agent/agent-session';
import {
  awaitDeliveryConsumption,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
  isMessageDeliveryV2Enabled,
} from '../../../lib/agent/message-delivery';
import { validateImageSizes } from '../../session/message-persistence';
import type { Database } from '../../../storage/database';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import type { SessionManager } from '../../session-manager';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceRuntimeService } from './space-runtime-service';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types';
import type { ActorResolver } from '../../../../../messaging/src/contracts';
import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository';
import type { SpaceWorktreeManager } from '../managers/space-worktree-manager';
import { SpaceTaskManager } from '../managers/space-task-manager';
export interface SubSessionMemberInfo {
  agentId?: string;
  agentName?: string;
  nodeId?: string;
}
import { createNodeAgentMcpServer } from '../tools/node-agent-tools';
import {
  createEndNodeHandlers,
  createMarkCompleteHandler,
  createPrMergedGate,
} from '../tools/end-node-handlers';
import { builtInWorkflowRequiresPrMerge } from '../workflows/built-in-workflows';
import { createGithubConnector } from './connectors/github-connector';
import { collectDispatchablePostApprovalRoutes } from './post-approval-router';
import { jsonResult } from '../tools/tool-result';
import {
  assertExecutionValidAgainstWorkflow,
  PermanentSpawnError,
  validateTaskAllowsSpawn,
} from './workflow-node-execution-validation';
import type { DbQueryMcpServer } from '../../db-query/tools';
import { sanitizeAssistantUsageInSDKSessionFile } from '../../sdk-session-file-manager';
import { ChannelResolver } from './channel-resolver';
import { ChannelRouter } from './channel-router';
import { AgentMessageRouter } from './agent-message-router';
import type { ReplyRoutingRegistry } from './reply-routing-registry';
import type { WorkflowArtifactProfile } from './artifact-profile';
import type { AgentMemoryRepository } from '../../../storage/repositories/agent-memory-repository';
import type { EvolutionScopeService } from '../evolution-scope-service';
import { createAgentMemoryMcpServer } from '../tools/agent-memory-tools';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { validateGlobPattern } from '../../external-events/topic-validator';
import { HookExecutor } from './hook-executor';
import {
  clearAllRetryableHookActionTimers,
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  WorkflowHookEngine,
} from './workflow-hook-engine';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import {
  buildCustomAgentTaskMessage,
  resolveAgentInit,
  type SlotOverrides,
} from '../agents/custom-agent';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';
import { Logger } from '../../logger';
import {
  formatAgentMessage,
  extractReplyToSessionId,
  type AgentMessageLevel,
} from '../agent-message-envelope';

const log = new Logger('task-agent-manager');
const AGENT_MESSAGE_ENVELOPE_HEADER = /^─── Message from ([^\n]+) ───\n\n/;

const WORKFLOW_ESCALATION_TARGET = 'space-agent';
const AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK = '\n\n─── Reply ───\nTo reply, use: ';

function pendingSourceLevel(sourceAgentName: string): AgentMessageLevel {
  if (sourceAgentName === 'task-agent') return 'task-agent';
  if (sourceAgentName === 'space-agent') return 'space-agent';
  if (sourceAgentName === 'space-member') return 'session-agent';
  return 'node-agent';
}

function expectedEnvelopeSenderNames(sourceAgentName: string): string[] {
  return sourceAgentName === 'space-agent' ? ['space-agent', 'Space Agent'] : [sourceAgentName];
}

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

export function hasAgentMessageEnvelopeForTest(
  message: string,
  sourceAgentName: string,
  toLevel: AgentMessageLevel
): boolean {
  const match = message.match(AGENT_MESSAGE_ENVELOPE_HEADER);
  if (!match) return false;

  const fromLevel = pendingSourceLevel(sourceAgentName);
  const expectedSenders = expectedEnvelopeSenderNames(sourceAgentName);
  const headerSender = match[1];
  if (
    !expectedSenders.some(
      (expectedSender) =>
        headerSender === expectedSender || headerSender.startsWith(`${expectedSender} (task #`)
    )
  ) {
    return false;
  }

  if (fromLevel === 'node-agent' && toLevel === 'node-agent') return true;
  return message.includes(AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK);
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
    explicitMessageId?: string
  ) => Promise<void>;
  scheduleService?: import('../schedule/schedule-service').ScheduleService;
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
  goalService?: import('../goals/goal-service').SpaceGoalService;
  evolutionScopeService?: EvolutionScopeService;
  externalEventStore?: import('../../external-events/external-event-store').ExternalEventStore;
}

type CompletionCallbackMap = Map<string, Array<() => Promise<void>>>;

interface RateLimitSessionEntry {
  resetAt: number;
  kind: 'rate_limit' | 'usage_limit';
  reason: string;
}

const RATE_LIMIT_FALLBACK_RESET_AT_MS = 60 * 60 * 1000;

interface SpawnTaskAgentOptions {
  kickoff?: boolean;
}

export interface BuildSlotOverridesContext {
  task?: Pick<SpaceTask, 'workflowModelOverrides'>;
  node?: { id: string; name: string };
  workflow?: { id: string };
  workflowRun?: { id: string };
}

export function buildSlotOverrides(
  slot: WorkflowNodeAgent,
  context?: BuildSlotOverridesContext
): SlotOverrides {
  let slotCustomPrompt: string | undefined = slot.customPrompt?.value;
  if (!slotCustomPrompt && slot.replaceAgentPrompt !== true) {
    const legacySlot = slot as {
      systemPrompt?: { value: string };
      instructions?: { value: string };
    };
    const legacySp = legacySlot.systemPrompt?.value?.trim() ?? '';
    const legacyInstr = legacySlot.instructions?.value?.trim() ?? '';
    if (legacySp && legacyInstr) {
      slotCustomPrompt = `${legacySp}\n\n${legacyInstr}`;
    } else {
      slotCustomPrompt = legacySp || legacyInstr || undefined;
    }
  }
  const modelOverrideKey = context?.node ? `${context.node.id}:${slot.name}` : null;
  const taskModelOverride = modelOverrideKey
    ? context?.task?.workflowModelOverrides?.[modelOverrideKey]
    : undefined;
  const effectiveGuards = slot.toolGuards;
  return {
    model: taskModelOverride ?? slot.model,
    thinkingLevel: slot.thinkingLevel,
    customPrompt: slotCustomPrompt,
    replaceAgentPrompt: slot.replaceAgentPrompt,
    disabledSkillIds: slot.disabledSkillIds,
    extraMcpServers: slot.extraMcpServers,
    toolGuards: effectiveGuards,
    resolutionContext: {
      agentId: slot.agentId,
      agentName: slot.name,
      workflowRunId: context?.workflowRun?.id,
      workflowId: context?.workflow?.id,
      nodeId: context?.node?.id,
      nodeName: context?.node?.name,
    },
  };
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
  attachToolContinuationRepo(repo: ToolContinuationRecoveryRepository): void {
    this.config.toolContinuationRepo = repo;
  }

  private subSessions = new Map<string, Map<string, AgentSession>>();

  private agentSessionIndex = new Map<string, AgentSession>();

  private cancellingSessions = new Set<string>();

  private readonly sessionInjectLocks = new Map<string, Promise<void>>();

  private readonly sessionRestoreLocks = new Map<string, Promise<void>>();

  private spawningExecutionIds = new Set<string>();

  private completionCallbacks: CompletionCallbackMap = new Map();

  private sessionListeners = new Map<string, () => void>();

  private taskWorktreePaths = new Map<string, string>();

  private taskDbQueryServers = new Map<string, DbQueryMcpServer>();
  private readonly auditLogRepo: McpAuditLogRepository;

  private eagerSubSessionIds = new Map<string, Map<string, string>>();

  private taskArchiveListenerUnsub: (() => void) | null = null;
  private rateLimitListenerUnsubs: Array<() => void> = [];
  private activityListenerUnsubs: Array<() => void> = [];
  private limitedSessionsByTask = new Map<string, Map<string, RateLimitSessionEntry>>();

  constructor(private readonly config: TaskAgentManagerConfig) {
    this.auditLogRepo = new McpAuditLogRepository(this.config.db.getDatabase());
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
    for (const entry of entries.values()) {
      if (entry.kind === 'usage_limit') hasUsageLimit = true;
      if (entry.resetAt > resetAt) {
        resetAt = entry.resetAt;
        reason = entry.reason;
      }
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
    this.config.taskRepo.updateTask(taskId, { status, restrictions });
    this.emitTaskUpdatedEvent(taskId);
  }

  private async restoreTaskFromRateLimit(taskId: string): Promise<void> {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return;
    if (!isRateOrUsageLimited(task.status)) return;
    this.config.taskRepo.updateTask(taskId, { status: 'in_progress', restrictions: null });
    this.emitTaskUpdatedEvent(taskId);
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
    if (execution.agentSessionId && this.agentSessionIndex.has(execution.agentSessionId)) {
      if (this.isSessionAlive(execution.agentSessionId)) {
        const startedAt = execution.startedAt ?? Date.now();
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'in_progress',
          agentSessionId: execution.agentSessionId,
          startedAt,
          completedAt: null,
        });
        return execution.agentSessionId;
      }
      this.agentSessionIndex.delete(execution.agentSessionId);
    }

    if (this.spawningExecutionIds.has(execution.id)) {
      const CONCURRENT_SPAWN_TIMEOUT_MS = 30_000;
      const deadline = Date.now() + CONCURRENT_SPAWN_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          const fresh = this.config.nodeExecutionRepo.getById(execution.id);
          if (fresh?.agentSessionId) {
            clearInterval(interval);
            resolve(fresh.agentSessionId);
            return;
          }
          if (!this.spawningExecutionIds.has(execution.id)) {
            clearInterval(interval);
            reject(
              new Error(
                `Concurrent spawn for execution ${execution.id} failed before session was created`
              )
            );
            return;
          }
          if (Date.now() >= deadline) {
            clearInterval(interval);
            reject(
              new Error(
                `Concurrent spawn for execution ${execution.id} timed out after ${CONCURRENT_SPAWN_TIMEOUT_MS}ms`
              )
            );
          }
        }, 50);
      });
    }

    this.spawningExecutionIds.add(execution.id);
    let spawnedSessionId: string | null = null;

    try {
      const freshTask = this.config.taskRepo.getTask(task.id) ?? task;
      validateTaskAllowsSpawn(freshTask);
      assertExecutionValidAgainstWorkflow(execution, workflow);

      const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId)!;
      const nodeAgents = resolveNodeAgents(node);
      const slot =
        nodeAgents.length === 1
          ? nodeAgents[0]
          : nodeAgents.find((agentSlot) => agentSlot.name === execution.agentName);
      if (!slot?.agentId) {
        throw new Error(
          `No agent slot found for agent name "${execution.agentName}" in node "${execution.workflowNodeId}"`
        );
      }

      const taskId = task.id;
      const baseSessionId = `space:${space.id}:task:${taskId}:exec:${execution.id}`;
      const sessionId = this.resolveSessionId(baseSessionId);

      let workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;
      if (!this.taskWorktreePaths.has(taskId) && this.config.worktreeManager) {
        try {
          const result = await this.config.worktreeManager.createTaskWorktree(
            space.id,
            taskId,
            task.title,
            task.taskNumber
          );
          workspacePath = result.path;
          this.taskWorktreePaths.set(taskId, result.path);
        } catch (err) {
          log.warn(
            `TaskAgentManager: failed to create worktree for workflow task ${taskId}, falling back to space workspace: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const slotOverrides = buildSlotOverrides(slot, {
        task,
        node,
        workflow,
        workflowRun,
      });

      let init = resolveAgentInit({
        task,
        space,
        agentManager: this.config.spaceAgentManager,
        sessionId,
        workspacePath,
        workflowRun,
        workflow,
        slotOverrides,
        agentId: slot.agentId,
      });

      const shouldKickoff = options.kickoff ?? true;
      const customAgent = shouldKickoff
        ? this.config.spaceAgentManager.getById(slot.agentId)
        : null;
      if (shouldKickoff && !customAgent) {
        throw new PermanentSpawnError(`Agent not found: ${slot.agentId}`);
      }

      const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
        taskId,
        sessionId,
        execution.agentName,
        space.id,
        workflowRun.id,
        workspacePath,
        execution.workflowNodeId
      );

      init = {
        ...init,
        title: formatWorkflowNodeSessionTitle(task, execution.agentName),
        mcpServers: {
          ...init.mcpServers,
          'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
          ...this.buildAgentMemoryMcpServers(space.id, sessionId),
        },
      };

      const actualSessionId = await this.createSubSession(taskId, sessionId, init, {
        agentId: slot.agentId,
        agentName: execution.agentName,
        nodeId: execution.workflowNodeId,
      });
      spawnedSessionId = actualSessionId;

      const spawned = this.getSubSession(actualSessionId);
      if (!spawned) {
        throw new Error(`Spawned node session ${actualSessionId} is not registered in memory`);
      }

      const startedAt = Date.now();
      const updatedExecution = this.config.nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: actualSessionId,
        startedAt,
        completedAt: null,
      });
      if (
        !updatedExecution ||
        updatedExecution.status !== 'in_progress' ||
        updatedExecution.agentSessionId !== actualSessionId ||
        !updatedExecution.startedAt
      ) {
        log.error('[Spawn] Execution state mismatch after spawn', {
          executionId: execution.id,
          expectedStatus: 'in_progress',
          actualStatus: updatedExecution?.status ?? null,
          expectedSessionId: actualSessionId,
          actualSessionId: updatedExecution?.agentSessionId ?? null,
        });
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'blocked',
          result: 'Execution state corruption after spawn',
          completedAt: Date.now(),
        });
        throw new Error(`Execution state corruption after spawn for ${execution.id}`);
      }

      await this.ensureNodeAgentAttached(spawned, {
        taskId,
        subSessionId: actualSessionId,
        agentName: execution.agentName,
        spaceId: space.id,
        workflowRunId: workflowRun.id,
        workspacePath,
        workflowNodeId: execution.workflowNodeId,
        phase: 'spawn',
      });

      this.registerCompletionCallback(actualSessionId, async () => {
        await this.handleSubSessionComplete(taskId, execution.workflowNodeId, actualSessionId);
      });

      if (shouldKickoff) {
        const goal = task.goalId ? this.config.goalService?.getGoal(task.goalId) : null;
        const linkedGoal = goal?.spaceId === task.spaceId ? goal : null;

        const memoryQuery = `${task.title}\n${task.description}`;
        const coreMemories = this.config.memoryRepo
          ? this.config.memoryRepo.listCoreMemories(space.id, 10)
          : [];
        const relevantMemories = this.config.memoryRepo
          ? await this.config.memoryRepo.search(space.id, memoryQuery, 5)
          : [];
        const relevantScopeLessons = this.config.evolutionScopeService
          ? this.config.evolutionScopeService.selectActiveLessonsForTask({
              taskId: task.id,
              limit: 3,
            })
          : [];
        const initialMessage = buildCustomAgentTaskMessage({
          customAgent: customAgent!,
          task,
          workflowRun,
          workflow,
          space,
          sessionId: actualSessionId,
          workspacePath,
          goal: linkedGoal,
          relevantScopeLessons,
          slotOverrides,
          nodeId: execution.workflowNodeId,
          agentSlotName: execution.agentName,
          coreMemories,
          relevantMemories,
        });
        const runtimeContract = this.buildNodeExecutionRuntimeContract(workflow, execution, space);
        const kickoffMessage = runtimeContract
          ? `${initialMessage}\n\n${runtimeContract}`
          : initialMessage;
        await this.injectMessageIntoSession(spawned, kickoffMessage);
      }
      return actualSessionId;
    } catch (err) {
      if (spawnedSessionId) {
        this.cancelBySessionId(spawnedSessionId);
      }
      throw err;
    } finally {
      this.spawningExecutionIds.delete(execution.id);
    }
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
        const eagerSessionId = this.eagerSubSessionIds.get(taskId)?.get(memberInfo.agentName);
        let prevExec = this.config.nodeExecutionRepo
          .listByWorkflowRun(parentTask.workflowRunId)
          .filter((e) => e.agentName === memberInfo.agentName && e.agentSessionId)
          .at(-1);
        if (!prevExec && eagerSessionId) {
          prevExec = {
            id: '',
            workflowRunId: parentTask.workflowRunId,
            workflowNodeId: memberInfo.nodeId ?? '',
            agentName: memberInfo.agentName,
            agentId: memberInfo.agentId ?? null,
            agentSessionId: eagerSessionId,
            status: 'pending',
            result: null,
            data: null,
            createdAt: 0,
            startedAt: null,
            completedAt: null,
            updatedAt: 0,
            lastActivityAt: null,
          };
        }
        if (prevExec?.agentSessionId) {
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
                this.config.nodeExecutionRepo.update(match.id, {
                  status: 'in_progress',
                  agentSessionId: existingSessionId,
                  startedAt: match.startedAt ?? Date.now(),
                  completedAt: null,
                });
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
                  this.config.nodeExecutionRepo.update(stale.id, {
                    agentSessionId: null,
                    ...(!mustPreserve ? { status: 'idle' as const } : {}),
                  });
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
              cbSessionId: string,
              missing: string[]
            ) => {
              await this.mcpSelfHeal(cbSessionId, missing);
            };

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
        if (match && !match.agentSessionId) {
          this.config.nodeExecutionRepo.update(match.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: match.startedAt ?? Date.now(),
            completedAt: null,
          });
        } else if (match && match.agentSessionId) {
          log.warn(
            `TaskAgentManager: NodeExecution ${match.id} already has agentSessionId ${match.agentSessionId}; skipping update for new session ${sessionId}`
          );
        } else {
          log.warn(
            `TaskAgentManager: no matching NodeExecution found for (run=${parentTask.workflowRunId}, node=${memberInfo.nodeId}, agent=${memberInfo.agentName})`
          );
        }
      }
    }

    subSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
      await this.mcpSelfHeal(cbSessionId, missing);
    };

    await subSession.startStreamingQuery();

    if (memberInfo?.agentName) {
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

    repo.enforceRetention({ runId: workflowRunId });
    repo.expireStale(workflowRunId);

    const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
    const workflowNodeName = execution
      ? this.workflowNodeNameForRun(workflowRunId, execution.workflowNodeId)
      : null;
    const drainWorkflowNodeId = execution?.workflowNodeId ?? null;
    const executionless = !execution;
    const queueTargetNames = [
      targetAgentName,
      ...(workflowNodeName ? [`${workflowNodeName}/${targetAgentName}`] : []),
    ];
    const seenIds = new Set<string>();
    const pending = queueTargetNames
      .flatMap((targetName) =>
        drainWorkflowNodeId != null
          ? repo.listPendingForTarget(workflowRunId, targetName, drainWorkflowNodeId)
          : repo.listPendingForTarget(workflowRunId, targetName)
      )
      .filter((row) => row.targetKind === 'node_agent')
      .filter((row) => (executionless ? row.workflowNodeId == null : true))
      .filter((row) => {
        if (seenIds.has(row.id)) return false;
        seenIds.add(row.id);
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return;

    log.info(
      `TaskAgentManager: flushing ${pending.length} pending message(s) for agent=${targetAgentName} session=${sessionId}`
    );

    for (const row of pending) {
      const isSyntheticMessage = row.sourceAgentName !== 'human';
      const message = isSyntheticMessage
        ? hasAgentMessageEnvelopeForTest(row.message, row.sourceAgentName, 'node-agent')
          ? row.message
          : formatAgentMessage({
              fromLevel: pendingSourceLevel(row.sourceAgentName),
              fromAgentName: row.sourceAgentName,
              toLevel: 'node-agent',
              body: row.message,
              taskId: row.taskId,
              nodeId: targetAgentName,
            })
        : `[Message from human]: ${row.message}`;
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

    repo.enforceRetention({ runId: workflowRunId });
    repo.expireStale(workflowRunId);

    const pending = repo
      .listPendingForTarget(workflowRunId, 'space-agent')
      .filter((r) => r.targetKind === 'space_agent');
    if (pending.length === 0) return;

    const spaceChatSessionId = `space:chat:${spaceId}`;
    log.info(
      `TaskAgentManager: flushing ${pending.length} pending message(s) for Space Agent session=${spaceChatSessionId}`
    );

    for (const row of pending) {
      const message = hasAgentMessageEnvelopeForTest(
        row.message,
        row.sourceAgentName,
        'space-agent'
      )
        ? row.message
        : formatAgentMessage({
            fromLevel: pendingSourceLevel(row.sourceAgentName),
            fromAgentName: row.sourceAgentName,
            toLevel: 'space-agent',
            body: row.message,
            taskId: row.taskId,
          });
      try {
        const registry = this.config.replyRoutingRegistry;
        const replyTo =
          extractReplyToSessionId(message) ??
          (registry && row.taskId ? registry.get(row.taskId) : null);
        await inject(spaceId, message, replyTo, row.id);
        repo.markDelivered(row.id, spaceChatSessionId);
        this.emitPendingDelivered(row.id, spaceChatSessionId, row);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`TaskAgentManager: Space Agent delivery for ${row.id} failed: ${errMsg}`);
        repo.markAttemptFailed(row.id, errMsg);
      }
    }
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
      const guardTask = this.config.taskRepo.listByWorkflowRunIncludingArchived(
        guardExecution.workflowRunId
      )[0];
      const guardRun = this.config.workflowRunRepo.getRun(guardExecution.workflowRunId);
      if (
        guardTask?.status === 'cancelled' ||
        guardTask?.status === 'archived' ||
        guardRun?.status === 'cancelled'
      ) {
        log.warn(
          `TaskAgentManager.injectSubSessionMessageWithOrigin: rejecting inject to session ${subSessionId} — task/run is terminal (${guardTask?.status ?? guardRun?.status})`
        );
        throw new Error(
          `Cannot inject message to session ${subSessionId} — task/run is terminal (${guardTask?.status ?? guardRun?.status})`
        );
      }
    }

    return this.withSessionInjectLock(subSessionId, async () => {
      const indexed = this.agentSessionIndex.get(subSessionId);
      if (indexed) {
        return await this.injectMessageIntoSession(
          indexed,
          message,
          deliveryMode,
          origin,
          isSyntheticMessage,
          images,
          inputKind,
          messageId
        );
      }

      for (const [, nodeMap] of this.subSessions) {
        const session = nodeMap.get(subSessionId);
        if (session) {
          return await this.injectMessageIntoSession(
            session,
            message,
            deliveryMode,
            origin,
            isSyntheticMessage,
            images,
            inputKind,
            messageId
          );
        }
      }

      const rehydrated = await this.rehydrateSubSession(subSessionId);
      if (rehydrated) {
        return await this.injectMessageIntoSession(
          rehydrated,
          message,
          deliveryMode,
          origin,
          isSyntheticMessage,
          images,
          inputKind,
          messageId
        );
      }
      throw new Error(`Sub-session not found: ${subSessionId}`);
    });
  }

  private async withSessionInjectLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionInjectLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => held);
    this.sessionInjectLocks.set(sessionId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionInjectLocks.get(sessionId) === tail) {
        this.sessionInjectLocks.delete(sessionId);
      }
    }
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
              AND json_extract(s.session_context, '$.taskId') = ?
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
              AND json_extract(s.session_context, '$.taskId') = ?
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
    agentSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
      await this.mcpSelfHeal(cbSessionId, missing);
    };

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
    if (existing) {
      if (existing.agentSessionId && this.isSessionAlive(existing.agentSessionId)) {
        return [{ agentName, sessionId: existing.agentSessionId }];
      }
      if (existing.agentSessionId) {
        this.agentSessionIndex.delete(existing.agentSessionId);
      }
      this.config.nodeExecutionRepo.update(existing.id, {
        status: 'pending',
      });
    }

    if (options?.workflowNodeId) {
      const task = this.config.taskRepo.getTask(taskId);
      if (task?.workflowRunId) {
        const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
        if (run?.workflowId) {
          const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
          const node = workflow?.nodes.find((candidate) => candidate.id === options.workflowNodeId);
          const slots = node ? resolveNodeAgents(node) : [];
          if (!slots.some((slot) => slot.name === agentName)) return [];
        }
      }
      await this.ensureWorkflowNodeActivationForAgent(taskId, agentName, options);
    } else {
      await this.ensureWorkflowNodeActivationForAgent(taskId, agentName, options);
    }

    const task = this.config.taskRepo.getTask(taskId);
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    const workflow = run?.workflowId
      ? this.config.spaceWorkflowManager.getWorkflowForRun(run)
      : null;
    const space = task ? await this.config.spaceManager.getSpace(task.spaceId) : null;
    if (!task || !run || !workflow || !space) return [];

    const execution = this.config.nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .find(
        (candidate) => candidate.agentName === agentName && matchesNode(candidate.workflowNodeId)
      );
    if (!execution) return [];

    const spawnPromise = this.spawnWorkflowNodeAgentForExecution(
      task,
      space,
      workflow,
      run,
      execution
    );
    const timeoutMs = 30_000;
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const sessionId = await Promise.race([spawnPromise, timeoutPromise]);
    if (!sessionId) {
      log.warn(
        `TaskAgentManager.activateTargetSessionsForMessage: timed out after ${timeoutMs}ms activating agent "${agentName}" for run ${workflowRunId}`
      );
      return [];
    }
    return [{ agentName, sessionId }];
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

      let targetNodeId: string | null = null;
      for (const node of workflow.nodes) {
        let slots: ReturnType<typeof resolveNodeAgents>;
        try {
          slots = resolveNodeAgents(node);
        } catch {
          continue;
        }
        if (slots.some((slot) => slot.name === agentName)) {
          if (options?.workflowNodeId && node.id !== options.workflowNodeId) continue;
          targetNodeId = node.id;
          break;
        }
      }
      if (!targetNodeId) return false;

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

      await channelRouter.activateNode(run.id, targetNodeId, {
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

  isSpawning(_taskId: string): boolean {
    return false;
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

  getTaskAgent(_taskId: string): AgentSession | undefined {
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
    await this.mcpSelfHeal(sessionId, ['node-agent']);
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
    clearAllRetryableHookActionTimers();
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

    this.eagerSubSessionIds.delete(taskId);

    const dbQueryServer = this.taskDbQueryServers.get(taskId);
    if (dbQueryServer) {
      try {
        dbQueryServer.close();
      } catch (err) {
        log.warn(`TaskAgentManager: failed to close db-query server for task ${taskId}:`, err);
      }
      this.taskDbQueryServers.delete(taskId);
    }

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

    this.eagerSubSessionIds.delete(taskId);

    const dbQueryServer = this.taskDbQueryServers.get(taskId);
    if (dbQueryServer) {
      try {
        dbQueryServer.close();
      } catch (err) {
        log.warn(`TaskAgentManager: failed to close db-query server for task ${taskId}:`, err);
      }
      this.taskDbQueryServers.delete(taskId);
    }

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
    if (!this.config.db.getSession(baseId)) {
      return baseId;
    }

    const MAX_ATTEMPTS = 100;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const candidateId = `${baseId}:${attempt}`;
      if (!this.config.db.getSession(candidateId)) {
        return candidateId;
      }
    }
    throw new Error(
      `Could not find available session ID for base "${baseId}" after ${MAX_ATTEMPTS} attempts`
    );
  }

  private async rehydrateSubSessionsForRun(workflowRunId: string | null): Promise<void> {
    if (!workflowRunId) return;

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

    if (parentTask.status === 'cancelled' || parentTask.status === 'archived') {
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

    const agentSession = AgentSession.restore(
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

    const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

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

    agentSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
      await this.mcpSelfHeal(cbSessionId, missing);
    };

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

    await agentSession.startStreamingQuery();
    await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);

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

    const sdkUserMessage: SDKUserMessage & { isSynthetic: boolean } = {
      type: 'user' as const,
      uuid: messageId as UUID,
      session_id: sessionId,
      parent_tool_use_id: null,
      isSynthetic: isSyntheticMessage,
      message: {
        role: 'user' as const,
        content: sdkContent,
      },
    };

    const v2Enabled = isMessageDeliveryV2Enabled();
    const existing = v2Enabled
      ? this.config.db.getSDKMessageRepo().getDeliveryContent(sessionId, messageId)
      : null;
    if (existing?.sendStatus === 'consumed') {
      return messageId;
    }
    if (existing?.sendStatus === 'failed') {
      this.config.db.getSDKMessageRepo().reopenDeliveryByUuid(sessionId, messageId);
    }

    const inRateLimitCooldown = state.status === 'rate_limit_cooldown';
    const parentTaskId = this.findParentTaskIdForSubSession(sessionId);
    const parentTask = parentTaskId ? this.config.taskRepo.getTask(parentTaskId) : null;
    const parentLimited = parentTask ? isRateOrUsageLimited(parentTask.status) : false;
    if ((deliveryMode === 'defer' && isBusy) || inRateLimitCooldown || parentLimited) {
      if (v2Enabled && existing && existing.sendStatus !== 'deferred') {
        this.config.db.getSDKMessageRepo().markDeliveryDeferredByUuid(sessionId, messageId);
      }
      const dbId = existing
        ? messageId
        : this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'deferred', origin);
      return dbId;
    }

    const hasPriorContext = !!session.session.sdkSessionId;
    const shouldClearContext =
      inputKind === 'task' &&
      !isBusy &&
      hasPriorContext &&
      this.slotResetsContextForSession(sessionId) &&
      !this.hasActiveDeliveryJob(sessionId);
    if (shouldClearContext) {
      try {
        await session.clearConversationContext();
      } catch (err) {
        log.warn(
          `TaskAgentManager: resetContextPerTurn clear failed for session ${sessionId}: ` +
            `${err instanceof Error ? err.message : String(err)} — delivering without clear`
        );
      }
    }

    if (v2Enabled) {
      const dbId = existing
        ? messageId
        : this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued', origin);
      const sdkMessageRepo = this.config.db.getSDKMessageRepo();
      await awaitDeliveryConsumption({
        sessionId,
        messageUuid: messageId,
        timeoutMs: deliveryConsumptionTimeoutMs(session.getSessionData?.().config?.provider),
        deliver: () =>
          deliverAndMarkQueued({
            jobQueue: this.config.db.getJobQueueRepo(),
            stateManager: session.stateManager,
            sessionId,
            messageUuid: messageId,
            origin: 'space_inject',
            onEnqueueFailure: () => sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageId),
          }),
        ...(!existing
          ? {
              terminalizeOnTimeout: () =>
                sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageId),
            }
          : {}),
      });
      return dbId;
    }
    await session.ensureQueryStarted();
    const dbId = this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued', origin);
    await session.messageQueue.enqueueWithId(messageId, hasImages ? sdkContent : message);
    return dbId;
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

  async mcpSelfHeal(sessionId: string, missing: string[]): Promise<void> {
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

    const agentSession = this.agentSessionIndex.get(sessionId);
    if (!agentSession) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: AgentSession ${sessionId} not in memory — cannot self-heal`
      );
      return;
    }

    await this.ensureRequiredMcpServersAttached(agentSession, {
      taskId: parentTask.id,
      subSessionId: sessionId,
      agentName: execution.agentName,
      spaceId: parentTask.spaceId,
      workflowRunId: execution.workflowRunId,
      workspacePath: this.taskWorktreePaths.get(parentTask.id) ?? space.workspacePath,
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
      this.config.evolutionScopeService
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
      await this.injectMessageIntoSession(existing, kickoffMessage);
      log.info(
        `TaskAgentManager.spawnPostApprovalSubSession: reused live session ${existingSessionId} for agent "${matchedSlot.name}" (task ${taskId}, node ${matchedNodeId})`
      );
      return { sessionId: existingSessionId };
    }

    const workflowRunId = task.workflowRunId;
    const workflowRun = workflowRunId ? this.config.workflowRunRepo.getRun(workflowRunId) : null;

    const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

    const matchedNode = workflow.nodes.find((node) => node.id === matchedNodeId);
    const slotOverrides = buildSlotOverrides(matchedSlot, {
      task,
      node: matchedNode,
      workflow,
      workflowRun: workflowRun ?? undefined,
    });

    const baseSessionId = `space:${spaceId}:task:${taskId}:post-approval:${this.sanitizeAgentNameForId(matchedSlot.name)}`;
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
      agentId: matchedSlot.agentId,
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

    await this.injectMessageIntoSession(spawned, kickoffMessage);

    log.info(
      `TaskAgentManager.spawnPostApprovalSubSession: spawned session ${actualSessionId} for agent "${matchedSlot.name}" (task ${taskId}, node ${matchedNodeId})`
    );
    return { sessionId: actualSessionId };
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
