export const RATE_LIMIT_MIN_BACKOFF_MS = 60_000;

const RATE_LIMIT_ERROR_PATTERNS = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /secondary rate/i,
  /API rate limit/i,
  /abuse detection/i,
  /temporarily blocked/i,
  /throttled/i,
  /HTTP\s*429/i,
  /returned error:\s*429/i,
];

export function isRateLimitError(stderr: string): boolean {
  if (!stderr) return false;
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}

export function isSecondaryRateLimitError(stderr: string): boolean {
  if (!stderr) return false;
  return (
    /secondary rate/i.test(stderr) ||
    /too many requests/i.test(stderr) ||
    /abuse detection/i.test(stderr) ||
    /temporarily blocked/i.test(stderr) ||
    /throttled/i.test(stderr) ||
    /HTTP\s*429/i.test(stderr) ||
    /returned error:\s*429/i.test(stderr)
  );
}

export function computeRateLimitRetryMs(resetEpochSeconds: number | null | undefined): number {
  if (typeof resetEpochSeconds !== 'number' || !Number.isFinite(resetEpochSeconds)) {
    return RATE_LIMIT_MIN_BACKOFF_MS;
  }
  const ms = Math.floor(resetEpochSeconds) * 1000 - Date.now();
  return Math.max(RATE_LIMIT_MIN_BACKOFF_MS, ms);
}
