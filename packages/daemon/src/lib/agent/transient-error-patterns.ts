/**
 * Shared transient connection error patterns.
 *
 * Used by both query-runner.ts (includes-based matching for retry detection)
 * and api-error-circuit-breaker.ts (regex-based matching for error filtering).
 *
 * Keep both arrays in sync — each substring entry has a corresponding regex
 * entry with the same semantics. Adding a pattern to only one location
 * creates inconsistent retry/circuit-breaker behaviour.
 */

/**
 * Substrings used by query-runner.ts `includes()` checks to detect transient
 * fetch/connection errors.  These are mid-stream HTTP connection drops (network
 * blip, server restart, timeout) that should be retried rather than surfaced
 * as raw developer-facing error strings.
 */
export const TRANSIENT_CONNECTION_ERROR_SUBSTRINGS: readonly string[] = [
  'socket connection was closed',
  'verbose: true in the second argument to fetch()',
  'TypeError: fetch failed',
  'connection reset',
  'stream closed',
  'SocketError',
  'ReadableStream is locked',
  'network down',
  'Unable to connect',
  'backend connection error',
];

/**
 * Regex patterns used by api-error-circuit-breaker.ts to skip counting transient
 * connection errors.  Each entry corresponds to a substring in
 * TRANSIENT_CONNECTION_ERROR_SUBSTRINGS above.
 */
export const TRANSIENT_CONNECTION_ERROR_REGEXES: readonly RegExp[] = [
  /socket connection was closed/i,
  /verbose:\s*true\s+in the second argument to fetch/i,
  /TypeError:\s*fetch\s+failed/i,
  /connection reset/i,
  /stream closed/i,
  /SocketError/i,
  /ReadableStream is locked/i,
  /network down/i,
  /Unable to connect/i,
  /backend connection error/i,
];

/**
 * Substrings used by query-runner.ts to detect retryable provider errors
 * (5xx, overloaded, service unavailable). These are transient server-side
 * failures that escaped the SDK's own retry logic and should get a bounded
 * retry at the NeoKai level with exponential backoff.
 *
 * IMPORTANT: Only server-side/transient failures belong here. 4xx, auth,
 * quota, and model_not_found errors are terminal and MUST NOT be added —
 * they are non-retryable (guarded explicitly by isRetryableProviderError).
 *
 * Coordinated with B1 (529→overloaded mapping), B2 (broadened transient
 * patterns), B3 (body normalization). As those land, provider-specific
 * transient signals can be added here.
 */
export const RETRYABLE_PROVIDER_ERROR_SUBSTRINGS: readonly string[] = [
  // Anthropic 529 overloaded (server-side capacity)
  'overloaded',
  '529',
  // Generic 5xx
  'internal server error',
  '500',
  'bad gateway',
  '502',
  'service unavailable',
  '503',
  'temporarily unavailable',
];

/**
 * Detect whether an error message represents a retryable provider error
 * (5xx / overloaded / provider-unavailable). Used by query-runner.ts to
 * decide whether to fire a bounded retry with backoff.
 *
 * Excludes 4xx/auth/quota/model_not_found — those are terminal and must
 * never be retried, even if a retryable substring accidentally co-occurs.
 */
export function isRetryableProviderError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  // Terminal error guards — never retry these even if a retryable substring
  // accidentally co-occurs in the message.
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('model_not_found') ||
    lower.includes('402') ||
    lower.includes('quota') ||
    lower.includes('insufficient_quota')
  ) {
    return false;
  }
  return RETRYABLE_PROVIDER_ERROR_SUBSTRINGS.some((substr) => lower.includes(substr.toLowerCase()));
}
