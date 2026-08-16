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
 *
 * ## SDK Mode
 *
 * Uses STREAMING INPUT mode - a single persistent SDK query with AsyncGenerator
 * that continuously yields messages from a queue.
 */

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
import type { Database } from '../../storage/database';
import { ErrorManager, type StructuredError } from '../error-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Logger } from '../logger';
import { SettingsManager } from '../settings-manager';

export const RECENTLY_EXITED_ROOT_PID_RETENTION_MS = 15 * 60 * 1000;

/**
 * How often the periodic orphan-reconciliation sweep runs (task #861 item 4).
 * A backstop beyond the idle + startup hooks; the reconciler is idempotent so a
 * slow cadence is fine. Aligned with the job-queue stale-reclamation window.
 */
const SESSION_RECONCILE_INTERVAL_MS = 60_000;

/**
 * No-progress window for the delivery turn stall watchdog. A healthy turn —
 * even a multi-hour agentic one — emits SDK messages (assistant output, tool
 * events, system events) continuously; the watchdog resets on EVERY incoming
 * message (and defers while a tool is outstanding, so a long build is never
 * mistaken for a stall). It fires only when there is NO activity of any kind
 * — no SDK message AND no outstanding tool — for this whole window, which is a
 * true query hang. Tunable via `HYPERNEO_DELIVERY_NO_ACTIVITY_MS`. See
 * {@link AgentSession.armDeliveryTurnStall}.
 */
const DELIVERY_TURN_NO_ACTIVITY_MS = (() => {
  const env = Number(process.env.HYPERNEO_DELIVERY_NO_ACTIVITY_MS);
  return Number.isFinite(env) && env >= 30_000 ? env : 3 * 60 * 1000;
})();

/**
 * A tracked SDK subprocess handle that does not expose a numeric PID
 * (VM/container/remote execution spawns). Kept durably so termination can
 * signal it via its own kill() — there is no PID to process.kill.
 */
interface NoPidTrackedProcess {
  proc: TrackedAgentProcess;
  exitPromise?: Promise<void>;
  forceKillTimer?: ReturnType<typeof setTimeout>;
}

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

