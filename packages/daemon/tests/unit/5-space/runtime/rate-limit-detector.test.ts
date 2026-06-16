/**
 * Unit tests for shared rate-limit detection helpers.
 */
import { describe, expect, test } from 'bun:test';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../../../../src/lib/space/runtime/rate-limit-detector';

describe('isRateLimitError', () => {
  test('matches gh api rate-limit stderr', () => {
    expect(
      isRateLimitError(
        'HTTP 403: rate limit exceeded (https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting)'
      )
    ).toBe(true);
  });

  test('matches curl style "too many requests"', () => {
    expect(isRateLimitError('HTTP 429: Too Many Requests')).toBe(true);
  });

  test('matches "rate_limit" snake-case variant', () => {
    expect(isRateLimitError('api rate_limit exceeded')).toBe(true);
  });

  test('matches secondary rate-limit message', () => {
    expect(isRateLimitError('HTTP 403: You have exceeded a secondary rate limit')).toBe(true);
  });

  test('does not match generic 404 / network error', () => {
    expect(isRateLimitError('HTTP 404: Not Found')).toBe(false);
    expect(isRateLimitError('Could not resolve host')).toBe(false);
    expect(isRateLimitError('')).toBe(false);
  });
});

describe('computeRateLimitRetryMs', () => {
  test('returns ms remaining until reset, floored to min backoff', () => {
    const resetSeconds = Math.floor((Date.now() + 5 * 60_000) / 1000);
    const ms = computeRateLimitRetryMs(resetSeconds);
    expect(ms).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_BACKOFF_MS);
    expect(ms).toBeLessThanOrEqual(5 * 60_000);
  });

  test('returns min backoff when reset is missing', () => {
    expect(computeRateLimitRetryMs(null)).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
    expect(computeLimitUndefined()).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
  });

  test('returns min backoff when reset is in the past', () => {
    const pastSeconds = Math.floor((Date.now() - 1000) / 1000);
    expect(computeRateLimitRetryMs(pastSeconds)).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
  });
});

function computeLimitUndefined(): number {
  return computeRateLimitRetryMs(undefined);
}
