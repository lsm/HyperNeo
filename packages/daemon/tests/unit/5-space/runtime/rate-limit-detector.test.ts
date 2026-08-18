import { describe, expect, test } from 'bun:test';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
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

  test('bare HTTP 429 is matched as rate-limit evidence', () => {
    expect(isRateLimitError('HTTP 429')).toBe(true);
    expect(isRateLimitError('returned error: 429')).toBe(true);
  });

  test('matches abuse-detection and throttling messages', () => {
    expect(isRateLimitError('You have triggered an abuse detection mechanism. Please retry.')).toBe(
      true
    );
    expect(isRateLimitError('GitHub API temporarily blocked this request')).toBe(true);
    expect(isRateLimitError('Request was throttled; try again later')).toBe(true);
  });

  test('bare HTTP 403 without rate-limit text is NOT matched (permission failures)', () => {
    expect(isRateLimitError('HTTP 403: Resource not accessible by integration')).toBe(false);
    expect(isRateLimitError('HTTP 403')).toBe(false);
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

describe('isSecondaryRateLimitError', () => {
  test('matches secondary rate-limit message', () => {
    expect(isSecondaryRateLimitError('HTTP 403: You have exceeded a secondary rate limit')).toBe(
      true
    );
  });

  test('matches abuse-detection and throttling messages as secondary limits', () => {
    expect(
      isSecondaryRateLimitError('You have triggered an abuse detection mechanism. Please retry.')
    ).toBe(true);
    expect(isSecondaryRateLimitError('GitHub API temporarily blocked this request')).toBe(true);
    expect(isSecondaryRateLimitError('Request was throttled; try again later')).toBe(true);
  });

  test('matches 429 / too-many-requests command errors as secondary limits', () => {
    expect(isSecondaryRateLimitError('HTTP 429')).toBe(true);
    expect(isSecondaryRateLimitError('returned error: 429')).toBe(true);
    expect(isSecondaryRateLimitError('Too Many Requests')).toBe(true);
  });

  test('matches secondary rate limit with different casing', () => {
    expect(isSecondaryRateLimitError('SECONDARY RATE LIMIT EXCEEDED')).toBe(true);
    expect(isSecondaryRateLimitError('Secondary Rate-Limit detected')).toBe(true);
  });

  test('does not match primary rate-limit messages', () => {
    expect(isSecondaryRateLimitError('rate limit exceeded')).toBe(false);
    expect(isSecondaryRateLimitError('API rate limit')).toBe(false);
    expect(isSecondaryRateLimitError('primary rate limit exceeded')).toBe(false);
  });

  test('does not match non-rate-limit errors', () => {
    expect(isSecondaryRateLimitError('HTTP 404: Not Found')).toBe(false);
    expect(isSecondaryRateLimitError('')).toBe(false);
  });
});

function computeLimitUndefined(): number {
  return computeRateLimitRetryMs(undefined);
}
