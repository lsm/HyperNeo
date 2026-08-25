import { describe, expect, it } from 'bun:test';
import { ErrorCategory } from '../../../../src/lib/error-manager';
import {
  classifyQueryRetryRoute,
  type QueryRetryEnvironment,
  type QueryRetryErrorSignal,
  type QueryRetryRoute,
} from '../../../../src/lib/agent/query-retry-routing';

function env(overrides: Partial<QueryRetryEnvironment> = {}): QueryRetryEnvironment {
  return {
    attempt: 0,
    maxProviderRetries: 3,
    providerFamily: 'anthropic',
    hasConsumedPrompt: false,
    hasQueuedPrompt: false,
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

describe('query-retry-routing', () => {
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
      name: 'parseable 4xx routes to api_validation',
      signal: {
        rawText: '400 prompt is too long',
        apiValidationText: '**API Error (400)**: prompt is too long',
      },
      expected: { action: 'api_validation', text: '**API Error (400)**: prompt is too long' },
    },
  ];

  for (const { name, signal: sig, env: e, expected } of cases) {
    it(name, () => {
      const route = classifyQueryRetryRoute({ errorSignal: signal(sig ?? {}), env: env(e ?? {}) });
      expect(route).toMatchObject(expected);
    });
  }
});
