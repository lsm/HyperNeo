import { describe, expect, it } from 'bun:test';
import { ErrorCategory } from '../../../../src/lib/error-manager';
import {
  classifyQueryRetryRoute,
  decideQueryRetry,
  planTurnEndedGeneration,
  type QueryRetryEnvironment,
  type QueryRetryErrorSignal,
  type QueryRetryFinalizer,
  type QueryRetryRoute,
} from '../../../../src/lib/agent/query-retry-routing';

function env(overrides: Partial<QueryRetryEnvironment> = {}): QueryRetryEnvironment {
  return {
    attempt: 0,
    maxProviderRetries: 3,
    providerFamily: 'anthropic',
    hasConsumedPrompt: false,
    hasQueuedPrompt: false,
    turnEnded: false,
    lifecycle: {
      processingStatus: 'processing',
      abortSignalAborted: false,
      isLimitRecoveryPending: false,
    },
    isCleaningUp: false,
    isSuperseded: false,
    hasRateLimitHandoff: false,
    recoveryState: { rateLimitCooldownScheduled: false },
    ...overrides,
  };
}

function signal(overrides: Partial<QueryRetryErrorSignal> = {}): QueryRetryErrorSignal {
  return {
    rawText: 'unknown error',
    errorName: undefined,
    isStartupTimeout: false,
    isConversationNotFound: false,
    isMessageNotFound: false,
    isTransientConnectionError: false,
    isRetryableProviderError: false,
    isRateLimit: false,
    rateLimitHint: null,
    apiValidationText: null,
    ...overrides,
  };
}

function finalizer(
  overrides: Partial<Omit<QueryRetryFinalizer, 'skipFinalizerIdle'>> & {
    skipFinalizerIdle?: boolean | ((env: QueryRetryEnvironment) => boolean);
  } = {}
): QueryRetryFinalizer {
  const { skipFinalizerIdle: skipIdle, ...rest } = overrides;
  const skipFn = typeof skipIdle === 'boolean' ? () => skipIdle : (skipIdle ?? (() => false));
  const base = {
    skipQueueClear: false,
    skipStop: false,
    skipCatchIdle: false,
    skipFinalizerIdle: skipFn,
    skipBeginTerminalIdle: false,
    skipErrorManager: false,
  };
  return { ...base, ...rest, skipFinalizerIdle: skipFn };
}

function assertFinalizer(
  actual: QueryRetryFinalizer,
  expected: QueryRetryFinalizer,
  testEnv: QueryRetryEnvironment
): void {
  expect(actual.skipQueueClear).toBe(expected.skipQueueClear);
  expect(actual.skipStop).toBe(expected.skipStop);
  expect(actual.skipCatchIdle).toBe(expected.skipCatchIdle);
  expect(actual.skipBeginTerminalIdle).toBe(expected.skipBeginTerminalIdle);
  expect(actual.skipErrorManager).toBe(expected.skipErrorManager);
  expect(actual.skipFinalizerIdle(testEnv)).toBe(expected.skipFinalizerIdle(testEnv));
}

