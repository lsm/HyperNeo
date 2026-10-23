import { isProviderNotRegisteredMessage } from '../providers/session-provider-env-pipeline.ts';
import { ErrorCategory } from '../error-manager.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { LimitRetryHint } from './limit-error-classifier.ts';

export type QueryRetryProviderFamily = 'anthropic' | 'provider';

export type QueryRetryHandoffResult = 'accepted' | 'declined' | 'thrown';

export interface QueryRetryLifecycle {
  processingStatus:
    | 'idle'
    | 'processing'
    | 'interrupted'
    | 'rate_limit_cooldown'
    | 'queued'
    | 'waiting_for_input';
  abortSignalAborted: boolean;
  isLimitRecoveryPending: boolean;
}

export interface QueryRetryEnvironment {
  attempt: number;
  maxProviderRetries: number;
  providerFamily: QueryRetryProviderFamily;
  hasConsumedPrompt: boolean;
  hasQueuedPrompt: boolean;
  turnEnded: boolean;
  hasFedPrompt?: boolean;
  lifecycle: QueryRetryLifecycle;
  isCleaningUp: boolean;
  isSuperseded: boolean;
  hasRateLimitHandoff: boolean;
  useProviderFallback?: boolean;
  recoveryState: { rateLimitCooldownScheduled: boolean };
  rateLimitHandoffResult?: QueryRetryHandoffResult;
}

export interface QueryRetryErrorSignal {
  rawText: string;
  errorName: string | undefined;
  isStartupTimeout: boolean;
  isConversationNotFound: boolean;
  isMessageNotFound: boolean;
  isTransientConnectionError: boolean;
  isStreamStall?: boolean;
  isRetryableProviderError: boolean;
  isRateLimit: boolean;
  rateLimitHint: LimitRetryHint | null;
  apiValidationText: string | null;
  isNetworkUnreachable?: boolean;
}

export type QueryRetryRoute =
  | { action: 'startup_timeout_retry'; redeliver: 'consumed' | 'queue' }
  | { action: 'message_not_found_retry' }
  | { action: 'transient_retry' }
  | { action: 'claude_auth_retry' }
  | { action: 'stream_stall_retry' }
  | { action: 'network_pause' }
  | { action: 'provider_backoff'; nextAttempt: number }
  | { action: 'rate_limit_handoff'; hint: LimitRetryHint }
  | { action: 'api_validation'; text: string }
  | { action: 'aborted_noop' }
  | { action: 'cleanup_noop' }
  | { action: 'superseded_noop' }
  | { action: 'expected_recovery_noop' }
  | { action: 'turn_ended_noop' }
  | { action: 'turn_ended_redeliver' }
  | { action: 'terminal'; category: ErrorCategory; messageHint: string | undefined };

export interface QueryRetryRouteInput {
  errorSignal: QueryRetryErrorSignal;
  env: QueryRetryEnvironment;
}

export interface QueryRetryFinalizer {
  skipQueueClear: boolean;
  skipStop: boolean;
  skipCatchIdle: boolean;
  skipFinalizerIdle: (env: QueryRetryEnvironment) => boolean;
  skipBeginTerminalIdle: boolean;
  skipErrorManager: boolean;
}

export interface QueryRetryDecision {
  route: QueryRetryRoute;
  finalizer: QueryRetryFinalizer;
}

function isQueryInterrupted(
  signal: QueryRetryErrorSignal,
  lifecycle: QueryRetryLifecycle
): boolean {
  return (
    signal.errorName === 'AbortError' ||
    lifecycle.processingStatus === 'interrupted' ||
    lifecycle.abortSignalAborted
  );
}

const SDK_PROCESS_EXIT_ERROR_RE = /claude code process (?:exited with code|terminated by signal)/i;

export function isSdkProcessExitError(rawText: string): boolean {
  return SDK_PROCESS_EXIT_ERROR_RE.test(rawText);
}

const NEW_TURN_MESSAGE_TYPES = new Set(['assistant', 'user', 'stream_event']);

