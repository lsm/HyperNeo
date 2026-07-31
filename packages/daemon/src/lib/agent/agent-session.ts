/**
 * AgentSession - Pure Facade/Orchestrator for Claude Agent SDK Sessions
 *
 * ## Architecture: Handler Context Pattern
 *
 * This class is a thin orchestrator that delegates ALL business logic to handlers.
 * AgentSession itself contains NO implementation code - only:
 * 1. Handler instantiation and wiring
 * 2. Public API methods that delegate to handlers
 * 3. Context interface implementation (getters/setters for handler access)
 *
 * ## How to Add New Features
 *
 * 1. Create a new handler file: `my-feature-handler.ts`
 * 2. Define a context interface with required dependencies:
 *    ```typescript
 *    export interface MyFeatureHandlerContext {
 *      readonly session: Session;
 *      readonly db: Database;
 *      // ... other needed properties
 *    }
 *    ```
 * 3. Create handler class that takes context:
 *    ```typescript
 *    export class MyFeatureHandler {
 *      constructor(private ctx: MyFeatureHandlerContext) {}
 *      myMethod() { ... }
 *    }
 *    ```
 * 4. Add `MyFeatureHandlerContext` to AgentSession implements list
 * 5. Add handler property and instantiate in constructor
 * 6. Add delegation method: `myMethod() { return this.myFeatureHandler.myMethod(); }`
 *
 * ## Handler Categories
 *
 * **Core Components** (stateful, used by multiple handlers):
 * - MessageQueue: Message queueing with AsyncGenerator
 * - ProcessingStateManager: State machine for processing phases
 * - ContextTracker: Real-time context window usage
 *
 * **Business Logic Handlers**:
 * - QueryLifecycleManager: Query start/stop/restart/cleanup
 * - SDKMessageHandler: SDK message processing, circuit breaker
 * - AskUserQuestionHandler: User question/answer flow
 * - ModelSwitchHandler: Runtime model switching
 * - RewindHandler: Checkpoint rewind operations
 * - SessionConfigHandler: Config and metadata updates
 * - InterruptHandler: User interrupt handling
 *
 * **Infrastructure Handlers**:
 * - QueryRunner: Low-level query execution
 * - QueryOptionsBuilder: SDK options construction
 * - SDKRuntimeConfig: Runtime SDK settings
 * - EventSubscriptionSetup: InternalEventBus<DaemonInternalEventMap> event wiring
 * - QueryModeHandler: Manual/auto-queue mode
 * - SlashCommandManager: Slash command caching
 * - MessageRecoveryHandler: Orphaned message recovery
 *
 * ## SDK Mode
 *
 * Uses STREAMING INPUT mode - a single persistent SDK query with AsyncGenerator
 * that continuously yields messages from a queue.
 */

import type {
  AgentProcessingState,
  MessageContent,
  Session,
  SessionType,
  SessionContext,
  SessionFeatures,
  SessionConfig,
  SessionMetadata,
  ContextInfo,
  QuestionDraftResponse,
  MessageHub,
  CurrentModelInfo,
  RewindPreview,
  RewindResult,
  RewindMode,
  SelectiveRewindPreview,
  SelectiveRewindResult,
  SystemPromptConfig,
  McpServerConfig,
  Provider,
  FallbackModelEntry,
} from '@hyperneo/shared';
import type {
  ChatMessage,
  MessageOrigin,
  SkillEnablementOverride,
  DeclarativeToolGuard,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Database } from '../../storage/database';
import { ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import { SettingsManager } from '../settings-manager';
import { DEFAULT_WORKER_FEATURES as WORKER_FEATURES } from '@hyperneo/shared';

export const RECENTLY_EXITED_ROOT_PID_RETENTION_MS = 15 * 60 * 1000;

/**
 * AgentSessionInit - Configuration for creating a new AgentSession
 *
 * Used by SpaceRuntimeService and other session creators to create sessions
 * with custom system prompts, MCP servers, and feature flags.
 */
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
  /** Session ID (e.g., 'space:chat:abc123', or UUID for worker) */
  sessionId: string;

  /** Optional display title for this session */
  title?: string;

  /** Workspace path for this session */
  workspacePath: string;

  /** System prompt configuration - provided by caller */
  systemPrompt?: SystemPromptConfig;

  /** Non-secret prompt provenance for observability; never contains full prompt text. */
  promptProvenance?: PromptProvenanceInit;

  /** MCP servers configuration - provided by caller (merged with user config) */
  mcpServers?: Record<string, McpServerConfig>;

  /** Feature flags controlling UI capabilities */
  features?: SessionFeatures;

  /** Optional context for session orchestration */
  context?: SessionContext;

  /** Session type - defaults to 'worker' */
  type?: SessionType;

  /** Model ID - defaults to default model */
  model?: string;

  /** Provider ID for this session — if omitted, auto-detected from model or falls back to Anthropic */
  provider?: string;

  /** Thinking level for extended thinking — if omitted, global settings apply */
  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;

  /** Enable coordinator mode — main agent orchestrates specialist sub-agents */
  coordinatorMode?: boolean;

  /** The named agent to use as the main agent (must be a key in `agents`) */
  agent?: string;

  /** Custom sub-agent definitions (merged with built-in specialists in coordinator mode) */
  agents?: Record<string, import('@hyperneo/shared').AgentDefinition>;

  /** SDK tool selection for this session */
  sdkToolsPreset?: import('@hyperneo/shared').ToolsPresetConfig;

  /** Tools to auto-allow without permission prompts */
  allowedTools?: string[];

  /** Tools to disable entirely */
  disallowedTools?: string[];

  /**
   * Runtime skill overrides applied on top of the global skills registry.
   * Skills with enabled=false in this list are excluded from injection even if
   * globally enabled.
   */
  skillOverrides?: SkillEnablementOverride[];
  /**
   * Declarative tool guards from the workflow node agent definition.
   * Compiled into SDK hooks at runtime by the query options builder.
   */
  toolGuards?: DeclarativeToolGuard[];
  /**
   * Setting sources to load for this session (e.g., ['user', 'project', 'local']).
   * Falls back to global settings when unset.
   */
  settingSources?: import('@hyperneo/shared').SettingSource[];
}

