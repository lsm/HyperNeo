/**
 * QueryRunner - Executes SDK queries with streaming input
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Starting and running SDK queries with AsyncGenerator
 * - Abortable query iteration for interrupt support
 * - Message generation wrapper
 * - API error handling and display
 * - Provider environment variable management
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { Database } from '../../storage/database';
import { ErrorCategory, type ErrorManager } from '../error-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Logger } from '../logger';
import type { OriginalEnvVars, ProviderEnvVars } from '../provider-service';
import { NON_ANTHROPIC_PREFIX_PROVIDER_VARS } from '../provider-service';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
  SPACE_COORDINATOR_REQUIRED_MCP_SERVERS,
  SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS,
} from '../space/runtime/space-mcp-session-policy';
import type { AskUserQuestionHandler } from './ask-user-question-handler';
import { isNonRetryableBillingError } from './fallback-recovery';
import { drainDeliveryWaitersOnTerminalSDKMessage } from './message-delivery';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { QueryLike } from './query-like';
import type { QueryOptionsBuilder } from './query-options-builder';
import type { SDKMessageHandler } from './sdk-message-handler';
import { getSdkStartupGate, type SdkStartupPermit } from './sdk-startup-gate';
import {
  isRetryableProviderError,
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
} from './transient-error-patterns';

// Re-exported for callers that import OriginalEnvVars from this module — canonical definition lives in provider-service.ts.
export type { OriginalEnvVars } from '../provider-service';

/**
 * Default spawn implementation matching the SDK's internal spawnLocalProcess().
 * Used when no custom spawnClaudeCodeProcess is configured, so we can
 * still intercept the subprocess and track its exit.
 *
 * Mirrors the SDK's spawn behavior (verified in sdk.mjs):
 * - stdio: ['pipe', 'pipe', stderr] where stderr is 'pipe' when
 *   DEBUG_CLAUDE_AGENT_SDK is set, otherwise 'ignore'
 * - windowsHide: true
 * - Same cwd, env, signal passthrough
 *
 * Node's ChildProcess structurally satisfies the SDK's SpawnedProcess
 * interface (stdin, stdout, killed, exitCode, kill, on/once/off for
 * 'exit' and 'error' events).
 *
 * SDK coupling: This mirrors the internal spawnLocalProcess() in the SDK (sdk.mjs).
 * Re-verify this implementation matches the SDK's spawn behavior on SDK upgrades —
 * mismatches in stdio/env/signal can cause subtle subprocess communication failures.
 */
export type TrackedAgentProcess = SpawnedProcess & {
  pid?: number;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
};

function defaultSpawn(opts: SpawnOptions): SpawnedProcess {
  const debugSdk = opts.env?.DEBUG_CLAUDE_AGENT_SDK;
  const stderr = debugSdk && debugSdk !== '0' && debugSdk !== 'false' ? 'pipe' : 'ignore';
  const proc = nodeSpawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', stderr],
    signal: opts.signal,
    windowsHide: true,
    // Run the SDK subprocess as a process-group leader so session cleanup can
    // terminate descendant commands spawned by tool use (bun test, make dev, etc.).
    // On Windows this starts an independent process; group signalling is POSIX-only.
    detached: process.platform !== 'win32',
  });
  return proc as unknown as SpawnedProcess;
}

// 60s: a cold-starting SDK subprocess (fresh worktree + resumed transcript)
// measures ~4–5s solo, and a herd of simultaneous cold-starts (e.g. a daemon
// restart fanning out resumed sessions) exceeded the old 15s default across
// the board. The timer only guards silent hangs — real spawn failures exit
// and are detected immediately — so a generous default is cheap insurance.
// Ordering: at default settings this window stays BELOW the delivery-turn
// stall watchdog's no-activity window (DELIVERY_TURN_NO_ACTIVITY_MS,
// default 3min — agent-session.ts armDeliveryTurnStall) so a silently hung
// startup is aborted here first.
// Two 30s bounds sit BELOW this window and cap the effective tolerance for
// a delivered kickoff at 30s: MESSAGE_QUEUE_TIMEOUT_MS (message-queue.ts —
// splices + rejects a message the SDK never consumes, and is the
// acknowledgment bound the delivery lane's 35s settlementGraceMs in app.ts
// is ordered against via admitWithId's settle path in agent-session.ts) and
// awaitDeliveryConsumption's 30s default (message-delivery.ts — a separate
// consume-wait deliberately matched to that queue timeout). A kickoff
// spliced at 30s recovers through the delivery/reset lane, not this timer's
// retry: the splice rejects as MessageQueueTimeoutError, whose handler
// (query-lifecycle-manager.ts) resets with restartAfter + re-enqueues and
// clears the stale startup timer on the way through. Extending tolerance
// beyond 30s for delivered kickoffs needs delivery-lane work (queued-message
// lifetime / retry pacing), not a longer startup timer.
const DEFAULT_STARTUP_TIMEOUT_MS = 60000;
/** Max time to wait for subprocess exit before retrying after startup timeout. */
const RETRY_EXIT_TIMEOUT_MS = 5000;

