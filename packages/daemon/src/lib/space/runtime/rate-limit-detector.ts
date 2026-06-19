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

/**
 * Patterns that indicate a rate-limit error in command stderr.
 *
 * Bare `HTTP 403` status matches are intentionally excluded: GitHub also
 * returns 403 for permission/auth failures (e.g. `Resource not accessible by
 * integration`), and classifying those as rate-limit retries hides a real
 * credential problem behind a backoff. Require explicit textual evidence
 * instead. A bare `HTTP 429` is safe to match because GitHub does not return
 * 429 for permission/auth failures.
 */
const RATE_LIMIT_ERROR_PATTERNS = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /secondary rate/i,
  /API rate limit/i,
  // Abuse-detection / throttling messages also require a backoff rather than
  // an immediate retry.
  /abuse detection/i,
  /temporarily blocked/i,
  /throttled/i,
  // A 429 status is itself rate-limit evidence; GitHub does not return 429 for
  // permission/auth failures, so a bare status match is safe.
  /HTTP\s*429/i,
  /returned error:\s*429/i,
];

/**
 * Returns true if stderr text matches known rate-limit error patterns.
 *
 * Matches both `gh api` style ("HTTP 403: rate limit exceeded (documentation_url)") and
 * raw `curl` style ("rate limit exceeded"). Bare `HTTP 403` is not sufficient
 * because GitHub also returns it for permission/auth failures — see
 * {@link RATE_LIMIT_ERROR_PATTERNS}. Empty input never matches.
 */
export function isRateLimitError(stderr: string): boolean {
  if (!stderr) return false;
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Returns true if stderr indicates a GitHub secondary rate limit.
 *
 * Secondary limits (burst / abuse-detection) return 403 with a message like
 * "You have exceeded a secondary rate limit" but do NOT update the
 * `/rate_limit` endpoint. When true, callers should skip the primary-reset
 * probe and fall back to the minimum backoff or any `Retry-After` header.
 */
export function isSecondaryRateLimitError(stderr: string): boolean {
  if (!stderr) return false;
  return /secondary rate/i.test(stderr);
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