export interface AgentSessionRuntimeOptions {
  /**
   * Whether the constructor should replay persisted pending messages for
   * immediate-mode sessions.
   *
   * Space-owned restored sessions need owner-specific in-process MCP servers
   * rebuilt before any query can start, so their managers pass false and call
   * replayPendingMessagesForImmediateMode() after runtime provisioning.
   */
  autoReplayPendingMessages?: boolean;

  /**
   * Optional owner-provided hard reset primitive.
   *
   * SessionManager uses this to replace the cached in-memory AgentSession with
   * a fresh instance while preserving the persisted session row.
   */
  hardReset?: (
    session: AgentSession,
    options: { restartQuery: boolean }
  ) => Promise<{ success: boolean; error?: string }>;
}

// Extracted components
import { MessageQueue } from './message-queue';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { SDKMessageHandler, type SDKMessageHandlerContext } from './sdk-message-handler';
import { QueryOptionsBuilder, type QueryOptionsBuilderContext } from './query-options-builder';
import {
  QueryLifecycleManager,
  type QueryLifecycleManagerContext,
} from './query-lifecycle-manager';
import { ModelSwitchHandler, type ModelSwitchHandlerContext } from './model-switch-handler';
import {
  AskUserQuestionHandler,
  type AskUserQuestionHandlerContext,
} from './ask-user-question-handler';
import {
  QueryRunner,
  type QueryRunnerContext,
  type OriginalEnvVars,
  type TrackedAgentProcess,
} from './query-runner';
import { AcpQueryRunner } from '../acp/acp-query-runner';
import type { QueryLike } from './query-like';
import { InterruptHandler, type InterruptHandlerContext } from './interrupt-handler';
import { SDKRuntimeConfig, type SDKRuntimeConfigContext } from './sdk-runtime-config';
import {
  EventSubscriptionSetup,
  type EventSubscriptionSetupContext,
} from './event-subscription-setup';
import { QueryModeHandler, type QueryModeHandlerContext } from './query-mode-handler';
import { SlashCommandManager, type SlashCommandManagerContext } from './slash-command-manager';
import { MessageRecoveryHandler } from './message-recovery-handler';
import { RewindHandler, type RewindHandlerContext, type RewindPoint } from './rewind-handler';
import { SessionConfigHandler, type SessionConfigHandlerContext } from './session-config-handler';
import { RateLimitWatchdog } from './rate-limit-watchdog';
import { resolveFallbackChain } from './fallback-recovery';
import { getProviderRegistry } from '../providers/factory.js';