function getStartupTimeoutMs(): number {
  const raw = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
  if (!raw) return DEFAULT_STARTUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

// Read once at module load — consistent with the original STARTUP_TIMEOUT_MS pattern.
// Env vars set after the process starts will not be picked up; the values displayed
// in user-facing error messages reflect these module-load-time snapshots.
const STARTUP_TIMEOUT_MS = getStartupTimeoutMs();

/**
 * Bounded retry config for 5xx / overloaded / provider-unavailable errors that
 * escape the SDK's own retry logic. These are transient server-side failures that
 * should be retried at the HyperNeo level with exponential backoff before going terminal.
 *
 * Read lazily (at call time, not module load) so tests can set
 * HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS=0 in beforeEach to avoid real sleeps
 * and HYPERNEO_PROVIDER_MAX_RETRIES to adjust the cap.
 */
const DEFAULT_MAX_PROVIDER_RETRIES = 3;
const DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS = 2000;

function getMaxProviderRetries(): number {
  const raw = process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
  if (!raw) return DEFAULT_MAX_PROVIDER_RETRIES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_PROVIDER_RETRIES;
}

function getProviderRetryBaseDelayMs(): number {
  const raw = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
  if (!raw) return DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS;
}

/**
 * Exponential backoff delay for provider error retries.
 * attempt is 0-indexed (0 → base, 1 → 2×base, 2 → 4×base, …).
 */
function getProviderRetryDelayMs(attempt: number): number {
  return getProviderRetryBaseDelayMs() * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect a 429 rate-limit error in any of the shapes the SDK surfaces: a
 * leading `429`/`API Error: 429` (optionally prefixed by `Error: ` and followed by
 * a JSON body or text),
 * or a JSON envelope whose inner error message starts with `429`. Used to
 * decline validation-error rendering for 429s so they reach the rate-limit
 * recovery branch (fallback chain / reset-aware cooldown) instead of being
 * rendered as a terminal validation error.
 */
export function looksLikeRateLimit429(errorMessage: string): boolean {
  if (!errorMessage) return false;
  // Leading `429` / `API Error: 429` (the common Anthropic/relay shape).
  if (/^(?:Error:\s*)?(?:API Error:\s*)?429\b/i.test(errorMessage)) return true;
  // JSON envelope with an inner `429 ...` message (Copilot bridge shape).
  try {
    const jsonMessage = errorMessage.replace(/^Error:\s*/, '');
    const parsed = JSON.parse(jsonMessage) as { error?: { message?: string } };
    const inner = parsed?.error?.message;
    if (typeof inner === 'string' && /^429\b/.test(inner)) return true;
  } catch {
    // not JSON
  }
  return false;
}

export const PROVIDER_MANAGED_ENV_VARS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

function isRealAnthropicAuthToken(token: string | undefined): boolean {
  return typeof token === 'string' && token.startsWith('sk-ant-oat');
}

export function refreshQueryEnvFromProcess(
  queryEnv: Record<string, string | undefined> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
  options: {
    refreshAutoCompactWindow?: boolean;
    clearProviderManaged?: boolean;
    omitProviderManaged?: boolean;
    preserveAnthropicAuthToken?: boolean;
    preserveAnthropicOAuthToken?: boolean;
    omitProviderManagedPreserveAuth?: boolean;
    skipAmbientAnthropicApiKey?: boolean;
    extraProviderManagedEnvVars?: string[];
  } = {}
): Record<string, string | undefined> {
  const refreshedEnv: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(queryEnv ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
  const providerManagedEnvVars = new Set(PROVIDER_MANAGED_ENV_VARS);
  if (options.refreshAutoCompactWindow) {
    providerManagedEnvVars.add('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  }
  for (const key of options.extraProviderManagedEnvVars ?? []) {
    providerManagedEnvVars.add(key);
  }
  if (options.omitProviderManaged) {
    for (const key of providerManagedEnvVars) {
      if (
        options.omitProviderManagedPreserveAuth &&
        (key === 'ANTHROPIC_API_KEY' ||
          key === 'ANTHROPIC_AUTH_TOKEN' ||
          key === 'CLAUDE_CODE_OAUTH_TOKEN')
      ) {
        continue;
      }
      refreshedEnv[key] = undefined;
    }
  }
  for (const key of providerManagedEnvVars) {
    if (options.omitProviderManaged) continue;
    if (
      key === 'CLAUDE_CODE_OAUTH_TOKEN' &&
      options.clearProviderManaged &&
      !options.preserveAnthropicOAuthToken
    ) {
      delete refreshedEnv[key];
      continue;
    }
    const value = processEnv[key];
    if (value === undefined) {
      if (options.clearProviderManaged) {
        if (
          key === 'ANTHROPIC_AUTH_TOKEN' &&
          options.preserveAnthropicAuthToken &&
          isRealAnthropicAuthToken(refreshedEnv.ANTHROPIC_AUTH_TOKEN)
        ) {
          continue;
        }
        if (
          key === 'CLAUDE_CODE_OAUTH_TOKEN' &&
          options.preserveAnthropicOAuthToken &&
          refreshedEnv.CLAUDE_CODE_OAUTH_TOKEN
        ) {
          continue;
        }
        if (options.omitProviderManaged) {
          refreshedEnv[key] = undefined;
        } else {
          delete refreshedEnv[key];
        }
      }
    } else {
      if (options.skipAmbientAnthropicApiKey && key === 'ANTHROPIC_API_KEY') {
        delete refreshedEnv[key];
      } else {
        refreshedEnv[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined || key === 'PORT' || key === 'HYPERNEO_PORT' || key === 'NEOKAI_PORT')
      continue;
    if (options.omitProviderManaged && providerManagedEnvVars.has(key)) {
      if (
        !options.omitProviderManagedPreserveAuth ||
        (key !== 'ANTHROPIC_API_KEY' &&
          key !== 'ANTHROPIC_AUTH_TOKEN' &&
          key !== 'CLAUDE_CODE_OAUTH_TOKEN')
      ) {
        continue;
      }
    }
    if (
      options.clearProviderManaged &&
      key === 'CLAUDE_CODE_OAUTH_TOKEN' &&
      !options.preserveAnthropicOAuthToken
    ) {
      continue;
    }
    if (options.skipAmbientAnthropicApiKey && key === 'ANTHROPIC_API_KEY') {
      continue;
    }
    // Provider-managed vars should always UPDATE from process.env, not skip if present.
    // This ensures values from ~/.claude/settings.json (read into queryOptions.env by
    // getMergedEnvironmentVars) are overridden by provider-specific values set in
    // process.env by applyEnvVarsToProcess(). Without this, a user's
    // ANTHROPIC_DEFAULT_SONNET_MODEL setting persists across provider switches.
    if (providerManagedEnvVars.has(key)) {
      refreshedEnv[key] = value;
    } else if (!(key in refreshedEnv)) {
      refreshedEnv[key] = value;
    }
  }
  return refreshedEnv;
}

function applyProviderEnvToFlagSettings(queryOptions: Options, envVars: ProviderEnvVars): void {
  const flagEnv: Record<string, string> = {};
  const providerManagedEnvVars = new Set(PROVIDER_MANAGED_ENV_VARS);
  providerManagedEnvVars.add('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  providerManagedEnvVars.add('CLAUDE_CODE_SUBAGENT_MODEL');
  providerManagedEnvVars.add('ENABLE_TOOL_SEARCH');

  for (const key of providerManagedEnvVars) {
    if (envVars[key] !== undefined) {
      flagEnv[key] = envVars[key];
    }
  }

  if (Object.keys(flagEnv).length === 0) return;

  const existingSettings =
    queryOptions.settings && typeof queryOptions.settings === 'object' ? queryOptions.settings : {};

  queryOptions.settings = {
    ...existingSettings,
    env: {
      ...existingSettings.env,
      ...flagEnv,
    },
  };
}

const REQUIRED_SPACE_CHAT_MCP_SERVERS = SPACE_COORDINATOR_REQUIRED_MCP_SERVERS;
const REQUIRED_SPACE_CHAT_COORDINATION_TOOLS = [
  'create_standalone_task',
  'get_task_detail',
  'retry_task',
  'cancel_task',
  'reassign_task',
  'list_workflows',
  'suggest_workflow',
  'get_workflow_detail',
] as const;
/**
 * Context interface - what QueryRunner needs from AgentSession
 * Handlers take AgentSession instance directly via this context pattern
 */
export interface QueryRunnerContext {
  // Core dependencies (readonly)
  readonly session: Session;
  readonly db: Database;
  readonly messageHub: MessageHub;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly messageQueue: MessageQueue;
  readonly stateManager: ProcessingStateManager;
  readonly errorManager: ErrorManager;
  readonly logger: Logger;
  readonly optionsBuilder: QueryOptionsBuilder;
  readonly askUserQuestionHandler: AskUserQuestionHandler;
  readonly messageHandler: SDKMessageHandler;

  // Mutable query state (accessed directly)
  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;
  queryAbortController: AbortController | null;
  firstMessageReceived: boolean;
  startupTimeoutTimer: ReturnType<typeof setTimeout> | null;
  originalEnvVars: OriginalEnvVars;
  /** Resolves when tracked SDK subprocesses exit. Set by QueryRunner via spawnClaudeCodeProcess wrapper. */
  processExitedPromise: Promise<void> | null;
  /** Clear processExitedPromise and any stale no-PID exit promises. */
  resetProcessExitedPromise(): void;
  trackAgentProcess(proc: TrackedAgentProcess): void;
  snapshotTrackedAgentProcesses(): Array<[number, TrackedAgentProcess]>;
  /** Force-terminate tracked SDK subprocesses (SIGTERM + scheduled SIGKILL). */
  terminateTrackedAgentProcesses(options?: {
    forceDelayMs?: number;
    processes?: Array<[number, TrackedAgentProcess]>;
  }): void;
  // Methods for state coordination
  incrementQueryGeneration(): number;
  getQueryGeneration(): number;
  isCleaningUp(): boolean;

  // Callbacks for message handling
  onSDKMessage(message: SDKMessage, queuedMessages?: SDKMessage[]): Promise<void>;
  onSlashCommandsFetched(): Promise<void>;
  onModelsFetched(): Promise<void>;
  onMarkApiSuccess(message: SDKMessage): Promise<void>;

  /**
   * Self-heal hook: called when `QueryRunner.start()` detects that a workflow
   * sub-session is missing required MCP servers (`node-agent`).
   *
   * The callback receives the session so the caller (TaskAgentManager) can
   * re-attach the missing server before the first turn runs. This is the
   * final backstop — even if spawn/rehydrate/ensureRequiredMcpServersAttached
   * all failed silently, this fires at the moment of detection and can recover.
   *
   * Undefined for generic sessions (chat, worker, etc.) where this hook is
   * not applicable.
   */
  onMissingWorkflowMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  /**
   * Self-heal hook for Space chat sessions missing their in-process coordination
   * MCP server. SpaceRuntimeService wires this so context compaction/session
   * resume cannot silently start a degraded Space Agent turn.
   */
  onMissingSpaceChatMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  /**
   * Self-heal hook for SpaceRuntime-owned member sessions missing their
   * `space-agent-tools` MCP server. SpaceRuntimeService wires this in
   * `attachSpaceToolsToMemberSession()` so cache eviction / DB reload cannot
   * silently start a degraded turn.
   */
  onMissingMemberSpaceMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  /** Consume (clear) the one-shot resumeSessionAt after the query has started. */
  consumePendingResumeSessionAt?(): string | undefined;

  /**
   * Called when a 429 rate limit exhaustion error is detected (all SDK retries exhausted).
   * The RateLimitWatchdog uses this to schedule an automatic retry after cooldown.
   * @returns true if cooldown was scheduled (caller should skip setIdle),
   *          false if max retries exceeded or callback is unset.
   */
  onRateLimitExhausted?: (
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null
  ) => Promise<boolean>;
}

/**
 * Runs SDK queries with streaming input mode
 */
export class QueryRunner {
  /**
   * Last non-internal user message consumed by the generator, for re-enqueue
   * on transient connection error retry or rate limit auto-retry.
   * Set by createMessageGeneratorWrapper() when a message is yielded to the SDK;
   * cleared after re-enqueue or on cleanup.
   */
  private _lastConsumedUserMessage: {
    uuid: string;
    content: string | MessageContent[];
  } | null = null;

  /**
   * Ordered list, per query generation, of every non-internal user message
   * consumed by that generation's generator, for the startup-timeout retry to
   * replay. The single `_lastConsumedUserMessage` slot is enough for the
   * transient/rate-limit retries (only the in-flight message needs replay), but
   * a silent SDK can pull the kickoff AND trailing steers before the startup
   * timer fires — those all need re-feeding, in order. Keyed by generation so a
   * superseded query cannot clear (or inherit) a replacement's history.
   */
  private _consumedUserMessages = new Map<
    number,
    Array<{ uuid: string; content: string | MessageContent[] }>
  >();

  /**
   * Public accessor for the last consumed user message.
   * Used by RateLimitWatchdog to re-enqueue on auto-retry.
   */
  get lastConsumedUserMessage() {
    return this._lastConsumedUserMessage;
  }

  constructor(private ctx: QueryRunnerContext) {}

  /**
   * Start the streaming query (called from AgentSession.startStreamingQuery)
   */
  async start(): Promise<void> {
    const { messageQueue, logger } = this.ctx;

    if (messageQueue.isRunning()) {
      logger.warn(
        `QueryRunner.start(): messageQueue already running for session ${this.ctx.session.id}, ` +
          `skipping start (generation=${messageQueue.getGeneration()}, ` +
          `queryPromise=${this.ctx.queryPromise ? 'active' : 'null'})`
      );
      return;
    }

    logger.debug(
      `QueryRunner.start(): starting query for session ${this.ctx.session.id} ` +
        `(generation=${messageQueue.getGeneration()})`
    );
    messageQueue.start();

    // Increment query generation for this new query
    const currentGeneration = this.ctx.incrementQueryGeneration();

    // Reset firstMessageReceived flag for new query
    this.ctx.firstMessageReceived = false;

    // Store query promise for cleanup
    this.ctx.queryPromise = this.runQuery(currentGeneration);
  }

  /**
   * Run the query (main execution loop)
   *
   * @param queryGeneration - Generation counter to detect stale queries
   * @param retryAttempt - Retry attempt counter (0 = first attempt, 1+ = retry).
   *   Used to gate bounded retries: startup-timeout / message-not-found /
   *   transient-connection retries fire only on attempt 0 (1-shot), while
   *   the 5xx/overloaded provider-retry path fires up to the configured cap.
   */
  private async runQuery(
    queryGeneration: number,
    retryAttempt = 0,
    recoveryState = { rateLimitCooldownScheduled: false }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;

    // Startup-phase admission permit (daemon-wide cold-start gate). Acquired
    // just before the SDK query is created below and released on the first SDK
    // message, on any throw (catch entry), and on attempt exit (finally
    // backstop) — release is idempotent, and the permit is attempt-local so it
    // is safe to free even when the attempt is stale. Declared outside the try
    // so all three release sites share one slot.
    let startupPermit: SdkStartupPermit | null = null;
    const releaseStartupPermit = (reason: string): void => {
      if (!startupPermit) return;
      const permit = startupPermit;
      startupPermit = null;
      logger.debug(
        `SDK startup gate: slot released (session=${session.id} reason=${reason} ` +
          `heldMs=${Date.now() - permit.admittedAt})`
      );
      permit.release();
    };

    try {
      // Verify authentication for the selected provider
      const { initializeProviders, waitForOptionalProviderRegistration } = await import(
        '../providers/factory.js'
      );
      const providerRegistry = initializeProviders();
      await waitForOptionalProviderRegistration();
      const modelId = session.config.model || 'sonnet';
      // As of PR #466, all new agent sessions store an explicit provider ID in
      // session.config.provider. The registry.get('anthropic') fallback below is a
      // temporary shim for sessions created before that change. It must NOT be
      // expanded or used as a design pattern — new code should always have an
      // explicit provider stored.
      const explicitProviderId = session.config.provider as string | undefined;
      const provider = explicitProviderId
        ? providerRegistry.detectProviderForModel(modelId, explicitProviderId)
        : providerRegistry.get('anthropic');

      // Check if the provider can make API calls (env vars, auth.json, gh CLI — all count).
      // isAvailable() is the runtime gate; getAuthStatus().isAuthenticated is UI-only
      // (HyperNeo-managed OAuth) and must NOT be used here or env-var users will be blocked.
      if (provider?.isAvailable && !(await provider.isAvailable())) {
        const authStatus = provider.getAuthStatus ? await provider.getAuthStatus() : null;
        const errorMsg = authStatus?.error || 'Please configure credentials.';
        const authError = new Error(
          `Provider ${provider.displayName} is not available. ${errorMsg}`
        );
        await errorManager.handleError(
          session.id,
          authError,
          ErrorCategory.PROVIDER_AUTH_ERROR,
          `Provider ${provider.displayName} is not available. Please configure credentials to continue.`,
          stateManager.getState(),
          { providerId: provider.id, providerName: provider.displayName }
        );
        throw authError;
      }
      // needsRefresh is a UI hint — warn but do not block the session.
      if (provider?.getAuthStatus) {
        const authStatus = await provider.getAuthStatus();
        if (authStatus.needsRefresh) {
          logger.warn(
            `Provider ${provider.displayName} token needs refresh. Attempting to continue.`
          );
        }
      }

      if (!provider?.isAvailable) {
        // Fall back to checking Anthropic/GLM auth for SDK-based providers
        const { getProviderService } = await import('../provider-service');
        const providerService = getProviderService();

        const hasAnthropicAuth = !!(
          process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
        );
        const hasGlmAuth = await providerService.isGlmAvailable();
        const hasAuth = hasAnthropicAuth || hasGlmAuth;

        if (!hasAuth) {
          const authError = new Error(
            'No authentication configured. Please set up API key for Anthropic or Z.ai.'
          );
          await errorManager.handleError(
            session.id,
            authError,
            ErrorCategory.AUTHENTICATION,
            undefined,
            stateManager.getState()
          );
          throw authError;
        }
      }

      // Ensure workspace exists when the session is bound to a concrete workspace path.
      if (session.workspacePath) {
        const fs = await import('fs/promises');
        await fs.mkdir(session.workspacePath, { recursive: true });
      }

      // Build query options
      optionsBuilder.setCanUseTool(this.ctx.askUserQuestionHandler.createCanUseToolCallback());
      optionsBuilder.setAskUserQuestionHook(this.ctx.askUserQuestionHandler.createPreToolUseHook());
      let queryOptions = await optionsBuilder.build();

      // Side-channel: propagate the session's effective thinking level to providers
      // whose bridge/translation layer needs it (e.g. anthropic-codex, where the
      // Claude Code CLI omits the thinking field from request bodies). Must run
      // AFTER optionsBuilder.build() so the bridge server already exists.
      if (provider?.setSessionThinkingConfig) {
        const effectiveThinkingLevel = optionsBuilder.getEffectiveThinkingLevel();
        provider.setSessionThinkingConfig(session.id, effectiveThinkingLevel);
      }

      queryOptions = optionsBuilder.addSessionStateOptions(queryOptions);

      // Structured log of MCP servers visible to this query. Critical for diagnosing
      // "No such tool available" issues where an expected MCP server (e.g. node-agent
      // for workflow sub-sessions) is missing from session config at first turn.
      // Always logged at info level so production logs preserve the evidence trail.
      //
      // Task #140 acceptance #9: emit a structured `query.mcp.snapshot` payload
      // (joinable by sessionId/taskId/workflowRunId) so monitoring can detect
      // regressions without grepping prose log lines.
      const mcpServerNames = Object.keys(queryOptions.mcpServers ?? {}).sort();
      const spacePolicy = resolveSpaceMcpSessionPolicy(session, {
        nodeExecutionRepo: this.ctx.db.getNodeExecutionRepo(),
        taskRepo: this.ctx.db.getSpaceTaskRepo(),
      });
      const isWorkflowSubSession = spacePolicy.isWorkflowWorker;
      const sessionTaskId = session.context?.taskId as string | undefined;
      const snapshotPayload = {
        event: 'query.mcp.snapshot',
        sessionId: session.id,
        sessionType: session.type,
        role: spacePolicy.role,
        owner: spacePolicy.owner,
        ...(spacePolicy.spaceId ? { spaceId: spacePolicy.spaceId } : {}),
        ...(sessionTaskId ? { taskId: sessionTaskId } : {}),
        ...(isWorkflowSubSession ? { workflowSubSession: true } : {}),
        mcpServers: mcpServerNames,
      };
      logger.info(
        `QueryRunner.start(): session ${session.id} mcp servers visible at first turn: ` +
          `[${mcpServerNames.join(', ')}]` +
          (isWorkflowSubSession ? ' (workflow sub-session)' : '') +
          ` ${JSON.stringify(snapshotPayload)}`
      );

      queryOptions = await this.ensureSpaceChatMcpInvariant(queryOptions);
      // P2-6 / P1-5: Self-heal — detect a missing required MCP server for
      // workflow sub-sessions and recover via the registered callback.
      // Required server:
      //   - node-agent: peer comms, artifact writes, and node-safe task actions
      //
      // Only enters this block when servers are actually missing. The callback
      // (TaskAgentManager.mcpSelfHeal) calls ensureRequiredMcpServersAttached which
      // already verifies post-injection — no separate functional check needed here.
      // No health check on healthy starts — the outer condition is strictly
      // `missingServers.length > 0` to avoid false-positive throws.
      if (isWorkflowSubSession) {
        const requiredServers = SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS;
        const missingServers = missingMcpServers(
          queryOptions.mcpServers as Record<string, unknown> | undefined,
          requiredServers
        );

        if (missingServers.length > 0) {
          const diagnosticPayload = {
            event: 'workflow.mcp.missing',
            sessionId: session.id,
            spaceId: spacePolicy.spaceId,
            sessionType: session.type,
            role: spacePolicy.role,
            owner: spacePolicy.owner,
            requiredServers,
            missingServers,
            presentServers: mcpServerNames,
            liveSdkServers: this.getLiveSdkMcpServerNames(queryOptions),
            selfHealAttempted: !!this.ctx.onMissingWorkflowMcpServers,
          };

          logger.error(
            `QueryRunner.start(): workflow sub-session ${session.id} is MISSING required MCP servers. ` +
              `Missing: [${missingServers.join(', ')}]. ` +
              `Present: [${mcpServerNames.join(', ')}]. ` +
              `Live SDK servers: [${diagnosticPayload.liveSdkServers.join(', ')}]. ` +
              `Self-heal attempted: ${diagnosticPayload.selfHealAttempted}. ` +
              `Attempting self-heal via onMissingWorkflowMcpServers callback... ` +
              `${JSON.stringify(diagnosticPayload)}`
          );

          // ── Self-heal: call the registered callback to re-inject servers ─────
          if (this.ctx.onMissingWorkflowMcpServers) {
            try {
              await this.ctx.onMissingWorkflowMcpServers(session.id, missingServers);
              logger.info(
                `QueryRunner.start(): self-heal callback completed for session ${session.id}. ` +
                  `${JSON.stringify(diagnosticPayload)}`
              );
            } catch (err) {
              logger.error(
                `QueryRunner.start(): self-heal callback FAILED for session ${session.id}: ` +
                  `${err instanceof Error ? err.message : String(err)}. ` +
                  `The session will start without required MCP servers — expect "No such tool available" failures at runtime.`
              );
            }
          }

          // Belt-and-suspenders: re-read the live map and throw if still missing.
          // The callback may have thrown, in which case we never reach here.
          // If it succeeded without throwing but servers are still absent (should not
          // happen with ensureRequiredMcpServersAttached), catch it here.
          const currentMcpServers =
            (session.config?.mcpServers as Record<string, unknown> | undefined) ?? {};
          const currentServerNames = Object.keys(currentMcpServers);
          const stillMissing = requiredServers.filter((name) => !currentServerNames.includes(name));
          if (stillMissing.length > 0) {
            logger.error(
              `QueryRunner.start(): workflow sub-session ${session.id} servers still missing after self-heal. ` +
                `Still absent: [${stillMissing.join(', ')}]. ` +
                `Present: [${currentServerNames.join(', ')}]. ` +
                `Live SDK servers: [${this.getLiveSdkMcpServerNames({ mcpServers: currentMcpServers } as Options).join(', ')}]. ` +
                `Refusing to start.`
            );
            throw new Error(
              `[MCP invariant] Workflow sub-session ${session.id} still missing required ` +
                `MCP servers after self-heal: [${stillMissing.join(', ')}]. ` +
                `Refusing to start — fix the injection logic.`
            );
          }

          // The self-heal callback mutates session.config.mcpServers. The
          // queryOptions object was built before that mutation, so rebuild it
          // now or the SDK will still start with the stale server map.
          queryOptions = await optionsBuilder.build();
          queryOptions = optionsBuilder.addSessionStateOptions(queryOptions);
          const repairedServerNames = Object.keys(queryOptions.mcpServers ?? {}).sort();
          logger.info(
            `QueryRunner.start(): rebuilt query options after MCP self-heal for session ${session.id}. ` +
              `Present: [${repairedServerNames.join(', ')}]. ` +
              `${JSON.stringify({
                event: 'workflow.mcp.self_heal.rebuilt_query_options',
                sessionId: session.id,
                sessionType: session.type,
                requiredServers,
                presentServers: repairedServerNames,
                liveSdkServers: this.getLiveSdkMcpServerNames(queryOptions),
              })}`
          );
        }
      }

      queryOptions = await this.ensureMemberSpaceMcpInvariant(queryOptions);

      // Apply provider env vars
      const resolvedProviderId = explicitProviderId ?? provider?.id ?? 'anthropic';
      const refreshAutoCompactWindow = true;
      let extraProviderManagedEnvVars: string[] = [];
      {
        const { getProviderService } = await import('../provider-service');
        const providerService = getProviderService();
        // Use the resolved provider ID (falls back to 'anthropic' for legacy sessions)
        const providerSession = {
          ...session,
          config: {
            ...session.config,
            model: modelId,
            provider: resolvedProviderId as Session['config']['provider'],
          },
        };
        const providerEnvVars = providerService.getProviderEnvVars(providerSession);
        extraProviderManagedEnvVars = NON_ANTHROPIC_PREFIX_PROVIDER_VARS.filter(
          (key) => providerEnvVars[key] !== undefined
        );
        applyProviderEnvToFlagSettings(queryOptions, providerEnvVars);
        const originalEnvVars = providerService.applyEnvVarsToProcessForSession(providerSession);
        this.ctx.originalEnvVars = originalEnvVars;
      }

      // Note: PORT and HYPERNEO_PORT are cleared inside applyEnvVarsToProcess() above,
      // so SDK subprocesses cannot inherit the daemon's listening port. Refresh
      // the full SDK env snapshot now so provider credentials applied to
      // process.env are included before SDK 0.3 treats options.env as complete.
      // Provider-managed context-window overrides are refreshed from process.env for all
      // providers so stale bridge values are removed after provider cleanup.
      queryOptions.env = refreshQueryEnvFromProcess(queryOptions.env, process.env, {
        refreshAutoCompactWindow,
        clearProviderManaged: true,
        preserveAnthropicAuthToken: resolvedProviderId === 'anthropic',
        preserveAnthropicOAuthToken: resolvedProviderId === 'anthropic',
        skipAmbientAnthropicApiKey: resolvedProviderId !== 'anthropic',
        extraProviderManagedEnvVars,
      }) as Record<string, string>;

      // Wrap spawnClaudeCodeProcess to track subprocess exit deterministically.
      // This lets stop() await the actual process exit instead of using arbitrary delays.
      const originalSpawn = queryOptions.spawnClaudeCodeProcess;
      queryOptions.spawnClaudeCodeProcess = (opts: SpawnOptions): SpawnedProcess => {
        const proc = (
          originalSpawn ? originalSpawn(opts) : defaultSpawn(opts)
        ) as TrackedAgentProcess;
        this.ctx.trackAgentProcess(proc);
        // Delivery observability: correlates the subprocess PID with the
        // session + resume target so a later 0-message timeout can be matched
        // to the exact process that stayed silent.
        logger.info(
          `SDK subprocess spawned (pid=${proc.pid} session=${session.id} ` +
            `resume=${session.sdkSessionId ?? 'fresh'} model=${queryOptions.model})`
        );
        return proc;
      };

      // ── Startup-phase admission gate ─────────────────────────────────────
      // The expensive resource at session start is the spawn→first-message
      // window (fork/exec of the CLI + transcript parse), not steady-state
      // streaming. The daemon-wide gate bounds how many sessions may be in
      // that phase at once, so a reclaimed herd rolls its admissions instead
      // of missing the startup window en masse. The SDK spawns the subprocess
      // synchronously inside query() below, so the permit must be held BEFORE
      // that call. It is released when the first SDK message arrives (next to
      // clearing the startup timer) and on every other attempt exit via the
      // catch/finally backstops below — retries re-queue like any other start.
      const abortController = new AbortController();
      this.ctx.queryAbortController = abortController;
      {
        const startupGate = getSdkStartupGate();
        startupPermit = await startupGate.acquire({
          sessionId: session.id,
          signal: abortController.signal,
        });
        if (startupPermit.queuedBehind > 0) {
          logger.info(
            `SDK startup gate: session ${session.id} admitted after waiting ` +
              `${startupPermit.waitedMs}ms behind ${startupPermit.queuedBehind} session(s) ` +
              `(gate=${JSON.stringify(startupGate.getStats())})`
          );
        }
      }
      // The wait can straddle a stop/interrupt/restart. An abort wins via the
      // signal, a replacement query via the generation check; either way
      // release the slot and surface as an abort so the existing cleanup paths
      // run — never spawn into a session that has moved on.
      if (
        abortController.signal.aborted ||
        this.ctx.isCleaningUp() ||
        this.ctx.getQueryGeneration() !== queryGeneration
      ) {
        releaseStartupPermit('aborted_while_queued');
        const gateAbort = new Error('SDK startup gate: query aborted while awaiting admission');
        gateAbort.name = 'AbortError';
        throw gateAbort;
      }

      // Create query with AsyncGenerator
      const queryObject = query({
        prompt: this.createMessageGeneratorWrapper(queryGeneration),
        options: queryOptions,
      });
      this.ctx.queryObject = queryObject;

      // Apply the deferred bypassPermissions switch. `build()` withheld the
      // mode from the options (see QueryOptionsBuilder.getDeferredPermissionMode)
      // so the SDK does not warn that canUseTool is shadowed — canUseTool must
      // stay registered for the CLI to expose the AskUserQuestion tool, and the
      // PreToolUse hook delivers the answers. The control request queues behind
      // the initialize handshake, so the session runs the real mode from its
      // first turn. Fire-and-forget: if the switch fails the session keeps the
      // intake default ('default' mode) where canUseTool's allow-all fallback
      // preserves effectively identical tool behavior.
      const deferredPermissionMode = optionsBuilder.getDeferredPermissionMode();
      if (deferredPermissionMode && queryObject.setPermissionMode) {
        void queryObject.setPermissionMode(deferredPermissionMode).catch((err) => {
          logger.warn(
            `QueryRunner.start: failed to apply deferred permission mode ` +
              `'${deferredPermissionMode}' for session ${session.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        });
      }

      // Drain any MCP-server change that arrived during startup. Streaming-input
      // queries run once per session (start() is a no-op while the message queue
      // is active), so options are built a single time above; an
      // mcp.registry.changed / skills.changed arriving between that build and this
      // assignment would otherwise be dropped (reconcile sees no queryObject yet)
      // and never re-applied. Re-push the current effective set to close that
      // window. ACP queries cannot live-update MCP tools, so skip them. See #853.
      if (session.config.provider !== 'acp') {
        const effectiveMcpServers = optionsBuilder.getEffectiveMcpServers() ?? {};
        void queryObject.setMcpServers?.(effectiveMcpServers).catch((err) => {
          logger.warn(
            `QueryRunner.start: post-start MCP reconcile failed for session ${session.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        });
      }

      // The abort controller was created and published before the admission
      // gate above; the timer below closes over that exact controller so it
      // cannot miss the narrow setup window or abort a replacement query
      // through mutable shared state.

      // Set up startup timeout
      const queryStartTime = Date.now();
      let startupTimeoutReached = false;

      const startupTimer = setTimeout(() => {
        if (!this.ctx.firstMessageReceived) {
          startupTimeoutReached = true;
          const elapsed = Date.now() - queryStartTime;
          const isRootWorkspace = !session.worktree;
          const workspaceDesc = isRootWorkspace
            ? `root workspace: ${session.workspacePath ?? 'unbound'}`
            : `worktree: ${session.worktree!.worktreePath}`;
          logger.error(
            `SDK startup timeout: SDK did not respond within ${elapsed}ms. ` +
              `Model: ${queryOptions.model}, ${workspaceDesc}` +
              (isRootWorkspace
                ? ' — running on root workspace (not a worktree); check for other Claude Code sessions using this path'
                : '') +
              ` (Hint: set HYPERNEO_SDK_STARTUP_TIMEOUT_MS to increase timeout, currently ${STARTUP_TIMEOUT_MS}ms)`
          );
          // Delivery diagnostics: distinguish "kickoff never reached the CLI"
          // (queueRunning=true + queueSize>0 → feed starvation, e.g. orphaned
          // generator) from "fed but CLI emitted nothing" (queueSize=0 →
          // subprocess hang). trackedPids shows orphaned-process collisions.
          logger.error(
            `SDK startup timeout diagnostics: queueRunning=${messageQueue.isRunning()} ` +
              `queueSize=${messageQueue.size()} trackedPids=[${this.ctx
                .snapshotTrackedAgentProcesses()
                .map(([pid]) => pid)
                .join(',')}] sdkSessionId=${session.sdkSessionId ?? 'none'}`
          );

          // Actively abort this exact attempt so iterator cleanup and retry can
          // proceed without touching a replacement query's controller.
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
        }
      }, STARTUP_TIMEOUT_MS);
      this.ctx.startupTimeoutTimer = startupTimer;

      // Models can be fetched from the live query object. Slash commands are
      // captured from the SDK system:init message by SDKMessageHandler; probing
      // supportedCommands() here races startup recovery and can duplicate stale
      // resumeSessionAt errors from an about-to-be-retried query.
      this.ctx.onModelsFetched().catch((e) => {
        logger.warn('Background fetch of models failed:', e);
      });

      if (!queryObject) {
        throw new Error('Query object is null after initialization');
      }

      let messageCount = 0;

      for await (const message of this.createAbortableQuery(queryObject, abortController.signal)) {
        if (startupTimeoutReached && messageCount === 0) {
          throw new Error('SDK startup timeout - query aborted');
        }

        messageCount++;

        // Clear startup timeout on first message. The startup phase is over
        // here — also free the daemon-wide admission slot so queued sessions
        // can cold-start while this one streams (streaming holds no slot).
        if (messageCount === 1) {
          const timer = this.ctx.startupTimeoutTimer;
          if (timer) {
            clearTimeout(timer);
            this.ctx.startupTimeoutTimer = null;
          }
          releaseStartupPermit('first_message');
        }

        this.ctx.firstMessageReceived = true;
        if (messageCount === 1) {
          // Startup succeeded (timer cleared above): the replay history can no
          // longer be used for startup recovery and would otherwise retain every
          // message's full content for the session's lifetime. `_lastConsumedUserMessage`
          // stays for the transient/rate-limit retries. (Codex P2, PR #2499.)
          this._consumedUserMessages.delete(queryGeneration);
        }

        try {
          await this.handleSDKMessage(message as SDKMessage);
        } catch (error) {
          logger.error('Error handling SDK message:', error);
          logger.error('Message type:', (message as SDKMessage).type);

          // During cleanup the database may already be closed — skip
          // state persistence to avoid cascading "closed database" errors.
          if (!this.ctx.isCleaningUp()) {
            const processingState = stateManager.getState();
            // Only publish the terminal idle (draining the delivery waiters) when
            // the throwing message actually ends the turn — the final `result`.
            await drainDeliveryWaitersOnTerminalSDKMessage(stateManager, message as SDKMessage);

            await errorManager.handleError(
              session.id,
              error as Error,
              ErrorCategory.MESSAGE,
              'Error processing SDK message. The session has been reset.',
              processingState,
              { messageType: (message as SDKMessage).type }
            );
          }
        }
      }

      // Consume the one-shot resumeSessionAt now that the query completed
      // successfully. Peek was used in addSessionStateOptions so options had
      // the value; consuming only on success preserves it for startup retries.
      // Guard: only consume if this is still the current query. When restart()
      // aborts this query via createAbortableQuery (which breaks, not throws),
      // execution reaches here — but the RewindHandler may have already set a
      // new pendingResumeSessionAt for the restarted query. Without this guard
      // the stale old query consumes the value the new query needs.
      // The startup-timeout escape below ALSO reaches this block "normally"
      // (the abort-driven iterator shutdown breaks the for-await, not throws)
      // — a timeout is not a success, so its retry must keep the requested
      // resume-at cutoff instead of silently running against latest history.
      // (Codex P2, PR #2499.)
      if (
        this.ctx.getQueryGeneration() === queryGeneration &&
        !(startupTimeoutReached && messageCount === 0)
      ) {
        this.ctx.consumePendingResumeSessionAt?.();
      }

      // Stop the queue immediately after the query ends to close the race window
      // between the for-await loop ending and the finally block calling stop().
      // Without this, ensureQueryStarted() can see isRunning()=true while no
      // generator is consuming messages, causing enqueued messages to be orphaned.
      // Guard: only stop if this is still the current query (not stale from a restart).
      if (this.ctx.getQueryGeneration() === queryGeneration) {
        messageQueue.stop();
      }

      // If startup timed out before first message, surface as timeout error
      // (after abort-driven iterator shutdown) so error state is visible.
      if (startupTimeoutReached && messageCount === 0) {
        throw new Error('SDK startup timeout - query aborted');
      }
    } catch (error) {
      logger.error('Streaming query error:', error);

      // The attempt is exiting without completing its startup phase (or its
      // permit was already freed at the first message — release is idempotent).
      // Free the admission slot NOW, before the teardown waits and recursive
      // retries below: retries must re-queue like any other start, and
      // subprocess-exit waits must never hold cold-start capacity.
      releaseStartupPermit('query_error');

      // During cleanup the database may already be closed. Skip all
      // error-recovery DB writes to avoid cascading "closed database"
      // errors that escape as unhandled rejections.
      if (this.ctx.isCleaningUp()) {
        return;
      }

      // A stale query (a newer query started — e.g. a resetContextPerTurn clear
      // bumped the generation before stop()) must not touch shared state from
      // the catch: no retry, no messageQueue.clear(), no idle, no error
      // surfacing. The error is from the intentional stop; the newer query owns
      // the queue, the env, and the completion lifecycle. Returning here also
      // lets the finally's isStaleQuery guard handle cleanup uniformly.
      if (this.ctx.getQueryGeneration() !== queryGeneration) {
        return;
      }

      // Use String(error) rather than error.message so TypeError instances
      // (e.g. "fetch failed") include their name prefix.  All downstream
      // pattern checks use includes() on substrings, so the "Error: " /
      // "TypeError: " prefix does not break any existing detection logic.
      const errorMessage = String(error);
      const isAbortError = error instanceof Error && error.name === 'AbortError';
      const isQueryInterrupted =
        isAbortError ||
        stateManager.getState().status === 'interrupted' ||
        this.ctx.queryAbortController?.signal.aborted === true;
      const isStartupTimeout = errorMessage.includes('SDK startup timeout');
      const isConversationNotFound = errorMessage.includes('No conversation found');
      const isMessageNotFound = errorMessage.includes('No message found');

      // Bounded provider-retry cap (read lazily so tests can override via env).
      const maxProviderRetries = getMaxProviderRetries();

      // Detect transient fetch/connection errors that escape the SDK's own retry logic.
      // These are mid-stream HTTP connection drops (network blip, server restart, timeout)
      // that should be retried rather than surfaced as raw developer-facing error strings.
      // Patterns are shared with api-error-circuit-breaker.ts via transient-error-patterns.ts.
      const isTransientConnectionError = TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.some((substr) =>
        errorMessage.includes(substr)
      );

      // Startup timeout is transient — always keep sdkSessionId so resume works.
      // Never clear sdkSessionId on timeout: the session file is valid and the
      // conversation can be resumed once the workspace lock conflict resolves.
      // Clearing it would lose the ability to resume the conversation history.
      if (isStartupTimeout && session.sdkSessionId) {
        logger.error(
          `Startup timeout with sdkSessionId (${session.sdkSessionId}). ` +
            'Keeping sdkSessionId for resume on retry.'
        );
      }
      if (isConversationNotFound && session.sdkSessionId) {
        // Do NOT auto-clear sdkSessionId here. The query-lifecycle-manager
        // already handles the missing-transcript case with a user-facing
        // sdkResumeChoice prompt ("Start Fresh" / "Leave as Is"). Silently
        // clearing here bypasses that prompt and loses context irreversibly.
        logger.error(
          `No conversation found for sdkSessionId (${session.sdkSessionId}). ` +
            'Not clearing sdkSessionId — let the user choose via sdkResumeChoice prompt.'
        );
      }
      if (isMessageNotFound) {
        // Runtime-only resumeSessionAt is one-shot and has already been consumed.
        // Retry without the rewind cutoff, but keep sdkSessionId because the SDK
        // conversation still exists; only the requested message UUID was missing.
        logger.warn(
          'No message found for one-shot resumeSessionAt; retrying without resumeSessionAt while preserving sdkSessionId.'
        );
      }

      // Auto-retry once on startup timeout — the user shouldn't have to resend.
      // This handles transient SDK startup failures (e.g., after a model switch)
      // where the second attempt succeeds reliably.
      // Skip messageQueue.clear() so queued tails survive for the retry (a
      // kickoff already spliced by MESSAGE_QUEUE_TIMEOUT_MS recovers via the
      // delivery/reset lane instead — see DEFAULT_STARTUP_TIMEOUT_MS). An
      // interrupt that raced this catch must not respawn: interrupt-handler
      // sets 'interrupted' without bumping the generation, so only this
      // status guard (not retrySupersededByReplacement / isCleaningUp) stops
      // a fresh subprocess spawning on a stopped session.
      if (
        isStartupTimeout &&
        retryAttempt === 0 &&
        !this.ctx.isCleaningUp() &&
        stateManager.getState().status !== 'interrupted'
      ) {
        logger.warn('Auto-retrying query after startup timeout (1 retry).');
        await stateManager.setIdle({ suppressDeliveryWaiters: true });

        // Ownership check BEFORE terminating: setIdle above awaited, so a
        // replacement query may already have started and registered its
        // subprocess. Terminating now would SIGTERM/SIGKILL the replacement.
        // The check→terminate sequence below is synchronous, so no replacement
        // can slip in between. (Codex P1, PR #2491.)
        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }

        // Clean-slate guard: a timed-out spawn may be orphaned (spawned but
        // never fed, or hung past cooperative close()) and would collide with
        // the retry's fresh spawn — producing repeated 0-message timeouts.
        // Force-terminate the whole tracked set for this session first, then
        // close the query object (cooperative teardown of MCP transports), so
        // the retry starts from a genuinely clean slate. Order mirrors
        // QueryLifecycleManager.stop() (terminate → close).
        this.ctx.terminateTrackedAgentProcesses?.();

        // Close the current queryObject BEFORE retrying to prevent the
        // "Already connected to a transport" crash. The finally{} block has not
        // yet run (we are still in the catch block), so MCP transports are still
        // open. Explicitly closing here ensures a clean slate for the retry.
        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {
            // Ignore close errors — transport may already be in a broken state
          }
          this.ctx.queryObject = null;
        }

        // Wait for the old subprocess to fully exit before retrying.
        // close() above terminates the process, but we must wait for it to
        // release workspace locks before spawning a replacement.
        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          // Clear only if the tracking still belongs to the old subprocess —
          // a concurrent start during the await may have installed the
          // replacement's exit promise (same race as the lifecycle manager's
          // stale-running recovery).
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        // Ownership check: a replacement query may have started during the
        // waits above (restart / delivery reclaim drove a new start). This
        // recursive call bypasses start()'s queue-running guard, so recursing
        // with a stale generation would spawn a competing query that
        // overwrites the replacement's queryObject while its stale finally{}
        // skips cleanup. Abandon the retry — the replacement owns the session.
        // (Codex P1, PR #2491.)
        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }

        // The timeout escape returns the iterator NORMALLY (non-blocking
        // cleanup), so the post-loop code already ran messageQueue.stop()
        // before this throw reached the catch. Restart it — the retry's
        // messageGenerator exits immediately while the queue is stopped, so
        // the preserved prompt would never feed the retry and it would time
        // out again. A stop by interrupt/shutdown is excluded by the checks
        // above (generation, isCleaningUp) and the status guard below.
        // (Codex P1, PR #2499.)
        if (
          !messageQueue.isRunning() &&
          !this.ctx.isCleaningUp() &&
          stateManager.getState().status !== 'interrupted'
        ) {
          messageQueue.start();
        }

        // The old SDK may have pulled prompts out of the queue via
        // messageGenerator() before going silent; restarting the queue above
        // alone leaves the retry with no input, so it times out again at zero
        // messages. Re-enqueue every recorded consumed message IN ORDER (a silent
        // iterator can pull the kickoff AND trailing steers — replaying only the
        // last would silently drop the earlier prompts whose durable rows are
        // already consumed). Mirror the transient-connection retry's feed.
        // (Codex P1, PR #2499.)
        const consumed = this._consumedUserMessages.get(queryGeneration) ?? [];
        if (consumed.length > 0) {
          logger.warn(
            `Re-enqueueing ${consumed.length} consumed user message(s) for startup-timeout retry.`
          );
          // Prepend in reverse order so the consumed prefix lands AHEAD of any
          // still-queued tail: the SDK may have pulled only a prefix (kickoff +
          // a steer) before going silent, leaving later messages untouched. A
          // plain enqueue would append the replay behind that tail and change
          // prompt order. (Codex P1, PR #2499.)
          for (let i = consumed.length - 1; i >= 0; i--) {
            const message = consumed[i];
            messageQueue
              .enqueueWithId(message.uuid, message.content, false, { prepend: true })
              .catch(() => {});
          }
          this._consumedUserMessages.delete(queryGeneration);
          this._lastConsumedUserMessage = null;
        }

        // Use `return await` so this call's finally{} runs only after the retry
        // completes. Otherwise finally{} would race the retry and can tear down
        // shared state (queue/controller/queryObject) while it is still running.
        return await this.runQuery(queryGeneration, 1, recoveryState);
      }
      if (isMessageNotFound && retryAttempt === 0 && !this.ctx.isCleaningUp()) {
        // Consume the stale resumeSessionAt before retrying. The for-await loop
        // threw before reaching the consume at line ~548, so the value is still
        // pending. Without this, peek returns the same UUID and the retry fails
        // with the same 'No message found' error.
        this.ctx.consumePendingResumeSessionAt?.();
        logger.warn('Auto-retrying query without one-shot resumeSessionAt.');
        // Clear the startup timer from THIS attempt and reset
        // firstMessageReceived so the retry's startup timer is effective
        // (mirror of the provider-retry path below). Recursive retries do NOT
        // go through start(); a stale true flag would disable the retry's
        // startup timeout, so a silent replacement spawn would sit in the
        // for-await forever — never reaching a permit release site and
        // permanently holding its startup-gate slot.
        const staleStartupTimer = this.ctx.startupTimeoutTimer;
        if (staleStartupTimer) {
          clearTimeout(staleStartupTimer);
          this.ctx.startupTimeoutTimer = null;
        }
        this.ctx.firstMessageReceived = false;
        await stateManager.setIdle({ suppressDeliveryWaiters: true });

        // Ownership check BEFORE terminating (see the startup-timeout retry).
        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }

        // Clean-slate guard (same rationale as the startup-timeout retry):
        // force-terminate any orphaned tracked subprocess so the retry spawns
        // against a clean process set.
        this.ctx.terminateTrackedAgentProcesses?.();

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {
            // Ignore close errors — transport may already be in a broken state
          }
          this.ctx.queryObject = null;
        }

        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          // Clear only if the tracking still belongs to the old subprocess
          // (see the startup-timeout retry above for the race rationale).
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        // Ownership check (see the startup-timeout retry above).
        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }
        return await this.runQuery(queryGeneration, 1, recoveryState);
      }

      // Auto-retry once on transient connection errors (mid-stream HTTP drop).
      // These are network blips that escape the SDK's own retry logic — retrying
      // the entire query is the safest recovery path.
      if (
        isTransientConnectionError &&
        !isQueryInterrupted &&
        retryAttempt === 0 &&
        !this.ctx.isCleaningUp() &&
        stateManager.getState().status !== 'interrupted'
      ) {
        logger.warn('Auto-retrying query after transient connection error (1 retry).');
        // Clear the startup timer from THIS attempt and reset
        // firstMessageReceived so the retry's startup timer is effective
        // (mirror of the provider-retry path below). This retry fires
        // mid-stream, so the flag is stale-true; without the reset a silent
        // replacement spawn would sit in the for-await forever — never
        // reaching a permit release site and permanently holding its
        // startup-gate slot, stalling every later cold-start behind it.
        const staleStartupTimer = this.ctx.startupTimeoutTimer;
        if (staleStartupTimer) {
          clearTimeout(staleStartupTimer);
          this.ctx.startupTimeoutTimer = null;
        }
        this.ctx.firstMessageReceived = false;
        await stateManager.setIdle({ suppressDeliveryWaiters: true });

        // Re-enqueue the last consumed user message so the retry has input to
        // process.  Without this, the message was already shifted out of
        // MessageQueue by messageGenerator() and the retry starts with an
        // empty queue, silently dropping the user's request.
        const lastMsg = this._lastConsumedUserMessage;
        if (lastMsg) {
          logger.warn(
            `Re-enqueueing user message ${lastMsg.uuid} for transient connection error retry.`
          );
          // Fire-and-forget: the promise resolves when the retry's generator
          // consumes the message, or rejects on timeout/interrupt (harmless).
          messageQueue.enqueueWithId(lastMsg.uuid, lastMsg.content).catch(() => {});
          this._lastConsumedUserMessage = null;
          this._consumedUserMessages.delete(queryGeneration);
        }

        // Display a sanitized retry message so the user knows what's happening,
        // but never show the raw fetch error string ("verbose: true", etc.).
        try {
          await this.displayErrorAsAssistantMessage('⚠️ The connection was interrupted. Retrying…', {
            markAsError: false,
          });
        } catch {
          // Best-effort — don't let message emission block the retry
        }

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {
            // Ignore close errors
          }
          this.ctx.queryObject = null;
        }

        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          // Clear only if the tracking still belongs to the old subprocess
          // (see the startup-timeout retry above for the race rationale).
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        // Ownership check (see the startup-timeout retry above).
        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }
        return await this.runQuery(queryGeneration, 1, recoveryState);
      }

      // Bounded retry for 5xx / overloaded / provider-unavailable errors that
      // escaped the SDK's own retry logic. These are transient server-side
      // failures that should be retried at the HyperNeo level with exponential
      // backoff before going terminal. Mirrors the transient-connection retry
      // above, but allows up to maxProviderRetries attempts with backoff.
      //
      // GUARDS:
      // - retryAttempt < maxProviderRetries caps total retries (no unbounded loop).
      // - isRetryableProviderError() excludes 4xx/auth/quota/model_not_found (terminal).
      // - 429 rate-limit errors are handled earlier by RateLimitWatchdog, not here.
      if (
        !isQueryInterrupted &&
        !this.ctx.isCleaningUp() &&
        retryAttempt < maxProviderRetries &&
        isRetryableProviderError(errorMessage)
      ) {
        const delayMs = getProviderRetryDelayMs(retryAttempt);
        logger.warn(
          `Provider error (5xx/overloaded/unavailable) detected; retrying in ${delayMs}ms ` +
            `(attempt ${retryAttempt + 1}/${maxProviderRetries}).`
        );
        // Deliberately do NOT call stateManager.setIdle() here. The existing
        // transient-connection retry (~1006) and startup-timeout retry (~931)
        // call setIdle before recursing, but those retry near-instantly. The
        // provider retry has a multi-second backoff window — calling setIdle
        // would leave the session appearing idle (turn finished) while a retry
        // is still pending. Keeping the current 'processing' state during
        // backoff is more accurate: queryPromise is still set so
        // ensureQueryStarted() won't launch a duplicate query, and state
        // observers see the turn as in-progress. The recursive runQuery's
        // message generator re-asserts 'processing' on the next yield; the
        // finally block sets 'idle' when the turn actually completes.

        // Clear the startup timer from THIS attempt. If the 5xx happened before
        // firstMessageReceived, the timer is still armed and would fire during
        // a later retry, aborting that retry's queryAbortController and turning
        // a provider retry into a spurious startup-timeout. The recursive
        // runQuery arms its own fresh timer.
        const startupTimer = this.ctx.startupTimeoutTimer;
        if (startupTimer) {
          clearTimeout(startupTimer);
          this.ctx.startupTimeoutTimer = null;
        }

        // Reset firstMessageReceived so the retry's startup timer is effective.
        // Recursive retries do NOT go through start(), so without this reset a
        // stale true value (from a system:init in the failed attempt) would
        // disable the retry's startup timeout — the session could hang forever
        // if the replacement SDK process never emits its first message.
        this.ctx.firstMessageReceived = false;

        // Save the last consumed user message for re-enqueue AFTER the backoff
        // (below). We defer the actual enqueue to just before recursing so the
        // message doesn't expire in the queue (enqueueWithId has a ~30s TTL) if
        // an operator configures a long backoff, and so a cancelled retry
        // doesn't leave an orphaned message in the queue.
        //
        // Clear _lastConsumedUserMessage IMMEDIATELY after saving so a stale
        // value can't persist if the retry is cancelled (e.g. generation bump
        // from restart) — the finally block skips cleanup for stale queries, so
        // without this clear the old replay message would survive into the next
        // turn.
        const retryMsg = this._lastConsumedUserMessage;
        this._lastConsumedUserMessage = null;
        this._consumedUserMessages.delete(queryGeneration);

        // Display a sanitized retry message so the user knows what's happening,
        // but never show the raw provider error string.
        try {
          await this.displayErrorAsAssistantMessage(
            `⚠️ The provider is temporarily unavailable. Retrying ` +
              `(attempt ${retryAttempt + 1}/${maxProviderRetries})…`,
            { markAsError: false }
          );
        } catch {
          // Best-effort — don't let message emission block the retry
        }

        // Close the current queryObject BEFORE retrying to prevent the
        // "Already connected to a transport" crash (same rationale as the
        // startup-timeout retry above).
        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {
            // Ignore close errors — transport may already be in a broken state
          }
          this.ctx.queryObject = null;
        }

        // Wait for the old subprocess to fully exit before retrying, so it
        // releases workspace locks before a replacement is spawned.
        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          // Clear only if the tracking still belongs to the old subprocess
          // (see the startup-timeout retry above for the race rationale).
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        // Restore provider env vars BEFORE the backoff sleep so process.env is
        // clean during the wait AND regardless of whether the retry proceeds or
        // is cancelled by the post-sleep re-check below. Without this, a
        // cancellation return (e.g. generation bump from restart) would skip
        // the restore, and when the finally treats this run as stale it skips
        // cleanup entirely — leaking provider routing into later sessions.
        const envVarsToRestore = this.ctx.originalEnvVars;
        if (Object.keys(envVarsToRestore).length > 0) {
          const { getProviderService: getProviderServiceForRetry } = await import(
            '../provider-service'
          );
          getProviderServiceForRetry().restoreEnvVars(envVarsToRestore);
          this.ctx.originalEnvVars = {};
        }

        // Exponential backoff before the retry attempt — gives the transient
        // provider condition time to clear. Sleeps AFTER cleanup+env-restore so
        // the subprocess-exit wait and the backoff don't compound unnecessarily;
        // the notice above was already shown to the user.
        await sleep(delayMs);

        // Re-check cancellation/generation/queue immediately before recursing.
        // The backoff window (2-8s) is long enough that the user may have
        // interrupted the turn, a restart may have called stop() (which stops
        // the queue without bumping generation or marking interrupted), or the
        // daemon may be shutting down. Without this re-check the cancelled turn
        // would relaunch an orphaned query after the sleep.
        if (
          this.ctx.isCleaningUp() ||
          !messageQueue.isRunning() ||
          this.ctx.getQueryGeneration() !== queryGeneration ||
          stateManager.getState().status === 'interrupted' ||
          this.ctx.queryAbortController?.signal.aborted === true
        ) {
          logger.warn(
            'Provider error retry cancelled: session interrupted/restarted/cleaning up during backoff.'
          );
          return;
        }

        // Re-enqueue the saved user message immediately before recursing so the
        // retry's generator has input. Enqueueing here (not earlier) avoids the
        // queue TTL expiry during long backoffs and prevents orphaned messages
        // when the retry is cancelled by the re-check above.
        if (retryMsg) {
          logger.warn(
            `Re-enqueueing user message ${retryMsg.uuid} for provider error retry ` +
              `(attempt ${retryAttempt + 1}/${maxProviderRetries}).`
          );
          messageQueue.enqueueWithId(retryMsg.uuid, retryMsg.content).catch(() => {});
          this._lastConsumedUserMessage = null;
          this._consumedUserMessages.delete(queryGeneration);
        }

        return await this.runQuery(queryGeneration, retryAttempt + 1, recoveryState);
      }

      // Clear the queue on non-retryable errors so stale messages don't bleed into the next session.
      messageQueue.clear();

      // True when a retryable provider error (5xx/overloaded/unavailable) has
      // exhausted all bounded retry attempts and is now going terminal. Used to
      // surface a dedicated user-facing message distinct from generic SYSTEM errors.
      const isProviderRetryExhausted =
        retryAttempt >= maxProviderRetries && isRetryableProviderError(errorMessage);

      if (!isAbortError) {
        // Classify validation errors without publishing so terminal fencing can be
        // decided from the actual path: handled 4xx errors fence before rendering,
        // while cooldown-eligible errors wait for the scheduling result.
        const apiValidationError = this.parseApiValidationError(error);
        if (apiValidationError) {
          stateManager.beginTerminalIdle();
          await this.displayErrorAsAssistantMessage(apiValidationError.text, {
            markAsError: true,
          });
        }
        const apiErrorHandled = apiValidationError !== null;

        if (!apiErrorHandled) {
          let category = ErrorCategory.SYSTEM;
          const providerId = session.config.provider as string | undefined;

          // Detect provider-specific errors before general categorization
          const isProviderSession =
            providerId && providerId !== 'anthropic' && providerId !== 'glm';

          if (
            isProviderSession &&
            (errorMessage.includes('401') ||
              errorMessage.includes('403') ||
              errorMessage.includes('unauthorized') ||
              errorMessage.includes('Unauthorized') ||
              errorMessage.includes('token expired') ||
              errorMessage.includes('token_expired') ||
              errorMessage.includes('not authenticated') ||
              errorMessage.includes('invalid_api_key'))
          ) {
            category = ErrorCategory.PROVIDER_AUTH_ERROR;
          } else if (
            isProviderSession &&
            (errorMessage.includes('ECONNREFUSED') ||
              errorMessage.includes('ENOTFOUND') ||
              errorMessage.includes('EHOSTUNREACH') ||
              errorMessage.includes('service unavailable') ||
              errorMessage.includes('503') ||
              errorMessage.includes('502'))
          ) {
            category = ErrorCategory.PROVIDER_UNAVAILABLE;
          } else if (
            errorMessage.includes('401') ||
            errorMessage.includes('unauthorized') ||
            errorMessage.includes('invalid_api_key')
          ) {
            category = ErrorCategory.AUTHENTICATION;
          } else if (
            errorMessage.includes('ECONNREFUSED') ||
            errorMessage.includes('ENOTFOUND') ||
            errorMessage.includes('EHOSTUNREACH') ||
            isTransientConnectionError
          ) {
            category = ErrorCategory.CONNECTION;
          } else if (
            errorMessage.includes('429') ||
            errorMessage.includes('rate limit') ||
            errorMessage.includes('402') ||
            errorMessage.toLowerCase().includes('no quota') ||
            errorMessage.toLowerCase().includes('quota exceeded') ||
            errorMessage.toLowerCase().includes('insufficient_quota')
          ) {
            category = ErrorCategory.RATE_LIMIT;
          } else if (errorMessage.includes('timeout')) {
            category = ErrorCategory.TIMEOUT;
          } else if (errorMessage.includes('model_not_found')) {
            category = ErrorCategory.MODEL;
          } else if (
            errorMessage.includes('cannot be run as root') ||
            errorMessage.includes('dangerously-skip-permissions') ||
            errorMessage.includes('permission') ||
            errorMessage.includes('Exit code: 1')
          ) {
            category = ErrorCategory.PERMISSION;
          }

          const processingState = stateManager.getState();

          // Notify rate limit watchdog when 429 exhaustion is detected.
          // Only trigger for genuine 429 rate-limit errors, not 402/quota/billing
          // issues (which are non-retryable). Use case-insensitive matching.
          const lowerMsg = errorMessage.toLowerCase();
          // A quota-style 429 that carries a resettable timestamp is a rate/usage
          // cap, not a billing dead-end — route it to recovery so the reset
          // parser + usage-limit classification reach it (otherwise such a 429
          // is terminal-billing and onRateLimitExhausted is never called).
          const isBillingError = isNonRetryableBillingError(errorMessage);
          const is429Error =
            category === ErrorCategory.RATE_LIMIT &&
            !isBillingError &&
            (errorMessage.includes('429') || lowerMsg.includes('rate limit'));
          recoveryState.rateLimitCooldownScheduled =
            is429Error &&
            !!(await this.ctx.onRateLimitExhausted?.(errorMessage, this._lastConsumedUserMessage));
          if (!recoveryState.rateLimitCooldownScheduled) {
            stateManager.beginTerminalIdle();
          }

          // For startup timeouts / resume failures, provide actionable recovery hints.
          // Keep the hints distinct: HYPERNEO_SDK_STARTUP_TIMEOUT_MS is irrelevant to a
          // missing/corrupt session file — sdkSessionId is intentionally preserved so
          // the user can choose via sdkResumeChoice prompt.
          const startupTimeoutUserMessage = isStartupTimeout
            ? `The AI session failed to start (workspace: ${session.workspacePath ?? 'unbound'}). ` +
              `Common causes: another Claude Code session is using the same workspace, ` +
              `a stale lock file in .claude/, or the workspace is under heavy load. ` +
              `Try: closing other Claude sessions on this workspace, ` +
              `then resend your message. ` +
              `You can also increase the timeout with HYPERNEO_SDK_STARTUP_TIMEOUT_MS (current: ${STARTUP_TIMEOUT_MS}ms).`
            : isConversationNotFound
              ? `The AI session could not be resumed (workspace: ${session.workspacePath ?? 'unbound'}). ` +
                `The previous session transcript was not found — this can happen after a provider switch, ` +
                `workspace path change, or if the ~/.claude/projects/ directory was cleaned up. ` +
                `Your message history in HyperNeo is preserved; only the AI context window is reset. ` +
                `Please resend your message — you will be asked to choose whether to start a fresh session or keep the existing context.`
              : isMessageNotFound
                ? `The AI session could not resume from the previous rewind point ` +
                  `(workspace: ${session.workspacePath ?? 'unbound'}). The Claude SDK transcript no longer ` +
                  `contains that message UUID, likely after SDK compaction. Your message history in HyperNeo ` +
                  `is preserved; only the AI context window is reset. Please resend your message.`
                : isProviderRetryExhausted
                  ? `The provider is temporarily unavailable. The request was retried ` +
                    `${maxProviderRetries} time(s) without success. Please try again later.`
                  : isTransientConnectionError && retryAttempt > 0
                    ? 'Could not get a response. The connection was interrupted. Please try again.'
                    : undefined;
          // Skip error broadcast when rate-limit cooldown is scheduled —
          // the session.error event is terminal in Space workflows and would
          // prematurely mark the task as failed before the auto-retry fires.
          if (!recoveryState.rateLimitCooldownScheduled) {
            await errorManager.handleError(
              session.id,
              error as Error,
              category,
              startupTimeoutUserMessage,
              processingState,
              {
                errorMessage,
                queueSize: messageQueue.size(),
                providerId: providerId ?? 'anthropic',
                workspacePath: session.workspacePath ?? undefined,
                isRootWorkspace: !session.worktree,
                startupTimeoutMs: STARTUP_TIMEOUT_MS,
              }
            );
          }
        }
        // Skip idle transition when rate limit cooldown was scheduled —
        // the watchdog already set rate_limit_cooldown state and will
        // transition to idle when the user cancels or the retry fires.
        if (!recoveryState.rateLimitCooldownScheduled) {
          await stateManager.setIdle();
        }
      }
    } finally {
      // Admission-slot backstop: covers every non-throw exit (iterator EOF,
      // including a zero-message end) and attempts whose shared-state cleanup
      // is skipped below as stale. The permit is attempt-local, so releasing
      // it is safe even when stale — unlike the shared state guarded by
      // isStaleQuery. No-op once the first message or catch entry released it.
      releaseStartupPermit('attempt_finished');

      // Check for stale query FIRST to avoid race conditions.
      // When a query is restarted (e.g., model switch), the old query's finally block
      // must not touch shared state (abort controller, timers) that belongs to the new query.
      const isStaleQuery = this.ctx.getQueryGeneration() !== queryGeneration;

      if (!isStaleQuery) {
        // This is the current query — safe to clean up shared state

        // Clear startup timer
        const timer = this.ctx.startupTimeoutTimer;
        if (timer) {
          clearTimeout(timer);
          this.ctx.startupTimeoutTimer = null;
        }

        // Cleanup abort controller
        const abortController = this.ctx.queryAbortController;
        if (abortController) {
          abortController.abort();
          this.ctx.queryAbortController = null;
        }

        // Clear process exit tracking — the subprocess has exited (or will be
        // cleaned up by close() below). Prevents a resolved promise from a
        // previous generation being observed by stop() after a restart: without
        // this clear, a future stop() call on a new query could snapshot a stale
        // resolved promise and skip the real wait for the new subprocess's exit.
        this.ctx.resetProcessExitedPromise();

        messageQueue.stop();

        // Close and null queryObject BEFORE any async operation so that
        // concurrent stop()/interrupt() callers see null and skip their
        // own close() call. queryPromise is nulled LAST — callers awaiting
        // it exit the race only after this synchronous block has run,
        // guaranteeing they observe queryObject=null and skip the redundant
        // close().
        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {
            // Ignore close errors — subprocess may already be terminated
          }
          this.ctx.queryObject = null;
        }

        // Restore original env vars
        const originalEnvVars = this.ctx.originalEnvVars;
        if (Object.keys(originalEnvVars).length > 0) {
          const { getProviderService: getProviderServiceRestore } = await import(
            '../provider-service'
          );
          const providerServiceRestore = getProviderServiceRestore();
          providerServiceRestore.restoreEnvVars(originalEnvVars);
          this.ctx.originalEnvVars = {};
        }

        if (!this.ctx.isCleaningUp() && !recoveryState.rateLimitCooldownScheduled) {
          await stateManager.setIdle();
        }

        // Clear the last consumed user message so a stale value from this turn
        // cannot be replayed on the NEXT turn's retry path. Without this, a 5xx
        // that fires before the next turn's generator yields would re-enqueue
        // the previous turn's already-completed message.
        this._lastConsumedUserMessage = null;
        this._consumedUserMessages.delete(queryGeneration);

        // Null queryPromise last so callers awaiting it see queryObject=null.
        this.ctx.queryPromise = null;
      }
      // Stale query: skip all cleanup — new query owns shared state
    }
  }

  private getLiveSdkMcpServerNames(queryOptions: Pick<Options, 'mcpServers'>): string[] {
    return Object.entries(queryOptions.mcpServers ?? {})
      .filter(([, config]) => {
        const maybeSdk = config as { type?: unknown; instance?: unknown };
        return maybeSdk.type === 'sdk' && !!maybeSdk.instance;
      })
      .map(([name]) => name)
      .sort();
  }

  private async ensureSpaceChatMcpInvariant(queryOptions: Options): Promise<Options> {
    const { session, logger } = this.ctx;
    if (session.type !== 'space_chat') return queryOptions;

    const serverNames = Object.keys(queryOptions.mcpServers ?? {}).sort();
    const missingServers = REQUIRED_SPACE_CHAT_MCP_SERVERS.filter(
      (name) => !serverNames.includes(name)
    );
    if (missingServers.length === 0) return queryOptions;

    const payload = {
      event: 'space_chat.mcp.missing',
      sessionId: session.id,
      spaceId: session.context?.spaceId,
      sessionType: session.type,
      requiredServers: REQUIRED_SPACE_CHAT_MCP_SERVERS,
      requiredTools: REQUIRED_SPACE_CHAT_COORDINATION_TOOLS,
      missingServers,
      presentServers: serverNames,
      liveSdkServers: this.getLiveSdkMcpServerNames(queryOptions),
      selfHealAttempted: !!this.ctx.onMissingSpaceChatMcpServers,
    };

    logger.error(
      `QueryRunner.start(): Space chat session ${session.id} is MISSING required MCP servers. ` +
        `Missing: [${missingServers.join(', ')}]. Present: [${serverNames.join(', ')}]. ` +
        `This would remove Space coordination tools after compaction/resume. ${JSON.stringify(payload)}`
    );

    if (this.ctx.onMissingSpaceChatMcpServers) {
      await this.ctx.onMissingSpaceChatMcpServers(session.id, missingServers);
      const rebuilt = await this.ctx.optionsBuilder.build();
      const repairedOptions = this.ctx.optionsBuilder.addSessionStateOptions(rebuilt);
      const repairedServerNames = Object.keys(repairedOptions.mcpServers ?? {});
      const stillMissing = REQUIRED_SPACE_CHAT_MCP_SERVERS.filter(
        (name) => !repairedServerNames.includes(name)
      );
      if (stillMissing.length > 0) {
        throw new Error(
          `[MCP invariant] Space chat session ${session.id} still missing required MCP servers ` +
            `after self-heal: [${stillMissing.join(', ')}]. Refusing to start a degraded ` +
            `Space Agent turn.`
        );
      }
      return repairedOptions;
    }

    throw new Error(
      `[MCP invariant] Space chat session ${session.id} missing required MCP servers: ` +
        `[${missingServers.join(', ')}]. Refusing to start a degraded Space Agent turn. ` +
        `Expected coordination tools: ${REQUIRED_SPACE_CHAT_COORDINATION_TOOLS.join(', ')}.`
    );
  }

  /**
   * Ensure sessions owned by SpaceRuntimeService have their role-specific
   * `space-agent-tools` MCP server attached before the SDK query starts.
   *
   * This guard follows the central Space MCP session policy instead of inferring
   * ownership from broad Space context or session ID shape. Workflow workers are
   * guarded separately above because TaskAgentManager owns their node-agent and
   * workflow-scoped space-agent-tools attachment.
   */
  private async ensureMemberSpaceMcpInvariant(queryOptions: Options): Promise<Options> {
    const { session, logger } = this.ctx;
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: this.ctx.db.getNodeExecutionRepo(),
      taskRepo: this.ctx.db.getSpaceTaskRepo(),
    });
    if (!policy.attachGenericSpaceTools && !policy.attachLongTermAgentTools) return queryOptions;

    const serverNames = Object.keys(queryOptions.mcpServers ?? {}).sort();
    const missingServers = missingMcpServers(
      queryOptions.mcpServers as Record<string, unknown> | undefined,
      policy.requiredServers
    );
    if (missingServers.length === 0) return queryOptions;

    const payload = {
      event: 'member_space.mcp.missing',
      sessionId: session.id,
      spaceId: policy.spaceId,
      sessionType: session.type,
      role: policy.role,
      owner: policy.owner,
      requiredServers: policy.requiredServers,
      missingServers,
      presentServers: serverNames,
      liveSdkServers: this.getLiveSdkMcpServerNames(queryOptions),
      selfHealAttempted: !!this.ctx.onMissingMemberSpaceMcpServers,
    };

    logger.error(
      `QueryRunner.start(): Space member session ${session.id} is MISSING required MCP servers. ` +
        `Missing: [${missingServers.join(', ')}]. Present: [${serverNames.join(', ')}]. ` +
        `This would remove Space coordination tools after cache eviction / DB reload. ${JSON.stringify(payload)}`
    );

    if (this.ctx.onMissingMemberSpaceMcpServers) {
      await this.ctx.onMissingMemberSpaceMcpServers(session.id, missingServers);
      const rebuilt = await this.ctx.optionsBuilder.build();
      const repairedOptions = this.ctx.optionsBuilder.addSessionStateOptions(rebuilt);
      const stillMissing = missingMcpServers(
        repairedOptions.mcpServers as Record<string, unknown> | undefined,
        policy.requiredServers
      );
      if (stillMissing.length > 0) {
        throw new Error(
          `[MCP invariant] Space member session ${session.id} still missing required MCP servers ` +
            `after self-heal: [${stillMissing.join(', ')}]. Refusing to start a degraded ` +
            `Space member turn.`
        );
      }
      return repairedOptions;
    }

    throw new Error(
      `[MCP invariant] Space member session ${session.id} missing required MCP servers: ` +
        `[${missingServers.join(', ')}]. Refusing to start a degraded Space member turn.`
    );
  }

  /**
   * True when a replacement query took ownership while an auto-retry path was
   * awaiting (restart / delivery reclaim drove a new start, bumping the query
   * generation). The retry's recursive runQuery() call bypasses start()'s
   * queue-running guard, so recursing with a stale generation would spawn a
   * competing query that overwrites the replacement's queryObject while its
   * stale finally{} skips cleanup — the caller must abandon the retry.
   * (Codex P1, PR #2491.)
   */
  private retrySupersededByReplacement(queryGeneration: number): boolean {
    if (this.ctx.getQueryGeneration() === queryGeneration) return false;
    this.ctx.logger.warn('Auto-retry abandoned: a replacement query owns the session.');
    // The superseded generation's startup-replay history must not be inherited
    // by the replacement: if it also times out, replaying the superseded query's
    // prompts would duplicate an earlier request / rerun its tools.
    // (Codex P2, PR #2499.)
    this._consumedUserMessages.delete(queryGeneration);
    return true;
  }

  /**
   * Create wrapper for MessageQueue's AsyncGenerator
   * Public for testing
   */
  async *createMessageGeneratorWrapper(queryGeneration: number) {
    const { session, messageQueue, stateManager, logger } = this.ctx;

    for await (const { message, onSent } of messageQueue.messageGenerator(session.id)) {
      const queuedMessage = message as typeof message & { internal?: boolean };
      const isInternal = queuedMessage.internal || false;

      if (!isInternal) {
        await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
        // Track the last consumed non-internal message so the transient
        // connection error retry can re-enqueue it.  The message has
        // already been shifted out of MessageQueue by messageGenerator(),
        // so without re-enqueue the retry starts with an empty queue and
        // the user's request is silently dropped.
        this._lastConsumedUserMessage = {
          uuid: message.uuid ?? '',
          content: (message.message?.content ?? '') as unknown as string | MessageContent[],
        };
        // Accumulate the full ordered set of consumed messages for THIS
        // generation's startup-timeout replay (see _consumedUserMessages). Stop
        // collecting once the generation has produced its first SDK frame — the
        // startup timer is then disabled and later messages are a healthy turn's
        // inputs, not something a startup retry would need to replay. Without
        // this, a long-lived session rebuilds the list on every prompt/steer and
        // re-introduces unbounded full-content retention. (Codex P2, PR #2499.)
        if (!this.ctx.firstMessageReceived) {
          const generationMessages = this._consumedUserMessages.get(queryGeneration) ?? [];
          generationMessages.push({
            uuid: message.uuid ?? '',
            content: (message.message?.content ?? '') as unknown as string | MessageContent[],
          });
          this._consumedUserMessages.set(queryGeneration, generationMessages);
        }
      }

      // Delivery observability: this yield is the moment the kickoff actually
      // reaches the CLI's stdin. When a 0-message startup timeout is later
      // diagnosed, this line distinguishes "feed never happened" (absent) from
      // "fed but CLI silent" (present, followed by no SDK output).
      logger.debug(
        `delivery-feed: yielding message to SDK transport (session=${session.id} ` +
          `uuid=${message.uuid ?? 'unknown'} queueSizeAfter=${messageQueue.size()} ` +
          `internal=${isInternal})`
      );

      yield message;
      onSent();
    }
  }

  /**
   * Handle incoming SDK message
   * Public for testing
   */
  async handleSDKMessage(message: SDKMessage): Promise<void> {
    // Delegate to callback
    await this.ctx.onSDKMessage(message);
    await this.ctx.onMarkApiSuccess(message);
  }

  /**
   * Create an abortable async iterator wrapper
   * Public for testing
   */
  async *createAbortableQuery(
    queryObj: QueryLike,
    signal: AbortSignal
  ): AsyncGenerator<unknown, void, unknown> {
    const iterator = queryObj[Symbol.asyncIterator]();
    const abortResult = { aborted: true } as const;
    let resolveAbort!: (value: typeof abortResult) => void;
    const abortPromise = new Promise<typeof abortResult>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = () => resolveAbort(abortResult);

    let abortWonPendingNext = false;
    try {
      if (signal.aborted) {
        abortWonPendingNext = true;
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      while (!signal.aborted) {
        const nextPromise = iterator.next();
        const result = await Promise.race([nextPromise, abortPromise]);

        if ('aborted' in result || signal.aborted) {
          abortWonPendingNext = true;
          break;
        }

        if (result.done) {
          break;
        }

        yield result.value;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        const cleanup = iterator.return?.();
        if (cleanup) {
          if (abortWonPendingNext) {
            // Async iterators may serialize return() behind the unresolved next().
            // Cleanup is still requested, but startup recovery must not await it.
            void cleanup.catch(() => {});
          } else {
            await cleanup;
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Parse API validation errors (400-level) without side effects. Keeping parsing
   * synchronous lets the caller establish terminal fencing before rendering.
   */
  private parseApiValidationError(error: unknown): { text: string } | null {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Decline genuine 429 rate-limit errors so they fall through to recovery.
    if (looksLikeRateLimit429(errorMessage)) return null;

    // JSON-body 4xx. Depending on where the Claude SDK raises it,
    // this can arrive as either `402 {...}` or `API Error: 402 {...}`.
    const apiErrorMatch = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);
    if (apiErrorMatch) {
      const [, statusCode, jsonBody] = apiErrorMatch;
      try {
        const errorBody = JSON.parse(jsonBody) as {
          type?: string;
          error?: { type?: string; message?: string };
        };
        const apiErrorMessage = errorBody.error?.message || errorMessage;
        const apiErrorType = errorBody.error?.type || 'api_error';
        return {
          text: `**API Error (${statusCode})**: ${apiErrorType}\n\n${apiErrorMessage}\n\nThis error occurred while processing your request. Please review the error message above and adjust your request accordingly.`,
        };
      } catch {
        return null;
      }
    }

    // Plain-text 4xx (e.g. Copilot returns "402 You have no quota (Request ID: ...)")
    const plainErrorMatch = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(.+)$/s);
    if (plainErrorMatch) {
      const [, statusCode, plainMessage] = plainErrorMatch;
      return {
        text: `**API Error (${statusCode})**: ${plainMessage.trim()}\n\nThis error occurred while processing your request.`,
      };
    }

    // JSON SSE error event (e.g. from Copilot bridge).
    try {
      const parsed = JSON.parse(errorMessage) as {
        type?: string;
        error?: { type?: string; message?: string };
      };
      const innerMessage = parsed?.error?.message;
      if (typeof innerMessage === 'string') {
        const innerMatch = innerMessage.match(/^(4\d{2})\s+(.+)$/s);
        if (innerMatch) {
          const [, statusCode, plainMessage] = innerMatch;
          return {
            text: `**API Error (${statusCode})**: ${plainMessage.trim()}\n\nThis error occurred while processing your request.`,
          };
        }
      }
    } catch {
      // not JSON
    }

    return null;
  }

  /**
   * Display error as assistant message
   */
  async displayErrorAsAssistantMessage(
    text: string,
    options?: { markAsError?: boolean }
  ): Promise<void> {
    const { session, db, messageHub } = this.ctx;

    const assistantMessage = {
      type: 'assistant' as const,
      uuid: generateUUID() as UUID,
      session_id: session.id,
      parent_tool_use_id: null,
      ...(options?.markAsError ? { error: 'invalid_request' as const } : {}),
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text, citations: null }],
      },
    } as unknown as SDKMessage;

    db.saveSDKMessage(session.id, assistantMessage);

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [assistantMessage], timestamp: Date.now() },
      { channel: `session:${session.id}` }
    );
  }
}
