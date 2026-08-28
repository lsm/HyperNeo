import { spawn as nodeSpawn } from 'node:child_process';
import type {
  HookCallback,
  Options,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { Database } from '../../storage/database.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { ErrorCategory, type ErrorManager } from '../error-manager.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Logger } from '../logger.ts';
import type { OriginalEnvVars, ProviderEnvVars } from '../provider-service.ts';
import { NON_ANTHROPIC_PREFIX_PROVIDER_VARS } from '../provider-service.ts';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
  SPACE_COORDINATOR_REQUIRED_MCP_SERVERS,
  SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS,
} from '../space/runtime/space-mcp-session-policy.ts';
import type { AgentSession } from './agent-session.ts';
import type { AskUserQuestionHandler } from './ask-user-question-handler.ts';
import { assessLimitError, type LimitRetryHint } from './limit-error-classifier.ts';
import { drainDeliveryWaitersOnTerminalSDKMessage } from './message-delivery.ts';
import type { MessageQueue } from './message-queue.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import { QueryAttemptRegistry, type QueryAttemptToken } from './query-attempt-token.ts';
import type { QueryLike } from './query-like.ts';
import type { QueryOptionsBuilder } from './query-options-builder.ts';
import {
  decideQueryRetry,
  type QueryRetryEnvironment,
  type QueryRetryErrorSignal,
  type QueryRetryRoute,
} from './query-retry-routing.ts';
import type { SDKMessageHandler } from './sdk-message-handler.ts';
import { getSdkStartupGate, type SdkStartupPermit } from './sdk-startup-gate.ts';
import { isMeaningfulSdkStartupProgress } from './sdk-startup-progress.ts';
import {
  isRetryableProviderError,
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
} from './transient-error-patterns.ts';

export type { OriginalEnvVars } from '../provider-service.ts';

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
    detached: process.platform !== 'win32',
  });
  return proc as unknown as SpawnedProcess;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60000;
const RETRY_EXIT_TIMEOUT_MS = 5000;

