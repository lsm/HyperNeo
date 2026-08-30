import type {
  AgentProcessingState,
  ChatMessage,
  ContextInfo,
  CurrentModelInfo,
  DeclarativeToolGuard,
  FallbackModelEntry,
  McpServerConfig,
  MessageContent,
  MessageHub,
  MessageOrigin,
  ModelInfo,
  Provider,
  QuestionDraftResponse,
  RewindMode,
  RewindPreview,
  RewindResult,
  SelectiveRewindPreview,
  SelectiveRewindResult,
  Session,
  SessionConfig,
  SessionContext,
  SessionFeatures,
  SessionMetadata,
  SessionType,
  SkillEnablementOverride,
  SystemPromptConfig,
} from '@hyperneo/shared';
import { generateUUID, DEFAULT_WORKER_FEATURES as WORKER_FEATURES } from '@hyperneo/shared';
import type { Database } from '../../storage/database.ts';
import { ErrorCategory, ErrorManager, type StructuredError } from '../error-manager.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { SettingsManager } from '../settings-manager.ts';
import { runRateLimitManualCancel } from './rate-limit-manual-cancel.ts';
import { runRateLimitManualRetry } from './rate-limit-manual-retry.ts';

export const RECENTLY_EXITED_ROOT_PID_RETENTION_MS = 15 * 60 * 1000;

const SESSION_RECONCILE_INTERVAL_MS = 60_000;

const CLEAR_CONFIRM_TIMEOUT_MS = 45_000;

const MID_TURN_USAGE_REFRESH_INTERVAL_MS = 10_000;

export class ClearConversationCancelledError extends Error {
  constructor() {
    super('clearConversationContext cancelled by query teardown');
    this.name = 'ClearConversationCancelledError';
  }
}

interface NoPidTrackedProcess {
  proc: TrackedAgentProcess;
  exitPromise?: Promise<void>;
  forceKillTimer?: ReturnType<typeof setTimeout>;
}

export interface PromptProvenanceInit {
  source: string;
  hash: string;
  agentId?: string;
  agentName?: string;
  workflowRunId?: string;
  workflowId?: string;
  nodeId?: string;
  nodeName?: string;
}

export interface AgentSessionInit {
  sessionId: string;

  title?: string;

  workspacePath: string;

  systemPrompt?: SystemPromptConfig;

  promptProvenance?: PromptProvenanceInit;

  mcpServers?: Record<string, McpServerConfig>;

  features?: SessionFeatures;

  context?: SessionContext;

  type?: SessionType;

  model?: string;

  provider?: string;

  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;

  coordinatorMode?: boolean;

  agent?: string;

  agents?: Record<string, import('@hyperneo/shared').AgentDefinition>;

  sdkToolsPreset?: import('@hyperneo/shared').ToolsPresetConfig;

  allowedTools?: string[];

  disallowedTools?: string[];

  skillOverrides?: SkillEnablementOverride[];
  toolGuards?: DeclarativeToolGuard[];
  settingSources?: import('@hyperneo/shared').SettingSource[];
}

export interface AgentSessionRuntimeOptions {
  autoReplayPendingMessages?: boolean;

  hardReset?: (
    session: AgentSession,
    options: { restartQuery: boolean }
  ) => Promise<{ success: boolean; error?: string }>;
}

import {
  isSDKResultSuccess,
  isSDKSessionStateChangedMessage,
} from '@hyperneo/shared/sdk/type-guards';
import { AcpQueryRunner } from '../acp/acp-query-runner.ts';
import {
  ensureScopedProviderCatalogModels,
  getSessionModelInfo,
  initializeModels,
  resolveModelAlias,
} from '../model-service.ts';
import { getProviderService } from '../provider-service.ts';
import { getProviderRegistry } from '../providers/factory.js';
import {
  AskUserQuestionHandler,
  type AskUserQuestionHandlerContext,
} from './ask-user-question-handler.ts';
import {
  contextBudgetThreshold,
  decideContextBudgetCompaction,
} from './context-budget-decision.ts';
import { runContextBudgetReevaluation } from './context-budget-enforcement.ts';
import { ContextTracker } from './context-tracker.ts';
import {
  EventSubscriptionSetup,
  type EventSubscriptionSetupContext,
} from './event-subscription-setup.ts';
import { resolveFallbackChain } from './fallback-recovery.ts';
import type { IdleOwnerScope } from './idle-waiter-admission-pipeline.ts';
import { InterruptHandler, type InterruptHandlerContext } from './interrupt-handler.ts';
import type { LimitRetryHint } from './limit-error-classifier.ts';
import { LimitErrorLlmClassifier } from './limit-error-llm-classifier.ts';
import {
  admitAcrossContextClearBoundary,
  type DeliveryOutcome,
  type DriveTurnOutcome,
  deliverMessage,
  deliveryConsumptionTimeoutMs,
  deliveryConsumptionTimeoutOrDefault,
  MANUAL_RECOVERY_PARK_MS,
  MESSAGE_DELIVERY_PARK_MS,
  type MessageDeliveryAttemptObserver,
  MessageDeliveryRecoverableTurnError,
  MessageDeliveryTerminalTurnError,
  signalDeliveryConsumed,
  throwIfDeliveryAborted,
  acquireContextClearBoundary,
  type ContextClearBoundaryOwner,
  waitForDeliveryAbort,
  waitForDeliveryConsumption,
  withSessionLock,
} from './message-delivery.ts';
import { decideReconcileAdmission, selectStrandedDeliveries } from './message-delivery-pipeline.ts';
import { deliveryMetrics } from './message-delivery-metrics.ts';
import type { MidTurnBudgetInterruptOptions } from './message-queue.ts';
import { MessageQueue } from './message-queue.ts';
import { runMidTurnBudgetPipeline } from './mid-turn-budget-pipeline.ts';
import { ModelSwitchHandler, type ModelSwitchHandlerContext } from './model-switch-handler.ts';
import { ProcessingStateManager } from './processing-state-manager.ts';
import { QueryAttemptRegistry, type QueryAttemptToken } from './query-attempt-token.ts';
import {
  QueryLifecycleManager,
  type QueryLifecycleManagerContext,
} from './query-lifecycle-manager.ts';
import type { QueryLike } from './query-like.ts';
import { QueryModeHandler, type QueryModeHandlerContext } from './query-mode-handler.ts';
import {
  NATIVE_CONTEXT_WINDOW_PROVIDER_IDS,
  QueryOptionsBuilder,
  type QueryOptionsBuilderContext,
} from './query-options-builder.ts';
import {
  type OriginalEnvVars,
  QueryRunner,
  type QueryRunnerContext,
  type TrackedAgentProcess,
} from './query-runner.ts';
import { RateLimitWatchdog } from './rate-limit-watchdog.ts';
import { selectStaleSubmittedDeliveries } from './reconciler-sweep.ts';
import { RewindHandler, type RewindHandlerContext, type RewindPoint } from './rewind-handler.ts';
import {
  boundedDeliveryGate,
  SDKMessageHandler,
  type SDKMessageHandlerContext,
  type SuppressedResultOutcome,
} from './sdk-message-handler.ts';
import { SDKRuntimeConfig, type SDKRuntimeConfigContext } from './sdk-runtime-config.ts';
import {
  SessionConfigHandler,
  type SessionConfigHandlerContext,
} from './session-config-handler.ts';
import { SlashCommandManager, type SlashCommandManagerContext } from './slash-command-manager.ts';
import {
  buildTaskNotificationRequeryEscalationEvent,
  resolveTaskNotificationRequery,
  TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE,
  TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
  taskNotificationRequeryDelayMs,
} from './task-notification-requery.ts';

