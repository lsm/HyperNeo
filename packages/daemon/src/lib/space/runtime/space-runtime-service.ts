/**
 * SpaceRuntimeService
 *
 * Manages SpaceRuntime lifecycle and provides per-space access to the
 * underlying workflow execution engine.
 *
 * Design: One shared SpaceRuntime handles all spaces in a single tick loop.
 * SpaceRuntimeService provides lifecycle management (start/stop) and a
 * per-space API surface for RPC handlers and DaemonAppContext.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
  AgentDefinition,
  McpServerConfig,
  Session,
  Space,
  SpaceWorkerAgent,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceWorkflowRun,
  UpdateSpaceTaskParams,
} from '@hyperneo/shared';
import type { MessageRecord, ActorRef } from '../../../../../messaging/src/types';
import { canonicalAgentHandle, SpaceActorRegistryAdapter } from '../actor-registry';
import type { ExternalEventPublishedPayload } from '../../external-events/external-event-service';
import { SpaceMessageResolver } from '../messaging-adapter';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceRepository } from '../../../storage/repositories/space-repository';
import type { SessionRepository } from '../../../storage/repositories/session-repository';
import type { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';
import type { SpaceAgentInboxRepository } from '../../../storage/repositories/space-agent-inbox-repository';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository';
import type { TaskAgentManager } from './task-agent-manager';
import type { SessionManager } from '../../session-manager';
import type { AgentSession } from '../../agent/agent-session';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import { SpaceRuntime } from './space-runtime';
import type { SelectWorkflowWithLlm } from './llm-workflow-selector';
import { selectWorkflowWithLlmDefault } from './llm-workflow-selector';
import { ChannelRouter } from './channel-router';
import { GateRetryScheduler } from './gate-retry-scheduler';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { createSpaceAgentMcpServer } from '../tools/space-agent-tools';
import type { ReplyRoutingRegistry } from './reply-routing-registry';
import { buildSpaceChatSystemPrompt } from '../agents/space-chat-agent';
import { resolveCustomAgentPrompt } from '../agents/custom-agent';
import { inferPersistableProviderForModel } from '../../providers/registry';
import { findInModels, getAvailableModels } from '../../model-service';
import { Logger } from '../../logger';
import { createDbQueryMcpServer, type DbQueryMcpServer } from '../../db-query/tools';
import { createAgentMemoryMcpServer } from '../tools/agent-memory-tools';
import {
  resolveSpaceMcpSessionPolicy,
  type SpaceMcpSessionPolicy,
} from './space-mcp-session-policy';
import {
  SpaceAgentNotificationService,
  type SpaceAgentNotificationServiceConfig,
} from './space-agent-notification-service';
import { encodeActorIdComponent, longTermAgentSessionId } from '../long-term-agent-session';
import type { DaemonCommandMap, InternalCommandBus } from '../../internal-command-bus';
import type { ExternalEventStore } from '../../external-events/external-event-store';
import type { ExternalEventService } from '../../external-events/external-event-service';
import type { AgentMemoryRepository } from '../../../storage/repositories/agent-memory-repository';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { deriveWorkerDisallowedTools } from '../agents/tool-policy';
import type { UUID } from 'crypto';

const log = new Logger('space-runtime-service');

const LONG_TERM_AGENT_SESSION_FEATURES = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
} as const;

const DEFAULT_LONG_HORIZON_AGENT_MODEL = 'claude-sonnet-4-6';

export interface SpaceRuntimeServiceConfig {
  db: BunDatabase;
  /** Absolute path to the SQLite database file. When provided, a db-query MCP server
   * with space scope is attached to each space chat session. */
  dbPath?: string;
  spaceManager: SpaceManager;
  spaceAgentManager: SpaceAgentManager;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  spaceWorkflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  /** Node execution repository for workflow-internal execution state */
  nodeExecutionRepo?: NodeExecutionRepository;
  reactiveDb?: ReactiveDatabase;
  /**
   * Optional Task Agent Manager to wire into the underlying SpaceRuntime.
   *
   * When provided, the tick loop delegates task workflow execution to Task Agent
   * sessions instead of calling advance() directly. If not provided at construction
   * time (e.g. due to circular dependency resolution), use setTaskAgentManager()
   * after both objects have been created.
   */
  taskAgentManager?: TaskAgentManager;
  tickIntervalMs?: number;
  /**
   * Optional gate data repository for onGateDataChanged support.
   * When provided, notifyGateDataChanged() can be called to trigger lazy node
   * activation after gate data is written externally (e.g. human approval via RPC).
   */
  gateDataRepo?: GateDataRepository;
  /**
   * Optional gate open state repository for persisting gate-open cache across daemon restarts.
   */
  gateOpenStateRepo?: import('../../../storage/repositories/gate-open-state-repository').GateOpenStateRepository;
  /**
   * Optional pending message repository for queueing messages to not-yet-spawned
   * workflow node agents.
   */
  pendingMessageRepo?: PendingAgentMessageRepository;
  channelCycleRepo?: ChannelCycleRepository;
  /**
   * Optional SessionManager for provisioning Space-owned sessions.
   * When provided, role-specific MCP tools attach on startup and session events.
   */
  sessionManager?: SessionManager;
  /**
   * Optional artifact repository for resolving completion action context.
   * Passed through to SpaceRuntime so completion actions with `artifactType`
   * can resolve artifact data for script env injection.
   */
  artifactRepo?: WorkflowRunArtifactRepository;
  /**
   * Optional LLM-backed workflow selector override. Passed through to
   * SpaceRuntime verbatim. Defaults to `selectWorkflowWithLlmDefault` which
   * calls the Claude Agent SDK. Tests should supply a deterministic stub.
   */
  selectWorkflowWithLlm?: SelectWorkflowWithLlm;
  /**
   * Schedule service — shared business logic for task schedule lifecycle.
   * Passed to space-agent-tools so Space Agent and member sessions can manage
   * scheduled tasks via the same code path as the RPC handlers. Optional.
   */
  scheduleService?: import('../schedule/schedule-service').ScheduleService;
  /**
   * Optional InternalEventBus for publishing Space runtime domain events.
   * When provided, SpaceRuntime publishes typed events alongside the legacy
   * NotificationSink path, and SpaceAgentNotificationService is wired per-space
   * to inject agent-facing messages into space:chat:${spaceId} sessions.
   *
   * This is the preferred integration point for M6+.
   */
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  commandBus?: InternalCommandBus<DaemonCommandMap>;
  externalEventStore?: ExternalEventStore;
  /** External event publisher, available for runtime-owned direct publications if needed. */
  externalEventService?: ExternalEventService;
  /**
   * Reply routing registry for symmetric message routing.
   * Passed to space-agent-tools so member sessions can register their
   * session ID as the reply target when sending messages to task/node agents.
   */
  replyRoutingRegistry?: ReplyRoutingRegistry;
  /** Persistent per-space agent memory repository. */
  memoryRepo?: AgentMemoryRepository;
  /** Repositories used by generic actor messaging for long-term Space agents. */
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
  /** Durable inbox for inactive long-term Space agents. */
  spaceAgentInboxRepo?: SpaceAgentInboxRepository;
  /** Optional goal service for processing terminal goal-task side effects and MCP goal tools. */
  goalService?: import('../goals/goal-service').SpaceGoalService;
  /** Optional Forge scope service for MCP Forge tools. */
  evolutionScopeService?: import('../evolution-scope-service').EvolutionScopeService;
  /** Optional Forge episode service for MCP Forge tools. */
  evolutionEpisodeService?: import('../evolution-episode-service').EvolutionEpisodeService;
}