import { isSDKResultSuccess, isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import { AcpQueryRunner } from '../acp/acp-query-runner';
import { resolveModelAlias } from '../model-service';
import { getProviderRegistry } from '../providers/factory.js';
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
import {
  BATCH_DELIVERY_MAX_CHARS,
  buildBatchedDeliveryContent,
  classifyReclaimTermination,
  type DriveTurnOutcome,
  deliverMessage,
  type FeedSteerOutcome,
  flattenDeliveryText,
  isMessageDeliveryV2Enabled,
  isRetryableErrorResultSubtype,
  isTerminalTurnError,
  MESSAGE_DELIVERY_PARK_MS,
  type MessageDeliveryAttemptObserver,
  MessageDeliveryRecoverableTurnError,
  MessageDeliveryTerminalTurnError,
  reconcileStrandedDeliveries as reconcileStrandedDeliveriesCore,
  signalDeliveryConsumed,
  throwIfDeliveryAborted,
  waitForDeliveryAbort,
  withSessionLock,
} from './message-delivery';
import { deliveryMetrics } from './message-delivery-metrics';
// Extracted components
import { MessageQueue } from './message-queue';
import { ModelSwitchHandler, type ModelSwitchHandlerContext } from './model-switch-handler';
import { ProcessingStateManager } from './processing-state-manager';
import {
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
import { SDKMessageHandler, type SDKMessageHandlerContext } from './sdk-message-handler';
import { SDKRuntimeConfig, type SDKRuntimeConfigContext } from './sdk-runtime-config';
import { SessionConfigHandler, type SessionConfigHandlerContext } from './session-config-handler';
import { SlashCommandManager, type SlashCommandManagerContext } from './slash-command-manager';

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

  /**
   * The most recent terminal SDK error for this session, captured from the
   * `session.error` broadcast. The delivery layer reads this at turn-end to
   * detect that a driven turn died on a provider error (the query-runner HANDLES
   * such errors inline — `queryPromise` resolves, it does not reject — so the
   * delivery bridge cannot see the failure any other way). Gated to "occurred
   * during this turn" by `at` vs. the turn-start timestamp, and cleared on the
   * next successful `ensureQueryStarted` (and `session.errorClear`) so a later
   * success isn't mistaken for a retryable failure. See
   * {@link driveDeliveryTurn} + docs/features/message-delivery-v2.md.
   */
  private lastTerminalError: { error: StructuredError; at: number } | null = null;

  /**
   * Stall watchdog for the in-flight delivery turn: a NO-PROGRESS timer armed
   * once the SDK consumes the kickoff, raced against the turn-end await. It
   * resets on EVERY incoming SDK message ({@link bumpDeliveryTurnActivity}) and
   * defers while a tool is outstanding ({@link outstandingToolUseIds}), so a
   * healthy multi-hour turn is never mistaken for a stall. It fires only when
   * there is no activity of any kind — no message AND no outstanding tool — for
   * {@link DELIVERY_TURN_NO_ACTIVITY_MS}, a true query hang; on fire it resets
   * the zombie query so the bridge throws a recoverable error and the job
   * retries. See {@link driveDeliveryTurn}.
   */
  private deliveryTurnStall: DeliveryTurnStallWatchdog | null = null;
  private deliveryTurnStalled = false;
  // `pendingStart` marks an observer armed before its driving attempt's query
  // started; the generation bump that starts that query retags it (see
  // incrementQueryGeneration) so the new query's first frame fences clean.
  private deliveryResponseObserver: {
    generation: number;
    observer: MessageDeliveryAttemptObserver;
    pendingStart?: boolean;
  } | null = null;

  /**
   * Outstanding `tool_use` IDs for this session (added on `sdk.toolUse.created`,
   * removed on `sdk.toolUse.consumed`). Non-empty means a tool is mid-execution,
   * so a quiet window is the tool running — NOT a stall. Cleared per turn. Used
   * only by {@link scheduleStallFire}'s defer check.
   */
  private outstandingToolUseIds = new Set<string>();

  /** Unsubscribers for the delivery terminal-error capture (freed in cleanup). */
  private readonly deliveryErrorSubs: Array<() => void> = [];
  originalEnvVars: OriginalEnvVars = {};
  processExitedPromise: Promise<void> | null = null;
  private trackedAgentProcesses = new Map<number, TrackedAgentProcess>();
  private trackedAgentProcessExitPromises = new Map<number, Promise<void>>();
  /**
   * Durable no-PID handles (VM/container/remote spawns) with their exit
   * promises and force-kill timers. Single source of truth: termination
   * signals them via their kill() (no PID to process.kill), and
   * updateProcessExitedPromise() derives the aggregate wait from them —
   * so an orphan retained across a reset still blocks later teardown
   * waits until it exits. Self-clean on exit.
   */
  private noPidAgentProcesses: NoPidTrackedProcess[] = [];
  private recentlyExitedAgentRootPids = new Map<number, number>();
  private forceKillTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // Session state
  private _isCleaningUp = false;
  private pendingResumeSessionAt: string | undefined;
  // Periodic orphan-reconciliation timer (task #861 item 4). unref'd; cleared in cleanup().
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // True once the owner's post-provisioning replay path has run — gates the
  // periodic reconciler so it won't drive pending input before runtime MCP /
  // prompt / continuation maps are attached. (task #861, Codex review.)
  private reconcilerProvisioned = false;
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

    // Capture terminal SDK errors so the delivery layer can detect a driven
    // turn that died on a recoverable/non-recoverable provider error (the
    // query-runner resolves queryPromise on handled errors, so the bridge has
    // no other signal). Cleared on successful query (re)start / errorClear.
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
    // Track outstanding tool_use IDs so the no-progress stall watchdog can tell
    // "a tool is mid-execution (quiet but active)" from "the query hung (no
    // activity)". Added on tool_use, removed on tool_result. See
    // scheduleStallFire.
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
      resolveChain: async () => {
        const gs = this.settingsManager.getGlobalSettings();
        const provider = (this.session.config.provider as string | undefined) ?? 'anthropic';
        const rawModel = this.session.config.model ?? 'sonnet';
        // Canonicalize the current model before the modelFallbackMap lookup:
        // the UI saves override keys from ModelInfo.id (canonical provider/model),
        // so an alias-configured session (e.g. `sonnet`) would otherwise miss its
        // model-specific override and silently use the global fallback list.
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
    });
    this.rateLimitWatchdog.setRetryCallback(
      async (lastUserMessage, switchTo, episodeGeneration) => {
        if (switchTo) {
          // A cooldown that was scheduled after a fallback switch re-switches
          // before re-enqueuing (rare). Goes through the same timing-safe path.
          return await this.switchAndRetryForFallback(lastUserMessage, switchTo, episodeGeneration);
        }
        // Return whether the query actually started so the watchdog only clears
        // the paused task state on a real restart (not on a failed retry).
        return await this.executeRateLimitAutoRetry(lastUserMessage, episodeGeneration);
      }
    );

    // Initialize EventSubscriptionSetup (handlers take AgentSession context directly)
    // Must be last since it needs other handlers to be initialized
    this.eventSubscriptionSetup = new EventSubscriptionSetup(this);

    // Set state manager callback - delegates to lifecycleManager
    this.stateManager.setOnIdleCallback(async () => {
      await this.lifecycleManager.executeDeferredRestartIfPending();
      // Orphan reconciler (task #861 item 4): on each idle transition, recover
      // any user message stranded in a nonterminal send_status with no active
      // durable job (the #856 shape). Fire-and-forget (NOT awaited): an idle
      // transition can fire WHILE the caller holds withSessionLock (e.g.
      // revokePendingDelivery → clearQueuedIfOwnedBy → setIdle), and the
      // reconciler's core reacquires that non-reentrant lock — awaiting it here
      // would deadlock (the RPC never returns, the lock never releases).
      // Fire-and-forget lets the callback return, the lock holder release, and
      // the reconciler then acquire the now-free lock. (Codex review, P1.)
      void this.reconcileStrandedDeliveries().catch((error) => {
        this.logger.warn('Idle reconcileStrandedDeliveries failed:', error);
      });
    });

    // Restore persisted state
    if (session.metadata?.lastContextInfo) {
      this.contextTracker.restoreFromMetadata(session.metadata.lastContextInfo);
    }
    this.stateManager.restoreFromDatabase();

    // Setup event subscriptions (moved callbacks into EventSubscriptionSetup)
    this.eventSubscriptionSetup.setup();

    if (this.runtimeOptions.autoReplayPendingMessages ?? true) {
      this.scheduleInitialPendingMessageReplay();
      // Orphan reconciler startup pass (task #861 item 4/7): settle stranded
      // deliveries now that state is restored — re-enqueue stuck 'enqueued'
      // rows and surface stale 'submitted' rows as failed. Gated on the SAME
      // autoReplayPendingMessages flag as pending replay: restored Space /
      // task-agent sessions pass false so current prompts, runtime MCP servers,
      // and tool-continuation maps are provisioned before any pending input
      // starts a query — reconciling then would race that provisioning. Those
      // owners call replayPendingMessagesForImmediateMode (which routes through
      // the durable owner) after provisioning; the idle + periodic hooks cover
      // the rest. (Codex review.)
      void this.reconcileStrandedDeliveries().catch((error) => {
        this.logger.warn('Startup reconcileStrandedDeliveries failed:', error);
      });
    }

    // Periodic orphan reconciliation (task #861 item 4): a backstop beyond the
    // idle + startup hooks, for a message that strands without an idle
    // transition (e.g. a job cancelled mid-flight leaving an enqueued row).
    // unref'd so it never keeps the daemon alive on shutdown. Idempotent. The
    // callback is gated on `reconcilerProvisioned` — restored Space/task-agent
    // sessions pass autoReplayPendingMessages=false so the owner can attach
    // runtime MCP servers, the current prompt, and continuation maps BEFORE any
    // pending input starts a query; the flag flips when the owner calls the
    // post-provisioning replay path, so the timer won't re-enqueue a stranded
    // row against a half-provisioned session. Generic/manual/immediate sessions
    // (autoReplayPendingMessages !== false) are provisioned at construction —
    // their runtime is ready immediately, and manual-mode sessions never call
    // the replay path, so they'd otherwise never enable the timer. (Codex review.)
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
    // The owner's post-provisioning readiness signal (Space/task-agent owners
    // call this AFTER attaching runtime MCP servers / prompt / continuation
    // maps). Flip the reconciler-provisioned flag HERE (before the manual /
    // waiting_for_input early-returns) so the periodic orphan reconciler can
    // safely run — it won't drive a stranded row against a half-provisioned
    // session. (task #861, Codex review.)
    this.reconcilerProvisioned = true;
    if (this.session.config.queryMode === 'manual') return;
    const restoredState = this.stateManager.getState();
    if (restoredState.status === 'waiting_for_input') return;
    // Note: rate_limit_cooldown is NOT preserved across a restart —
    // restoreFromDatabase() resets it to 'idle' — so there is no cooldown case
    // to guard here. Real flood protection on restore is the inject-path
    // parentLimited gate, not replay (which only completes in-flight tool
    // flows for an idle session).
    await this.queryModeHandler.replayPendingMessagesForImmediateMode();
  }

  async ensureQueryStarted(): Promise<void> {
    await this.lifecycleManager.ensureQueryStarted();
  }

  async startQueryAndEnqueue(
    messageId: string,
    messageContent: string | MessageContent[],
    episodeGeneration?: number
  ): Promise<void> {
    if (episodeGeneration === undefined) {
      // Genuine new user input: it supersedes any in-flight recovery episode.
      // cancel() bumps the generation so an in-flight fallback switch or
      // cooldown-retry callback aborts (its captured generation no longer
      // matches) and doesn't switch models or replay the stale message
      // alongside this new turn. It also clears the timer + episode and
      // notifies resume so a paused task is restored to in_progress for the new
      // work. (A new turn's fallback chain is rebuilt lazily in scheduleRetry
      // per-UUID, so clearing the old tried-set is correct.)
      this.rateLimitWatchdog.cancel();
    } else {
      // Internal recovery re-enqueue (same episode): clear only the timer so a
      // stale cooldown doesn't fire into the new query, WITHOUT bumping the
      // generation (which would self-abort the in-flight fallback) or clearing
      // the episode (which would cripple the per-episode tried-set).
      this.rateLimitWatchdog.clearPendingCooldown();
    }
    await this.lifecycleManager.startQueryAndEnqueue(messageId, messageContent, episodeGeneration);
  }

  removeQueuedMessage(messageId: string): boolean {
    return this.messageQueue.remove(messageId);
  }

  /**
   * Revoke one not-yet-delivered durable message under the same per-session
   * ownership lock used by transport admission. This linearizes remove/defer
   * against the handler's final validation + synchronous queue admission.
   */
  async revokePendingDelivery(
    messageDbId: string,
    mode: 'remove' | 'defer'
  ): Promise<
    { changed: false } | { changed: true; dbId: string; uuid: string; removedFromMemory: boolean }
  > {
    return withSessionLock(this.session.id, async () => {
      // Remove accepts BOTH pending states: the frontend Remove button sends
      // the same RPC for current-turn (enqueued) and next-turn (deferred)
      // messages — hardcoding 'enqueued' made deferred removal a silent no-op
      // that reappeared on refresh. cancelDelivery is a safe no-op when the
      // deferred row has no active job. See Codex (#3744105283).
      const result =
        mode === 'remove'
          ? this.db.deletePendingUserMessage(this.session.id, messageDbId)
          : this.db.deferEnqueuedUserMessage(this.session.id, messageDbId);
      if (!result?.uuid) return { changed: false as const };

      this.db.getJobQueueRepo().cancelDelivery(this.session.id, result.uuid);
      const removedFromMemory = this.messageQueue.remove(result.uuid);
      await this.stateManager.clearQueuedIfOwnedBy(result.uuid);
      // Task #862 (review P2): both `deferEnqueuedUserMessage` (enqueued →
      // deferred) and `cancelDelivery` (deletes the active job) write through
      // the raw db with no notify, so the widened feed would keep showing
      // "retrying" (deliveryRetry stays 1) after Move to Next. Notify both
      // tables so `sdk_messages` (the new deferred status) and `job_queue` (the
      // gone active job) re-evaluate.
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

  // ============================================================================
  // Interrupt and Reset
  // ============================================================================

  async handleInterrupt(opts?: {
    preserveDeliveryJobs?: boolean;
    skipDeferredReplay?: boolean;
  }): Promise<void> {
    // Cancel any rate-limit recovery so an in-flight fallback switch / armed
    // cooldown timer can't switch the model or replay the stale message after
    // the user explicitly stopped the turn.
    this.rateLimitWatchdog.cancel();

    // The durable-delivery cancel lives in InterruptHandler.handleInterrupt —
    // the single chokepoint every interrupt path reaches (client.interrupt RPC
    // → agent.interruptRequest subscriber → the raw handler, and the space
    // paths via this wrapper). See Codex (#3744105273). `preserveDeliveryJobs`
    // is forwarded for restart-bound shutdown stops; `skipDeferredReplay`
    // for teardown-bound stops that must not drive the deferred queue.
    await this.interruptHandler.handleInterrupt(opts);
  }

  /**
   * Whether an interrupt is currently in flight for this session. Distinguishes
   * a live `interrupted` processing state from a stale persisted one (e.g. a
   * daemon crash between setInterrupted and setIdle leaves the persisted state
   * `interrupted` with no interrupt operation remaining to resolve it).
   */
  isInterruptInProgress(): boolean {
    return this.interruptHandler.getInterruptPromise() !== null;
  }

  /**
   * Normalize a stale persisted `interrupted` processing state: no interrupt
   * is in flight (e.g. the daemon crashed between setInterrupted and
   * setIdle), so nothing remains to transition the session to idle. Flips
   * the state to idle so a defer-mode delivery delivers now instead of being
   * persisted against a busy state that never resolves to a replay.
   */
  async normalizeStaleInterruptedState(): Promise<void> {
    if (this.getProcessingState().status !== 'interrupted') return;
    if (this.isInterruptInProgress()) return;
    await this.stateManager.setIdle();
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

  /**
   * Reset the SDK model context (the "/clear" equivalent) while preserving
   * NeoKai's own session identity and message history.
   *
   * Used by `resetContextPerTurn` agent slots to give a node "fresh eyes" at the
   * start of each handoff: issues the SDK's `/clear` command in-stream. The SDK
   * rotates to a brand-new conversation (a fresh `session_id`, captured by
   * `SDKMessageHandler.handleSystemInit`) WITHOUT restarting the query, so the
   * model's in-memory context is empty on the next turn. NeoKai's `sdk_messages`
   * rows (keyed by THIS session id) are untouched, so the UI keeps one
   * continuous thread across clears.
   *
   * The `/clear` is enqueued as an internal control message ahead of the
   * triggering handoff (which the caller enqueues immediately after this
   * returns). The SDK's pull-based streaming-input generator serializes them:
   * it will not pull the handoff until the `/clear` turn completes, so the
   * handoff always runs in the fresh conversation. Issuing `/clear` in-stream —
   * rather than stopping and restarting the query — means there is no
   * generation-bump idle-race to suppress and no provider-env restore to patch.
   *
   * The SDK rotates the resume pointer (`sdkSessionId`) itself on `/clear`; we
   * capture the new id from the post-`/clear` init. The prior id is appended to
   * `metadata.pastSdkSessionIds` (capped) as an audit trace of the rotations.
   *
   * SDK-only: `/clear` is a Claude-Code command. This is a no-op for ACP (codex)
   * providers — callers gate on `sdkSessionId`, so `resetContextPerTurn` on a
   * codex slot clears nothing until ACP grows an equivalent.
   */
  async clearConversationContext(): Promise<void> {
    // Record the soon-to-be-rotated sdk session id (capped audit trace) and
    // roll the prior conversation's cost into costBaseline before the rotation.
    // The result handler's restart-detection (sdkCost < lastSdkCost) is
    // unreliable across a /clear — the post-clear cost can be >= the prior — so
    // we roll deterministically and zero lastSdkCost, letting the fresh
    // session's cost accumulate on top of the rolled baseline.
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

    // Ensure the persistent streaming query is pulling, then issue /clear as an
    // internal control message (not persisted to the DB/client — it is a
    // command, not a user message). The SDK processes it as a turn: it rotates
    // to a fresh session (handleSystemInit captures the new sdkSessionId) and
    // only then pulls the next queued message (the caller's handoff).
    await this.lifecycleManager.ensureQueryStarted();
    // The /clear turn never sets processing (the generator skips setProcessing
    // for internal messages), so its result would otherwise publish a spurious
    // idle→idle and fire the one-shot node-agent completion callback before the
    // cleared handoff is reviewed. Arm idle suppression for that result; the
    // handoff's own genuine processing→idle is what completes the turn.
    this.messageHandler.suppressIdleForNextResult();
    try {
      await this.messageQueue.enqueue('/clear', true);
    } catch (err) {
      // /clear was never consumed (no turn ran) — release the suppression so the
      // handoff's result still completes the turn.
      this.messageHandler.clearIdleSuppression();
      throw err;
    }
  }

  /**
   * Build the next capped `metadata.pastSdkSessionIds` trace by appending the
   * current sdkSessionId (the one a /clear is about to rotate away from).
   * Returns undefined when there is nothing to record — no current id, or it is
   * already the most recent entry (a repeated clear with no rotation between) —
   * so callers can skip a no-op metadata write.
   */
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
    entry: FallbackModelEntry,
    episodeGeneration: number
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

      // A cancel/reset/interrupt during the teardown await bumps the episode
      // generation. Don't switch the provider or re-enqueue — the new episode
      // (or the interrupt's own teardown) owns the session now. The watchdog's
      // post-switch guard also catches this, but checking before the side effect
      // prevents the config switch from committing at all.
      if (this.rateLimitWatchdog.isSuperseded(episodeGeneration)) {
        this.logger.info('Fallback switch aborted after teardown (episode superseded).');
        return false;
      }

      // (1b) Persisted sessions created before explicit provider IDs were
      // stored have no `session.config.provider`; QueryRunner treats a missing
      // provider as Anthropic, and so does the fallback chain resolver. But
      // ModelSwitchHandler rejects immediately when provider is absent, which
      // would fail every configured fallback for a legacy session. Backfill the
      // inferred Anthropic provider before attempting the switch.
      if (!this.session.config.provider) {
        this.session.config.provider = 'anthropic';
        this.db.updateSession(this.session.id, {
          config: { model: this.session.config.model, provider: 'anthropic' } as SessionConfig,
        });
      }

      // (2) Switch model. The query is inactive now → config-only branch, no restart.
      const result = await this.handleModelSwitch(entry.model, entry.provider);
      // A cancel/reset during the model switch's await must not re-enqueue the
      // stale turn onto the new episode. (The config may have already flipped,
      // but the consumer message is what replays the stopped turn.)
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

      // (3) Re-enqueue with the new model and start a fresh query. A switch is
      // only "successful" if the retry query actually started — a swallowed
      // startQueryAndEnqueue failure must report false so the watchdog advances
      // the chain rather than leaving the message idle with no recovery pending.
      return await this.executeRateLimitAutoRetry(lastUserMessage, episodeGeneration);
    } catch (err) {
      this.logger.error('Fallback switch-and-retry failed:', err);
      await this.stateManager.setIdle();
      return false;
    }
  }

  /**
   * Resolve a (provider, model) to its canonical model ID, falling back to the
   * raw ID on any error. Used to canonicalize the current model and fallback
   * candidates so an alias and its canonical entry are recognized as the same
   * (tried-set dedup + modelFallbackMap lookup).
   */
  private async resolveModelIdOrDefault(provider: string, model: string): Promise<string> {
    try {
      return await resolveModelAlias(model, 'global', provider);
    } catch {
      return model;
    }
  }

  /**
   * Execute auto-retry after rate limit cooldown.
   * Re-enqueues the last user message and starts a new query.
   *
   * @returns true if the query was (re)started successfully; false if it threw
   *   (so the caller — the fallback switch path — can treat it as a failed
   *   switch and advance the chain / schedule a cooldown instead of stalling).
   */
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
      // Ensure the session is idle before starting a new query. Suppress the
      // delivery-waiter drain: this idle is a retry mid-point (the query is
      // re-started below via startQueryAndEnqueue), not a terminal turn-end —
      // draining here would complete the durable job while the prompt is still
      // being retried, freeing the active-turn slot for a competing turn.
      await this.stateManager.setIdle({ suppressDeliveryWaiters: true });

      // A cancel/reset/interrupt during the setIdle await (or the preceding
      // switch teardown) bumps the episode generation. Don't re-enqueue the stale
      // turn — the new episode / interrupt owns the session now. (Opt-in via the
      // recovery call site, NOT in the shared startQueryAndEnqueue, so genuine
      // new user input is unaffected.)
      if (
        episodeGeneration !== undefined &&
        this.rateLimitWatchdog.isSuperseded(episodeGeneration)
      ) {
        this.logger.info('Rate limit auto-retry aborted before re-enqueue (episode superseded).');
        // The durable turn this retry would have re-driven is abandoned — release
        // its turn-end waiter so the job doesn't hang `processing`. Scope the
        // release to this episode's generation so a NEWER turn's waiter (armed
        // after the cancel/reset bumped the generation) is left untouched.
        this.stateManager.releaseIdleWaiters(episodeGeneration);
        return false;
      }

      // Re-enqueue the last user message and start the query. Pass the episode
      // generation so the lifecycle can re-check it inside startQueryAndEnqueue
      // (after its internal awaits) and abort the enqueue if a cancel/reset
      // superseded the episode during query startup.
      await this.startQueryAndEnqueue(
        lastUserMessage.uuid,
        lastUserMessage.content,
        episodeGeneration
      );
      return true;
    } catch (error) {
      this.logger.error('Rate limit auto-retry failed:', error);
      // Suppress the drain: returning false makes the watchdog schedule another
      // startup attempt for this same episode, so the old prompt is still slated
      // for replay — draining here would complete the durable job and free the
      // active-turn slot while the retry continues, letting a new message admit
      // as a competing turn. The waiter is released when the episode is actually
      // abandoned (supersession → releaseIdleWaiters(gen) above) or superseded by
      // a successful retry (terminal idle). (Codex P1.)
      await this.stateManager.setIdle({ suppressDeliveryWaiters: true });
      return false;
    }
  }

  /**
   * Cancel a pending rate limit auto-retry.
   * Called when the user explicitly cancels or sends a new message.
   */
  cancelRateLimitRetry(): void {
    // The user explicitly stopped the auto-retry. Do NOT resume the task:
    // cancelling must leave the workflow paused (rate/usage-limited) rather than
    // restoring it to in_progress — which, followed by the idle transition
    // below, the workflow completion listener could misread as successful node
    // completion and advance downstream past a failed turn.
    this.rateLimitWatchdog.cancel(false);
    // Transition from rate_limit_cooldown to idle
    if (this.stateManager.getState().status === 'rate_limit_cooldown') {
      void this.stateManager.setIdle();
    }
  }

  /**
   * Immediately retry after a rate limit (bypassing the cooldown timer).
   * Called when the user clicks "Retry Now" in the UI, or by
   * `resumeRateLimitedSubSession` for a manual Resume.
   *
   * Delegates to the watchdog's `retryNow()`, which gates the resume on the
   * retry actually starting (rescheduling a cooldown on failure) — so a manual
   * retry that can't start the query does NOT restore the task to in_progress
   * with no recovery pending.
   */
  async retryNowAfterRateLimit(): Promise<boolean> {
    const fired = this.rateLimitWatchdog.retryNow();
    if (!fired) {
      this.logger.warn('retryNowAfterRateLimit: no cooldown retry is pending.');
    }
    return fired;
  }

  /**
   * True only after the cooldown banner's Cancel. Used by the manual Resume
   * path to detect a parked, banner-cancelled session whose consumed turn must
   * be re-spawned — narrower than the raw pause flag, which is also true while
   * an auto-retry is actively starting.
   */
  isRateLimitBannerCancelled(): boolean {
    return this.rateLimitWatchdog.isRateLimitBannerCancelled();
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

  /**
   * Recompute the effective MCP-server set for this session and push it to the
   * live SDK query (if any) via `setMcpServers`.
   *
   * Triggered by `SessionManager` when the app-level MCP registry or skills
   * change (`mcp.registry.changed` / `skills.changed`), so an enable/disable/
   * update/remove takes effect on active sessions without waiting for the next
   * turn's option rebuild. The effective set is computed from the registry +
   * `mcp_enablement` overrides + skills, and runtime-injected servers
   * (`space-agent-tools`, `node-agent`, …) in `session.config.mcpServers` are
   * preserved because they win the merge on name collision. No-op when there
   * is no live query (idle sessions pick the change up on their next turn).
   *
   * ACP-backed sessions are skipped with a diagnostic: `AcpQueryAdapter`
   * cannot live-update MCP tools (its `setMcpServers` is a no-op that reports
   * empty success), so registry/skill changes for them apply on the next query
   * recreation rather than via this path. This avoids logging a misleading
   * "success" for a change that did not take effect.
   */
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
    const next = ++this._queryGeneration;
    // A delivery observer armed with `pendingStart` belongs to the query THIS
    // bump is starting — retag it so the new query's first frame passes the
    // generation fence instead of being dropped against the stale pre-start
    // generation. Cleared once the driving attempt's startup returns.
    if (this.deliveryResponseObserver?.pendingStart) {
      this.deliveryResponseObserver.generation = next;
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
    // Reset the rate-limit watchdog episode only on a substantive successful
    // turn (a `result` message with subtype `success`), NOT on every SDK frame.
    // Initialization and error-result frames fire onMarkApiSuccess too; resetting
    // on those would clear the fallback episode mid-recovery (the tried-entry set
    // + resolved chain), causing an A/B fallback loop on repeated 429s.
    if (isSDKResultSuccess(message)) {
      this.rateLimitWatchdog.reset();
    }
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

  /**
   * QueryLifecycleManagerContext: rate-limit episode supersession check. The
   * lifecycle re-checks this inside `startQueryAndEnqueue` (after its internal
   * awaits) so a recovery re-enqueue that a cancel/reset superseded mid-startup
   * doesn't commit the stale message into the replacement query.
   */
  isRateLimitEpisodeSuperseded(generation: number): boolean {
    return this.rateLimitWatchdog.isSuperseded(generation);
  }

  // ============================================================================
  // Message delivery v2 — turn/steer driving bridge
  // ============================================================================

  /**
   * Drive a new SDK turn for a durable message_delivery job (v2). Ensures the
   * query is started (parking if blocked on sdk_resume_choice), feeds the
   * kickoff to the transport, then awaits the turn's terminal outcome (the
   * runQuery promise settling). The job stays `processing` across the await, so
   * a crash before the turn ends is redelivered by reclaimStale.
   *
   * On a turn that ENDS IN AN ERROR: the QueryRunner handles provider errors
   * inline (it classifies + displays them, publishes `session.error`, and
   * resolves `queryPromise`), so the bridge cannot see the failure from the
   * promise. Instead it reads the terminal error captured from `session.error`
   * (gated to this turn). A RECOVERABLE error (e.g. a transient provider 5xx /
   * "unexpected error", category SYSTEM) THROWS so the job's `fail`/backoff
   * retries the turn — each retry re-drives via `ensureQueryStarted`, which
   * restarts the query (the "send a new message and it works" recovery, now
   * automatic). A NON-recoverable error (auth/permission/quota) throws a
   * `MessageDeliveryTerminalTurnError` so the job dead-letters immediately. The
   * durable turn-end marker is cleared before throwing so a retry's reclaim
   * re-drives instead of short-circuiting on `turn_terminated`. The job's
   * backoff composes with the QueryRunner's own bounded retry; the total is
   * bounded by `maxRetries`.
   */
  async driveDeliveryTurn(
    messageUuid: string,
    content: string | MessageContent[],
    _parentToolUseId?: string | null,
    alreadyConsumed = false,
    claimGuard?: () => boolean,
    /**
     * Batched queue flush: the UUIDs whose content was folded into `content`.
     * Flipped to `consumed` (and their consumption waiters signaled) together
     * with the kickoff. `messageUuid` (the kickoff) may be a member itself —
     * it is skipped in the member loop.
     */
    batchUuids?: string[],
    signal?: AbortSignal,
    observer?: MessageDeliveryAttemptObserver
  ): Promise<DriveTurnOutcome> {
    // Timestamp gates the terminal-error read to "fired during THIS turn" — a
    // stale error from a prior turn must not turn a clean turn into a retry.
    const turnStartedAt = Date.now();
    // Delivery observability: entry snapshot of the session's queue/process
    // state. When a 0-message startup timeout is diagnosed later, this line
    // shows whether an orphaned process or a stuck queue predated the attempt.
    this.logger.debug(
      `delivery-turn: driving (uuid=${messageUuid} alreadyConsumed=${alreadyConsumed} ` +
        `queueRunning=${this.messageQueue.isRunning()} queueSize=${this.messageQueue.size()} ` +
        `trackedPids=[${this.snapshotTrackedAgentProcesses()
          .map(([pid]) => pid)
          .join(',')}] sdkSessionId=${this.session.sdkSessionId ?? 'none'})`
    );
    // Brief critical section (per-session lock): start the query + feed the
    // kickoff so it is the FIRST message the generator yields (a steer grabbing
    // the lock next can't jump ahead). The lock also serializes ensureQueryStarted
    // against a concurrent steer's state-check. Released BEFORE the long turn
    // await below — holding it across the turn would serialize mid-turn steering
    // (the feature's whole point). See message-delivery-v2.md §8 + Codex review.
    // Waiter-owned turn-end marker: fire on ANY release path (terminal idle
    // drain, direct releaseIdleWaiters from restart/reset/answer-reinjection
    // failures, or the waiter's cancel) — the kickoff UUID is the durable
    // turn owner, so it isn't corrupted by a steer overwriting the processing
    // messageId or waiting_for_input dropping it. Gated on the message having
    // been CONSUMED and the job still being `processing` (a graceful-shutdown
    // requeue, or a pre-consumption transient idle, records nothing). See
    // Codex (PR #2463, P2). Hoisted so the grace re-arm below (outside the
    // lock) can re-arm the waiter with the identical callback.
    const recordTurnEndMarker = (): void => {
      try {
        // Scope completion to the durable delivery UUID, not this transient
        // claim. A lease handoff can invalidate the predecessor claim before a
        // result-less terminal idle fires; that genuine completion still belongs
        // to the same consumed message and must survive until the replacement
        // handler observes it. The processing+UUID+consumed checks below prevent
        // an old waiter from marking a different or already-settled turn.
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
        // Validate the persisted lifecycle barrier BEFORE starting/restarting the
        // provider. Archive may flip after the handler's initial guard; checking
        // only after ensureQueryStarted races teardown. Reclaimed consumed turns
        // must validate too, while accepting their consumed ownership state.
        if (!this.messageDeliveryValid(messageUuid, alreadyConsumed)) {
          return { kind: 'aborted' as const };
        }
        // Re-fence the lease before the (async) provider startup so a reclaim
        // during the lock wait can't waste a subprocess start. See Codex
        // (#3744886834).
        if (claimGuard && !claimGuard()) {
          return { kind: 'aborted' as const };
        }
        // A re-claimed consumed turn whose turn already ended has nothing to
        // resume — but only an ended-and-SUCCEEDED turn is safe to complete
        // silently (see reclaimTurnAlreadySucceeded). A bare delivery_turn_end
        // marker (the turn ended via a result-less path) is cleared and re-driven
        // so the producedResult/stall-retry path decides; this check still runs
        // BEFORE provider startup so a SUCCESS-terminated reclaim does not start a
        // fresh query that would idle waiting for input forever. See Codex
        // (PR #2463, P1/P2) + task #946 (PR #2471 review r3772035811).
        if (alreadyConsumed && this.reclaimTurnAlreadySucceeded(messageUuid)) {
          return { kind: 'turn_terminated' as const };
        }
        // Arm first-response observability BEFORE ensureQueryStarted: the
        // startup path launches the streaming query before its await resolves,
        // so an init/history/model frame can reach SDKMessageHandler while this
        // critical section is still settling. `pendingStart` lets
        // incrementQueryGeneration retag this record with the new query's
        // generation at the bump, so the first frame of OUR query fences clean
        // instead of being dropped by the stale pre-start generation. Cleared
        // once startup returns (a resume of an already-running query never
        // bumps); disarmed on the in-lock abort exits below; the driving path
        // owns it until the outer finally clears it by identity. (Codex P2.)
        const armedObserver = observer
          ? { generation: this.getQueryGeneration(), observer, pendingStart: true }
          : null;
        if (armedObserver) this.deliveryResponseObserver = armedObserver;
        const disarmObserver = (): void => {
          if (armedObserver && this.deliveryResponseObserver === armedObserver) {
            this.deliveryResponseObserver = null;
          }
        };
        const ensureStartedAt = Date.now();
        const queryStartResult = await this.lifecycleManager.ensureQueryStarted(signal);
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
        // Re-check termination AFTER startup, immediately before arming the
        // turn-end waiter — the two statements are adjacent (no await between), so
        // a turn that terminates in the check→arm window cannot be missed: if it
        // ended before the check, we abort here (on success) or clear+re-drive
        // (bare marker); if it ends after the waiter is armed, the waiter resolves
        // it. Without this, a live-but-stale consumed turn that finishes during
        // ensureQueryStarted's await would leak a query waiting for input and hold
        // the active-turn slot forever. See Codex (PR #2463, P2) + task #946.
        if (alreadyConsumed && this.reclaimTurnAlreadySucceeded(messageUuid)) {
          disarmObserver();
          return { kind: 'turn_terminated' as const };
        }
        // Arm the turn-end wait AFTER ensureQueryStarted: ensureQueryStarted awaits
        // a preceding interrupt's completion, and that interrupt's terminal
        // setIdle() fires BEFORE the await resolves — arming earlier would let it
        // resolve this turn's waiter for a turn that hasn't started yet. Don't
        // short-circuit on a current isIdle(): a reclaimed consumed turn is
        // restored as idle and the streaming query doesn't leave idle until input
        // is observed, so treating that pre-input idle as terminal would complete
        // the durable job while history replay is still running.
        // Tag the waiter with the current rate-limit episode generation so a
        // narrowly-scoped release (a superseded rate-limit retry calling
        // releaseIdleWaiters(episodeGeneration)) resolves only this turn's waiter
        // — not a newer turn's waiter armed after a cancel()/reset() bumped the
        // generation. The generation here equals the one scheduleRetry later
        // captures as episodeGeneration (its own supersession guard keeps the
        // generation stable at this value through the 429'd turn's life).
        const turnEnd = this.stateManager.waitForIdleTransition(
          this.rateLimitWatchdog.getGeneration(),
          recordTurnEndMarker
        );
        // Feed the kickoff (resolves on onSent = the SDK consumed it) UNLESS a
        // prior attempt already did (alreadyConsumed = reclaim after a crash): the
        // SDK resume-from-history already holds a consumed kickoff, so re-feeding
        // would duplicate the prompt. History drives the turn; we only ensure the
        // query is running. See Codex (#2592). Durable so a yielded-but-unresumed
        // kickoff does not TTL-out into a duplicate re-feed (#3742616720).
        let acknowledgment: Promise<void> | null = null;
        let admittedBatchUuids: string[] | undefined;
        let feedContent: string | MessageContent[] = content;
        if (!alreadyConsumed) {
          // Re-fence the lease AGAIN right before admission: ensureQueryStarted
          // awaits provider startup, so the event loop can suspend past the stale
          // threshold and a resumed processor can reclaim the row with a new token.
          // Without this recheck both attempts would admit the same kickoff. See
          // Codex (#3744971818).
          if (claimGuard && !claimGuard()) {
            turnEnd.cancel();
            disarmObserver();
            return { kind: 'aborted' as const };
          }
          // Batched queue flush: revalidate every member + rebuild the prompt
          // from the durable rows UNDER THIS LOCK — a member deleted or
          // user-deferred between the handler's snapshot and the feed must not
          // reach the provider, and the combined prompt must respect the
          // BATCH_DELIVERY_MAX_CHARS budget. See rebuildBatchDeliveryContent.
          if (batchUuids && batchUuids.length > 1) {
            const rebuilt = this.rebuildBatchDeliveryContent(messageUuid, content, batchUuids);
            feedContent = rebuilt.content;
            admittedBatchUuids = rebuilt.admittedUuids;
            // Persist the ADMITTED set back into the job payload: every payload
            // consumer (ACP acceptance consume, dead-letter settlement,
            // batch-aware active lookups) must see exactly what was fed, so
            // dropped tails are neither marked consumed, nor failed on
            // dead-letter, nor shielded from reconciler redelivery. Narrowing
            // is REQUIRED before feeding — never admit a reduced prompt against
            // a superset payload (ACP acceptance / dead-letter would then
            // settle rows that were never sent). A transient persistence
            // failure throws recoverable so the job retries the narrowing+feed;
            // a row that no longer matches (cancelled claim) aborts.
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
            // Freeze the admitted members as in-flight (enqueued → submitted)
            // BEFORE the admission places their text inside the kickoff-keyed
            // combined prompt. Revoke/defer only mutate enqueued/deferred rows,
            // so past this point a member's text can no longer be deleted from
            // a prompt the transport is about to receive — without this, the
            // admission→provider window lets the queue UI "remove" text that
            // still executes. Serialized with revoke by this session lock.
            const memberUuids = (admittedBatchUuids ?? []).filter((uuid) => uuid !== messageUuid);
            if (memberUuids.length > 0) {
              this.markDeliveryBatchSubmitted(memberUuids);
            }
          }
          acknowledgment = this.messageQueue.admitWithId(messageUuid, feedContent, false, {
            durable: true,
          });
        }
        return {
          kind: 'driving' as const,
          queryPromise,
          turnEnd,
          acknowledgment,
          admittedBatchUuids,
          generation,
          responseObserver: armedObserver,
        };
      },
      signal
    );
    if (started.kind === 'blocked') {
      // Mirror the legacy startQueryAndEnqueue path: report the session as
      // queued while it waits on sdk_resume_choice, so later explicit deferrals
      // are honored (isAgentBusy) and the UI shows blocked-state controls
      // instead of idle. See Codex (#2599).
      this.logger.warn(
        `delivery-turn: blocked on sdk_resume_choice (uuid=${messageUuid}); parking job`
      );
      await this.stateManager.setQueued(messageUuid);
      return { outcome: 'blocked', retryAt: Date.now() + MESSAGE_DELIVERY_PARK_MS };
    }
    if (started.kind === 'turn_terminated') {
      // Nothing to resume — the handler completes the job, freeing the
      // active-turn slot so the next steer promotes into a real turn.
      return { outcome: 'turn_terminated' };
    }
    if (started.kind === 'aborted') {
      return { outcome: 'aborted' };
    }
    // Long awaits OUTSIDE the lock — ownership mutations and mid-turn steers can
    // proceed while the provider acknowledges the kickoff and runs the turn.
    // Complete at TURN-END (the idle transition). queryPromise is raced only as
    // a safety net for a query that closes without an idle (e.g. a hard crash);
    // in streaming-input mode queryPromise never resolves at turn-end, so
    // turnEnd wins and the job completes promptly when the SDK finishes the turn.
    this.deliveryTurnStalled = false;
    this.outstandingToolUseIds.clear();
    // Stall watchdog placeholder; armed once we begin awaiting the turn (below).
    let stallPromise: Promise<void> = new Promise<void>(() => {});
    // The turn-end waiter the turn await races (possibly re-armed by the
    // spurious-fire grace below); cancelled in the finally.
    let activeTurnEnd = started.turnEnd;
    // Response observability applies to EVERY driving attempt — including an
    // alreadyConsumed reclaim, whose `acknowledgment` is null (no fresh feed
    // below) but which still starts a query whose first SDK response the
    // lifecycle log must see. Armed inside the session lock (see above); this
    // local reference backs the identity-checked clear in the finally.
    const responseObserver = started.responseObserver;
    try {
      // An alreadyConsumed reclaim skips the feed (admitWithId not called), so
      // `started.acknowledgment` is null — `await null` resolves immediately.
      // The feed + consumed-flip + waiter signal must fire ONLY for a genuine
      // handoff; a consumed-reclaim that re-drives from history must NOT be
      // counted as a fresh feed (it would falsely inflate feedsObserved + read
      // as a ground-truth duplicate, and record a residual sample for a handoff
      // that never occurred). (Codex review.)
      if (started.acknowledgment) {
        const aborted = waitForDeliveryAbort(signal);
        try {
          await Promise.race([started.acknowledgment, aborted.promise]);
        } catch (error) {
          if (signal?.aborted) {
            // Revocation wins only before provider yield. Once remove() returns
            // false, the provider owns the admission; finish its bookkeeping so
            // a replacement observes consumed/submitted and never re-feeds it.
            if (this.messageQueue.remove(messageUuid)) throw error;
            await started.acknowledgment;
          } else {
            throw error;
          }
        } finally {
          aborted.cancel();
        }
        // Delivery observability: onSent elapsed measures spawn → kickoff-write.
        // A long window here (approaching STARTUP_TIMEOUT_MS) is the feed
        // starvation that produces 0-message startup timeouts.
        this.logger.debug(
          `delivery-turn: kickoff consumed by SDK ` +
            `(${Date.now() - turnStartedAt}ms since turn start, uuid=${messageUuid})`
        );
        // onSent fired → the prompt reached the SDK / subprocess (the ACTUAL
        // handoff). Record the feed here, not at admission: admitWithId only
        // places the row in the in-memory queue, so a provider-startup stall,
        // queue interrupt, or admission timeout before the generator yields is
        // NOT a handoff and must not be counted as one. (Codex review.)
        deliveryMetrics.recordFeed(messageUuid);
        observer?.reportStage('sdk_admitted', { generation: started.generation });
        // For the Claude SDK, onSent is the consume signal — flip send_status →
        // 'consumed' SYNCHRONOUSLY (item 12) so reclaimStale almost always sees
        // 'consumed' and skips the re-feed, and signal delivery waiters (LTA /
        // task-agent confirm their source only after genuine consumption). ACP
        // is EXCLUDED: its onSent fires at submission; the real consume boundary
        // is acceptance (markMessageAccepted). (Codex.)
        if (this.session.config.provider !== 'acp') {
          const consumeSignalMs = Date.now();
          // Batched queue flush: the kickoff's prompt folded the admitted
          // members in — flip them ATOMICALLY with the kickoff (see
          // markDeliveryBatchConsumed) so a crash between flips can't leave
          // members `enqueued` under a consumed kickoff (the reconciler would
          // re-deliver them individually, repeating executed prompts).
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
      // Arm the stall watchdog now that the kickoff is consumed (or this is a
      // consumed reclaim): a live-but-silent turn (no result, no error) would
      // otherwise pin the job via the lease heartbeat forever. Raced against the
      // turn-end await; cleared in `finally`.
      throwIfDeliveryAborted(signal);
      stallPromise = this.armDeliveryTurnStall(signal, claimGuard);
      // Spurious-fire grace: a turn-end transition landing within milliseconds
      // of a FRESH kickoff admission cannot be THIS turn's end — a provider
      // roundtrip takes longer than that — it is the PREVIOUS turn's teardown
      // (its terminal idle release / deferred waiter drain) arriving just after
      // this attempt armed its waiter. Failing there reopens the row and
      // re-feeds a prompt the still-live query is already answering; the
      // duplicate feed then sits dead until the stall watchdog (observed as the
      // deterministic steer-after-turn-end hang in the features-b online suite).
      // Discriminators: this attempt fed the kickoff (alreadyConsumed reclaims
      // resolve their ended turns via the pre-arm turn_terminated check), no
      // terminal result for THIS message yet, and the query promise still
      // pending (a genuinely-ended turn's query has closed, or a legitimately
      // fast turn already has its result row). Re-arm and keep waiting;
      // bounded to two re-arms. (PR #2499 CI trace.)
      const SPURIOUS_TURN_END_GRACE_MS = 250;
      const freshFeed = !!started.acknowledgment;
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
        // A success OR error terminal result for this message means the turn
        // genuinely ended (fast) — hasTerminalResultAfter only matches success,
        // and an error-result turn must fall through to the post-race terminal
        // classification, not wait out the stall watchdog. (Codex P2.)
        const turnResultRepo = this.db.getSDKMessageRepo();
        const hasAnyTerminalResult =
          !!turnResultRepo?.hasTerminalResultAfter(this.session.id, messageUuid) ||
          !!turnResultRepo?.getErrorTerminalResultSubtypeAfter(this.session.id, messageUuid);
        const spuriousFire =
          freshFeed &&
          turnEndFired &&
          !queryEnded &&
          Date.now() - raceArmedAt <= SPURIOUS_TURN_END_GRACE_MS &&
          graceRearms < 2 &&
          !hasAnyTerminalResult;
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
      // Cancel the waiter if it didn't win the race (e.g. queryPromise resolved
      // on query-close, or acknowledgment rejected) so it isn't left in the map.
      activeTurnEnd.cancel();
      this.clearDeliveryTurnStall();
      if (responseObserver && this.deliveryResponseObserver === responseObserver) {
        this.deliveryResponseObserver = null;
      }
    }
    // The turn ended (or the stall watchdog fired). Determine whether it
    // actually produced output: a terminal `result` row after consumption is the
    // "processed" signal. If one exists, the turn SUCCEEDED — return completed
    // even if a `session.error` happened to fire during the window (it came
    // from an unrelated subsystem; this avoids a false-positive retry). If NOT,
    // the turn failed to produce a response — clear the turn-end marker (so a
    // retry's reclaim re-drives instead of short-circuiting on `turn_terminated`)
    // and throw so the job retries (recoverable error OR stall) or dead-letters
    // (non-recoverable). See message-delivery-v2.md.
    const producedResult = !!this.db
      .getSDKMessageRepo()
      ?.hasTerminalResultAfter(this.session.id, messageUuid);
    if (!producedResult) {
      const turnError = this.consumeTerminalTurnError(turnStartedAt);
      this.db.getSDKMessageRepo()?.clearDeliveryTurnEnd(this.session.id, messageUuid);
      // The SDK persists terminal error results (error_max_budget_usd, …)
      // WITHOUT emitting session.error, so a turnError-null no-result can still
      // be a classified failure: consult the persisted error subtype and treat
      // non-retryable subtypes (cost/structured-output exhaustion) as terminal —
      // retrying those repeats spend for a deterministic limit. Retryable
      // subtypes (error_during_execution / error_max_turns) fall through to the
      // normal recoverable retry. (Codex review.)
      const errorResultSubtype = this.db
        .getSDKMessageRepo()
        ?.getErrorTerminalResultSubtypeAfter(this.session.id, messageUuid);
      const detail =
        turnError?.userMessage ||
        turnError?.message ||
        (errorResultSubtype
          ? `Turn ended with a terminal error (${errorResultSubtype})`
          : this.deliveryTurnStalled
            ? 'No response from the model — resetting and retrying'
            : 'Turn ended without a response');
      // Non-recoverable OR auth (Codex #2): retrying cannot fix a credential/
      // permission/quota error — dead-letter immediately with a Retry affordance
      // instead of burning the budget re-invoking a provider that cannot auth.
      if (turnError && isTerminalTurnError(turnError)) {
        throw new MessageDeliveryTerminalTurnError(detail, turnError.category);
      }
      // A non-retryable persisted error result is equally terminal (Codex
      // review): budget/limit exhaustion will not succeed on re-drive.
      if (!turnError && errorResultSubtype && !isRetryableErrorResultSubtype(errorResultSubtype)) {
        throw new MessageDeliveryTerminalTurnError(detail, errorResultSubtype);
      }
      // Recoverable provider error OR a no-progress stall (turnError null): the
      // turn consumed the kickoff but produced no result — reset+retry. Reopen
      // the row to `enqueued` so the retry RE-FEEDS the prompt: a resumed SDK
      // query only loads history, it does not continue an incomplete trailing
      // user turn, so a no-feed re-drive would sit silent until this watchdog
      // fires again and burn the budget without another provider attempt. (The
      // crash-reclaim path is different: there the SDK may still be
      // mid-execution, so `consumed` rows are NOT re-fed on reclaim — this flip
      // happens only after we confirmed the turn produced nothing.) (Codex P1.)
      //
      // Gated on the claim still being current: an interrupt (Stop) deletes the
      // delivery job FIRST and leaves the consumed row untouched by design, then
      // the query unwind's idle transition lands HERE. Reopening in that state
      // would strand an `enqueued` row with no job, which the periodic orphan
      // reconciler re-enqueues — replaying a prompt the user just cancelled
      // (potentially re-running tools). A dead/replaced claim means this attempt
      // no longer owns the retry, so it must not mutate the row. (Codex P1.)
      if (!claimGuard || claimGuard()) {
        this.reopenDeliveryForRetry(messageUuid);
      }
      throw new MessageDeliveryRecoverableTurnError(detail, turnError?.category);
    }
    return { outcome: 'completed' };
  }

  /**
   * Arm the delivery-turn no-progress stall watchdog. Returns a promise that
   * resolves when the turn has had NO activity (no SDK message AND no
   * outstanding tool) for {@link DELIVERY_TURN_NO_ACTIVITY_MS}. Every incoming
   * SDK message calls {@link bumpDeliveryTurnActivity} to reset the window; a
   * firing is deferred while a tool is outstanding (so a long build is not a
   * stall) or while the session sits in a scheduled `rate_limit_cooldown` (the
   * query is intentionally silent for the provider's reset window — firing here
   * would cancel the cooldown timer via `resetQuery()` and re-drive the provider
   * early, burning the delivery retry budget against a 429-ing provider).
   * On a true fire it flags {@link deliveryTurnStalled} and resets the
   * zombie query so the bridge throws a recoverable error and the job retries on
   * a clean query. The reset publishes the idle transition, which also resolves
   * the turn-end waiter raced in {@link driveDeliveryTurn}. (Codex P1.)
   */
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
        } catch {
          // best-effort — the flag is set; the bridge will throw + retry
        }
      },
      () => this.stateManager.getState().status === 'rate_limit_cooldown'
    );
    return this.deliveryTurnStall.arm();
  }

  /**
   * Reset the no-progress stall window — called on EVERY incoming SDK message
   * (via {@link SDKMessageHandler.handleMessage}). A healthy turn streams
   * messages continuously, so this keeps the watchdog from firing on a live
   * turn. No-op when no delivery turn is in flight. Exposed on
   * {@link SDKMessageHandlerContext} for the message handler.
   */
  bumpDeliveryTurnActivity(): void {
    this.deliveryTurnStall?.bump();
  }

  reportFirstDeliverySDKResponse(responseType: string): void {
    const active = this.deliveryResponseObserver;
    if (!active || active.generation !== this.getQueryGeneration()) return;
    this.deliveryResponseObserver = null;
    active.observer.reportStage('first_sdk_response', {
      generation: active.generation,
      responseType,
    });
  }

  /** Cancel the in-flight stall watchdog (no-op if none armed). */
  private clearDeliveryTurnStall(): void {
    this.deliveryTurnStall?.cancel();
    this.deliveryTurnStall = null;
  }

  /**
   * Return the terminal SDK error captured for this session iff it fired during
   * the turn that started at `turnStartedAt`, then clear it (consume-on-read) so
   * it cannot leak to a later turn. Null when the turn ended cleanly (or the
   * error predated this turn). The companion of {@link lastTerminalError}; see
   * {@link driveDeliveryTurn} for why the bridge needs this signal.
   */
  private consumeTerminalTurnError(turnStartedAt: number): StructuredError | null {
    const entry = this.lastTerminalError;
    if (!entry || entry.at < turnStartedAt) return null;
    this.lastTerminalError = null;
    return entry.error;
  }

  /**
   * Feed a steered message into the active turn's live transport (v2). The
   * per-session lock guards ONLY the processing-state check (brief); the feed
   * (enqueueWithId, which resolves on `onSent`) runs UNLOCKED — it is
   * concurrent-safe and may itself await for the duration of the steer being
   * consumed. If the turn ended, returns `promote` so the handler converts the
   * job to a turn in place.
   */
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
        // Re-fence the lease at the TOP of the locked section, before branching on
        // status. The handler's pre-lock check can pass, then a reclaim can win the
        // row during the lock wait. A stale attempt must not feed, park, OR promote
        // (promote calls requeueAs, which is token-fenced, but aborting here avoids
        // the superseded/requeue churn). See Codex (#3744886834, #3744971820).
        if (claimGuard && !claimGuard()) return { kind: 'aborted' as const };
        const status = this.stateManager.getState().status;
        // 'processing' → validate + synchronously admit while remove/defer are
        // excluded by this same lock. 'queued' → parked owner, so park this steer.
        if (status === 'processing') {
          if (!this.messageDeliveryValid(messageUuid)) return { kind: 'aborted' as const };
          if (!this.queryPromise) return { kind: 'promote' as const };
          const generation = this.getQueryGeneration();
          observer?.reportStage('query_ready', { generation });
          // ACP: if this steer was already admitted and is still pending subprocess
          // acceptance (a parked re-run), do NOT re-admit — admitWithId is not
          // idempotent, so a second push would duplicate the prompt. Keep awaiting
          // acceptance (the handler parks again). The non-ACP path never reaches a
          // re-admit: a consumed steer short-circuits via alreadyConsumed upstream.
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
      // The active turn ended (or never started) — promote to a turn candidate.
      return { outcome: 'promote' };
    }
    if (action.kind === 'park') {
      return { outcome: 'park' };
    }
    if (action.kind === 'aborted') {
      return { outcome: 'aborted' };
    }
    if (action.kind === 'awaiting_acceptance') {
      // ACP re-run while the already-admitted steer is still pending acceptance.
      return { outcome: 'awaiting_acceptance' };
    }
    // Admission happened atomically under the lock; only the provider
    // acknowledgment is awaited here.
    const aborted = waitForDeliveryAbort(signal);
    try {
      await Promise.race([action.acknowledgment, aborted.promise]);
    } catch (error) {
      if (signal?.aborted) {
        if (this.messageQueue.remove(messageUuid)) throw error;
        await action.acknowledgment;
      } else {
        throw error;
      }
    } finally {
      aborted.cancel();
    }
    // onSent fired → the steer reached the SDK (actual handoff). Record here,
    // not at admission (see driveDeliveryTurn).
    deliveryMetrics.recordFeed(messageUuid);
    observer?.reportStage('sdk_admitted', { generation: action.generation });
    // Claude SDK: onSent is the consume signal — flip synchronously (item 12)
    // and signal delivery waiters. ACP is excluded (consume boundary is
    // acceptance, not onSent); see driveDeliveryTurn for the full rationale.
    if (this.session.config.provider !== 'acp') {
      this.markDeliveryConsumed(messageUuid);
      signalDeliveryConsumed(this.session.id, messageUuid);
      return { outcome: 'consumed' };
    }
    // ACP: onSent fired (≡ onSubmitted → the row is now `submitted`), but the
    // consume boundary is acceptance (markMessageAccepted), which fires async
    // from the ACP runner. Report awaiting-acceptance instead of `consumed` so
    // the handler parks the job (keeps it alive) rather than auto-completing at
    // submission — if acceptance never comes the job dead-letters → `failed`
    // (surfaces) instead of stranding the row. On re-run the row is
    // `submitted`/`consumed` (settled by the handler's skip/alreadyConsumed
    // paths) or still `enqueued` with the message already admitted (the
    // re-admit guard above suppresses a duplicate feed).
    return { outcome: 'awaiting_acceptance' };
  }

  /**
   * Ordinary-chat entry for message-delivery v2: enqueue a durable delivery job
   * (role decided atomically by the job_queue index) instead of driving the
   * query inline. The message_delivery handler then drives/feeds the turn.
   * Default-on (HYPERNEO_MESSAGE_DELIVERY_V2); the `message.persisted`
   * subscriber calls this unless the flag is explicitly disabled (=0).
   */
  async settleSkippedDelivery(messageUuid: string): Promise<void> {
    await withSessionLock(this.session.id, () =>
      this.stateManager.clearQueuedIfOwnedBy(messageUuid).then(() => undefined)
    );
  }

  /**
   * Human gate open (an unanswered `sdk_resume_choice` OR `waiting_for_input`).
   * The delivery handler keeps a parked steer parked without burning its park
   * budget while this is true — the choice resolving (or the session leaving
   * the gate via archive/interrupt/turn-end) re-evaluates. (Codex #11.)
   *
   * The state check alone cannot see the resume gate: a blocked startup only
   * persists the `sdk_resume_choice` action and parks the session as `queued`
   * (`waiting_for_input` belongs to AskUserQuestion), so without the action
   * check a steer parked behind an unanswered resume card would charge
   * `__parkCount` every cycle and dead-letter after ~5 minutes while the gate
   * is legitimately open. (Codex P2.)
   */
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
      // Enqueue-time archive barrier: cancelForSession is point-in-time, so a send
      // landing after it but before the phase-4 status flip would otherwise create a
      // job that drives against a half-destroyed session. Skip the enqueue when the
      // session is already archived; the handler + bridge revalidate again at feed
      // time. See Codex (#3742774841).
      if (this.db.getSession(this.session.id)?.status === 'archived') {
        // Archive can win after MessagePersistence's post-save check but before
        // this final admission point. Its point-in-time job cancellation then
        // saw no job, so terminalize the saved enqueued row before rejecting.
        this.db.getSDKMessageRepo().markDeliveryFailedByUuid(this.session.id, messageUuid);
        throw new Error(`Session ${this.session.id} is archived`);
      }
      // Role arbitration and queued ownership are one critical section. The row
      // that actually inserts as `turn` owns the marker; a concurrently-persisted
      // steer can never steal it by publishing message.persisted first.
      let role: 'turn' | 'steer';
      try {
        role = deliverMessage(this.db.getJobQueueRepo(), this.session.id, messageUuid, {
          origin: 'chat',
        });
      } catch (err) {
        // The user row was already saved `enqueued` by MessagePersistence. If job
        // insertion throws (transient SQLite failure), the hidden prompt has no
        // durable owner — a client retry would create a second, and restart/replay
        // could still run the orphaned original. Terminalize before propagating.
        this.db.getSDKMessageRepo().markDeliveryFailedByUuid(this.session.id, messageUuid);
        throw err;
      }
      // A new chat message supersedes an armed rate-limit recovery episode. For a
      // `turn` this always holds (fresh user input). For a `steer` it must ALSO
      // hold while the session is in rate_limit_cooldown: the prior durable turn
      // still occupies the active-turn slot there, so the replacement is
      // classified as a steer and would park while the watchdog's timer replays
      // the stale prompt instead of letting the user's replacement take over.
      // (Mirrors the legacy inline path's unconditional cancel at the top of
      // startQueryAndEnqueue.) Gate the steer case on the cooldown state so a
      // normal steer into a LIVE turn does NOT bump the generation — that would
      // desync the rate-limit episode from the active turn's turn-end waiter tag
      // (see driveDeliveryTurn) and strand it on a later 429. (Codex P1.)
      if (role === 'turn' || this.stateManager.getState().status === 'rate_limit_cooldown') {
        this.rateLimitWatchdog.cancel();
      }
      if (role === 'turn') {
        try {
          // DB-first publication failure is non-fatal after durable insertion —
          // rejecting here would invite a client retry while this job still runs.
          await this.stateManager.setQueuedIfIdle(messageUuid);
        } catch (error) {
          this.logger.warn('Queued-state publication failed after durable insertion:', error);
        }
      }
    });
  }

  /**
   * Revalidation checked under the per-session lock immediately before feeding a
   * delivery: false if the session was archived (worktree/agent torn down) or the
   * message row is no longer pending delivery (removed by removePending, or
   * re-classified to deferred/consumed/failed) since the handler loaded it. Closes
   * the archive + removePending TOCTOU windows together. See Codex (#3742774841, #3696).
   */
  private messageDeliveryValid(messageUuid: string, alreadyConsumed = false): boolean {
    if (this.db.getSession(this.session.id)?.status === 'archived') return false;
    const loaded = this.db.getSDKMessageRepo().getDeliveryContent(this.session.id, messageUuid);
    return (
      loaded !== null &&
      (loaded.sendStatus === 'enqueued' || (alreadyConsumed && loaded.sendStatus === 'consumed'))
    );
  }

  /**
   * Reclaim decision for an already-consumed turn whose turn may have already
   * ended. Delegates to the pure {@link classifyReclaimTermination}: only a turn
   * that ended AND succeeded (`'terminated'`) completes silently; a bare
   * `delivery_turn_end` marker with no success result (`'redrive'`) is cleared
   * here and the caller falls through to re-drive so the producedResult /
   * stall-retry path decides. Returns `true` only for `'terminated'`.
   *
   * Why the success gate: a bare marker proves the turn ENDED, not that it
   * SUCCEEDED. On a restart reclaim such a marker is the tell-tale of the crash
   * window — the daemon exited AFTER the idle waiter recorded the marker but
   * BEFORE the producedResult/retry decision ran (and cleared it). Completing on
   * the marker alone would silently drop a recoverable failure (never retried)
   * and bury a non-recoverable one (never surfaced as `failed`). (Task #946,
   * PR #2471 review r3772035811.)
   */
  private reclaimTurnAlreadySucceeded(messageUuid: string): boolean {
    const repo = this.db.getSDKMessageRepo();
    if (!repo) return false;
    const decision = classifyReclaimTermination({
      successResult: repo.hasTerminalResultAfter(this.session.id, messageUuid),
      markerExists: repo.hasDeliveryTurnEnd(this.session.id, messageUuid),
      terminalIdleInFlight: this.stateManager.isTerminalIdleInFlight(),
    });
    if (decision === 'redrive') {
      // Clear the stale marker so the re-drive's own reclaim (if it re-crashes)
      // does not loop on `turn_terminated`; the producedResult check below is
      // the single retry/dead-letter authority.
      repo.clearDeliveryTurnEnd(this.session.id, messageUuid);
    }
    return decision === 'terminated';
  }

  /**
   * Persist a durable delivery-turn completion marker for a consumed message
   * whose turn ended via a result-less terminal path. Called by the delivery
   * handler when a driven turn completes while its job is still `processing`
   * (gated there so a graceful-shutdown requeue — where resume is desired —
   * does not mark it). See `MessageDeliverySession.recordDeliveryTurnEnd`.
   */
  recordDeliveryTurnEnd(messageUuid: string): void {
    this.db
      .getSDKMessageRepo()
      .recordDeliveryTurnEnd(this.session.id, messageUuid, new Date().toISOString());
  }

  /**
   * Flip a delivery row to `consumed` at the earliest SDK-consume signal
   * (onSent) and broadcast the status change. At-least-once quality hardening
   * (task #861 item 12): shrinking the [SDK yield, persisted consumed-flip]
   * window means reclaimStale almost always observes `consumed` and skips the
   * re-feed. Idempotent — a no-op (no broadcast) if the row is already
   * consumed/terminal, so the later history-echo path (which would also flip)
   * is unaffected. Fire-and-forget the publish: a rejecting statusChanged
   * subscriber must not surface as an unhandled rejection here.
   */
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

  /**
   * Atomic variant of {@link markDeliveryConsumed} for batched queue flushes:
   * the kickoff and every admitted member flip to `consumed` in ONE database
   * transaction. A crash between two separate flips would leave the members
   * `enqueued` while the (consumed) reclaim skips the re-feed — the reconciler
   * would then deliver them individually, repeating already-executed prompts.
   * One statusChanged broadcast carries every flipped row.
   */
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

  /**
   * Freeze a batched flush's admitted members as in-flight (`enqueued` →
   * `submitted`, one transaction + one broadcast) at admission — their text is
   * inside the combined prompt about to reach the transport, and revoke/defer
   * (which only touch `enqueued`/`deferred` rows) must stop offering to remove
   * it. `submitted` rows still consume normally (see
   * markDeliveryConsumedByUuids) and settle on dead-letter.
   */
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

  /**
   * Revalidate a batched flush's members and rebuild the combined prompt from
   * the durable rows, under the caller's session lock (immediately before
   * feeding). Members removed or user-deferred since the handler's snapshot
   * are dropped — their content must not reach the provider. Admission stops
   * at {@link BATCH_DELIVERY_MAX_CHARS} so the combined prompt can never
   * outgrow the provider's request limit; the remainder stays `enqueued`
   * (shielded from the reconciler by the batch-aware active-job lookups until
   * this job completes, then delivered individually). Returns the feed content
   * plus the admitted UUIDs (`undefined` when only the kickoff survives — its
   * raw content feeds, no batch flip).
   */
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
      const cost = text.length + 32; // delimiter overhead per message
      if (texts.length > 0 && budget < cost) break; // the kickoff is always admitted
      budget -= cost;
      if (uuid === kickoffUuid) kickoffRaw = row.content;
      texts.push(text);
      admitted.push(uuid);
    }
    if (texts.length === 0) {
      // No usable row (snapshot raced full removal) — the kickoff itself
      // passed messageDeliveryValid above, so fall back to its content.
      return { content: kickoffContent };
    }
    if (texts.length === 1) {
      // Single survivor (e.g. the budget admitted only the kickoff): still
      // return the singleton admitted set — the caller narrows the payload so
      // the omitted tail is not consumed at ACP acceptance / failed on
      // dead-letter as part of this batch.
      return { content: kickoffRaw ?? kickoffContent, admittedUuids: admitted };
    }
    return { content: buildBatchedDeliveryContent(texts), admittedUuids: admitted };
  }

  /**
   * Reopen a delivery row whose turn was confirmed to have produced no result,
   * so the job's automatic retry re-feeds it (see
   * {@link SDKMessageRepository.markDeliveryRetryableByUuid}). Fire-and-forget
   * the publish: a rejecting statusChanged subscriber must not surface as an
   * unhandled rejection here.
   */
  private reopenDeliveryForRetry(messageUuid: string): void {
    // The prior feed's outcome is void (the turn produced nothing), so the
    // retry's re-feed is an intentional recovery — not the exactly-once breach
    // duplicateFeedCount exists to flag. Drop it from the recent-feed window
    // BEFORE the retry can feed again. (Codex P2.)
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

  /**
   * Orphan reconciler (task #861 item 4) — recover the one case `job_queue`
   * cannot see by itself: a persisted user message stuck `enqueued` with NO
   * active `message_delivery` job (the confirmed #856 "stranded pending in an
   * idle session" shape). Delegates to the pure cross-check
   * {@link reconcileStrandedDeliveries}, adding a processing-state guard (never
   * reconcile while a turn is driving — the handler owns those messages) and
   * logging. Runs on each idle transition and on a periodic unref'd timer; the
   * pure core is idempotent so concurrent ticks/workers are safe.
   *
   * Also settles stale `submitted` rows (orphaned ACP messages whose subprocess
   * died) by flipping them to `failed` so they surface instead of staying
   * hidden — the responsibility of the now-deleted
   * `recoverOrphanedConsumedMessages` (task #861 item 7). The handler skips
   * `submitted`, so without this they would strand invisibly on restart.
   */
  async reconcileStrandedDeliveries(): Promise<number> {
    if (!isMessageDeliveryV2Enabled()) return 0;
    const jobQueue = this.db.getJobQueueRepo?.();
    if (!jobQueue) return 0;
    // Don't reconcile while a turn is actively driving — the handler owns those
    // messages, and re-enqueuing mid-turn could create a competing steer. Also
    // skip `queued` (a parked owner) and `waiting_for_input` (a restored
    // AskUserQuestion awaiting an answer — driving a stranded row there would
    // start a query and overwrite the pending-question state). The idle/periodic
    // callers run when the session is otherwise idle.
    const status = this.stateManager.getState().status;
    if (status === 'processing' || status === 'queued' || status === 'waiting_for_input') {
      return 0;
    }

    // 1) Re-enqueue stranded 'enqueued' messages (the #856 shape). The core
    // pass serializes under the per-session lock (withSessionLock) so concurrent
    // idle/periodic reconciles cannot double-enqueue one message.
    const reEnqueued = await reconcileStrandedDeliveriesCore({
      sessionId: this.session.id,
      db: this.db,
      jobQueue,
      stateManager: this.stateManager,
    });
    // 2) Settle stale 'submitted' rows (orphaned ACP) → failed so they surface.
    // Run under the per-session lock and re-query active ownership AT THE POINT
    // OF MUTATION: a racing retry (deliverAndMarkQueued) can enqueue a job for a
    // still-submitted UUID after an earlier snapshot; the fresh in-lock query
    // sees it and skips, so we never flip a row whose job just (re)activated
    // (which would make the handler skip it and block a later acceptance).
    // (Codex review.)
    let settled = 0;
    const sdkRepo = this.db.getSDKMessageRepo();
    await withSessionLock(this.session.id, async () => {
      const activeNow = jobQueue.activeDeliveryMessageUuids(this.session.id);
      for (const msg of this.db.getMessagesByStatus(this.session.id, 'submitted')) {
        if (!isSDKUserMessage(msg) || !msg.uuid) continue;
        if (activeNow.has(msg.uuid)) continue; // still has a durable job — leave it
        const dbId = sdkRepo.markDeliveryFailedByUuid(this.session.id, msg.uuid);
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
      // Store no-PID handles + promises in a durable collection so
      // updateProcessExitedPromise() includes them on every rebuild
      // (e.g. when a later numeric-PID process is tracked), and
      // terminateTrackedAgentProcesses() can still signal the handle via its
      // kill() — no-PID spawns (VM/container/remote execution) have no PID to
      // process.kill, so the handle is the only termination path. (Codex P2.)
      const entry: NoPidTrackedProcess = { proc };
      const noPidExitPromise = new Promise<void>((resolve) => {
        proc.once('exit', () => {
          // Self-clean from the durable collection once resolved.
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
    noPidProcesses?: NoPidTrackedProcess[];
  }): void {
    const forceDelayMs = options?.forceDelayMs ?? 2000;
    const processSnapshot = options?.processes ?? [...this.trackedAgentProcesses];

    // No-PID handles (VM/container/remote spawns) are not in the PID map —
    // signal them via their own kill() with the same SIGTERM→SIGKILL cadence.
    // Snapshot-scoped like the PID entries: a caller that captured only the
    // old query's handles (stop() during a replacement start) must not kill
    // the replacement's no-PID process. (Codex P2, PR #2491.)
    const noPidSnapshot = options?.noPidProcesses ?? [...this.noPidAgentProcesses];
    this.signalNoPidTrackedProcesses(noPidSnapshot, 'SIGTERM');
    for (const entry of noPidSnapshot) {
      // Ownership guard: skip entries that exited or were replaced.
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

  /** Snapshot the durable no-PID handles (for scoped termination). */
  snapshotNoPidTrackedProcesses(): NoPidTrackedProcess[] {
    return [...this.noPidAgentProcesses];
  }

  /** Signal the given no-PID tracked handles (best-effort via kill()). */
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
    } catch {
      // Handle may have already exited.
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
    // The durable no-PID handles are the source of truth for their exit
    // promises: an orphan retained across resetProcessExitedPromise() (still
    // alive, still killable) must stay in the aggregate so a later stop()
    // waits for it — otherwise the rebuild after tracking a replacement would
    // silently drop the orphan's wait. (Codex P2, PR #2491.)
    const noPidPromises = this.noPidAgentProcesses.flatMap((entry) =>
      entry.exitPromise ? [entry.exitPromise] : []
    );
    const exitPromises = [...this.trackedAgentProcessExitPromises.values(), ...noPidPromises];
    this.processExitedPromise =
      exitPromises.length > 0 ? Promise.all(exitPromises).then(() => {}) : null;
  }

  /** Re-derive the aggregated exit-wait promise from the current tracked handles. */
  refreshProcessExitedPromise(): void {
    this.updateProcessExitedPromise();
  }

  /**
   * Clear the aggregated exit-wait promise (retry paths abandoning the
   * current wait). The durable per-process exit promises are NOT dropped:
   * a subsequent trackAgentProcess()/updateProcessExitedPromise() rebuild
   * re-derives the aggregate from the still-live handles, so an abandoned
   * but still-alive process keeps blocking later teardown waits until it
   * actually exits (or is force-killed via its retained handle).
   * (Codex P2, PR #2491.)
   */
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

  // ============================================================================
  // Cleanup (delegated to QueryLifecycleManager)
  // ============================================================================

  async cleanup(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.clearDeliveryTurnStall();
    for (const unsub of this.deliveryErrorSubs) {
      try {
        unsub();
      } catch {
        // best-effort — cleanup must not throw
      }
    }
    this.deliveryErrorSubs.length = 0;
    this.rateLimitWatchdog.destroy();
    await this.lifecycleManager.cleanup();
  }
}