describe('query-retry-routing', () => {
  it('hands retryable provider errors to configured Neo fallbacks while preserving ordinary retry policy', () => {
    const errorSignal = signal({ rawText: '503 overloaded', isRetryableProviderError: true });
    expect(
      classifyQueryRetryRoute({
        errorSignal,
        env: env({ hasRateLimitHandoff: true, useProviderFallback: true }),
      })
    ).toEqual({ action: 'rate_limit_handoff', hint: { kind: 'rate_limit' } });
    expect(
      classifyQueryRetryRoute({ errorSignal, env: env({ hasRateLimitHandoff: true }) })
    ).toEqual({ action: 'provider_backoff', nextAttempt: 1 });
    expect(
      classifyQueryRetryRoute({
        errorSignal,
        env: env({ hasRateLimitHandoff: true, useProviderFallback: true, isSuperseded: true }),
      })
    ).toEqual({ action: 'superseded_noop' });
  });
  const cases: Array<{
    name: string;
    signal?: Partial<QueryRetryErrorSignal>;
    env?: Partial<QueryRetryEnvironment>;
    expected: Partial<QueryRetryRoute>;
  }> = [
    {
      name: 'startup timeout with consumed prompt retries',
      signal: { isStartupTimeout: true },
      env: { hasConsumedPrompt: true },
      expected: { action: 'startup_timeout_retry', redeliver: 'consumed' },
    },
    {
      name: 'startup timeout blocked when interrupted',
      signal: { isStartupTimeout: true },
      env: {
        hasConsumedPrompt: true,
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expected: {
        action: 'terminal',
        category: ErrorCategory.TIMEOUT,
        messageHint: 'startup_timeout',
      },
    },
    {
      name: 'message not found retries on attempt zero',
      signal: { isMessageNotFound: true },
      expected: { action: 'message_not_found_retry' },
    },
    {
      name: 'transient connection retries when not interrupted',
      signal: { isTransientConnectionError: true },
      env: { hasConsumedPrompt: true },
      expected: { action: 'transient_retry' },
    },
    {
      name: 'transient connection blocked when aborted',
      signal: { isTransientConnectionError: true },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: true,
          isLimitRecoveryPending: false,
        },
      },
      expected: { action: 'terminal', category: ErrorCategory.CONNECTION },
    },
    {
      name: 'retryable 5xx backs off before the cap',
      signal: { rawText: '500 Internal Server Error', isRetryableProviderError: true },
      env: { hasConsumedPrompt: true },
      expected: { action: 'provider_backoff', nextAttempt: 1 },
    },
    {
      name: 'provider 503 exhausted as PROVIDER_UNAVAILABLE',
      signal: { rawText: '503 Service Unavailable', isRetryableProviderError: true },
      env: { attempt: 3, providerFamily: 'provider' },
      expected: {
        action: 'terminal',
        category: ErrorCategory.PROVIDER_UNAVAILABLE,
        messageHint: 'provider_exhausted',
      },
    },
    {
      name: 'Anthropic 503 exhausted as SYSTEM',
      signal: { rawText: '503 Service Unavailable', isRetryableProviderError: true },
      env: { attempt: 3 },
      expected: {
        action: 'terminal',
        category: ErrorCategory.SYSTEM,
        messageHint: 'provider_exhausted',
      },
    },
    {
      name: 'rate limit hands off when callback is wired',
      signal: {
        rawText: '429 Too Many Requests',
        isRateLimit: true,
        rateLimitHint: { kind: 'rate_limit', billingTerminal: false },
      },
      env: { hasRateLimitHandoff: true },
      expected: {
        action: 'rate_limit_handoff',
        hint: { kind: 'rate_limit', billingTerminal: false },
      },
    },
    {
      name: 'mixed 429 service-unavailable is RATE_LIMIT for Anthropic',
      signal: { rawText: '429 service unavailable', isRateLimit: true },
      expected: { action: 'terminal', category: ErrorCategory.RATE_LIMIT },
    },
    {
      name: 'mixed 429 service-unavailable is PROVIDER_UNAVAILABLE for provider',
      signal: { rawText: '429 service unavailable', isRateLimit: true },
      env: { providerFamily: 'provider' },
      expected: { action: 'terminal', category: ErrorCategory.PROVIDER_UNAVAILABLE },
    },
    {
      name: 'AbortError routes to aborted_noop',
      signal: { errorName: 'AbortError' },
      expected: { action: 'aborted_noop' },
    },
    {
      name: 'cleanup supersedes arms',
      signal: { isStartupTimeout: true },
      env: { isCleaningUp: true },
      expected: { action: 'cleanup_noop' },
    },
    {
      name: 'superseded supersedes arms',
      signal: { isRetryableProviderError: true },
      env: { isSuperseded: true },
      expected: { action: 'superseded_noop' },
    },
    {
      name: 'superseded takes precedence over cleanup',
      signal: { isStartupTimeout: true },
      env: { isSuperseded: true, isCleaningUp: true },
      expected: { action: 'superseded_noop' },
    },
    {
      name: 'parseable 4xx routes to api_validation',
      signal: {
        rawText: '400 prompt is too long',
        apiValidationText: '**API Error (400)**: prompt is too long',
      },
      expected: { action: 'api_validation', text: '**API Error (400)**: prompt is too long' },
    },
    {
      name: 'parseable 401 routes to api_validation before auth category',
      signal: {
        rawText: '401 Unauthorized',
        apiValidationText: '**API Error (401)**: Unauthorized',
      },
      expected: { action: 'api_validation', text: '**API Error (401)**: Unauthorized' },
    },
    {
      name: 'structured rate-limit signal drives terminal category',
      signal: { rawText: 'usage limit reached', isRateLimit: true },
      expected: { action: 'terminal', category: ErrorCategory.RATE_LIMIT },
    },
    {
      name: 'permission stem matches underscore-delimited tags',
      signal: { rawText: 'permission_error' },
      expected: { action: 'terminal', category: ErrorCategory.PERMISSION },
    },
    {
      name: 'permission stem matches plural phrase',
      signal: { rawText: 'insufficient permissions' },
      expected: { action: 'terminal', category: ErrorCategory.PERMISSION },
    },
    {
      name: 'SDK process exit with pending limit recovery is expected',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expected: { action: 'expected_recovery_noop' },
    },
    {
      name: 'SDK process exit during rate_limit_cooldown is expected',
      signal: { rawText: 'Error: Claude Code process exited with code 1' },
      env: {
        lifecycle: {
          processingStatus: 'rate_limit_cooldown',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expected: { action: 'expected_recovery_noop' },
    },
    {
      name: 'SDK process exit with scheduled cooldown is expected',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: { recoveryState: { rateLimitCooldownScheduled: true } },
      expected: { action: 'expected_recovery_noop' },
    },
    {
      name: 'SDK signal exit with pending limit recovery is expected',
      signal: { rawText: 'Claude Code process terminated by signal SIGTERM' },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expected: { action: 'expected_recovery_noop' },
    },
    {
      name: 'SDK process exit with stderr tail and pending recovery is expected',
      signal: { rawText: 'Claude Code process exited with code 1. stderr: rate limit hit' },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expected: { action: 'expected_recovery_noop' },
    },
    {
      name: 'an unreachable provider pauses the turn instead of failing it',
      signal: { rawText: 'getaddrinfo ENOTFOUND chatgpt.com', isNetworkUnreachable: true },
      expected: { action: 'network_pause' },
    },
    {
      name: 'an unreachable provider after the user interrupted is not paused',
      signal: { rawText: 'getaddrinfo ENOTFOUND chatgpt.com', isNetworkUnreachable: true },
      env: {
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expected: { action: 'terminal', category: ErrorCategory.CONNECTION },
    },
    {
      name: 'SDK process exit after the turn ended with a result is not a crash',
      signal: { rawText: 'Error: Claude Code process exited with code 1' },
      env: { turnEnded: true },
      expected: { action: 'turn_ended_noop' },
    },
    {
      name: 'SDK process exit after a result during an armed cooldown stays expected recovery',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: {
        turnEnded: true,
        lifecycle: {
          processingStatus: 'rate_limit_cooldown',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expected: { action: 'expected_recovery_noop' },
    },
    {
      name: 'SDK process exit after a result ends the turn even with a prompt queued',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: { turnEnded: true, hasQueuedPrompt: true },
      expected: { action: 'turn_ended_noop' },
    },
    {
      name: 'SDK process exit after a prompt was fed past the result redelivers it',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: { turnEnded: true, hasFedPrompt: true },
      expected: { action: 'turn_ended_redeliver' },
    },
    {
      name: 'an interrupt after a prompt was fed past the result ends the turn without redelivery',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: {
        turnEnded: true,
        hasFedPrompt: true,
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expected: { action: 'turn_ended_noop' },
    },
    {
      name: 'a non-exit error after the turn ended stays terminal',
      signal: { rawText: 'invalid_api_key' },
      env: { turnEnded: true },
      expected: { action: 'terminal', category: ErrorCategory.AUTHENTICATION },
    },
    {
      name: 'SDK process exit outside recovery windows stays terminal',
      signal: { rawText: 'Claude Code process exited with code 1' },
      expected: { action: 'terminal', category: ErrorCategory.SYSTEM },
    },
    {
      name: 'genuine terminal error during pending recovery stays terminal',
      signal: { rawText: 'invalid_api_key' },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expected: { action: 'terminal', category: ErrorCategory.AUTHENTICATION },
    },
    {
      name: 'SDK process exit during recovery yields to superseded',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: {
        isSuperseded: true,
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expected: { action: 'superseded_noop' },
    },
    {
      name: 'SDK process exit during recovery yields to cleanup',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: {
        isCleaningUp: true,
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expected: { action: 'cleanup_noop' },
    },
  ];

  for (const { name, signal: sig, env: e, expected } of cases) {
    it(name, () => {
      const route = classifyQueryRetryRoute({ errorSignal: signal(sig ?? {}), env: env(e ?? {}) });
      expect(route).toMatchObject(expected);
    });
  }
});

describe('decideQueryRetry', () => {
  const cases: Array<{
    name: string;
    signal?: Partial<QueryRetryErrorSignal>;
    env?: Partial<QueryRetryEnvironment>;
    expectedRoute: QueryRetryRoute;
    expectedFinalizer: QueryRetryFinalizer;
  }> = [
    {
      name: 'startup timeout with consumed prompt retries and finalizes as a retry arm',
      signal: { isStartupTimeout: true },
      env: { hasConsumedPrompt: true },
      expectedRoute: { action: 'startup_timeout_retry', redeliver: 'consumed' },
      expectedFinalizer: finalizer({
        skipQueueClear: true,
        skipCatchIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'startup timeout interrupted routes terminal with default finalizer',
      signal: { isStartupTimeout: true },
      env: {
        hasConsumedPrompt: true,
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.TIMEOUT,
        messageHint: 'startup_timeout',
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'message not found retry arm skips queue clear and terminal handling',
      signal: { isMessageNotFound: true },
      expectedRoute: { action: 'message_not_found_retry' },
      expectedFinalizer: finalizer({
        skipQueueClear: true,
        skipCatchIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'transient retry arm skips queue clear and terminal handling',
      signal: { isTransientConnectionError: true },
      env: { hasConsumedPrompt: true },
      expectedRoute: { action: 'transient_retry' },
      expectedFinalizer: finalizer({
        skipQueueClear: true,
        skipCatchIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'transient interrupted routes terminal CONNECTION',
      signal: { isTransientConnectionError: true },
      env: {
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.CONNECTION,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'transient aborted controller routes terminal CONNECTION',
      signal: { isTransientConnectionError: true },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: true,
          isLimitRecoveryPending: false,
        },
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.CONNECTION,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'provider 5xx backoff arm skips queue clear and terminal handling',
      signal: { rawText: '503 Service Unavailable', isRetryableProviderError: true },
      env: { hasConsumedPrompt: true },
      expectedRoute: { action: 'provider_backoff', nextAttempt: 1 },
      expectedFinalizer: finalizer({
        skipQueueClear: true,
        skipCatchIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'provider 5xx interrupted routes terminal SYSTEM',
      signal: { rawText: '503 Service Unavailable', isRetryableProviderError: true },
      env: {
        hasConsumedPrompt: true,
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.SYSTEM,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'provider 5xx exhausted routes terminal SYSTEM',
      signal: { rawText: '503 Service Unavailable', isRetryableProviderError: true },
      env: { attempt: 3, hasConsumedPrompt: true },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.SYSTEM,
        messageHint: 'provider_exhausted',
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'provider 5xx exhausted on provider family routes PROVIDER_UNAVAILABLE',
      signal: { rawText: '503 Service Unavailable', isRetryableProviderError: true },
      env: { attempt: 3, providerFamily: 'provider', hasConsumedPrompt: true },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.PROVIDER_UNAVAILABLE,
        messageHint: 'provider_exhausted',
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'aborted_noop clears the queue and skips terminal handling',
      signal: { errorName: 'AbortError' },
      expectedRoute: { action: 'aborted_noop' },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'aborted_noop with cooldown scheduled suppresses finalizer idle',
      signal: { errorName: 'AbortError' },
      env: {
        recoveryState: { rateLimitCooldownScheduled: true },
      },
      expectedRoute: { action: 'aborted_noop' },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'expected_recovery_noop preserves the queue and skips terminal handling',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expectedRoute: { action: 'expected_recovery_noop' },
      expectedFinalizer: finalizer({
        skipQueueClear: true,
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'turn_ended_noop goes idle without a terminal error report',
      signal: { rawText: 'Claude Code process exited with code 1' },
      env: { turnEnded: true },
      expectedRoute: { action: 'turn_ended_noop' },
      expectedFinalizer: finalizer({ skipBeginTerminalIdle: true, skipErrorManager: true }),
    },
    {
      name: 'aborted_noop with limit recovery pending suppresses finalizer idle',
      signal: { errorName: 'AbortError' },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expectedRoute: { action: 'aborted_noop' },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'aborted_noop with rate_limit_cooldown status suppresses finalizer idle',
      signal: { errorName: 'AbortError' },
      env: {
        lifecycle: {
          processingStatus: 'rate_limit_cooldown',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expectedRoute: { action: 'aborted_noop' },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'cleanup_noop skips queue clear and all terminal effects',
      signal: { isStartupTimeout: true },
      env: { isCleaningUp: true, hasConsumedPrompt: true },
      expectedRoute: { action: 'cleanup_noop' },
      expectedFinalizer: finalizer({
        skipQueueClear: true,
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'superseded_noop skips all teardown',
      signal: { isRetryableProviderError: true },
      env: { isSuperseded: true, hasConsumedPrompt: true },
      expectedRoute: { action: 'superseded_noop' },
      expectedFinalizer: finalizer({
        skipQueueClear: true,
        skipStop: true,
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'api_validation skips error manager',
      signal: {
        rawText: '400 prompt is too long',
        apiValidationText: '**API Error (400)**: prompt is too long',
      },
      expectedRoute: {
        action: 'api_validation',
        text: '**API Error (400)**: prompt is too long',
      },
      expectedFinalizer: finalizer({
        skipErrorManager: true,
      }),
    },
    {
      name: 'api_validation with cooldown scheduled suppresses idle',
      signal: {
        rawText: '400 prompt is too long',
        apiValidationText: '**API Error (400)**: prompt is too long',
      },
      env: {
        recoveryState: { rateLimitCooldownScheduled: true },
      },
      expectedRoute: {
        action: 'api_validation',
        text: '**API Error (400)**: prompt is too long',
      },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'terminal auth runs full terminal finalizer',
      signal: { rawText: 'invalid_api_key' },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.AUTHENTICATION,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'terminal with limit recovery pending skips finalizer idle',
      signal: { rawText: 'invalid_api_key' },
      env: {
        lifecycle: {
          processingStatus: 'processing',
          abortSignalAborted: false,
          isLimitRecoveryPending: true,
        },
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.AUTHENTICATION,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer({
        skipFinalizerIdle: true,
      }),
    },
    {
      name: 'terminal with rate_limit_cooldown status skips finalizer idle',
      signal: { rawText: 'invalid_api_key' },
      env: {
        lifecycle: {
          processingStatus: 'rate_limit_cooldown',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.AUTHENTICATION,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer({
        skipFinalizerIdle: true,
      }),
    },
    {
      name: 'terminal with incoming cooldown flag recomputes and does not skip',
      signal: { rawText: 'invalid_api_key' },
      env: {
        attempt: 0,
        recoveryState: { rateLimitCooldownScheduled: true },
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.AUTHENTICATION,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'rate limit handoff accepted suppresses terminal and idle',
      signal: {
        rawText: '429 please upgrade your plan',
        isRateLimit: true,
        rateLimitHint: { kind: 'usage_limit', billingTerminal: true },
      },
      env: {
        hasRateLimitHandoff: true,
        rateLimitHandoffResult: 'accepted',
      },
      expectedRoute: {
        action: 'rate_limit_handoff',
        hint: { kind: 'usage_limit', billingTerminal: true },
      },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'rate limit handoff declined falls back to terminal RATE_LIMIT',
      signal: {
        rawText: '429 please upgrade your plan',
        isRateLimit: true,
        rateLimitHint: { kind: 'usage_limit', billingTerminal: true },
      },
      env: {
        hasRateLimitHandoff: true,
        rateLimitHandoffResult: 'declined',
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.RATE_LIMIT,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'rate limit handoff declined preserves provider availability category',
      signal: {
        rawText: '429 service unavailable',
        isRateLimit: true,
        rateLimitHint: { kind: 'rate_limit', billingTerminal: false },
      },
      env: {
        providerFamily: 'provider',
        hasRateLimitHandoff: true,
        rateLimitHandoffResult: 'declined',
      },
      expectedRoute: {
        action: 'terminal',
        category: ErrorCategory.PROVIDER_UNAVAILABLE,
        messageHint: undefined,
      },
      expectedFinalizer: finalizer(),
    },
    {
      name: 'rate limit handoff declined with interrupted session routes aborted_noop',
      signal: {
        rawText: '429 please upgrade your plan',
        isRateLimit: true,
        rateLimitHint: { kind: 'usage_limit', billingTerminal: true },
      },
      env: {
        hasRateLimitHandoff: true,
        rateLimitHandoffResult: 'declined',
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: false,
          isLimitRecoveryPending: false,
        },
      },
      expectedRoute: { action: 'aborted_noop' },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'rate limit handoff thrown skips terminal but keeps finalizer idle',
      signal: {
        rawText: '429 please upgrade your plan',
        isRateLimit: true,
        rateLimitHint: { kind: 'usage_limit', billingTerminal: true },
      },
      env: {
        hasRateLimitHandoff: true,
        rateLimitHandoffResult: 'thrown',
      },
      expectedRoute: {
        action: 'rate_limit_handoff',
        hint: { kind: 'usage_limit', billingTerminal: true },
      },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
    {
      name: 'rate limit handoff without result defers terminal and idle',
      signal: {
        rawText: '429 please upgrade your plan',
        isRateLimit: true,
        rateLimitHint: { kind: 'usage_limit', billingTerminal: true },
      },
      env: {
        hasRateLimitHandoff: true,
      },
      expectedRoute: {
        action: 'rate_limit_handoff',
        hint: { kind: 'usage_limit', billingTerminal: true },
      },
      expectedFinalizer: finalizer({
        skipCatchIdle: true,
        skipFinalizerIdle: true,
        skipBeginTerminalIdle: true,
        skipErrorManager: true,
      }),
    },
  ];

  for (const { name, signal: sig, env: e, expectedRoute, expectedFinalizer } of cases) {
    it(name, () => {
      const testEnv = env(e ?? {});
      const decision = decideQueryRetry({
        errorSignal: signal(sig ?? {}),
        env: testEnv,
      });
      expect(decision.route).toEqual(expectedRoute);
      assertFinalizer(decision.finalizer, expectedFinalizer, testEnv);
    });
  }

  it('terminal finalizer recomputes on resnapshotted recovery state', () => {
    const initialEnv = env({
      lifecycle: {
        processingStatus: 'processing',
        abortSignalAborted: false,
        isLimitRecoveryPending: false,
      },
    });
    const resnappedEnv = env({
      lifecycle: {
        processingStatus: 'rate_limit_cooldown',
        abortSignalAborted: false,
        isLimitRecoveryPending: false,
      },
    });
    const decision = decideQueryRetry({
      errorSignal: signal({ rawText: 'invalid_api_key' }),
      env: initialEnv,
    });
    expect(decision.finalizer.skipFinalizerIdle(initialEnv)).toBe(false);
    expect(decision.finalizer.skipFinalizerIdle(resnappedEnv)).toBe(true);
  });

  describe('lifecycle status × abort signal × cleanup matrix', () => {
    const PROVIDER_5XX_MSG = '503 Service Unavailable';
    const ABORT_MSG = 'the query was aborted';

    const matrix: Array<{
      name: string;
      signal: Partial<QueryRetryErrorSignal>;
      env: Partial<QueryRetryEnvironment>;
      expectedAction: QueryRetryRoute['action'];
    }> = [
      {
        name: 'startup with abort signal still retries',
        signal: { isStartupTimeout: true },
        env: {
          hasConsumedPrompt: true,
          lifecycle: {
            processingStatus: 'processing',
            abortSignalAborted: true,
            isLimitRecoveryPending: false,
          },
        },
        expectedAction: 'startup_timeout_retry',
      },
      {
        name: 'transient with abort signal routes terminal',
        signal: { isTransientConnectionError: true },
        env: {
          hasConsumedPrompt: true,
          lifecycle: {
            processingStatus: 'processing',
            abortSignalAborted: true,
            isLimitRecoveryPending: false,
          },
        },
        expectedAction: 'terminal',
      },
      {
        name: 'provider with abort signal routes terminal',
        signal: { rawText: PROVIDER_5XX_MSG, isRetryableProviderError: true },
        env: {
          hasConsumedPrompt: true,
          lifecycle: {
            processingStatus: 'processing',
            abortSignalAborted: true,
            isLimitRecoveryPending: false,
          },
        },
        expectedAction: 'terminal',
      },
      {
        name: 'message not found with abort signal still retries',
        signal: { isMessageNotFound: true },
        env: {
          lifecycle: {
            processingStatus: 'processing',
            abortSignalAborted: true,
            isLimitRecoveryPending: false,
          },
        },
        expectedAction: 'message_not_found_retry',
      },
      {
        name: 'aborted_noop with cleanup suppresses queue clear',
        signal: { errorName: 'AbortError', rawText: ABORT_MSG },
        env: { isCleaningUp: true },
        expectedAction: 'cleanup_noop',
      },
      {
        name: 'terminal with supersede suppresses all teardown',
        signal: { rawText: 'invalid_api_key' },
        env: { isSuperseded: true },
        expectedAction: 'superseded_noop',
      },
      {
        name: 'provider with cleanup routes cleanup_noop',
        signal: { rawText: PROVIDER_5XX_MSG, isRetryableProviderError: true },
        env: { isCleaningUp: true, hasConsumedPrompt: true },
        expectedAction: 'cleanup_noop',
      },
      {
        name: 'cleanup with superseded routes superseded_noop',
        signal: { rawText: PROVIDER_5XX_MSG, isRetryableProviderError: true },
        env: { isCleaningUp: true, isSuperseded: true, hasConsumedPrompt: true },
        expectedAction: 'superseded_noop',
      },
      {
        name: 'transient with cleanup routes cleanup_noop',
        signal: { isTransientConnectionError: true },
        env: { isCleaningUp: true, hasConsumedPrompt: true },
        expectedAction: 'cleanup_noop',
      },
    ];

    for (const { name, signal: sig, env: e, expectedAction } of matrix) {
      it(name, () => {
        const decision = decideQueryRetry({
          errorSignal: signal(sig),
          env: env(e),
        });
        expect(decision.route.action).toBe(expectedAction);
      });
    }
  });
});

describe('planTurnEndedGeneration', () => {
  it.each([
    ['a top-level result ends the turn', 3, { type: 'result' }, 7, 7],
    ['a subagent result does not', null, { type: 'result', parent_tool_use_id: 't1' }, 7, null],
    [
      'a trailing idle state keeps it ended',
      7,
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      7,
      7,
    ],
    [
      'a running state starts a new turn',
      7,
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      7,
      null,
    ],
    [
      'other system messages keep it ended',
      7,
      { type: 'system', subtype: 'files_persisted' },
      7,
      7,
    ],
    ['an assistant message starts a new turn', 7, { type: 'assistant' }, 7, null],
    ['a user message starts a new turn', 7, { type: 'user' }, 7, null],
    ['a stream event starts a new turn', 7, { type: 'stream_event' }, 7, null],
  ])('%s', (_label, current, message, generation, expected) => {
    expect(planTurnEndedGeneration(current, message, generation)).toBe(expected);
  });
});

describe('classifyQueryRetryRoute for a silent model stream', () => {
  it('retries a stalled stream once, then fails it as a timeout with its own message', () => {
    const stall = signal({ rawText: 'Error: Model stream stalled: no data', isStreamStall: true });
    expect(classifyQueryRetryRoute({ errorSignal: stall, env: env() })).toEqual({
      action: 'stream_stall_retry',
    });
    expect(classifyQueryRetryRoute({ errorSignal: stall, env: env({ attempt: 1 }) })).toEqual({
      action: 'terminal',
      category: ErrorCategory.TIMEOUT,
      messageHint: 'stream_stall',
    });
    expect(decideQueryRetry({ errorSignal: stall, env: env() }).finalizer.skipErrorManager).toBe(
      true
    );
  });
});

describe('Claude login recovery', () => {
  it('restarts a Claude query once after authentication rejection', () => {
    const decision = decideQueryRetry({
      errorSignal: signal({ rawText: '401 OAuth token revoked' }),
      env: env({ hasConsumedPrompt: true }),
    });
    expect(decision.route.action).toBe('claude_auth_retry');
  });
  it('surfaces a persistent login failure after that retry', () => {
    const decision = decideQueryRetry({
      errorSignal: signal({ rawText: '401 OAuth token revoked' }),
      env: env({ attempt: 1, hasConsumedPrompt: true }),
    });
    expect(decision.route).toEqual({
      action: 'terminal',
      category: ErrorCategory.AUTHENTICATION,
      messageHint: 'claude_login_failed',
    });
  });
  it('does not restart an interrupted Claude query or another provider', () => {
    for (const input of [
      env({
        lifecycle: {
          processingStatus: 'interrupted',
          abortSignalAborted: true,
          isLimitRecoveryPending: false,
        },
      }),
      env({ providerFamily: 'provider' }),
    ]) {
      expect(
        decideQueryRetry({ errorSignal: signal({ rawText: '401 unauthorized' }), env: input }).route
          .action
      ).not.toBe('claude_auth_retry');
    }
  });
});
