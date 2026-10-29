import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { SessionToolApplication } from '@hyperneo/shared/types/session-tool-choice';
import type { SessionToolInventory } from '@hyperneo/shared/types/observed-tool-inventory';
import {
  isSDKAPIRetryMessage,
  isSDKResultMessage,
  isSDKResultSuccess,
  isSDKSystemInit,
} from '@hyperneo/shared/sdk/type-guards';
import type { UUID } from 'crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { PROVIDER_KEY_ENV_VARS } from '../credential-discovery.ts';
import { ErrorCategory, type ErrorManager } from '../error-manager.ts';
import { runLagPhase } from '../event-loop-activity.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Logger } from '../logger.ts';
import type { ProviderEnvVars } from '../provider-service.ts';
import { setKeyBridgeThinkingOff } from '../providers/provider-key-bridge.ts';
import { NON_ANTHROPIC_PREFIX_PROVIDER_VARS } from '../provider-service.ts';
import { resolveAvailableQueryProvider } from '../providers/registry.js';
import {
  FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
  resolveSpaceMcpSessionPolicy,
} from '../space/runtime/space-mcp-session-policy.ts';
import { sleep } from '../utils/sleep.ts';
import { QueryFailureGovernor, QueryFailureCapError } from './query-failure-episode.ts';
import type { AgentSession } from './agent-session.ts';
import type { AskUserQuestionHandler } from './ask-user-question-handler.ts';
import { createFlagSettingsFileWriter } from './flag-settings-file.ts';
import { assessLimitError, type LimitRetryHint } from './limit-error-classifier.ts';
import { drainDeliveryWaitersOnTerminalSDKMessage } from './message-delivery.ts';
import type { MessageQueue } from './message-queue.ts';
import { isNetworkUnreachableError } from './network-outage-pause.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import { QueryAttemptRegistry, type QueryAttemptToken } from './query-attempt-token.ts';
import { ObservedToolInventory } from './observed-tool-inventory.ts';
import type { QueryLike } from './query-like.ts';
import type { QueryOptionsBuilder } from './query-options-builder.ts';
import {
  decideQueryRetry,
  decideProviderTerminalCategory,
  isClaudeAuthenticationError,
  planTurnEndedGeneration,
  type QueryRetryEnvironment,
  type QueryRetryErrorSignal,
  type QueryRetryRoute,
} from './query-retry-routing.ts';
import { type QuestionInputOriginSource, QuestionInputScope } from './question-input-origin.ts';
import { RetryPromptIdentity } from './retry-prompt-identity.ts';
import { neoCoordinatorBinding } from '../neo/session-policy.ts';
import type { SDKMessageHandler } from './sdk-message-handler.ts';
import { getSdkStartupGate, type SdkStartupPermit } from './sdk-startup-gate.ts';
import {
  DEFAULT_SDK_STARTUP_NUDGE_THRESHOLD_MS,
  getSdkStartInactivityBackstopMs,
  runStartupWatch,
  type SdkStartExitInfo,
} from './startup-watch-pipeline.ts';
import {
  getOpenToolStallTimeoutMs,
  getStreamSilenceTimeoutMs,
  noteStreamFed,
  noteStreamMessage,
  planStreamSilence,
  STREAM_STALL_ERROR,
  type StreamSilenceState,
} from './stream-silence-watch.ts';
import {
  TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE,
  isTopLevelHollowTaskNotificationResult,
} from './task-notification-requery.ts';
import {
  isRetryableProviderError,
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
} from './transient-error-patterns.ts';

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

const RETRY_EXIT_TIMEOUT_MS = 5000;

const toolStatusSchema = z.array(
  z.object({
    name: z.string(),
    status: z.string(),
    tools: z.array(z.object({ name: z.string() })).optional(),
  })
);

type StartupWatchRace =
  | { kind: 'message'; result: IteratorResult<unknown, void> }
  | { kind: 'iterator_error'; error: unknown }
  | { kind: 'nudge' }
  | { kind: 'backstop' }
  | { kind: 'drain' }
  | { kind: 'exit' }
  | { kind: 'silence' }
  | { kind: 'abort' };

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
  'ANTHROPIC_CUSTOM_HEADERS',
]);

function isRealAnthropicAuthToken(token: string | undefined): boolean {
  return typeof token === 'string' && token.startsWith('sk-ant-oat');
}

export { resolveAvailableQueryProvider, resolveQueryProvider } from '../providers/registry.js';

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
    if (PROVIDER_KEY_ENV_VARS.has(key) && !providerManagedEnvVars.has(key)) continue;
    if (providerManagedEnvVars.has(key)) {
      refreshedEnv[key] = value;
    } else if (!(key in refreshedEnv)) {
      refreshedEnv[key] = value;
    }
  }
  return refreshedEnv;
}

export function shouldPreserveAnthropicOAuthToken(
  providerId: string,
  providerEnvVars: ProviderEnvVars
): boolean {
  return providerId === 'anthropic' && providerEnvVars.CLAUDE_CODE_OAUTH_TOKEN !== '';
}

const writeFlagSettingsFile = createFlagSettingsFileWriter();

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

interface RetryTeardownState {
  snapshotMsg: { uuid: string; content: string | MessageContent[] } | null;
}

interface RetryTeardownOptions {
  nextAttempt: number;
  recoveryState: { rateLimitCooldownScheduled: boolean; startGuard?: () => void };
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
  guardAfterBackoff?: boolean;
  restartQueue?: boolean;
  requeueConsumedList?: boolean;
  requeueFedPrompts?: boolean;
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
  onModelsFetched(queryGeneration?: number, attemptToken?: QueryAttemptToken): Promise<void>;
  onMarkApiSuccess(message: SDKMessage, queryGeneration?: number): Promise<void>;

  onMissingWorkflowMcpServers?: (session: AgentSession, missing: string[]) => Promise<void>;

  onMissingMemberSpaceMcpServers?: (sessionId: string, missing: string[]) => Promise<void>;

  consumePendingResumeSessionAt?(): string | undefined;

  onRateLimitExhausted?: (
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    hint?: LimitRetryHint,
    queryGeneration?: number
  ) => Promise<boolean>;

  isLimitRecoveryPending?(): boolean;
  endNetworkOutage?(): void;
  onNetworkOutage?(
    errorText: string,
    prompt: { uuid: string; content: string | MessageContent[] } | null,
    queryGeneration?: number
  ): Promise<boolean>;
}

export class QueryRunner {
  readonly retryPromptIdentity = new RetryPromptIdentity();
  private readonly toolInventory = new ObservedToolInventory();
  private toolInventoryOwner: QueryAttemptToken | null = null;
  private toolStatusRead = 0;
  private turnEndedGeneration: number | null = null;

  private streamSilence: StreamSilenceState = { lastActivityAt: 0, openTools: [] };

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

  private _turnConsumedGeneration: number | null = null;

  private fedAfterTurnEnd: Array<{
    uuid: string;
    content: string | MessageContent[];
    internal: boolean;
  }> = [];

  private redeliveredFedPrompts: string[] = [];

