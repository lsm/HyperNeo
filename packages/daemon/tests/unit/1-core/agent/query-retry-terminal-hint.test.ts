import { describe, expect, it } from 'bun:test';
import {
  type QueryRetryEnvironment,
  type QueryRetryErrorSignal,
  resolveTerminalMessageHint,
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

describe('resolveTerminalMessageHint', () => {
  const cases: Array<{
    signal?: Partial<QueryRetryErrorSignal>;
    env?: Partial<QueryRetryEnvironment>;
    expected: string | undefined;
  }> = [
    { signal: { isStartupTimeout: true }, expected: 'startup_timeout' },
    { signal: { isConversationNotFound: true }, expected: 'conversation_not_found' },
    { signal: { isMessageNotFound: true }, expected: 'message_not_found' },
    {
      signal: { isRetryableProviderError: true },
      env: { attempt: 3, maxProviderRetries: 3 },
      expected: 'provider_exhausted',
    },
    {
      signal: { isRetryableProviderError: true },
      env: { attempt: 2, maxProviderRetries: 3 },
      expected: undefined,
    },
    { env: { attempt: 3, maxProviderRetries: 3 }, expected: undefined },
    {
      signal: { isTransientConnectionError: true },
      env: { attempt: 1 },
      expected: 'transient_exhausted',
    },
    { signal: { isTransientConnectionError: true }, env: { attempt: 0 }, expected: undefined },
    {
      signal: { isStartupTimeout: true, isConversationNotFound: true },
      expected: 'startup_timeout',
    },
    {
      signal: { isMessageNotFound: true, isRetryableProviderError: true },
      env: { attempt: 3, maxProviderRetries: 3 },
      expected: 'message_not_found',
    },
    {
      signal: { isRetryableProviderError: true, isTransientConnectionError: true },
      env: { attempt: 3, maxProviderRetries: 3 },
      expected: 'provider_exhausted',
    },
    { expected: undefined },
  ];

  for (const { signal: sig, env: e, expected } of cases) {
    const mergedEnv = env(e ?? {});
    const keys = Object.keys(sig ?? {}).join('+') || 'defaults';
    it(`${keys}@${mergedEnv.attempt}/${mergedEnv.maxProviderRetries} → ${expected ?? 'undefined'}`, () => {
      expect(resolveTerminalMessageHint(signal(sig ?? {}), mergedEnv)).toBe(expected);
    });
  }
});
