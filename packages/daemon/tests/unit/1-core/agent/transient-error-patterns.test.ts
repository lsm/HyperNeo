/**
 * Unit tests for transient-error-patterns.ts
 *
 * Covers the bounded-retry detection helper (isRetryableProviderError) and
 * the shared pattern arrays used by query-runner.ts and api-error-circuit-breaker.ts.
 */

import { describe, it, expect } from 'bun:test';
import {
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
  TRANSIENT_CONNECTION_ERROR_REGEXES,
  RETRYABLE_PROVIDER_ERROR_SUBSTRINGS,
  isRetryableProviderError,
} from '../../../../src/lib/agent/transient-error-patterns';

describe('TRANSIENT_CONNECTION_ERROR_SUBSTRINGS / REGEXES', () => {
  it('keeps substring and regex arrays in sync (same count)', () => {
    expect(TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.length).toBe(
      TRANSIENT_CONNECTION_ERROR_REGEXES.length
    );
  });
});

describe('RETRYABLE_PROVIDER_ERROR_SUBSTRINGS', () => {
  it('does not include 4xx/auth/quota/model patterns', () => {
    const joined = RETRYABLE_PROVIDER_ERROR_SUBSTRINGS.join(' ').toLowerCase();
    // These terminal signals must never appear in the retryable set.
    expect(joined).not.toContain('401');
    expect(joined).not.toContain('403');
    expect(joined).not.toContain('unauthorized');
    expect(joined).not.toContain('model_not_found');
    expect(joined).not.toContain('quota');
  });

  it('includes 5xx / overloaded / unavailable signals', () => {
    const joined = RETRYABLE_PROVIDER_ERROR_SUBSTRINGS.join(' ').toLowerCase();
    expect(joined).toContain('overloaded');
    expect(joined).toContain('529');
    expect(joined).toContain('500');
    expect(joined).toContain('502');
    expect(joined).toContain('503');
    expect(joined).toContain('service unavailable');
  });
});

describe('isRetryableProviderError', () => {
  describe('retryable (returns true)', () => {
    const retryable = [
      '529 {"type":"error","error":{"type":"overloaded_error"}}',
      'Error: 529 Overloaded',
      'overloaded',
      '503 Service Unavailable',
      'service unavailable',
      '500 Internal Server Error',
      'internal server error',
      '502 Bad Gateway',
      'bad gateway',
      'temporarily unavailable',
      'API Error: 500 {"error":{"type":"api_error"}}',
    ];

    for (const msg of retryable) {
      it(`returns true for: ${msg}`, () => {
        expect(isRetryableProviderError(msg)).toBe(true);
      });
    }
  });

  describe('terminal (returns false)', () => {
    const terminal = [
      '401 Unauthorized',
      '403 Forbidden',
      'unauthorized',
      'invalid_api_key',
      'model_not_found: bad-model',
      '402 {"error":{"message":"insufficient_quota"}}',
      'quota exceeded',
      'no quota',
      'insufficient_quota',
      '400 Bad Request',
      '429 Too Many Requests',
      'Some generic error with no status code',
      'Exit code: 1',
      '',
    ];

    for (const msg of terminal) {
      it(`returns false for: ${msg}`, () => {
        expect(isRetryableProviderError(msg)).toBe(false);
      });
    }
  });

  describe('auth guard wins over retryable substring', () => {
    it('returns false when a 5xx signal co-occurs with invalid_api_key', () => {
      expect(isRetryableProviderError('500 error: invalid_api_key')).toBe(false);
    });

    it('returns false when "overloaded" co-occurs with 401', () => {
      expect(isRetryableProviderError('overloaded after 401 retry')).toBe(false);
    });

    it('returns false when 503 co-occurs with quota', () => {
      expect(isRetryableProviderError('503 due to quota limits')).toBe(false);
    });
  });

  describe('case-insensitivity', () => {
    it('matches "Overloaded" with capital O', () => {
      expect(isRetryableProviderError('Error: Overloaded')).toBe(true);
    });

    it('matches "INTERNAL SERVER ERROR" uppercased', () => {
      expect(isRetryableProviderError('INTERNAL SERVER ERROR')).toBe(true);
    });

    it('excludes "UNAUTHORIZED" uppercased', () => {
      expect(isRetryableProviderError('UNAUTHORIZED')).toBe(false);
    });
  });
});