  private turnEndedState(queryGeneration: number): { turnEnded: boolean; hasFedPrompt: boolean } {
    if (this.turnEndedGeneration !== queryGeneration)
      return { turnEnded: false, hasFedPrompt: false };
    if (this.fedAfterTurnEnd.length === 0) return { turnEnded: true, hasFedPrompt: false };
    const fresh = this.fedAfterTurnEnd.some(
      (prompt) => !this.redeliveredFedPrompts.includes(prompt.uuid)
    );
    return { turnEnded: true, hasFedPrompt: fresh };
  }

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

  private readonly failures: QueryFailureGovernor;
  constructor(private ctx: QueryRunnerContext) {
    this.failures = new QueryFailureGovernor(ctx.session, ctx.db);
  }
  resetFailureEpisode() {
    return this.failures.reset();
  }

  failureLatchedUntil() {
    return this.failures.latchedUntil();
  }

  private notifyToolInventory(): void {
    this.ctx.messageHub.event(
      'session.toolInventory.changed',
      { sessionId: this.ctx.session.id },
      { channel: `session:${this.ctx.session.id}` }
    );
  }

  async getToolInventory(): Promise<SessionToolInventory> {
    const owner = this.toolInventoryOwner;
    const queryObject = this.ctx.queryObject;
    const snapshot = this.toolInventory.snapshot();
    if (!owner || !queryObject || snapshot.state !== 'observed') return snapshot;
    const read = ++this.toolStatusRead;
    let status: unknown;
    try {
      status = await queryObject.mcpServerStatus?.();
    } catch {
      status = null;
    }
    if (read === this.toolStatusRead && queryObject === this.ctx.queryObject) {
      const parsed = toolStatusSchema.safeParse(status);
      this.toolInventory.captureStatus(
        owner,
        parsed.success
          ? parsed.data
          : snapshot.mcpServers.map((server) => ({ name: server.name, status: 'unverified' }))
      );
    }
    return this.toolInventory.snapshot();
  }

  async applyToolChoice(): Promise<SessionToolApplication> {
    const owner = this.toolInventoryOwner,
      query = this.ctx.queryObject;
    if (!query)
      return this.ctx.queryPromise
        ? { application: 'restart_required', reason: 'query_not_ready' }
        : { application: 'next_query' };
    if (!owner?.isLive() || this.toolInventory.snapshot().state !== 'observed')
      return { application: 'restart_required', reason: 'query_not_ready' };
    if (!query.setMcpServers)
      return { application: 'restart_required', reason: 'live_mcp_unavailable' };
    const owns = () =>
      owner === this.toolInventoryOwner && owner.isLive() && query === this.ctx.queryObject;
    try {
      const result = await query.setMcpServers(
        this.ctx.optionsBuilder.getEffectiveMcpServers() ?? {}
      );
      if (!owns()) return { application: 'unverified', reason: 'query_changed' };
      if (Object.keys(result.errors ?? {}).length)
        return { application: 'unverified', reason: 'application_failed' };
      const read = ++this.toolStatusRead;
      const status = await query.mcpServerStatus?.();
      if (!owns()) return { application: 'unverified', reason: 'query_changed' };
      const parsed = toolStatusSchema.safeParse(status);
      if (!parsed.success || read !== this.toolStatusRead)
        return { application: 'unverified', reason: 'status_unavailable' };
      this.toolInventory.captureStatus(owner, parsed.data);
      this.notifyToolInventory();
      return { application: 'live' };
    } catch {
      return { application: 'unverified', reason: 'application_failed' };
    }
  }

  private queryLiveness: { promise: Promise<void>; isLive: () => boolean } | null = null;

  private hasLiveQuery(): boolean {
    const queryPromise = this.ctx.queryPromise;
    if (!queryPromise) return false;
    const tracked = this.queryLiveness;
    if (tracked && tracked.promise === queryPromise) return tracked.isLive();
    return true;
  }

