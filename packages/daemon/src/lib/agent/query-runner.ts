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
import type { AgentSession } from './agent-session';
import type { AskUserQuestionHandler } from './ask-user-question-handler';
import { assessLimitError, type LimitRetryHint } from './limit-error-classifier';
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

export type { OriginalEnvVars } from '../provider-service';

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

  onSDKMessage(message: SDKMessage, queuedMessages?: SDKMessage[]): Promise<void>;
  onSlashCommandsFetched(): Promise<void>;
  onModelsFetched(): Promise<void>;
  onMarkApiSuccess(message: SDKMessage): Promise<void>;

  onMissingWorkflowMcpServers?: (session: AgentSession, missing: string[]) => Promise<void>;

  onMissingSpaceChatMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  onMissingMemberSpaceMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  consumePendingResumeSessionAt?(): string | undefined;

  onRateLimitExhausted?: (
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    hint?: LimitRetryHint
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

    const currentGeneration = this.ctx.incrementQueryGeneration();

    this.ctx.firstMessageReceived = false;

    this.ctx.queryPromise = this.runQuery(currentGeneration);
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

  private async runQuery(
    queryGeneration: number,
    retryAttempt = 0,
    recoveryState = { rateLimitCooldownScheduled: false }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;

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

      if (session.workspacePath) {
        const fs = await import('fs/promises');
        await fs.mkdir(session.workspacePath, { recursive: true });
      }

      optionsBuilder.setCanUseTool(this.ctx.askUserQuestionHandler.createCanUseToolCallback());
      optionsBuilder.setAskUserQuestionHook(this.ctx.askUserQuestionHandler.createPreToolUseHook());
      let queryOptions = await optionsBuilder.build();

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

      queryOptions = await this.ensureSpaceChatMcpInvariant(queryOptions);
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

      const resolvedProviderId = explicitProviderId ?? provider?.id ?? 'anthropic';
      const refreshAutoCompactWindow = true;
      let extraProviderManagedEnvVars: string[] = [];
      {
        const { getProviderService } = await import('../provider-service');
        const providerService = getProviderService();
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

          if (!abortController.signal.aborted) {
            abortController.abort();
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

      let messageCount = 0;

      for await (const message of this.createAbortableQuery(queryObject, abortController.signal)) {
        if (startupTimeoutReached && messageCount === 0) {
          throw new Error('SDK startup timeout - query aborted');
        }

        messageCount++;

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
          this._consumedUserMessages.delete(queryGeneration);
        }

        try {
          await this.handleSDKMessage(message as SDKMessage);
        } catch (error) {
          logger.error('Error handling SDK message:', error);
          logger.error('Message type:', (message as SDKMessage).type);

          if (!this.ctx.isCleaningUp()) {
            const processingState = stateManager.getState();
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

      if (
        this.ctx.getQueryGeneration() === queryGeneration &&
        !(startupTimeoutReached && messageCount === 0)
      ) {
        this.ctx.consumePendingResumeSessionAt?.();
      }

      if (this.ctx.getQueryGeneration() === queryGeneration) {
        messageQueue.stop();
      }

      if (startupTimeoutReached && messageCount === 0) {
        throw new Error('SDK startup timeout - query aborted');
      }
    } catch (error) {
      logger.error('Streaming query error:', error);

      releaseStartupPermit('query_error');

      if (this.ctx.isCleaningUp()) {
        return;
      }

      if (this.ctx.getQueryGeneration() !== queryGeneration) {
        return;
      }

      const errorMessage = String(error);
      const isAbortError = error instanceof Error && error.name === 'AbortError';
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

      const startupRetryFutile =
        isStartupTimeout &&
        retryAttempt === 0 &&
        !this.canRedeliverPromptOnStartupRetry(queryGeneration);
      if (startupRetryFutile) {
        logger.warn(
          'SDK startup timeout with no consumed or queued prompt: skipping the one-shot ' +
            'retry — a fresh attempt could not deliver anything.'
        );
      }

      if (
        !startupRetryFutile &&
        isStartupTimeout &&
        retryAttempt === 0 &&
        !this.ctx.isCleaningUp() &&
        stateManager.getState().status !== 'interrupted'
      ) {
        logger.warn('Auto-retrying query after startup timeout (1 retry).');
        await stateManager.setIdle({ suppressDeliveryWaiters: true });

        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }

        this.ctx.terminateTrackedAgentProcesses?.();

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {}
          this.ctx.queryObject = null;
        }

        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }

        if (
          !messageQueue.isRunning() &&
          !this.ctx.isCleaningUp() &&
          stateManager.getState().status !== 'interrupted'
        ) {
          messageQueue.start();
        }

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

        try {
          await this.displayErrorAsAssistantMessage(
            `⚠️ The AI session is slow to start — no response after ` +
              `${Math.round(STARTUP_TIMEOUT_MS / 1000)}s. Retrying once…`,
            { markAsError: false }
          );
        } catch {}

        return await this.runQuery(queryGeneration, 1, recoveryState);
      }
      if (isMessageNotFound && retryAttempt === 0 && !this.ctx.isCleaningUp()) {
        this.ctx.consumePendingResumeSessionAt?.();
        logger.warn('Auto-retrying query without one-shot resumeSessionAt.');
        const staleStartupTimer = this.ctx.startupTimeoutTimer;
        if (staleStartupTimer) {
          clearTimeout(staleStartupTimer);
          this.ctx.startupTimeoutTimer = null;
        }
        this.ctx.firstMessageReceived = false;
        await stateManager.setIdle({ suppressDeliveryWaiters: true });

        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }

        this.ctx.terminateTrackedAgentProcesses?.();

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {}
          this.ctx.queryObject = null;
        }

        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }
        return await this.runQuery(queryGeneration, 1, recoveryState);
      }

      if (
        isTransientConnectionError &&
        !isQueryInterrupted &&
        retryAttempt === 0 &&
        !this.ctx.isCleaningUp() &&
        stateManager.getState().status !== 'interrupted'
      ) {
        logger.warn('Auto-retrying query after transient connection error (1 retry).');
        const staleStartupTimer = this.ctx.startupTimeoutTimer;
        if (staleStartupTimer) {
          clearTimeout(staleStartupTimer);
          this.ctx.startupTimeoutTimer = null;
        }
        this.ctx.firstMessageReceived = false;
        await stateManager.setIdle({ suppressDeliveryWaiters: true });

        const lastMsg = this._lastConsumedUserMessage;
        if (lastMsg) {
          logger.warn(
            `Re-enqueueing user message ${lastMsg.uuid} for transient connection error retry.`
          );
          messageQueue.enqueueWithId(lastMsg.uuid, lastMsg.content).catch(() => {});
          this._lastConsumedUserMessage = null;
          this._consumedUserMessages.delete(queryGeneration);
        }

        try {
          await this.displayErrorAsAssistantMessage('⚠️ The connection was interrupted. Retrying…', {
            markAsError: false,
          });
        } catch {}

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {}
          this.ctx.queryObject = null;
        }

        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        if (this.retrySupersededByReplacement(queryGeneration)) {
          return;
        }
        return await this.runQuery(queryGeneration, 1, recoveryState);
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

        const startupTimer = this.ctx.startupTimeoutTimer;
        if (startupTimer) {
          clearTimeout(startupTimer);
          this.ctx.startupTimeoutTimer = null;
        }

        this.ctx.firstMessageReceived = false;

        const retryMsg = this._lastConsumedUserMessage;
        this._lastConsumedUserMessage = null;
        this._consumedUserMessages.delete(queryGeneration);

        try {
          await this.displayErrorAsAssistantMessage(
            `⚠️ The provider is temporarily unavailable. Retrying ` +
              `(attempt ${retryAttempt + 1}/${maxProviderRetries})…`,
            { markAsError: false }
          );
        } catch {}

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {}
          this.ctx.queryObject = null;
        }

        const exitPromise = this.ctx.processExitedPromise;
        if (exitPromise) {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
          ]);
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        const envVarsToRestore = this.ctx.originalEnvVars;
        if (Object.keys(envVarsToRestore).length > 0) {
          const { getProviderService: getProviderServiceForRetry } = await import(
            '../provider-service'
          );
          getProviderServiceForRetry().restoreEnvVars(envVarsToRestore);
          this.ctx.originalEnvVars = {};
        }

        await sleep(delayMs);

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

      messageQueue.clear();

      const isProviderRetryExhausted =
        retryAttempt >= maxProviderRetries && isRetryableProviderError(errorMessage);

      if (!isAbortError) {
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

          const limitAssessment = assessLimitError({ rawText: errorMessage });
          recoveryState.rateLimitCooldownScheduled =
            limitAssessment.isLimit &&
            !!(await this.ctx.onRateLimitExhausted?.(errorMessage, this._lastConsumedUserMessage, {
              resetAtMs: limitAssessment.resetAtMs,
              kind: limitAssessment.kind,
              billingTerminal: limitAssessment.billingTerminal,
            }));
          if (!recoveryState.rateLimitCooldownScheduled) {
            stateManager.beginTerminalIdle();
          }

          const startupTimeoutUserMessage = isStartupTimeout
            ? `The AI session failed to start (workspace: ${session.workspacePath ?? 'unbound'}). ` +
              `The SDK subprocess did not emit its first message within the startup window ` +
              `(after one automatic retry); concurrent cold-start load is bounded by the startup gate. ` +
              `Try: resending your message, or increase the timeout with ` +
              `HYPERNEO_SDK_STARTUP_TIMEOUT_MS (current: ${STARTUP_TIMEOUT_MS}ms).`
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
        if (!recoveryState.rateLimitCooldownScheduled) {
          await stateManager.setIdle();
        }
      }
    } finally {
      releaseStartupPermit('attempt_finished');

      const isStaleQuery = this.ctx.getQueryGeneration() !== queryGeneration;

      if (!isStaleQuery) {
        const timer = this.ctx.startupTimeoutTimer;
        if (timer) {
          clearTimeout(timer);
          this.ctx.startupTimeoutTimer = null;
        }

        const abortController = this.ctx.queryAbortController;
        if (abortController) {
          abortController.abort();
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
            '../provider-service'
          );
          const providerServiceRestore = getProviderServiceRestore();
          providerServiceRestore.restoreEnvVars(originalEnvVars);
          this.ctx.originalEnvVars = {};
        }

        if (
          !this.ctx.isCleaningUp() &&
          !recoveryState.rateLimitCooldownScheduled &&
          !(this.ctx.isLimitRecoveryPending?.() ?? false) &&
          stateManager.getState().status !== 'rate_limit_cooldown'
        ) {
          await stateManager.setIdle();
        }

        this._lastConsumedUserMessage = null;
        this._turnConsumedUserMessages = [];
        this._consumedUserMessages.delete(queryGeneration);

        this.ctx.queryPromise = null;
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

  private canRedeliverPromptOnStartupRetry(queryGeneration: number): boolean {
    const consumed = this._consumedUserMessages.get(queryGeneration) ?? [];
    return consumed.length > 0 || this.ctx.messageQueue.size() > 0;
  }

  private retrySupersededByReplacement(queryGeneration: number): boolean {
    if (this.ctx.getQueryGeneration() === queryGeneration) return false;
    this.ctx.logger.warn('Auto-retry abandoned: a replacement query owns the session.');
    this._consumedUserMessages.delete(queryGeneration);
    return true;
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

  async handleSDKMessage(message: SDKMessage): Promise<void> {
    await this.ctx.onSDKMessage(message);
    await this.ctx.onMarkApiSuccess(message);
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
