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
import { DEFAULT_WORKER_FEATURES as WORKER_FEATURES } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { Database } from '../../storage/database';
import { ErrorManager, type StructuredError } from '../error-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Logger } from '../logger';
import { SettingsManager } from '../settings-manager';

export const RECENTLY_EXITED_ROOT_PID_RETENTION_MS = 15 * 60 * 1000;

const SESSION_RECONCILE_INTERVAL_MS = 60_000;

const CLEAR_CONFIRM_TIMEOUT_MS = 45_000;

export class ClearConversationCancelledError extends Error {
  constructor() {
    super('clearConversationContext cancelled by query teardown');
    this.name = 'ClearConversationCancelledError';
  }
}

const DELIVERY_TURN_NO_ACTIVITY_MS = (() => {
  const env = Number(process.env.HYPERNEO_DELIVERY_NO_ACTIVITY_MS);
  return Number.isFinite(env) && env >= 30_000 ? env : 3 * 60 * 1000;
})();

const MAX_ZERO_PROGRESS_DELIVERY_FAILURES = (() => {
  const env = Number(process.env.HYPERNEO_DELIVERY_ZERO_PROGRESS_MAX);
  return Number.isFinite(env) && env > 0 ? env : 3;
})();

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

import { isSDKResultSuccess } from '@hyperneo/shared/sdk/type-guards';
import { AcpQueryRunner } from '../acp/acp-query-runner';
import { resolveModelAlias } from '../model-service';
import { getProviderRegistry } from '../providers/factory.js';
import { getProviderService } from '../provider-service';
import {
  AskUserQuestionHandler,
  type AskUserQuestionHandlerContext,
} from './ask-user-question-handler';
import { ContextTracker } from './context-tracker';
import { DeliveryTurnStallWatchdog } from './delivery-turn-stall-watchdog';
import {
  EventSubscriptionSetup,
  type EventSubscriptionSetupContext,
} from './event-subscription-setup';
import { resolveFallbackChain } from './fallback-recovery';
import { InterruptHandler, type InterruptHandlerContext } from './interrupt-handler';
import type { LimitRetryHint } from './limit-error-classifier';
import { LimitErrorLlmClassifier } from './limit-error-llm-classifier';
import {
  BATCH_DELIVERY_MAX_CHARS,
  buildBatchedDeliveryContent,
  classifyReclaimTermination,
  type DriveTurnOutcome,
  deliverMessage,
  type FeedSteerOutcome,
  flattenDeliveryText,
  isMessageDeliveryV2Enabled,
  MANUAL_RECOVERY_PARK_MS,
  MESSAGE_DELIVERY_PARK_MS,
  type MessageDeliveryAttemptObserver,
  MessageDeliveryRecoverableTurnError,
  MessageDeliveryTerminalTurnError,
  signalDeliveryConsumed,
  throwIfDeliveryAborted,
  waitForDeliveryAbort,
  withSessionLock,
  withSessionResetCoordination,
} from './message-delivery';
import {
  classifyTurnCompletion,
  decideReconcileAdmission,
  selectStrandedDeliveries,
  shouldRearmSpuriousTurnEnd,
} from './message-delivery-pipeline';
import { deliveryMetrics } from './message-delivery-metrics';
import { MessageQueue } from './message-queue';
import { ModelSwitchHandler, type ModelSwitchHandlerContext } from './model-switch-handler';
import { ProcessingStateManager } from './processing-state-manager';
import {
  type EnsureQueryStartedResult,
  QueryLifecycleManager,
  type QueryLifecycleManagerContext,
} from './query-lifecycle-manager';
import type { QueryLike } from './query-like';
import { QueryModeHandler, type QueryModeHandlerContext } from './query-mode-handler';
import { QueryOptionsBuilder, type QueryOptionsBuilderContext } from './query-options-builder';
import {
  type OriginalEnvVars,
  QueryRunner,
  type QueryRunnerContext,
  type TrackedAgentProcess,
} from './query-runner';
import { RateLimitWatchdog } from './rate-limit-watchdog';
import { RewindHandler, type RewindHandlerContext, type RewindPoint } from './rewind-handler';
import {
  SDKMessageHandler,
  type SDKMessageHandlerContext,
  type SuppressedResultOutcome,
} from './sdk-message-handler';
import { SDKRuntimeConfig, type SDKRuntimeConfigContext } from './sdk-runtime-config';
import { SessionConfigHandler, type SessionConfigHandlerContext } from './session-config-handler';
import { SlashCommandManager, type SlashCommandManagerContext } from './slash-command-manager';

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

  private queryRunner: QueryRunner | AcpQueryRunner;
  readonly interruptHandler: InterruptHandler;
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

  private deliveryTurnStall: DeliveryTurnStallWatchdog | null = null;
  private deliveryTurnStalled = false;
  private zeroProgressDeliveryFailures: { messageUuid: string; count: number } | null = null;
  private deliveryResponseObserver: {
    generation: number;
    observer: MessageDeliveryAttemptObserver;
    pendingStart?: boolean;
  } | null = null;

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

  get mcpEnablementRepo(): import('../../storage/repositories/mcp-enablement-repository').McpEnablementRepository {
    return this.db.mcpEnablement;
  }

  constructor(
    readonly session: Session,
    readonly db: Database,
    readonly messageHub: MessageHub,
    readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private getApiKey: () => Promise<string | null>,
    readonly skillsManager?: import('../skills-manager').SkillsManager,
    readonly appMcpServerRepo?: import('../../storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
    public skillOverrides?: SkillEnablementOverride[],
    public toolGuards?: DeclarativeToolGuard[],
    private readonly runtimeOptions: AgentSessionRuntimeOptions = {}
  ) {
    this.errorManager = new ErrorManager(this.messageHub, this.internalEventBus);
    this.logger = new Logger(`AgentSession ${session.id}`);

    this.deliveryErrorSubs.push(
      this.internalEventBus.subscribe(
        'session.error',
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
      switchAndRetry: (lastUserMessage, entry, episodeGeneration) =>
        this.switchAndRetryForFallback(lastUserMessage, entry, episodeGeneration),
      resolveModelId: async (provider, model) => this.resolveModelIdOrDefault(provider, model),
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
      async (lastUserMessage, switchTo, episodeGeneration) => {
        if (switchTo) {
          return await this.switchAndRetryForFallback(lastUserMessage, switchTo, episodeGeneration);
        }
        return await this.executeRateLimitAutoRetry(lastUserMessage, episodeGeneration);
      }
    );

    this.eventSubscriptionSetup = new EventSubscriptionSetup(this);

    this.stateManager.setOnIdleCallback(async () => {
      await this.lifecycleManager.executeDeferredRestartIfPending();
      void this.reconcileStrandedDeliveries().catch((error) => {
        this.logger.warn('Idle reconcileStrandedDeliveries failed:', error);
      });
    });

    if (session.metadata?.lastContextInfo) {
      this.contextTracker.restoreFromMetadata(session.metadata.lastContextInfo);
    }
    this.stateManager.restoreFromDatabase();

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
    skillsManager?: import('../skills-manager').SkillsManager,
    appMcpServerRepo?: import('../../storage/repositories/app-mcp-server-repository').AppMcpServerRepository
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
    skillsManager?: import('../skills-manager').SkillsManager,
    appMcpServerRepo?: import('../../storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
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
    const wantsAcp = this.session.config.provider === 'acp';
    const hasAcpRunner = this.queryRunner instanceof AcpQueryRunner;
    if (wantsAcp !== hasAcpRunner) {
      this.queryRunner = wantsAcp ? new AcpQueryRunner(this) : new QueryRunner(this);
    }
    await this.queryRunner.start();
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

  async replayPendingMessagesForImmediateMode(): Promise<void> {
    this.reconcilerProvisioned = true;
    await this.queryModeHandler.replayPendingMessagesForAutomaticTurnEnd();
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
    options?: { prepend?: boolean }
  ): Promise<void> {
    if (episodeGeneration === undefined) {
      this.rateLimitWatchdog.cancel();
    } else {
      this.rateLimitWatchdog.clearPendingCooldown();
    }
    await this.lifecycleManager.startQueryAndEnqueue(
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
    return withSessionLock(this.session.id, async () => {
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
  }

  async handleInterrupt(opts?: {
    preserveDeliveryJobs?: boolean;
    skipDeferredReplay?: boolean;
  }): Promise<void> {
    this.rateLimitWatchdog.cancel();
    this.messageHandler.cancelSuppressedResultWait();

    await this.interruptHandler.handleInterrupt(opts);
  }

  isInterruptInProgress(): boolean {
    return this.interruptHandler.getInterruptPromise() !== null;
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

  async clearConversationContext(): Promise<void> {
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
    episodeGeneration: number
  ): Promise<boolean> {
    if (!lastUserMessage) {
      this.logger.warn('Fallback switch skipped: no last user message available.');
      await this.stateManager.setIdle();
      return false;
    }
    try {
      if (this.queryPromise) {
        try {
          await this.queryPromise;
        } catch {}
      }

      if (this.rateLimitWatchdog.isSuperseded(episodeGeneration)) {
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
      if (this.rateLimitWatchdog.isSuperseded(episodeGeneration)) {
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

      return await this.executeRateLimitAutoRetry(lastUserMessage, episodeGeneration);
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
    episodeGeneration?: number
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

      await this.startQueryAndEnqueue(
        lastUserMessage.uuid,
        lastUserMessage.content,
        episodeGeneration,
        { prepend: true }
      );
      return true;
    } catch (error) {
      this.logger.error('Rate limit auto-retry failed:', error);
      await this.stateManager.setIdle({ suppressDeliveryWaiters: true });
      return false;
    }
  }

  cancelRateLimitRetry(): void {
    const episodeMessage = this.rateLimitWatchdog.getState().lastUserMessage;
    this.rateLimitWatchdog.cancel(false);
    if (this.stateManager.getState().status === 'rate_limit_cooldown') {
      void this.stateManager.setIdle();
    }
    if (episodeMessage) {
      try {
        this.db.getJobQueueRepo()?.cancelDelivery(this.session.id, episodeMessage.uuid);
      } catch (error) {
        this.logger.warn('Failed to cancel the parked delivery for the retry episode:', error);
      }
    }
  }

  async retryNowAfterRateLimit(): Promise<boolean> {
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

  async restart(): Promise<void> {
    this.rateLimitWatchdog.cancel();
    await this.lifecycleManager.restart();
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

  incrementQueryGeneration(): number {
    const next = ++this._queryGeneration;
    if (this.deliveryResponseObserver?.pendingStart) {
      this.deliveryResponseObserver.generation = next;
      this.deliveryResponseObserver.pendingStart = false;
    }
    return next;
  }

  getQueryGeneration(): number {
    return this._queryGeneration;
  }

  isCleaningUp(): boolean {
    return this._isCleaningUp;
  }

  async onSDKMessage(message: import('@hyperneo/shared/sdk').SDKMessage): Promise<void> {
    await this.messageHandler.handleMessage(message);
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

  async onModelsFetched(): Promise<void> {
    if (!this.queryObject) return;
    try {
      const { getSupportedModelsFromQuery } = await import('../model-service');
      await getSupportedModelsFromQuery(this.queryObject, this.session.id);
    } catch (error) {
      this.logger.warn('Failed to fetch models from SDK:', error);
    }
  }

  async onMarkApiSuccess(message: import('@hyperneo/shared/sdk').SDKMessage): Promise<void> {
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
    hint?: LimitRetryHint
  ): Promise<boolean> {
    return this.rateLimitWatchdog.scheduleRetry(errorMessage, lastUserMessage, hint);
  }

  async onResultLimitError(
    errorText: string,
    hint: LimitRetryHint,
    userMessageUuid?: string
  ): Promise<boolean> {
    return this.onRateLimitExhausted(
      errorText,
      this.queryRunner.resolveRetryUserMessage(userMessageUuid),
      hint
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
    alreadyConsumed = false,
    claimGuard?: () => boolean,
    batchUuids?: string[],
    signal?: AbortSignal,
    observer?: MessageDeliveryAttemptObserver
  ): Promise<DriveTurnOutcome> {
    const turnStartedAt = Date.now();
    this.logger.debug(
      `delivery-turn: driving (uuid=${messageUuid} alreadyConsumed=${alreadyConsumed} ` +
        `queueRunning=${this.messageQueue.isRunning()} queueSize=${this.messageQueue.size()} ` +
        `trackedPids=[${this.snapshotTrackedAgentProcesses()
          .map(([pid]) => pid)
          .join(',')}] sdkSessionId=${this.session.sdkSessionId ?? 'none'})`
    );
    const recordTurnEndMarker = (): void => {
      try {
        const repo = this.db.getSDKMessageRepo();
        const jobQueue = this.db.getJobQueueRepo?.();
        if (!repo || !jobQueue) return;
        if (!jobQueue.isProcessingDelivery(this.session.id, messageUuid)) return;
        const loaded = repo.getDeliveryContent(this.session.id, messageUuid);
        if (!loaded || loaded.sendStatus !== 'consumed') return;
        this.recordDeliveryTurnEnd(messageUuid);
      } catch (error) {
        this.logger.warn('Failed to record delivery turn-end marker at turn end:', error);
      }
    };
    const started = await withSessionLock(
      this.session.id,
      async () => {
        if (!this.messageDeliveryValid(messageUuid, alreadyConsumed)) {
          return { kind: 'aborted' as const };
        }
        if (claimGuard && !claimGuard()) {
          return { kind: 'aborted' as const };
        }
        if (alreadyConsumed && this.reclaimTurnAlreadySucceeded(messageUuid)) {
          return { kind: 'turn_terminated' as const };
        }
        const armedObserver = observer
          ? { generation: this.getQueryGeneration(), observer, pendingStart: true }
          : null;
        if (armedObserver) this.deliveryResponseObserver = armedObserver;
        const disarmObserver = (): void => {
          if (armedObserver && this.deliveryResponseObserver === armedObserver) {
            this.deliveryResponseObserver = null;
          }
        };
        const pendingContentBeforeStart = alreadyConsumed
          ? null
          : (this.messageQueue.getPendingOrInFlightContent?.(messageUuid) ?? null);
        const ensureStartedAt = Date.now();
        let queryStartResult: EnsureQueryStartedResult;
        try {
          queryStartResult = await this.lifecycleManager.ensureQueryStarted(signal);
        } catch (error) {
          disarmObserver();
          throw error;
        }
        this.logger.debug(
          `delivery-turn: ensureQueryStarted → ${queryStartResult} ` +
            `(${Date.now() - ensureStartedAt}ms, uuid=${messageUuid})`
        );
        if (queryStartResult === 'blocked') {
          disarmObserver();
          return { kind: 'blocked' as const };
        }
        const queryPromise = this.queryPromise;
        if (!queryPromise) {
          disarmObserver();
          throw new Error('message_delivery: query did not start; cannot drive turn');
        }
        if (armedObserver) armedObserver.pendingStart = false;
        const generation = armedObserver?.generation ?? this.getQueryGeneration();
        observer?.reportStage('query_ready', { generation });
        if (alreadyConsumed && this.reclaimTurnAlreadySucceeded(messageUuid)) {
          disarmObserver();
          return { kind: 'turn_terminated' as const };
        }
        const turnEnd = this.stateManager.waitForIdleTransition(
          this.rateLimitWatchdog.getGeneration(),
          recordTurnEndMarker
        );
        let acknowledgment: Promise<void> | null = null;
        let freshFeed = false;
        let admittedBatchUuids: string[] | undefined;
        let feedContent: string | MessageContent[] = content;
        if (!alreadyConsumed) {
          if (claimGuard && !claimGuard()) {
            turnEnd.cancel();
            disarmObserver();
            return { kind: 'aborted' as const };
          }
          const existing = this.messageQueue.waitForPendingOrInFlight(messageUuid);
          void existing?.acknowledgment.catch(() => {});
          freshFeed = existing === null;
          if (freshFeed) {
            const loaded = this.db
              .getSDKMessageRepo()
              .getDeliveryContent(this.session.id, messageUuid);
            if (
              this.db.getSession(this.session.id)?.status === 'archived' ||
              loaded?.sendStatus !== 'enqueued'
            ) {
              turnEnd.cancel();
              disarmObserver();
              return { kind: 'aborted' as const };
            }
            feedContent = loaded.content;
          }
          if (batchUuids && batchUuids.length > 1) {
            const rebuilt = this.rebuildBatchDeliveryContent(messageUuid, feedContent, batchUuids);
            feedContent = rebuilt.content;
            admittedBatchUuids = rebuilt.admittedUuids;
            if (freshFeed && !admittedBatchUuids?.includes(messageUuid)) {
              turnEnd.cancel();
              disarmObserver();
              return { kind: 'aborted' as const };
            }
            if (admittedBatchUuids && admittedBatchUuids.length !== batchUuids.length) {
              let narrowed = false;
              try {
                narrowed =
                  this.db
                    .getJobQueueRepo()
                    ?.narrowActiveDeliveryBatchUuids(
                      this.session.id,
                      messageUuid,
                      admittedBatchUuids
                    ) ?? false;
              } catch (error) {
                turnEnd.cancel();
                disarmObserver();
                throw new MessageDeliveryRecoverableTurnError(
                  `batch narrowing failed: ${error instanceof Error ? error.message : String(error)}`
                );
              }
              if (!narrowed) {
                turnEnd.cancel();
                disarmObserver();
                return { kind: 'aborted' as const };
              }
            }
          }
          if (freshFeed && pendingContentBeforeStart !== null) {
            if (!this.deliveryContentMatches(pendingContentBeforeStart, feedContent)) {
              turnEnd.cancel();
              disarmObserver();
              return { kind: 'aborted' as const };
            }
            turnEnd.cancel();
            disarmObserver();
            throw new MessageDeliveryRecoverableTurnError(
              'Pending queue entry disappeared before delivery admission'
            );
          }
          if (existing && !this.deliveryContentMatches(existing.content, feedContent)) {
            if (!this.messageQueue.hasYielded(messageUuid)) {
              this.messageQueue.remove(messageUuid);
            }
            turnEnd.cancel();
            disarmObserver();
            return { kind: 'aborted' as const };
          }
          const memberUuids = (admittedBatchUuids ?? []).filter((uuid) => uuid !== messageUuid);
          if (memberUuids.length > 0) {
            this.markDeliveryBatchSubmitted(memberUuids);
          }
          acknowledgment =
            existing?.acknowledgment ??
            this.messageQueue.admitWithId(messageUuid, feedContent, false, {
              durable: true,
            });
        }
        return {
          kind: 'driving' as const,
          queryPromise,
          turnEnd,
          acknowledgment,
          freshFeed,
          admittedBatchUuids,
          generation,
          responseObserver: armedObserver,
        };
      },
      signal
    );
    if (started.kind === 'blocked') {
      this.logger.warn(
        `delivery-turn: blocked on sdk_resume_choice (uuid=${messageUuid}); parking job`
      );
      await this.stateManager.setQueued(messageUuid);
      return { outcome: 'blocked', retryAt: Date.now() + MESSAGE_DELIVERY_PARK_MS };
    }
    if (started.kind === 'turn_terminated') {
      this.zeroProgressDeliveryFailures = null;
      return { outcome: 'turn_terminated' };
    }
    if (started.kind === 'aborted') {
      return { outcome: 'aborted' };
    }
    if (
      alreadyConsumed &&
      !this.rateLimitWatchdog.isRecoveryPending() &&
      !!this.db
        .getSDKMessageRepo()
        ?.hasRecoveryInterceptedResultAfter?.(this.session.id, messageUuid)
    ) {
      this.logger.info(
        `delivery-turn: reclaiming recovery-intercepted row directly (uuid=${messageUuid}); ` +
          `the parked recovery episode no longer owns its retry.`
      );
      started.turnEnd.cancel();
      if (started.responseObserver && this.deliveryResponseObserver === started.responseObserver) {
        this.deliveryResponseObserver = null;
      }
      if (!claimGuard || claimGuard()) {
        this.reopenDeliveryForRetry(messageUuid);
      }
      throw new MessageDeliveryRecoverableTurnError('Turn ended without a response');
    }
    this.deliveryTurnStalled = false;
    this.outstandingToolUseIds.clear();
    let stallPromise: Promise<void> = new Promise<void>(() => {});
    let stallWatchdog: DeliveryTurnStallWatchdog | null = null;
    let activeTurnEnd = started.turnEnd;
    const responseObserver = started.responseObserver;
    let kickoffAcknowledged = false;
    let kickoffDiedBeforeConsumption = false;
    try {
      if (started.acknowledgment) {
        const aborted = waitForDeliveryAbort(signal);
        let kickoffWinner: 'acknowledged' | 'query_ended' = 'query_ended';
        try {
          kickoffWinner = await Promise.race([
            started.acknowledgment.then(() => 'acknowledged' as const),
            started.queryPromise.catch(() => {}).then(() => 'query_ended' as const),
            aborted.promise,
          ]);
        } catch (error) {
          if (signal?.aborted) {
            if (!started.freshFeed) throw error;
            if (this.messageQueue.remove(messageUuid)) throw error;
            await started.acknowledgment;
            kickoffWinner = 'acknowledged';
          } else {
            if (this.peekTerminalTurnError(turnStartedAt)) throw error;
            const terminal = await this.escalateZeroProgressDeliveryFailure(messageUuid);
            throw terminal ?? error;
          }
        } finally {
          aborted.cancel();
        }
        if (kickoffWinner === 'query_ended') {
          this.logger.warn(
            `delivery-turn: query ended before the SDK consumed the kickoff ` +
              `(uuid=${messageUuid}, generation=${started.generation}); requeueing the ` +
              `kickoff and classifying the turn outcome`
          );
          this.messageQueue.requeueYielded(messageUuid);
          kickoffDiedBeforeConsumption = true;
        }
        if (!kickoffDiedBeforeConsumption) {
          kickoffAcknowledged = true;
          this.zeroProgressDeliveryFailures = null;
          this.logger.debug(
            `delivery-turn: kickoff consumed by SDK ` +
              `(${Date.now() - turnStartedAt}ms since turn start, uuid=${messageUuid})`
          );
          deliveryMetrics.recordFeed(messageUuid);
          observer?.reportStage('sdk_admitted', { generation: started.generation });
          if (this.session.config.provider !== 'acp') {
            const consumeSignalMs = Date.now();
            this.markDeliveryBatchConsumed(started.admittedBatchUuids ?? [messageUuid]);
            deliveryMetrics.recordResidualWindow(Date.now() - consumeSignalMs);
            signalDeliveryConsumed(this.session.id, messageUuid);
            if (started.admittedBatchUuids) {
              for (const memberUuid of started.admittedBatchUuids) {
                if (memberUuid === messageUuid) continue;
                signalDeliveryConsumed(this.session.id, memberUuid);
              }
            }
          }
        }
      }
      throwIfDeliveryAborted(signal);
      stallPromise = this.armDeliveryTurnStall(signal, claimGuard);
      stallWatchdog = this.deliveryTurnStall;
      const SPURIOUS_TURN_END_GRACE_MS = 250;
      const feedAcknowledged = started.acknowledgment !== null;
      let raceArmedAt = Date.now();
      let graceRearms = 0;
      let turnEndFired = false;
      let queryEnded = false;
      void activeTurnEnd.promise.then(() => {
        turnEndFired = true;
      });
      void started.queryPromise
        .catch(() => {})
        .then(() => {
          queryEnded = true;
        });
      while (true) {
        const aborted = waitForDeliveryAbort(signal);
        try {
          await Promise.race([
            activeTurnEnd.promise,
            started.queryPromise.catch(() => {}),
            stallPromise,
            aborted.promise,
          ]);
        } finally {
          aborted.cancel();
        }
        const turnResultRepo = this.db.getSDKMessageRepo();
        const hasAnyTerminalResult =
          !!turnResultRepo?.hasTerminalResultAfter(this.session.id, messageUuid) ||
          !!turnResultRepo?.getErrorTerminalResultSubtypeAfter(this.session.id, messageUuid);
        const spuriousFire = shouldRearmSpuriousTurnEnd({
          feedAcknowledged,
          turnEndFired,
          queryEnded,
          withinGraceMs: Date.now() - raceArmedAt <= SPURIOUS_TURN_END_GRACE_MS,
          graceRearms,
          hasTerminalResult: hasAnyTerminalResult,
        });
        if (!spuriousFire) break;
        graceRearms++;
        activeTurnEnd.cancel();
        activeTurnEnd = this.stateManager.waitForIdleTransition(
          this.rateLimitWatchdog.getGeneration(),
          recordTurnEndMarker
        );
        raceArmedAt = Date.now();
        turnEndFired = false;
        void activeTurnEnd.promise.then(() => {
          turnEndFired = true;
        });
      }
    } finally {
      activeTurnEnd.cancel();
      if (this.deliveryTurnStall === stallWatchdog) {
        this.clearDeliveryTurnStall();
      }
      if (responseObserver && this.deliveryResponseObserver === responseObserver) {
        this.deliveryResponseObserver = null;
      }
    }
    const producedResult = !!this.db
      .getSDKMessageRepo()
      ?.hasTerminalResultAfter(this.session.id, messageUuid);
    if (!producedResult) {
      if (this.rateLimitWatchdog.isRecoveryPending()) {
        const cooldownRetryAt = this.rateLimitWatchdog.getState().retryAt;
        const retryAt = this.rateLimitWatchdog.isManualRecoveryPause()
          ? Date.now() + MANUAL_RECOVERY_PARK_MS
          : Math.max(Date.now() + MESSAGE_DELIVERY_PARK_MS, cooldownRetryAt ?? 0);
        this.db.getSDKMessageRepo()?.clearDeliveryTurnEnd(this.session.id, messageUuid);
        this.logger.info(
          `delivery-turn: parking job while limit recovery is pending ` +
            `(uuid=${messageUuid}, retryAt=${new Date(retryAt).toISOString()})`
        );
        return { outcome: 'recovery_pending', retryAt };
      }
      const turnError = this.consumeTerminalTurnError(turnStartedAt);
      this.db.getSDKMessageRepo()?.clearDeliveryTurnEnd(this.session.id, messageUuid);
      const errorResultSubtype = this.db
        .getSDKMessageRepo()
        ?.getErrorTerminalResultSubtypeAfter(this.session.id, messageUuid);
      const completion = classifyTurnCompletion({
        producedResult,
        turnError,
        errorResultSubtype,
        deliveryTurnStalled: this.deliveryTurnStalled,
        claimGuardHeld: claimGuard ? claimGuard() : undefined,
      });
      if (completion.outcome === 'terminal_error') {
        throw new MessageDeliveryTerminalTurnError(completion.detail, completion.category);
      }
      if (completion.outcome === 'recoverable_error') {
        if (!kickoffAcknowledged && !alreadyConsumed) {
          const terminal = await this.escalateZeroProgressDeliveryFailure(messageUuid);
          if (terminal) throw terminal;
        }
        if (completion.reopenForRetry) {
          this.reopenDeliveryForRetry(messageUuid);
        }
        throw new MessageDeliveryRecoverableTurnError(completion.detail, completion.category);
      }
    }
    this.zeroProgressDeliveryFailures = null;
    return { outcome: 'completed' };
  }

  private armDeliveryTurnStall(signal?: AbortSignal, claimGuard?: () => boolean): Promise<void> {
    this.clearDeliveryTurnStall();
    this.deliveryTurnStalled = false;
    this.deliveryTurnStall = new DeliveryTurnStallWatchdog(
      DELIVERY_TURN_NO_ACTIVITY_MS,
      () => this.outstandingToolUseIds.size > 0,
      async () => {
        if (signal?.aborted || (claimGuard && !claimGuard())) return;
        this.deliveryTurnStalled = true;
        try {
          await this.resetQuery({ restartQuery: false });
        } catch {}
      },
      () => this.stateManager.getState().status === 'rate_limit_cooldown'
    );
    return this.deliveryTurnStall.arm();
  }

  bumpDeliveryTurnActivity(): void {
    this.deliveryTurnStall?.bump();
  }

  reportFirstDeliverySDKResponse(responseType: string): void {
    const active = this.deliveryResponseObserver;
    if (!active || active.pendingStart || active.generation !== this.getQueryGeneration()) return;
    this.deliveryResponseObserver = null;
    active.observer.reportStage('first_sdk_response', {
      generation: active.generation,
      responseType,
    });
  }

  private clearDeliveryTurnStall(): void {
    this.deliveryTurnStall?.cancel();
    this.deliveryTurnStall = null;
  }

  private async escalateZeroProgressDeliveryFailure(
    messageUuid: string
  ): Promise<MessageDeliveryTerminalTurnError | null> {
    if (this.zeroProgressDeliveryFailures?.messageUuid !== messageUuid) {
      this.zeroProgressDeliveryFailures = { messageUuid, count: 0 };
    }
    this.zeroProgressDeliveryFailures.count += 1;
    if (this.zeroProgressDeliveryFailures.count < MAX_ZERO_PROGRESS_DELIVERY_FAILURES) {
      return null;
    }
    this.zeroProgressDeliveryFailures = null;
    const detail =
      `Delivery for ${messageUuid} failed ${MAX_ZERO_PROGRESS_DELIVERY_FAILURES} consecutive ` +
      `times with zero SDK progress — every query backing the turn died before the message ` +
      `was consumed (startup-gate admission aborts under retry pressure). Failing the message ` +
      `and resetting the session instead of retrying.`;
    this.logger.error(
      `delivery-turn: zero-progress delivery livelock detected for session ${this.session.id} ` +
        `(uuid=${messageUuid}, queueRunning=${this.messageQueue.isRunning()}, ` +
        `liveQuery=${this.hasLiveQuery()}, generation=${this.getQueryGeneration()}); ` +
        `resetting the session and terminalizing the delivery`
    );
    deliveryMetrics.recordZeroProgressWedge();
    try {
      const resetResult = await this.resetQuery({ restartQuery: false });
      if (!resetResult.success) {
        this.logger.warn(
          `delivery-turn: wedge recovery reset reported failure: ${resetResult.error ?? 'unknown'}`
        );
      }
    } catch (resetError) {
      this.logger.warn('delivery-turn: wedge recovery reset failed:', resetError);
    }
    return new MessageDeliveryTerminalTurnError(detail, 'delivery_zero_progress');
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

  private peekTerminalTurnError(turnStartedAt: number): StructuredError | null {
    const entry = this.lastTerminalError;
    if (!entry || entry.at < turnStartedAt) return null;
    return entry.error;
  }

  private consumeTerminalTurnError(turnStartedAt: number): StructuredError | null {
    const entry = this.lastTerminalError;
    if (!entry || entry.at < turnStartedAt) return null;
    this.lastTerminalError = null;
    return entry.error;
  }

  async feedDeliverySteer(
    messageUuid: string,
    content: string | MessageContent[],
    _parentToolUseId?: string | null,
    claimGuard?: () => boolean,
    signal?: AbortSignal,
    observer?: MessageDeliveryAttemptObserver
  ): Promise<FeedSteerOutcome> {
    const action = await withSessionLock(
      this.session.id,
      async () => {
        if (claimGuard && !claimGuard()) return { kind: 'aborted' as const };
        const status = this.stateManager.getState().status;
        if (status === 'processing') {
          if (!this.messageDeliveryValid(messageUuid)) return { kind: 'aborted' as const };
          if (!this.queryPromise) return { kind: 'promote' as const };
          const generation = this.getQueryGeneration();
          observer?.reportStage('query_ready', { generation });
          if (
            this.session.config.provider === 'acp' &&
            this.messageQueue.hasPendingOrInFlight(messageUuid)
          ) {
            return { kind: 'awaiting_acceptance' as const };
          }
          const acknowledgment = this.messageQueue.admitWithId(messageUuid, content, false, {
            durable: true,
          });
          return { kind: 'feed' as const, acknowledgment, generation };
        }
        if (status === 'queued') return { kind: 'park' as const };
        return { kind: 'promote' as const };
      },
      signal
    );
    if (action.kind === 'promote') {
      return { outcome: 'promote' };
    }
    if (action.kind === 'park') {
      return { outcome: 'park' };
    }
    if (action.kind === 'aborted') {
      return { outcome: 'aborted' };
    }
    if (action.kind === 'awaiting_acceptance') {
      return { outcome: 'awaiting_acceptance' };
    }
    const aborted = waitForDeliveryAbort(signal);
    const steerQueryEnded: Promise<'query_ended'> = this.queryPromise
      ? this.queryPromise.catch(() => {}).then(() => 'query_ended' as const)
      : Promise.resolve('query_ended');
    let steerWinner: 'acknowledged' | 'query_ended' = 'query_ended';
    try {
      steerWinner = await Promise.race([
        action.acknowledgment.then(() => 'acknowledged' as const),
        steerQueryEnded,
        aborted.promise,
      ]);
    } catch (error) {
      if (signal?.aborted) {
        if (this.messageQueue.remove(messageUuid)) throw error;
        await action.acknowledgment;
        steerWinner = 'acknowledged';
      } else {
        throw error;
      }
    } finally {
      aborted.cancel();
    }
    if (steerWinner === 'query_ended') {
      this.messageQueue.requeueYielded(messageUuid);
      throw new Error('Steer target query ended before the SDK consumed the steer');
    }
    deliveryMetrics.recordFeed(messageUuid);
    observer?.reportStage('sdk_admitted', { generation: action.generation });
    if (this.session.config.provider !== 'acp') {
      this.markDeliveryConsumed(messageUuid);
      signalDeliveryConsumed(this.session.id, messageUuid);
      return { outcome: 'consumed' };
    }
    return { outcome: 'awaiting_acceptance' };
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
      let role: 'turn' | 'steer';
      try {
        role = deliverMessage(this.db.getJobQueueRepo(), this.session.id, messageUuid, {
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
      if (role === 'turn' || this.stateManager.getState().status === 'rate_limit_cooldown') {
        this.rateLimitWatchdog.cancel();
      }
      if (role === 'turn') {
        try {
          await this.stateManager.setQueuedIfIdle(messageUuid);
        } catch (error) {
          this.logger.warn('Queued-state publication failed after durable insertion:', error);
        }
      }
    });
  }

  private messageDeliveryValid(messageUuid: string, alreadyConsumed = false): boolean {
    if (this.db.getSession(this.session.id)?.status === 'archived') return false;
    const loaded = this.db.getSDKMessageRepo().getDeliveryContent(this.session.id, messageUuid);
    return (
      loaded !== null &&
      (loaded.sendStatus === 'enqueued' || (alreadyConsumed && loaded.sendStatus === 'consumed'))
    );
  }

  private reclaimTurnAlreadySucceeded(messageUuid: string): boolean {
    const repo = this.db.getSDKMessageRepo();
    if (!repo) return false;
    const decision = classifyReclaimTermination({
      successResult: repo.hasTerminalResultAfter(this.session.id, messageUuid),
      markerExists: repo.hasDeliveryTurnEnd(this.session.id, messageUuid),
      terminalIdleInFlight: this.stateManager.isTerminalIdleInFlight(),
    });
    if (decision === 'redrive') {
      repo.clearDeliveryTurnEnd(this.session.id, messageUuid);
    }
    return decision === 'terminated';
  }

  recordDeliveryTurnEnd(messageUuid: string): void {
    this.db
      .getSDKMessageRepo()
      .recordDeliveryTurnEnd(this.session.id, messageUuid, new Date().toISOString());
  }

  private markDeliveryConsumed(messageUuid: string): void {
    const dbId = this.db
      .getSDKMessageRepo()
      .markDeliveryConsumedByUuid(this.session.id, messageUuid);
    if (dbId) {
      void this.internalEventBus
        .publish('messages.statusChanged', {
          sessionId: this.session.id,
          messageIds: [dbId],
          status: 'consumed',
        })
        .catch(() => {});
    }
  }

  private markDeliveryBatchConsumed(uuids: string[]): void {
    const flippedIds = this.db
      .getSDKMessageRepo()
      .markDeliveryConsumedByUuids(this.session.id, uuids);
    if (flippedIds.length > 0) {
      void this.internalEventBus
        .publish('messages.statusChanged', {
          sessionId: this.session.id,
          messageIds: flippedIds,
          status: 'consumed',
        })
        .catch(() => {});
    }
  }

  private markDeliveryBatchSubmitted(uuids: string[]): void {
    const flippedIds = this.db
      .getSDKMessageRepo()
      .markDeliverySubmittedByUuids(this.session.id, uuids);
    if (flippedIds.length > 0) {
      void this.internalEventBus
        .publish('messages.statusChanged', {
          sessionId: this.session.id,
          messageIds: flippedIds,
          status: 'submitted',
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

  private rebuildBatchDeliveryContent(
    kickoffUuid: string,
    kickoffContent: string | MessageContent[],
    batchUuids: string[]
  ): { content: string | MessageContent[]; admittedUuids?: string[] } {
    const repo = this.db.getSDKMessageRepo();
    const texts: string[] = [];
    const admitted: string[] = [];
    let kickoffRaw: string | MessageContent[] | null = null;
    let budget = BATCH_DELIVERY_MAX_CHARS;
    for (const uuid of batchUuids) {
      const row = repo.getDeliveryContent(this.session.id, uuid);
      if (!row) continue;
      if (row.sendStatus === 'deferred' || row.sendStatus === 'failed') continue;
      const text = flattenDeliveryText(row.content);
      if (text === null) continue;
      const cost = text.length + 32;
      if (texts.length > 0 && budget < cost) break;
      budget -= cost;
      if (uuid === kickoffUuid) kickoffRaw = row.content;
      texts.push(text);
      admitted.push(uuid);
    }
    if (texts.length === 0) {
      return { content: kickoffContent };
    }
    if (texts.length === 1) {
      return { content: kickoffRaw ?? kickoffContent, admittedUuids: admitted };
    }
    return { content: buildBatchedDeliveryContent(texts), admittedUuids: admitted };
  }

  private reopenDeliveryForRetry(messageUuid: string): void {
    deliveryMetrics.forgetFeed(messageUuid);
    const dbId = this.db
      .getSDKMessageRepo()
      ?.markDeliveryRetryableByUuid(this.session.id, messageUuid);
    if (dbId) {
      void this.internalEventBus
        .publish('messages.statusChanged', {
          sessionId: this.session.id,
          messageIds: [dbId],
          status: 'enqueued',
        })
        .catch(() => {});
    }
  }

  async reconcileStrandedDeliveries(): Promise<number> {
    if (!isMessageDeliveryV2Enabled()) return 0;
    const jobQueue = this.db.getJobQueueRepo?.();
    if (!jobQueue) return 0;
    const status = this.stateManager.getState().status;
    if (decideReconcileAdmission({ processingStatus: status }).action === 'skip') {
      return 0;
    }

    const reEnqueued = await withSessionResetCoordination(this.session.id, async () =>
      withSessionLock(this.session.id, async () => {
        const active = jobQueue.activeDeliveryMessageUuids(this.session.id);
        const stranded = selectStrandedDeliveries(
          this.db.getUserMessageIdsByStatus(this.session.id, 'enqueued'),
          active,
          (uuid) => this.messageQueue.hasPendingOrInFlight(uuid)
        );
        for (const uuid of stranded) {
          const role = deliverMessage(jobQueue, this.session.id, uuid, { origin: 'recovery' });
          if (role === 'turn') {
            await this.stateManager.setQueuedIfIdle(uuid).catch(() => {});
          }
        }
        return stranded.length;
      })
    );
    let settled = 0;
    const sdkRepo = this.db.getSDKMessageRepo();
    await withSessionLock(this.session.id, async () => {
      const activeNow = jobQueue.activeDeliveryMessageUuids(this.session.id);
      for (const msg of this.db.getUserMessageIdsByStatus(this.session.id, 'submitted')) {
        const uuid = msg.uuid;
        if (typeof uuid !== 'string' || uuid.length === 0) continue;
        if (activeNow.has(uuid)) continue;
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
    const { clearModelsCache } = await import('../model-service');
    clearModelsCache(this.session.id);
  }

  async cleanup(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.messageHandler.cancelSuppressedResultWait();
    this.clearDeliveryTurnStall();
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