function getStartupTimeoutMs(): number {
  const raw = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
  if (!raw) return DEFAULT_STARTUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

const STARTUP_TIMEOUT_MS = getStartupTimeoutMs();

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

function getProviderRetryDelayMs(attempt: number): number {
  return getProviderRetryBaseDelayMs() * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function looksLikeRateLimit429(errorMessage: string): boolean {
  if (!errorMessage) return false;
  if (/^(?:Error:\s*)?(?:API Error:\s*)?429\b/i.test(errorMessage)) return true;
  try {
    const jsonMessage = errorMessage.replace(/^Error:\s*/, '');
    const parsed = JSON.parse(jsonMessage) as { error?: { message?: string } };
    const inner = parsed?.error?.message;
    if (typeof inner === 'string' && /^429\b/.test(inner)) return true;
  } catch {}
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
interface RetryTeardownState {
  snapshotMsg: { uuid: string; content: string | MessageContent[] } | null;
}

interface RetryTeardownOptions {
  nextAttempt: number;
  recoveryState: { rateLimitCooldownScheduled: boolean };
  resetStartupState?: boolean;
  idleFirst?: boolean;
  routeGuard?: {
    expectedAction: QueryRetryRoute['action'];
    retrySignal: QueryRetryErrorSignal;
    retryEnv: QueryRetryEnvironment;
    queueRunningAtEntry: boolean;
    abandonLabel: string;
  };
  terminateProcesses?: boolean;
  requeueLastConsumedFor?: string;
  snapshotLastConsumed?: boolean;
  notice?: string;
  guardAfterExit?: boolean;
  restartQueueIfStopped?: boolean;
  requeueConsumedList?: boolean;
  noticeAfterTeardown?: string;
  backoffMs?: number;
  snapshotRequeueLabel?: string;
}

export interface QueryRunnerContext {
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

  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;
  queryAbortController: AbortController | null;
  firstMessageReceived: boolean;
  startupTimeoutTimer: ReturnType<typeof setTimeout> | null;
  originalEnvVars: OriginalEnvVars;
  processExitedPromise: Promise<void> | null;
  resetProcessExitedPromise(): void;
  trackAgentProcess(proc: TrackedAgentProcess): void;
  snapshotTrackedAgentProcesses(): Array<[number, TrackedAgentProcess]>;
  terminateTrackedAgentProcesses(options?: {
    forceDelayMs?: number;
    processes?: Array<[number, TrackedAgentProcess]>;
  }): void;
  incrementQueryGeneration(): number;
  getQueryGeneration(): number;
  isCleaningUp(): boolean;
  attemptTokens: QueryAttemptRegistry;

  onSDKMessage(
    message: SDKMessage,
    queuedMessages?: SDKMessage[],
    runnerGeneration?: number
  ): Promise<void>;
  onSlashCommandsFetched(): Promise<void>;
  onModelsFetched(): Promise<void>;
  onMarkApiSuccess(message: SDKMessage, queryGeneration?: number): Promise<void>;

  onMissingWorkflowMcpServers?: (session: AgentSession, missing: string[]) => Promise<void>;

  onMissingSpaceChatMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  onMissingMemberSpaceMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  consumePendingResumeSessionAt?(): string | undefined;

  onRateLimitExhausted?: (
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    hint?: LimitRetryHint,
    queryGeneration?: number
  ) => Promise<boolean>;

  isLimitRecoveryPending?(): boolean;
}

export class QueryRunner {
  private _lastConsumedUserMessage: {
    uuid: string;
    content: string | MessageContent[];
  } | null = null;

  private _consumedUserMessages = new Map<
    number,
    Array<{ uuid: string; content: string | MessageContent[] }>
  >();

  private _turnConsumedUserMessages: Array<{ uuid: string; content: string | MessageContent[] }> =
    [];

  get lastConsumedUserMessage() {
    return this._lastConsumedUserMessage;
  }

  resolveRetryUserMessage(
    userMessageUuid?: string
  ): { uuid: string; content: string | MessageContent[] } | null {
    if (userMessageUuid) {
      for (let i = this._turnConsumedUserMessages.length - 1; i >= 0; i--) {
        const entry = this._turnConsumedUserMessages[i];
        if (entry.uuid === userMessageUuid) return entry;
      }
      for (const messages of this._consumedUserMessages.values()) {
        const found = messages.find((entry) => entry.uuid === userMessageUuid);
        if (found) return found;
      }
      return null;
    }
    return this._lastConsumedUserMessage;
  }

  constructor(private ctx: QueryRunnerContext) {}

  private queryLiveness: { promise: Promise<void>; isLive: () => boolean } | null = null;

  private hasLiveQuery(): boolean {
    const queryPromise = this.ctx.queryPromise;
    if (!queryPromise) return false;
    const tracked = this.queryLiveness;
    if (tracked && tracked.promise === queryPromise) return tracked.isLive();
    return true;
  }

  async start(): Promise<void> {
    const { messageQueue, logger } = this.ctx;

    if (messageQueue.isRunning()) {
      if (this.hasLiveQuery()) {
        logger.warn(
          `QueryRunner.start(): messageQueue already running for session ${this.ctx.session.id}, ` +
            `skipping start (generation=${messageQueue.getGeneration()}, ` +
            `queryPromise=active)`
        );
        return;
      }
      const orphanedProcesses = this.ctx.snapshotTrackedAgentProcesses();
      const stalePids = orphanedProcesses.map(([pid]) => pid).join(',');
      logger.warn(
        `QueryRunner.start(): stale running messageQueue for session ${this.ctx.session.id} ` +
          `(generation=${messageQueue.getGeneration()}, queryPromise=${
            this.ctx.queryPromise ? 'settled' : 'null'
          }, trackedPids=[${stalePids}] queueSize=${messageQueue.size()}) — ` +
          `no live query behind it; force-stopping the queue and starting a fresh query`
      );
      messageQueue.stop();
      this.ctx.queryObject = null;
      this.ctx.terminateTrackedAgentProcesses({
        forceDelayMs: 2000,
        processes: orphanedProcesses,
      });
    }

    logger.debug(
      `QueryRunner.start(): starting query for session ${this.ctx.session.id} ` +
        `(generation=${messageQueue.getGeneration()})`
    );
    messageQueue.start();

    const currentGeneration = this.ctx.incrementQueryGeneration();

    this.ctx.firstMessageReceived = false;

    const queryPromise = this.runQuery(currentGeneration);
    let queryLive = true;
    queryPromise.then(
      () => {
        queryLive = false;
      },
      () => {
        queryLive = false;
      }
    );
    this.queryLiveness = { promise: queryPromise, isLive: () => queryLive };
    this.ctx.queryPromise = queryPromise;
  }

  private async applyDeferredPermissionMode(
    queryObject: QueryLike,
    deferredPermissionMode: string | undefined,
    attemptTimeoutMs = 8000,
    backoffBaseMs = 250
  ): Promise<void> {
    if (!deferredPermissionMode || !queryObject.setPermissionMode) return;
    const { session, logger } = this.ctx;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const liveMode = this.ctx.optionsBuilder.getCurrentPermissionMode?.();
      if (liveMode !== undefined && liveMode !== deferredPermissionMode) {
        logger.debug(
          `QueryRunner.start: deferred permission mode switch for session ` +
            `${session.id} aborted — desired mode is now '${liveMode}' ` +
            `(was '${deferredPermissionMode}' at capture)`
        );
        return;
      }
      try {
        const attemptPromise = queryObject.setPermissionMode(deferredPermissionMode);
        attemptPromise.catch(() => {});
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            attemptPromise,
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error(`no response within ${attemptTimeoutMs}ms`)),
                attemptTimeoutMs
              );
            }),
          ]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
        return;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (this.ctx.queryObject !== queryObject) {
          logger.debug(
            `QueryRunner.start: deferred permission mode switch for session ` +
              `${session.id} aborted on attempt ${attempt} — query object ` +
              `replaced/closed (${detail}); the replacement spawn re-applies it.`
          );
          return;
        }
        if (attempt === maxAttempts) {
          logger.error(
            `QueryRunner.start: failed to apply deferred permission mode ` +
              `'${deferredPermissionMode}' for session ${session.id} after ` +
              `${maxAttempts} attempts: ${detail}. The session keeps the intake ` +
              `state (allowDangerouslySkipPermissions keeps permission decisions ` +
              `host-managed via canUseTool allow-all). The mode is re-applied on ` +
              `the next query spawn.`
          );
          return;
        }
        logger.warn(
          `QueryRunner.start: deferred permission mode ` +
            `'${deferredPermissionMode}' for session ${session.id} failed on ` +
            `attempt ${attempt}/${maxAttempts}: ${detail}; retrying`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffBaseMs * attempt));
      }
    }
  }

  invalidateAttemptTokens(): void {
    this.ctx.attemptTokens.invalidateCurrent();
  }

  private createAttemptBoundPreToolUseHook(attemptToken: QueryAttemptToken): HookCallback {
    const hook = this.ctx.askUserQuestionHandler.createPreToolUseHook();
    return async (input, toolUseID, options) => {
      if (attemptToken.isLive()) return hook(input, toolUseID, options);
      const { session, logger } = this.ctx;
      logger.warn(
        `PreToolUse hook: denying callback from superseded query attempt ` +
          `${attemptToken.attemptId} (session=${session.id}) — a retry or replacement owns the run`
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            'The query attempt that issued this tool call was superseded by an automatic retry ' +
            'or a replacement query.',
        },
      };
    };
  }

  private async runQuery(
    queryGeneration: number,
    retryAttempt = 0,
    recoveryState = { rateLimitCooldownScheduled: false }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;

    const attemptToken =
      this.ctx.getQueryGeneration() === queryGeneration
        ? this.ctx.attemptTokens.allocate()
        : QueryAttemptRegistry.detached();
    const attemptHook = this.createAttemptBoundPreToolUseHook(attemptToken);

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

    let runAbortController: AbortController | null = null;
    let isAbortError = false;

    try {
      const { initializeProviders, waitForOptionalProviderRegistration } = await import(
        '../providers/factory.js'
      );
      const providerRegistry = initializeProviders();
      await waitForOptionalProviderRegistration();
      const modelId = session.config.model || 'sonnet';
      const explicitProviderId = session.config.provider as string | undefined;
      const provider = explicitProviderId
        ? providerRegistry.detectProviderForModel(modelId, explicitProviderId)
        : providerRegistry.get('anthropic');

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
      if (provider?.getAuthStatus) {
        const authStatus = await provider.getAuthStatus();
        if (authStatus.needsRefresh) {
          logger.warn(
            `Provider ${provider.displayName} token needs refresh. Attempting to continue.`
          );
        }
      }

      if (!provider?.isAvailable) {
        const { getProviderService } = await import('../provider-service.ts');
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

      if (session.workspacePath) {
        const fs = await import('fs/promises');
        await fs.mkdir(session.workspacePath, { recursive: true });
      }

      optionsBuilder.setCanUseTool(this.ctx.askUserQuestionHandler.createCanUseToolCallback());
      let queryOptions = await optionsBuilder.build({ askUserQuestionHook: attemptHook });

      if (provider?.setSessionThinkingConfig) {
        const effectiveThinkingLevel = optionsBuilder.getEffectiveThinkingLevel();
        provider.setSessionThinkingConfig(session.id, effectiveThinkingLevel);
      }

      queryOptions = optionsBuilder.addSessionStateOptions(queryOptions);

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

      queryOptions = await this.ensureSpaceChatMcpInvariant(queryOptions, attemptHook);
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

          if (this.ctx.onMissingWorkflowMcpServers) {
            try {
              await this.ctx.onMissingWorkflowMcpServers(this.ctx as AgentSession, missingServers);
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

          queryOptions = await optionsBuilder.build({ askUserQuestionHook: attemptHook });
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

      queryOptions = await this.ensureMemberSpaceMcpInvariant(queryOptions, attemptHook);

      const resolvedProviderId = explicitProviderId ?? provider?.id ?? 'anthropic';
      const refreshAutoCompactWindow = true;
      let extraProviderManagedEnvVars: string[] = [];
      {
        const { getProviderService } = await import('../provider-service.ts');
        const providerService = getProviderService();
        const providerSession = {
          ...session,
          config: {
            ...session.config,
            model: modelId,
            provider: resolvedProviderId as Session['config']['provider'],
          },
        };
        await providerService.ensureSessionProviderBridges(providerSession);
        const providerEnvVars = providerService.getProviderEnvVars(providerSession);
        extraProviderManagedEnvVars = NON_ANTHROPIC_PREFIX_PROVIDER_VARS.filter(
          (key) => providerEnvVars[key] !== undefined
        );
        applyProviderEnvToFlagSettings(queryOptions, providerEnvVars);
        const originalEnvVars = providerService.applyEnvVarsToProcessForSession(providerSession);
        this.ctx.originalEnvVars = originalEnvVars;
      }

      queryOptions.env = refreshQueryEnvFromProcess(queryOptions.env, process.env, {
        refreshAutoCompactWindow,
        clearProviderManaged: true,
        preserveAnthropicAuthToken: resolvedProviderId === 'anthropic',
        preserveAnthropicOAuthToken: resolvedProviderId === 'anthropic',
        skipAmbientAnthropicApiKey: resolvedProviderId !== 'anthropic',
        extraProviderManagedEnvVars,
      }) as Record<string, string>;

      const originalSpawn = queryOptions.spawnClaudeCodeProcess;
      queryOptions.spawnClaudeCodeProcess = (opts: SpawnOptions): SpawnedProcess => {
        const proc = (
          originalSpawn ? originalSpawn(opts) : defaultSpawn(opts)
        ) as TrackedAgentProcess;
        this.ctx.trackAgentProcess(proc);
        logger.info(
          `SDK subprocess spawned (pid=${proc.pid} session=${session.id} ` +
            `resume=${session.sdkSessionId ?? 'fresh'} model=${queryOptions.model})`
        );
        return proc;
      };

      runAbortController = new AbortController();
      this.ctx.queryAbortController = runAbortController;
      {
        const startupGate = getSdkStartupGate();
        startupPermit = await startupGate.acquire({
          sessionId: session.id,
          signal: runAbortController.signal,
        });
        if (startupPermit.queuedBehind > 0) {
          logger.info(
            `SDK startup gate: session ${session.id} admitted after waiting ` +
              `${startupPermit.waitedMs}ms behind ${startupPermit.queuedBehind} session(s) ` +
              `(gate=${JSON.stringify(startupGate.getStats())})`
          );
        }
      }
      if (
        runAbortController.signal.aborted ||
        this.ctx.isCleaningUp() ||
        this.ctx.getQueryGeneration() !== queryGeneration
      ) {
        releaseStartupPermit('aborted_while_queued');
        const gateAbort = new Error('SDK startup gate: query aborted while awaiting admission');
        gateAbort.name = 'AbortError';
        throw gateAbort;
      }

      const queryObject = query({
        prompt: this.createMessageGeneratorWrapper(queryGeneration),
        options: queryOptions,
      });
      this.ctx.queryObject = queryObject;

      void this.applyDeferredPermissionMode(
        queryObject,
        optionsBuilder.getDeferredPermissionMode()
      ).catch((err) => {
        logger.warn(
          `QueryRunner.start: deferred permission mode switch failed for session ${session.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      });

      if (session.config.provider !== 'acp') {
        const effectiveMcpServers = optionsBuilder.getEffectiveMcpServers() ?? {};
        void queryObject.setMcpServers?.(effectiveMcpServers).catch((err) => {
          logger.warn(
            `QueryRunner.start: post-start MCP reconcile failed for session ${session.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        });
      }

      const queryStartTime = Date.now();
      let startupTimeoutReached = false;
      let startupProgressSeen = false;

      const startupTimer = setTimeout(() => {
        if (!startupProgressSeen) {
          startupTimeoutReached = true;
          const elapsed = Date.now() - queryStartTime;
          const isRootWorkspace = !session.worktree;
          const workspaceDesc = isRootWorkspace
            ? `root workspace: ${session.workspacePath ?? 'unbound'}`
            : `worktree: ${session.worktree!.worktreePath}`;
          logger.error(
            `SDK startup timeout: SDK did not respond within ${elapsed}ms. ` +
              `Model: ${queryOptions.model}, ${workspaceDesc}` +
              (isRootWorkspace ? ' — running on root workspace (not a worktree)' : '') +
              ` The SDK subprocess did not emit its first message within the startup window; ` +
              `concurrent cold-start load is bounded by the startup gate.` +
              ` (Hint: set HYPERNEO_SDK_STARTUP_TIMEOUT_MS to increase timeout, currently ${STARTUP_TIMEOUT_MS}ms)`
          );
          logger.error(
            `SDK startup timeout diagnostics: queueRunning=${messageQueue.isRunning()} ` +
              `queueSize=${messageQueue.size()} trackedPids=[${this.ctx
                .snapshotTrackedAgentProcesses()
                .map(([pid]) => pid)
                .join(',')}] sdkSessionId=${session.sdkSessionId ?? 'none'}`
          );

          if (runAbortController && !runAbortController.signal.aborted) {
            runAbortController.abort();
          }
        }
      }, STARTUP_TIMEOUT_MS);
      this.ctx.startupTimeoutTimer = startupTimer;

      this.ctx.onModelsFetched().catch((e) => {
        logger.warn('Background fetch of models failed:', e);
      });

      if (!queryObject) {
        throw new Error('Query object is null after initialization');
      }

      for await (const message of this.createAbortableQuery(
        queryObject,
        runAbortController.signal
      )) {
        if (startupTimeoutReached && !startupProgressSeen) {
          throw new Error('SDK startup timeout - query aborted');
        }

        if (!startupProgressSeen && isMeaningfulSdkStartupProgress(message as SDKMessage)) {
          startupProgressSeen = true;
          const timer = this.ctx.startupTimeoutTimer;
          if (timer) {
            clearTimeout(timer);
            this.ctx.startupTimeoutTimer = null;
          }
          releaseStartupPermit('first_message');
          this.ctx.firstMessageReceived = true;
          this._consumedUserMessages.delete(queryGeneration);
        }

        try {
          await this.handleSDKMessage(message as SDKMessage, queryGeneration);
        } catch (error) {
          await this.handleStreamMessageError(
            message as SDKMessage,
            error,
            queryGeneration,
            attemptToken
          );
        }
      }

      if (
        this.ctx.getQueryGeneration() === queryGeneration &&
        !(startupTimeoutReached && !startupProgressSeen)
      ) {
        this.ctx.consumePendingResumeSessionAt?.();
      }

      if (this.ctx.getQueryGeneration() === queryGeneration) {
        messageQueue.stop();
      }

      if (startupTimeoutReached && !startupProgressSeen) {
        throw new Error('SDK startup timeout - query aborted');
      }
    } catch (error) {
      logger.error('Streaming query error:', error);

      releaseStartupPermit('query_error');

      const errorMessage = String(error);
      isAbortError = error instanceof Error && error.name === 'AbortError';
      const isQueryInterrupted =
        isAbortError ||
        stateManager.getState().status === 'interrupted' ||
        this.ctx.queryAbortController?.signal.aborted === true;
      const isStartupTimeout = errorMessage.includes('SDK startup timeout');
      const isConversationNotFound = errorMessage.includes('No conversation found');
      const isMessageNotFound = errorMessage.includes('No message found');

      const maxProviderRetries = getMaxProviderRetries();

      const isTransientConnectionError = TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.some((substr) =>
        errorMessage.includes(substr)
      );

      const providerId = session.config.provider as string | undefined;
      const isProviderSession = providerId && providerId !== 'anthropic' && providerId !== 'glm';
      const limitAssessment = assessLimitError({ rawText: errorMessage });
      const retrySignal: QueryRetryErrorSignal = {
        rawText: errorMessage,
        errorName: error instanceof Error ? error.name : undefined,
        isStartupTimeout,
        isConversationNotFound,
        isMessageNotFound,
        isTransientConnectionError,
        isRetryableProviderError: isRetryableProviderError(errorMessage),
        isRateLimit: limitAssessment.isLimit,
        rateLimitHint: limitAssessment.isLimit
          ? {
              resetAtMs: limitAssessment.resetAtMs,
              kind: limitAssessment.kind,
              billingTerminal: limitAssessment.billingTerminal,
            }
          : null,
        apiValidationText: this.parseApiValidationError(error)?.text ?? null,
      };
      const retryEnv: QueryRetryEnvironment = {
        attempt: retryAttempt,
        maxProviderRetries,
        providerFamily: isProviderSession ? 'provider' : 'anthropic',
        hasConsumedPrompt: (this._consumedUserMessages.get(queryGeneration)?.length ?? 0) > 0,
        hasQueuedPrompt: messageQueue.size() > 0,
        lifecycle: {
          processingStatus: stateManager.getState().status,
          abortSignalAborted: this.ctx.queryAbortController?.signal.aborted === true,
          isLimitRecoveryPending: this.ctx.isLimitRecoveryPending?.() ?? false,
        },
        isCleaningUp: this.ctx.isCleaningUp(),
        isSuperseded: this.ctx.getQueryGeneration() !== queryGeneration,
        hasRateLimitHandoff: !!this.ctx.onRateLimitExhausted,
        recoveryState,
      };
      const routeDecision = decideQueryRetry({ errorSignal: retrySignal, env: retryEnv });
      const queueRunningAtEntry = messageQueue.isRunning();

      if (
        routeDecision.route.action === 'superseded_noop' ||
        routeDecision.route.action === 'cleanup_noop'
      ) {
        return;
      }

      if (isStartupTimeout && session.sdkSessionId) {
        logger.error(
          `Startup timeout with sdkSessionId (${session.sdkSessionId}). ` +
            'Keeping sdkSessionId for resume on retry.'
        );
      }
      if (isConversationNotFound && session.sdkSessionId) {
        logger.error(
          `No conversation found for sdkSessionId (${session.sdkSessionId}). ` +
            'Not clearing sdkSessionId — let the user choose via sdkResumeChoice prompt.'
        );
      }
      if (isMessageNotFound) {
        logger.warn(
          'No message found for one-shot resumeSessionAt; retrying without resumeSessionAt while preserving sdkSessionId.'
        );
      }

      if (
        isStartupTimeout &&
        retryAttempt === 0 &&
        !retryEnv.hasConsumedPrompt &&
        !retryEnv.hasQueuedPrompt
      ) {
        logger.warn(
          'SDK startup timeout with no consumed or queued prompt: skipping the one-shot ' +
            'retry — a fresh attempt could not deliver anything.'
        );
      }

      if (routeDecision.route.action === 'startup_timeout_retry') {
        logger.warn('Auto-retrying query after startup timeout (1 retry).');
        return await this.runRetryTeardown(queryGeneration, attemptToken, {
          nextAttempt: 1,
          recoveryState,
          idleFirst: true,
          routeGuard: {
            expectedAction: 'startup_timeout_retry',
            retrySignal,
            retryEnv,
            queueRunningAtEntry,
            abandonLabel: 'Startup-timeout retry',
          },
          terminateProcesses: true,
          guardAfterExit: true,
          restartQueueIfStopped: true,
          requeueConsumedList: true,
          noticeAfterTeardown:
            `⚠️ The AI session is slow to start — no response after ` +
            `${Math.round(STARTUP_TIMEOUT_MS / 1000)}s. Retrying once…`,
        });
      }
      if (routeDecision.route.action === 'message_not_found_retry') {
        this.ctx.consumePendingResumeSessionAt?.();
        logger.warn('Auto-retrying query without one-shot resumeSessionAt.');
        return await this.runRetryTeardown(queryGeneration, attemptToken, {
          nextAttempt: 1,
          recoveryState,
          resetStartupState: true,
          idleFirst: true,
          routeGuard: {
            expectedAction: 'message_not_found_retry',
            retrySignal,
            retryEnv,
            queueRunningAtEntry,
            abandonLabel: 'Message-not-found retry',
          },
          terminateProcesses: true,
          guardAfterExit: true,
        });
      }

      if (
        isTransientConnectionError &&
        !isQueryInterrupted &&
        retryAttempt === 0 &&
        !this.ctx.isCleaningUp() &&
        stateManager.getState().status !== 'interrupted'
      ) {
        logger.warn('Auto-retrying query after transient connection error (1 retry).');
        return await this.runRetryTeardown(queryGeneration, attemptToken, {
          nextAttempt: 1,
          recoveryState,
          resetStartupState: true,
          idleFirst: true,
          requeueLastConsumedFor: 'transient connection error retry',
          notice: '⚠️ The connection was interrupted. Retrying…',
          guardAfterExit: true,
        });
      }

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
        return await this.runRetryTeardown(queryGeneration, attemptToken, {
          nextAttempt: retryAttempt + 1,
          recoveryState,
          resetStartupState: true,
          snapshotLastConsumed: true,
          notice:
            `⚠️ The provider is temporarily unavailable. Retrying ` +
            `(attempt ${retryAttempt + 1}/${maxProviderRetries})…`,
          backoffMs: delayMs,
          snapshotRequeueLabel: `provider error retry (attempt ${retryAttempt + 1}/${maxProviderRetries})`,
        });
      }

      messageQueue.clear();

      if (!isAbortError) {
        const processingState = stateManager.getState();
        let decision = routeDecision;

        if (decision.route.action === 'rate_limit_handoff') {
          const handoffAccepted = !!(await this.ctx.onRateLimitExhausted?.(
            errorMessage,
            this._lastConsumedUserMessage,
            retrySignal.rateLimitHint ?? undefined,
            queryGeneration
          ));
          recoveryState.rateLimitCooldownScheduled = handoffAccepted;
          decision = decideQueryRetry({
            errorSignal: retrySignal,
            env: {
              ...retryEnv,
              rateLimitHandoffResult: handoffAccepted ? 'accepted' : 'declined',
            },
          });
        } else if (decision.route.action === 'terminal') {
          recoveryState.rateLimitCooldownScheduled = false;
        }

        const { route, finalizer } = decision;
        const owner = stateManager.idleOwnerForQuery(queryGeneration);
        let terminalIdleArmed = false;

        if (route.action === 'api_validation') {
          if (!finalizer.skipBeginTerminalIdle) {
            if (this.ctx.isCleaningUp() || this.ctx.getQueryGeneration() !== queryGeneration) {
              return;
            }
            stateManager.beginTerminalIdle(owner);
            terminalIdleArmed = true;
          }
          try {
            await this.displayErrorAsAssistantMessage(route.text, {
              markAsError: true,
            });
          } catch (error) {
            if (terminalIdleArmed) {
              stateManager.cancelTerminalIdleArm(owner);
            }
            throw error;
          }
        } else if (route.action === 'terminal') {
          if (!finalizer.skipBeginTerminalIdle) {
            if (this.ctx.isCleaningUp() || this.ctx.getQueryGeneration() !== queryGeneration) {
              return;
            }
            stateManager.beginTerminalIdle(owner);
            terminalIdleArmed = true;
          }
          if (!finalizer.skipErrorManager) {
            const publishGuard = () =>
              !this.ctx.isCleaningUp() && this.ctx.getQueryGeneration() === queryGeneration;
            try {
              await errorManager.handleError(
                session.id,
                error as Error,
                route.category,
                this.terminalUserMessageFor(route.messageHint, maxProviderRetries),
                processingState,
                {
                  errorMessage,
                  queueSize: messageQueue.size(),
                  providerId: providerId ?? 'anthropic',
                  workspacePath: session.workspacePath ?? undefined,
                  isRootWorkspace: !session.worktree,
                  startupTimeoutMs: STARTUP_TIMEOUT_MS,
                },
                publishGuard
              );
            } catch (error) {
              if (terminalIdleArmed) {
                stateManager.cancelTerminalIdleArm(owner);
              }
              throw error;
            }
          }
        }

        if (!finalizer.skipCatchIdle) {
          if (this.ctx.getQueryGeneration() !== queryGeneration) {
            return;
          }
          if (this.ctx.isCleaningUp()) {
            if (terminalIdleArmed) {
              stateManager.cancelTerminalIdleArm(owner);
            }
            return;
          }
          await stateManager.setIdle({ owner });
        }
      }
    } finally {
      this.ctx.attemptTokens.invalidate(attemptToken);

      releaseStartupPermit('attempt_finished');

      const isStaleQuery = this.ctx.getQueryGeneration() !== queryGeneration;

      if (isStaleQuery) {
        stateManager.cancelTerminalIdleArm(stateManager.idleOwnerForQuery(queryGeneration));
      }

      if (!isStaleQuery) {
        const timer = this.ctx.startupTimeoutTimer;
        if (timer) {
          clearTimeout(timer);
          this.ctx.startupTimeoutTimer = null;
        }

        if (runAbortController) {
          runAbortController.abort();
        } else if (this.ctx.queryAbortController) {
          this.ctx.queryAbortController.abort();
          this.ctx.queryAbortController = null;
        }

        this.ctx.resetProcessExitedPromise();

        messageQueue.stop();

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {}
          this.ctx.queryObject = null;
        }

        const originalEnvVars = this.ctx.originalEnvVars;
        if (Object.keys(originalEnvVars).length > 0) {
          const { getProviderService: getProviderServiceRestore } = await import(
            '../provider-service.ts'
          );
          const providerServiceRestore = getProviderServiceRestore();
          providerServiceRestore.restoreEnvVars(originalEnvVars);
          this.ctx.originalEnvVars = {};
        }

        this._lastConsumedUserMessage = null;
        this._turnConsumedUserMessages = [];

        if (
          this.ctx.getQueryGeneration() === queryGeneration &&
          this.ctx.queryAbortController === runAbortController &&
          !this.ctx.isCleaningUp() &&
          !recoveryState.rateLimitCooldownScheduled &&
          !(this.ctx.isLimitRecoveryPending?.() ?? false) &&
          stateManager.getState().status !== 'rate_limit_cooldown' &&
          !(isAbortError && stateManager.getState().status === 'interrupted')
        ) {
          await stateManager.setIdle({ owner: stateManager.idleOwnerForQuery(queryGeneration) });
        }

        if (this.ctx.getQueryGeneration() !== queryGeneration) {
          stateManager.cancelTerminalIdleArm(stateManager.idleOwnerForQuery(queryGeneration));
        }

        if (this.ctx.queryAbortController === runAbortController) {
          this.ctx.queryAbortController = null;
        }

        this._consumedUserMessages.delete(queryGeneration);

        if (this.ctx.getQueryGeneration() === queryGeneration) {
          this.ctx.queryPromise = null;
        }
      }
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

  private async ensureSpaceChatMcpInvariant(
    queryOptions: Options,
    askUserQuestionHook: HookCallback
  ): Promise<Options> {
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
      const rebuilt = await this.ctx.optionsBuilder.build({ askUserQuestionHook });
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

  private async ensureMemberSpaceMcpInvariant(
    queryOptions: Options,
    askUserQuestionHook: HookCallback
  ): Promise<Options> {
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
      const rebuilt = await this.ctx.optionsBuilder.build({ askUserQuestionHook });
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

  private async runRetryTeardown(
    queryGeneration: number,
    attemptToken: QueryAttemptToken,
    options: RetryTeardownOptions
  ): Promise<void> {
    const { messageQueue, stateManager, logger } = this.ctx;

    this.ctx.attemptTokens.invalidate(attemptToken);

    const abandon = (point: string): boolean => {
      const routeGuard = options.routeGuard;
      if (!routeGuard) {
        if (this.isRunOwnershipLive(queryGeneration)) return false;
        this.retrySupersededByReplacement(queryGeneration);
        return true;
      }
      if (this.retrySupersededByReplacement(queryGeneration)) return true;
      if (
        this.retryRouteChanged(
          routeGuard.expectedAction,
          routeGuard.retrySignal,
          routeGuard.retryEnv,
          queryGeneration,
          routeGuard.queueRunningAtEntry
        )
      ) {
        logger.warn(
          `${routeGuard.abandonLabel} abandoned: session ownership changed across the ${point}.`
        );
        return true;
      }
      return false;
    };

    const resetStartupState = (state: RetryTeardownState): RetryTeardownState => {
      const staleStartupTimer = this.ctx.startupTimeoutTimer;
      if (staleStartupTimer) {
        clearTimeout(staleStartupTimer);
        this.ctx.startupTimeoutTimer = null;
      }
      this.ctx.firstMessageReceived = false;
      return state;
    };

    const idleSuppressWaiters = async (): Promise<void> => {
      await stateManager.setIdle({
        suppressDeliveryWaiters: true,
        owner: stateManager.idleOwnerForQuery(queryGeneration),
      });
    };

    const terminateProcesses = (state: RetryTeardownState): RetryTeardownState => {
      this.ctx.terminateTrackedAgentProcesses?.();
      return state;
    };

    const requeueLastConsumed = (state: RetryTeardownState): RetryTeardownState => {
      const lastMsg = this._lastConsumedUserMessage;
      if (lastMsg && options.requeueLastConsumedFor) {
        logger.warn(
          `Re-enqueueing user message ${lastMsg.uuid} for ${options.requeueLastConsumedFor}.`
        );
        messageQueue.enqueueWithId(lastMsg.uuid, lastMsg.content).catch(() => {});
        this._lastConsumedUserMessage = null;
        this._consumedUserMessages.delete(queryGeneration);
      }
      return state;
    };

    const snapshotLastConsumed = (state: RetryTeardownState): RetryTeardownState => {
      const snapshotMsg = this._lastConsumedUserMessage;
      this._lastConsumedUserMessage = null;
      this._consumedUserMessages.delete(queryGeneration);
      return { ...state, snapshotMsg };
    };

    const displayRetryNotice = async (): Promise<void> => {
      if (options.notice === undefined) return;
      try {
        await this.displayErrorAsAssistantMessage(options.notice, { markAsError: false });
      } catch {}
    };

    const closeQueryObject = (state: RetryTeardownState): RetryTeardownState => {
      if (this.ctx.queryObject) {
        try {
          this.ctx.queryObject.close();
        } catch {}
        this.ctx.queryObject = null;
      }
      return state;
    };

    const awaitProcessExit = async (): Promise<void> => {
      const exitPromise = this.ctx.processExitedPromise;
      if (!exitPromise) return;
      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
      ]);
      if (this.ctx.processExitedPromise === exitPromise) {
        this.ctx.resetProcessExitedPromise();
      }
    };

    const restartStoppedQueue = (state: RetryTeardownState): RetryTeardownState => {
      if (
        !messageQueue.isRunning() &&
        !this.ctx.isCleaningUp() &&
        stateManager.getState().status !== 'interrupted'
      ) {
        messageQueue.start();
      }
      return state;
    };

    const requeueConsumedList = (state: RetryTeardownState): RetryTeardownState => {
      const consumed = this._consumedUserMessages.get(queryGeneration) ?? [];
      if (consumed.length > 0) {
        logger.warn(
          `Re-enqueueing ${consumed.length} consumed user message(s) for startup-timeout retry.`
        );
        for (let i = consumed.length - 1; i >= 0; i--) {
          const message = consumed[i];
          messageQueue
            .enqueueWithId(message.uuid, message.content, false, { prepend: true })
            .catch(() => {});
        }
        this._consumedUserMessages.delete(queryGeneration);
        this._lastConsumedUserMessage = null;
      }
      return state;
    };

    const displayPostTeardownNotice = async (): Promise<void> => {
      if (options.noticeAfterTeardown === undefined) return;
      try {
        await this.displayErrorAsAssistantMessage(options.noticeAfterTeardown, {
          markAsError: false,
        });
      } catch {}
    };

    const restoreEnvAndBackoff = async (): Promise<void> => {
      const envVarsToRestore = this.ctx.originalEnvVars;
      if (Object.keys(envVarsToRestore).length > 0) {
        const { getProviderService: getProviderServiceForRetry } = await import(
          '../provider-service.ts'
        );
        getProviderServiceForRetry().restoreEnvVars(envVarsToRestore);
        this.ctx.originalEnvVars = {};
      }
      if (options.backoffMs !== undefined) {
        await sleep(options.backoffMs);
      }
    };

    const requeueSnapshotted = (state: RetryTeardownState): RetryTeardownState => {
      if (state.snapshotMsg && options.snapshotRequeueLabel) {
        logger.warn(
          `Re-enqueueing user message ${state.snapshotMsg.uuid} for ${options.snapshotRequeueLabel}.`
        );
        messageQueue
          .enqueueWithId(state.snapshotMsg.uuid, state.snapshotMsg.content)
          .catch(() => {});
        this._lastConsumedUserMessage = null;
        this._consumedUserMessages.delete(queryGeneration);
      }
      return state;
    };

    const recurseNextAttempt = async (): Promise<void> => {
      await this.runQuery(queryGeneration, options.nextAttempt, options.recoveryState);
    };

    const noticeOrRequeueBeforeTeardown =
      options.notice !== undefined ||
      options.requeueLastConsumedFor !== undefined ||
      options.snapshotLastConsumed === true;
    const deps: Record<string, ((state: RetryTeardownState) => unknown) | undefined> = {
      resetStartupState: options.resetStartupState ? resetStartupState : undefined,
      idleSuppressWaiters: options.idleFirst ? idleSuppressWaiters : undefined,
      idleAwaitAbandoned: () => abandon('idle await'),
      terminateProcesses: options.terminateProcesses ? terminateProcesses : undefined,
      requeueLastConsumed: options.requeueLastConsumedFor ? requeueLastConsumed : undefined,
      snapshotLastConsumed: options.snapshotLastConsumed ? snapshotLastConsumed : undefined,
      displayRetryNotice: options.notice !== undefined ? displayRetryNotice : undefined,
      noticeAbandoned: noticeOrRequeueBeforeTeardown ? () => abandon('publication') : undefined,
      exitAwaitAbandoned: options.guardAfterExit ? () => abandon('exit await') : undefined,
      restartStoppedQueue: options.restartQueueIfStopped ? restartStoppedQueue : undefined,
      requeueConsumedList: options.requeueConsumedList ? requeueConsumedList : undefined,
      displayPostTeardownNotice:
        options.noticeAfterTeardown !== undefined ? displayPostTeardownNotice : undefined,
      publicationAbandoned:
        options.noticeAfterTeardown !== undefined ? () => abandon('publication') : undefined,
      restoreEnvAndBackoff: options.backoffMs !== undefined ? restoreEnvAndBackoff : undefined,
      backoffAbandoned:
        options.backoffMs !== undefined
          ? () => {
              if (this.isRunOwnershipLive(queryGeneration)) return false;
              this.retrySupersededByReplacement(queryGeneration);
              logger.warn(
                'Provider error retry cancelled: session interrupted/restarted/cleaning up during backoff.'
              );
              return true;
            }
          : undefined,
      requeueSnapshotted: options.snapshotLastConsumed ? requeueSnapshotted : undefined,
    };

    const runRetryTeardownPipeline = (superpipe(deps)('query-retry-teardown') as PipelineAPI)
      .input(['state'])
      .pipe('?resetStartupState', 'state', 'state')
      .pipe('?idleSuppressWaiters', 'state')
      .pipe('!idleAwaitAbandoned', 'state')
      .pipe('?terminateProcesses', 'state', 'state')
      .pipe('?requeueLastConsumed', 'state', 'state')
      .pipe('?snapshotLastConsumed', 'state', 'state')
      .pipe('?displayRetryNotice', 'state')
      .pipe('!?noticeAbandoned', 'state')
      .pipe(closeQueryObject, 'state', 'state')
      .pipe(awaitProcessExit, 'state')
      .pipe('!?exitAwaitAbandoned', 'state')
      .pipe('?restartStoppedQueue', 'state', 'state')
      .pipe('?requeueConsumedList', 'state', 'state')
      .pipe('?displayPostTeardownNotice', 'state')
      .pipe('!?publicationAbandoned', 'state')
      .pipe('?restoreEnvAndBackoff', 'state')
      .pipe('!?backoffAbandoned', 'state')
      .pipe('?requeueSnapshotted', 'state', 'state')
      .pipe(recurseNextAttempt, 'state')
      .endAsync();

    await (runRetryTeardownPipeline as (state: RetryTeardownState) => Promise<void>)({
      snapshotMsg: null,
    });
  }

  private retryRouteChanged(
    expectedAction: QueryRetryRoute['action'],
    errorSignal: QueryRetryErrorSignal,
    env: QueryRetryEnvironment,
    queryGeneration: number,
    queueRunningAtEntry: boolean
  ): boolean {
    const queueRunning = this.ctx.messageQueue.isRunning();
    const abortAborted = this.ctx.queryAbortController?.signal.aborted === true;
    if (queueRunningAtEntry && !queueRunning) return true;
    if (env.lifecycle.abortSignalAborted && !abortAborted) return true;
    const resnapshotted = decideQueryRetry({
      errorSignal,
      env: {
        ...env,
        hasConsumedPrompt: (this._consumedUserMessages.get(queryGeneration) ?? []).length > 0,
        hasQueuedPrompt: this.ctx.messageQueue.size() > 0,
        isCleaningUp: this.ctx.isCleaningUp(),
        isSuperseded: this.ctx.getQueryGeneration() !== queryGeneration,
        lifecycle: {
          ...env.lifecycle,
          processingStatus: this.ctx.stateManager.getState().status,
          abortSignalAborted: abortAborted,
        },
      },
    });
    return resnapshotted.route.action !== expectedAction;
  }

  private retrySupersededByReplacement(queryGeneration: number): boolean {
    if (this.ctx.getQueryGeneration() === queryGeneration) return false;
    this.ctx.logger.warn('Auto-retry abandoned: a replacement query owns the session.');
    this._consumedUserMessages.delete(queryGeneration);
    return true;
  }

  private isRunOwnershipLive(queryGeneration: number): boolean {
    return (
      this.ctx.getQueryGeneration() === queryGeneration &&
      !this.ctx.isCleaningUp() &&
      this.ctx.stateManager.getState().status !== 'interrupted' &&
      this.ctx.queryAbortController?.signal.aborted !== true &&
      this.ctx.messageQueue.isRunning()
    );
  }

  async *createMessageGeneratorWrapper(queryGeneration: number) {
    const { session, messageQueue, stateManager, logger } = this.ctx;

    for await (const { message, onSent } of messageQueue.messageGenerator(session.id, {
      suppressPreYieldCallback: true,
    })) {
      if (this.ctx.isLimitRecoveryPending?.()) {
        logger.info('Prompt feed: limit recovery engaged; requeueing prompt until the retry.');
        const yieldedUuid = message.uuid;
        if (yieldedUuid && !messageQueue.requeueYielded(yieldedUuid)) {
          logger.warn(`Prompt feed: could not requeue yielded prompt ${yieldedUuid}.`);
        }
        break;
      }
      messageQueue.onMessageYielded?.(message.uuid ?? '', Date.now());
      const queuedMessage = message as typeof message & { internal?: boolean };
      const isInternal = queuedMessage.internal || false;

      if (!isInternal) {
        await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
        this._lastConsumedUserMessage = {
          uuid: message.uuid ?? '',
          content: (message.message?.content ?? '') as unknown as string | MessageContent[],
        };
        this._turnConsumedUserMessages.push({
          uuid: message.uuid ?? '',
          content: (message.message?.content ?? '') as unknown as string | MessageContent[],
        });
        if (this._turnConsumedUserMessages.length > 32) {
          this._turnConsumedUserMessages.shift();
        }
        if (!this.ctx.firstMessageReceived) {
          const generationMessages = this._consumedUserMessages.get(queryGeneration) ?? [];
          generationMessages.push({
            uuid: message.uuid ?? '',
            content: (message.message?.content ?? '') as unknown as string | MessageContent[],
          });
          this._consumedUserMessages.set(queryGeneration, generationMessages);
        }
      }

      logger.debug(
        `delivery-feed: yielding message to SDK transport (session=${session.id} ` +
          `uuid=${message.uuid ?? 'unknown'} queueSizeAfter=${messageQueue.size()} ` +
          `internal=${isInternal})`
      );

      yield message;
      onSent();
    }
  }

  async handleSDKMessage(message: SDKMessage, queryGeneration?: number): Promise<void> {
    await this.ctx.onSDKMessage(message, undefined, queryGeneration);
    await this.ctx.onMarkApiSuccess(message, queryGeneration);
  }

  async handleStreamMessageError(
    message: SDKMessage,
    error: unknown,
    queryGeneration: number,
    attemptToken: QueryAttemptToken
  ): Promise<void> {
    const { session, stateManager, errorManager, logger } = this.ctx;

    logger.error('Error handling SDK message:', error);
    logger.error('Message type:', message.type);

    const attemptOwnsRun = () =>
      !this.ctx.isCleaningUp() &&
      this.ctx.getQueryGeneration() === queryGeneration &&
      attemptToken.isLive();

    if (attemptOwnsRun()) {
      const processingState = stateManager.getState();
      await drainDeliveryWaitersOnTerminalSDKMessage(stateManager, message);
      await errorManager.handleError(
        session.id,
        error as Error,
        ErrorCategory.MESSAGE,
        'Error processing SDK message. The session has been reset.',
        processingState,
        { messageType: message.type },
        attemptOwnsRun
      );
      return;
    }

    stateManager.cancelTerminalIdleArm(stateManager.idleOwnerForQuery(queryGeneration));
  }

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
            void cleanup.catch(() => {});
          } else {
            await cleanup;
          }
        }
      } catch {}
    }
  }

  private parseApiValidationError(error: unknown): { text: string } | null {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (looksLikeRateLimit429(errorMessage)) return null;

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

    const plainErrorMatch = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(.+)$/s);
    if (plainErrorMatch) {
      const [, statusCode, plainMessage] = plainErrorMatch;
      return {
        text: `**API Error (${statusCode})**: ${plainMessage.trim()}\n\nThis error occurred while processing your request.`,
      };
    }

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
    } catch {}

    return null;
  }

  private terminalUserMessageFor(
    messageHint: string | undefined,
    maxProviderRetries: number
  ): string | undefined {
    const { session } = this.ctx;
    if (messageHint === 'startup_timeout') {
      return (
        `The AI session failed to start (workspace: ${session.workspacePath ?? 'unbound'}). ` +
        `The SDK subprocess did not emit its first message within the startup window ` +
        `(after one automatic retry); concurrent cold-start load is bounded by the startup gate. ` +
        `Try: resending your message, or increase the timeout with ` +
        `HYPERNEO_SDK_STARTUP_TIMEOUT_MS (current: ${STARTUP_TIMEOUT_MS}ms).`
      );
    }
    if (messageHint === 'conversation_not_found') {
      return (
        `The AI session could not be resumed (workspace: ${session.workspacePath ?? 'unbound'}). ` +
        `The previous session transcript was not found — this can happen after a provider switch, ` +
        `workspace path change, or if the ~/.claude/projects/ directory was cleaned up. ` +
        `Your message history in HyperNeo is preserved; only the AI context window is reset. ` +
        `Please resend your message — you will be asked to choose whether to start a fresh session or keep the existing context.`
      );
    }
    if (messageHint === 'message_not_found') {
      return (
        `The AI session could not resume from the previous rewind point ` +
        `(workspace: ${session.workspacePath ?? 'unbound'}). The Claude SDK transcript no longer ` +
        `contains that message UUID, likely after SDK compaction. Your message history in HyperNeo ` +
        `is preserved; only the AI context window is reset. Please resend your message.`
      );
    }
    if (messageHint === 'provider_exhausted') {
      return (
        `The provider is temporarily unavailable. The request was retried ` +
        `${maxProviderRetries} time(s) without success. Please try again later.`
      );
    }
    if (messageHint === 'transient_exhausted') {
      return 'Could not get a response. The connection was interrupted. Please try again.';
    }
    return undefined;
  }

  async displayErrorAsAssistantMessage(
    text: string,
    options?: { markAsError?: boolean }
  ): Promise<boolean> {
    const { session, db, messageHub, internalEventBus } = this.ctx;

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

    if (!db.saveSDKMessage(session.id, assistantMessage)) {
      if (options?.markAsError) {
        internalEventBus.publishAsync('session.error', {
          sessionId: session.id,
          error: text,
          details: { category: ErrorCategory.SYSTEM, message: text, userMessage: text },
        });
      }
      return false;
    }

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [assistantMessage], timestamp: Date.now() },
      { channel: `session:${session.id}` }
    );
    return true;
  }
}