export function planTurnEndedGeneration(
  current: number | null,
  message: { type: string; subtype?: string; state?: string; parent_tool_use_id?: string | null },
  queryGeneration: number
): number | null {
  if (message.type === 'result') return message.parent_tool_use_id ? null : queryGeneration;
  if (NEW_TURN_MESSAGE_TYPES.has(message.type)) return null;
  if (message.type === 'system' && message.subtype === 'session_state_changed')
    return message.state === 'running' ? null : current;
  return current;
}

export function decideProviderTerminalCategory(
  signal: QueryRetryErrorSignal,
  env: QueryRetryEnvironment
): ErrorCategory {
  const raw = signal.rawText.toLowerCase();
  if (signal.isStreamStall) return ErrorCategory.TIMEOUT;
  if (env.providerFamily === 'provider') {
    if (
      /\b(?:401|403|unauthorized|token expired|token_expired|not authenticated|invalid_api_key)\b/.test(
        raw
      )
    )
      return ErrorCategory.PROVIDER_AUTH_ERROR;
    if (/\b(?:econnrefused|enotfound|ehostunreach|service unavailable|503|502)\b/.test(raw))
      return ErrorCategory.PROVIDER_UNAVAILABLE;
  }
  if (/\b(?:401|unauthorized|invalid_api_key)\b/.test(raw)) return ErrorCategory.AUTHENTICATION;
  if (/\b(?:econnrefused|enotfound|ehostunreach)\b/.test(raw) || signal.isTransientConnectionError)
    return ErrorCategory.CONNECTION;
  if (
    signal.isRateLimit ||
    /\b(?:429|rate limit|402|no quota|quota exceeded|insufficient_quota)\b/.test(raw)
  )
    return ErrorCategory.RATE_LIMIT;
  if (signal.isStartupTimeout || /\btimeout\b/.test(raw)) return ErrorCategory.TIMEOUT;
  if (/\bmodel_not_found\b/.test(raw) || isProviderNotRegisteredMessage(raw))
    return ErrorCategory.MODEL;
  if (
    raw.includes('cannot be run as root') ||
    raw.includes('dangerously-skip-permissions') ||
    raw.includes('permission') ||
    raw.includes('exit code: 1')
  )
    return ErrorCategory.PERMISSION;
  return ErrorCategory.SYSTEM;
}

export function isClaudeAuthenticationError(rawText: string): boolean {
  return /\b401\b|authentication_failed|authentication_error|OAuth token.*(?:revoked|expired)/i.test(
    rawText
  );
}

export function resolveTerminalMessageHint(
  signal: QueryRetryErrorSignal,
  env: QueryRetryEnvironment
): string | undefined {
  if (env.providerFamily === 'anthropic' && isClaudeAuthenticationError(signal.rawText))
    return 'claude_login_failed';
  if (signal.isStartupTimeout) return 'startup_timeout';
  if (signal.isStreamStall) return 'stream_stall';
  if (signal.isConversationNotFound) return 'conversation_not_found';
  if (signal.isMessageNotFound) return 'message_not_found';
  if (env.attempt >= env.maxProviderRetries && signal.isRetryableProviderError)
    return 'provider_exhausted';
  if (signal.isTransientConnectionError && env.attempt > 0) return 'transient_exhausted';
  return undefined;
}

