import type {
  AgentDefinition,
  McpServerConfig,
  Session,
  Space,
  SpaceGoalOutcomeNotification,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceWorkerAgent,
  SpaceWorkflowRun,
  UpdateSpaceTaskParams,
} from '@hyperneo/shared';
import { generateUUID, isRateOrUsageLimited, isScopedBashToolEntry } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import type { AgentMemoryRepository } from '../../../storage/repositories/agent-memory-repository.ts';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository.ts';
import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository.ts';
import type { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import type {
  SpaceAgentInboxMessageRecord,
  SpaceAgentInboxRepository,
} from '../../../storage/repositories/space-agent-inbox-repository.ts';
import type { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository.ts';
import type { SpaceGoalOutcomeNotificationRepository } from '../../../storage/repositories/space-goal-outcome-notification-repository.ts';
import { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository.ts';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
  type SpaceLongHorizonAgentRepository,
} from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceWorkflowEventSubscriptionRepository } from '../../../storage/repositories/space-workflow-event-subscription-repository.ts';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { AgentSession } from '../../agent/agent-session.ts';
import {
  awaitDeliveryConsumption,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
  isMessageDeliveryV2Enabled,
  withSessionResetCoordination,
} from '../../agent/message-delivery.ts';
import { createDbQueryMcpServer, type DbQueryMcpServer } from '../../db-query/tools.ts';
import type { ExternalEventService } from '../../external-events/external-event-service.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import {
  ExternalEventQueueMetrics,
  type QueueHealthSnapshot,
} from '../../external-events/queue-health-metrics.ts';
import type { DaemonCommandMap, InternalCommandBus } from '../../internal-command-bus.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import { Logger } from '../../logger.ts';
import { findInModels, getAvailableModels } from '../../model-service.ts';
import { inferPersistableProviderForModel } from '../../providers/registry.ts';
import type { SessionManager } from '../../session-manager.ts';
import { canonicalAgentHandle, SpaceActorRegistryAdapter } from '../actor-registry.ts';
import { resolveCustomAgentPrompt } from '../agents/custom-agent.ts';
import {
  LONG_HORIZON_AGENT_BUILTIN_TOOLS,
  LONG_HORIZON_OWNER_REVIEW_CONTRACT,
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
} from '../agents/long-horizon-agent-tools.ts';
import { buildSpaceChatSystemPrompt } from '../agents/space-chat-agent.ts';
import { deriveWorkerDisallowedTools } from '../agents/tool-policy.ts';
import { encodeActorIdComponent, longTermAgentSessionId } from '../long-term-agent-session.ts';
import type { SpaceAgentManager } from '../managers/space-agent-manager.ts';
import type { SpaceManager } from '../managers/space-manager.ts';
import { SpaceTaskManager } from '../managers/space-task-manager.ts';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager.ts';
import { SpaceMessageResolver } from '../messaging-adapter.ts';
import { createAgentMemoryMcpServer } from '../tools/agent-memory-tools.ts';
import { createSpaceAgentMcpServer } from '../tools/space-agent-tools.ts';
import type { WorkflowArtifactProfile } from './artifact-profile.ts';
import { ChannelRouter } from './channel-router.ts';
import type { SelectWorkflowWithLlm } from './llm-workflow-selector.ts';
import { selectWorkflowWithLlmDefault } from './llm-workflow-selector.ts';
import type { ReplyRoutingRegistry } from './reply-routing-registry.ts';
import {
  SpaceAgentNotificationService,
  type SpaceAgentNotificationServiceConfig,
} from './space-agent-notification-service.ts';
import {
  resolveSpaceMcpSessionPolicy,
  type SpaceMcpSessionPolicy,
} from './space-mcp-session-policy.ts';
import { SpaceRuntime } from './space-runtime.ts';
import type { TaskAgentManager } from './task-agent-manager.ts';
import { canTransition as canTransitionRunStatus } from './workflow-run-status-machine.ts';

const log = new Logger('space-runtime-service');

const LONG_TERM_AGENT_SESSION_FEATURES = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
} as const;

const DEFAULT_LONG_HORIZON_AGENT_MODEL = 'claude-sonnet-4-6';

type LongTermAgentDirectDelivery =
  | { state: 'delivered'; sessionId: string }
  | { state: 'recipient_stale' }
  | { state: 'failed' };

type LongTermAgentQueueing =
  | { state: 'delivered'; sessionId: string }
  | { state: 'queued'; messageId: string }
  | { state: 'recipient_stale' }
  | { state: 'undeliverable' };

export interface SpaceRuntimeServiceConfig {
  db: BunDatabase;
  dbPath?: string;
  spaceManager: SpaceManager;
  spaceAgentManager: SpaceAgentManager;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  spaceWorkflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  nodeExecutionRepo?: NodeExecutionRepository;
  workflowEventSubscriptionRepo?: SpaceWorkflowEventSubscriptionRepository;
  reactiveDb?: ReactiveDatabase;
  taskAgentManager?: TaskAgentManager;
  tickIntervalMs?: number;
  pendingMessageRepo?: PendingAgentMessageRepository;
  channelCycleRepo?: ChannelCycleRepository;
  sessionManager?: SessionManager;
  artifactRepo?: WorkflowRunArtifactRepository;
  artifactProfile?: WorkflowArtifactProfile;
  selectWorkflowWithLlm?: SelectWorkflowWithLlm;
  scheduleService?: import('../schedule/schedule-service.ts').ScheduleService;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  commandBus?: InternalCommandBus<DaemonCommandMap>;
  externalEventStore?: ExternalEventStore;
  queueHealthMetrics?: ExternalEventQueueMetrics;
  externalEventService?: ExternalEventService;
  replyRoutingRegistry?: ReplyRoutingRegistry;
  memoryRepo?: AgentMemoryRepository;
  actorRegistryRepos?: {
    spaceRepo: SpaceRepository;
    sessionRepo: SessionRepository;
    spaceAgentRepo: SpaceAgentRepository;
    longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
    workflowRepo: SpaceWorkflowRepository;
    workflowRunRepo: SpaceWorkflowRunRepository;
    nodeExecutionRepo: NodeExecutionRepository;
    pendingMessageRepo?: PendingAgentMessageRepository;
  };
  spaceAgentInboxRepo?: SpaceAgentInboxRepository;
  goalService?: import('../goals/goal-service.ts').SpaceGoalService;
  evolutionScopeService?: import('../evolution-scope-service.ts').EvolutionScopeService;
  evolutionEpisodeService?: import('../evolution-episode-service.ts').EvolutionEpisodeService;
  outcomeNotificationRepo?: SpaceGoalOutcomeNotificationRepository;
  enableGoalOutcomeWake?: boolean;
  inactivityConfigRepo?: import('../../../storage/repositories/space-agent-inactivity-repository.ts').SpaceAgentInactivityConfigRepository;
  inactivityClaimRepo?: import('../../../storage/repositories/space-agent-inactivity-repository.ts').SpaceAgentInactivityClaimRepository;
  inactivityRunNow?: (spaceId: string, agentId: string) => Promise<void>;
}

export class SpaceRuntimeService {
  private readonly runtime: SpaceRuntime;
  private readonly queueHealthMetrics: ExternalEventQueueMetrics;
  private started = false;
  private readonly unsubscribers: Array<() => void> = [];
  private taskAgentManager: TaskAgentManager | null = null;
  private readonly nodeExecutionRepo: NodeExecutionRepository;
  private readonly workflowEventSubscriptionRepo: SpaceWorkflowEventSubscriptionRepository;
  private readonly actorRegistry: SpaceActorRegistryAdapter | null;
  private readonly auditLogRepo: McpAuditLogRepository;
  private readonly spaceDbQueryServers = new Map<string, DbQueryMcpServer>();
  private readonly memberSessionDbQueryServers = new Map<string, DbQueryMcpServer>();
  private readonly longTermAgentDbQueryServers = new Map<string, DbQueryMcpServer>();
  private readonly spaceAgentNotificationUnsubs = new Map<string, () => void>();
  private readonly longTermAgentFlushes = new Map<string, Promise<void>>();
  private resumeStalledRecoveryPromise: Promise<void> = Promise.resolve();
  private provisioningPromise: Promise<void> | null = null;

  constructor(private readonly config: SpaceRuntimeServiceConfig) {
    this.nodeExecutionRepo =
      this.config.nodeExecutionRepo ??
      new NodeExecutionRepository(this.config.db, this.config.reactiveDb);
    this.workflowEventSubscriptionRepo =
      this.config.workflowEventSubscriptionRepo ??
      new SpaceWorkflowEventSubscriptionRepository(this.config.db);
    this.actorRegistry = config.actorRegistryRepos
      ? new SpaceActorRegistryAdapter(config.actorRegistryRepos)
      : null;
    this.auditLogRepo = new McpAuditLogRepository(this.config.db);
    this.queueHealthMetrics = config.queueHealthMetrics ?? new ExternalEventQueueMetrics();
    config.externalEventStore?.setDeliveryTerminalHook((event) =>
      this.queueHealthMetrics.recordDeliveryTerminal(event)
    );
    this.runtime = new SpaceRuntime({
      ...config,
      nodeExecutionRepo: this.nodeExecutionRepo,
      workflowEventSubscriptionRepo: this.workflowEventSubscriptionRepo,
      queueHealthMetrics: this.queueHealthMetrics,
      selectWorkflowWithLlm: config.selectWorkflowWithLlm ?? selectWorkflowWithLlmDefault,
      internalEventBus: config.internalEventBus,
      onTaskUpdated: async ({ spaceId, task, archiveSource, fromStatus }) => {
        try {
          this.config.goalService?.handleTaskTerminal(task.id, { fromStatus: fromStatus ?? null });
        } catch (err) {
          log.warn(`goal terminal handling failed for task ${task.id}:`, err);
        }
        if (!this.config.internalEventBus) return;
        await this.config.internalEventBus.publish('space.task.updated', {
          sessionId: 'global',
          spaceId,
          taskId: task.id,
          task,
          ...(archiveSource ? { archiveSource } : {}),
        });
      },
      onWorkflowRunCreated: async ({ spaceId, run }) => {
        if (!this.config.internalEventBus) return;
        await this.config.internalEventBus.publish('space.workflowRun.created', {
          sessionId: 'global',
          spaceId,
          runId: run.id,
          run,
        });
      },
      onWorkflowRunUpdated: async ({ spaceId, run }) => {
        if (!this.config.internalEventBus) return;
        await this.config.internalEventBus.publish('space.workflowRun.updated', {
          sessionId: 'global',
          spaceId,
          runId: run.id,
          run,
        });
      },
      deliverLongHorizonExternalEvent: (args) => this.deliverLongHorizonExternalEvent(args),
    });
  }