  async start(startGuard?: () => void): Promise<void> {
    const { messageQueue, logger } = this.ctx;
    this.failures.assertOpen();

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

    const queryPromise = this.runQuery(currentGeneration, 0, {
      rateLimitCooldownScheduled: false,
      startGuard,
    });
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

  invalidateAttemptTokens(): void {
    this.ctx.attemptTokens.invalidateCurrent();
  }

  private createAttemptBoundPreToolUseHook(
    attemptToken: QueryAttemptToken,
    inputOrigin?: QuestionInputOriginSource
  ): HookCallback {
    const hook = this.ctx.askUserQuestionHandler.createPreToolUseHook(attemptToken, inputOrigin);
    return async (input, toolUseID, options) => {
      if (!attemptToken.isLive()) {
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
      }
      const result = await hook(input, toolUseID, options);
      if (
        !attemptToken.isLive() &&
        typeof result === 'object' &&
        result !== null &&
        'hookSpecificOutput' in result &&
        result.hookSpecificOutput &&
        (result.hookSpecificOutput as { hookEventName?: string }).hookEventName === 'PreToolUse' &&
        (result.hookSpecificOutput as { permissionDecision?: string }).permissionDecision ===
          'allow'
      ) {
        const { session, logger } = this.ctx;
        logger.warn(
          `PreToolUse hook: denying result from superseded query attempt ` +
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
      }
      return result;
    };
  }

  private createAttemptBoundCanUseTool(
    attemptToken: QueryAttemptToken,
    inputOrigin?: QuestionInputOriginSource
  ): CanUseTool {
    const canUseTool = this.ctx.askUserQuestionHandler.createCanUseToolCallback(
      attemptToken,
      inputOrigin
    );
    return async (toolName, input, options) => {
      if (!attemptToken.isLive()) {
        const { session, logger } = this.ctx;
        logger.warn(
          `CanUseTool: denying callback from superseded query attempt ` +
            `${attemptToken.attemptId} (session=${session.id}) — a retry or replacement owns the run`
        );
        return {
          behavior: 'deny',
          message:
            'The query attempt that issued this tool call was superseded by an automatic retry ' +
            'or a replacement query.',
        } as PermissionResult;
      }
      const result = await canUseTool(toolName, input, options);
      if (result === null || attemptToken.isLive()) return result;
      const { session, logger } = this.ctx;
      logger.warn(
        `CanUseTool: denying result from superseded query attempt ` +
          `${attemptToken.attemptId} (session=${session.id}) — a retry or replacement owns the run`
      );
      return {
        behavior: 'deny',
        message:
          'The query attempt that issued this tool call was superseded by an automatic retry ' +
          'or a replacement query.',
      } as PermissionResult;
    };
  }

  private async runQuery(
    queryGeneration: number,
    retryAttempt = 0,
    recoveryState: { rateLimitCooldownScheduled: boolean; startGuard?: () => void } = {
      rateLimitCooldownScheduled: false,
    }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;

    const attemptToken =
      this.ctx.getQueryGeneration() === queryGeneration
        ? this.ctx.attemptTokens.allocate()
        : QueryAttemptRegistry.detached();
    if (attemptToken.isLive()) {
      this.toolInventoryOwner = attemptToken;
      this.toolInventory.begin(attemptToken, 'sdk');
      this.notifyToolInventory();
    }
    const questionInputs = new QuestionInputScope(
      session.id,
      () => attemptToken.isLive() && this.isRunOwnershipLive(queryGeneration)
    );
    const questionOrigin = () => questionInputs.origin();
    const humanInputs = new QuestionInputScope(
      session.id,
      () => attemptToken.isLive() && this.isRunOwnershipLive(queryGeneration)
    );
    const attemptHook = this.createAttemptBoundPreToolUseHook(attemptToken, questionOrigin);

    let startupPermit: SdkStartupPermit | null = null;
    const releaseStartupPermit = (reason: string): void => {
      if (!startupPermit) return;
      const permit = startupPermit;
      startupPermit = null;
      if (!permit.release()) return;
      logger.warn(
        `SDK startup gate: slot released (session=${session.id} reason=${reason} ` +
          `heldMs=${Date.now() - permit.admittedAt})`
      );
    };

    let runAbortController: AbortController | null = null;
    let isAbortError = false;
    this.turnEndedGeneration = null;
    this.fedAfterTurnEnd = [];

    const inactivityBackstopMs = getSdkStartInactivityBackstopMs();
    const nudgeThresholdMs = DEFAULT_SDK_STARTUP_NUDGE_THRESHOLD_MS;
    const silenceThresholdMs = getStreamSilenceTimeoutMs();
    const openToolStallMs = getOpenToolStallTimeoutMs();
    let lastStall: { silentMs: number; openToolCount: number } | null = null;
    this.streamSilence = { lastActivityAt: Date.now(), openTools: [] };

    let processExitInfo: SdkStartExitInfo = { code: null, signal: null };
    let processExited = false;
    let deadReason: 'process_exit' | 'stream_closed' | 'backstop' | null = null;
    let removeFlagSettingsFile: (() => void) | undefined;
    let episodeId: string | undefined;
    const interruptEpoch = messageQueue.getUserInterruptEpoch?.();
    const owns = () =>
      this.ctx.getQueryGeneration() === queryGeneration && !this.ctx.isCleaningUp();
    const live = () => attemptToken.isLive() && owns();

    try {
      episodeId = await this.failures.admit(live);
      const { initializeProviders, waitForOptionalProviderRegistration } = await import(
        '../providers/factory.js'
      );
      const providerRegistry = initializeProviders();
      await waitForOptionalProviderRegistration();
      const modelId = session.config.model || 'sonnet';
      const rawProviderId = session.config.provider as string | undefined;
      const explicitProviderId = rawProviderId?.trim() || undefined;
      const resolvedProvider = await resolveAvailableQueryProvider(
        providerRegistry,
        modelId,
        explicitProviderId
      );
      let provider = resolvedProvider.provider;
      const normalizedProviderId = explicitProviderId ?? provider?.id;
      let providerAvailable = resolvedProvider.available;
      if (provider?.isAvailable && providerAvailable === null) {
        try {
          providerAvailable = await provider.isAvailable();
        } catch {
          providerAvailable = false;
        }
      }
      const explicitPin = rawProviderId != null && explicitProviderId !== undefined;
      const persistPin =
        normalizedProviderId !== undefined &&
        (explicitPin
          ? rawProviderId !== normalizedProviderId
          : providerAvailable !== false && !resolvedProvider.fallback);
      if (persistPin) {
        session.config.provider = normalizedProviderId as Session['config']['provider'];
      }
      if (persistPin) {
        try {
          await this.ctx.db.updateSession(session.id, {
            config: { ...session.config },
          });
        } catch (err) {
          logger.warn(
            `Failed to persist normalized provider '${normalizedProviderId}' for session ` +
              `${session.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (provider && providerAvailable === false) {
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

      const resolvedProviderId = explicitProviderId ?? provider?.id ?? 'anthropic';
      const providerSession = {
        ...session,
        config: {
          ...session.config,
          model: modelId,
          provider: resolvedProviderId as Session['config']['provider'],
        },
      };
      {
        const { getProviderService } = await import('../provider-service.ts');
        await getProviderService().resolveSessionProviderEnvVars(providerSession);
        provider = providerRegistry.get(resolvedProviderId) ?? provider;
      }

      const deadline = Date.now() + Math.min(inactivityBackstopMs, 60_000);
      const pendingOptions = runLagPhase('sdk:options_build', () =>
        optionsBuilder.build({
          askUserQuestionHook: attemptHook,
          canUseTool: this.createAttemptBoundCanUseTool(attemptToken, questionOrigin),
          operationInputOrigin: () => humanInputs.origin(),
          session: providerSession,
        })
      );

      let queryOptions = await this.failures.bound(() => pendingOptions, deadline, live);

      queryOptions = optionsBuilder.addSessionStateOptions(queryOptions);
      const mcpServerNames = Object.keys(queryOptions.mcpServers ?? {}).sort();
      const spacePolicy = resolveSpaceMcpSessionPolicy(session, {
        nodeExecutionRepo: this.ctx.db.getNodeExecutionRepo(),
        taskRepo: this.ctx.db.getSpaceTaskRepo(),
        longHorizonAgentRepo:
          this.ctx.db.getLongHorizonAgentRepo?.() ?? FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
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

      let resolveProcessExit: (() => void) | null = null;
      const processExitPromise = new Promise<void>((resolve) => {
        resolveProcessExit = resolve;
      });

      const originalSpawn = queryOptions.spawnClaudeCodeProcess;
      queryOptions.spawnClaudeCodeProcess = (opts: SpawnOptions): SpawnedProcess => {
        recoveryState.startGuard?.();
        const proc = runLagPhase('sdk:spawn', () =>
          originalSpawn ? originalSpawn(opts) : defaultSpawn(opts)
        ) as TrackedAgentProcess;
        this.ctx.trackAgentProcess(proc);
        const child = proc as unknown as ChildProcess;
        if (child.exitCode !== null) {
          processExitInfo = { code: child.exitCode, signal: child.signalCode ?? null };
          resolveProcessExit?.();
        } else {
          child.once('exit', (code, signal) => {
            processExitInfo = { code: code ?? null, signal: signal ?? null };
            resolveProcessExit?.();
          });
        }
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
        if (startupPermit.waitedMs > 0) {
          logger.warn(
            `SDK startup gate: session ${session.id} admitted after waiting ` +
              `${startupPermit.waitedMs}ms behind ${startupPermit.queuedBehind} session(s) ` +
              `(gate=${JSON.stringify(startupGate.getStats())})`
          );
        }
      }
      if (
        runAbortController.signal.aborted ||
        this.ctx.isCleaningUp() ||
        this.ctx.getQueryGeneration() !== queryGeneration ||
        !attemptToken.isLive()
      ) {
        releaseStartupPermit('aborted_while_queued');
        const gateAbort = new Error('SDK startup gate: query aborted while awaiting admission');
        gateAbort.name = 'AbortError';
        throw gateAbort;
      }

      {
        const { getProviderService } = await import('../provider-service.ts');
        const providerService = getProviderService();
        let providerEnvVars = await providerService.resolveSessionProviderEnvVars(providerSession);
        for (let attempt = 0; attempt < 3; attempt++) {
          const liveProvider = providerRegistry.get(resolvedProviderId);
          if (!liveProvider) {
            throw new Error(
              `Provider '${resolvedProviderId}' was removed while preparing to spawn ` +
                `(session '${session.id}'); refusing to apply its environment`
            );
          }
          if (liveProvider === provider) break;
          if (attempt === 2) {
            throw new Error(
              `Provider '${resolvedProviderId}' kept changing while preparing to spawn ` +
                `(session '${session.id}'); refusing to apply an unstable environment`
            );
          }
          provider = liveProvider;
          providerEnvVars = await providerService.resolveSessionProviderEnvVars(providerSession);
        }
        provider?.setSessionThinkingConfig?.(
          session.id,
          optionsBuilder.getEffectiveThinkingLevel()
        );
        setKeyBridgeThinkingOff(session.id, queryOptions.thinking?.type === 'disabled');
        const extraProviderManagedEnvVars = NON_ANTHROPIC_PREFIX_PROVIDER_VARS.filter(
          (key) => providerEnvVars[key] !== undefined
        );
        applyProviderEnvToFlagSettings(queryOptions, providerEnvVars);
        const childEnv = providerService.providerProcessEnv(providerSession, providerEnvVars);
        queryOptions.env = refreshQueryEnvFromProcess(queryOptions.env, childEnv, {
          refreshAutoCompactWindow: true,
          clearProviderManaged: true,
          preserveAnthropicAuthToken: resolvedProviderId === 'anthropic',
          preserveAnthropicOAuthToken: shouldPreserveAnthropicOAuthToken(
            resolvedProviderId,
            providerEnvVars
          ),
          skipAmbientAnthropicApiKey: resolvedProviderId !== 'anthropic',
          extraProviderManagedEnvVars,
        }) as Record<string, string>;
      }

      if (runAbortController.signal.aborted || !attemptToken.isLive()) {
        releaseStartupPermit('aborted_after_provider_env');
        const envAbort = new Error(
          'SDK startup gate: query aborted while preparing provider environment'
        );
        envAbort.name = 'AbortError';
        throw envAbort;
      }

      startupPermit?.setPhase('sdk_first_message');
      removeFlagSettingsFile = runLagPhase('sdk:flag_settings', () =>
        writeFlagSettingsFile(queryOptions, session.id)
      );
      recoveryState.startGuard?.();
      const queryObject = runLagPhase('sdk:query_create', () =>
        query({
          prompt: this.createMessageGeneratorWrapper(
            queryGeneration,
            recoveryState.startGuard,
            questionInputs,
            live,
            humanInputs
          ),
          options: queryOptions,
        })
      );
      this.ctx.queryObject = queryObject;

      this.ctx.onModelsFetched(queryGeneration, attemptToken).catch((e) => {
        logger.warn('Background fetch of models failed:', e);
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

      const sdkIterator = this.createAbortableQuery(queryObject, runAbortController.signal);
      let nextPromise = sdkIterator.next();
      const startupWatchMessages: SDKMessage[] = [];
      let nudgeSent = false;
      let firstMessageArrived = false;

      let resolveNudge: () => void = () => {};
      const nudgePromise = new Promise<void>((resolve) => {
        resolveNudge = resolve;
      });
      const nudgeTimeout = setTimeout(() => {
        resolveNudge();
      }, nudgeThresholdMs);

      let resolveBackstop: () => void = () => {};
      const backstopPromise = new Promise<void>((resolve) => {
        resolveBackstop = resolve;
      });
      const backstopTimeout = setTimeout(() => {
        resolveBackstop();
      }, inactivityBackstopMs);
      this.ctx.startupTimeoutTimer = backstopTimeout;

      let resolveDrain: () => void = () => {};
      const drainPromise = new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      let drainTimer: ReturnType<typeof setTimeout> | null = null;

      const abortPromise = new Promise<void>((resolve) => {
        if (runAbortController!.signal.aborted) {
          resolve();
        } else {
          runAbortController!.signal.addEventListener('abort', () => resolve(), { once: true });
        }
      });

      const logStartupTimeout = (elapsedMs: number): void => {
        const isRootWorkspace = !session.worktree;
        const workspaceDesc = isRootWorkspace
          ? `root workspace: ${session.workspacePath ?? 'unbound'}`
          : `worktree: ${session.worktree!.worktreePath}`;
        logger.error(
          `SDK startup timeout: SDK did not respond within ${elapsedMs}ms. ` +
            `Model: ${queryOptions.model}, ${workspaceDesc}` +
            (isRootWorkspace ? ' — running on root workspace (not a worktree)' : '') +
            ` The SDK subprocess did not emit its first message within the startup window; ` +
            `Startup permits expire independently of query recovery; slow startups may overlap after lease expiry.` +
            ` (Hint: set HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS to increase timeout, currently ${inactivityBackstopMs}ms)`
        );
        logger.error(
          `SDK startup timeout diagnostics: queueRunning=${messageQueue.isRunning()} ` +
            `queueSize=${messageQueue.size()} trackedPids=[${this.ctx
              .snapshotTrackedAgentProcesses()
              .map(([pid]) => pid)
              .join(',')}] sdkSessionId=${session.sdkSessionId ?? 'none'}`
        );
      };

      try {
        while (true) {
          if (runAbortController.signal.aborted) {
            break;
          }

          const race: Array<Promise<StartupWatchRace>> = [
            nextPromise.then(
              (result) => ({ kind: 'message' as const, result }),
              (error) => ({ kind: 'iterator_error' as const, error })
            ),
            abortPromise.then(() => ({ kind: 'abort' as const })),
          ];
          if (!firstMessageArrived) {
            if (!processExited) {
              race.push(processExitPromise.then(() => ({ kind: 'exit' as const })));
            }
            if (!nudgeSent && !processExited) {
              race.push(nudgePromise.then(() => ({ kind: 'nudge' as const })));
            }
            if (processExited) {
              race.push(drainPromise.then(() => ({ kind: 'drain' as const })));
            }
            race.push(backstopPromise.then(() => ({ kind: 'backstop' as const })));
          }
          const silence = () =>
            planStreamSilence({
              state: this.streamSilence,
              processing: stateManager.getState().status === 'processing',
              now: Date.now(),
              thresholdMs: silenceThresholdMs,
              openToolStallMs,
            });
          let silenceTimer: ReturnType<typeof setTimeout> | undefined;
          if (firstMessageArrived) {
            const planned = silence();
            race.push(
              new Promise<StartupWatchRace>((resolve) => {
                silenceTimer = setTimeout(
                  () => resolve({ kind: 'silence' }),
                  planned.stalled ? 0 : planned.waitMs
                );
              })
            );
          }

          const winner = await Promise.race(race);
          clearTimeout(silenceTimer);

          if (winner.kind === 'silence') {
            const planned = silence();
            if (!planned.stalled) continue;
            const openTools = this.streamSilence.openTools;
            lastStall = { silentMs: planned.silentMs, openToolCount: openTools.length };
            logger.warn(
              openTools.length
                ? `Model stream silent for ${planned.silentMs}ms with ${openTools.length} open tool call(s) [${openTools.join(', ')}]; aborting the request.`
                : `Model stream silent for ${planned.silentMs}ms; aborting the request.`
            );
            throw new Error(
              openTools.length
                ? `${STREAM_STALL_ERROR}: ${openTools.length} tool call(s) ran without a result for ${Math.round(planned.silentMs / 1000)}s`
                : `${STREAM_STALL_ERROR}: no data from the model for ${Math.round(planned.silentMs / 1000)}s`
            );
          }

          if (winner.kind === 'abort') {
            break;
          }

          if (winner.kind === 'iterator_error') {
            if (!firstMessageArrived && processExited) {
              deadReason = 'process_exit';
              logger.error(
                `SDK startup liveness: SDK iterator rejected after the process exited ` +
                  `(code=${processExitInfo.code}, signal=${processExitInfo.signal}). ` +
                  'Treating as a startup timeout and retrying once if a prompt is available.'
              );
              throw new Error('SDK startup timeout - query aborted');
            }
            throw winner.error;
          }

          if (winner.kind === 'nudge') {
            nudgeSent = true;
            clearTimeout(nudgeTimeout);
            await runStartupWatch(
              { nudgeThresholdMs, inactivityBackstopMs },
              {
                messages: startupWatchMessages,
                processExit: null,
                streamClosed: false,
                inactivity: { elapsedMs: nudgeThresholdMs, lastActivityAt: null },
              }
            );
            continue;
          }

          if (winner.kind === 'backstop') {
            const outcome = await runStartupWatch(
              {
                nudgeThresholdMs: nudgeSent ? Number.POSITIVE_INFINITY : nudgeThresholdMs,
                inactivityBackstopMs,
              },
              {
                messages: startupWatchMessages,
                processExit: processExited ? processExitInfo : null,
                streamClosed: false,
                inactivity: { elapsedMs: inactivityBackstopMs, lastActivityAt: null },
              }
            );
            if (outcome.action === 'abort-backstop') {
              deadReason = 'backstop';
              logStartupTimeout(inactivityBackstopMs);
              throw new Error('SDK startup timeout - query aborted');
            }
            if (outcome.action === 'retry-dead') {
              if (outcome.reason === 'process_exit') {
                deadReason = 'process_exit';
                logger.error(
                  `SDK startup liveness: SDK process exited before the first message ` +
                    `(code=${processExitInfo.code}, signal=${processExitInfo.signal}). ` +
                    'Treating as a startup timeout and retrying once if a prompt is available.'
                );
              } else {
                deadReason = 'stream_closed';
                logger.error(
                  'SDK startup liveness: SDK stream closed before the first message. ' +
                    'Treating as a startup timeout and retrying once if a prompt is available.'
                );
              }
              throw new Error('SDK startup timeout - query aborted');
            }
            continue;
          }

          if (winner.kind === 'exit') {
            processExited = true;
            if (drainTimer === null) {
              drainTimer = setTimeout(() => resolveDrain(), RETRY_EXIT_TIMEOUT_MS);
            }
            continue;
          }

          if (winner.kind === 'drain') {
            const outcome = await runStartupWatch(
              {
                nudgeThresholdMs: nudgeSent ? Number.POSITIVE_INFINITY : nudgeThresholdMs,
                inactivityBackstopMs,
              },
              {
                messages: startupWatchMessages,
                processExit: processExitInfo,
                streamClosed: false,
                inactivity: null,
              }
            );
            if (outcome.action === 'retry-dead') {
              deadReason = 'process_exit';
              logger.error(
                `SDK startup liveness: SDK process exited before the first message ` +
                  `(code=${processExitInfo.code}, signal=${processExitInfo.signal}). ` +
                  'Treating as a startup timeout and retrying once if a prompt is available.'
              );
              throw new Error('SDK startup timeout - query aborted');
            }
            continue;
          }

          const { result } = winner;
          if (result.done) {
            if (firstMessageArrived) {
              break;
            }
            const consumedPrompts = this._consumedUserMessages.get(queryGeneration) ?? [];
            const hasUnsentYieldedPrompt = consumedPrompts.some((m) =>
              this.ctx.messageQueue.hasYielded(m.uuid)
            );
            if (hasUnsentYieldedPrompt || consumedPrompts.length > 0 || messageQueue.size() > 0) {
              break;
            }
            const outcome = await runStartupWatch(
              {
                nudgeThresholdMs: nudgeSent ? Number.POSITIVE_INFINITY : nudgeThresholdMs,
                inactivityBackstopMs,
              },
              {
                messages: startupWatchMessages,
                processExit: processExited ? processExitInfo : null,
                streamClosed: !processExited,
                inactivity: null,
              }
            );
            if (outcome.action === 'retry-dead') {
              if (processExited) {
                deadReason = 'process_exit';
                logger.error(
                  `SDK startup liveness: SDK process exited before the first message ` +
                    `(code=${processExitInfo.code}, signal=${processExitInfo.signal}). ` +
                    'Treating as a startup timeout and retrying once if a prompt is available.'
                );
              } else {
                deadReason = 'stream_closed';
                logger.error(
                  'SDK startup liveness: SDK stream closed before the first message. ' +
                    'Treating as a startup timeout and retrying once if a prompt is available.'
                );
              }
              throw new Error('SDK startup timeout - query aborted');
            }
            break;
          }

          const message = this.retryPromptIdentity.incoming(
            result.value as SDKMessage
          ) as SDKMessage & Record<string, unknown>;
          const sessionResult = () =>
            isSDKResultMessage(message) &&
            message.parent_tool_use_id == null &&
            !message.internal_compaction_turn &&
            !(message.recovery_intercepted && !message.recovery_billing_terminal);
          if ((session.config.provider ?? 'anthropic') === 'anthropic') {
            const authRetry = isSDKAPIRetryMessage(message) && message.error_status === 401;
            const authResult =
              isSDKResultMessage(message) &&
              sessionResult() &&
              message.is_error === true &&
              ((isSDKResultSuccess(message) && message.api_error_status === 401) ||
                isClaudeAuthenticationError(
                  isSDKResultSuccess(message) ? message.result : message.errors.join('\n')
                ));
            if (authRetry || authResult) {
              if (authResult) await this.ctx.db.saveSDKMessage(session.id, message);
              throw new Error('401 Claude authentication failed');
            }
          }
          this.streamSilence = noteStreamMessage(this.streamSilence, message, Date.now());
          if (!firstMessageArrived) {
            startupWatchMessages.push(message);
            const elapsed = Date.now() - queryStartTime;
            const messageOutcome = await runStartupWatch(
              {
                nudgeThresholdMs: nudgeSent ? Number.POSITIVE_INFINITY : nudgeThresholdMs,
                inactivityBackstopMs,
              },
              {
                messages: startupWatchMessages,
                processExit: null,
                streamClosed: false,
                inactivity: { elapsedMs: elapsed, lastActivityAt: null },
              }
            );
            if (messageOutcome.action === 'continue' && messageOutcome.disarmed) {
              firstMessageArrived = true;
              this.ctx.firstMessageReceived = true;
              clearTimeout(nudgeTimeout);
              clearTimeout(backstopTimeout);
              if (drainTimer) {
                clearTimeout(drainTimer);
                drainTimer = null;
              }
              if (this.ctx.startupTimeoutTimer === backstopTimeout) {
                this.ctx.startupTimeoutTimer = null;
              }
              releaseStartupPermit('first_message');
              this._consumedUserMessages.delete(queryGeneration);
            } else if (messageOutcome.action === 'nudge-slow') {
              nudgeSent = true;
              clearTimeout(nudgeTimeout);
            } else if (
              messageOutcome.action === 'abort-backstop' ||
              messageOutcome.action === 'retry-dead'
            ) {
              if (messageOutcome.action === 'abort-backstop') {
                deadReason = 'backstop';
              } else {
                deadReason =
                  messageOutcome.reason === 'process_exit' ? 'process_exit' : 'stream_closed';
              }
              logStartupTimeout(elapsed);
              throw new Error('SDK startup timeout - query aborted');
            }
          }

          const turnEndedGeneration = planTurnEndedGeneration(
            this.turnEndedGeneration,
            message as SDKMessage & { subtype?: string; state?: string },
            queryGeneration
          );
          if (message.type === 'result' || turnEndedGeneration !== this.turnEndedGeneration)
            this.fedAfterTurnEnd = [];
          this.turnEndedGeneration = turnEndedGeneration;
          try {
            if (isSDKSystemInit(message)) {
              this.toolInventory.captureInit(attemptToken, {
                tools: message.tools ?? [],
                skills: message.skills ?? [],
                plugins: message.plugins ?? [],
                mcp_servers: message.mcp_servers ?? [],
              });
              this.notifyToolInventory();
            }
            if (message.type === 'result') {
              questionInputs.endTurn();
              humanInputs.endTurn();
            }
            await this.handleSDKMessage(message, queryGeneration);
          } catch (error) {
            await this.handleStreamMessageError(message, error, queryGeneration, attemptToken);
          }
          if (live() && sessionResult() && isSDKResultMessage(message)) {
            if (message.is_error === true) {
              await this.failures.failure(JSON.stringify(message), episodeId);
              this.failures.assertOpen();
            } else if (!isTopLevelHollowTaskNotificationResult(message)) {
              retryAttempt = 0;
              await this.failures.success(episodeId);
            }
          }
          nextPromise = sdkIterator.next();
        }

        if (this.ctx.getQueryGeneration() === queryGeneration) {
          this.ctx.consumePendingResumeSessionAt?.();
          messageQueue.stop();
        }
      } finally {
        clearTimeout(nudgeTimeout);
        clearTimeout(backstopTimeout);
        if (drainTimer) {
          clearTimeout(drainTimer);
        }
        if (this.ctx.startupTimeoutTimer === backstopTimeout) {
          this.ctx.startupTimeoutTimer = null;
        }
        resolveNudge = () => {};
        resolveBackstop = () => {};
        resolveDrain = () => {};
      }
    } catch (error) {
      this.ctx.attemptTokens.invalidate(attemptToken);

      releaseStartupPermit('query_error');

      const errorMessage = String(error);
      isAbortError = error instanceof Error && error.name === 'AbortError';
      const cancelled = isAbortError || stateManager.getState().status === 'interrupted';
      const isQueryInterrupted =
        cancelled || this.ctx.queryAbortController?.signal.aborted === true;
      let episode: Session['metadata']['queryFailureEpisode'];
      if (!cancelled && owns()) {
        episode =
          episodeId &&
          !(error instanceof QueryFailureCapError) &&
          !isNetworkUnreachableError(errorMessage)
            ? await this.failures.failure(errorMessage, episodeId)
            : session.metadata.queryFailureEpisode;
      }
      const isStartupTimeout = errorMessage.includes('SDK startup timeout');
      const isConversationNotFound = errorMessage.includes('No conversation found');
      const isMessageNotFound = errorMessage.includes('No message found');

      const maxProviderRetries = getMaxProviderRetries();

      const isTransientConnectionError = TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.some((substr) =>
        errorMessage.includes(substr)
      );
      const isStreamStall = errorMessage.includes(STREAM_STALL_ERROR);

      const providerId = session.config.provider as string | undefined;
      const isProviderSession = providerId && providerId !== 'anthropic';
      const limitAssessment = assessLimitError({ rawText: errorMessage });
      const retrySignal: QueryRetryErrorSignal = {
        rawText: errorMessage,
        errorName: error instanceof Error ? error.name : undefined,
        isStartupTimeout,
        isConversationNotFound,
        isMessageNotFound,
        isTransientConnectionError,
        isStreamStall,
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
        isNetworkUnreachable: isNetworkUnreachableError(errorMessage),
      };
      const retryEnv: QueryRetryEnvironment = {
        attempt: retryAttempt,
        maxProviderRetries,
        providerFamily: isProviderSession ? 'provider' : 'anthropic',
        hasConsumedPrompt: (this._consumedUserMessages.get(queryGeneration)?.length ?? 0) > 0,
        hasQueuedPrompt: messageQueue.size() > 0,
        ...this.turnEndedState(queryGeneration),
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
      if (episode?.failed) {
        const terminal = new QueryFailureCapError(
          `Query stopped after ${episode.failures} failures: ${episode.error}. Use Retry to recover.`
        );
        messageQueue.clear(terminal);
        await errorManager.handleError(
          session.id,
          terminal,
          decideProviderTerminalCategory(retrySignal, retryEnv),
          terminal.message,
          stateManager.getState(),
          { queryFailureEpisode: episode },
          () => owns() && session.metadata.queryFailureEpisode?.id === episode.id
        );
        return;
      }
      const queueRunningAtEntry = messageQueue.isRunning();

      if (routeDecision.route.action === 'expected_recovery_noop') {
        logger.info(
          'SDK process exit during rate-limit recovery: attributing the CLI process exit ' +
            'to the in-flight recovery restart; no error report.'
        );
        return;
      }

      if (routeDecision.route.action === 'network_pause') {
        logger.warn(`Model provider unreachable; pausing the turn: ${errorMessage}`);
        await this.ctx.onNetworkOutage?.(
          errorMessage,
          this._lastConsumedUserMessage,
          queryGeneration
        );
        return;
      }

      if (
        routeDecision.route.action === 'turn_ended_noop' ||
        routeDecision.route.action === 'turn_ended_redeliver'
      )
        logger.info(`SDK process exited after its turn ended with a result: ${errorMessage}`);
      else logger.error('Streaming query error:', error);

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
        const startupRetryNotice = ((): string => {
          if (deadReason === 'process_exit') {
            const exitDesc = processExitInfo.signal
              ? `signal ${processExitInfo.signal}`
              : `code ${processExitInfo.code ?? 'unknown'}`;
            return `⚠️ The AI session failed to start — process exited (${exitDesc}); retrying…`;
          }
          if (deadReason === 'stream_closed') {
            return `⚠️ The AI session failed to start — SDK stream closed; retrying…`;
          }
          return (
            `⚠️ The AI session is slow to start — no response after ` +
            `${Math.round(inactivityBackstopMs / 1000)}s. Retrying…`
          );
        })();
        logger.warn('Auto-retrying query after startup timeout (1 retry).');
        runAbortController?.abort();
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
          restartQueue: true,
          requeueConsumedList: true,
          noticeAfterTeardown: startupRetryNotice,
        });
      }
      if (routeDecision.route.action === 'turn_ended_redeliver') {
        logger.info('Redelivering the prompts fed after the turn ended into a fresh query.');
        runAbortController?.abort();
        return await this.runRetryTeardown(queryGeneration, attemptToken, {
          nextAttempt: 0,
          recoveryState,
          resetStartupState: true,
          idleFirst: true,
          routeGuard: {
            expectedAction: 'turn_ended_redeliver',
            retrySignal,
            retryEnv,
            queueRunningAtEntry,
            abandonLabel: 'Turn-ended redelivery',
          },
          terminateProcesses: true,
          guardAfterExit: true,
          restartQueue: true,
          requeueFedPrompts: true,
        });
      }
      if (routeDecision.route.action === 'claude_auth_retry') {
        return await this.runRetryTeardown(queryGeneration, attemptToken, {
          nextAttempt: 1,
          recoveryState,
          resetStartupState: true,
          idleFirst: true,
          snapshotLastConsumed: true,
          snapshotRequeueLabel: 'Claude login retry',
          terminateProcesses: true,
          guardAfterExit: true,
          restartQueue: true,
        });
      }
      if (routeDecision.route.action === 'stream_stall_retry') {
        logger.warn('Retrying a model request that went silent (1 retry).');
        return await this.runRetryTeardown(queryGeneration, attemptToken, {
          nextAttempt: 1,
          recoveryState,
          resetStartupState: true,
          idleFirst: true,
          snapshotLastConsumed: true,
          snapshotRequeueLabel: 'model stream stall retry',
          notice:
            lastStall && lastStall.openToolCount > 0
              ? `⚠️ ${lastStall.openToolCount} tool call(s) ran without a result for ${Math.round(lastStall.silentMs / 1000)} s. Retrying…`
              : `⚠️ The model sent nothing for ${Math.round((lastStall?.silentMs ?? silenceThresholdMs) / 1000)} s. Retrying…`,
          guardAfterExit: true,
          restartQueue: true,
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
          snapshotLastConsumed: true,
          snapshotRequeueLabel: 'transient connection error retry',
          notice: '⚠️ The connection was interrupted. Retrying…',
          guardAfterExit: true,
          restartQueue: true,
        });
      }

      if (routeDecision.route.action === 'provider_backoff') {
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

      if (!isAbortError) {
        const processingState = stateManager.getState();
        let decision = routeDecision;

        if (decision.route.action === 'rate_limit_handoff') {
          let handoffAccepted = false;
          try {
            handoffAccepted = !!(await this.ctx.onRateLimitExhausted?.(
              errorMessage,
              this._lastConsumedUserMessage,
              retrySignal.rateLimitHint ?? undefined,
              queryGeneration
            ));
          } catch (handoffError) {
            if (owns())
              messageQueue.clear(error instanceof Error ? error : new Error(errorMessage));
            throw handoffError;
          }
          if (!owns()) return;
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

        if (
          !cancelled &&
          messageQueue.getUserInterruptEpoch?.() === interruptEpoch &&
          decision.route.action === 'terminal' &&
          session.metadata.queryFailureEpisode?.id === episodeId &&
          (session.metadata.queryFailureEpisode?.failures ?? 0) > 0 &&
          (this._lastConsumedUserMessage || retryEnv.hasConsumedPrompt || messageQueue.size() > 0)
        ) {
          const consumed = (this._consumedUserMessages.get(queryGeneration)?.length ?? 0) > 0;
          return await this.runRetryTeardown(queryGeneration, attemptToken, {
            nextAttempt: retryAttempt + 1,
            recoveryState,
            resetStartupState: true,
            idleFirst: true,
            routeGuard: {
              expectedAction: decision.route.action,
              retrySignal,
              retryEnv: {
                ...retryEnv,
                rateLimitHandoffResult:
                  routeDecision.route.action === 'rate_limit_handoff' ? 'declined' : undefined,
              },
              queueRunningAtEntry,
              abandonLabel: 'Shared query failure retry',
            },
            guardAfterBackoff: true,
            terminateProcesses: true,
            guardAfterExit: true,
            restartQueue: true,
            requeueConsumedList: consumed,
            snapshotLastConsumed: !consumed,
            snapshotRequeueLabel: 'shared query failure retry',
          });
        }

        messageQueue.clear(
          cancelled ? undefined : error instanceof Error ? error : new Error(errorMessage)
        );
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
          this.ctx.endNetworkOutage?.();
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
                this.terminalUserMessageFor(
                  route.messageHint,
                  maxProviderRetries,
                  inactivityBackstopMs,
                  deadReason
                ),
                processingState,
                {
                  errorMessage,
                  queueSize: messageQueue.size(),
                  providerId: providerId ?? 'anthropic',
                  workspacePath: session.workspacePath ?? undefined,
                  isRootWorkspace: !session.worktree,
                  startupTimeoutMs: inactivityBackstopMs,
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
      } else {
        messageQueue.clear();
      }
    } finally {
      this.ctx.attemptTokens.invalidate(attemptToken);
      this.toolInventory.end(attemptToken);
      this.notifyToolInventory();
      removeFlagSettingsFile?.();

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

        this._lastConsumedUserMessage = null;
        this._turnConsumedUserMessages = [];
        this._turnConsumedGeneration = null;

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

  private async runRetryTeardown(
    queryGeneration: number,
    attemptToken: QueryAttemptToken,
    options: RetryTeardownOptions
  ): Promise<void> {
    const { messageQueue, stateManager, logger } = this.ctx;

    this.ctx.attemptTokens.invalidate(attemptToken);

    const interruptEpoch = messageQueue.getUserInterruptEpoch?.();
    const abandon = (point: string): boolean => {
      if (messageQueue.getUserInterruptEpoch?.() !== interruptEpoch) return true;
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

    const restartQueue = (state: RetryTeardownState): RetryTeardownState => {
      if (!this.ctx.isCleaningUp() && stateManager.getState().status !== 'interrupted') {
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
          if (messageQueue.requeueYielded(message.uuid)) {
            continue;
          }
          messageQueue
            .enqueueWithId(message.uuid, message.content, false, { prepend: true })
            .catch(() => {});
        }
        this._consumedUserMessages.delete(queryGeneration);
        this._lastConsumedUserMessage = null;
      }
      return state;
    };

    const requeueFedPrompts = (state: RetryTeardownState): RetryTeardownState => {
      const fed = this.fedAfterTurnEnd;
      this.fedAfterTurnEnd = [];
      this.redeliveredFedPrompts = [
        ...this.redeliveredFedPrompts,
        ...fed.map((message) => message.uuid),
      ].slice(-32);
      logger.warn(`Re-enqueueing ${fed.length} prompt(s) fed after the turn ended.`);
      for (let i = fed.length - 1; i >= 0; i--) {
        const message = fed[i];
        if (messageQueue.requeueYielded(message.uuid)) continue;
        messageQueue
          .enqueueWithId(message.uuid, message.content, message.internal, { prepend: true })
          .catch(() => {});
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

    const backoff = async (): Promise<void> => {
      if (options.backoffMs !== undefined) {
        await sleep(options.backoffMs);
      }
      await this.failures.admit(() => this.ctx.getQueryGeneration() === queryGeneration);
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
      restartQueue: options.restartQueue ? restartQueue : undefined,
      requeueConsumedList: options.requeueConsumedList ? requeueConsumedList : undefined,
      requeueFedPrompts: options.requeueFedPrompts ? requeueFedPrompts : undefined,
      displayPostTeardownNotice:
        options.noticeAfterTeardown !== undefined ? displayPostTeardownNotice : undefined,
      publicationAbandoned:
        options.noticeAfterTeardown !== undefined ? () => abandon('publication') : undefined,
      backoff,
      backoffAbandoned: () => {
        if (messageQueue.getUserInterruptEpoch?.() !== interruptEpoch) return true;
        if (options.guardAfterBackoff) return abandon('backoff');
        if (options.backoffMs === undefined || this.isRunOwnershipLive(queryGeneration))
          return false;
        this.retrySupersededByReplacement(queryGeneration);
        logger.warn(
          'Provider error retry cancelled: session interrupted/restarted/cleaning up during backoff.'
        );
        return true;
      },
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
      .pipe('?restartQueue', 'state', 'state')
      .pipe('?requeueConsumedList', 'state', 'state')
      .pipe('?requeueFedPrompts', 'state', 'state')
      .pipe('?displayPostTeardownNotice', 'state')
      .pipe('!?publicationAbandoned', 'state')
      .pipe('?backoff', 'state')
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
        ...this.turnEndedState(queryGeneration),
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

  async *createMessageGeneratorWrapper(
    queryGeneration: number,
    startGuard?: () => void,
    questionInputs?: QuestionInputScope,
    liveAttempt?: () => boolean,
    humanInputs?: QuestionInputScope
  ) {
    const { session, messageQueue, stateManager, logger } = this.ctx;

    for await (const { message, onSent } of messageQueue.messageGenerator(session.id, {
      suppressPreYieldCallback: true,
      queryGeneration,
    })) {
      if (this.ctx.isLimitRecoveryPending?.()) {
        logger.info('Prompt feed: limit recovery engaged; requeueing prompt until the retry.');
        const yieldedUuid = message.uuid;
        if (yieldedUuid && !messageQueue.requeueYielded(yieldedUuid)) {
          logger.warn(`Prompt feed: could not requeue yielded prompt ${yieldedUuid}.`);
        }
        break;
      }
      const live = () => !this.ctx.isCleaningUp() && (liveAttempt?.() ?? true);
      await this.failures.admit(live);
      await messageQueue.onMessageYielded?.(message.uuid ?? '', Date.now());
      const queuedMessage = message as typeof message & { internal?: boolean };
      const isInternal = queuedMessage.internal || false;
      const promptContent = (queuedMessage.message as { content?: unknown } | undefined)?.content;
      const promptText =
        typeof promptContent === 'string'
          ? promptContent
          : Array.isArray(promptContent) &&
              promptContent.length === 1 &&
              (promptContent[0] as { type?: unknown; text?: unknown } | undefined)?.type ===
                'text' &&
              typeof (promptContent[0] as { text?: unknown }).text === 'string'
            ? ((promptContent[0] as { text: string }).text as string)
            : undefined;
      const startsDaemonTurn =
        isInternal &&
        (promptText === '/compact' || promptText === TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE);

      if (startsDaemonTurn && stateManager.getState().status !== 'processing') {
        await stateManager.setProcessing(queuedMessage.uuid ?? 'unknown', 'initializing');
      }

      if (!isInternal) {
        this._lastConsumedUserMessage = {
          uuid: message.uuid ?? '',
          content: (message.message?.content ?? '') as unknown as string | MessageContent[],
        };
        if (this._turnConsumedGeneration !== queryGeneration) {
          this._turnConsumedUserMessages = [];
          this._turnConsumedGeneration = queryGeneration;
        }
        this._turnConsumedUserMessages.push({
          uuid: message.uuid ?? '',
          content: (message.message?.content ?? '') as unknown as string | MessageContent[],
        });
        if (this._turnConsumedUserMessages.length > 32) {
          this._turnConsumedUserMessages.shift();
        }
        await stateManager.setProcessing(
          message.uuid ?? 'unknown',
          'initializing',
          this._turnConsumedUserMessages.map((entry) => entry.uuid)
        );
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

      startGuard?.();
      questionInputs?.recordInput(queuedMessage);
      if (humanInputs && message.uuid && neoCoordinatorBinding(this.ctx.db, session.id)) {
        const prompt = this.ctx.db.getSDKMessageRepo().getDeliveryContent(session.id, message.uuid);
        if (prompt?.inputKind === 'human') humanInputs.recordInput(queuedMessage);
      }
      if (this.turnEndedGeneration === queryGeneration)
        this.fedAfterTurnEnd.push({
          uuid: message.uuid ?? '',
          content: (message.message?.content ?? '') as unknown as string | MessageContent[],
          internal: isInternal,
        });
      yield this.retryPromptIdentity.outgoing(
        message,
        !!neoCoordinatorBinding(this.ctx.db, session.id)
      );
      this.streamSilence = noteStreamFed(this.streamSilence, Date.now());
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
    maxProviderRetries: number,
    startupTimeoutMs: number,
    deadReason: 'process_exit' | 'stream_closed' | 'backstop' | null = null
  ): string | undefined {
    const { session } = this.ctx;
    if (messageHint === 'claude_login_failed') return 'Claude login failed — sign in again';
    if (messageHint === 'startup_timeout') {
      if (deadReason === 'process_exit') {
        return (
          `The AI session failed to start (workspace: ${session.workspacePath ?? 'unbound'}). ` +
          `The SDK process exited unexpectedly (after one automatic retry). ` +
          `Try: resending your message.`
        );
      }
      if (deadReason === 'stream_closed') {
        return (
          `The AI session failed to start (workspace: ${session.workspacePath ?? 'unbound'}). ` +
          `The SDK stream closed unexpectedly (after one automatic retry). ` +
          `Try: resending your message.`
        );
      }
      return (
        `The AI session failed to start (workspace: ${session.workspacePath ?? 'unbound'}). ` +
        `The SDK subprocess did not emit its first message within the startup window ` +
        `(after one automatic retry); Startup permits expire independently of query recovery; slow startups may overlap after lease expiry. ` +
        `Try: resending your message, or increase the timeout with ` +
        `HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS (current: ${startupTimeoutMs}ms).`
      );
    }
    if (messageHint === 'stream_stall') {
      return (
        `The model stopped sending anything for ${Math.round(getStreamSilenceTimeoutMs() / 1000)} s ` +
        `(${Math.round(getOpenToolStallTimeoutMs() / 1000)} s while a tool call was open), ` +
        `again after one automatic retry, so this turn was stopped. ` +
        `Try: resending your message, or switching models. The limits are ` +
        `HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS (current: ${getStreamSilenceTimeoutMs()}ms) and ` +
        `HYPERNEO_SDK_OPEN_TOOL_STALL_TIMEOUT_MS (current: ${getOpenToolStallTimeoutMs()}ms).`
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

    if (!(await db.saveSDKMessage(session.id, assistantMessage))) {
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