/**
 * AgentSession - Pure facade that delegates to specialized handlers
 *
 * Implements all handler context interfaces so handlers can access state directly.
 * This class should contain NO business logic - only delegation and wiring.
 */
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
  // Core components (accessible to handlers via context interfaces)
  readonly messageQueue: MessageQueue;
  readonly stateManager: ProcessingStateManager;
  readonly contextTracker: ContextTracker;
  readonly messageHandler: SDKMessageHandler;
  readonly lifecycleManager: QueryLifecycleManager;
  readonly modelSwitchHandler: ModelSwitchHandler;
  readonly askUserQuestionHandler: AskUserQuestionHandler;
  readonly optionsBuilder: QueryOptionsBuilder;

  // Extracted handlers (accessible to EventSubscriptionSetupContext)
  private queryRunner: QueryRunner | AcpQueryRunner;
  readonly interruptHandler: InterruptHandler;
  private sdkRuntimeConfig: SDKRuntimeConfig;
  private eventSubscriptionSetup: EventSubscriptionSetup;
  readonly queryModeHandler: QueryModeHandler;
  private slashCommandManager: SlashCommandManager;

  // Rewind support (accessible to handlers)
  private rewindHandler: RewindHandler;

  // Config handler
  private sessionConfigHandler: SessionConfigHandler;

  // Rate limit auto-retry watchdog
  private rateLimitWatchdog: RateLimitWatchdog;

  // Query state (accessible to handlers via context interfaces)
  queryObject: QueryLike | null = null;
  queryPromise: Promise<void> | null = null;
  private _queryGeneration = 0;
  queryAbortController: AbortController | null = null;
  firstMessageReceived = false;
  startupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  originalEnvVars: OriginalEnvVars = {};
  processExitedPromise: Promise<void> | null = null;
  private trackedAgentProcesses = new Map<number, TrackedAgentProcess>();
  private trackedAgentProcessExitPromises = new Map<number, Promise<void>>();
  /** Durable no-PID exit promises — retained until resolved so updateProcessExitedPromise() never drops them. */
  private noPidExitPromises: Promise<void>[] = [];
  private recentlyExitedAgentRootPids = new Map<number, number>();
  private forceKillTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // Session state
  private _isCleaningUp = false;
  private pendingResumeSessionAt: string | undefined;
  pendingRestartReason: 'settings.local.json' | null = null;
  private initialPendingReplayScheduled = false;

  // Services (accessible to handlers)
  readonly errorManager: ErrorManager;
  settingsManager: SettingsManager;
  readonly logger: Logger;

  /**
   * Self-heal callback for workflow sub-sessions: invoked by `QueryRunner.start()`
   * when it detects missing MCP servers. Set by `TaskAgentManager.createSubSession`
   * so that the manager can re-attach the servers before the first turn runs.
   *
   * undefined for generic sessions (chat, worker, etc.) where this hook is N/A.
   */
  onMissingWorkflowMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  /**
   * Self-heal callback for Space chat sessions: invoked by `QueryRunner.start()`
   * when it detects that the `space-agent-tools` MCP server is absent before a
   * turn starts (notably after context compaction/session resume). Set by
   * SpaceRuntimeService when provisioning the Space Agent session.
   */
  onMissingSpaceChatMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  /**
   * Self-heal callback for Space member sessions (ad-hoc worker sessions with
   * `context.spaceId`): invoked by `QueryRunner.start()` when it detects that
   * the `space-agent-tools` MCP server is absent before a turn starts (notably
   * after cache eviction / DB reload). Set by SpaceRuntimeService in
   * `attachSpaceToolsToMemberSession()`.
   */
  onMissingMemberSpaceMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  /**
   * Unified per-scope MCP enablement repo — exposed on the context so the
   * QueryOptionsBuilder can resolve the session > space > registry
   * precedence for skill-wrapped MCP servers (MCP M6).
   *
   * Exposed as a getter because every AgentSession already owns a Database
   * reference; this avoids threading a new constructor arg through every
   * spawn call site just to re-wrap something that's already reachable.
   */
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
    this.settingsManager = new SettingsManager(
      this.db,
      this.session.worktree?.worktreePath ?? this.session.workspacePath ?? undefined
    );

    // Initialize core components (order matters - some handlers depend on earlier ones)
    this.messageQueue = new MessageQueue();
    this.stateManager = new ProcessingStateManager(session.id, internalEventBus, db);
    this.contextTracker = new ContextTracker(session.id, (contextInfo: ContextInfo) => {
      this.session.metadata.lastContextInfo = contextInfo;
      this.db.updateSession(this.session.id, { metadata: this.session.metadata });
    });

    // Initialize SDKMessageHandler (handlers take AgentSession context directly)
    this.messageHandler = new SDKMessageHandler(this);

    // Initialize QueryLifecycleManager (handlers take AgentSession context directly)
    this.lifecycleManager = new QueryLifecycleManager(this);

    // Initialize model switch handler (handlers take AgentSession context directly)
    this.modelSwitchHandler = new ModelSwitchHandler(this);

    // Initialize AskUserQuestion handler (handlers take AgentSession context directly)
    this.askUserQuestionHandler = new AskUserQuestionHandler(this);

    // Initialize QueryOptionsBuilder (handlers take AgentSession context directly)
    this.optionsBuilder = new QueryOptionsBuilder(this);

    // Initialize query runners (handlers take AgentSession context directly)
    this.queryRunner =
      session.config.provider === 'acp' ? new AcpQueryRunner(this) : new QueryRunner(this);

    // Initialize InterruptHandler (handlers take AgentSession context directly)
    this.interruptHandler = new InterruptHandler(this);

    // Initialize SDKRuntimeConfig (handlers take AgentSession context directly)
    this.sdkRuntimeConfig = new SDKRuntimeConfig(this);

    // Initialize QueryModeHandler (handlers take AgentSession context directly)
    this.queryModeHandler = new QueryModeHandler(this);

    // Initialize SlashCommandManager (handlers take AgentSession context directly)
    this.slashCommandManager = new SlashCommandManager(this);

    // Initialize RewindHandler (handlers take AgentSession context directly)
    this.rewindHandler = new RewindHandler(this);

    // Initialize SessionConfigHandler (handlers take AgentSession context directly)
    this.sessionConfigHandler = new SessionConfigHandler(this);

    // Initialize RateLimitWatchdog — detects 429/usage-limit exhaustion and
    // drives two-phase recovery: (A) immediate fallback-model switch via the
    // configured fallback chain, then (B) a cooldown at a parsed reset time or
    // on a backoff ladder. Deps are injected here so the watchdog stays free of
    // session/DB/provider coupling.
    this.rateLimitWatchdog = new RateLimitWatchdog(session.id, this.stateManager, {
      getCurrentModel: () => ({
        provider: (this.session.config.provider as string | undefined) ?? 'anthropic',
        model: this.session.config.model ?? 'sonnet',
      }),
      resolveChain: () => {
        const gs = this.settingsManager.getGlobalSettings();
        const { provider, model } = this.session.config;
        return resolveFallbackChain(
          (provider as string | undefined) ?? 'anthropic',
          model ?? 'sonnet',
          gs.modelFallbackMap,
          gs.fallbackModels
        );
      },
      isEntryAvailable: async (entry) => {
        try {
          const reg = getProviderRegistry();
          const p = reg.detectProviderForModel(entry.model, entry.provider);
          if (!p) return false;
          // `isAvailable()` is the authoritative runtime gate — it covers
          // env-var / gh CLI / hosts.yml credentials as well as HyperNeo-managed
          // auth.json. Do NOT additionally require `getAuthStatus().isAuthenticated`:
          // some providers (e.g. anthropic-copilot) intentionally report
          // `isAuthenticated: false` for externally-provided credentials, so that
          // check would wrongly make a usable fallback appear unavailable.
          return await Promise.resolve(p.isAvailable());
        } catch {
          return false;
        }
      },
      switchAndRetry: (lastUserMessage, entry) =>
        this.switchAndRetryForFallback(lastUserMessage, entry),
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
    });
    this.rateLimitWatchdog.setRetryCallback(async (lastUserMessage, switchTo) => {
      if (switchTo) {
        // A cooldown that was scheduled after a fallback switch re-switches
        // before re-enqueuing (rare). Goes through the same timing-safe path.
        await this.switchAndRetryForFallback(lastUserMessage, switchTo);
        return;
      }
      await this.executeRateLimitAutoRetry(lastUserMessage);
    });

    // Initialize EventSubscriptionSetup (handlers take AgentSession context directly)
    // Must be last since it needs other handlers to be initialized
    this.eventSubscriptionSetup = new EventSubscriptionSetup(this);

    // Set state manager callback - delegates to lifecycleManager
    this.stateManager.setOnIdleCallback(async () => {
      await this.lifecycleManager.executeDeferredRestartIfPending();
    });

    // Restore persisted state
    if (session.metadata?.lastContextInfo) {
      this.contextTracker.restoreFromMetadata(session.metadata.lastContextInfo);
    }
    this.stateManager.restoreFromDatabase();

    // Recover orphaned messages
    const recoveryHandler = new MessageRecoveryHandler(session, db, this.logger);
    recoveryHandler.recoverOrphanedConsumedMessages();

    // Setup event subscriptions (moved callbacks into EventSubscriptionSetup)
    this.eventSubscriptionSetup.setup();

    if (this.runtimeOptions.autoReplayPendingMessages ?? true) {
      this.scheduleInitialPendingMessageReplay();
    }
  }

  // ============================================================================
  // Factory Method for Unified Session Architecture
  // ============================================================================

  /**
   * Create an AgentSession from init configuration
   *
   * This is the preferred way to create Space chat and orchestration sessions.
   * For worker sessions, use SessionManager.createSession() which handles
   * title generation, worktree setup, etc.
   *
   * @param init - Session initialization config
   * @param db - Database instance
   * @param messageHub - MessageHub for WebSocket communication
   * @param internalEventBus - InternalEventBus<DaemonInternalEventMap> for event bus
   * @param getApiKey - Function to get API key
   * @param defaultModel - Default model to use if not specified in init
   * @returns AgentSession instance
   */
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
    // Check if session already exists in DB
    let session = db.getSession(init.sessionId);

    if (!session) {
      // Create new session from init
      session = AgentSession.createSessionFromInit(init, defaultModel);
      db.createSession(session);
    } else {
      const updates: Partial<Session> = {};
      let hasUpdates = false;

      // Keep deterministic workspace for long-lived session IDs across restarts.
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

      // Non-worker sessions should never run with a worktree path from stale persisted state.
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

    // Merge runtime-only config (mcpServers with non-serializable instances)
    // into the session config for use by query options builder.
    // This is NOT persisted to DB - only available in memory.
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

  /**
   * Restore an AgentSession from DB after daemon restart.
   *
   * Unlike fromInit(), this skips fingerprint comparison and init-derived config
   * updates. Used for worker/leader sessions that were persisted before restart.
   *
   * Returns null if the session doesn't exist in DB.
   */
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

  /**
   * Create a Session object from AgentSessionInit
   *
   * This creates the session data structure that can be persisted to DB.
   */
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
      // Pass through system prompt from init
      systemPrompt: init.systemPrompt,
      // NOTE: mcpServers is intentionally NOT stored here because it may contain
      // non-serializable objects (e.g., McpSdkServerConfigWithInstance with live McpServer).
      // MCP servers are passed to AgentSession at runtime and don't need persistence.
      // Store features in config for frontend access
      features,
      // Default tools config for non-worker sessions
      tools: type !== 'worker' ? { useClaudeCodePreset: false } : undefined,
      // Coordinator mode — leader sessions use this with reviewer sub-agents
      coordinatorMode: init.coordinatorMode,
      agent: init.agent,
      agents: init.agents,
      sdkToolsPreset: init.sdkToolsPreset,
      allowedTools: init.allowedTools,
      disallowedTools: init.disallowedTools,
      // Persist tool guards so they survive daemon restart / session restore
      toolGuards: init.toolGuards,
      // Setting sources for loading CLAUDE.md and settings files
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

  // ============================================================================
  // Query Lifecycle
  // ============================================================================

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

  /**
   * Replay persisted pending messages after runtime-only session provisioning
   * has completed.
   *
   * Space owners call this after attaching live SDK MCP server instances on
   * restored sessions. It is also what the constructor schedules for generic
   * sessions where no owner-specific provisioning is required.
   */
  async replayPendingMessagesForImmediateMode(): Promise<void> {
    if (this.session.config.queryMode === 'manual') return;
    const restoredState = this.stateManager.getState();
    if (restoredState.status === 'waiting_for_input') return;
    await this.queryModeHandler.replayPendingMessagesForImmediateMode();
  }

  async ensureQueryStarted(): Promise<void> {
    await this.lifecycleManager.ensureQueryStarted();
  }

  async startQueryAndEnqueue(
    messageId: string,
    messageContent: string | MessageContent[]
  ): Promise<void> {
    // Cancel any pending rate limit auto-retry — user sent a new message
    this.rateLimitWatchdog.cancel();
    await this.lifecycleManager.startQueryAndEnqueue(messageId, messageContent);
  }

  removeQueuedMessage(messageId: string): boolean {
    return this.messageQueue.remove(messageId);
  }

  // ============================================================================
  // Interrupt and Reset
  // ============================================================================

  async handleInterrupt(): Promise<void> {
    await this.interruptHandler.handleInterrupt();
  }

  async resetQuery(options?: {
    restartQuery?: boolean;
    hardReset?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    // Cancel any pending rate-limit cooldown timer so it doesn't
    // inject stale messages into the reset session.
    this.rateLimitWatchdog.cancel();

    const restartQuery = options?.restartQuery ?? true;
    if (options?.hardReset && this.runtimeOptions.hardReset) {
      return await this.runtimeOptions.hardReset(this, { restartQuery });
    }

    return await this.lifecycleManager.reset({ restartAfter: restartQuery });
  }

  // ============================================================================
  // Rate Limit Auto-Retry
  // ============================================================================

  /**
   * Switch to a fallback model and re-enqueue the last user message (Phase A of
   * rate-limit recovery). Timing-critical: this MUST run after the failed
   * query's `finally` block completes, so we `await this.queryPromise` first
   * (it resolves only once query-runner has torn the query down — queryObject
   * nulled, env restored, setIdle called). By then the query is inactive, so
   * `handleModelSwitch` takes its config-only branch (model-switch-handler) and
   * `executeRateLimitAutoRetry` starts a fresh query with the new model.
   *
   * Returns false if the switch itself failed so the watchdog marks the entry
   * tried and advances to the next chain entry.
   */
  private async switchAndRetryForFallback(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    entry: FallbackModelEntry
  ): Promise<boolean> {
    if (!lastUserMessage) {
      this.logger.warn('Fallback switch skipped: no last user message available.');
      await this.stateManager.setIdle();
      return false;
    }
    try {
      // (1) Wait for the failed query's cleanup to finish before mutating config.
      if (this.queryPromise) {
        try {
          await this.queryPromise;
        } catch {
          // The failed query already rejected; its finally has still run.
        }
      }

      // (2) Switch model. The query is inactive now → config-only branch, no restart.
      const result = await this.handleModelSwitch(entry.model, entry.provider);
      if (!result.success) {
        this.logger.warn(
          `Fallback switch to ${entry.provider}/${entry.model} failed: ${result.error}. ` +
            `Will try the next chain entry.`
        );
        return false;
      }

      // (3) Re-enqueue with the new model and start a fresh query.
      await this.executeRateLimitAutoRetry(lastUserMessage);
      return true;
    } catch (err) {
      this.logger.error('Fallback switch-and-retry failed:', err);
      await this.stateManager.setIdle();
      return false;
    }
  }

  /**
   * Execute auto-retry after rate limit cooldown.
   * Re-enqueues the last user message and starts a new query.
   */
  private async executeRateLimitAutoRetry(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null
  ): Promise<void> {
    if (!lastUserMessage) {
      this.logger.warn('Rate limit auto-retry skipped: no last user message available.');
      await this.stateManager.setIdle();
      return;
    }

    this.logger.info(
      `Rate limit auto-retry: re-enqueueing user message ${lastUserMessage.uuid} ` +
        `and restarting query.`
    );

    try {
      // Ensure the session is idle before starting a new query
      await this.stateManager.setIdle();

      // Re-enqueue the last user message and start the query
      await this.startQueryAndEnqueue(lastUserMessage.uuid, lastUserMessage.content);
    } catch (error) {
      this.logger.error('Rate limit auto-retry failed:', error);
      await this.stateManager.setIdle();
    }
  }

  /**
   * Cancel a pending rate limit auto-retry.
   * Called when the user explicitly cancels or sends a new message.
   */
  cancelRateLimitRetry(): void {
    this.rateLimitWatchdog.cancel();
    // Transition from rate_limit_cooldown to idle
    if (this.stateManager.getState().status === 'rate_limit_cooldown') {
      void this.stateManager.setIdle();
    }
  }

  /**
   * Immediately retry after a rate limit (bypassing the cooldown timer).
   * Called when the user clicks "Retry Now" in the UI.
   */
  async retryNowAfterRateLimit(): Promise<void> {
    const state = this.rateLimitWatchdog.getState();
    if (state.status !== 'cooldown') {
      this.logger.warn('retryNowAfterRateLimit: no cooldown pending.');
      return;
    }

    const lastUserMessage = state.lastUserMessage;
    this.rateLimitWatchdog.cancel();
    await this.executeRateLimitAutoRetry(lastUserMessage);
  }

  /**
   * Get current rate limit watchdog state (for RPC responses).
   */
  getRateLimitWatchdogState() {
    return this.rateLimitWatchdog.getState();
  }

  // ============================================================================
  // Question Handling (delegated to AskUserQuestionHandler)
  // ============================================================================

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

  /**
   * Mark any pending AskUserQuestion as orphaned and reset the session to
   * idle. Called by reapers (force-completion, rehydrate failure) so the
   * UI removes the now-unanswerable question card.
   *
   * @param telemetryReason Annotates the `question.orphaned` internalEventBus event
   *   only — the persisted `cancelReason` is hardcoded to
   *   `agent_session_terminated` (see `AskUserQuestionHandler.markQuestionOrphaned`).
   * @returns true if a question was actually orphaned, false if the session
   *   was not in `waiting_for_input`.
   */
  async markPendingQuestionOrphaned(
    telemetryReason: 'agent_session_terminated' | 'rehydrate_failed' = 'agent_session_terminated'
  ): Promise<boolean> {
    return this.askUserQuestionHandler.markQuestionOrphaned(telemetryReason);
  }

  // ============================================================================
  // Model Switching
  // ============================================================================

  async handleModelSwitch(
    newModel: string,
    newProvider: string
  ): Promise<{ success: boolean; model: string; error?: string }> {
    return this.modelSwitchHandler.switchModel(newModel, newProvider);
  }

  getCurrentModel(): CurrentModelInfo {
    return this.modelSwitchHandler.getCurrentModel();
  }

  // ============================================================================
  // SDK Runtime Config
  // ============================================================================

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

  // ============================================================================
  // Config and Metadata (delegated to SessionConfigHandler)
  // ============================================================================

  async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
    await this.sessionConfigHandler.updateConfig(configUpdates);
  }

  /**
   * Replace the entire in-memory runtime MCP-server map for this session.
   *
   * @deprecated Production code MUST NOT use this method. Prefer
   * `mergeRuntimeMcpServers` (which preserves existing entries) plus
   * `detachRuntimeMcpServer` (which removes a single named entry).
   *
   * Replace-semantics call sites silently drop concurrent attaches by other
   * subsystems (`space-agent-tools`, `db-query`, `node-agent`, …) and have
   * caused recurring "No such tool available" failures during workflow
   * execution. See `docs/research/node-agent-mcp-loss-root-cause.md` §3.
   *
   * Retained as a clearly-named escape hatch only for tests that need to
   * assert against an empty runtime map. Acceptance criterion #1 of Task #140
   * requires zero remaining production call sites.
   */
  replaceAllRuntimeMcpServers(mcpServers: Record<string, McpServerConfig>): void {
    this.session.config = {
      ...this.session.config,
      mcpServers,
    };
    this.emitMcpAttachLog('replace', Object.keys(mcpServers));
    this.syncRuntimeMcpServersToActiveQuery('replace', Object.keys(mcpServers));
  }

  /**
   * @deprecated Renamed to `replaceAllRuntimeMcpServers`. This alias remains
   * temporarily so external callers (e.g. tests, downstream consumers of
   * `AgentSession`) keep compiling while migrations land. Will be removed.
   */
  setRuntimeMcpServers(mcpServers: Record<string, McpServerConfig>): void {
    this.replaceAllRuntimeMcpServers(mcpServers);
  }

  /**
   * Merge additional runtime MCP servers into the in-memory session config.
   *
   * Unlike `replaceAllRuntimeMcpServers`, this preserves existing entries and only
   * overwrites the keys present in `additional`. Used when a cross-cutting
   * subsystem (e.g., `SpaceRuntimeService`) wants to attach a shared MCP
   * server (like `space-agent-tools`) to a session without disturbing other
   * runtime-attached servers (e.g., `task-agent`, `db-query`)
   * that may have been added by other owners.
   */
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

  /**
   * Remove a single named runtime MCP server from the in-memory session config.
   *
   * Use this alongside `mergeRuntimeMcpServers` when you need to rotate a server
   * (e.g. rebuild `node-agent` with a fresh closure for a new node activation).
   * Removing a name that is not present is a no-op.
   */
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

  private syncRuntimeMcpServersToActiveQuery(
    action: 'merge' | 'detach' | 'replace',
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

  /**
   * Emit a structured `mcp.attach` log line for runtime MCP map mutations.
   *
   * Goal: every mutation of `session.config.mcpServers` produces a single,
   * grep-able, joinable diagnostic record. When the next "tool disconnected"
   * regression surfaces, the log trail is sufficient to reconstruct exactly
   * which subsystem attached/detached/replaced what — without scattering
   * bespoke log lines at every call site.
   *
   * Joinable fields:
   *   - sessionId      — the agent session this mutation targets
   *   - taskId?        — present for task-agent sessions (from SessionContext)
   *   - spaceId?       — present for any Space-bound session
   *   - workflowRunId? — present when this looks like a workflow sub-session
   *
   * Acceptance criterion #9 of Task #140.
   */
  private emitMcpAttachLog(action: 'merge' | 'detach' | 'replace', servers: string[]): void {
    const ctx = this.session.context ?? {};
    const sessionId = this.session.id;
    // Best-effort sub-session metadata: workflow sub-session ids carry the
    // shape "space:<spaceId>:task:<taskId>:exec:<execId>". Parsing here is
    // purely diagnostic — never used for behavior.
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

  /**
   * Update only the user-managed (subprocess) MCP servers in the session config,
   * preserving all in-process (SDK-type) servers such as `node-agent`, `task-agent`,
   * `space-agent-tools`, and `db-query`.
   *
   * Call this instead of `updateConfig({ mcpServers })` from RPC handlers that handle
   * user-facing MCP configuration (config.mcp.update, config.mcp.addServer,
   * config.mcp.removeServer). Using `updateConfig` directly would replace the whole
   * `mcpServers` key, dropping runtime-injected in-process servers and causing
   * "No such tool available" failures on the next query start.
   */
  async updateUserMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.sessionConfigHandler.updateUserMcpServers(servers);
  }

  /**
   * Apply a runtime system prompt to in-memory session config only.
   * Used to inject context-specific instructions (e.g. space workflow guidance)
   * without persisting them to the database.
   */
  setRuntimeSystemPrompt(systemPrompt: SystemPromptConfig): void {
    this.session.config = {
      ...this.session.config,
      systemPrompt,
    };
  }

  /**
   * Apply a runtime model override to in-memory session config only.
   * Used by runtime-managed sessions that have a model setting independent
   * of the global default. Not persisted to the database.
   */
  setRuntimeModel(model: string): void {
    this.session.config = {
      ...this.session.config,
      model,
    };
  }

  updateMetadata(updates: Partial<Session>): void {
    this.sessionConfigHandler.updateMetadata(updates);
  }

  // ============================================================================
  // Getters
  // ============================================================================

  getProcessingState(): AgentProcessingState {
    return this.stateManager.getState();
  }

  getContextInfo(): ContextInfo | null {
    return this.contextTracker.getContextInfo();
  }

  getQueryObject(): QueryLike | null {
    return this.queryObject;
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

  /**
   * Wait until the SDK has published its `init` message and the resulting
   * `sdkSessionId` has been persisted on the in-memory `session` object.
   *
   * The sdkSessionId is what lets a future daemon restart resume the exact
   * same SDK conversation (via `~/.claude/projects/{cwd}/{sdkSessionId}.jsonl`).
   * Without it the SDK has no way to find the prior transcript and the
   * conversation is effectively lost.
   *
   * Orchestration call sites (TaskAgentManager.spawnTaskAgent, eager
   * sub-session spawn) should `await` this after `startStreamingQuery()`
   * so that the spawn contract is "session exists AND SDK has been
   * initialised" — a restart immediately after spawn can then safely
   * rehydrate.
   *
   * Resolves immediately if sdkSessionId is already set. Rejects on timeout.
   */
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

      // Listen for sdk-session update emitted by SDKMessageHandler.handleSystemMessage
      unsubscribe = this.internalEventBus.subscribe(
        'session.updated',
        (payload) => {
          if (payload.sessionId && payload.sessionId !== this.session.id) return;

          // Fast path: payload carries the new id
          const payloadId = payload.session?.sdkSessionId;
          if (typeof payloadId === 'string' && payloadId.length > 0) {
            finish(null, payloadId);
            return;
          }
          // Fallback: check the mutated session object
          if (this.session.sdkSessionId) {
            finish(null, this.session.sdkSessionId);
          }
        },
        { sessionId: this.session.id, subscriberName: 'AgentSession.waitForSdkSessionId' }
      );
      // Re-check synchronously in case the init arrived between the top
      // check and subscription wiring.
      if (this.session.sdkSessionId) {
        finish(null, this.session.sdkSessionId);
      }
    });
  }

  async getSlashCommands(): Promise<string[]> {
    return this.slashCommandManager.getSlashCommands();
  }

  async handleQueryTrigger(): Promise<{ success: boolean; messageCount: number; error?: string }> {
    return this.queryModeHandler.handleQueryTrigger();
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  async restartQuery(): Promise<void> {
    await this.lifecycleManager.restartQuery();
  }

  /**
   * Force-restart the query, preserving the SDK session if possible.
   *
   * Unlike restartQuery() which defers restart if the queue isn't running,
   * this method always stops and restarts the query immediately.
   * Preserves pending messages and attempts to resume the SDK session.
   *
   * Use case: Manual restart from UI to apply model/provider changes
   * while preserving conversation history.
   */
  async restart(): Promise<void> {
    this.rateLimitWatchdog.cancel();
    await this.lifecycleManager.restart();
  }

  // ============================================================================
  // Rewind Feature (delegated to RewindHandler)
  // ============================================================================

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

  // ============================================================================
  // QueryRunnerContext methods
  // ============================================================================

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
    return ++this._queryGeneration;
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

  async onMarkApiSuccess(): Promise<void> {
    this.errorManager.markApiSuccess();
    // Reset rate limit watchdog on successful API call
    this.rateLimitWatchdog.reset();
  }

  /**
   * Called by QueryRunner when 429 rate limit exhaustion is detected.
   * Delegates to the RateLimitWatchdog to schedule auto-retry.
   * @returns true if cooldown was scheduled, false if max retries exceeded.
   */
  async onRateLimitExhausted(
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null
  ): Promise<boolean> {
    return this.rateLimitWatchdog.scheduleRetry(errorMessage, lastUserMessage);
  }

  // ============================================================================
  // QueryLifecycleManagerContext methods
  // ============================================================================

  setCleaningUp(value: boolean): void {
    this._isCleaningUp = value;
  }

  trackAgentProcess(proc: TrackedAgentProcess): void {
    const pid = proc.pid;
    if (typeof pid !== 'number' || pid <= 0) {
      // Store no-PID promises in a durable collection so
      // updateProcessExitedPromise() includes them on every rebuild
      // (e.g. when a later numeric-PID process is tracked).
      const noPidExitPromise = new Promise<void>((resolve) => {
        proc.once('exit', () => {
          // Self-clean from the durable collection once resolved.
          const idx = this.noPidExitPromises.indexOf(noPidExitPromise);
          if (idx >= 0) this.noPidExitPromises.splice(idx, 1);
          resolve();
        });
      });
      this.noPidExitPromises.push(noPidExitPromise);
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

  /**
   * Returns exit timestamps for recently-exited agent root PIDs.
   * Used by SessionManager to preserve accurate retention windows
   * when snapshots are transferred to the evicted-root maps.
   */
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
  }): void {
    const forceDelayMs = options?.forceDelayMs ?? 2000;
    const processSnapshot = options?.processes ?? [...this.trackedAgentProcesses];
    if (processSnapshot.length === 0) return;

    this.signalTrackedAgentProcesses(processSnapshot, 'SIGTERM');
    for (const [pid, proc] of processSnapshot) {
      if (this.trackedAgentProcesses.get(pid) !== proc) continue;
      this.clearForceKillTimer(pid);
      this.scheduleForceKill(pid, proc, forceDelayMs);
    }
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
      // Ownership guard: skip stale snapshot entries where the PID no longer
      // maps to the same process object (e.g. child exited + PID reused).
      if (this.trackedAgentProcesses.get(pid) !== proc) continue;

      // Signal the entire process group (reaches tool grandchildren).
      if (process.platform !== 'win32' && pid > 0) {
        try {
          process.kill(-pid, signal);
        } catch {
          // Process group may have already exited.
        }
      }

      // Direct signal to the tracked child.
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
      // Child may have already exited.
      return false;
    }
  }

  private updateProcessExitedPromise(): void {
    const exitPromises = [
      ...this.trackedAgentProcessExitPromises.values(),
      ...this.noPidExitPromises,
    ];
    this.processExitedPromise =
      exitPromises.length > 0 ? Promise.all(exitPromises).then(() => {}) : null;
  }

  /**
   * Clear processExitedPromise and any stale no-PID exit promises.
   * Called when retry paths time out and abandon the current wait.
   * Without this, unresolved no-PID promises accumulate and block
   * future teardown waits for processes that were already abandoned.
   */
  resetProcessExitedPromise(): void {
    this.noPidExitPromises.length = 0;
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

  // ============================================================================
  // Cleanup (delegated to QueryLifecycleManager)
  // ============================================================================

  async cleanup(): Promise<void> {
    this.rateLimitWatchdog.destroy();
    await this.lifecycleManager.cleanup();
  }
}