  private resolveMcpSessionPolicy(session: Session): SpaceMcpSessionPolicy {
    return resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: this.nodeExecutionRepo,
      taskRepo: this.config.taskRepo,
    });
  }

  setTaskAgentManager(manager: TaskAgentManager): void {
    this.taskAgentManager = manager;
    this.runtime.setTaskAgentManager(manager);
  }

  longTermAgentDeliveryCallbacks():
    | {
        deliverToSession: (actor: ActorRef, message: MessageRecord) => Promise<string | null>;
        queueForActivation: (actor: ActorRef, message: MessageRecord) => Promise<string | null>;
      }
    | undefined {
    if (!this.config.sessionManager) return undefined;
    return {
      deliverToSession: async (actor, message) => {
        const outcome = await this.deliverToLongTermAgent(actor, message);
        return outcome.state === 'delivered' ? outcome.sessionId : null;
      },
      queueForActivation: async (actor, message) => {
        const outcome = await this.queueLongTermAgentMessage(actor, message);
        if (outcome.state === 'delivered') return outcome.sessionId;
        return outcome.state === 'queued' ? outcome.messageId : null;
      },
    };
  }

  createMessageResolver(
    spaceId: string,
    context?: { workflowRunId?: string; nodeId?: string; agentName?: string }
  ): SpaceMessageResolver | undefined {
    if (!this.actorRegistry || !this.config.actorRegistryRepos) return undefined;
    return new SpaceMessageResolver(
      {
        actorRegistry: this.actorRegistry,
        workflowRepo: this.config.actorRegistryRepos.workflowRepo,
        workflowRunRepo: this.config.actorRegistryRepos.workflowRunRepo,
      },
      { spaceId, ...context }
    );
  }

  private async deliverLongHorizonExternalEvent(
    args: {
      spaceId: string;
      agentId: string;
      message: string;
      idempotencyKey: string;
    },
    options: { gateSpaceLifecycle?: boolean } = {}
  ): Promise<{ delivered: boolean }> {
    const gateLifecycle = options.gateSpaceLifecycle === true;
    const agent = this.config.longHorizonAgentRepo?.getById(args.agentId);
    if (!agent || agent.spaceId !== args.spaceId || agent.status !== 'active') {
      return { delivered: false };
    }
    if (gateLifecycle) {
      const spaceBefore = await this.config.spaceManager.getSpace(args.spaceId);
      if (
        !spaceBefore ||
        spaceBefore.status !== 'active' ||
        spaceBefore.paused ||
        spaceBefore.stopped
      ) {
        return { delivered: false };
      }
    }
    const session = await this.ensureLongHorizonAgentSession(args.spaceId, args.agentId);
    if (!session) return { delivered: false };
    if (gateLifecycle) {
      const space = await this.config.spaceManager.getSpace(args.spaceId);
      if (!space || space.status !== 'active' || space.paused || space.stopped) {
        return { delivered: false };
      }
      const freshAgent = this.config.longHorizonAgentRepo?.getById(args.agentId);
      if (!freshAgent || freshAgent.status !== 'active') {
        return { delivered: false };
      }
    }
    await this.injectLongTermAgentMessage(session, args.message, args.idempotencyKey);
    return { delivered: true };
  }

  async deliverLongHorizonAgentReminder(args: {
    spaceId: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
  }): Promise<{ delivered: boolean }> {
    return this.deliverLongHorizonExternalEvent(args, { gateSpaceLifecycle: true });
  }

  async deliverLongHorizonAgentNag(args: {
    spaceId: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
    expectedConfigRevision?: number | null;
  }): Promise<
    | 'consumed'
    | 'accepted'
    | 'terminal_failure'
    | 'terminal_failure_after_consumption'
    | 'pre_admission_failure'
  > {
    const agent = this.config.longHorizonAgentRepo?.getById(args.agentId);
    if (!agent || agent.spaceId !== args.spaceId || agent.status !== 'active') {
      return 'pre_admission_failure';
    }
    const space = await this.config.spaceManager.getSpace(args.spaceId);
    if (!space || space.status !== 'active' || space.paused || space.stopped) {
      return 'pre_admission_failure';
    }
    if (args.expectedConfigRevision !== undefined) {
      const config = this.config.inactivityConfigRepo?.getByAgent(args.spaceId, args.agentId);
      if (!config || !config.enabled || config.configRevision !== args.expectedConfigRevision) {
        return 'pre_admission_failure';
      }
    }
    const coordinator = this.config.longHorizonAgentRepo?.getCoordinator(args.spaceId);
    const isCoordinator =
      agent.id === coordinatorLongHorizonAgentId(args.spaceId) || coordinator?.id === agent.id;
    const session = isCoordinator
      ? ((await this.resolveCoordinatorSession(args.spaceId)) ??
        (await this.ensureCoordinatorSession(args.spaceId)))
      : await this.ensureLongHorizonAgentSession(args.spaceId, args.agentId);
    if (!session) return 'terminal_failure';
    const spaceAfter = await this.config.spaceManager.getSpace(args.spaceId);
    if (!spaceAfter || spaceAfter.status !== 'active' || spaceAfter.paused || spaceAfter.stopped) {
      return 'pre_admission_failure';
    }
    const agentAfter = this.config.longHorizonAgentRepo?.getById(args.agentId);
    if (!agentAfter || agentAfter.status !== 'active') return 'pre_admission_failure';
    const sessionState = session.stateManager?.getState().status as string | undefined;
    if (
      sessionState === 'processing' ||
      sessionState === 'queued' ||
      sessionState === 'running' ||
      sessionState === 'waiting_for_input' ||
      sessionState === 'rate_limit_cooldown'
    ) {
      return 'pre_admission_failure';
    }
    const sessionId = session.getSessionData().id;
    try {
      await this.injectLongTermAgentMessage(session, args.message, args.idempotencyKey, {
        terminalizeOnTimeout: false,
      });
      const row = this.config.reactiveDb?.db
        .getSDKMessageRepo()
        .getDeliveryContent(sessionId, args.idempotencyKey);
      if (row !== null && row !== undefined && row.sendStatus === 'failed') {
        return 'terminal_failure_after_consumption';
      }
      if (isMessageDeliveryV2Enabled()) return 'consumed';
      for (let i = 0; i < 10; i++) {
        const legacyRow = this.config.reactiveDb?.db
          .getSDKMessageRepo()
          .getDeliveryContent(sessionId, args.idempotencyKey);
        if (legacyRow === null || legacyRow === undefined) break;
        if (legacyRow.sendStatus === 'failed') {
          return 'terminal_failure_after_consumption';
        }
        if (legacyRow.sendStatus === 'consumed') {
          return 'consumed';
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return 'accepted';
    } catch {
      const row = this.config.reactiveDb?.db
        .getSDKMessageRepo()
        .getDeliveryContent(sessionId, args.idempotencyKey);
      return row !== null && row !== undefined && row.sendStatus !== 'failed'
        ? 'accepted'
        : 'terminal_failure';
    }
  }

  private async deliverToLongTermAgent(
    actor: ActorRef,
    message: MessageRecord
  ): Promise<LongTermAgentDirectDelivery> {
    if (!(await this.isGoalOutcomeWakeDeliverable(actor, message))) {
      return { state: 'recipient_stale' };
    }
    const session = await this.ensureLongTermAgentSession(actor);
    if (!session) return { state: 'failed' };
    if (!(await this.isGoalOutcomeWakeDeliverable(actor, message))) {
      return { state: 'recipient_stale' };
    }
    await this.injectLongTermAgentMessage(
      session,
      message.body,
      message.idempotencyKey ?? message.messageId
    );
    return { state: 'delivered', sessionId: session.getSessionData().id };
  }

  private async isGoalOutcomeWakeDeliverable(
    actor: ActorRef,
    message: MessageRecord
  ): Promise<boolean> {
    if (!message.idempotencyKey?.startsWith('goal-outcome:')) return true;
    const notificationId = message.idempotencyKey.slice('goal-outcome:'.length);
    const notification = this.config.outcomeNotificationRepo?.getById(notificationId);
    if (notification == null || notification.status !== 'pending') return false;
    const space = await this.config.spaceManager.getSpace(message.spaceId);
    if (!space || space.status !== 'active' || space.paused || space.stopped) return false;
    const goal = this.config.goalService?.getGoal(notification.goalId);
    if (!goal || goal.spaceId !== notification.spaceId) return false;
    const resolution = this.config.longHorizonAgentRepo?.getPrimaryGoalOwner(goal.id, goal.spaceId);
    let authorizedId: string | null = null;
    if (resolution?.action === 'resolved') {
      authorizedId = resolution.owner.agentId;
    } else if (resolution?.action === 'coordinator_fallback') {
      authorizedId = resolution.coordinatorAgentId;
    } else if (resolution?.action === 'degraded' || resolution?.action === 'no_recipient') {
      authorizedId = this.config.longHorizonAgentRepo?.getCoordinator(goal.spaceId)?.id ?? null;
    }
    return authorizedId != null && agentIdFromActorId(actor.actorId) === authorizedId;
  }

  async deliverGoalOutcomeWake(notification: SpaceGoalOutcomeNotification): Promise<void> {
    if (!this.config.enableGoalOutcomeWake) return;
    const maxRecipientReroutes = 3;
    for (let attempt = 0; attempt < maxRecipientReroutes; attempt += 1) {
      const shouldRetry = await this.deliverGoalOutcomeWakeToResolvedRecipient(notification);
      if (!shouldRetry) return;
      log.warn(
        `Goal outcome wake recipient went stale for notification "${notification.id}"; re-resolving recipient`
      );
    }
    log.warn(
      `Goal outcome wake recipient kept going stale for notification "${notification.id}"; leaving it pending for recovery`
    );
  }

  private async deliverGoalOutcomeWakeToResolvedRecipient(
    notification: SpaceGoalOutcomeNotification
  ): Promise<boolean> {
    if (this.config.outcomeNotificationRepo?.getById(notification.id)?.status !== 'pending') {
      return false;
    }
    const goal = this.config.goalService?.getGoal(notification.goalId);
    if (!goal || goal.spaceId !== notification.spaceId) return false;
    const resolution = this.config.longHorizonAgentRepo?.getPrimaryGoalOwner(goal.id, goal.spaceId);
    let targetAgentId: string | null = null;
    if (resolution?.action === 'resolved') {
      targetAgentId = resolution.owner.agentId;
    } else if (resolution?.action === 'coordinator_fallback') {
      targetAgentId = resolution.coordinatorAgentId;
    } else if (resolution?.action === 'degraded' || resolution?.action === 'no_recipient') {
      targetAgentId = this.config.longHorizonAgentRepo?.ensureCoordinator(goal.spaceId).id ?? null;
    }
    if (!targetAgentId) {
      log.warn(
        `Goal outcome wake has no owner or coordinator for notification "${notification.id}"`
      );
      return false;
    }
    const agent = this.config.longHorizonAgentRepo?.getById(targetAgentId);
    if (!agent) return false;
    const actor: ActorRef = {
      actorId: `agent:${encodeActorIdComponent(agent.id)}`,
      kind: 'agent',
      spaceId: goal.spaceId,
      handle: `@${agent.handle}`,
      roles: ['space-agent', 'coordinator'],
      status: 'inactive',
    };
    const { summary, taskStatus, taskTitle, goalTitle } = notification.payload;
    const detail = summary ? ` ${summary}` : '';
    const message: MessageRecord = {
      messageId: generateUUID(),
      spaceId: goal.spaceId,
      senderActorId: `agent:coordinator:${goal.spaceId}`,
      targets: [actor.actorId],
      body: `Goal outcome ready for review: "${goalTitle}". Task "${taskTitle}" reached ${taskStatus}.${detail}`,
      kind: 'message',
      taskId: notification.taskId,
      idempotencyKey: `goal-outcome:${notification.id}`,
      createdAt: Date.now(),
    };
    const routed = await this.queueLongTermAgentMessage(actor, message);
    return routed.state === 'recipient_stale';
  }

  private async queueLongTermAgentMessage(
    actor: ActorRef,
    message: MessageRecord
  ): Promise<LongTermAgentQueueing> {
    const inboxRepo = this.config.spaceAgentInboxRepo;
    const agentId = agentIdFromActorId(actor.actorId);
    if (!agentId) return { state: 'undeliverable' };
    const longHorizonAgent = this.config.longHorizonAgentRepo?.getById(agentId);
    if (longHorizonAgent?.spaceId === actor.spaceId) {
      const delivered = await this.deliverToLongTermAgent(actor, message);
      if (delivered.state === 'delivered') {
        return { state: 'delivered', sessionId: delivered.sessionId };
      }
      if (delivered.state === 'recipient_stale') return { state: 'recipient_stale' };
    }
    if (!inboxRepo) return { state: 'undeliverable' };
    const sourceSessionId = sourceSessionIdFromActorId(message.senderActorId);
    const { record } = inboxRepo.enqueue({
      spaceId: message.spaceId,
      targetAgentId: agentId,
      sourceActorId: message.senderActorId,
      sourceSessionId,
      message: message.body,
      messageRecordJson: JSON.stringify(message),
      idempotencyKey: message.idempotencyKey ?? message.messageId,
    });
    void this.activateLongTermAgentAndFlush(actor, record.id).catch((err) => {
      inboxRepo.markAttemptFailed(record.id, err instanceof Error ? err.message : String(err));
      log.warn(
        `Long-term Space agent activation failed for ${actor.actorId}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    return { state: 'queued', messageId: record.id };
  }

  private async activateLongTermAgentAndFlush(
    actor: ActorRef,
    queuedMessageId?: string
  ): Promise<void> {
    const space = await this.config.spaceManager.getSpace(actor.spaceId);
    if (!space || space.status !== 'active' || space.paused || space.stopped) return;
    const agentId = agentIdFromActorId(actor.actorId);
    const lockKey = agentId ? `${actor.spaceId}:${agentId}` : actor.actorId;
    const previous = this.longTermAgentFlushes.get(lockKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        const session = await this.ensureLongTermAgentSession(actor);
        if (!session) return;
        const resumed = await this.config.spaceManager.getSpace(actor.spaceId);
        if (!resumed || resumed.status !== 'active' || resumed.paused || resumed.stopped) return;
        await this.flushLongTermAgentInbox(actor, session, queuedMessageId);
      });
    this.longTermAgentFlushes.set(lockKey, current);
    try {
      await current;
    } finally {
      if (this.longTermAgentFlushes.get(lockKey) === current) {
        this.longTermAgentFlushes.delete(lockKey);
      }
    }
  }

  private async flushLongTermAgentInbox(
    actor: ActorRef,
    session: {
      getSessionData(): Session;
      ensureQueryStarted(): Promise<void>;
      messageQueue: { enqueueWithId: (id: string, message: string) => Promise<void> };
    },
    preferredMessageId?: string
  ): Promise<void> {
    const inboxRepo = this.config.spaceAgentInboxRepo;
    if (!inboxRepo) return;
    const agentId = agentIdFromActorId(actor.actorId);
    if (!agentId) return;
    inboxRepo.expireStale(actor.spaceId);
    const pending = inboxRepo.listPendingForAgent(actor.spaceId, agentId);
    const ordered = preferredMessageId
      ? [
          ...pending.filter((row) => row.id === preferredMessageId),
          ...pending.filter((row) => row.id !== preferredMessageId),
        ]
      : pending;
    for (const row of ordered) {
      try {
        if (this.isGoalOutcomeWakeStale(row)) {
          inboxRepo.markDelivered(row.id, session.getSessionData().id);
          continue;
        }
        await this.injectLongTermAgentMessage(session, row.message, row.idempotencyKey ?? row.id);
        inboxRepo.markDelivered(row.id, session.getSessionData().id);
      } catch (err) {
        inboxRepo.markAttemptFailed(row.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private isGoalOutcomeWakeStale(row: SpaceAgentInboxMessageRecord): boolean {
    if (!row.idempotencyKey?.startsWith('goal-outcome:')) return false;
    const notificationId = row.idempotencyKey.slice('goal-outcome:'.length);
    const notification = this.config.outcomeNotificationRepo?.getById(notificationId);
    if (notification == null || notification.status !== 'pending') return true;
    const goal = this.config.goalService?.getGoal(notification.goalId);
    if (!goal || goal.spaceId !== notification.spaceId) return true;
    const resolution = this.config.longHorizonAgentRepo?.getPrimaryGoalOwner(goal.id, goal.spaceId);
    let targetAgentId: string | null = null;
    if (resolution?.action === 'resolved') {
      targetAgentId = resolution.owner.agentId;
    } else if (resolution?.action === 'coordinator_fallback') {
      targetAgentId = resolution.coordinatorAgentId;
    } else if (resolution?.action === 'degraded' || resolution?.action === 'no_recipient') {
      targetAgentId = this.config.longHorizonAgentRepo?.getCoordinator(goal.spaceId)?.id ?? null;
    }
    return targetAgentId == null || row.targetAgentId !== targetAgentId;
  }

  private async injectLongTermAgentMessage(
    session: {
      getSessionData(): Session;
      ensureQueryStarted(): Promise<void>;
      messageQueue: { enqueueWithId: (id: string, message: string) => Promise<void> };
      stateManager?: {
        setQueuedIfIdle(messageId: string): Promise<boolean>;
        getState(): { status: string };
      };
    },
    message: string,
    messageId?: string,
    options: { terminalizeOnTimeout?: boolean } = {}
  ): Promise<string> {
    const id = messageId ?? generateRuntimeMessageId();
    const sessionId = session.getSessionData().id;
    const sdkUserMessage: SDKUserMessage & { isSynthetic: boolean } = {
      type: 'user' as const,
      uuid: id as UUID,
      session_id: sessionId,
      parent_tool_use_id: null,
      isSynthetic: true,
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: message }],
      },
    };
    const reactiveDb = this.config.reactiveDb?.db;
    if (!reactiveDb) {
      throw new Error(
        `injectLongTermAgentMessage: reactiveDb unavailable; cannot deliver to ${sessionId}`
      );
    }
    if (isMessageDeliveryV2Enabled()) {
      const sdkMessageRepo = reactiveDb.getSDKMessageRepo();
      const existing = sdkMessageRepo.getDeliveryContent(sessionId, id);
      const fresh = !existing;
      if (!existing) {
        const dbId = reactiveDb.saveUserMessage(sessionId, sdkUserMessage, 'enqueued');
        await this.publishMessageStatusChanged(sessionId, dbId, 'enqueued');
      } else if (existing.sendStatus === 'consumed') {
        return id;
      } else if (existing.sendStatus === 'failed') {
        const reopenedDbId = sdkMessageRepo.reopenDeliveryByUuid(sessionId, id);
        if (reopenedDbId) {
          await this.publishMessageStatusChanged(sessionId, reopenedDbId, 'enqueued');
        }
      }
      await awaitDeliveryConsumption({
        sessionId,
        messageUuid: id,
        timeoutMs: deliveryConsumptionTimeoutMs(session.getSessionData?.().config?.provider),
        deliver: () =>
          withSessionResetCoordination(sessionId, async () =>
            deliverAndMarkQueued({
              jobQueue: reactiveDb.getJobQueueRepo(),
              stateManager: session.stateManager,
              sessionId,
              messageUuid: id,
              origin: 'long_term_agent',
              onEnqueueFailure: () => {
                const failedDbId = sdkMessageRepo.markDeliveryFailedByUuid(sessionId, id);
                if (failedDbId) {
                  void this.publishMessageStatusChanged(sessionId, failedDbId, 'failed');
                }
              },
            })
          ),
        ...(fresh && options.terminalizeOnTimeout !== false
          ? {
              terminalizeOnTimeout: () => {
                const failedDbId = sdkMessageRepo.markDeliveryFailedByUuid(sessionId, id);
                if (failedDbId) {
                  void this.publishMessageStatusChanged(sessionId, failedDbId, 'failed');
                }
              },
            }
          : {}),
      });
    } else {
      await session.ensureQueryStarted();
      const dbId = reactiveDb.saveUserMessage(sessionId, sdkUserMessage, 'enqueued');
      await this.publishMessageStatusChanged(sessionId, dbId, 'enqueued');
      await session.messageQueue.enqueueWithId(id, message);
    }
    return id;
  }

  private async publishMessageStatusChanged(
    sessionId: string,
    dbId: string,
    status: 'enqueued' | 'deferred' | 'failed'
  ): Promise<void> {
    if (!this.config.internalEventBus) {
      return;
    }
    await this.config.internalEventBus
      .publish('messages.statusChanged', {
        sessionId,
        messageIds: [dbId],
        status,
      })
      .catch(() => {});
  }

  private async buildLongHorizonAgentSessionConfig(
    space: Space,
    agent: SpaceLongHorizonAgent,
    currentProvider?: string,
    currentModel?: string
  ): Promise<Partial<Session['config']>> {
    const customTools = Array.isArray(agent.toolPermissions.tools)
      ? (agent.toolPermissions.tools.filter((tool) => typeof tool === 'string') as string[])
      : undefined;
    const customDisallowedBuiltins = deriveWorkerDisallowedTools(customTools);
    const scopedBashToolEntries = customTools?.filter((tool) => isScopedBashToolEntry(tool));
    const agentKey = sanitizeLongTermAgentKey(agent.displayName);

    const model =
      agent.model ??
      space.defaultModel ??
      (agent.provider ? undefined : DEFAULT_LONG_HORIZON_AGENT_MODEL);
    const provider = (agent.provider ??
      (model
        ? await resolveAgentConfigProvider(model, currentProvider, currentModel)
        : undefined)) as Session['config']['provider'];
    const instructions = agent.instructions?.trim();
    const systemPromptAppend = instructions
      ? `${instructions}\n\n${LONG_HORIZON_OWNER_REVIEW_CONTRACT}\n\n${LONG_HORIZON_SCHEDULING_GUARDRAIL}`
      : `${LONG_HORIZON_OWNER_REVIEW_CONTRACT}\n\n${LONG_HORIZON_SCHEDULING_GUARDRAIL}`;
    return {
      model,
      provider,
      thinkingLevel: agent.thinkingLevel ?? undefined,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemPromptAppend,
      },
      sdkToolsPreset: [...LONG_HORIZON_AGENT_BUILTIN_TOOLS],
      features: LONG_TERM_AGENT_SESSION_FEATURES,
      allowedTools:
        scopedBashToolEntries && scopedBashToolEntries.length > 0
          ? scopedBashToolEntries
          : undefined,
      disallowedTools: customDisallowedBuiltins.length > 0 ? customDisallowedBuiltins : undefined,
      agent: customDisallowedBuiltins.length > 0 ? agentKey : undefined,
      agents:
        customDisallowedBuiltins.length > 0
          ? {
              [agentKey]: {
                description: `Long-horizon Space agent: ${agent.displayName}`,
                disallowedTools: customDisallowedBuiltins,
                model: 'inherit',
                prompt: agent.instructions,
              } satisfies AgentDefinition,
            }
          : undefined,
      settingSources: agent.settingSources ?? space.settingSources,
    };
  }

  private async refreshLongHorizonAgentSessionConfig(
    session: AgentSession,
    config: Partial<Session['config']>
  ): Promise<void> {
    const currentConfig = session.getSessionData().config;
    const updates: Partial<Session['config']> = {
      model: config.model,
      provider: config.provider,
      thinkingLevel: config.thinkingLevel,
      systemPrompt: config.systemPrompt,
      features: config.features,
      sdkToolsPreset: config.sdkToolsPreset,
      allowedTools: config.allowedTools,
      disallowedTools: config.disallowedTools,
      agent: config.agent,
      agents: config.agents,
      settingSources: config.settingSources,
    };
    const changed = Object.entries(updates).some(
      ([key, value]) =>
        JSON.stringify(currentConfig[key as keyof Session['config']]) !== JSON.stringify(value)
    );
    if (!changed) return;
    await session.updateConfig(updates);
    const result = await session.resetQuery({ restartQuery: true });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to refresh long-horizon agent session');
    }
  }

  private async resolveCoordinatorSession(spaceId: string) {
    const sessionManager = this.config.sessionManager;
    if (!sessionManager) return null;
    return sessionManager.getSessionAsync(coordinatorSessionId(spaceId));
  }

  private async ensureCoordinatorSession(spaceId: string) {
    const sessionManager = this.config.sessionManager;
    if (!sessionManager) return null;
    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) return null;
    const sessionId = coordinatorSessionId(spaceId);
    let session = await sessionManager.getSessionAsync(sessionId);
    if (!session) {
      try {
        await sessionManager.createSession({
          sessionId,
          title: space.name,
          workspacePath: space.workspacePath,
          config: { model: space.defaultModel },
          sessionType: 'space_chat',
          spaceId: space.id,
        });
        await this.config.spaceManager.addSession(space.id, sessionId);
      } catch (err) {
        session = await sessionManager.getSessionAsync(sessionId);
        if (!session) throw err;
      }
      session = session ?? (await sessionManager.getSessionAsync(sessionId));
      if (!session) return null;
    }
    await this.setupSpaceAgentSession(space);
    return session;
  }

  private async ensureLongHorizonAgentSession(spaceId: string, agentId: string) {
    const sessionManager = this.config.sessionManager;
    const repo = this.config.longHorizonAgentRepo;
    if (!sessionManager || !repo) return null;
    const agent = repo.getById(agentId);
    if (!agent || agent.spaceId !== spaceId || agent.status !== 'active') return null;
    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) return null;
    const sessionId = longTermAgentSessionId(spaceId, agentId);
    let session = await sessionManager.getSessionAsync(sessionId);
    const currentConfig = session?.getSessionData().config;
    const config = await this.buildLongHorizonAgentSessionConfig(
      space,
      agent,
      currentConfig?.provider,
      currentConfig?.model
    );
    if (!session) {
      try {
        await sessionManager.createSession({
          sessionId,
          workspacePath: space.workspacePath,
          title: agent.displayName,
          spaceId: space.id,
          worktreeMode: 'direct',
          config,
        });
      } catch (err) {
        session = await sessionManager.getSessionAsync(sessionId);
        if (!session) throw err;
      }
      session = session ?? (await sessionManager.getSessionAsync(sessionId));
      if (!session) return null;
    } else {
      await this.refreshLongHorizonAgentSessionConfig(session, config);
    }
    if (agent.sessionId !== sessionId) repo.update(agent.id, { sessionId });
    const currentMetadata = session.getSessionData().metadata;
    this.config.actorRegistryRepos?.sessionRepo.updateSession(sessionId, {
      metadata: {
        ...currentMetadata,
        promptProvenance: {
          source: agent.templateKey ?? 'long_horizon_agent',
          hash: agent.id,
          agentId: agent.id,
          agentName: agent.displayName,
        },
      },
    });
    this.attachLongTermAgentMcpServers(
      session,
      space,
      agent.displayName,
      sessionId,
      null,
      agentId,
      [`@${agent.handle}`]
    );
    return session;
  }

  private async ensureLongTermAgentSession(actor: ActorRef) {
    const sessionManager = this.config.sessionManager;
    if (!sessionManager) return null;
    const agentId = agentIdFromActorId(actor.actorId);
    if (!agentId) return null;
    const longHorizonAgent = this.config.longHorizonAgentRepo?.getById(agentId);
    if (longHorizonAgent?.spaceId === actor.spaceId) {
      const coordinator = this.config.longHorizonAgentRepo?.getCoordinator(actor.spaceId);
      if (
        longHorizonAgent.id === coordinatorLongHorizonAgentId(actor.spaceId) ||
        coordinator?.id === longHorizonAgent.id
      ) {
        if (longHorizonAgent.status !== 'active') return null;
        return this.resolveCoordinatorSession(actor.spaceId);
      }
      return this.ensureLongHorizonAgentSession(actor.spaceId, agentId);
    }
    const agent = this.config.spaceAgentManager.getById(agentId);
    if (!agent || agent.spaceId !== actor.spaceId) return null;
    const space = await this.config.spaceManager.getSpace(actor.spaceId);
    if (!space) return null;
    const sessionId = longTermAgentSessionId(actor.spaceId, agentId);
    let session = await sessionManager.getSessionAsync(sessionId);
    const created = !session;
    const resolvedPrompt = resolveCustomAgentPrompt(agent, {
      resolutionContext: { agentId: agent.id, agentName: agent.name },
    });
    const customTools = agent.tools;
    const customDisallowedBuiltins = deriveWorkerDisallowedTools(customTools);
    const agentKey = sanitizeLongTermAgentKey(agent.name);
    const model = agent.model ?? space.defaultModel;
    const currentConfig = session?.getSessionData().config;
    const provider = (agent.provider ??
      (model
        ? await resolveAgentConfigProvider(model, currentConfig?.provider, currentConfig?.model)
        : undefined)) as Session['config']['provider'];
    const regularAgentConfig: Partial<Session['config']> = {
      model,
      provider,
      thinkingLevel: agent.thinkingLevel,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: resolvedPrompt.value,
      },
      features: LONG_TERM_AGENT_SESSION_FEATURES,
      sdkToolsPreset: undefined,
      allowedTools: undefined,
      disallowedTools: customDisallowedBuiltins.length > 0 ? customDisallowedBuiltins : undefined,
      agent: customDisallowedBuiltins.length > 0 ? agentKey : undefined,
      agents:
        customDisallowedBuiltins.length > 0
          ? {
              [agentKey]: {
                description: agent.description ?? `Space agent: ${agent.name}`,
                disallowedTools: customDisallowedBuiltins,
                model: 'inherit',
                prompt: resolvedPrompt.value,
              } satisfies AgentDefinition,
            }
          : undefined,
      settingSources: agent.settingSources ?? space.settingSources,
    };
    if (!session) {
      try {
        await sessionManager.createSession({
          sessionId,
          workspacePath: space.workspacePath,
          title: agent.name,
          spaceId: space.id,
          worktreeMode: 'direct',
          config: regularAgentConfig,
        });
      } catch (err) {
        session = await sessionManager.getSessionAsync(sessionId);
        if (!session) throw err;
      }
      session = session ?? (await sessionManager.getSessionAsync(sessionId));
      if (!session) return null;
      const currentMetadata = session.getSessionData().metadata;
      this.config.actorRegistryRepos?.sessionRepo.updateSession(sessionId, {
        metadata: {
          ...currentMetadata,
          promptProvenance: {
            source: resolvedPrompt.source,
            hash: resolvedPrompt.hash,
            agentId: agent.id,
            agentName: agent.name,
          },
        },
      });
    } else {
      await session.updateConfig(regularAgentConfig);
      await session.resetQuery({ restartQuery: true });
    }
    if (created || this.missingLongTermAgentMcpServers(session)) {
      this.attachLongTermAgentMcpServers(session, space, agent.name, sessionId, agent, agentId);
    }
    return session;
  }

  private async attachLongTermAgentMcpServersForSession(
    session: Session,
    options: { replayPendingMessages?: boolean } = {}
  ): Promise<void> {
    const { sessionManager } = this.config;
    if (!sessionManager) return;
    const policy = this.resolveMcpSessionPolicy(session);
    if (!policy.attachLongTermAgentTools || !policy.spaceId) return;
    const agentId = session.metadata.promptProvenance?.agentId;
    if (!agentId) return;
    const [space, agentSession, persistedAgent, longHorizonAgent] = await Promise.all([
      this.config.spaceManager.getSpace(policy.spaceId),
      sessionManager.getSessionAsync(session.id),
      this.config.actorRegistryRepos?.spaceAgentRepo.getById(agentId) ?? null,
      this.config.longHorizonAgentRepo?.getById(agentId) ?? null,
    ]);
    if (!space) {
      log.warn(
        `attachLongTermAgentMcpServersForSession: space "${policy.spaceId}" not found (session ${session.id})`
      );
      return;
    }
    if (!agentSession) {
      log.warn(
        `attachLongTermAgentMcpServersForSession: agent session not found for ${session.id}`
      );
      return;
    }
    const agentName =
      session.metadata.promptProvenance?.agentName ??
      longHorizonAgent?.displayName ??
      persistedAgent?.name ??
      'Space Agent';
    const agentHandleAliases = longHorizonAgent ? [`@${longHorizonAgent.handle}`] : undefined;
    this.attachLongTermAgentMcpServers(
      agentSession,
      space,
      agentName,
      session.id,
      persistedAgent,
      agentId,
      agentHandleAliases
    );
    agentSession.onMissingMemberSpaceMcpServers = async (_sessionId, missing) => {
      log.warn(
        `Long-term Space agent session ${session.id} missing MCP servers [${missing.join(', ')}]; re-attaching space-agent-tools before query start`
      );
      await this.attachLongTermAgentMcpServersForSession(session, {
        replayPendingMessages: false,
      });
    };
    if (options.replayPendingMessages !== false) {
      await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);
    }
  }

  private attachLongTermAgentMcpServers(
    session: {
      mergeRuntimeMcpServers(mcpServers: Record<string, McpServerConfig>): void;
    },
    space: Space,
    agentName: string,
    sessionId: string,
    agent: SpaceWorkerAgent | null,
    agentId: string | null,
    agentHandleAliases?: string[]
  ): void {
    const mcpServers: Record<string, McpServerConfig> = {
      'space-agent-tools': this.buildLongTermAgentMcpServer(
        space,
        agentName,
        sessionId,
        agent,
        agentId,
        agentHandleAliases
      ) as unknown as McpServerConfig,
    };
    if (this.config.memoryRepo) {
      mcpServers['agent-memory'] = createAgentMemoryMcpServer({
        spaceId: space.id,
        memoryRepo: this.config.memoryRepo,
        mySessionId: sessionId,
      }) as unknown as McpServerConfig;
    }
    if (this.config.dbPath) {
      this.releaseLongTermAgentDbQuery(sessionId);
      const dbQueryServer = createDbQueryMcpServer({
        dbPath: this.config.dbPath,
        scopeType: 'space',
        scopeValue: space.id,
      });
      this.longTermAgentDbQueryServers.set(sessionId, dbQueryServer);
      mcpServers['db-query'] = dbQueryServer as unknown as McpServerConfig;
    }
    session.mergeRuntimeMcpServers(mcpServers);
  }

  private missingLongTermAgentMcpServers(session: { getSessionData(): Session }): boolean {
    const current = session.getSessionData().config?.mcpServers;
    return !current?.['space-agent-tools'];
  }

  private releaseLongTermAgentDbQuery(sessionId: string): void {
    const server = this.longTermAgentDbQueryServers.get(sessionId);
    if (!server) return;
    try {
      server.close();
    } catch (err) {
      log.warn(`Failed to close db-query server for long-term agent session ${sessionId}:`, err);
    }
    this.longTermAgentDbQueryServers.delete(sessionId);
  }

  private buildLongTermAgentMcpServer(
    space: Space,
    agentName: string,
    sessionId: string,
    agent: SpaceWorkerAgent | null,
    agentId: string | null,
    agentHandleAliases?: string[]
  ) {
    const agents = this.config.spaceAgentManager.listBySpaceId(space.id);
    const agentHandle = agent ? canonicalAgentHandle(agents, agent) : undefined;
    const aliases = agentHandleAliases ?? (agentHandle ? [agentHandle] : undefined);
    return createSpaceAgentMcpServer({
      spaceId: space.id,
      db: this.config.db,
      longHorizonAgentRepo: this.config.longHorizonAgentRepo,
      runtime: this.runtime,
      workflowManager: this.config.spaceWorkflowManager,
      spaceManager: this.config.spaceManager,
      taskRepo: this.config.taskRepo,
      nodeExecutionRepo: this.nodeExecutionRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      isWorkflowRunActive: (runId: string) => this.isWorkflowRunActive(runId),
      taskManager: new SpaceTaskManager(
        this.config.db,
        space.id,
        this.config.reactiveDb,
        this.config.evolutionScopeService,
        (taskId) => this.config.goalService?.supersedeOutcomeNotificationsForTask(taskId),
        (taskId, fromStatus) =>
          this.config.goalService?.handleTaskTerminal(taskId, {
            fromStatus,
            deferPostCommitEffects: true,
          })
      ),
      spaceAgentManager: this.config.spaceAgentManager,
      sessionManager: this.config.sessionManager,
      clearLongTermAgentSessionProvider: (sid, aid) =>
        this.clearLongTermAgentSessionProvider(sid, aid),
      getRuntimeSession: (sid) =>
        this.taskAgentManager?.getCachedAgentSessionById(sid) ?? undefined,
      taskAgentManager: this.taskAgentManager ?? undefined,
      internalEventBus: this.config.internalEventBus,
      pendingMessageQueue: this.config.pendingMessageRepo,
      getSpaceAutonomyLevel: async (sid) => {
        const s = await this.config.spaceManager.getSpace(sid);
        return s?.autonomyLevel ?? 1;
      },
      myAgentName: agentName,
      myAgentNameAliases: aliases,
      myAgentId: agentId ?? undefined,
      mySessionId: sessionId,
      callerRole: 'long_term_agent',
      auditLogRepo: this.auditLogRepo,
      scheduleService: this.config.scheduleService,
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
      goalRepo: new SpaceGoalRepository(this.config.db),
      evolutionEpisodeService: this.config.evolutionEpisodeService,
      replyRoutingRegistry: this.config.replyRoutingRegistry,
      messageResolver: this.createMessageResolver(space.id),
      longTermAgentDelivery: this.longTermAgentDeliveryCallbacks(),
      externalEventStore: this.config.externalEventStore,
      inactivityConfigRepo:
        agentId !== null && this.config.longHorizonAgentRepo?.getById(agentId)
          ? this.config.inactivityConfigRepo
          : undefined,
      inactivityClaimRepo:
        agentId !== null && this.config.longHorizonAgentRepo?.getById(agentId)
          ? this.config.inactivityClaimRepo
          : undefined,
      inactivityRunNow:
        agentId !== null && this.config.longHorizonAgentRepo?.getById(agentId)
          ? this.config.inactivityRunNow
          : undefined,
    });
  }

  registerSubscription(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    topic: string
  ): { success: boolean; error?: string } {
    return this.runtime.registerSubscription(workflowRunId, taskId, nodeId, agentName, topic);
  }

  unregisterSubscription(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    topic: string
  ): { success: boolean; error?: string } {
    return this.runtime.unregisterSubscription(workflowRunId, taskId, nodeId, agentName, topic);
  }

  listSubscriptions(
    workflowRunId: string,
    spaceId: string,
    nodeId?: string
  ): ReturnType<SpaceRuntime['listSubscriptions']> {
    return this.runtime.listSubscriptions(workflowRunId, spaceId, nodeId);
  }

  async stopActiveWork(spaceId: string): Promise<void> {
    const { taskRepo } = this.config;

    this.runtime.holdSpaceDeliveries(spaceId);

    const cleanupTaskIds = new Set(
      taskRepo
        .listBySpace(spaceId)
        .filter(
          (t) => t.status === 'in_progress' || t.status === 'open' || isRateOrUsageLimited(t.status)
        )
        .map((t) => t.id)
    );
    if (this.taskAgentManager) {
      for (const taskId of this.taskAgentManager.listLiveSessionTaskIdsForSpace(spaceId)) {
        cleanupTaskIds.add(taskId);
      }
    }

    let verifiedTotal = 0;
    let verifiedStopped = 0;
    if (this.taskAgentManager) {
      try {
        const sessionIds = this.taskAgentManager.getSubSessionIdsForTasks([...cleanupTaskIds]);
        const results = await this.taskAgentManager.stopSessionsVerified(sessionIds);
        verifiedTotal = results.length;
        verifiedStopped = results.filter((result) => result.stopped).length;
        const failures = results.filter((result) => !result.stopped);
        if (failures.length > 0) {
          log.warn(
            `stopActiveWork: ${failures.length}/${results.length} session(s) for space ${spaceId} not confirmed stopped: ` +
              failures
                .map((failure) => `${failure.sessionId} (${failure.detail ?? 'unknown reason'})`)
                .join('; ')
          );
        }
      } catch (err) {
        log.error(`stopActiveWork: verified session stop failed for space ${spaceId}:`, err);
      }
    }

    await Promise.allSettled(
      [...cleanupTaskIds].map(async (taskId) => {
        if (!this.taskAgentManager) return;
        await this.taskAgentManager.cleanup(taskId, 'stopped').catch((err: unknown) => {
          log.warn(`stopActiveWork: failed to cleanup agent session for task ${taskId}:`, err);
        });
      })
    );

    this.runtime.parkInFlightExecutionsForSpace(spaceId);

    log.info(
      `stopActiveWork: verified-stopped ${verifiedStopped}/${verifiedTotal} session(s) across ${cleanupTaskIds.size} task(s) and parked in-flight executions for space ${spaceId} — task/run statuses preserved`
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.runtime.start();
    this.subscribeToSpaceEvents();
    this.provisioningPromise = (async () => {
      await this.provisionExistingSpaces();
      await this.recoverLongTermAgentInbox();
      await this.recoverPendingOutcomeNotifications();
      await this.recoverStalledWorkflowRuns();
    })().catch((err) => {
      log.error('Failed to provision existing spaces during startup:', err);
    });
    log.info('SpaceRuntimeService started');
  }

  async recoverStalledWorkflowRuns(): Promise<void> {
    try {
      await this.runtime.recoverStalledRuns();
    } catch (err) {
      log.error('SpaceRuntimeService: recoverStalledWorkflowRuns failed:', err);
    }
  }

  recoverStalledWorkflowRunsAfterSpaceResume(spaceId: string): void {
    this.resumeStalledRecoveryPromise = this.resumeStalledRecoveryPromise
      .catch(() => {})
      .then(async () => {
        try {
          await this.runtime.recoverStalledRunsForSpace(spaceId);
        } catch (err) {
          log.error(
            `SpaceRuntimeService: recoverStalledWorkflowRuns after space resume failed for ${spaceId}:`,
            err
          );
        }
      });
  }

  recoverLongTermAgentInboxForSpace(spaceId: string): void {
    const inboxRepo = this.config.spaceAgentInboxRepo;
    if (!inboxRepo) return;
    try {
      inboxRepo.expireStale(spaceId);
      for (const row of inboxRepo.listPendingForSpace(spaceId)) {
        const workerAgent = this.config.spaceAgentManager.getById(row.targetAgentId);
        const longHorizonAgent = this.config.longHorizonAgentRepo?.getById(row.targetAgentId);
        if (workerAgent?.spaceId !== spaceId && longHorizonAgent?.spaceId !== spaceId) continue;
        void this.activateLongTermAgentAndFlush(
          {
            actorId: `agent:${encodeActorIdComponent(row.targetAgentId)}`,
            kind: 'agent',
            spaceId,
            roles: ['space-agent'],
            status: 'inactive',
          },
          row.id
        ).catch((err) => {
          inboxRepo.markAttemptFailed(row.id, err instanceof Error ? err.message : String(err));
          log.warn(
            `Long-term Space agent inbox recovery failed for ${row.targetAgentId}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    } catch (err) {
      log.error(`SpaceRuntimeService: recoverLongTermAgentInbox failed for ${spaceId}:`, err);
    }
  }

  private async recoverLongTermAgentInbox(): Promise<void> {
    const inboxRepo = this.config.spaceAgentInboxRepo;
    if (!inboxRepo) return;
    try {
      inboxRepo.expireStale();
      for (const space of await this.config.spaceManager.listSpaces()) {
        this.recoverLongTermAgentInboxForSpace(space.id);
      }
    } catch (err) {
      log.error('SpaceRuntimeService: recoverLongTermAgentInbox failed:', err);
    }
  }

  async recoverPendingOutcomeNotificationsForSpace(spaceId: string): Promise<void> {
    const repo = this.config.outcomeNotificationRepo;
    if (!repo || !this.config.enableGoalOutcomeWake) return;
    try {
      if (!(await this.isSpaceWakeable(spaceId))) return;
      for (const notification of repo.listPendingBySpace(spaceId)) {
        void this.deliverGoalOutcomeWake(notification).catch((err) => {
          log.warn(
            `Outcome wake recovery failed for notification "${notification.id}": ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    } catch (err) {
      log.error(
        `SpaceRuntimeService: recoverPendingOutcomeNotifications failed for ${spaceId}:`,
        err
      );
    }
  }

  private async recoverPendingOutcomeNotifications(): Promise<void> {
    const repo = this.config.outcomeNotificationRepo;
    if (!repo || !this.config.enableGoalOutcomeWake) return;
    try {
      for (const notification of repo.listPending()) {
        if (!(await this.isSpaceWakeable(notification.spaceId))) continue;
        void this.deliverGoalOutcomeWake(notification).catch((err) => {
          log.warn(
            `Outcome wake recovery failed for notification "${notification.id}": ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    } catch (err) {
      log.error('SpaceRuntimeService: recoverPendingOutcomeNotifications failed:', err);
    }
  }

  private async isSpaceWakeable(spaceId: string): Promise<boolean> {
    const space = await this.config.spaceManager.getSpace(spaceId);
    return space != null && space.status === 'active' && !space.paused && !space.stopped;
  }

  async ready(): Promise<void> {
    if (this.provisioningPromise) {
      await this.provisioningPromise;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.provisioningPromise) {
      await this.provisioningPromise;
      this.provisioningPromise = null;
    }
    await this.runtime.stop();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;

    for (const [spaceId, server] of this.spaceDbQueryServers) {
      try {
        server.close();
      } catch (error) {
        log.warn(`Failed to close db-query server for space ${spaceId}:`, error);
      }
    }
    this.spaceDbQueryServers.clear();

    for (const [sessionId, server] of this.memberSessionDbQueryServers) {
      try {
        server.close();
      } catch (error) {
        log.warn(`Failed to close db-query server for member session ${sessionId}:`, error);
      }
    }
    this.memberSessionDbQueryServers.clear();

    for (const [sessionId, server] of this.longTermAgentDbQueryServers) {
      try {
        server.close();
      } catch (error) {
        log.warn(
          `Failed to close db-query server for long-term agent session ${sessionId}:`,
          error
        );
      }
    }
    this.longTermAgentDbQueryServers.clear();

    for (const [spaceId, unsub] of this.spaceAgentNotificationUnsubs) {
      try {
        unsub();
      } catch (error) {
        log.warn(
          `Failed to unsubscribe SpaceAgentNotificationService for space ${spaceId}:`,
          error
        );
      }
    }
    this.spaceAgentNotificationUnsubs.clear();

    log.info('SpaceRuntimeService stopped');
  }

  private subscribeToSpaceEvents(): void {
    const { sessionManager, internalEventBus } = this.config;
    if (!sessionManager || !internalEventBus) return;

    const unsubCreated = internalEventBus.subscribe(
      'space.created',
      (event) => {
        void this.setupSpaceAgentSession(event.space).catch((err) => {
          log.error(`Failed to provision space chat session for space ${event.spaceId}:`, err);
        });
      },
      { sessionId: 'global', subscriberName: 'SpaceRuntimeService.global' }
    );
    this.unsubscribers.push(unsubCreated);

    const unsubSessionCreated = internalEventBus.subscribe(
      'session.created',
      (event) => {
        const policy = this.resolveMcpSessionPolicy(event.session);
        const attachPromise = policy.attachLongTermAgentTools
          ? this.attachLongTermAgentMcpServersForSession(event.session)
          : this.attachSpaceToolsToMemberSession(event.session);
        void attachPromise.catch((err) => {
          log.error(
            `Failed to attach space tools to session ${event.sessionId} (space ${event.session.context?.spaceId ?? '?'}):`,
            err
          );
        });
      },
      { subscriberName: 'SpaceRuntimeService.sessionCreated' }
    );
    this.unsubscribers.push(unsubSessionCreated);

    const unsubSessionDeleted = internalEventBus.subscribe(
      'session.deleted',
      (event) => {
        this.releaseMemberSessionDbQuery(event.sessionId);
        this.releaseLongTermAgentDbQuery(event.sessionId);
      },
      { subscriberName: 'SpaceRuntimeService.sessionDeleted' }
    );
    this.unsubscribers.push(unsubSessionDeleted);

    const unsubTaskUpdated = internalEventBus.subscribe(
      'space.task.updated',
      (event) => {
        const task = event.task;
        if (
          !task?.workflowRunId ||
          (task.status !== 'cancelled' && task.status !== 'archived' && task.status !== 'done')
        ) {
          return;
        }
        if (task.status === 'archived' || task.status === 'done') {
          this.runtime.clearTaskInterests(task.id);
        } else {
          this.runtime.clearTaskInterestsPreservingDynamic(task.id);
        }
      },
      { subscriberName: 'SpaceRuntimeService.taskLifecycleSubscriptions' }
    );
    this.unsubscribers.push(unsubTaskUpdated);

    const handleSpaceArchived = (event: DaemonInternalEventMap['space.archived']): void => {
      for (const run of this.config.workflowRunRepo.listBySpace(event.spaceId)) {
        this.runtime.clearRunInterests(run.id);
      }
      this.tearDownSpaceNotificationService(event.spaceId, 'archived');
    };
    const unsubSpaceArchived = internalEventBus.subscribe('space.archived', handleSpaceArchived, {
      sessionId: 'global',
      subscriberName: 'SpaceRuntimeService.global',
    });
    this.unsubscribers.push(unsubSpaceArchived);

    const handleSpaceDeleted = (event: DaemonInternalEventMap['space.deleted']): void => {
      for (const run of this.config.workflowRunRepo.listBySpace(event.spaceId)) {
        this.runtime.clearRunInterests(run.id);
      }
      this.tearDownSpaceNotificationService(event.spaceId, 'deleted');
    };
    const unsubSpaceDeleted = internalEventBus.subscribe('space.deleted', handleSpaceDeleted, {
      sessionId: 'global',
      subscriberName: 'SpaceRuntimeService.global',
    });
    this.unsubscribers.push(unsubSpaceDeleted);

    const unsubSpaceUpdated = internalEventBus.subscribe(
      'space.updated',
      (event) => {
        const existingUnsub = this.spaceAgentNotificationUnsubs.get(event.spaceId);
        if (!existingUnsub) return;

        if (event.space) {
          void this.setupSpaceAgentSession(event.space as Space).catch((err) => {
            log.error(
              `Failed to re-provision space chat session after autonomy update for space ${event.spaceId}:`,
              err
            );
          });
        }
      },
      { sessionId: 'global', subscriberName: 'SpaceRuntimeService.global' }
    );
    this.unsubscribers.push(unsubSpaceUpdated);

    const unsubSessionReset =
      typeof sessionManager.registerSessionResetSubscriber === 'function'
        ? sessionManager.registerSessionResetSubscriber(async (event) => {
            await this.reprovisionResetSession(event.session, {
              replayPendingMessages: event.restartQuery,
            }).catch((err) => {
              log.error(`Failed to re-provision reset session ${event.sessionId}:`, err);
            });
          })
        : () => {};
    this.unsubscribers.push(unsubSessionReset);
  }

  private async reprovisionResetSession(
    session: Session,
    options: { replayPendingMessages: boolean }
  ): Promise<void> {
    if (session.type === 'space_chat') {
      const spaceId = session.context?.spaceId ?? session.id.match(/^space:chat:(.+)$/)?.[1];
      if (!spaceId) return;
      const space = await this.config.spaceManager.getSpace(spaceId);
      if (!space) {
        log.warn(`reprovisionResetSession: space "${spaceId}" not found (session ${session.id})`);
        return;
      }
      await this.setupSpaceAgentSession(space, options);
      return;
    }

    const policy = this.resolveMcpSessionPolicy(session);
    if (policy.attachLongTermAgentTools) {
      await this.attachLongTermAgentMcpServersForSession(session, options);
      return;
    }
    if (policy.attachGenericSpaceTools) {
      await this.attachSpaceToolsToMemberSession(session, options);
    }
  }

  private releaseMemberSessionDbQuery(sessionId: string): void {
    const server = this.memberSessionDbQueryServers.get(sessionId);
    if (!server) return;
    try {
      server.close();
    } catch (err) {
      log.warn(`Failed to close db-query server for member session ${sessionId}:`, err);
    }
    this.memberSessionDbQueryServers.delete(sessionId);
  }

  private tearDownSpaceNotificationService(spaceId: string, reason: 'archived' | 'deleted'): void {
    const unsub = this.spaceAgentNotificationUnsubs.get(spaceId);
    if (!unsub) return;
    try {
      unsub();
    } catch {
      log.warn(
        `Failed to unsubscribe SpaceAgentNotificationService for ${reason} space ${spaceId}:`
      );
    }
    this.spaceAgentNotificationUnsubs.delete(spaceId);
  }

  private async provisionExistingSpaces(): Promise<void> {
    const { sessionManager } = this.config;
    if (!sessionManager) return;

    const chatSweep = this.config.spaceManager
      .listSpaces()
      .then((spaces) =>
        Promise.all(
          spaces.map((space) =>
            this.setupSpaceAgentSession(space).catch((err) => {
              log.error(`Failed to provision space chat session for space ${space.id}:`, err);
            })
          )
        )
      )
      .then(() => {})
      .catch((err) => {
        log.error('Failed to list spaces for session provisioning:', err);
      });

    const memberSweep = this.reattachSpaceToolsToExistingSessions();

    await Promise.all([chatSweep, memberSweep]);
  }

  private async reattachSpaceToolsToExistingSessions(): Promise<void> {
    const { sessionManager } = this.config;
    if (!sessionManager) return;

    try {
      const all = sessionManager.listSessions({
        includeArchived: false,
        includeSpaceSessions: true,
      });
      for (const session of all) {
        if (!session.context?.spaceId && session.type !== 'space_chat') continue;

        const policy = this.resolveMcpSessionPolicy(session);
        if (policy.owner !== 'space-runtime') continue;
        try {
          if (policy.attachLongTermAgentTools) {
            await this.attachLongTermAgentMcpServersForSession(session);
          } else if (policy.attachGenericSpaceTools) {
            await this.attachSpaceToolsToMemberSession(session);
          }
        } catch (err) {
          log.error(
            `Failed to attach space tools to existing session ${session.id} (space ${policy.spaceId ?? '?'}, role ${policy.role}):`,
            err
          );
        }
      }
    } catch (err) {
      log.error('Failed to iterate existing sessions for space-tool attachment:', err);
    }
  }

  private sessionBelongsToLongHorizonAgent(spaceId: string, sessionId: string): boolean {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return false;
    return repo.listBySpaceId(spaceId).some((agent) => agent.sessionId === sessionId);
  }

  buildMemberSpaceToolsMcpServer(space: Space, sessionId: string): McpServerConfig {
    const spaceManagerForApproval = this.config.spaceManager;
    return createSpaceAgentMcpServer({
      spaceId: space.id,
      db: this.config.db,
      longHorizonAgentRepo: this.config.longHorizonAgentRepo,
      runtime: this.runtime,
      workflowManager: this.config.spaceWorkflowManager,
      spaceManager: this.config.spaceManager,
      taskRepo: this.config.taskRepo,
      nodeExecutionRepo: this.nodeExecutionRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      isWorkflowRunActive: (runId: string) => this.isWorkflowRunActive(runId),
      taskManager: new SpaceTaskManager(
        this.config.db,
        space.id,
        this.config.reactiveDb,
        this.config.evolutionScopeService,
        (taskId) => this.config.goalService?.supersedeOutcomeNotificationsForTask(taskId),
        (taskId, fromStatus) =>
          this.config.goalService?.handleTaskTerminal(taskId, {
            fromStatus,
            deferPostCommitEffects: true,
          })
      ),
      spaceAgentManager: this.config.spaceAgentManager,
      sessionManager: this.config.sessionManager,
      clearLongTermAgentSessionProvider: (sid, aid) =>
        this.clearLongTermAgentSessionProvider(sid, aid),
      getRuntimeSession: (sid) =>
        this.taskAgentManager?.getCachedAgentSessionById(sid) ?? undefined,
      taskAgentManager: this.taskAgentManager ?? undefined,
      internalEventBus: this.config.internalEventBus,
      pendingMessageQueue: this.config.pendingMessageRepo,
      getSpaceAutonomyLevel: async (sid) => {
        const s = await spaceManagerForApproval.getSpace(sid);
        return s?.autonomyLevel ?? 1;
      },
      mySessionId: sessionId,
      callerRole: 'ad_hoc_member',
      auditLogRepo: this.auditLogRepo,
      scheduleService: this.config.scheduleService,
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
      goalRepo: new SpaceGoalRepository(this.config.db),
      evolutionEpisodeService: this.config.evolutionEpisodeService,
      replyRoutingRegistry: this.config.replyRoutingRegistry,
      messageResolver: this.createMessageResolver(space.id),
      longTermAgentDelivery: this.longTermAgentDeliveryCallbacks(),
      externalEventStore: this.config.externalEventStore,
    }) as unknown as McpServerConfig;
  }

  async attachSpaceToolsToMemberSession(
    session: Session,
    options: { replayPendingMessages?: boolean } = {}
  ): Promise<void> {
    const { sessionManager } = this.config;
    if (!sessionManager) return;
    const policy = this.resolveMcpSessionPolicy(session);
    if (!policy.attachGenericSpaceTools || !policy.spaceId) return;
    const spaceId = policy.spaceId;

    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      log.warn(
        `attachSpaceToolsToMemberSession: space "${spaceId}" not found (session ${session.id})`
      );
      return;
    }

    const agentSession = await sessionManager.getSessionAsync(session.id);
    if (!agentSession) {
      log.warn(`attachSpaceToolsToMemberSession: agent session not found for ${session.id}`);
      return;
    }

    if (this.sessionBelongsToLongHorizonAgent(spaceId, session.id)) return;

    this.taskAgentManager?.reattachSlotContextReset(agentSession);

    const mcpServer = this.buildMemberSpaceToolsMcpServer(space, session.id);

    const additional: Record<string, McpServerConfig> = {
      'space-agent-tools': mcpServer,
    };
    if (this.config.memoryRepo) {
      additional['agent-memory'] = createAgentMemoryMcpServer({
        spaceId: space.id,
        memoryRepo: this.config.memoryRepo,
        mySessionId: session.id,
      }) as unknown as McpServerConfig;
    }

    if (this.config.dbPath) {
      this.releaseMemberSessionDbQuery(session.id);
      const dbQueryServer = createDbQueryMcpServer({
        dbPath: this.config.dbPath,
        scopeType: 'space',
        scopeValue: space.id,
      });
      this.memberSessionDbQueryServers.set(session.id, dbQueryServer);
      additional['db-query'] = dbQueryServer as unknown as McpServerConfig;
    }

    agentSession.mergeRuntimeMcpServers(additional);

    agentSession.onMissingMemberSpaceMcpServers = async (_sessionId, missing) => {
      log.warn(
        `Space member session ${session.id} missing MCP servers [${missing.join(', ')}]; re-attaching space-agent-tools before query start`
      );
      await this.attachSpaceToolsToMemberSession(session, { replayPendingMessages: false });
    };

    if (options.replayPendingMessages !== false) {
      await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);
    }

    log.info(
      `Attached space-agent-tools to member session ${session.id} (space ${space.id}, role ${policy.role}, type ${session.type ?? 'worker'})`
    );
  }

  async reattachMemberSpaceTools(sessionId: string): Promise<void> {
    const { sessionManager } = this.config;
    if (!sessionManager) return;
    const cached = sessionManager.getCachedSession(sessionId);
    const agentSession = cached ?? (await sessionManager.getSessionAsync(sessionId));
    if (!agentSession) {
      log.warn(`reattachMemberSpaceTools: agent session not found for ${sessionId}`);
      return;
    }
    const session = agentSession.getSessionData();
    const policy = this.resolveMcpSessionPolicy(session);
    if (policy.attachLongTermAgentTools) {
      await this.attachLongTermAgentMcpServersForSession(session, {
        replayPendingMessages: false,
      });
    } else if (policy.attachGenericSpaceTools) {
      await this.attachSpaceToolsToMemberSession(session, { replayPendingMessages: false });
    }
  }

  async reattachWorkflowMcpServers(session: AgentSession, missing: string[]): Promise<void> {
    if (!this.taskAgentManager) {
      log.warn(
        `reattachWorkflowMcpServers: TaskAgentManager unavailable; cannot heal session ${session.getSessionData().id} missing [${missing.join(', ')}]`
      );
      return;
    }
    await this.taskAgentManager.mcpSelfHeal(session, missing);
  }

  async setupSpaceAgentSession(
    space: Space,
    options: { replayPendingMessages?: boolean } = {}
  ): Promise<void> {
    const {
      sessionManager,
      db,
      spaceWorkflowManager,
      spaceAgentManager,
      taskRepo,
      workflowRunRepo,
    } = this.config;
    if (!sessionManager) return;

    const spaceChatSessionId = `space:chat:${space.id}`;
    const session = await sessionManager.getSessionAsync(spaceChatSessionId);
    if (!session) {
      log.warn(`Space chat session not found for space ${space.id} (${spaceChatSessionId})`);
      return;
    }

    const coordinator = this.config.longHorizonAgentRepo?.ensureCoordinator(space.id) ?? null;
    const agents = spaceAgentManager.listBySpaceId(space.id);
    const workflows = spaceWorkflowManager.listWorkflows(space.id);

    const spaceManagerForApproval = this.config.spaceManager;
    const mcpServer = createSpaceAgentMcpServer({
      spaceId: space.id,
      db: this.config.db,
      longHorizonAgentRepo: this.config.longHorizonAgentRepo,
      runtime: this.runtime,
      workflowManager: spaceWorkflowManager,
      spaceManager: this.config.spaceManager,
      taskRepo,
      nodeExecutionRepo: this.nodeExecutionRepo,
      workflowRunRepo,
      isWorkflowRunActive: (runId: string) => this.isWorkflowRunActive(runId),
      taskManager: new SpaceTaskManager(
        db,
        space.id,
        this.config.reactiveDb,
        this.config.evolutionScopeService,
        (taskId) => this.config.goalService?.supersedeOutcomeNotificationsForTask(taskId),
        (taskId, fromStatus) =>
          this.config.goalService?.handleTaskTerminal(taskId, {
            fromStatus,
            deferPostCommitEffects: true,
          })
      ),
      spaceAgentManager,
      sessionManager: this.config.sessionManager,
      clearLongTermAgentSessionProvider: (sid, aid) =>
        this.clearLongTermAgentSessionProvider(sid, aid),
      getRuntimeSession: (sid) =>
        this.taskAgentManager?.getCachedAgentSessionById(sid) ?? undefined,
      taskAgentManager: this.taskAgentManager ?? undefined,
      internalEventBus: this.config.internalEventBus,
      activateNode: async (runId, nodeId) => {
        await this.activateWorkflowNode(runId, nodeId);
      },
      pendingMessageQueue: this.config.pendingMessageRepo,
      getSpaceAutonomyLevel: async (sid) => {
        const s = await spaceManagerForApproval.getSpace(sid);
        return s?.autonomyLevel ?? 1;
      },
      myAgentName: 'space-agent',
      myAgentNameAliases: coordinator ? [coordinator.handle] : undefined,
      myAgentId: coordinator ? coordinator.id : undefined,
      mySessionId: spaceChatSessionId,
      callerRole: 'coordinator',
      auditLogRepo: this.auditLogRepo,
      scheduleService: this.config.scheduleService,
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
      goalRepo: new SpaceGoalRepository(this.config.db),
      evolutionEpisodeService: this.config.evolutionEpisodeService,
      replyRoutingRegistry: this.config.replyRoutingRegistry,
      messageResolver: this.createMessageResolver(space.id),
      longTermAgentDelivery: this.longTermAgentDeliveryCallbacks(),
      externalEventStore: this.config.externalEventStore,
      inactivityConfigRepo: coordinator ? this.config.inactivityConfigRepo : undefined,
      inactivityClaimRepo: coordinator ? this.config.inactivityClaimRepo : undefined,
      inactivityRunNow: coordinator ? this.config.inactivityRunNow : undefined,
    });

    const existingDbQueryServer = this.spaceDbQueryServers.get(space.id);
    if (existingDbQueryServer) {
      try {
        existingDbQueryServer.close();
      } catch (err) {
        log.warn(`Failed to close stale db-query server for space ${space.id}:`, err);
      }
    }

    const mcpServers: Record<string, McpServerConfig> = {
      'space-agent-tools': mcpServer as unknown as McpServerConfig,
    };
    if (this.config.memoryRepo) {
      mcpServers['agent-memory'] = createAgentMemoryMcpServer({
        spaceId: space.id,
        memoryRepo: this.config.memoryRepo,
        mySessionId: spaceChatSessionId,
      }) as unknown as McpServerConfig;
    }
    if (this.config.dbPath) {
      const dbQueryServer = createDbQueryMcpServer({
        dbPath: this.config.dbPath,
        scopeType: 'space',
        scopeValue: space.id,
      });
      this.spaceDbQueryServers.set(space.id, dbQueryServer);
      mcpServers['db-query'] = dbQueryServer as unknown as McpServerConfig;
    }

    session.mergeRuntimeMcpServers(mcpServers);
    session.onMissingSpaceChatMcpServers = async (_sessionId, missing) => {
      log.warn(
        `Space chat session ${spaceChatSessionId} missing MCP servers [${missing.join(', ')}]; re-attaching space-agent-tools before query start`
      );
      await this.setupSpaceAgentSession(space);
    };

    const currentToolset = session.getSessionData().config?.sdkToolsPreset;
    const toolsetMatches =
      Array.isArray(currentToolset) &&
      currentToolset.length === LONG_HORIZON_AGENT_BUILTIN_TOOLS.length &&
      LONG_HORIZON_AGENT_BUILTIN_TOOLS.every((tool, i) => currentToolset[i] === tool);
    if (!toolsetMatches) {
      await session.updateConfig({
        sdkToolsPreset: [...LONG_HORIZON_AGENT_BUILTIN_TOOLS],
      });
    }

    session.setRuntimeSystemPrompt(
      buildSpaceChatSystemPrompt({
        background: space.backgroundContext,
        instructions: space.instructions,
        autonomyLevel: space.autonomyLevel,
        workflows: workflows.map((w) => ({
          id: w.id,
          handle: w.handle ?? undefined,
          name: w.name,
          description: w.description,
          tags: w.tags ?? [],
          nodeCount: w.nodes?.length ?? 0,
        })),
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,

          description: a.description,
        })),
      })
    );

    log.info(`Space chat session provisioned for space ${space.id}`);
    if (options.replayPendingMessages !== false) {
      await this.replayPendingMessagesAfterRuntimeProvisioning(session);
    }

    if (this.taskAgentManager) {
      const activeRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
      for (const run of activeRuns) {
        void this.taskAgentManager
          .flushPendingMessagesForSpaceAgent(space.id, run.id)
          .catch(() => {});
      }
    }

    if (this.config.internalEventBus && sessionManager) {
      const existingUnsub = this.spaceAgentNotificationUnsubs.get(space.id);
      if (existingUnsub) {
        existingUnsub();
      }

      const notificationService = new SpaceAgentNotificationService({
        internalEventBus: this.config.internalEventBus,
        sessionFactory: sessionManager,
        sessionId: spaceChatSessionId,
        spaceId: space.id,
        autonomyLevel: space.autonomyLevel ?? 1,
      } as SpaceAgentNotificationServiceConfig);
      const unsub = notificationService.subscribe();
      this.spaceAgentNotificationUnsubs.set(space.id, unsub);
      log.info(`SpaceAgentNotificationService wired for space ${space.id} (${spaceChatSessionId})`);
    }
  }

  async createOrGetRuntime(spaceId: string): Promise<SpaceRuntime> {
    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }
    if (!this.started) {
      this.start();
    }
    return this.runtime;
  }

  getSharedRuntime(): SpaceRuntime {
    if (!this.started) {
      this.start();
    }
    return this.runtime;
  }

  getQueueHealthSnapshot(): QueueHealthSnapshot {
    return this.runtime.getQueueHealthSnapshot();
  }

  refreshLongHorizonAgentSubscriptions(
    spaceId: string,
    agentId: string
  ): { success: boolean; error?: string } {
    return this.runtime.refreshLongHorizonAgentSubscriptions(spaceId, agentId);
  }

  refreshLongHorizonSubscription(
    spaceId: string,
    subscriptionId: string
  ): { success: boolean; error?: string } {
    return this.runtime.refreshLongHorizonSubscription(spaceId, subscriptionId);
  }

  removeLongHorizonSubscription(spaceId: string, subscriptionId: string): void {
    this.runtime.removeLongHorizonSubscription(spaceId, subscriptionId);
  }

  removeLongHorizonAgentSubscriptions(spaceId: string, agentId: string): void {
    this.runtime.removeLongHorizonAgentSubscriptions(spaceId, agentId);
  }

  async clearLongTermAgentSessionProvider(spaceId: string, agentId: string): Promise<void> {
    const sessionManager = this.config.sessionManager;
    if (!sessionManager) return;
    const session = await sessionManager.getSessionAsync(longTermAgentSessionId(spaceId, agentId));
    if (!session || session.getSessionData?.().config?.provider === undefined) return;
    await session.updateConfig({ provider: undefined });
  }

  stopRuntime(_spaceId: string): void {}

  notifyRunResumed(runId: string): void {
    try {
      this.resetBlockedExecutionsForRun(runId);
    } catch (err) {
      log.warn(
        `SpaceRuntimeService: notifyRunResumed failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private resetBlockedExecutionsForRun(runId: string): void {
    this.runtime.resetBlockedExecutionsForRun(runId);
  }

  private async replayPendingMessagesAfterRuntimeProvisioning(session: {
    replayPendingMessagesForImmediateMode?: () => Promise<void>;
  }): Promise<void> {
    if (typeof session.replayPendingMessagesForImmediateMode === 'function') {
      await session.replayPendingMessagesForImmediateMode();
    }
  }

  async activateWorkflowNode(runId: string, nodeId: string): Promise<SpaceTask[]> {
    const taskAgentManager = this.taskAgentManager;
    const router = new ChannelRouter({
      taskRepo: this.config.taskRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      workflowManager: this.config.spaceWorkflowManager,
      agentManager: this.config.spaceAgentManager,
      nodeExecutionRepo: this.nodeExecutionRepo,
      channelCycleRepo: this.config.channelCycleRepo,
      isSessionAlive: taskAgentManager ? (sid) => taskAgentManager.isSessionAlive(sid) : undefined,
      cancelSessionById: taskAgentManager
        ? (sid) => taskAgentManager.cancelBySessionId(sid)
        : undefined,
      internalEventBus: this.config.internalEventBus,
    });
    return router.activateNode(runId, nodeId, {
      allowTerminalReopen: true,
      reopenBy: 'space-runtime-service',
      reopenReason: 'explicit workflow node activation',
    });
  }

  async dispatchPostApproval(
    spaceId: string,
    taskId: string,
    approvalSource: 'human' | 'agent',
    contextExtras?: { reviewerName?: string; approvalReason?: string | null }
  ): Promise<void> {
    log.info(`dispatchPostApproval: spaceId=${spaceId} taskId=${taskId} source=${approvalSource}`);
    await this.runtime.dispatchPostApproval(taskId, approvalSource, contextExtras ?? {});
  }

  async recoverWorkflowBackedTask(
    spaceId: string,
    taskId: string,
    targetStatus: 'open' | 'in_progress',
    options: { workflowNodeId?: string; agentName?: string; description?: string } = {}
  ): Promise<SpaceTask> {
    const recovered = await this.runtime.recoverWorkflowBackedTask(
      spaceId,
      taskId,
      targetStatus,
      options
    );
    return recovered.task;
  }

  async stopWorkflowBackedTask(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ): Promise<SpaceTask> {
    const updated = await this.runtime.blockWorkflowBackedTask(spaceId, taskId, params);
    if (!updated) {
      throw new Error(`Failed to block workflow-backed task ${taskId}`);
    }
    return updated;
  }

  async stopWorkflowBackedTaskForStatus(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ): Promise<SpaceTask> {
    const updated = await this.runtime.stopWorkflowBackedTaskForStatus(spaceId, taskId, params);
    if (!updated) {
      throw new Error(`Failed to stop workflow-backed task ${taskId}`);
    }
    return updated;
  }

  async parkStoppedWorkflowTask(spaceId: string, taskId: string): Promise<SpaceTask> {
    const updated = await this.runtime.parkStoppedWorkflowTask(spaceId, taskId);
    if (!updated) {
      throw new Error(`Failed to stop (park) workflow-backed task ${taskId}`);
    }
    return updated;
  }

  async cancelWorkflowRun(spaceId: string, runId: string): Promise<SpaceWorkflowRun> {
    return this.runtime.cancelWorkflowRun(spaceId, runId);
  }

  isWorkflowRunActive(runId: string): boolean {
    const run = this.config.workflowRunRepo.getRun(runId);
    return !!run && canTransitionRunStatus(run.status, 'cancelled');
  }
}

function agentIdFromActorId(actorId: string): string | null {
  if (!actorId.startsWith('agent:')) return null;
  try {
    return decodeURIComponent(actorId.slice('agent:'.length));
  } catch {
    return null;
  }
}

async function resolveAgentConfigProvider(
  model: string,
  preferredProvider?: string,
  currentModel?: string
): Promise<Session['config']['provider']> {
  const models = getAvailableModels('global');
  if (preferredProvider) {
    if (currentModel && model === currentModel) {
      return preferredProvider as Session['config']['provider'];
    }
    const stillOffered = findInModels(
      models.filter((m) => m.provider === preferredProvider),
      model
    );
    if (stillOffered) return preferredProvider as Session['config']['provider'];
  }
  const cached = findInModels(models, model);
  if (cached?.provider) return cached.provider as Session['config']['provider'];
  return (await inferPersistableProviderForModel(model)) as Session['config']['provider'];
}

function sourceSessionIdFromActorId(actorId: string): string | null {
  if (!actorId.startsWith('session:')) return null;
  return actorId.slice('session:'.length) || null;
}

function generateRuntimeMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function sanitizeLongTermAgentKey(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'space-agent'
  );
}