export class AgentSession
  implements
    RewindHandlerContext,
    InterruptHandlerContext,
    SDKRuntimeConfigContext,
    QueryModeHandlerContext,
    SlashCommandManagerContext,
    ModelSwitchHandlerContext,
    QueryRunnerContext,
    SDKMessageHandlerContext,
    QueryLifecycleManagerContext,
    AskUserQuestionHandlerContext,
    QueryOptionsBuilderContext,
    EventSubscriptionSetupContext,
    SessionConfigHandlerContext
{
  readonly messageQueue: MessageQueue;
  readonly stateManager: ProcessingStateManager;
  readonly contextTracker: ContextTracker;
  readonly messageHandler: SDKMessageHandler;
  readonly lifecycleManager: QueryLifecycleManager;
  readonly modelSwitchHandler: ModelSwitchHandler;
  readonly askUserQuestionHandler: AskUserQuestionHandler;
  readonly optionsBuilder: QueryOptionsBuilder;
  readonly attemptTokens = new QueryAttemptRegistry();

  private queryRunner: QueryRunner | AcpQueryRunner;
  readonly interruptHandler: InterruptHandler;
  private interruptRequests = 0;
  private sdkRuntimeConfig: SDKRuntimeConfig;
  private eventSubscriptionSetup: EventSubscriptionSetup;
  readonly queryModeHandler: QueryModeHandler;
  private slashCommandManager: SlashCommandManager;

  private rewindHandler: RewindHandler;

  private sessionConfigHandler: SessionConfigHandler;

  private rateLimitWatchdog: RateLimitWatchdog;

  queryObject: QueryLike | null = null;
  private queryPromiseValue: Promise<void> | null = null;
  private queryLiveness: { promise: Promise<void>; isLive: () => boolean } | null = null;
  get queryPromise(): Promise<void> | null {
    return this.queryPromiseValue;
  }
  set queryPromise(next: Promise<void> | null) {
    this.queryPromiseValue = next;
    if (!next) {
      this.queryLiveness = null;
      return;
    }
    let live = true;
    next.then(
      () => {
        live = false;
      },
      () => {
        live = false;
      }
    );
    this.queryLiveness = { promise: next, isLive: () => live };
  }
  hasLiveQuery(): boolean {
    const tracked = this.queryLiveness;
    if (!tracked || this.queryPromiseValue !== tracked.promise) return false;
    return tracked.isLive();
  }
  private _queryGeneration = 0;
  queryAbortController: AbortController | null = null;
  firstMessageReceived = false;
  startupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  private lastTerminalError: { error: StructuredError; at: number } | null = null;

  private taskNotificationRequeryAttempts = 0;
  private taskNotificationRequeryExhausted = false;
  private taskNotificationRequeryTimer: ReturnType<typeof setTimeout> | null = null;
  private taskNotificationRequeryPending = false;
  private taskNotificationRequeryPendingDelayMs: number | null = null;
  private taskNotificationRequeryInterruptionGeneration: number | null = null;
  private taskNotificationRequerySuppressedGeneration: number | null = null;
  private taskNotificationRequeryContinueMessageId: string | null = null;
  private taskNotificationRequeryEpisodeToken = 0;
  private taskNotificationRequeryAwaitingSdkIdle = false;
  private taskNotificationRequeryBusyInterruptGeneration: number | null = null;
  private taskNotificationRequeryObservingResultDepth = 0;

  private outstandingToolUseIds = new Set<string>();

  private readonly deliveryErrorSubs: Array<() => void> = [];
  originalEnvVars: OriginalEnvVars = {};
  processExitedPromise: Promise<void> | null = null;
  private trackedAgentProcesses = new Map<number, TrackedAgentProcess>();
  private trackedAgentProcessExitPromises = new Map<number, Promise<void>>();
  private noPidAgentProcesses: NoPidTrackedProcess[] = [];
  private recentlyExitedAgentRootPids = new Map<number, number>();
  private forceKillTimers = new Map<number, ReturnType<typeof setTimeout>>();

  private _isCleaningUp = false;
  private pendingResumeSessionAt: string | undefined;
  private pendingResumeAfterCompaction = false;
  private midTurnBudgetCheckInFlight = false;

  private contextBudgetReevaluationQueue: Promise<void> = Promise.resolve();
  private lastMidTurnUsageRefreshAt = 0;
  private lastMidTurnUsageRefreshKey = '';
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcilerProvisioned = false;
  pendingRestartReason: 'settings.local.json' | null = null;
  private initialPendingReplayScheduled = false;
  private clearConfirmTimeoutMs = CLEAR_CONFIRM_TIMEOUT_MS;

  readonly errorManager: ErrorManager;
  settingsManager: SettingsManager;
  readonly logger: Logger;

  onMissingWorkflowMcpServers?: (session: AgentSession, missing: string[]) => Promise<void>;

  onMissingSpaceChatMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  onMissingMemberSpaceMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  slotResetsContext?: () => boolean;

  renderPendingDigest?: (
    sessionId: string,
    taskId?: string
  ) => Promise<
    import('../space/runtime/render-pending-digest-pipeline.ts').RenderPendingDigestOutcome | null
  >;

  get mcpEnablementRepo(): import('../../storage/repositories/mcp-enablement-repository.ts').McpEnablementRepository {
    return this.db.mcpEnablement;
  }

  constructor(
    readonly session: Session,
    readonly db: Database,
    readonly messageHub: MessageHub,
    readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private getApiKey: () => Promise<string | null>,
    readonly skillsManager?: import('../skills-manager.ts').SkillsManager,
    readonly appMcpServerRepo?: import('../../storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
    public skillOverrides?: SkillEnablementOverride[],
    public toolGuards?: DeclarativeToolGuard[],
    private readonly runtimeOptions: AgentSessionRuntimeOptions = {}
  ) {
    this.errorManager = new ErrorManager(this.messageHub, this.internalEventBus);
    this.logger = new Logger(`AgentSession ${session.id}`);

    this.deliveryErrorSubs.push(
      this.internalEventBus.subscribe(
        'session.errorObserved',
        (data) => {
          if (data.sessionId !== this.session.id) return;
          const details = data.details as StructuredError | undefined;
          if (!details) return;
          this.lastTerminalError = { error: details, at: Date.now() };
        },
        { subscriberName: 'AgentSession.deliveryTurnError' }
      )
    );
    this.deliveryErrorSubs.push(
      this.internalEventBus.subscribe(
        'session.errorClear',
        (data) => {
          if (data.sessionId !== this.session.id) return;
          this.lastTerminalError = null;
        },
        { subscriberName: 'AgentSession.deliveryTurnErrorClear' }
      )
    );
    this.deliveryErrorSubs.push(
      this.internalEventBus.subscribe(
        'sdk.toolUse.created',
        (data) => {
          if (data.sessionId !== this.session.id) return;
          this.outstandingToolUseIds.add(data.toolUseId);
        },
        { subscriberName: 'AgentSession.stallWatchdogToolUse' }
      )
    );
    this.deliveryErrorSubs.push(
      this.internalEventBus.subscribe(
        'sdk.toolUse.consumed',
        (data) => {
          if (data.sessionId !== this.session.id) return;
          this.outstandingToolUseIds.delete(data.toolUseId);
        },
        { subscriberName: 'AgentSession.stallWatchdogToolResult' }
      )
    );
    this.settingsManager = new SettingsManager(
      this.db,
      this.session.worktree?.worktreePath ?? this.session.workspacePath ?? undefined
    );

    this.messageQueue = new MessageQueue();
    this.stateManager = new ProcessingStateManager(session.id, internalEventBus, db);
    this.contextTracker = new ContextTracker(session.id, (contextInfo: ContextInfo) => {
      this.session.metadata.lastContextInfo = contextInfo;
      this.db.updateSession(this.session.id, { metadata: this.session.metadata });
    });

    this.messageHandler = new SDKMessageHandler(this);

    this.lifecycleManager = new QueryLifecycleManager(this);

    this.modelSwitchHandler = new ModelSwitchHandler(this);

    this.askUserQuestionHandler = new AskUserQuestionHandler(this);

    this.optionsBuilder = new QueryOptionsBuilder(this);

    this.queryRunner =
      session.config.provider === 'acp' ? new AcpQueryRunner(this) : new QueryRunner(this);

    this.interruptHandler = new InterruptHandler(this);

    this.sdkRuntimeConfig = new SDKRuntimeConfig(this);

    this.queryModeHandler = new QueryModeHandler(this);

    this.slashCommandManager = new SlashCommandManager(this);

    this.rewindHandler = new RewindHandler(this);

    this.sessionConfigHandler = new SessionConfigHandler(this);

    this.rateLimitWatchdog = new RateLimitWatchdog(session.id, this.stateManager, {
      getCurrentModel: () => ({
        provider: (this.session.config.provider as string | undefined) ?? 'anthropic',
        model: this.session.config.model ?? 'sonnet',
      }),
      resolveChain: async () => {
        const gs = this.settingsManager.getGlobalSettings();
        const provider = (this.session.config.provider as string | undefined) ?? 'anthropic';
        const rawModel = this.session.config.model ?? 'sonnet';
        const canonicalModel = await this.resolveModelIdOrDefault(provider, rawModel);
        return resolveFallbackChain(
          provider,
          canonicalModel,
          gs.modelFallbackMap,
          gs.fallbackModels
        );
      },
      isEntryAvailable: async (entry) => {
        try {
          const reg = getProviderRegistry();
          const p = reg.detectProviderForModel(entry.model, entry.provider);
          if (!p) return false;
          return await Promise.resolve(p.isAvailable());
        } catch {
          return false;
        }
      },
      switchAndRetry: (lastUserMessage, entry, episodeGeneration, queryGeneration) =>
        this.switchAndRetryForFallback(lastUserMessage, entry, episodeGeneration, queryGeneration),
      resolveModelId: async (provider, model) => this.resolveModelIdOrDefault(provider, model),
      getQueryGeneration: () => this.getQueryGeneration(),
      notifyPause: (payload) => {
        this.internalEventBus.publish('session.rate_limit_pause', {
          sessionId: this.session.id,
          kind: payload.kind,
          resetAt: payload.resetAt,
          reason: payload.reason,
        });
      },
      notifyResume: () => {
        this.internalEventBus.publish('session.rate_limit_resume', {
          sessionId: this.session.id,
        });
      },
      classifyUnknownLimit: (rawText: string) =>
        new LimitErrorLlmClassifier(this.session.id, {
          providerService: getProviderService(),
          excludeProvider: (this.session.config.provider as string | undefined) ?? 'anthropic',
        }).classifyWithTimeout(rawText),
    });
    this.rateLimitWatchdog.setRetryCallback(
      async (lastUserMessage, switchTo, episodeGeneration, queryGeneration) => {
        if (switchTo) {
          return await this.switchAndRetryForFallback(
            lastUserMessage,
            switchTo,
            episodeGeneration,
            queryGeneration
          );
        }
        return await this.executeRateLimitAutoRetry(
          lastUserMessage,
          episodeGeneration,
          queryGeneration
        );
      }
    );

    this.eventSubscriptionSetup = new EventSubscriptionSetup(this);

    this.stateManager.setOnIdleCallback(async (owner) => {
      const restarted = await this.lifecycleManager.executeDeferredRestartIfPending();
      this.flushPendingTaskNotificationRequery();
      const reconcileOwner = restarted ? this.stateManager.getCurrentIdleOwner() : owner;
      void this.reconcileStrandedDeliveries(reconcileOwner).catch((error) => {
        this.logger.warn('Idle reconcileStrandedDeliveries failed:', error);
      });
    });

    if (session.metadata?.lastContextInfo) {
      this.contextTracker.restoreFromMetadata(session.metadata.lastContextInfo);
      void this.reevaluateContextBudgetAfterModelSwitch();
    }
    this.stateManager.restoreFromDatabase();
    this.armPersistedRateLimitCooldown();

    this.eventSubscriptionSetup.setup();

    if (this.runtimeOptions.autoReplayPendingMessages ?? true) {
      this.scheduleInitialPendingMessageReplay();
      void this.reconcileStrandedDeliveries().catch((error) => {
        this.logger.warn('Startup reconcileStrandedDeliveries failed:', error);
      });
    }

    this.reconcilerProvisioned = this.runtimeOptions.autoReplayPendingMessages ?? true;
    this.reconcileTimer = setInterval(() => {
      if (!this.reconcilerProvisioned) return;
      void this.reconcileStrandedDeliveries().catch((error) => {
        this.logger.warn('Periodic reconcileStrandedDeliveries failed:', error);
      });
    }, SESSION_RECONCILE_INTERVAL_MS);
    if (typeof this.reconcileTimer.unref === 'function') {
      this.reconcileTimer.unref();
    }
  }

  static fromInit(
    init: AgentSessionInit,
    db: Database,
    messageHub: MessageHub,
    internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    getApiKey: () => Promise<string | null>,
    defaultModel: string,
    skillsManager?: import('../skills-manager.ts').SkillsManager,
    appMcpServerRepo?: import('../../storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository
  ): AgentSession {
    let session = db.getSession(init.sessionId);

    if (!session) {
      session = AgentSession.createSessionFromInit(init, defaultModel);
      db.createSession(session);
    } else {
      const updates: Partial<Session> = {};
      let hasUpdates = false;

      if (init.workspacePath && session.workspacePath !== init.workspacePath) {
        updates.workspacePath = init.workspacePath;
        session = { ...session, workspacePath: init.workspacePath };
        hasUpdates = true;
      }

      if (init.type && session.type !== init.type) {
        updates.type = init.type;
        session = { ...session, type: init.type };
        hasUpdates = true;
      }

      if (
        init.context &&
        JSON.stringify(session.context ?? null) !== JSON.stringify(init.context)
      ) {
        updates.context = init.context;
        session = { ...session, context: init.context };
        hasUpdates = true;
      }

      if (session.config.thinkingLevel !== init.thinkingLevel) {
        const nextConfig: SessionConfig = { ...session.config };
        if (init.thinkingLevel === undefined) {
          delete nextConfig.thinkingLevel;
        } else {
          nextConfig.thinkingLevel = init.thinkingLevel;
        }
        updates.config = nextConfig;
        session = { ...session, config: nextConfig };
        hasUpdates = true;
      }

      if (
        init.type === 'worker' &&
        init.agents &&
        JSON.stringify(session.config.agents ?? null) !== JSON.stringify(init.agents)
      ) {
        const nextConfig: SessionConfig = { ...session.config, agents: init.agents };
        updates.config = nextConfig;
        session = { ...session, config: nextConfig };
        hasUpdates = true;
      }

      if (init.type && init.type !== 'worker' && session.worktree) {
        updates.worktree = undefined;
        session = { ...session, worktree: undefined };
        hasUpdates = true;
      }

      if (
        init.promptProvenance &&
        JSON.stringify(session.metadata.promptProvenance ?? null) !==
          JSON.stringify(init.promptProvenance)
      ) {
        const nextMetadata: SessionMetadata = {
          ...session.metadata,
          promptProvenance: init.promptProvenance,
        };
        updates.metadata = nextMetadata;
        session = { ...session, metadata: nextMetadata };
        hasUpdates = true;
      }

      if (hasUpdates) {
        db.updateSession(init.sessionId, updates);
      }
    }

    if (init.mcpServers) {
      session = {
        ...session,
        config: {
          ...session.config,
          mcpServers: init.mcpServers,
        },
      };
    }

    const agentSession = new AgentSession(
      session,
      db,
      messageHub,
      internalEventBus,
      getApiKey,
      skillsManager,
      appMcpServerRepo,
      init.skillOverrides,
      init.toolGuards
    );
    return agentSession;
  }

  static restore(
    sessionId: string,
    db: Database,
    messageHub: MessageHub,
    internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    getApiKey: () => Promise<string | null>,
    skillsManager?: import('../skills-manager.ts').SkillsManager,
    appMcpServerRepo?: import('../../storage/repositories/app-mcp-server-repository.ts').AppMcpServerRepository,
    options?: AgentSessionRuntimeOptions
  ): AgentSession | null {
    const session = db.getSession(sessionId);
    if (!session) return null;

    const agentSession = new AgentSession(
      session,
      db,
      messageHub,
      internalEventBus,
      getApiKey,
      skillsManager,
      appMcpServerRepo,
      undefined,
      session.config.toolGuards,
      options
    );
    return agentSession;
  }

  static createSessionFromInit(init: AgentSessionInit, defaultModel: string): Session {
    const now = new Date().toISOString();
    const type = init.type ?? 'worker';
    const features = init.features ?? WORKER_FEATURES;

    const config: SessionConfig = {
      model: init.model ?? defaultModel,
      provider: init.provider as Provider | undefined,
      thinkingLevel: init.thinkingLevel,
      maxTokens: 4096,
      temperature: 1.0,
      systemPrompt: init.systemPrompt,
      features,
      tools: type !== 'worker' ? { useClaudeCodePreset: false } : undefined,
      coordinatorMode: init.coordinatorMode,
      agent: init.agent,
      agents: init.agents,
      sdkToolsPreset: init.sdkToolsPreset,
      allowedTools: init.allowedTools,
      disallowedTools: init.disallowedTools,
      toolGuards: init.toolGuards,
      settingSources: init.settingSources,
    };

    const metadata: SessionMetadata = {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      titleGenerated: Boolean(init.title),
      ...(init.promptProvenance ? { promptProvenance: init.promptProvenance } : {}),
    };

    return {
      id: init.sessionId,
      title: init.title ?? 'New Session',
      workspacePath: init.workspacePath,
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      config,
      metadata,
      type,
      context: init.context,
    };
  }

  async startStreamingQuery(): Promise<void> {
    if (this.session.status === 'archived' || this.session.status === 'ended') {
      throw new Error(
        `Session ${this.session.id} is ${this.session.status}; refusing to start the query`
      );
    }
    const wantsAcp = this.session.config.provider === 'acp';
    const hasAcpRunner = this.queryRunner instanceof AcpQueryRunner;
    if (wantsAcp !== hasAcpRunner) {
      (
        this.queryRunner as unknown as { invalidateAttemptTokens?: () => void }
      ).invalidateAttemptTokens?.();
      this.queryRunner = wantsAcp ? new AcpQueryRunner(this) : new QueryRunner(this);
    }
    await this.queryRunner.start();
  }

  private armPersistedRateLimitCooldown(): void {
    const persistedState = this.db.getSession(this.session.id)?.processingState;
    if (!persistedState) return;
    try {
      const parsed = JSON.parse(persistedState) as {
        status?: string;
        retryAt?: unknown;
        messageId?: unknown;
        retryCount?: unknown;
        maxRetries?: unknown;
      };
      if (
        parsed.status === 'rate_limit_cooldown' &&
        typeof parsed.retryAt === 'number' &&
        parsed.retryAt > Date.now()
      ) {
        const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
        this.rateLimitWatchdog.armPersistedCooldown(parsed.retryAt, messageId, () => {
          void this.stateManager.setIdle().catch(() => {});
        });
        void this.stateManager
          .setRateLimitCooldown({
            retryCount: typeof parsed.retryCount === 'number' ? parsed.retryCount : 0,
            maxRetries: typeof parsed.maxRetries === 'number' ? parsed.maxRetries : 0,
            retryAt: parsed.retryAt,
            ...(messageId !== undefined ? { messageId } : {}),
          })
          .catch(() => {});
      }
    } catch {
      this.logger.warn('Failed to restore the persisted rate-limit cooldown.');
    }
  }

  private scheduleInitialPendingMessageReplay(): void {
    if (this.initialPendingReplayScheduled) return;
    const restoredState = this.stateManager.getState();
    if (this.session.config.queryMode === 'manual') return;
    if (restoredState.status === 'waiting_for_input') return;
    this.initialPendingReplayScheduled = true;
    queueMicrotask(() => {
      this.replayPendingMessagesForImmediateMode().catch((error) => {
        this.logger.warn('Failed to replay pending messages after startup:', error);
      });
    });
  }

  async replayPendingMessagesForImmediateMode(): Promise<boolean> {
    this.reconcilerProvisioned = true;
    return this.queryModeHandler.replayPendingMessagesForAutomaticTurnEnd();
  }

  async replayAllPendingMessages(): Promise<void> {
    this.reconcilerProvisioned = true;
    await this.queryModeHandler.replayPendingMessagesForImmediateMode();
  }

  async sendEnqueuedMessagesOnTurnEnd(options?: {
    pendingTaskInput?: boolean;
    skipResetCoordination?: boolean;
  }): Promise<{ replayedWork: boolean; clearedContext: boolean; replayFailed: boolean }> {
    return this.queryModeHandler.sendEnqueuedMessagesOnTurnEnd(options);
  }

  async ensureQueryStarted(): Promise<void> {
    await this.lifecycleManager.ensureQueryStarted();
  }

  async startQueryAndEnqueue(
    messageId: string,
    messageContent: string | MessageContent[],
    episodeGeneration?: number,
    options?: { prepend?: boolean; queryGeneration?: number }
  ): Promise<'started' | 'aborted'> {
    if (episodeGeneration === undefined) {
      this.rateLimitWatchdog.cancel();
    } else {
      this.rateLimitWatchdog.clearPendingCooldown();
    }
    return await this.lifecycleManager.startQueryAndEnqueue(
      messageId,
      messageContent,
      episodeGeneration,
      options
    );
  }

  removeQueuedMessage(messageId: string): boolean {
    return this.messageQueue.remove(messageId);
  }

  async revokePendingDelivery(
    messageDbId: string,
    mode: 'remove' | 'defer'
  ): Promise<
    { changed: false } | { changed: true; dbId: string; uuid: string; removedFromMemory: boolean }
  > {
    const result = await withSessionLock(this.session.id, async () => {
      const result =
        mode === 'remove'
          ? this.db.deletePendingUserMessage(this.session.id, messageDbId)
          : this.db.deferEnqueuedUserMessage(this.session.id, messageDbId);
      if (!result?.uuid) return { changed: false as const };

      this.db.getJobQueueRepo().cancelDelivery(this.session.id, result.uuid);
      const removedFromMemory = this.messageQueue.remove(result.uuid);
      await this.stateManager.clearQueuedIfOwnedBy(result.uuid);
      this.db.notifyChange?.('sdk_messages', { sessionId: this.session.id });
      this.db.notifyChange?.('job_queue', { sessionId: this.session.id });
      return {
        changed: true as const,
        dbId: result.dbId,
        uuid: result.uuid,
        removedFromMemory,
      };
    });
    this.flushPendingTaskNotificationRequery();
    return result;
  }

  async handleInterrupt(opts?: {
    preserveDeliveryJobs?: boolean;
    skipDeferredReplay?: boolean;
  }): Promise<void> {
    this.interruptRequests += 1;
    try {
      this.rateLimitWatchdog.cancel();
      this.clearPendingResumeAfterCompaction();
      this.messageHandler.cancelSuppressedResultWait();
      const yieldedContinuationId = this.taskNotificationRequeryContinueMessageId;
      if (
        yieldedContinuationId &&
        this.stateManager.getState().status === 'idle' &&
        (this.messageQueue.isRunning() || this.queryPromise)
      ) {
        await this.stateManager.setProcessing(yieldedContinuationId, 'initializing');
      }

      await this.interruptHandler.handleInterrupt(opts);
    } finally {
      this.interruptRequests -= 1;
    }
  }

  onInterruptRequested(): void {
    const status = this.stateManager.getState().status;
    if (status !== 'idle' && status !== 'interrupted') {
      this.taskNotificationRequerySuppressedGeneration = this.getQueryGeneration();
    } else if (
      this.taskNotificationRequeryAwaitingSdkIdle ||
      this.taskNotificationRequeryContinueMessageId !== null
    ) {
      this.taskNotificationRequeryBusyInterruptGeneration = this.getQueryGeneration();
    }
    this.resetTaskNotificationRequery();
  }

  isInterruptInProgress(): boolean {
    return (
      this.interruptRequests > 0 ||
      this.interruptHandler.isInterruptRequested() ||
      this.interruptHandler.getInterruptPromise() !== null
    );
  }

  async normalizeStaleInterruptedState(): Promise<void> {
    if (this.getProcessingState().status !== 'interrupted') return;
    if (this.isInterruptInProgress()) return;
    await this.stateManager.setIdle();
  }

  async resetQuery(options?: {
    restartQuery?: boolean;
    hardReset?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    this.rateLimitWatchdog.cancel();

    const restartQuery = options?.restartQuery ?? true;
    if (options?.hardReset && this.runtimeOptions.hardReset) {
      return await this.runtimeOptions.hardReset(this, { restartQuery });
    }

    return await this.lifecycleManager.reset({ restartAfter: restartQuery });
  }

  async clearConversationContext(boundaryOwner?: ContextClearBoundaryOwner): Promise<void> {
    if (boundaryOwner) {
      await this.runClearConversationFlow();
      return;
    }
    const owner = await acquireContextClearBoundary(this.session.id);
    try {
      await this.runClearConversationFlow();
    } finally {
      owner.release();
    }
  }

  private async runClearConversationFlow(): Promise<void> {
    const pastSdkSessionIds = this.nextPastSdkSessionIds();
    const lastSdkCost = this.session.metadata?.lastSdkCost || 0;
    if (lastSdkCost > 0 || pastSdkSessionIds) {
      const costBaseline = this.session.metadata?.costBaseline || 0;
      this.session.metadata = {
        ...this.session.metadata,
        costBaseline: lastSdkCost > 0 ? costBaseline + lastSdkCost : costBaseline,
        lastSdkCost: lastSdkCost > 0 ? 0 : this.session.metadata?.lastSdkCost,
        ...(pastSdkSessionIds ? { pastSdkSessionIds } : {}),
      };
      this.db.updateSession(this.session.id, { metadata: this.session.metadata });
    }

    await this.lifecycleManager.ensureQueryStarted();
    this.messageHandler.suppressIdleForNextResult();
    const clearMessageId = generateUUID();
    const confirmedClear = this.messageHandler.armSuppressedResultWait(clearMessageId);
    let clearWaitOutcome: SuppressedResultOutcome | null = null;
    void confirmedClear.then((outcome) => {
      clearWaitOutcome = outcome;
    });
    try {
      await this.messageQueue.enqueueWithId(clearMessageId, '/clear', true);
    } catch (err) {
      this.messageHandler.clearIdleSuppression();
      if (clearWaitOutcome === 'cancelled') {
        throw new ClearConversationCancelledError();
      }
      if (err instanceof Error && err.name === 'MessageQueueTimeoutError') {
        this.logger.warn(
          `clearConversationContext: /clear delivery to the SDK timed out — resetting the ` +
            `query before rethrowing`
        );
        await this.resetQueryForcingTeardown();
      }
      throw err;
    }
    this.messageHandler.markClearMessageSent();
    this.messageHandler.startSuppressedResultTimer(this.clearConfirmTimeoutMs);
    const clearOutcome = await confirmedClear;
    if (clearOutcome === 'confirmed') {
      return;
    }
    this.messageHandler.clearIdleSuppression();
    if (clearOutcome === 'cancelled') {
      throw new ClearConversationCancelledError();
    }
    this.logger.warn(
      `clearConversationContext: /clear not confirmed within ${this.clearConfirmTimeoutMs / 1000}s ` +
        `— resetting the query and proceeding without confirmed clear`
    );
    await this.resetQueryForcingTeardown();
  }

  private async resetQueryForcingTeardown(): Promise<void> {
    const resetResult = await this.resetQuery();
    if (!resetResult.success) {
      this.logger.warn(
        `clearConversationContext: query reset failed (${resetResult.error ?? 'unknown error'}) ` +
          `— forcing query teardown before proceeding`
      );
      await this.lifecycleManager.stop({ catchQueryErrors: true }).catch((stopError) => {
        this.logger.warn('clearConversationContext: forced teardown failed:', stopError);
      });
    }
  }

  overrideClearConfirmTimeoutMsForTest(ms: number): void {
    this.clearConfirmTimeoutMs = ms;
  }

  private nextPastSdkSessionIds(): string[] | undefined {
    const current = this.session.sdkSessionId;
    if (!current) return undefined;
    const existing = this.session.metadata?.pastSdkSessionIds ?? [];
    if (existing[existing.length - 1] === current) return undefined;
    const PAST_SDK_SESSION_IDS_CAP = 50;
    const next = [...existing, current];
    return next.length > PAST_SDK_SESSION_IDS_CAP
      ? next.slice(next.length - PAST_SDK_SESSION_IDS_CAP)
      : next;
  }

  private async switchAndRetryForFallback(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    entry: FallbackModelEntry,
    episodeGeneration: number,
    queryGeneration?: number
  ): Promise<boolean> {
    if (!lastUserMessage) {
      this.logger.warn('Fallback switch skipped: no last user message available.');
      await this.stateManager.setIdle();
      return false;
    }
    const querySuperseded = (): boolean =>
      queryGeneration !== undefined && this.getQueryGeneration() !== queryGeneration;
    try {
      if (this.queryPromise) {
        try {
          await this.queryPromise;
        } catch {}
      }

      if (this.rateLimitWatchdog.isSuperseded(episodeGeneration) || querySuperseded()) {
        this.logger.info('Fallback switch aborted after teardown (episode superseded).');
        return false;
      }

      if (!this.session.config.provider) {
        this.session.config.provider = 'anthropic';
        this.db.updateSession(this.session.id, {
          config: { model: this.session.config.model, provider: 'anthropic' } as SessionConfig,
        });
      }

      const result = await this.handleModelSwitch(entry.model, entry.provider);
      if (this.rateLimitWatchdog.isSuperseded(episodeGeneration) || querySuperseded()) {
        this.logger.info('Fallback switch aborted after model switch (episode superseded).');
        return false;
      }
      if (!result.success) {
        this.logger.warn(
          `Fallback switch to ${entry.provider}/${entry.model} failed: ${result.error}. ` +
            `Will try the next chain entry.`
        );
        return false;
      }

      return await this.executeRateLimitAutoRetry(
        lastUserMessage,
        episodeGeneration,
        queryGeneration
      );
    } catch (err) {
      this.logger.error('Fallback switch-and-retry failed:', err);
      await this.stateManager.setIdle();
      return false;
    }
  }

  private async resolveModelIdOrDefault(provider: string, model: string): Promise<string> {
    try {
      return await resolveModelAlias(model, 'global', provider);
    } catch {
      return model;
    }
  }

  private async executeRateLimitAutoRetry(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    episodeGeneration?: number,
    queryGeneration?: number
  ): Promise<boolean> {
    if (!lastUserMessage) {
      this.logger.warn('Rate limit auto-retry skipped: no last user message available.');
      await this.stateManager.setIdle();
      return false;
    }

    this.logger.info(
      `Rate limit auto-retry: re-enqueueing user message ${lastUserMessage.uuid} ` +
        `and restarting query.`
    );

    try {
      await this.stateManager.setIdle({ suppressDeliveryWaiters: true });

      if (
        episodeGeneration !== undefined &&
        this.rateLimitWatchdog.isSuperseded(episodeGeneration)
      ) {
        this.logger.info('Rate limit auto-retry aborted before re-enqueue (episode superseded).');
        this.stateManager.releaseIdleWaiters(episodeGeneration);
        return false;
      }
      if (queryGeneration !== undefined && this.getQueryGeneration() !== queryGeneration) {
        this.logger.info(
          'Rate limit auto-retry aborted before re-enqueue (the originating query was superseded).'
        );
        return false;
      }

      const retryOutcome = await this.startQueryAndEnqueue(
        lastUserMessage.uuid,
        lastUserMessage.content,
        episodeGeneration,
        { prepend: true, queryGeneration }
      );
      if (retryOutcome === 'aborted') {
        this.logger.info(
          'Rate limit auto-retry aborted during re-enqueue (the originating query was superseded).'
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error('Rate limit auto-retry failed:', error);
      if (queryGeneration === undefined || this.getQueryGeneration() === queryGeneration) {
        await this.stateManager.setIdle({ suppressDeliveryWaiters: true });
      }
      return false;
    }
  }

  cancelRateLimitRetry(): void {
    runRateLimitManualCancel({
      db: this.db,
      sessionId: this.session.id,
      getLiveEpisodeMessageUuid: () => this.rateLimitWatchdog.getState().lastUserMessage?.uuid,
      getPersistedArmMessageUuid: () =>
        this.rateLimitWatchdog.getPersistedEpisodeMessageUuid?.() ?? undefined,
      cancelWatchdog: () => this.rateLimitWatchdog.cancel(false),
      isInMemoryCooldown: () => this.stateManager.getState().status === 'rate_limit_cooldown',
      clearCooldown: () => {
        void this.stateManager.setIdle();
      },
      publishStatusesFailed: (messageIds) => {
        void this.internalEventBus
          .publish('messages.statusChanged', {
            sessionId: this.session.id,
            messageIds,
            status: 'failed',
          })
          .catch(() => {});
      },
      onPersistedCooldownReadError: () => {
        this.logger.warn('Failed to inspect the persisted rate-limit cooldown on cancel.');
      },
      onDeliveryCancelError: (error) => {
        this.logger.warn('Failed to cancel the parked delivery for the retry episode:', error);
      },
    });
  }

  async retryNowAfterRateLimit(): Promise<boolean> {
    const persistedEpisodeMessageUuid = this.rateLimitWatchdog.getPersistedEpisodeMessageUuid();
    if (this.rateLimitWatchdog.isPersistedCooldownArmed()) {
      this.rateLimitWatchdog.cancel();
      return await runRateLimitManualRetry({
        db: this.db,
        sessionId: this.session.id,
        episodeMessageUuid: persistedEpisodeMessageUuid ?? undefined,
        clearCooldown: () => this.stateManager.setIdle(),
      });
    }
    const fired = this.rateLimitWatchdog.retryNow();
    if (!fired) {
      this.logger.warn('retryNowAfterRateLimit: no cooldown retry is pending.');
    }
    return fired;
  }

  isRateLimitBannerCancelled(): boolean {
    return this.rateLimitWatchdog.isRateLimitBannerCancelled();
  }

  getRateLimitWatchdogState() {
    return this.rateLimitWatchdog.getState();
  }

  async handleQuestionResponse(
    toolUseId: string,
    responses: QuestionDraftResponse[]
  ): Promise<void> {
    await this.askUserQuestionHandler.handleQuestionResponse(toolUseId, responses);
  }

  async updateQuestionDraft(draftResponses: QuestionDraftResponse[]): Promise<void> {
    await this.askUserQuestionHandler.updateQuestionDraft(draftResponses);
  }

  async handleQuestionCancel(toolUseId: string): Promise<void> {
    await this.askUserQuestionHandler.handleQuestionCancel(toolUseId);
  }

  async markPendingQuestionOrphaned(
    telemetryReason: 'agent_session_terminated' | 'rehydrate_failed' = 'agent_session_terminated'
  ): Promise<boolean> {
    return this.askUserQuestionHandler.markQuestionOrphaned(telemetryReason);
  }

  async handleModelSwitch(
    newModel: string,
    newProvider: string
  ): Promise<{ success: boolean; model: string; error?: string }> {
    return this.modelSwitchHandler.switchModel(newModel, newProvider);
  }

  getCurrentModel(): CurrentModelInfo {
    return this.modelSwitchHandler.getCurrentModel();
  }

  async setMaxThinkingTokens(tokens: number | null): Promise<{ success: boolean; error?: string }> {
    return this.sdkRuntimeConfig.setMaxThinkingTokens(tokens);
  }

  async setPermissionMode(mode: string): Promise<{ success: boolean; error?: string }> {
    return this.sdkRuntimeConfig.setPermissionMode(mode);
  }

  async getMcpServerStatus(): Promise<Array<{ name: string; status: string; error?: string }>> {
    return this.sdkRuntimeConfig.getMcpServerStatus();
  }

  async updateToolsConfig(
    tools: Session['config']['tools']
  ): Promise<{ success: boolean; error?: string }> {
    return this.sdkRuntimeConfig.updateToolsConfig(tools);
  }

  async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
    await this.sessionConfigHandler.updateConfig(configUpdates);
  }

  replaceAllRuntimeMcpServers(mcpServers: Record<string, McpServerConfig>): void {
    this.session.config = {
      ...this.session.config,
      mcpServers,
    };
    this.emitMcpAttachLog('replace', Object.keys(mcpServers));
    this.syncRuntimeMcpServersToActiveQuery('replace', Object.keys(mcpServers));
  }

  setRuntimeMcpServers(mcpServers: Record<string, McpServerConfig>): void {
    this.replaceAllRuntimeMcpServers(mcpServers);
  }

  mergeRuntimeMcpServers(additional: Record<string, McpServerConfig>): void {
    const existing = this.session.config?.mcpServers ?? {};
    this.session.config = {
      ...this.session.config,
      mcpServers: {
        ...existing,
        ...additional,
      },
    };
    this.emitMcpAttachLog('merge', Object.keys(additional));
    this.syncRuntimeMcpServersToActiveQuery('merge', Object.keys(additional));
  }

  detachRuntimeMcpServer(name: string): void {
    const existing = this.session.config?.mcpServers;
    if (!existing || !(name in existing)) return;
    const updated = { ...existing };
    delete updated[name];
    this.session.config = {
      ...this.session.config,
      mcpServers: updated,
    };
    this.emitMcpAttachLog('detach', [name]);
    this.syncRuntimeMcpServersToActiveQuery('detach', [name]);
  }

  reconcileEffectiveMcpServers(): void {
    if (this.session.config.provider === 'acp') {
      this.logger.info(
        `mcp.reconcile skipped: provider 'acp' does not support live MCP updates; ` +
          `changes apply on next query recreation (session ${this.session.id})`
      );
      return;
    }
    this.syncRuntimeMcpServersToActiveQuery('reconcile', []);
  }

  private syncRuntimeMcpServersToActiveQuery(
    action: 'merge' | 'detach' | 'replace' | 'reconcile',
    servers: string[]
  ): void {
    const queryObject = this.queryObject;
    if (!queryObject) return;

    const setMcpServers = queryObject.setMcpServers?.bind(queryObject);
    if (!setMcpServers) return;

    const effectiveMcpServers = this.optionsBuilder.getEffectiveMcpServers() ?? {};
    void setMcpServers(effectiveMcpServers)
      .then((result) => {
        this.logger.info(
          `mcp.attach.live ${JSON.stringify({
            event: 'mcp.attach.live',
            sessionId: this.session.id,
            action,
            servers: [...servers].sort(),
            effectiveServers: Object.keys(effectiveMcpServers).sort(),
            added: result.added,
            removed: result.removed,
            errors: result.errors,
          })}`
        );
      })
      .catch((error) => {
        this.logger.warn(
          `mcp.attach.live failed for session ${this.session.id} after ${action} [${servers
            .slice()
            .sort()
            .join(', ')}]: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  private emitMcpAttachLog(action: 'merge' | 'detach' | 'replace', servers: string[]): void {
    const ctx = this.session.context ?? {};
    const sessionId = this.session.id;
    const isSubSession = sessionId.includes(':task:') && sessionId.includes(':exec:');
    const taskId =
      ctx.taskId ?? (isSubSession ? sessionId.split(':task:')[1]?.split(':')[0] : undefined);
    const payload = {
      event: 'mcp.attach',
      sessionId,
      action,
      servers: [...servers].sort(),
      ...(ctx.spaceId ? { spaceId: ctx.spaceId } : {}),
      ...(taskId ? { taskId } : {}),
    };
    this.logger.info(`mcp.attach ${JSON.stringify(payload)}`);
  }

  async updateUserMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.sessionConfigHandler.updateUserMcpServers(servers);
  }

  setRuntimeSystemPrompt(systemPrompt: SystemPromptConfig): void {
    this.session.config = {
      ...this.session.config,
      systemPrompt,
    };
  }

  setRuntimeModel(model: string): void {
    this.session.config = {
      ...this.session.config,
      model,
    };
  }

  updateMetadata(updates: Partial<Session>): void {
    this.sessionConfigHandler.updateMetadata(updates);
  }

  getProcessingState(): AgentProcessingState {
    return this.stateManager.getState();
  }

  getContextInfo(): ContextInfo | null {
    return this.contextTracker.getContextInfo();
  }

  getQueryObject(): QueryLike | null {
    return this.queryObject;
  }

  getSdkCapabilities(): ReadonlySet<string> {
    return this.messageHandler.getSdkCapabilities();
  }

  isQueryActiveOrStarting(): boolean {
    return Boolean(this.queryObject || this.queryPromise || this.messageQueue.isRunning());
  }

  getFirstMessageReceived(): boolean {
    return this.firstMessageReceived;
  }

  getSessionData(): Session {
    return this.session;
  }

  getSDKMessages(
    limit?: number,
    before?: number,
    since?: number,
    beforeRowid?: number,
    sinceRowid?: number
  ): {
    messages: Array<
      ChatMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
    >;
    hasMore: boolean;
  } {
    return this.db.getSDKMessages(this.session.id, limit, before, since, beforeRowid, sinceRowid);
  }

  getBackgroundTaskMessages(): Array<ChatMessage & { timestamp: number }> {
    return this.db.getBackgroundTaskMessages(this.session.id);
  }

  getSDKMessageCount(): number {
    return this.db.getSDKMessageCount(this.session.id);
  }

  getSDKSessionId(): string | null {
    if (!this.queryObject || !('sessionId' in this.queryObject)) return null;
    return this.queryObject.sessionId as string;
  }

  async awaitSdkSessionCaptured(timeoutMs = 15000): Promise<string> {
    if (this.session.sdkSessionId) return this.session.sdkSessionId;

    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;

      const finish = (err: Error | null, id?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unsubscribe) unsubscribe();
        if (err) reject(err);
        else resolve(id as string);
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for sdkSessionId on session ${this.session.id}`
          )
        );
      }, timeoutMs);

      unsubscribe = this.internalEventBus.subscribe(
        'session.updated',
        (payload) => {
          if (payload.sessionId && payload.sessionId !== this.session.id) return;

          const payloadId = payload.session?.sdkSessionId;
          if (typeof payloadId === 'string' && payloadId.length > 0) {
            finish(null, payloadId);
            return;
          }
          if (this.session.sdkSessionId) {
            finish(null, this.session.sdkSessionId);
          }
        },
        { sessionId: this.session.id, subscriberName: 'AgentSession.waitForSdkSessionId' }
      );
      if (this.session.sdkSessionId) {
        finish(null, this.session.sdkSessionId);
      }
    });
  }

  async getSlashCommands(): Promise<string[]> {
    return this.slashCommandManager.getSlashCommands();
  }

  async handleQueryTrigger(options?: {
    deliverIndividually?: boolean;
    excludeMessageUuid?: string;
    skipContextReset?: boolean;
    skipResetCoordination?: boolean;
    pendingTaskInput?: boolean;
  }): Promise<{ success: boolean; messageCount: number; error?: string }> {
    return this.queryModeHandler.handleQueryTrigger(options);
  }

  async restartQuery(): Promise<void> {
    await this.lifecycleManager.restartQuery();
  }

  async restart(options?: { beforeStart?: () => void | Promise<void> }): Promise<void> {
    this.rateLimitWatchdog.cancel();
    await this.lifecycleManager.restart(options);
  }

  getRewindPoints(): RewindPoint[] {
    return this.rewindHandler.getRewindPoints();
  }

  previewRewind(checkpointId: string): Promise<RewindPreview> {
    return this.rewindHandler.previewRewind(checkpointId);
  }

  executeRewind(checkpointId: string, mode: RewindMode): Promise<RewindResult> {
    return this.rewindHandler.executeRewind(checkpointId, mode);
  }

  previewSelectiveRewind(messageIds: string[]): Promise<SelectiveRewindPreview> {
    return this.rewindHandler.previewSelectiveRewind(messageIds);
  }

  executeSelectiveRewind(messageIds: string[], mode?: RewindMode): Promise<SelectiveRewindResult> {
    return this.rewindHandler.executeSelectiveRewind(messageIds, mode);
  }

  setPendingResumeSessionAt(messageUuid: string): void {
    this.pendingResumeSessionAt = messageUuid;
  }

  peekPendingResumeSessionAt(): string | undefined {
    return this.pendingResumeSessionAt;
  }

  clearPendingResumeSessionAt(): void {
    this.pendingResumeSessionAt = undefined;
  }

  consumePendingResumeSessionAt(): string | undefined {
    const value = this.pendingResumeSessionAt;
    this.pendingResumeSessionAt = undefined;
    return value;
  }

  resumePendingWorkAfterCompaction(): void {
    if (!this.pendingResumeAfterCompaction) return;
    this.pendingResumeAfterCompaction = false;
    if (this.messageQueue.hasOutstandingNonCompactionMessages()) return;
    void this.messageQueue
      .enqueue(
        'Context was compacted to stay within the configured window. Continue the task you were working on.',
        false,
        { durable: true }
      )
      .catch((error) => {
        this.logger.warn(`post-compaction resume enqueue failed for ${this.session.id}:`, error);
      });
  }

  clearPendingResumeAfterCompaction(): void {
    if (!this.pendingResumeAfterCompaction) return;
    this.pendingResumeAfterCompaction = false;
    this.logger.info(
      `dropping pending post-compaction resume for session ${this.session.id} ` +
        `(no daemon compaction was enqueued)`
    );
  }

  async reevaluateContextBudgetAfterModelSwitch(opts?: {
    queueClearEpochAtStart?: number;
    userInterruptEpochAtStart?: number;
  }): Promise<void> {
    this.messageQueue.holdInternalCompactionDelivery();
    const queueClearEpochAtStart =
      opts?.queueClearEpochAtStart ?? this.messageQueue.getClearEpoch();
    const userInterruptEpochAtStart =
      opts?.userInterruptEpochAtStart ?? this.messageQueue.getUserInterruptEpoch();
    const decision = this.contextBudgetReevaluationQueue.then(async () => {
      const trackerInfo = this.contextTracker.getContextInfo();
      if (!trackerInfo || trackerInfo.totalUsed <= 0) return null;
      const run = runContextBudgetReevaluation({
        session: this.session,
        trackerInfo,
        resolveModelInfo: () =>
          this.resolveSessionModelInfoWithRetry(queueClearEpochAtStart, userInterruptEpochAtStart),
        limitRecoveryPending: this.isLimitRecoveryPending(),
        contextTracker: this.contextTracker,
        messageQueue: this.messageQueue,
        stateManager: this.stateManager,
        logger: this.logger,
        resumePendingWork: () => this.resumePendingWorkAfterCompaction(),
        clearPendingResume: () => this.clearPendingResumeAfterCompaction(),
        queueClearEpochAtStart,
        userInterruptEpochAtStart,
      });
      this.messageQueue.setDeliveryGate(
        boundedDeliveryGate(
          run.then(() => undefined).catch(() => {}),
          Date.now() + 5000
        )
      );
      return run;
    });
    this.contextBudgetReevaluationQueue = decision.then(
      () => undefined,
      () => undefined
    );
    const reevaluation = decision
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn('post-switch context budget evaluation failed:', error);
      })
      .finally(() => {
        this.messageQueue.releaseInternalCompactionDelivery();
      });
    this.messageQueue.setDeliveryGate(boundedDeliveryGate(reevaluation, Date.now() + 5000));
    await reevaluation;
  }

  private async resolveSessionModelInfoWithRetry(
    originQueueClearEpoch: number,
    originUserInterruptEpoch: number
  ): Promise<ModelInfo | null> {
    const deadlineAt = Date.now() + 4_000;
    const attemptPromise = (async (): Promise<ModelInfo | null> => {
      for (;;) {
        const modelInfo = await this.resolveSessionCatalogModelInfo();
        if (modelInfo) return modelInfo;
        if (Date.now() >= deadlineAt) return null;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          if (typeof timer.unref === 'function') {
            timer.unref();
          }
        });
      }
    })();
    const bounded = await Promise.race([
      attemptPromise,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 4_000);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }),
    ]);
    if (bounded === null) {
      void attemptPromise
        .then((lateModelInfo) => {
          if (lateModelInfo) {
            void this.reevaluateContextBudgetAfterModelSwitch({
              queueClearEpochAtStart: originQueueClearEpoch,
              userInterruptEpochAtStart: originUserInterruptEpoch,
            });
          }
        })
        .catch(() => {});
    }
    return bounded;
  }

  private async resolveSessionCatalogModelInfo(): Promise<ModelInfo | null> {
    const providerId = this.session.config.provider;
    const providerConfig = this.session.config.providerConfig;
    if (
      providerId &&
      (providerConfig?.apiKey || providerConfig?.baseUrl || providerConfig?.region)
    ) {
      await ensureScopedProviderCatalogModels(this.session.id, providerId, providerConfig);
      return getSessionModelInfo(this.session, this.session.id);
    }
    const cached = await getSessionModelInfo(this.session);
    if (cached) return cached;
    await initializeModels().catch(() => {});
    return getSessionModelInfo(this.session);
  }

  async midTurnContextBudgetCheck(): Promise<void> {
    if (this.midTurnBudgetCheckInFlight) return;
    this.midTurnBudgetCheckInFlight = true;
    try {
      await this.runMidTurnContextBudgetCheck();
    } finally {
      this.midTurnBudgetCheckInFlight = false;
    }
  }

  private async runMidTurnContextBudgetCheck(): Promise<void> {
    const queryObject = this.queryObject;
    if (!queryObject?.interrupt) return;
    const providerId = this.session.config.provider;
    if (!providerId) return;
    const cancelAsyncMessage = queryObject.cancelAsyncMessage;
    const opts: MidTurnBudgetInterruptOptions = {
      sessionId: this.session.id,
      providerId,
      budgetKey: 0,
      logger: this.logger,
      interrupt: () => queryObject.interrupt(),
      cancelAsyncMessage:
        typeof cancelAsyncMessage === 'function' ? cancelAsyncMessage.bind(queryObject) : undefined,
      restart: (options) => this.lifecycleManager.restart(options),
      contextTracker: this.contextTracker,
      onResumeArm: () => {
        this.pendingResumeAfterCompaction = true;
      },
      onResumeClear: () => {
        this.pendingResumeAfterCompaction = false;
      },
      onSurvivorRequeued: (uuid) => {
        try {
          const reopenedId = this.db
            .getSDKMessageRepo()
            .markDeliveryRetryableByUuid(this.session.id, uuid);
          if (reopenedId) {
            void this.internalEventBus
              .publish('messages.statusChanged', {
                sessionId: this.session.id,
                messageIds: [reopenedId],
                status: 'enqueued',
              })
              .catch(() => {});
          }
          deliverMessage(this.db.getJobQueueRepo()!, this.session.id, uuid, { origin: 'recovery' });
        } catch (error) {
          this.logger.warn(
            `mid-turn survivor requeue for ${uuid} in session ${this.session.id} failed:`,
            error
          );
        }
      },
      getDurableMessageContent: (uuid) => {
        const repo = this.db.getSDKMessageRepo();
        const kickoff = repo.getUserMessageContentByUuid(this.session.id, uuid);
        if (kickoff === null || kickoff === undefined) return undefined;
        return kickoff;
      },
      ownsTurn: () => this.queryObject === queryObject,
    };
    try {
      await runMidTurnBudgetPipeline({
        opts,
        queue: this.messageQueue,
        checkEligibility: () => {
          if (this.pendingResumeAfterCompaction) return false;
          const status = this.stateManager.getState().status;
          if (status === 'waiting_for_input' || status === 'rate_limit_cooldown') return false;
          if (this.isLimitRecoveryPending()) return false;
          if (!this.messageQueue.isRunning()) return false;
          if (providerId === 'acp') return false;
          if (NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(providerId)) return false;
          return true;
        },
        refreshUsage: () => this.refreshMidTurnContextInfo(queryObject),
        decideCompaction: (info) => {
          if (info.totalUsed <= 0) return false;
          if (this.stateManager.getState().status !== 'processing') return false;
          const configuredWindow = info.totalCapacity > 0 ? info.totalCapacity : undefined;
          const budgetKey = contextBudgetThreshold(configuredWindow ?? 0, info.autoCompactPercent);
          opts.budgetKey = budgetKey;
          const decision = decideContextBudgetCompaction({
            totalUsed: info.totalUsed,
            configuredWindow,
            autoCompactPercent: info.autoCompactPercent,
            sdkAutoCompactEnabled: info.isAutoCompactEnabled,
            sdkAutoCompactThreshold: info.sdkAutoCompactThreshold,
            cooldownActive:
              this.contextTracker.isCoolingDown(budgetKey) &&
              !this.messageQueue.hasOutstandingInternalCompaction(),
            compactingActive: this.stateManager.getIsCompacting(),
          });
          return decision.action === 'compact';
        },
      });
    } finally {
      this.messageQueue.releaseEarlyDeliveryGate(opts);
    }
  }

  private async refreshMidTurnContextInfo(queryObject: QueryLike): Promise<ContextInfo | null> {
    const fenceModel = this.session.config.model;
    const fenceProvider = this.session.config.provider;
    const stale = this.contextTracker.getContextInfo();
    const refreshKey = `${fenceModel}|${fenceProvider}`;
    if (
      stale &&
      refreshKey === this.lastMidTurnUsageRefreshKey &&
      Date.now() - this.lastMidTurnUsageRefreshAt < MID_TURN_USAGE_REFRESH_INTERVAL_MS
    ) {
      return stale;
    }
    try {
      const modelInfo = await getSessionModelInfo(this.session);
      if (
        this.session.config.model !== fenceModel ||
        this.session.config.provider !== fenceProvider
      ) {
        return null;
      }
      const info = await this.messageHandler
        .getContextFetcher()
        .fetch(queryObject, modelInfo ?? undefined);
      if (
        this.queryObject !== queryObject ||
        this.session.config.model !== fenceModel ||
        this.session.config.provider !== fenceProvider
      ) {
        return null;
      }
      if (!info) return stale;
      this.lastMidTurnUsageRefreshAt = Date.now();
      this.lastMidTurnUsageRefreshKey = refreshKey;
      this.contextTracker.updateWithDetailedBreakdown(info);
      return info;
    } catch (error) {
      this.logger.warn(
        `mid-turn context usage refresh failed for session ${this.session.id}:`,
        error
      );
      if (
        this.queryObject !== queryObject ||
        this.session.config.model !== fenceModel ||
        this.session.config.provider !== fenceProvider
      ) {
        return null;
      }
      return stale;
    }
  }

  incrementQueryGeneration(): number {
    const next = ++this._queryGeneration;
    this.stateManager.noteQueryOwnerGeneration(next);
    this.taskNotificationRequeryAwaitingSdkIdle = false;
    this.taskNotificationRequeryBusyInterruptGeneration = null;
    return next;
  }

  getQueryGeneration(): number {
    return this._queryGeneration;
  }

  isCleaningUp(): boolean {
    return this._isCleaningUp;
  }

  async onSDKMessage(
    message: import('@hyperneo/shared/sdk').SDKMessage,
    _queuedMessages?: Array<import('@hyperneo/shared/sdk').SDKMessage>,
    runnerGeneration?: number
  ): Promise<void> {
    const queryGeneration = runnerGeneration ?? this.getQueryGeneration();
    if (
      this.session.config.provider !== 'acp' &&
      queryGeneration === this.getQueryGeneration() &&
      isSDKSessionStateChangedMessage(message) &&
      message.state !== 'idle'
    ) {
      this.taskNotificationRequeryAwaitingSdkIdle = true;
    }
    const observingResult = message.type === 'result';
    if (observingResult) {
      this.taskNotificationRequeryObservingResultDepth += 1;
    }
    try {
      try {
        await this.messageHandler.handleMessage(message, queryGeneration);
      } catch (error) {
        if (this.getQueryGeneration() === queryGeneration) {
          this.observeTaskNotificationResult(message);
        }
        throw error;
      }
      if (this.getQueryGeneration() !== queryGeneration) return;
      this.observeTaskNotificationResult(message);
    } finally {
      if (observingResult) {
        this.taskNotificationRequeryObservingResultDepth -= 1;
        if (this.taskNotificationRequeryObservingResultDepth === 0) {
          this.flushPendingTaskNotificationRequery();
        }
      }
    }
  }

  private observeTaskNotificationResult(message: import('@hyperneo/shared/sdk').SDKMessage): void {
    if (this.session.config.provider === 'acp') return;
    if (isSDKSessionStateChangedMessage(message)) {
      if (message.state === 'idle') {
        this.taskNotificationRequeryAwaitingSdkIdle = false;
        this.taskNotificationRequeryBusyInterruptGeneration = null;
        this.flushPendingTaskNotificationRequery();
      } else {
        this.taskNotificationRequeryAwaitingSdkIdle = true;
      }
      return;
    }
    if (message.type !== 'result') return;
    const parentToolUseId = (
      message as import('@hyperneo/shared/sdk').SDKMessage & {
        parent_tool_use_id?: string | null;
      }
    ).parent_tool_use_id;
    if (parentToolUseId !== null && parentToolUseId !== undefined) return;
    this.taskNotificationRequeryContinueMessageId = null;
    const decision = resolveTaskNotificationRequery({
      message,
      attempts: this.taskNotificationRequeryAttempts,
      exhausted: this.taskNotificationRequeryExhausted,
      followUpQueued: this.hasQueuedFollowUpDelivery(),
    });
    if (decision.action === 'reset') {
      this.resetTaskNotificationRequery();
      return;
    }
    if (decision.action === 'hold') {
      if (!this.taskNotificationRequeryExhausted && this.hasQueuedFollowUpDelivery()) {
        this.taskNotificationRequeryEpisodeToken += 1;
        this.clearTaskNotificationRequeryTimer();
        this.taskNotificationRequeryPending = true;
        this.taskNotificationRequeryPendingDelayMs = taskNotificationRequeryDelayMs(
          this.taskNotificationRequeryAttempts
        );
        this.attachTaskNotificationRequerySettlementWatcher();
      }
      return;
    }
    if (decision.action === 'escalate') {
      this.clearTaskNotificationRequeryTimer();
      this.taskNotificationRequeryPending = false;
      this.taskNotificationRequeryExhausted = true;
      void this.escalateTaskNotificationRequeryExhaustion();
      return;
    }
    if (
      this.taskNotificationRequerySuppressedGeneration === this.getQueryGeneration() ||
      this.taskNotificationRequeryBusyInterruptGeneration === this.getQueryGeneration()
    ) {
      return;
    }
    this.taskNotificationRequeryEpisodeToken += 1;
    this.taskNotificationRequeryInterruptionGeneration = this.getQueryGeneration();
    if (
      !this.taskNotificationRequeryAwaitingSdkIdle &&
      this.stateManager.getState().status === 'idle'
    ) {
      this.scheduleTaskNotificationRequery(decision.delayMs);
    } else {
      this.clearTaskNotificationRequeryTimer();
      this.taskNotificationRequeryPending = true;
      this.taskNotificationRequeryPendingDelayMs = decision.delayMs;
      this.attachTaskNotificationRequerySettlementWatcher();
    }
  }

  private hasQueuedFollowUpDelivery(): boolean {
    if (this.messageQueue.size() > 0) return true;
    const status = this.stateManager.getState().status;
    if (status === 'queued' || status === 'waiting_for_input' || status === 'interrupted') {
      return true;
    }
    const jobQueue = this.db.getJobQueueRepo?.();
    const activeUuids = jobQueue?.activeDeliveryMessageUuids(this.session.id);
    if (!activeUuids || activeUuids.size === 0) return false;
    for (const uuid of activeUuids) {
      const consumed = this.db.getMessageByStatusAndUuid?.(this.session.id, 'consumed', uuid);
      if (!consumed) return true;
    }
    return false;
  }

  private scheduleTaskNotificationRequery(delayMs: number): void {
    this.clearTaskNotificationRequeryTimer();
    const timer = setTimeout(() => {
      this.taskNotificationRequeryTimer = null;
      void this.runTaskNotificationRequeryContinue();
    }, delayMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.taskNotificationRequeryTimer = timer;
    this.attachTaskNotificationRequerySettlementWatcher();
  }

  private attachTaskNotificationRequerySettlementWatcher(): void {
    const episodeToken = this.taskNotificationRequeryEpisodeToken;
    const owningQuery = this.queryPromise;
    if (!owningQuery) return;
    const onSettled = () => this.releaseTaskNotificationRequeryProtocolOnSettlement(episodeToken);
    void owningQuery.then(onSettled, onSettled);
  }

  private releaseTaskNotificationRequeryProtocolOnSettlement(episodeToken: number): void {
    if (
      this._isCleaningUp ||
      episodeToken !== this.taskNotificationRequeryEpisodeToken ||
      (!this.taskNotificationRequeryAwaitingSdkIdle && !this.taskNotificationRequeryPending)
    ) {
      return;
    }
    this.taskNotificationRequeryAwaitingSdkIdle = false;
    this.taskNotificationRequeryBusyInterruptGeneration = null;
    this.flushPendingTaskNotificationRequery();
  }

  private clearTaskNotificationRequeryTimer(): void {
    if (!this.taskNotificationRequeryTimer) return;
    clearTimeout(this.taskNotificationRequeryTimer);
    this.taskNotificationRequeryTimer = null;
  }

  resetTaskNotificationRequery(): void {
    this.clearTaskNotificationRequeryTimer();
    const continueMessageId = this.taskNotificationRequeryContinueMessageId;
    if (continueMessageId) {
      this.messageQueue.remove(continueMessageId);
    }
    this.taskNotificationRequeryAttempts = 0;
    this.taskNotificationRequeryExhausted = false;
    this.taskNotificationRequeryPending = false;
    this.taskNotificationRequeryPendingDelayMs = null;
    this.taskNotificationRequeryInterruptionGeneration = null;
    this.taskNotificationRequeryContinueMessageId = null;
    this.taskNotificationRequeryEpisodeToken += 1;
  }

  private flushPendingTaskNotificationRequery(): void {
    if (this.taskNotificationRequeryObservingResultDepth > 0) return;
    if (!this.taskNotificationRequeryPending) return;
    this.taskNotificationRequeryPending = false;
    const delayMs = this.taskNotificationRequeryPendingDelayMs ?? 0;
    this.taskNotificationRequeryPendingDelayMs = null;
    if (
      this.taskNotificationRequeryInterruptionGeneration !== null &&
      this.taskNotificationRequeryInterruptionGeneration !== this.getQueryGeneration()
    ) {
      this.logger.warn(
        `task-notification requery: query replaced while a continuation was pending for session ` +
          `${this.session.id}; dropping the stale episode`
      );
      this.resetTaskNotificationRequery();
      return;
    }
    if (
      this._isCleaningUp ||
      this.stateManager.getState().status === 'rate_limit_cooldown' ||
      this.taskNotificationRequeryAwaitingSdkIdle
    ) {
      this.taskNotificationRequeryPending = true;
      this.taskNotificationRequeryPendingDelayMs = delayMs;
      return;
    }
    if (this.isLimitRecoveryPending()) {
      this.taskNotificationRequeryPending = true;
      this.taskNotificationRequeryPendingDelayMs = delayMs;
      this.scheduleTaskNotificationRequery(1000);
      return;
    }
    if (this.stateManager.getState().status !== 'idle') {
      this.taskNotificationRequeryPending = true;
      this.taskNotificationRequeryPendingDelayMs = delayMs;
      return;
    }
    this.scheduleTaskNotificationRequery(delayMs);
  }

  private async runTaskNotificationRequeryContinue(): Promise<void> {
    if (this._isCleaningUp) return;
    if (this.db.getSession(this.session.id)?.status === 'archived') return;
    const episodeToken = this.taskNotificationRequeryEpisodeToken;
    if (
      this.taskNotificationRequeryInterruptionGeneration !== null &&
      this.taskNotificationRequeryInterruptionGeneration !== this.getQueryGeneration()
    ) {
      this.logger.warn(
        `task-notification requery: query replaced since the hollow result ` +
          `(generation ${this.taskNotificationRequeryInterruptionGeneration} -> ` +
          `${this.getQueryGeneration()}); standing down for session ${this.session.id}`
      );
      this.resetTaskNotificationRequery();
      return;
    }
    if (
      this.taskNotificationRequerySuppressedGeneration === this.getQueryGeneration() ||
      this.taskNotificationRequeryBusyInterruptGeneration === this.getQueryGeneration()
    ) {
      return;
    }
    if (this.taskNotificationRequeryAwaitingSdkIdle) {
      this.taskNotificationRequeryPending = true;
      this.taskNotificationRequeryPendingDelayMs = 0;
      return;
    }
    if (this.hasQueuedFollowUpDelivery()) {
      this.taskNotificationRequeryPending = true;
      this.taskNotificationRequeryPendingDelayMs = 0;
      return;
    }
    if (this.stateManager.getState().status !== 'idle') {
      this.taskNotificationRequeryPending = true;
      return;
    }
    if (this.isLimitRecoveryPending()) {
      this.taskNotificationRequeryPending = true;
      this.taskNotificationRequeryPendingDelayMs = 0;
      this.scheduleTaskNotificationRequery(1000);
      return;
    }
    if (this.taskNotificationRequeryAttempts >= TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS) {
      this.clearTaskNotificationRequeryTimer();
      this.taskNotificationRequeryExhausted = true;
      void this.escalateTaskNotificationRequeryExhaustion();
      return;
    }
    if (!this.messageQueue.isRunning() || !this.queryPromise) {
      if (!this.messageQueue.isRunning() && this.queryPromise) {
        this.scheduleTaskNotificationRequery(200);
        return;
      }
      if (this.session.config.queryMode === 'manual') {
        this.logger.warn(
          `task-notification requery: query is not live for manual-mode session ` +
            `${this.session.id}; standing down in favor of the runtime idle-watch backstop`
        );
        return;
      }
      try {
        const started = await this.lifecycleManager.ensureQueryStarted();
        if (started === 'blocked') {
          this.taskNotificationRequeryPending = true;
          this.taskNotificationRequeryPendingDelayMs = 0;
          return;
        }
        if (
          this._isCleaningUp ||
          episodeToken !== this.taskNotificationRequeryEpisodeToken ||
          this.taskNotificationRequerySuppressedGeneration === this.getQueryGeneration()
        ) {
          return;
        }
        if (this.hasQueuedFollowUpDelivery()) {
          this.taskNotificationRequeryPending = true;
          this.taskNotificationRequeryPendingDelayMs = 0;
          return;
        }
        if (this.taskNotificationRequeryAwaitingSdkIdle) {
          this.taskNotificationRequeryPending = true;
          this.taskNotificationRequeryPendingDelayMs = 0;
          return;
        }
        if (this.isLimitRecoveryPending()) {
          this.taskNotificationRequeryPending = true;
          this.taskNotificationRequeryPendingDelayMs = 0;
          this.scheduleTaskNotificationRequery(1000);
          return;
        }
        if (this.stateManager.getState().status !== 'idle') {
          this.taskNotificationRequeryPending = true;
          return;
        }
        this.taskNotificationRequeryInterruptionGeneration = this.getQueryGeneration();
      } catch (error) {
        if (episodeToken !== this.taskNotificationRequeryEpisodeToken) return;
        this.logger.warn(
          `task-notification requery: could not restart the dead query for session ` +
            `${this.session.id}: ${error instanceof Error ? error.message : String(error)}`
        );
        this.taskNotificationRequeryAttempts += 1;
        this.handleTaskNotificationRequeryFailure();
        return;
      }
    }
    this.taskNotificationRequeryAttempts += 1;
    this.taskNotificationRequeryPending = false;
    this.taskNotificationRequeryPendingDelayMs = null;
    const attempt = this.taskNotificationRequeryAttempts;
    this.logger.warn(
      `task-notification requery: turn ended on a hollow task-notification result; ` +
        `issuing bare-continue follow-up turn ${attempt}/${TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS} ` +
        `for session ${this.session.id}`
    );
    const continueMessageId = generateUUID();
    this.taskNotificationRequeryContinueMessageId = continueMessageId;
    try {
      await this.messageQueue.enqueueWithId(
        continueMessageId,
        TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE,
        true
      );
      const settledQuery = this.queryPromise;
      if (settledQuery) {
        const onSettled = () => this.recoverTaskNotificationRequeryAfterSettlement(episodeToken);
        void settledQuery.then(onSettled, onSettled);
      }
    } catch (error) {
      if (episodeToken !== this.taskNotificationRequeryEpisodeToken) return;
      this.logger.warn(
        `task-notification requery: bare-continue delivery failed for session ${this.session.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      if (this.taskNotificationRequeryContinueMessageId === continueMessageId) {
        this.taskNotificationRequeryContinueMessageId = null;
      }
      this.handleTaskNotificationRequeryFailure();
    }
  }

  private recoverTaskNotificationRequeryAfterSettlement(episodeToken: number): void {
    if (
      this._isCleaningUp ||
      this.taskNotificationRequeryExhausted ||
      episodeToken !== this.taskNotificationRequeryEpisodeToken ||
      this.taskNotificationRequerySuppressedGeneration === this.getQueryGeneration() ||
      this.taskNotificationRequeryBusyInterruptGeneration === this.getQueryGeneration()
    ) {
      return;
    }
    this.taskNotificationRequeryAwaitingSdkIdle = false;
    this.taskNotificationRequeryBusyInterruptGeneration = null;
    this.taskNotificationRequeryPending = true;
    this.taskNotificationRequeryPendingDelayMs = taskNotificationRequeryDelayMs(
      this.taskNotificationRequeryAttempts
    );
    this.flushPendingTaskNotificationRequery();
  }

  private handleTaskNotificationRequeryFailure(): void {
    if (this.taskNotificationRequerySuppressedGeneration === this.getQueryGeneration()) return;
    if (this.taskNotificationRequeryAttempts >= TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS) {
      this.taskNotificationRequeryExhausted = true;
      void this.escalateTaskNotificationRequeryExhaustion();
      return;
    }
    this.scheduleTaskNotificationRequery(
      taskNotificationRequeryDelayMs(this.taskNotificationRequeryAttempts)
    );
  }

  private async escalateTaskNotificationRequeryExhaustion(): Promise<void> {
    const attempts = this.taskNotificationRequeryAttempts;
    const episodeToken = this.taskNotificationRequeryEpisodeToken;
    const execution = this.db.getNodeExecutionRepo?.().getByAgentSessionId(this.session.id) ?? null;
    const event = buildTaskNotificationRequeryEscalationEvent({
      sessionId: this.session.id,
      spaceId: this.session.context?.spaceId,
      taskId: this.session.context?.taskId,
      workflowRunId: execution?.workflowRunId,
      attempts,
      timestamp: new Date().toISOString(),
    });
    if (!event) {
      this.logger.warn(
        `task-notification requery budget exhausted after ${attempts} attempt(s) for session ` +
          `${this.session.id}; needs attention: no space context resolved, surfacing a ` +
          'recoverable session error'
      );
      await this.surfaceTaskNotificationRequeryExhaustionError(attempts, episodeToken);
      return;
    }
    this.logger.warn(
      `task-notification requery budget exhausted after ${attempts} attempt(s); needs attention: ` +
        `session=${this.session.id} run=${event.runId} task=${event.taskId}`
    );
    let payload: (typeof event & import('../internal-event-bus.ts').InternalEventPayload) | null =
      null;
    try {
      payload = {
        ...event,
        handledBySpaceService: false,
      } as typeof event & import('../internal-event-bus.ts').InternalEventPayload;
      await this.internalEventBus.publish('space.workflowRun.needsAttention', payload);
      if (episodeToken !== this.taskNotificationRequeryEpisodeToken) return;
      if (!payload.handledBySpaceService) {
        this.logger.warn(
          `task-notification requery: needs-attention escalation had no handler for space ` +
            `${event.spaceId}; surfacing a recoverable session error instead`
        );
        await this.surfaceTaskNotificationRequeryExhaustionError(attempts, episodeToken);
      }
    } catch (error) {
      if (episodeToken !== this.taskNotificationRequeryEpisodeToken) return;
      if (payload?.handledBySpaceService) {
        this.logger.warn(
          `task-notification requery: needs-attention escalation was delivered to space ` +
            `${event.spaceId} despite a partial publish failure: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
      this.logger.warn(
        `task-notification requery: failed to publish needs-attention escalation: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      await this.surfaceTaskNotificationRequeryExhaustionError(attempts, episodeToken);
    }
  }

  private async surfaceTaskNotificationRequeryExhaustionError(
    attempts: number,
    episodeToken: number
  ): Promise<void> {
    if (episodeToken !== this.taskNotificationRequeryEpisodeToken) return;
    try {
      await this.errorManager.handleError(
        this.session.id,
        new Error(`task-notification re-query budget exhausted after ${attempts} attempt(s)`),
        ErrorCategory.SYSTEM,
        'A background-task notification could not be delivered to the model after repeated ' +
          'automatic retries. Send a message to continue the session and consume it.',
        this.stateManager.getState(),
        { taskNotificationRequeryAttempts: attempts },
        () => episodeToken === this.taskNotificationRequeryEpisodeToken
      );
    } catch (error) {
      this.logger.warn(
        `task-notification requery: failed to surface exhaustion error: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async onSlashCommandsFetched(): Promise<void> {
    await this.slashCommandManager.fetchAndCache();
  }

  async onInitSlashCommands(commands: string[]): Promise<void> {
    await this.slashCommandManager.updateFromInit(commands);
  }

  async onCommandsChanged(commands: string[]): Promise<void> {
    await this.slashCommandManager.updateFromCommandsChanged(commands);
  }

  async onModelsFetched(queryGeneration?: number, attemptToken?: QueryAttemptToken): Promise<void> {
    if (this.isCleaningUp()) {
      this.logger.info(
        `Skipping model discovery during session cleanup in session ${this.session.id}`
      );
      return;
    }
    if (queryGeneration !== undefined && this.getQueryGeneration() !== queryGeneration) {
      this.logger.info(
        `Skipping model discovery for superseded query generation ` +
          `${queryGeneration} (current ${this.getQueryGeneration()}) in session ${this.session.id}`
      );
      return;
    }
    if (!this.queryObject) return;
    try {
      const { getSupportedModelsFromQuery } = await import('../model-service.ts');
      await getSupportedModelsFromQuery(
        this.queryObject,
        this.session.id,
        queryGeneration === undefined && attemptToken === undefined
          ? undefined
          : {
              isLive: () =>
                !this.isCleaningUp() &&
                (queryGeneration === undefined || this.getQueryGeneration() === queryGeneration) &&
                (attemptToken === undefined || attemptToken.isLive()),
            }
      );
    } catch (error) {
      this.logger.warn('Failed to fetch models from SDK:', error);
    }
  }

  async onMarkApiSuccess(
    message: import('@hyperneo/shared/sdk').SDKMessage,
    queryGeneration?: number
  ): Promise<void> {
    if (queryGeneration !== undefined && this.getQueryGeneration() !== queryGeneration) {
      this.logger.info(
        `Skipping API success bookkeeping for superseded query generation ` +
          `${queryGeneration} (current ${this.getQueryGeneration()}) in session ${this.session.id}`
      );
      return;
    }
    this.errorManager.markApiSuccess();
    if (isSDKResultSuccess(message) && message.is_error !== true) {
      const wasPending = this.rateLimitWatchdog.isPending();
      this.rateLimitWatchdog.reset();
      if (wasPending && this.stateManager.getState().status === 'rate_limit_cooldown') {
        await this.stateManager.setIdle();
      }
    }
  }

  async onRateLimitExhausted(
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    hint?: LimitRetryHint,
    queryGeneration?: number
  ): Promise<boolean> {
    return this.rateLimitWatchdog.scheduleRetry(
      errorMessage,
      lastUserMessage,
      hint,
      queryGeneration
    );
  }

  async onResultLimitError(
    errorText: string,
    hint: LimitRetryHint,
    userMessageUuid?: string,
    queryGeneration?: number
  ): Promise<boolean> {
    return this.onRateLimitExhausted(
      errorText,
      this.queryRunner.resolveRetryUserMessage(userMessageUuid),
      hint,
      queryGeneration
    );
  }

  isLimitRecoveryPending(): boolean {
    return this.rateLimitWatchdog.isRecoveryPending();
  }

  setCleaningUp(value: boolean): void {
    this._isCleaningUp = value;
  }

  isRateLimitEpisodeSuperseded(generation: number): boolean {
    return this.rateLimitWatchdog.isSuperseded(generation);
  }

  async driveDeliveryTurn(
    messageUuid: string,
    content: string | MessageContent[],
    _parentToolUseId?: string | null,
    _alreadyConsumed = false,
    claimGuard?: () => boolean,
    signal?: AbortSignal,
    observer?: MessageDeliveryAttemptObserver
  ): Promise<DriveTurnOutcome> {
    return this.admitDelivery({
      messageUuid,
      content,
      claimGuard,
      signal,
      observer,
    });
  }

  private async admitDelivery(args: {
    messageUuid: string;
    content: string | MessageContent[];
    parentToolUseId?: string | null;
    claimGuard?: () => boolean;
    signal?: AbortSignal;
    observer?: MessageDeliveryAttemptObserver;
  }): Promise<DeliveryOutcome> {
    type DeliveryAdmissionResult =
      | DeliveryOutcome
      | { outcome: 'driving'; acknowledgment: Promise<void>; consumedUuids: string[] };

    const { messageUuid, content, claimGuard, signal, observer } = args;

    const boundary = await admitAcrossContextClearBoundary(this.session.id, signal, () =>
      withSessionLock(
        this.session.id,
        async (): Promise<DeliveryAdmissionResult> => {
          throwIfDeliveryAborted(signal);
          if (this.db.getSession(this.session.id)?.status === 'archived') {
            throw new MessageDeliveryTerminalTurnError('Session is archived');
          }
          if (this.isCleaningUp()) return { outcome: 'aborted' };
          if (claimGuard && !claimGuard()) return { outcome: 'aborted' };

          if (this.isWaitingForInput()) {
            return {
              outcome: 'blocked',
              retryAt: Date.now() + MESSAGE_DELIVERY_PARK_MS,
              reason: 'sdk_resume_choice',
            };
          }

          if (this.rateLimitWatchdog.isRecoveryPending()) {
            const retryAt = this.rateLimitWatchdog.isManualRecoveryPause()
              ? Date.now() + MANUAL_RECOVERY_PARK_MS
              : Math.max(
                  Date.now() + MESSAGE_DELIVERY_PARK_MS,
                  this.rateLimitWatchdog.getState().retryAt ?? 0
                );
            return { outcome: 'blocked', retryAt, reason: 'limit_recovery' };
          }

          if (!this.messageQueue.isRunning()) {
            const startResult = await this.lifecycleManager.ensureQueryStarted(signal);
            if (startResult === 'blocked') {
              return {
                outcome: 'blocked',
                retryAt: Date.now() + MESSAGE_DELIVERY_PARK_MS,
                reason: 'sdk_resume_choice',
              };
            }
            throwIfDeliveryAborted(signal);
            if (this.isCleaningUp()) return { outcome: 'aborted' };
            if (claimGuard && !claimGuard()) return { outcome: 'aborted' };
          }

          const loaded = this.db
            .getSDKMessageRepo()
            .getDeliveryContent(this.session.id, messageUuid);
          if (!loaded || (loaded.sendStatus !== 'enqueued' && loaded.sendStatus !== 'submitted')) {
            return { outcome: 'aborted' };
          }

          const existing = this.messageQueue.waitForPendingOrInFlight(messageUuid);
          if (
            existing &&
            this.messageQueue.hasYielded?.(messageUuid) &&
            !this.deliveryContentMatches(existing.content, content)
          ) {
            return { outcome: 'aborted' };
          }

          let acknowledgment: Promise<void>;
          if (existing && this.deliveryContentMatches(existing.content, content)) {
            acknowledgment = existing.acknowledgment;
          } else {
            if (existing) {
              this.messageQueue.remove(messageUuid);
              this.messageQueue.acknowledgeYielded(messageUuid, this.getQueryGeneration());
            }
            acknowledgment = this.messageQueue.admitWithId(messageUuid, content, false, {
              durable: true,
            });
          }

          observer?.reportStage('query_ready', { generation: this.getQueryGeneration() });
          return { outcome: 'driving', acknowledgment, consumedUuids: [messageUuid] };
        },
        signal
      )
    );

    if (boundary.kind === 'boundary_wait') {
      return {
        outcome: 'blocked',
        retryAt: Date.now() + MESSAGE_DELIVERY_PARK_MS,
        reason: 'context_clear_boundary',
      };
    }

    const admission = boundary.result;
    if (admission.outcome !== 'driving') {
      return admission;
    }

    const timeoutMs = deliveryConsumptionTimeoutOrDefault(
      deliveryConsumptionTimeoutMs(this.session.config.provider)
    );
    const ackWaitStartedAt = Date.now();
    let ackTimedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const aborted = waitForDeliveryAbort(signal);
    const consumption = waitForDeliveryConsumption(this.session.id, messageUuid);
    let failedPoll: ReturnType<typeof setInterval> | undefined;
    const admissionTimeout = (): Promise<never> =>
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          ackTimedOut = true;
          reject(
            new MessageDeliveryRecoverableTurnError(
              'Delivery not consumed within timeout',
              'admission_timeout'
            )
          );
        }, timeoutMs);
      });
    const failedBeforeAcceptance = (): Promise<never> =>
      new Promise<never>((_, reject) => {
        failedPoll = setInterval(() => {
          const current = this.db
            .getSDKMessageRepo()
            .getDeliveryContent(this.session.id, messageUuid);
          if (current?.sendStatus === 'failed' || current?.sendStatus === 'deferred') {
            clearInterval(failedPoll);
            failedPoll = undefined;
            reject(
              new MessageDeliveryRecoverableTurnError(
                'Delivery failed before acceptance',
                'admission_failed'
              )
            );
          }
        }, 500);
      });
    try {
      await Promise.race([admission.acknowledgment, admissionTimeout(), aborted.promise]);
      if (this.session.config.provider === 'acp') {
        clearTimeout(timeoutId);
        timeoutId = undefined;
        await Promise.race([
          consumption.promise,
          failedBeforeAcceptance(),
          admissionTimeout(),
          aborted.promise,
        ]);
      }
      deliveryMetrics.recordAckWait(Date.now() - ackWaitStartedAt, 'acknowledged');
    } catch (error) {
      if (ackTimedOut) {
        deliveryMetrics.recordAckWait(Date.now() - ackWaitStartedAt, 'ack_timeout');
        if (this.messageQueue.hasYielded?.(messageUuid)) {
          await withSessionLock(this.session.id, async () => {
            this.markDeliveryConsumed(admission.consumedUuids);
            await this.publishToolResultConsumed(this.session.id, admission.consumedUuids);
            for (const uuid of admission.consumedUuids) {
              signalDeliveryConsumed(this.session.id, uuid);
            }
          });
        } else {
          this.messageQueue.remove?.(messageUuid);
        }
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (failedPoll !== undefined) clearInterval(failedPoll);
      consumption.cancel();
      aborted.cancel();
    }

    await withSessionLock(this.session.id, async () => {
      this.markDeliveryConsumed(admission.consumedUuids);
      await this.publishToolResultConsumed(this.session.id, admission.consumedUuids);
      for (const uuid of admission.consumedUuids) {
        signalDeliveryConsumed(this.session.id, uuid);
      }
    });

    if (claimGuard && !claimGuard()) {
      return { outcome: 'aborted' };
    }

    observer?.reportStage('sdk_admitted', { generation: this.getQueryGeneration() });
    return { outcome: 'completed' };
  }

  private async publishToolResultConsumed(sessionId: string, uuids: string[]): Promise<void> {
    if (this.session.config.provider === 'acp') {
      if (uuids.length === 1) return;
      uuids = uuids.slice(1);
    }
    for (const uuid of uuids) {
      const row = this.db.getMessageByStatusAndUuid?.(sessionId, 'consumed', uuid);
      if (!row || row.type !== 'user') continue;
      const content = Array.isArray(row.message.content) ? row.message.content : [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        await this.internalEventBus
          .publish('sdk.toolUse.consumed', {
            sessionId,
            toolUseId: block.tool_use_id,
            timestamp: Date.now(),
          })
          .catch(() => {});
      }
    }
  }

  async settleSkippedDelivery(messageUuid: string): Promise<void> {
    await withSessionLock(this.session.id, () =>
      this.stateManager.clearQueuedIfOwnedBy(messageUuid).then(() => undefined)
    );
  }

  isWaitingForInput(): boolean {
    if (this.stateManager.getState().status === 'waiting_for_input') return true;
    try {
      return !!this.db
        .getSDKMessageRepo()
        ?.hasUnresolvedHyperNeoAction(this.session.id, 'sdk_resume_choice');
    } catch {
      return false;
    }
  }

  async deliverChatMessage(messageUuid: string): Promise<void> {
    await withSessionLock(this.session.id, async () => {
      if (this.db.getSession(this.session.id)?.status === 'archived') {
        const failedDbId = this.db
          .getSDKMessageRepo()
          ?.markDeliveryFailedByUuid(this.session.id, messageUuid);
        if (failedDbId) {
          void this.internalEventBus
            .publish('messages.statusChanged', {
              sessionId: this.session.id,
              messageIds: [failedDbId],
              status: 'failed',
            })
            .catch(() => {});
        }
        throw new Error(`Session ${this.session.id} is archived`);
      }
      try {
        deliverMessage(this.db.getJobQueueRepo(), this.session.id, messageUuid, {
          origin: 'chat',
        });
      } catch (err) {
        const failedDbId = this.db
          .getSDKMessageRepo()
          ?.markDeliveryFailedByUuid(this.session.id, messageUuid);
        if (failedDbId) {
          void this.internalEventBus
            .publish('messages.statusChanged', {
              sessionId: this.session.id,
              messageIds: [failedDbId],
              status: 'failed',
            })
            .catch(() => {});
        }
        throw err;
      }
      const status = this.stateManager.getState().status;
      if (status === 'rate_limit_cooldown') {
        this.rateLimitWatchdog.cancel();
      } else {
        const activeDeliveries =
          this.db.getJobQueueRepo?.().activeDeliveryMessageUuids?.(this.session.id) ??
          new Set<string>();
        activeDeliveries.delete(messageUuid);
        const midTurn = this.messageQueue.isRunning() && status === 'processing';
        if (!midTurn && activeDeliveries.size === 0) this.rateLimitWatchdog.cancel();
      }
      try {
        await this.stateManager.setQueuedIfIdle(messageUuid);
      } catch (error) {
        this.logger.warn('Queued-state publication failed after durable insertion:', error);
      }
    });
  }

  private markDeliveryConsumed(uuids: string[]): void {
    const flippedIds = this.db
      .getSDKMessageRepo()
      .markDeliveryConsumedByUuids(this.session.id, uuids);
    if (flippedIds.length > 0) {
      const now = Date.now();
      for (const dbId of flippedIds) {
        this.db.updateMessageTimestamp(dbId, now);
      }
      void this.internalEventBus
        .publish('messages.statusChanged', {
          sessionId: this.session.id,
          messageIds: flippedIds,
          status: 'consumed',
        })
        .catch(() => {});
    }
  }

  private deliveryContentMatches(
    queued: string | MessageContent[],
    expected: string | MessageContent[]
  ): boolean {
    return JSON.stringify(queued) === JSON.stringify(expected);
  }

  async reconcileStrandedDeliveries(owner?: IdleOwnerScope): Promise<number> {
    const jobQueue = this.db.getJobQueueRepo?.();
    if (!jobQueue) return 0;
    const status = this.stateManager.getState().status;
    if (decideReconcileAdmission({ processingStatus: status }).action === 'skip') {
      return 0;
    }

    const reEnqueued = await withSessionLock(this.session.id, async () => {
      if (!this.stateManager.isIdleOwnerCurrent(owner)) return 0;
      const active = jobQueue.activeDeliveryMessageUuids(this.session.id);
      const stranded = selectStrandedDeliveries(
        this.db.getUserMessageIdsByStatus(this.session.id, 'enqueued'),
        active,
        (uuid) => this.messageQueue.hasPendingOrInFlight(uuid)
      );
      for (const uuid of stranded) {
        deliverMessage(jobQueue, this.session.id, uuid, { origin: 'recovery' });
        void this.stateManager.setQueuedIfIdle(uuid).catch(() => {});
      }
      return stranded.length;
    });
    let settled = 0;
    const sdkRepo = this.db.getSDKMessageRepo();
    await withSessionLock(this.session.id, async () => {
      if (!this.stateManager.isIdleOwnerCurrent(owner)) return;
      const activeNow = jobQueue.activeDeliveryMessageUuids(this.session.id);
      const staleSubmitted = selectStaleSubmittedDeliveries(
        this.db.getUserMessageIdsByStatus(this.session.id, 'submitted'),
        activeNow
      );
      for (const uuid of staleSubmitted) {
        const dbId = sdkRepo.markDeliveryFailedByUuid(this.session.id, uuid);
        if (dbId) {
          settled++;
          void this.internalEventBus
            .publish('messages.statusChanged', {
              sessionId: this.session.id,
              messageIds: [dbId],
              status: 'failed',
            })
            .catch(() => {});
        }
      }
    });
    if (reEnqueued > 0 || settled > 0) {
      this.logger.info(
        `reconcileStrandedDeliveries: re-enqueued ${reEnqueued}, settled ${settled} stale submitted.`
      );
    }
    return reEnqueued + settled;
  }

  trackAgentProcess(proc: TrackedAgentProcess): void {
    const pid = proc.pid;
    if (typeof pid !== 'number' || pid <= 0) {
      const entry: NoPidTrackedProcess = { proc };
      const noPidExitPromise = new Promise<void>((resolve) => {
        proc.once('exit', () => {
          const handleIdx = this.noPidAgentProcesses.indexOf(entry);
          if (handleIdx >= 0) {
            if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
            this.noPidAgentProcesses.splice(handleIdx, 1);
          }
          resolve();
        });
      });
      entry.exitPromise = noPidExitPromise;
      this.noPidAgentProcesses.push(entry);
      this.updateProcessExitedPromise();
      return;
    }

    this.clearForceKillTimer(pid);
    this.recentlyExitedAgentRootPids.delete(pid);
    this.trackedAgentProcesses.set(pid, proc);

    const exitPromise = new Promise<void>((resolve) => {
      proc.once('exit', () => {
        this.clearForceKillTimer(pid);
        if (this.trackedAgentProcesses.get(pid) === proc) {
          this.trackedAgentProcesses.delete(pid);
          this.trackedAgentProcessExitPromises.delete(pid);
          this.recentlyExitedAgentRootPids.set(pid, Date.now());
        }
        resolve();
      });
    });
    this.trackedAgentProcessExitPromises.set(pid, exitPromise);
    this.updateProcessExitedPromise();
  }

  *getTrackedAgentRootPids(): Iterable<number> {
    this.expireRecentlyExitedAgentRootPids();
    yield* this.trackedAgentProcesses.keys();
    yield* this.recentlyExitedAgentRootPids.keys();
  }

  getTrackedAgentRootPidsSplit(): { live: number[]; exited: number[] } {
    this.expireRecentlyExitedAgentRootPids();
    return {
      live: [...this.trackedAgentProcesses.keys()],
      exited: [...this.recentlyExitedAgentRootPids.keys()],
    };
  }

  getExitedRootPidTimestamps(): Map<number, number> {
    this.expireRecentlyExitedAgentRootPids();
    return new Map(this.recentlyExitedAgentRootPids);
  }

  snapshotTrackedAgentProcesses(): Array<[number, TrackedAgentProcess]> {
    return [...this.trackedAgentProcesses];
  }

  terminateTrackedAgentProcesses(options?: {
    forceDelayMs?: number;
    processes?: Array<[number, TrackedAgentProcess]>;
    noPidProcesses?: NoPidTrackedProcess[];
  }): void {
    const forceDelayMs = options?.forceDelayMs ?? 2000;
    const processSnapshot = options?.processes ?? [...this.trackedAgentProcesses];

    const noPidSnapshot = options?.noPidProcesses ?? [...this.noPidAgentProcesses];
    this.signalNoPidTrackedProcesses(noPidSnapshot, 'SIGTERM');
    for (const entry of noPidSnapshot) {
      if (!this.noPidAgentProcesses.includes(entry)) continue;
      const timer = setTimeout(() => {
        entry.forceKillTimer = undefined;
        this.signalNoPidTrackedProcess(entry, 'SIGKILL');
      }, forceDelayMs);
      timer.unref?.();
      entry.forceKillTimer = timer;
    }

    if (processSnapshot.length === 0) return;

    this.signalTrackedAgentProcesses(processSnapshot, 'SIGTERM');
    for (const [pid, proc] of processSnapshot) {
      if (this.trackedAgentProcesses.get(pid) !== proc) continue;
      this.clearForceKillTimer(pid);
      this.scheduleForceKill(pid, proc, forceDelayMs);
    }
  }

  snapshotNoPidTrackedProcesses(): NoPidTrackedProcess[] {
    return [...this.noPidAgentProcesses];
  }

  private signalNoPidTrackedProcesses(
    entries: NoPidTrackedProcess[],
    signal: NodeJS.Signals
  ): void {
    for (const entry of entries) {
      if (!this.noPidAgentProcesses.includes(entry)) continue;
      this.signalNoPidTrackedProcess(entry, signal);
    }
  }

  private signalNoPidTrackedProcess(entry: NoPidTrackedProcess, signal: NodeJS.Signals): void {
    if (entry.forceKillTimer) {
      clearTimeout(entry.forceKillTimer);
      entry.forceKillTimer = undefined;
    }
    try {
      entry.proc.kill?.(signal);
    } catch {}
  }

  private scheduleForceKill(pid: number, proc: TrackedAgentProcess, forceDelayMs: number): void {
    const timer = setTimeout(() => {
      this.forceKillTimers.delete(pid);
      this.signalTrackedAgentProcesses([[pid, proc]], 'SIGKILL');
    }, forceDelayMs);
    timer.unref?.();
    this.forceKillTimers.set(pid, timer);
  }

  private clearForceKillTimer(pid: number): void {
    const timer = this.forceKillTimers.get(pid);
    if (!timer) return;
    clearTimeout(timer);
    this.forceKillTimers.delete(pid);
  }

  private signalTrackedAgentProcesses(
    processes: Array<[number, TrackedAgentProcess]>,
    signal: NodeJS.Signals
  ): void {
    for (const [pid, proc] of processes) {
      if (this.trackedAgentProcesses.get(pid) !== proc) continue;

      if (process.platform !== 'win32' && pid > 0) {
        try {
          process.kill(-pid, signal);
        } catch {}
      }

      const signaled = this.signalTrackedAgentProcess(pid, proc, signal);
      if (signal === 'SIGKILL' && signaled) {
        this.trackedAgentProcesses.delete(pid);
        this.trackedAgentProcessExitPromises.delete(pid);
        this.recentlyExitedAgentRootPids.set(pid, Date.now());
        this.updateProcessExitedPromise();
      }
    }
  }

  private signalTrackedAgentProcess(
    pid: number,
    proc: TrackedAgentProcess,
    signal: NodeJS.Signals
  ): boolean {
    try {
      if (typeof proc.kill === 'function') {
        return proc.kill(signal) !== false;
      }
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private updateProcessExitedPromise(): void {
    const noPidPromises = this.noPidAgentProcesses.flatMap((entry) =>
      entry.exitPromise ? [entry.exitPromise] : []
    );
    const exitPromises = [...this.trackedAgentProcessExitPromises.values(), ...noPidPromises];
    this.processExitedPromise =
      exitPromises.length > 0 ? Promise.all(exitPromises).then(() => {}) : null;
  }

  refreshProcessExitedPromise(): void {
    this.updateProcessExitedPromise();
  }

  resetProcessExitedPromise(): void {
    this.processExitedPromise = null;
  }

  private expireRecentlyExitedAgentRootPids(now = Date.now()): void {
    for (const [pid, exitedAt] of this.recentlyExitedAgentRootPids) {
      if (now - exitedAt > RECENTLY_EXITED_ROOT_PID_RETENTION_MS) {
        this.recentlyExitedAgentRootPids.delete(pid);
      }
    }
  }

  cleanupEventSubscriptions(): void {
    this.eventSubscriptionSetup.cleanup();
  }

  async clearModelsCache(): Promise<void> {
    const { clearModelsCache } = await import('../model-service.ts');
    clearModelsCache(this.session.id);
  }

  async clearStuckProcessingState(messageUuid: string): Promise<boolean> {
    return await withSessionLock(this.session.id, async () => {
      const state = this.stateManager.getState();
      if (state.status !== 'processing' || state.messageId !== messageUuid) return false;
      if (this.hasLiveQuery()) return false;
      this.logger.warn(
        `delivery: clearing stuck processing state (messageId=${messageUuid}) after terminal ` +
          `delivery failure — no live query owns the turn; resetting so the session accepts ` +
          `new messages`
      );
      try {
        const resetResult = await this.resetQuery({ restartQuery: false });
        if (!resetResult.success) {
          this.logger.warn(
            `delivery: stuck-state reset reported failure: ${resetResult.error ?? 'unknown'}`
          );
          return false;
        }
      } catch (resetError) {
        this.logger.warn('delivery: stuck-state reset failed:', resetError);
        return false;
      }
      return true;
    });
  }

  async cleanup(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.messageHandler.cancelSuppressedResultWait();
    this.resetTaskNotificationRequery();
    for (const unsub of this.deliveryErrorSubs) {
      try {
        unsub();
      } catch {}
    }
    this.deliveryErrorSubs.length = 0;
    this.rateLimitWatchdog.destroy();
    await this.lifecycleManager.cleanup();
  }
}