export function classifyQueryRetryRoute(input: QueryRetryRouteInput): QueryRetryRoute {
  const { errorSignal, env } = input;
  if (env.isSuperseded) return { action: 'superseded_noop' };
  if (env.isCleaningUp) return { action: 'cleanup_noop' };
  if (
    errorSignal.isStartupTimeout &&
    env.attempt === 0 &&
    env.lifecycle.processingStatus !== 'interrupted'
  ) {
    if (env.hasConsumedPrompt) return { action: 'startup_timeout_retry', redeliver: 'consumed' };
    if (env.hasQueuedPrompt) return { action: 'startup_timeout_retry', redeliver: 'queue' };
  }
  if (
    env.providerFamily === 'anthropic' &&
    isClaudeAuthenticationError(errorSignal.rawText) &&
    !isQueryInterrupted(errorSignal, env.lifecycle)
  )
    return env.attempt === 0
      ? { action: 'claude_auth_retry' }
      : {
          action: 'terminal',
          category: ErrorCategory.AUTHENTICATION,
          messageHint: 'claude_login_failed',
        };
  if (errorSignal.isMessageNotFound && env.attempt === 0)
    return { action: 'message_not_found_retry' };
  if (
    errorSignal.isNetworkUnreachable &&
    !isQueryInterrupted(errorSignal, env.lifecycle) &&
    !limitRecoveryInFlight(env)
  )
    return { action: 'network_pause' };
  if (
    errorSignal.isStreamStall &&
    !isQueryInterrupted(errorSignal, env.lifecycle) &&
    env.attempt === 0
  )
    return { action: 'stream_stall_retry' };
  if (
    errorSignal.isTransientConnectionError &&
    !isQueryInterrupted(errorSignal, env.lifecycle) &&
    env.attempt === 0
  )
    return { action: 'transient_retry' };
  if (
    errorSignal.isRetryableProviderError &&
    env.useProviderFallback &&
    env.hasRateLimitHandoff &&
    !isQueryInterrupted(errorSignal, env.lifecycle)
  )
    return { action: 'rate_limit_handoff', hint: { kind: 'rate_limit' } };
  if (
    !isQueryInterrupted(errorSignal, env.lifecycle) &&
    env.attempt < env.maxProviderRetries &&
    errorSignal.isRetryableProviderError
  )
    return { action: 'provider_backoff', nextAttempt: env.attempt + 1 };
  if (errorSignal.errorName === 'AbortError') return { action: 'aborted_noop' };
  if (errorSignal.apiValidationText !== null)
    return { action: 'api_validation', text: errorSignal.apiValidationText };
  if (isSdkProcessExitError(errorSignal.rawText) && limitRecoveryInFlight(env)) {
    return { action: 'expected_recovery_noop' };
  }
  if (env.turnEnded && isSdkProcessExitError(errorSignal.rawText))
    return env.hasFedPrompt && env.lifecycle.processingStatus !== 'interrupted'
      ? { action: 'turn_ended_redeliver' }
      : { action: 'turn_ended_noop' };
  if (errorSignal.isRateLimit && env.hasRateLimitHandoff && errorSignal.rateLimitHint !== null)
    return { action: 'rate_limit_handoff', hint: errorSignal.rateLimitHint };
  return {
    action: 'terminal',
    category: decideProviderTerminalCategory(errorSignal, env),
    messageHint: resolveTerminalMessageHint(errorSignal, env),
  };
}

function makeFinalizer(overrides: Partial<QueryRetryFinalizer>): QueryRetryFinalizer {
  return {
    skipQueueClear: false,
    skipStop: false,
    skipCatchIdle: false,
    skipFinalizerIdle: () => false,
    skipBeginTerminalIdle: false,
    skipErrorManager: false,
    ...overrides,
  };
}

function limitRecoveryInFlight(env: QueryRetryEnvironment): boolean {
  return (
    env.recoveryState.rateLimitCooldownScheduled ||
    env.lifecycle.isLimitRecoveryPending ||
    env.lifecycle.processingStatus === 'rate_limit_cooldown'
  );
}

function skipIdleDueToRecovery(env: QueryRetryEnvironment): boolean {
  return limitRecoveryInFlight(env);
}

function skipFinalizerIdleDueToLifecycle(env: QueryRetryEnvironment): boolean {
  return (
    env.lifecycle.isLimitRecoveryPending || env.lifecycle.processingStatus === 'rate_limit_cooldown'
  );
}

const skipFinalizerIdleAlways = () => true;