export class SpaceRuntimeService {
  private readonly runtime: SpaceRuntime;
  private started = false;
  /** Unsubscribe handles for InternalEventBus<DaemonInternalEventMap> event subscriptions (daemon-lifetime). */
  private readonly unsubscribers: Array<() => void> = [];
  /** Reference to TaskAgentManager, stored when injected via setTaskAgentManager(). */
  private taskAgentManager: TaskAgentManager | null = null;
  /** Resolved nodeExecutionRepo — created from db if not provided in config. */
  private readonly nodeExecutionRepo: NodeExecutionRepository;
  private readonly actorRegistry: SpaceActorRegistryAdapter | null;
  /** Audit log repository for MCP write operations. */
  private readonly auditLogRepo: McpAuditLogRepository;
  /** Stores db-query server instances per space for cleanup on stop. */
  private readonly spaceDbQueryServers = new Map<string, DbQueryMcpServer>();
  /**
   * Stores db-query server instances attached to SpaceRuntime-owned member sessions.
   * Keyed by `sessionId`. Each entry holds the server instance so it can be closed
   * when the daemon stops, mirroring `spaceDbQueryServers` for space-chat sessions.
   */
  private readonly memberSessionDbQueryServers = new Map<string, DbQueryMcpServer>();
  /** Stores db-query server instances attached to long-term Space agent sessions. */
  private readonly longTermAgentDbQueryServers = new Map<string, DbQueryMcpServer>();
  /**
   * Per-space SpaceAgentNotificationService unsubscribe handles.
   * Created when a space's chat session is provisioned; cleaned up on stop.
   */
  private readonly spaceAgentNotificationUnsubs = new Map<string, () => void>();
  private readonly longTermAgentFlushes = new Map<string, Promise<void>>();
  /**
   * Shared retry scheduler for rate-limited gate-data refresh re-evaluations.
   * Persisted at the service level so retries survive across the transient
   * `ChannelRouter` instances built by `notifyGateDataChanged`.
   */
  private readonly gateRetryScheduler = new GateRetryScheduler();
  private resumeStalledRecoveryPromise: Promise<void> = Promise.resolve();
  /**
   * Resolves when startup-time session provisioning has completed:
   *   - every existing space's space:chat session has had MCP tools +
   *     system prompt re-attached (via `setupSpaceAgentSession`), and
   *   - every existing session owned by the Space runtime policy has had its
   *     role-specific MCP servers re-attached.
   *
   * Set by `start()` to the provisioning promise returned by
   * `provisionExistingSpaces()`. `null` before `start()` is called.
   *
   * Callers that must not accept queries before provisioning finishes should
   * `await spaceRuntimeService.ready()` — specifically the daemon bootstrap,
   * which calls it before `Bun.serve()` starts listening. Without this gate,
   * a query arriving during the brief re-attach window would run with
   * `mcpServers: undefined` (strictMcpConfig is on) and fail to reach any
   * space-agent-tool — the root cause of task #83.
   */
  private provisioningPromise: Promise<void> | null = null;

  constructor(private readonly config: SpaceRuntimeServiceConfig) {
    // Ensure nodeExecutionRepo is available — create from db if not provided.
    this.nodeExecutionRepo =
      this.config.nodeExecutionRepo ?? new NodeExecutionRepository(this.config.db);
    this.actorRegistry = config.actorRegistryRepos
      ? new SpaceActorRegistryAdapter(config.actorRegistryRepos)
      : null;
    this.auditLogRepo = new McpAuditLogRepository(this.config.db);
    this.runtime = new SpaceRuntime({
      ...config,
      nodeExecutionRepo: this.nodeExecutionRepo,
      selectWorkflowWithLlm: config.selectWorkflowWithLlm ?? selectWorkflowWithLlmDefault,
      internalEventBus: config.internalEventBus,
      onTaskUpdated: async ({ spaceId, task, archiveSource }) => {
        try {
          this.config.goalService?.handleTaskTerminal(task.id);
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
      onBlockedRunExternalEvent: (payload) => this.handleBlockedRunExternalEvent(payload),
      onRunBlocked: (runId) => {
        // Run just transitioned to blocked via tick-loop recovery, markFailed
        // RPC, or gate rejection. Ensure the PR-event auto-subscription is
        // registered so subsequent GitHub events match a target.
        void this.notifyRunBlocked(runId);
      },
      onBeforeRedispatch: async () => {
        // Rebuild PR auto-subs for active runs before rehydrate's persisted
        // delivery replay and before the first redispatch sweep so crash-pending
        // PR events find a matching target instead of being terminalized. Pass
        // replay:false — retained events are replayed by the tick's
        // post-rehydrate redispatch after executors/sessions are restored.
        await this.rehydrateActiveRunPrEventSubscriptions(false);
      },
    });
  }

  private resolveMcpSessionPolicy(session: Session): SpaceMcpSessionPolicy {
    return resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: this.nodeExecutionRepo,
      taskRepo: this.config.taskRepo,
    });
  }

  /**
   * Wire a TaskAgentManager into the underlying SpaceRuntime after construction.
   *
   * Resolves the circular dependency: SpaceRuntimeService must exist before
   * TaskAgentManager (which takes it as a constructor argument), so the manager
   * is injected back here once both are created.
   *
   * Mirrors the setNotificationSink() pattern.
   */
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
      deliverToSession: (actor, message) => this.deliverToLongTermAgent(actor, message),
      queueForActivation: (actor, message) => this.queueLongTermAgentMessage(actor, message),
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
      // Pre-await lifecycle gate (reminders only): ensureLongHorizonAgentSession
      // performs side effects (session creation, config refresh + resetQuery,
      // agent-row update, metadata write, MCP attach) that must NOT run for a
      // space that is no longer active / is paused / is stopped. Bail first.
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
      // Re-check lifecycle AFTER the ensureSession await and BEFORE injecting
      // (reminders only): the space/agent may have been paused/stopped/
      // archived during session prep. Don't inject into a non-deliverable
      // space. Mirrors task-schedule-fire's space contract.
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

  /**
   * Deliver a long-horizon agent reminder to the owning agent's session.
   *
   * Public entry point for the reminder-fire job handler. Same ensure-session +
   * inject path as external-event delivery, but additionally gates on the space
   * lifecycle (active / not paused / not stopped) both before and after the
   * ensureSession await — a paused/stopped space never has its session
   * recreated or a reminder injected; the scanner treats {delivered:false} as a
   * skip and retries next scan.
   *
   * The lifecycle gate is intentionally reminder-only. External-event delivery
   * (deliverLongHorizonExternalEvent without gateSpaceLifecycle) is wrapped in a
   * bounded retry loop that terminally fails after repeated delivered:false, so
   * gating it would drop events for a paused space. Reminders retry harmlessly
   * next scan, so they can afford to fail fast on lifecycle.
   */
  async deliverLongHorizonAgentReminder(args: {
    spaceId: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
  }): Promise<{ delivered: boolean }> {
    return this.deliverLongHorizonExternalEvent(args, { gateSpaceLifecycle: true });
  }

  private async deliverToLongTermAgent(
    actor: ActorRef,
    message: MessageRecord
  ): Promise<string | null> {
    const session = await this.ensureLongTermAgentSession(actor);
    if (!session) return null;
    await this.injectLongTermAgentMessage(session, message.body);
    return session.getSessionData().id;
  }

  private async queueLongTermAgentMessage(
    actor: ActorRef,
    message: MessageRecord
  ): Promise<string | null> {
    const inboxRepo = this.config.spaceAgentInboxRepo;
    const agentId = agentIdFromActorId(actor.actorId);
    if (!agentId) return null;
    const longHorizonAgent = this.config.longHorizonAgentRepo?.getById(agentId);
    if (longHorizonAgent?.spaceId === actor.spaceId) {
      return this.deliverToLongTermAgent(actor, message);
    }
    if (!inboxRepo) return null;
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
    return record.id;
  }

