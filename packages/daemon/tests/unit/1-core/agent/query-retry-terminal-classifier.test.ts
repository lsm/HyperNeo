import { describe, expect, it } from 'bun:test';
import {
  decideProviderTerminalCategory,
  type QueryRetryEnvironment,
  type QueryRetryErrorSignal,
  type QueryRetryProviderFamily,
} from '../../../../src/lib/agent/query-retry-routing';
import { ErrorCategory } from '../../../../src/lib/error-manager';

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

describe('decideProviderTerminalCategory', () => {
  const stemTables: Array<{
    family: QueryRetryProviderFamily;
    stems: string[];
    expected: ErrorCategory;
  }> = [
    {
      family: 'provider',
      stems: [
        '401',
        '403',
        'unauthorized',
        'token expired',
        'token_expired',
        'not authenticated',
        'invalid_api_key',
      ],
      expected: ErrorCategory.PROVIDER_AUTH_ERROR,
    },
    {
      family: 'provider',
      stems: ['econnrefused', 'enotfound', 'ehostunreach', 'service unavailable', '503', '502'],
      expected: ErrorCategory.PROVIDER_UNAVAILABLE,
    },
    {
      family: 'anthropic',
      stems: ['401', 'unauthorized', 'invalid_api_key'],
      expected: ErrorCategory.AUTHENTICATION,
    },
    {
      family: 'anthropic',
      stems: ['econnrefused', 'enotfound', 'ehostunreach'],
      expected: ErrorCategory.CONNECTION,
    },
    {
      family: 'anthropic',
      stems: ['429', 'rate limit', '402', 'no quota', 'quota exceeded', 'insufficient_quota'],
      expected: ErrorCategory.RATE_LIMIT,
    },
    { family: 'anthropic', stems: ['timeout'], expected: ErrorCategory.TIMEOUT },
    { family: 'anthropic', stems: ['model_not_found'], expected: ErrorCategory.MODEL },
    {
      family: 'anthropic',
      stems: [
        'cannot be run as root',
        'dangerously-skip-permissions',
        'permission',
        'exit code: 1',
      ],
      expected: ErrorCategory.PERMISSION,
    },
  ];

  for (const { family, stems, expected } of stemTables) {
    for (const stem of stems) {
      it(`${family} family "${stem}" classifies ${expected}`, () => {
        const category = decideProviderTerminalCategory(
          signal({ rawText: stem }),
          env({ providerFamily: family })
        );
        expect(category).toBe(expected);
      });
    }
  }

  const cases: Array<{
    raw?: string;
    family?: QueryRetryProviderFamily;
    flags?: Partial<QueryRetryErrorSignal>;
    expected: ErrorCategory;
  }> = [
    { flags: { isTransientConnectionError: true }, expected: ErrorCategory.CONNECTION },
    { flags: { isRateLimit: true }, expected: ErrorCategory.RATE_LIMIT },
    { flags: { isStartupTimeout: true }, expected: ErrorCategory.TIMEOUT },
    { raw: '401 then 503', family: 'provider', expected: ErrorCategory.PROVIDER_AUTH_ERROR },
    {
      raw: '429 service unavailable',
      family: 'provider',
      expected: ErrorCategory.PROVIDER_UNAVAILABLE,
    },
    { raw: 'quota exceeded', family: 'provider', expected: ErrorCategory.RATE_LIMIT },
    {
      raw: 'invalid_api_key',
      flags: { isTransientConnectionError: true },
      expected: ErrorCategory.AUTHENTICATION,
    },
    { raw: 'econnrefused', flags: { isRateLimit: true }, expected: ErrorCategory.CONNECTION },
    { raw: '429', flags: { isStartupTimeout: true }, expected: ErrorCategory.RATE_LIMIT },
    { raw: 'UNAUTHORIZED Request', expected: ErrorCategory.AUTHENTICATION },
  ];

  for (const { raw, family, flags, expected } of cases) {
    const parts = [family ?? 'anthropic', raw ?? Object.keys(flags ?? {}).join(',')];
    it(`${parts.join(' ')} classifies ${expected}`, () => {
      const category = decideProviderTerminalCategory(
        signal({ rawText: raw ?? 'unknown error', ...flags }),
        env(family ? { providerFamily: family } : {})
      );
      expect(category).toBe(expected);
    });
  }

  const anthropicFallthroughs = [
    '403 forbidden',
    'token expired',
    'not authenticated',
    'service unavailable',
    '503 service unavailable',
    'unknown error',
    'job 14012 failed',
    'model not found',
    'insufficient quota',
  ];

  for (const raw of anthropicFallthroughs) {
    it(`anthropic family "${raw}" falls through to SYSTEM`, () => {
      expect(decideProviderTerminalCategory(signal({ rawText: raw }), env())).toBe(
        ErrorCategory.SYSTEM
      );
    });
  }
});