function resolveDecision(
  route: QueryRetryRoute,
  env: QueryRetryEnvironment,
  errorSignal?: QueryRetryErrorSignal
): QueryRetryDecision {
  const handoff = env.rateLimitHandoffResult ?? null;
  if (route.action === 'rate_limit_handoff') {
    if (handoff === 'accepted') {
      return {
        route,
        finalizer: makeFinalizer({
          skipCatchIdle: true,
          skipFinalizerIdle: skipFinalizerIdleAlways,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    }
    if (handoff === 'thrown') {
      return {
        route,
        finalizer: makeFinalizer({
          skipCatchIdle: true,
          skipFinalizerIdle: skipIdleDueToRecovery,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    }
    if (handoff === 'declined') {
      if (errorSignal && isQueryInterrupted(errorSignal, env.lifecycle)) {
        return {
          route: { action: 'aborted_noop' },
          finalizer: makeFinalizer({
            skipCatchIdle: true,
            skipFinalizerIdle: skipIdleDueToRecovery,
            skipBeginTerminalIdle: true,
            skipErrorManager: true,
          }),
        };
      }
      const nonHandoffEnv: QueryRetryEnvironment = { ...env, hasRateLimitHandoff: false };
      const recomputedRoute = errorSignal
        ? classifyQueryRetryRoute({ errorSignal, env: nonHandoffEnv })
        : ({
            action: 'terminal',
            category: ErrorCategory.RATE_LIMIT,
            messageHint: undefined,
          } as QueryRetryRoute);
      return resolveDecision(recomputedRoute, nonHandoffEnv, errorSignal);
    }
    return {
      route,
      finalizer: makeFinalizer({
        skipCatchIdle: true,
        skipFinalizerIdle: skipFinalizerIdleAlways,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    };
  }

  switch (route.action) {
    case 'superseded_noop':
      return {
        route,
        finalizer: makeFinalizer({
          skipQueueClear: true,
          skipStop: true,
          skipCatchIdle: true,
          skipFinalizerIdle: skipFinalizerIdleAlways,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    case 'cleanup_noop':
      if (env.isSuperseded) {
        return {
          route: { action: 'superseded_noop' },
          finalizer: makeFinalizer({
            skipQueueClear: true,
            skipStop: true,
            skipCatchIdle: true,
            skipFinalizerIdle: skipFinalizerIdleAlways,
            skipBeginTerminalIdle: true,
            skipErrorManager: true,
          }),
        };
      }
      return {
        route,
        finalizer: makeFinalizer({
          skipQueueClear: true,
          skipCatchIdle: true,
          skipFinalizerIdle: skipFinalizerIdleAlways,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    case 'aborted_noop':
      return {
        route,
        finalizer: makeFinalizer({
          skipCatchIdle: true,
          skipFinalizerIdle: skipIdleDueToRecovery,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    case 'network_pause':
      return {
        route,
        finalizer: makeFinalizer({
          skipQueueClear: true,
          skipCatchIdle: true,
          skipFinalizerIdle: skipFinalizerIdleAlways,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    case 'turn_ended_noop':
      return {
        route,
        finalizer: makeFinalizer({ skipBeginTerminalIdle: true, skipErrorManager: true }),
      };
    case 'expected_recovery_noop':
      return {
        route,
        finalizer: makeFinalizer({
          skipQueueClear: true,
          skipCatchIdle: true,
          skipFinalizerIdle: skipIdleDueToRecovery,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    case 'api_validation':
      return {
        route,
        finalizer: makeFinalizer({
          skipCatchIdle: env.recoveryState.rateLimitCooldownScheduled,
          skipFinalizerIdle: skipIdleDueToRecovery,
          skipErrorManager: true,
        }),
      };
    case 'terminal':
      return {
        route,
        finalizer: makeFinalizer({
          skipFinalizerIdle: skipFinalizerIdleDueToLifecycle,
        }),
      };
    case 'startup_timeout_retry':
    case 'turn_ended_redeliver':
    case 'message_not_found_retry':
    case 'transient_retry':
    case 'claude_auth_retry':
    case 'stream_stall_retry':
    case 'provider_backoff':
      return {
        route,
        finalizer: makeFinalizer({
          skipQueueClear: true,
          skipCatchIdle: true,
          skipBeginTerminalIdle: true,
          skipErrorManager: true,
        }),
      };
    default:
      return { route, finalizer: makeFinalizer({}) };
  }
}

export function classifyQueryRetryArm(input: QueryRetryRouteInput): QueryRetryRoute {
  return classifyQueryRetryRoute({ errorSignal: input.errorSignal, env: input.env });
}

export function mapQueryRetryArm(
  input: QueryRetryRouteInput,
  route: QueryRetryRoute
): QueryRetryDecision {
  return resolveDecision(route, input.env, input.errorSignal);
}

export const decideQueryRetry = (superpipe({})('query-retry-arm') as PipelineAPI)
  .input(['input'])
  .pipe(classifyQueryRetryArm, 'input', 'route')
  .pipe(mapQueryRetryArm, ['input', 'route'], 'decision')
  .end('decision') as (input: QueryRetryRouteInput) => QueryRetryDecision;
