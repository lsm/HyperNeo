/**
 * Shared rate-limit detection helpers.
 *
 * Used by gate hook executors (pr-ready-validator, gate-script-executor) to
 * detect GitHub API rate-limit failures in command stderr and compute a sane
 * retry-after backoff. The HTTP-header-based parser lives in the GitHub
 * extension (`parseRateLimitHeaders`) because it consumes `Response.headers`,
 * whereas these helpers operate on plain text emitted by `gh` / bash scripts.
 */

/** Minimum backoff when deferring rate-limited operations. */
export const RATE_LIMIT_MIN_BACKOFF_MS = 60_000;

/** Patterns that indicate a rate-limit error in command stderr. */
const RATE_LIMIT_ERROR_PATTERNS = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /HTTP 403/,
  /HTTP 429/,
  /secondary rate/i,
];

/**
 * Returns true if stderr text matches known rate-limit error patterns.
 *
 * Matches both `gh api` style ("HTTP 403: rate limit exceeded (documentation_url)") and
 * raw `curl` style ("rate limit exceeded"). Empty input never matches.
 */
export function isRateLimitError(stderr: string): boolean {
  if (!stderr) return false;
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Computes the retry-after delay in milliseconds from a GitHub `X-RateLimit-Reset`
 * epoch (seconds). Returns `RATE_LIMIT_MIN_BACKOFF_MS` when reset is missing,
 * not finite, or already in the past. Never returns a value below the minimum
 * backoff so callers cannot hot-loop a flapping endpoint.
 */
export function computeRateLimitRetryMs(resetEpochSeconds: number | null | undefined): number {
  if (typeof resetEpochSeconds !== 'number' || !Number.isFinite(resetEpochSeconds)) {
    return RATE_LIMIT_MIN_BACKOFF_MS;
  }
  const ms = Math.floor(resetEpochSeconds) * 1000 - Date.now();
  return Math.max(RATE_LIMIT_MIN_BACKOFF_MS, ms);
}