  private async activateLongTermAgentAndFlush(
    actor: ActorRef,
    queuedMessageId?: string
  ): Promise<void> {
    const agentId = agentIdFromActorId(actor.actorId);
    const lockKey = agentId ? `${actor.spaceId}:${agentId}` : actor.actorId;
    const previous = this.longTermAgentFlushes.get(lockKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        const session = await this.ensureLongTermAgentSession(actor);
        if (!session) return;
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
        await this.injectLongTermAgentMessage(session, row.message, row.id);
        inboxRepo.markDelivered(row.id, session.getSessionData().id);
      } catch (err) {
        inboxRepo.markAttemptFailed(row.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async injectLongTermAgentMessage(
    session: {
      getSessionData(): Session;
      ensureQueryStarted(): Promise<void>;
      messageQueue: { enqueueWithId: (id: string, message: string) => Promise<void> };
    },
    message: string,
    messageId?: string
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
    await session.ensureQueryStarted();
    this.config.reactiveDb?.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued');
    await session.messageQueue.enqueueWithId(id, message);
    return id;
  }

  private buildLongHorizonAgentSessionConfig(
    space: Space,
    agent: SpaceLongHorizonAgent
  ): Partial<Session['config']> {
    const customTools = Array.isArray(agent.toolPermissions.tools)
      ? (agent.toolPermissions.tools.filter((tool) => typeof tool === 'string') as string[])
      : undefined;
    const customDisallowedBuiltins = deriveWorkerDisallowedTools(customTools);
    const agentKey = sanitizeLongTermAgentKey(agent.displayName);

    const model =
      agent.model ??
      space.defaultModel ??
      (agent.provider ? undefined : DEFAULT_LONG_HORIZON_AGENT_MODEL);
    // Resolve the provider from cached model metadata first (authoritative —
    // covers Copilot/custom-endpoint models whose IDs heuristic inference would
    // mis-claim), falling back to non-contested heuristic inference on a cache
    // miss. Persisting the same provider createSession resolves keeps
    // refreshLongHorizonAgentSessionConfig a no-op on wake instead of stomping
    // the resolved provider back to undefined. Model-switching infers the
    // previous provider from the stored model, so a cache miss no longer
    // hard-blocks switching either.
    const provider = (agent.provider ??
      (model ? resolveAgentConfigProvider(model) : undefined)) as Session['config']['provider'];
    return {
      model,
      provider,
      thinkingLevel: agent.thinkingLevel ?? undefined,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: agent.instructions,
      },
      features: LONG_TERM_AGENT_SESSION_FEATURES,
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

  private async ensureLongHorizonAgentSession(spaceId: string, agentId: string) {
    const sessionManager = this.config.sessionManager;
    const repo = this.config.longHorizonAgentRepo;
    if (!sessionManager || !repo) return null;
    const agent = repo.getById(agentId);
    if (!agent || agent.spaceId !== spaceId || agent.status !== 'active') return null;
    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) return null;
    const sessionId = longTermAgentSessionId(spaceId, agentId);
    const config = this.buildLongHorizonAgentSessionConfig(space, agent);
    let session = await sessionManager.getSessionAsync(sessionId);
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
    // Same cache-first provider resolution as buildLongHorizonAgentSessionConfig.
    const regularAgentConfig: Partial<Session['config']> = {
      model,
      provider: (agent.provider ??
        (model ? resolveAgentConfigProvider(model) : undefined)) as Session['config']['provider'],
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
    // Resolve the immutable handle alias from the long-horizon record so that
    // @handle-based gate-writer delegation survives restart/reactivation
    // (persistedAgent comes from the worker repo and is null for LH agents).
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
      taskManager: new SpaceTaskManager(
        this.config.db,
        space.id,
        this.config.reactiveDb,
        this.config.evolutionScopeService
      ),
      spaceAgentManager: this.config.spaceAgentManager,
      sessionManager: this.config.sessionManager,
      getRuntimeSession: (sid) =>
        this.taskAgentManager?.getCachedAgentSessionById(sid) ?? undefined,
      taskAgentManager: this.taskAgentManager ?? undefined,
      gateDataRepo: this.config.gateDataRepo,
      internalEventBus: this.config.internalEventBus,
      onGateChanged: (runId, gateId) => {
        void this.notifyGateDataChanged(runId, gateId).catch(() => {});
      },
      pendingMessageQueue: this.config.pendingMessageRepo,
      getSpaceAutonomyLevel: async (sid) => {
        const s = await this.config.spaceManager.getSpace(sid);
        return s?.autonomyLevel ?? 1;
      },
      myAgentName: agentName,
      myAgentNameAliases: aliases,
      myAgentId: agentId ?? undefined,
      mySessionId: sessionId,
      auditLogRepo: this.auditLogRepo,
      scheduleService: this.config.scheduleService,
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
      evolutionEpisodeService: this.config.evolutionEpisodeService,
      replyRoutingRegistry: this.config.replyRoutingRegistry,
      messageResolver: this.createMessageResolver(space.id),
      longTermAgentDelivery: this.longTermAgentDeliveryCallbacks(),
      externalEventStore: this.config.externalEventStore,
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

  /**
   * Stop all active work for a space: terminates running agent sessions and
   * cancels all in-progress/open tasks and active workflow runs.
   *
   * Called by the `space.stop` RPC handler before archiving the space.
   * Does NOT archive the space itself — the caller is responsible for that.
   */
  async stopActiveWork(spaceId: string): Promise<void> {
    const { taskRepo, workflowRunRepo } = this.config;

    // 1. Cancel all active tasks (in_progress or open) and their agent sessions.
    const activeTasks = taskRepo
      .listBySpace(spaceId)
      .filter((t) => t.status === 'in_progress' || t.status === 'open');

    await Promise.allSettled(
      activeTasks.map(async (task) => {
        // Stop the agent session first, then mark the task as cancelled in the DB.
        if (this.taskAgentManager) {
          await this.taskAgentManager.cleanup(task.id, 'cancelled').catch((err: unknown) => {
            log.warn(`stopActiveWork: failed to cleanup agent session for task ${task.id}:`, err);
          });
        }
        taskRepo.updateTask(task.id, { status: 'cancelled' });
      })
    );

    // 2. Cancel all active workflow runs (pending, in_progress, blocked).
    const activeRuns = workflowRunRepo
      .listBySpace(spaceId)
      .filter(
        (r) => r.status === 'pending' || r.status === 'in_progress' || r.status === 'blocked'
      );

    for (const run of activeRuns) {
      try {
        workflowRunRepo.transitionStatus(run.id, 'cancelled');
      } catch (err) {
        log.warn(`stopActiveWork: failed to cancel workflow run ${run.id}:`, err);
      }
    }

    log.info(
      `stopActiveWork: cancelled ${activeTasks.length} tasks and ${activeRuns.length} workflow runs for space ${spaceId}`
    );
  }

  /**
   * Start the underlying SpaceRuntime tick loop.
   *
   * Synchronously starts the runtime + subscribes to space/session events, then
   * kicks off startup session provisioning + a stalled-workflow-run recovery
   * pass as a tracked async task. The returned `provisioningPromise` is exposed
   * via `ready()` so the daemon bootstrap can await it before accepting queries
   * — without that gate, queries arriving before re-attachment finishes run
   * with `mcpServers: undefined` and fail to reach `space-agent-tools` (root
   * cause of task #83).
   *
   * The recovery pass (`recoverStalledWorkflowRuns`) is chained after
   * provisioning inside `provisioningPromise` to repair workflow runs whose
   * in-flight state was orphaned by the previous daemon shutdown: runs whose
   * node executions are all terminal but never finalized are flagged
   * `blocked` with `block_reason = execution_failed`. Orphan in_progress node
   * executions (dead session) are left for the tick loop's existing
   * crash-retry path, which handles them correctly with proper crash
   * counting. Without this scan, a crash that lands the run with
   * all-terminal-no-completion-signal would leave the parent task
   * `in_progress` forever (root cause of task #120).
   *
   * Ordering caveat: `runtime.start()` synchronously schedules an immediate
   * `executeTick()`, whose first invocation also calls `recoverStalledRuns()`
   * after rehydrate. The "after provisioning" sequencing is therefore
   * best-effort — whichever path wins the race fires first. Correctness is
   * enforced by `SpaceRuntime.recoveryDone`, which guarantees recovery runs
   * exactly once regardless of caller order.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.runtime.start();
    this.subscribeToSpaceEvents();
    // Kick off provisioning + recovery and retain the promise so callers
    // (notably the daemon bootstrap) can `await ready()` before accepting
    // queries. Recovery is chained after provisioning here as a best-effort
    // ordering — but the runtime's first `executeTick()` also calls
    // `recoverStalledRuns()`, so the actual single-execution guarantee
    // comes from `SpaceRuntime.recoveryDone`, not this sequencing.
    this.provisioningPromise = (async () => {
      await this.provisionExistingSpaces();
      await this.recoverLongTermAgentInbox();
      await this.recoverStalledWorkflowRuns();
      // PR auto-subscription rehydration is wired via the runtime's
      // onBeforeRedispatch hook so it runs inside the first executeTick,
      // before the redispatch sweep re-processes crash-pending events.
    })().catch((err) => {
      log.error('Failed to provision existing spaces during startup:', err);
    });
    log.info('SpaceRuntimeService started');
  }

  /**
   * Re-drive workflow runs that were left in an inconsistent in-flight state
   * by the previous daemon shutdown.
   *
   * Delegates to `SpaceRuntime.recoverStalledRuns()`, which is idempotent.
   * Called from `start()` after provisioning; also invoked once from the
   * runtime's first `executeTick()` as a backstop. Whichever fires first
   * wins; the other call is a no-op.
   *
   * Exposed publicly so tests (and operators, via direct injection) can
   * trigger recovery deterministically without driving a tick.
   */
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

  private async recoverLongTermAgentInbox(): Promise<void> {
    const inboxRepo = this.config.spaceAgentInboxRepo;
    if (!inboxRepo) return;
    try {
      inboxRepo.expireStale();
      for (const space of await this.config.spaceManager.listSpaces()) {
        for (const row of inboxRepo.listPendingForSpace(space.id)) {
          const workerAgent = this.config.spaceAgentManager.getById(row.targetAgentId);
          const longHorizonAgent = this.config.longHorizonAgentRepo?.getById(row.targetAgentId);
          if (workerAgent?.spaceId !== space.id && longHorizonAgent?.spaceId !== space.id) continue;
          void this.activateLongTermAgentAndFlush(
            {
              actorId: `agent:${encodeActorIdComponent(row.targetAgentId)}`,
              kind: 'agent',
              spaceId: space.id,
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
      }
    } catch (err) {
      log.error('SpaceRuntimeService: recoverLongTermAgentInbox failed:', err);
    }
  }

  /**
   * Resolves when startup-time session provisioning has fully completed, i.e.
   * when both the space-chat sessions have had MCP tools + system prompts
   * re-attached AND every existing member session has had `space-agent-tools`
   * (and optional `db-query`) re-attached.
   *
   * Call before the daemon begins serving queries to avoid the re-attach race
   * in which a session-bound RPC runs with `mcpServers: undefined` because the
   * fire-and-forget startup loop has not yet reached it.
   *
   * Safe to call multiple times; resolves immediately once provisioning is done.
   * Never rejects — errors are logged by the provisioning path itself.
   */
  async ready(): Promise<void> {
    if (this.provisioningPromise) {
      await this.provisioningPromise;
    }
  }

  /** Stop the underlying SpaceRuntime tick loop and await in-flight ticks. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // Wait for any in-flight startup provisioning to settle before we tear
    // down db-query servers etc., so a concurrent re-attach doesn't leak
    // references into the cleared maps.
    if (this.provisioningPromise) {
      await this.provisioningPromise;
      this.provisioningPromise = null;
    }
    await this.runtime.stop();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;

    // Close all db-query server connections to release read-only SQLite handles.
    for (const [spaceId, server] of this.spaceDbQueryServers) {
      try {
        server.close();
      } catch (error) {
        log.warn(`Failed to close db-query server for space ${spaceId}:`, error);
      }
    }
    this.spaceDbQueryServers.clear();

    // Close all member-session db-query servers as well.
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

    // Tear down per-space SpaceAgentNotificationService subscriptions.
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

  /**
   * Subscribe to space.created and session.created events so newly created
   * spaces get their chat sessions provisioned with MCP tools + system prompt,
   * and every new SpaceRuntime-owned member session gets `space-agent-tools`
   * (and `db-query`) attached so it can coordinate with the rest of the Space.
   *
   * Called once during start(). No-op when sessionManager or internalEventBus are absent.
   */
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

    // New sessions are routed through the explicit Space MCP policy. Coordinator
    // sessions are handled by `setupSpaceAgentSession`; ad-hoc Space member
    // sessions get the generic Space tools here; workflow workers are owned by
    // TaskAgentManager and skipped by policy.
    //
    // NOTE: no `{ sessionId: 'global', subscriberName: 'SpaceRuntimeService.global' }` filter here — `session.created` is
    // emitted with `data.sessionId = <new session UUID>`, so a `'global'`
    // filter would never match. We want every session.created event, so we
    // subscribe globally (TypedHub's default).
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

    // When a session is deleted, release any per-session db-query server we
    // spun up for it so read-only SQLite handles don't accumulate on a
    // long-lived daemon serving many short-lived worker sessions.
    // (Same reasoning as above: `session.deleted` is emitted with the
    // deleted session's UUID as `sessionId`, not `'global'`.)
    const unsubSessionDeleted = internalEventBus.subscribe(
      'session.deleted',
      (event) => {
        this.releaseMemberSessionDbQuery(event.sessionId);
        this.releaseLongTermAgentDbQuery(event.sessionId);
      },
      { subscriberName: 'SpaceRuntimeService.sessionDeleted' }
    );
    this.unsubscribers.push(unsubSessionDeleted);

    // When a space is archived or deleted, tear down its notification service
    // so stale subscribers don't accumulate and fan-out to non-existent sessions.
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

    // When a space is updated, refresh the autonomy level in its notification
    // service so [TASK_EVENT] messages report the current level.
    const unsubSpaceUpdated = internalEventBus.subscribe(
      'space.updated',
      (event) => {
        const existingUnsub = this.spaceAgentNotificationUnsubs.get(event.spaceId);
        if (!existingUnsub) return;

        // Re-provision the space chat session, which re-creates the
        // SpaceAgentNotificationService with the updated autonomy level.
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

    // Hard resets replace the cached AgentSession with a fresh instance built
    // only from persisted DB state, so runtime-only MCP servers, Space prompts,
    // and self-heal callbacks must be re-attached before replay restarts a query.
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

  /**
   * Re-attach runtime-only Space configuration after SessionManager hard resets
   * a cached AgentSession. Without this hook, reset Space chats would lose their
   * `space-agent-tools` server and the QueryRunner invariant would hard-fail
   * before its self-heal callback could exist.
   */
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

  /**
   * Close and evict the db-query server instance (if any) we attached to the
   * given member session. Safe to call for sessions that never had one.
   */
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

  /**
   * Tear down the SpaceAgentNotificationService subscription for a given space.
   * Called when a space is archived or deleted to prevent stale subscribers.
   */
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

  /**
   * Provision existing Space sessions after daemon restart.
   *
   * Space chat sessions are provisioned from the spaces table because they are
   * guaranteed one-per-space. All other persisted sessions are routed through the
   * explicit Space MCP session policy: SpaceRuntime owns ad-hoc members and skips
   * workflow workers because TaskAgentManager owns their node wrapper.
   *
   * Returns a promise that resolves only after **both** sweeps complete so the
   * daemon bootstrap can `await spaceRuntimeService.ready()` before accepting
   * queries.
   *
   * No-op when sessionManager is absent.
   */
  private async provisionExistingSpaces(): Promise<void> {
    const { sessionManager } = this.config;
    if (!sessionManager) return;

    // Space chat sessions: run in parallel (one session per space) and wait
    // for all of them so `ready()` only resolves once every space's chat
    // session has MCP tools + system prompt attached.
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

    // Space-owned session sweep: ad-hoc member sessions get generic Space tools;
    // workflow workers are skipped because TaskAgentManager owns node-specific tools.
    const memberSweep = this.reattachSpaceToolsToExistingSessions();

    await Promise.all([chatSweep, memberSweep]);
  }

  /**
   * Re-attach SpaceRuntime-owned MCP tools to existing sessions.
   *
   * Runs sequentially because each policy decision can read node-execution state
   * and each attach performs SQLite-backed session/space lookups. Sequential is
   * fast enough for daemon startup and avoids a thundering herd.
   */
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

  /**
   * True when `sessionId` is the live session of a long-horizon agent in `spaceId`.
   * Used to detect the first-activation race (session.created fires before the
   * session is marked as a long-term agent) so the generic member attach can
   * self-suppress instead of overwriting the capped server. DB-backed, so it is
   * immune to session-metadata cache staleness.
   */
  private sessionBelongsToLongHorizonAgent(spaceId: string, sessionId: string): boolean {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return false;
    return repo.listBySpaceId(spaceId).some((agent) => agent.sessionId === sessionId);
  }

  /**
   * Attach generic Space MCP servers to an ad-hoc Space member session.
   *
   * Role selection is centralised in `resolveSpaceMcpSessionPolicy`; this method
   * only serves sessions whose policy says SpaceRuntime owns generic member tools.
   * Workflow workers are skipped because TaskAgentManager attaches node-scoped
   * `node-agent` plus specialised `space-agent-tools`.
   */
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

    // First-activation guard against the session.created race: createSession
    // publishes session.created BEFORE ensureLongHorizonAgentSession persists
    // promptProvenance.agentId, so a brand-new long-term agent session is
    // momentarily classified as an ad-hoc member and routed here. By the time
    // this async path resumes, the long-horizon agent row already has its
    // sessionId set to this session (ensureLongHorizonAgentSession sets it
    // synchronously right after createSession). If this session belongs to a
    // long-horizon agent, self-suppress: the capped space-agent-tools is
    // attached by the dedicated long-term path, and merging the generic
    // (uncapped) server here would overwrite it — mergeRuntimeMcpServers is
    // last-writer-wins, so the uncapped server would win and defeat the ceiling.
    if (this.sessionBelongsToLongHorizonAgent(spaceId, session.id)) return;

    const spaceManagerForApproval = this.config.spaceManager;
    const mcpServer = createSpaceAgentMcpServer({
      spaceId: space.id,
      db: this.config.db,
      longHorizonAgentRepo: this.config.longHorizonAgentRepo,
      runtime: this.runtime,
      workflowManager: this.config.spaceWorkflowManager,
      spaceManager: this.config.spaceManager,
      taskRepo: this.config.taskRepo,
      nodeExecutionRepo: this.nodeExecutionRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      taskManager: new SpaceTaskManager(
        this.config.db,
        space.id,
        this.config.reactiveDb,
        this.config.evolutionScopeService
      ),
      spaceAgentManager: this.config.spaceAgentManager,
      sessionManager: this.config.sessionManager,
      getRuntimeSession: (sid) =>
        this.taskAgentManager?.getCachedAgentSessionById(sid) ?? undefined,
      taskAgentManager: this.taskAgentManager ?? undefined,
      gateDataRepo: this.config.gateDataRepo,
      internalEventBus: this.config.internalEventBus,
      onGateChanged: (runId, gateId) => {
        void this.notifyGateDataChanged(runId, gateId).catch(() => {});
      },
      pendingMessageQueue: this.config.pendingMessageRepo,
      getSpaceAutonomyLevel: async (sid) => {
        const s = await spaceManagerForApproval.getSpace(sid);
        return s?.autonomyLevel ?? 1;
      },
      // Member sessions don't declare themselves as "space-agent"; they are
      // ordinary participants in the Space. Leaving myAgentName undefined
      // means gate writer-authorization paths that rely on matching the
      // writer name fall through to the autonomy path, which is the
      // correct gating behavior for non-space-agent callers.
      mySessionId: session.id,
      auditLogRepo: this.auditLogRepo,
      scheduleService: this.config.scheduleService,
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
      evolutionEpisodeService: this.config.evolutionEpisodeService,
      replyRoutingRegistry: this.config.replyRoutingRegistry,
      messageResolver: this.createMessageResolver(space.id),
      longTermAgentDelivery: this.longTermAgentDeliveryCallbacks(),
      externalEventStore: this.config.externalEventStore,
    });

    const additional: Record<string, McpServerConfig> = {
      'space-agent-tools': mcpServer as unknown as McpServerConfig,
    };
    if (this.config.memoryRepo) {
      additional['agent-memory'] = createAgentMemoryMcpServer({
        spaceId: space.id,
        memoryRepo: this.config.memoryRepo,
        mySessionId: session.id,
      }) as unknown as McpServerConfig;
    }

    if (this.config.dbPath) {
      // Close any stale instance for this session (e.g., on re-provision
      // after daemon restart) to avoid leaking read-only SQLite handles.
      this.releaseMemberSessionDbQuery(session.id);
      const dbQueryServer = createDbQueryMcpServer({
        dbPath: this.config.dbPath,
        scopeType: 'space',
        scopeValue: space.id,
      });
      this.memberSessionDbQueryServers.set(session.id, dbQueryServer);
      additional['db-query'] = dbQueryServer as unknown as McpServerConfig;
    }

    // Merge rather than replace — other subsystems (e.g., room tools) may
    // have already attached their own MCP servers on this session.
    agentSession.mergeRuntimeMcpServers(additional);

    // Wire self-heal callback so QueryRunner can recover if this session is
    // evicted from cache and reloaded from DB (losing runtime-only MCP config).
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

  /**
   * Attach MCP tools and system prompt to a space's chat session.
   *
   * Mirrors SpaceRuntimeService.setupSpaceAgentSession(). Called:
   *   - On startup for all existing spaces (re-attaches after daemon restart)
   *   - On space.created event for newly created spaces
   *
   * No-op when sessionManager is absent.
   */
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

    // Build context for the system prompt.
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
      taskManager: new SpaceTaskManager(
        db,
        space.id,
        this.config.reactiveDb,
        this.config.evolutionScopeService
      ),
      spaceAgentManager,
      sessionManager: this.config.sessionManager,
      getRuntimeSession: (sid) =>
        this.taskAgentManager?.getCachedAgentSessionById(sid) ?? undefined,
      taskAgentManager: this.taskAgentManager ?? undefined,
      gateDataRepo: this.config.gateDataRepo,
      internalEventBus: this.config.internalEventBus,
      onGateChanged: (runId, gateId) => {
        void this.notifyGateDataChanged(runId, gateId).catch(() => {});
      },
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
      mySessionId: spaceChatSessionId,
      auditLogRepo: this.auditLogRepo,
      scheduleService: this.config.scheduleService,
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
      evolutionEpisodeService: this.config.evolutionEpisodeService,
      replyRoutingRegistry: this.config.replyRoutingRegistry,
      messageResolver: this.createMessageResolver(space.id),
      longTermAgentDelivery: this.longTermAgentDeliveryCallbacks(),
      externalEventStore: this.config.externalEventStore,
    });

    // Create a space-scoped db-query server if dbPath is configured.
    // Close any existing instance for this space to prevent connection leaks on re-setup.
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

    // Merge rather than replace — the deprecated `setRuntimeMcpServers` is a
    // replace-all that silently wipes any other subsystem's previously-attached
    // MCP servers on this space_chat session. `mergeRuntimeMcpServers` is the
    // additive variant already used by `attachSpaceToolsToMemberSession`.
    session.mergeRuntimeMcpServers(mcpServers);
    session.onMissingSpaceChatMcpServers = async (_sessionId, missing) => {
      log.warn(
        `Space chat session ${spaceChatSessionId} missing MCP servers [${missing.join(', ')}]; re-attaching space-agent-tools before query start`
      );
      await this.setupSpaceAgentSession(space);
    };

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

    // Flush any Task Agent → Space Agent messages that were queued before
    // this session was provisioned (handles the daemon-restart activation race).
    if (this.taskAgentManager) {
      const activeRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
      for (const run of activeRuns) {
        void this.taskAgentManager
          .flushPendingMessagesForSpaceAgent(space.id, run.id)
          .catch(() => {});
      }
    }

    // Wire SpaceAgentNotificationService for this space when InternalEventBus is available.
    // This replaces the legacy SessionNotificationSink / setNotificationSink path.
    if (this.config.internalEventBus && sessionManager) {
      // Tear down any existing notification service for this space (re-provision safety).
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

  /**
   * Returns the SpaceRuntime for the given space, starting it if needed.
   *
   * The underlying runtime is shared — one SpaceRuntime handles all spaces.
   * This method validates that the space exists and ensures the runtime is
   * running before returning it.
   *
   * Throws if the space does not exist.
   */
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

  /**
   * Returns the shared SpaceRuntime without space validation.
   * For system-level access (e.g. Global Spaces Agent) where no specific space context exists.
   */
  getSharedRuntime(): SpaceRuntime {
    if (!this.started) {
      this.start();
    }
    return this.runtime;
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

  /**
   * Release the runtime for a given space.
   *
   * Currently a no-op — the shared runtime handles all spaces together.
   * Reserved for future per-space runtime isolation.
   */
  stopRuntime(_spaceId: string): void {
    // No-op: shared runtime handles all spaces; use stop() to stop entirely.
  }

  /**
   * Called when a gate is waiting for human approval (gate data exists but
   * `approved` hasn't been set yet). Transitions the canonical task to `review`
   * so the task appears in the "Needs Attention" group in the UI.
   *
   * No-op when:
   * - The run or its tasks cannot be found
   * - No non-archived task is currently `in_progress` or `open`
   */
  async handleGatePendingApproval(runId: string, _gateId: string): Promise<void> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return;

    const tasks = this.config.taskRepo.listByWorkflowRun(runId);
    if (tasks.length === 0) return;

    // Find the canonical task that is actively running. Gate pending approval
    // happens while the agent is working or has just finished writing gate data.
    const canonical =
      tasks.find((t) => t.status === 'in_progress') ?? tasks.find((t) => t.status === 'open');
    if (!canonical) return;

    const updated = this.config.taskRepo.updateTask(canonical.id, {
      status: 'review',
      pendingCheckpointType: 'gate',
    });
    if (!updated) return;

    if (this.config.internalEventBus) {
      await this.config.internalEventBus.publish('space.task.updated', {
        sessionId: 'global',
        spaceId: run.spaceId,
        taskId: updated.id,
        task: updated,
      });
    }
  }

  /**
   * Notify that gate data has changed for a given run/gate pair.
   *
   * Creates a temporary ChannelRouter and calls onGateDataChanged() to re-evaluate
   * all channels referencing the gate and lazily activate any newly-unblocked nodes.
   *
   * Used by the approveGate RPC handler and the writeGateData RPC handler to trigger
   * downstream node activation after gate data is written externally (i.e. without going
   * through the write_gate MCP tool, which has its own onGateDataChanged wiring).
   *
   * No-op when gateDataRepo was not provided at construction time.
   */
  getGateRetryScheduler(): GateRetryScheduler {
    return this.gateRetryScheduler;
  }

  async notifyGateDataChanged(runId: string, gateId: string): Promise<SpaceTask[]> {
    if (!this.config.gateDataRepo) return [];
    // Resolve workspacePath from run → space for script gate evaluation.
    const run = this.config.workflowRunRepo.getRun(runId);
    let workspacePath: string | undefined;
    if (run) {
      const space = await this.config.spaceManager.getSpace(run.spaceId);
      workspacePath = space?.workspacePath;
    }
    const spaceManager = this.config.spaceManager;
    const taskAgentManager = this.taskAgentManager;
    const router = new ChannelRouter({
      taskRepo: this.config.taskRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      workflowManager: this.config.spaceWorkflowManager,
      agentManager: this.config.spaceAgentManager,
      nodeExecutionRepo: this.nodeExecutionRepo,
      gateDataRepo: this.config.gateDataRepo,
      gateOpenStateRepo: this.config.gateOpenStateRepo,
      channelCycleRepo: this.config.channelCycleRepo,
      db: this.config.db,
      workspacePath,
      gateRetryScheduler: this.gateRetryScheduler,
      getSpaceAutonomyLevel: async (spaceId) => {
        const s = await spaceManager.getSpace(spaceId);
        return s?.autonomyLevel ?? 1;
      },
      isSessionAlive: taskAgentManager ? (sid) => taskAgentManager.isSessionAlive(sid) : undefined,
      cancelSessionById: taskAgentManager
        ? (sid) => taskAgentManager.cancelBySessionId(sid)
        : undefined,
      // Forward the runtime's current sink so a gate-driven reopen still
      // surfaces `workflow_run_reopened` to the Space Agent session.
      // Forward the InternalEventBus so gate-driven reopens also publish
      // typed `space.workflowRun.reopened` events for bus subscribers.
      internalEventBus: this.config.internalEventBus,
      onGatePendingApproval: (runId, gateId) => this.handleGatePendingApproval(runId, gateId),
      onGateDataChangedComplete: (runId, _gateId, activatedTasks, gateOpened) =>
        this.handleGateDataChangedComplete(runId, activatedTasks, gateOpened),
      getPrUrlForRun: (rid) => this.resolvePrUrlForRun(rid),
    });
    const activated = await router.onGateDataChanged(runId, gateId);
    // Also fire the sync inline; the router's complete-hook covers the
    // deferred retry path but the immediate path is re-entrantly invoked
    // here so the result is reflected before the caller observes it.
    await this.syncBlockedRunPrEventSubscription(runId, activated);
    return activated;
  }

  /**
   * Ensure an active workflow run remains subscribed to GitHub PR events when a
   * PR URL is resolvable from gate data / hook state / artifacts.
   *
   * Called from {@link notifyGateDataChanged}, direct resume paths, and the
   * event-driven re-evaluation path. Also invoked directly by the `write_gate`
   * MCP tool path in `TaskAgentManager` so agent-driven gate writes trigger the
   * same sync as RPC-driven ones. Idempotent for the current PR URL and refreshes
   * stale auto-subscriptions when the resolved PR URL changes.
   */
  async syncBlockedRunPrEventSubscription(
    runId: string,
    _activatedTasks: SpaceTask[]
  ): Promise<void> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run || (run.status !== 'blocked' && run.status !== 'in_progress')) return;
    // For a run already in_progress there is no pending transition to replay a
    // retained PR event, so replay now (this path is also invoked directly by
    // notifyGateDataChanged, not only via handleGateDataChangedComplete). For a
    // blocked run, defer — handleGateDataChangedComplete replays after any
    // transition (gate-open resume) or when the gate stays closed.
    const replay = run.status === 'in_progress';
    const result = this.runtime.ensurePrEventSubscriptionForRun(runId, { replay });
    if (
      !result.subscribed &&
      result.reason &&
      result.reason !== 'no resolvable PR URL' &&
      result.reason !== 'already has current auto PR-event subscription'
    ) {
      log.warn(`SpaceRuntimeService: auto-subscribe for run ${runId}: ${result.reason}`);
    }
  }

  /**
   * Post-eval hook shared by both the immediate and deferred-retry
   * `onGateDataChanged` paths. Triggered via the router's
   * `onGateDataChangedComplete` config callback.
   *
   * Registers/refreshes the PR auto-subscription via
   * {@link syncBlockedRunPrEventSubscription}. When the gate opens and the run
   * is currently `blocked`, also fires the full resume chain
   * (transitionBlockedRunToInProgress + notify session) so the deferred retry
   * path does not silently leave the workflow stuck despite the open gate.
   *
   * Public so TaskAgentManager's nodeAgentChannelRouter can route deferred
   * retries through the same chain — otherwise the retry fires
   * `router.onGateDataChanged` directly and only hits this hook.
   */
  async handleGateDataChangedComplete(
    runId: string,
    activatedTasks: SpaceTask[],
    gateOpened = activatedTasks.length > 0
  ): Promise<void> {
    await this.syncBlockedRunPrEventSubscription(runId, activatedTasks);
    // Resume the run only when EVERY gate is now open. Resuming on a partial
    // opening (e.g. an unrelated gate A is already satisfied while blocking
    // gate B is still closed) lets the tick loop immediately re-block the
    // run because B's channel still cannot deliver. Without this check, the
    // per-gate completion hook in handleBlockedRunExternalEvent's loop would
    // resume the run as soon as gate A's re-eval reports open, before the
    // post-loop allGatesOpen check can prevent it.
    if (gateOpened && this.allWorkflowGatesOpen(runId)) {
      const run = this.config.workflowRunRepo.getRun(runId);
      if (run?.status === 'blocked') {
        this.transitionBlockedRunToInProgress(runId);
      }
    }
    // Replay retained PR events after any transition: for a gate-open resume
    // the run is now in_progress so the event delivers to the resumed slot;
    // when the gate stayed closed the replay re-evaluates the blocked gate.
    this.runtime.redispatchRetainedExternalEvents();
  }

  /**
   * Returns true when every gate declared on the run's workflow is currently
   * cached open in the gate-open state repository. Used by the event-driven
   * resume paths to decide whether the run can actually progress after a
   * re-evaluation pass.
   */
  private allWorkflowGatesOpen(runId: string): boolean {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
    const gates = workflow?.gates ?? [];
    if (gates.length === 0) return true;
    return gates.every(
      (gate) => this.config.gateOpenStateRepo?.isOpen(runId, gate.id).open === true
    );
  }

  /**
   * Public entry point for code paths that transition a workflow run to
   * `blocked` via direct `workflowRunRepo.transitionStatus(...)` calls
   * (markFailed RPC, gate rejection, space-agent-tools block). Ensures the
   * PR-event auto-subscription is registered for the run regardless of which
   * code path performed the transition.
   *
   * Delegates to {@link SpaceRuntime.notifyRunBlocked} which performs the
   * actual prUrl resolution and topic-trie registration. Idempotent.
   */
  /**
   * Public entry point for code paths that transition a workflow run out of
   * `blocked` via direct `workflowRunRepo.transitionStatus(...)` calls
   * (resume RPC, approval-after-rejection). Sweeps any persisted PR-event
   * auto-subscription so subsequent PR events do not keep re-evaluating gates
   * for an active run that only needed the subscription while it was blocked.
   *
   * Delegates to {@link SpaceRuntime.clearPrEventSubscriptionsForRun} which is
   * safe to call regardless of whether a subscription was actually
   * registered. Idempotent.
   */
  notifyRunResumed(runId: string): void {
    try {
      // Direct resume paths (spaceWorkflowRun.resume, approveGate after
      // rejection) bypass transitionBlockedRunToInProgress, so reset any
      // blocked executions BEFORE ensuring the auto-sub so the subscription
      // targets the recovered slot, not the stale blocked one.
      this.resetBlockedExecutionsForRun(runId);
      const result = this.runtime.ensurePrEventSubscriptionForRun(runId);
      if (
        !result.subscribed &&
        result.reason &&
        result.reason !== 'no resolvable PR URL' &&
        result.reason !== 'already has current auto PR-event subscription'
      ) {
        log.warn(`SpaceRuntimeService: notifyRunResumed for run ${runId}: ${result.reason}`);
      }
    } catch (err) {
      log.warn(
        `SpaceRuntimeService: notifyRunResumed failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async notifyRunBlocked(runId: string): Promise<void> {
    try {
      const result = this.runtime.notifyRunBlocked(runId);
      if (!result.subscribed && result.reason && result.reason !== 'no resolvable PR URL') {
        log.warn(`SpaceRuntimeService: notifyRunBlocked for run ${runId}: ${result.reason}`);
      }
    } catch (err) {
      log.warn(
        `SpaceRuntimeService: notifyRunBlocked failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Event-driven gate re-evaluation entry point.
   *
   * Wired to `SpaceRuntimeConfig.onBlockedRunExternalEvent` so that whenever an
   * external event is delivered to a workflow run currently in `blocked`
   * status, every gate of the run's workflow is re-evaluated immediately. If
   * any gate opens as a result, the active agent session for the run is
   * notified with a human-readable summary so the workflow can continue
   * without waiting for the next tick.
   */
  async handleBlockedRunExternalEvent(payload: {
    runId: string;
    event: ExternalEventPublishedPayload;
  }): Promise<boolean | 'retry'> {
    const { runId, event } = payload;
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run || run.status !== 'blocked') return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
    if (!workflow) return false;

    let anyOpened = false;
    const gates = workflow.gates ?? [];
    for (const gate of gates) {
      try {
        const wasOpenBefore = this.config.gateOpenStateRepo?.isOpen(runId, gate.id).open ?? false;
        await this.notifyGateDataChanged(runId, gate.id);
        const isOpenNow = this.config.gateOpenStateRepo?.isOpen(runId, gate.id).open ?? false;
        if (!wasOpenBefore && isOpenNow) {
          anyOpened = true;
        }
      } catch (err) {
        log.warn(
          `SpaceRuntimeService: event-driven gate re-evaluation for gate "${gate.id}" ` +
            `on blocked run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const allGatesOpen = gates.length > 0 && this.allWorkflowGatesOpen(runId);

    if (anyOpened && allGatesOpen) {
      this.transitionBlockedRunToInProgress(runId);
      await this.notifyBlockedRunSessionGateResolved(runId, event);
      return true;
    }

    // Check whether any deferred retry was scheduled during the loop — if so,
    // signal 'retry' so the runtime keeps the event published instead of
    // terminally marking it failed.
    const scheduler = this.gateRetryScheduler;
    const anyRetryScheduled = scheduler && gates.some((gate) => scheduler.has(runId, gate.id));
    if (anyRetryScheduled) return 'retry';
    return false;
  }

  /**
   * Transition a `blocked` workflow run back to `in_progress` after an
   * event-driven gate opening. Mirrors the resume RPC semantics: only fires
   * when the run is actually `blocked`, and publishes the canonical
   * `space.workflowRun.updated` event so UI subscribers stay in sync.
   *
   * Also promotes the canonical task out of `blocked` → `in_progress` so the
   * UI does not keep showing a blocked task after the underlying run resumed.
   * Only terminal-ish `blocked`/`review` tasks are touched; `open` tasks
   * stay `open` so the normal tick-loop promotion path still runs.
   */
  private transitionBlockedRunToInProgress(runId: string): void {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run || run.status !== 'blocked') return;
    const updated = this.config.workflowRunRepo.transitionStatus(runId, 'in_progress');
    if (updated) {
      // Clear any stale failureReason left by the prior block path
      // (agentCrash / humanRejected / execution_failed). Without this the
      // resumed run — and later its terminal record — would still report
      // the old failure reason, mismatching its in_progress / done status.
      const cleanedRun = run.failureReason
        ? (this.config.workflowRunRepo.updateRun(runId, { failureReason: null }) ?? updated)
        : updated;
      // Reset any blocked node executions back to pending so the next tick
      // re-drives them instead of short-circuiting through the existing
      // blocked-execution guard (which would re-block the run before the
      // newly-activated target can make progress).
      this.resetBlockedExecutionsForRun(runId);
      this.promoteCanonicalTaskAfterRunResume(runId);
      if (this.config.internalEventBus) {
        this.config.internalEventBus
          .publish('space.workflowRun.updated', {
            sessionId: 'global',
            spaceId: cleanedRun.spaceId,
            runId: cleanedRun.id,
            run: cleanedRun,
          })
          .catch((err) => {
            log.warn(
              `SpaceRuntimeService: failed to emit space.workflowRun.updated after blocked→in_progress: ${err instanceof Error ? err.message : String(err)}`
            );
          });
      }
    }
  }

  /**
   * Re-register PR event auto-subscriptions for blocked workflow runs after a
   * daemon restart.
   *
   * Auto-subscriptions live in the SpaceRuntime's in-memory topic trie and are
   * lost when the process restarts. This pass walks every space's active runs,
   * resolves the PR URL from gate data / artifacts (same resolver used at
   * runtime), and re-invokes
   * {@link SpaceRuntime.registerPrEventSubscriptionForRun} so subsequent GitHub
   * PR events match a target and trigger delivery / event-driven gate evaluation.
   *
   * Idempotent and best-effort: failures for individual runs are logged and
   * swallowed so one bad run cannot block startup. Skips paused / stopped
   * spaces — those are recovered by {@link rehydrateActiveRunPrEventSubscriptionsForSpace}
   * when the space is resumed.
   */
  async rehydrateActiveRunPrEventSubscriptions(replay = true): Promise<void> {
    try {
      const spaces = await this.config.spaceManager.listSpaces(false);
      let rehydrated = 0;
      for (const space of spaces) {
        if (space.paused || space.stopped) continue;
        rehydrated += this.rehydrateActiveRunPrEventSubscriptionsForSpace(space.id, replay);
      }
      if (rehydrated > 0) {
        log.info(
          `SpaceRuntimeService: rehydrated ${rehydrated} PR event auto-subscription(s) for active runs`
        );
      }
    } catch (err) {
      log.error(
        `SpaceRuntimeService: rehydrateActiveRunPrEventSubscriptions failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async rehydrateBlockedRunPrEventSubscriptions(replay = true): Promise<void> {
    await this.rehydrateActiveRunPrEventSubscriptions(replay);
  }

  /**
   * Space-scoped variant of {@link rehydrateActiveRunPrEventSubscriptions}.
   * Re-registers PR auto-subscriptions for the active runs of a single space —
   * used by the space-resume path (`resumeSpace` RPC) to rebuild subscriptions
   * for previously-paused spaces that were skipped at startup.
   *
   * `replay` (default true) is forwarded to {@link SpaceRuntime.ensurePrEventSubscriptionForRun};
   * the startup `onBeforeRedispatch` path passes false so retained events are
   * not replayed before executors/sessions are restored. Returns the count of
   * successfully re-registered subscriptions. Errors for individual runs are
   * logged and swallowed.
   */
  rehydrateActiveRunPrEventSubscriptionsForSpace(spaceId: string, replay = true): number {
    let rehydrated = 0;
    try {
      const activeRuns = this.config.workflowRunRepo
        .listBySpace(spaceId)
        .filter((run) => run.status === 'blocked' || run.status === 'in_progress');
      for (const run of activeRuns) {
        const result = this.runtime.ensurePrEventSubscriptionForRun(run.id, { replay });
        if (result.subscribed) rehydrated++;
      }
      if (rehydrated > 0) {
        log.info(
          `SpaceRuntimeService: rehydrated ${rehydrated} PR event auto-subscription(s) for active runs in space ${spaceId}`
        );
      }
    } catch (err) {
      log.error(
        `SpaceRuntimeService: rehydrateActiveRunPrEventSubscriptionsForSpace(${spaceId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return rehydrated;
  }

  rehydrateBlockedRunPrEventSubscriptionsForSpace(spaceId: string, replay = true): number {
    return this.rehydrateActiveRunPrEventSubscriptionsForSpace(spaceId, replay);
  }

  /**
   * Reset any `blocked` node executions for a run back to `pending` so the
   * tick loop's executor will re-drive them. Called by
   * {@link transitionBlockedRunToInProgress} so a run resumed via event-driven
   * gate open does not get immediately re-blocked by the existing
   * blocked-execution guard before the newly-activated target can progress.
   *
   * Best-effort — errors are logged and swallowed.
   */
  private resetBlockedExecutionsForRun(runId: string): void {
    // Delegate to the runtime's single source of truth.
    this.runtime.resetBlockedExecutionsForRun(runId);
  }

  private promoteCanonicalTaskAfterRunResume(runId: string): void {
    const tasks = this.config.taskRepo.listByWorkflowRun(runId);
    if (tasks.length === 0) return;
    // Mirror SpaceRuntime.pickCanonicalTaskForRun ordering without taking a
    // cross-class dependency on the private helper: prefer title-matched tasks
    // then lowest taskNumber, then earliest createdAt.
    const run = this.config.workflowRunRepo.getRun(runId);
    const runTitle = run?.title?.trim().toLowerCase() ?? '';
    const titleMatches = runTitle
      ? tasks.filter((task) => (task.title ?? '').trim().toLowerCase() === runTitle)
      : [];
    const pool = titleMatches.length > 0 ? titleMatches : tasks;
    const sorted = [...pool].sort((a, b) => {
      if (a.taskNumber !== b.taskNumber) return a.taskNumber - b.taskNumber;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
    const target = sorted.find((task) => task.status === 'blocked' || task.status === 'review');
    if (!target) return;
    // Clear stale block metadata so the resumed task does not surface the old
    // "Gate rejected" / crash result in the UI and API after the gate has
    // been resolved. Mirrors the SpaceTaskManager.setTaskStatus recovery path
    // which clears these fields when transitioning out of blocked.
    const updatedTask = this.config.taskRepo.updateTask(target.id, {
      status: 'in_progress',
      pendingCheckpointType: null,
      blockReason: null,
      result: null,
    });
    if (!updatedTask || !this.config.internalEventBus) return;
    this.config.internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId: updatedTask.spaceId,
        taskId: updatedTask.id,
        task: updatedTask,
      })
      .catch((err) => {
        log.warn(
          `SpaceRuntimeService: failed to emit space.task.updated after task resume: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  /**
   * Inject a courtesy notification into the active agent session for a blocked
   * run whose gate just opened as a result of an external event. Best-effort:
   * dispatch failures are logged and swallowed so they cannot destabilize the
   * re-evaluation flow.
   */
  private async notifyBlockedRunSessionGateResolved(
    runId: string,
    event: ExternalEventPublishedPayload
  ): Promise<void> {
    const session = this.findActiveSessionForRun(runId);
    if (!session?.sessionId || !this.taskAgentManager) return;
    const actor = `[github:${event.topic}]`;
    const summary = event.summary?.trim() || event.topic;
    const message =
      `[runtime] Gate re-evaluation triggered by external event ${actor} resolved ` +
      `a blocking gate on this run. Summary: ${summary}`;
    try {
      await this.taskAgentManager.injectRuntimeRecoveryMessage(session.sessionId, message);
    } catch (err) {
      log.warn(
        `SpaceRuntimeService: failed to notify blocked session ${session.sessionId} ` +
          `for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private findActiveSessionForRun(runId: string): { sessionId: string } | null {
    const executions = this.nodeExecutionRepo.listByWorkflowRun(runId);
    const active = executions
      .filter((execution) => execution.status === 'in_progress' && execution.agentSessionId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    return active?.agentSessionId ? { sessionId: active.agentSessionId } : null;
  }

  private async replayPendingMessagesAfterRuntimeProvisioning(session: {
    replayPendingMessagesForImmediateMode?: () => Promise<void>;
  }): Promise<void> {
    if (typeof session.replayPendingMessagesForImmediateMode === 'function') {
      await session.replayPendingMessagesForImmediateMode();
    }
  }

  /**
   * Lazily activate a workflow node.
   *
   * Builds a scoped ChannelRouter (same dependencies as `notifyGateDataChanged`)
   * and delegates to `ChannelRouter.activateNode()`, which either reuses an
   * existing node_execution for cyclic re-entry (preserving `agentSessionId` so
   * history survives) or creates a pending execution for the tick loop to spawn.
   *
   * Exposed so the Space Agent's `send_message_to_task` tool can target a
   * specific node even when that node has no live session yet.
   */
  async activateWorkflowNode(runId: string, nodeId: string): Promise<SpaceTask[]> {
    if (!this.config.gateDataRepo) {
      throw new Error(
        'activateWorkflowNode requires gateDataRepo to be configured on SpaceRuntimeService.'
      );
    }
    const run = this.config.workflowRunRepo.getRun(runId);
    let workspacePath: string | undefined;
    if (run) {
      const space = await this.config.spaceManager.getSpace(run.spaceId);
      workspacePath = space?.workspacePath;
    }
    const spaceManager = this.config.spaceManager;
    const taskAgentManager = this.taskAgentManager;
    const router = new ChannelRouter({
      taskRepo: this.config.taskRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      workflowManager: this.config.spaceWorkflowManager,
      agentManager: this.config.spaceAgentManager,
      nodeExecutionRepo: this.nodeExecutionRepo,
      gateDataRepo: this.config.gateDataRepo,
      gateOpenStateRepo: this.config.gateOpenStateRepo,
      channelCycleRepo: this.config.channelCycleRepo,
      db: this.config.db,
      workspacePath,
      gateRetryScheduler: this.gateRetryScheduler,
      getSpaceAutonomyLevel: async (spaceId) => {
        const s = await spaceManager.getSpace(spaceId);
        return s?.autonomyLevel ?? 1;
      },
      isSessionAlive: taskAgentManager ? (sid) => taskAgentManager.isSessionAlive(sid) : undefined,
      cancelSessionById: taskAgentManager
        ? (sid) => taskAgentManager.cancelBySessionId(sid)
        : undefined,
      // Forward the runtime's current sink so activation-driven reopens of
      // terminal runs still surface `workflow_run_reopened` to the Space
      // Agent session (mirrors `notifyGateDataChanged` above).
      // Forward the InternalEventBus so activation-driven reopens also publish
      // typed `space.workflowRun.reopened` events for bus subscribers.
      internalEventBus: this.config.internalEventBus,
      onGateDataChangedComplete: (runId, _gateId, activatedTasks) =>
        this.handleGateDataChangedComplete(runId, activatedTasks),
      getPrUrlForRun: (rid) => this.resolvePrUrlForRun(rid),
    });
    return router.activateNode(runId, nodeId, {
      allowTerminalReopen: true,
      reopenBy: 'space-runtime-service',
      reopenReason: 'explicit workflow node activation',
    });
  }

  /**
   * Resolves the PR URL for a workflow run by scanning gate data records
   * and artifacts. Mirrors SpaceRuntime.resolvePrUrlForRun so temporary
   * ChannelRouters built by notifyGateDataChanged / activateWorkflowNode
   * can inject PR_URL into feature scripts.
   */
  private resolvePrUrlForRun(runId: string): string {
    const fromData = (data: Record<string, unknown> | undefined): string =>
      (typeof data?.prUrl === 'string' && data.prUrl) ||
      (typeof data?.pr_url === 'string' && data.pr_url) ||
      '';

    try {
      const gateDataRepo = this.config.gateDataRepo ?? new GateDataRepository(this.config.db);
      const gateRecords = gateDataRepo.listByRun(runId).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const record of gateRecords) {
        const candidate = fromData(record.data);
        if (candidate) return candidate;
      }
    } catch (err) {
      log.warn(
        `SpaceRuntimeService.resolvePrUrlForRun: failed to read gate data for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Scan workflow hook state next. `pr_ready` hooks persist `pr_url` in
    // localState after a successful send_message handoff (see
    // workflow-hook-engine.ts); without this scan the resolver cannot find
    // PR URLs for review-approval-gate when that gate's schema does not
    // declare `pr_url` (the typical Review→QA handoff case).
    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.config.db);
      const hookStates = hookStateRepo
        .listByRun(runId)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      for (const snapshot of hookStates) {
        const candidate = fromData(snapshot.localState);
        if (candidate) return candidate;
      }
    } catch (err) {
      log.warn(
        `SpaceRuntimeService.resolvePrUrlForRun: failed to read hook state for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (this.config.artifactRepo) {
      try {
        const artifacts = this.config.artifactRepo.listByRun(runId);
        for (let i = artifacts.length - 1; i >= 0; i--) {
          const candidate = fromData(artifacts[i]?.data);
          if (candidate) return candidate;
        }
      } catch (err) {
        log.warn(
          `SpaceRuntimeService.resolvePrUrlForRun: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return '';
  }

  /**
   * Dispatch post-approval routing for a task. Delegates to
   * `SpaceRuntime.dispatchPostApproval`, which:
   *   1. Transitions the task into `approved` (via `SpaceTaskManager.setTaskStatus`).
   *   2. Calls `PostApprovalRouter.route()` to dispatch the configured
   *      post-approval step (no-route, inline Task Agent, or spawn fresh
   *      node-agent sub-session).
   *
   * Called from the `spaceTask.approvePendingCompletion` RPC handler when a
   * human approves a task paused at a `task_completion` checkpoint.
   *
   * The `spaceId` argument is only used for logging at this layer — the
   * underlying runtime looks up the task's actual spaceId from the repository.
   */
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
    targetStatus: 'open' | 'in_progress'
  ): Promise<SpaceTask> {
    const recovered = await this.runtime.recoverWorkflowBackedTask(spaceId, taskId, targetStatus);
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

  async cancelWorkflowRun(spaceId: string, runId: string): Promise<SpaceWorkflowRun> {
    return this.runtime.cancelWorkflowRun(spaceId, runId);
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

/**
 * Resolve the provider for an agent session config.
 *
 * Cached model metadata is authoritative: it knows which provider actually
 * offers the model (e.g. Copilot's `gemini-3.1-pro-preview` / `gpt-5.4`, or a
 * custom endpoint whose model ID merely looks built-in like `glm-4`). Heuristic
 * inference is only a cache-miss fallback, and contested inferences (anthropic
 * catch-all, codex gpt-*) stay undefined so downstream resolution can decide.
 */
function resolveAgentConfigProvider(model: string): Session['config']['provider'] {
  const cached = findInModels(getAvailableModels('global'), model);
  if (cached?.provider) return cached.provider as Session['config']['provider'];
  return inferPersistableProviderForModel(model) as Session['config']['provider'];
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
