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
 * Descriptive (non-numeric) substrings that indicate a retryable provider error.
 * Numeric 5xx codes are matched separately via HTTP_5XX_STATUS_RE to avoid
 * false positives on bare digit substrings (e.g. "5000ms", UUID fragments).
 *
 * IMPORTANT: Only server-side/transient failures belong here. 4xx, auth,
 * quota, and model_not_found errors are terminal and MUST NOT be added —
 * they are non-retryable (guarded explicitly by isRetryableProviderError).
 *
 * Coordinated with B1 (529→overloaded mapping), B2 (broadened transient
 * patterns), B3 (body normalization). As those land, provider-specific
 * transient signals can be added here.
 */
export const RETRYABLE_PROVIDER_ERROR_TEXT: readonly string[] = [
  // Anthropic 529 overloaded (server-side capacity)
  'overloaded',
  // Generic 5xx descriptive patterns
  'internal server error',
  'bad gateway',
  'gateway timeout',
  'service unavailable',
  'temporarily unavailable',
  // GLM (Zhipu) provider overload — code 1305 ("该模型当前访问量过大" = model traffic
  // too high, try again later). The HTTP 529 transport status may not survive into the
  // surfaced error string, so match the provider-specific signals directly. The code is
  // matched in its bracketed payload shape `[1305]` (not as a bare number) so unrelated
  // numerics (token counts, ports, request ids) cannot false-positive into a retry; the
  // Chinese phrases are overload-specific descriptions ("access volume too high") that
  // also catch the payload regardless of how the code is rendered.
  '[1305]',
  '访问量过大',
  '当前访问量过大',
];

/**
 * Matches standalone 5xx HTTP status codes (500-599) with word boundaries so
 * longer digit sequences like "5000ms" or UUID fragments don't false-positive.
 * Covers 500, 502, 503, 504, 520, 529, …
 */
export const HTTP_5XX_STATUS_RE = /\b5\d{2}\b/;

/**
 * Matches standalone 4xx HTTP status codes (400-499) with word boundaries.
 * Used as a terminal guard — 4xx errors (auth, quota, validation) must never
 * be retried. 429 rate-limit is handled separately by RateLimitWatchdog.
 */
export const HTTP_4XX_STATUS_RE = /\b4\d{2}\b/;

/**
 * Detect whether an error message represents a retryable provider error
 * (5xx / overloaded / provider-unavailable). Used by query-runner.ts to
 * decide whether to fire a bounded retry with backoff.
 *
 * Excludes 4xx/auth/quota/model_not_found — those are terminal and must
 * never be retried, even if a retryable signal accidentally co-occurs.
 *
 * Numeric status codes are matched with word boundaries (\b5\d{2}\b) so that
 * digit sequences embedded in longer numbers (e.g. "5000ms timeout", UUID
 * fragments containing "500") do not false-positive into a retry.
 */
export function isRetryableProviderError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();

  // Terminal text guards — auth/quota/model errors (non-numeric patterns).
  if (
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('model_not_found') ||
    lower.includes('quota') ||
    lower.includes('insufficient_quota') ||
    lower.includes('not implemented')
  ) {
    return false;
  }

  // Terminal numeric guard — any standalone 4xx status code. Word-bounded so
  // "4010 tokens" or "14023 tokens" don't false-positive.
  if (HTTP_4XX_STATUS_RE.test(errorMessage)) {
    return false;
  }

  // Permanent 5xx guard — 501 Not Implemented is returned by HyperNeo's bridges
  // (openai-chat-bridge, ollama-bridge) for unsupported routes. It is never
  // transient, so exclude it from the retryable 5xx class.
  if (/\b501\b/.test(errorMessage)) {
    return false;
  }

  // Retryable: any standalone 5xx status code (500-599). Covers 500/502/503/
  // 504/529/… in one bounded check.
  if (HTTP_5XX_STATUS_RE.test(errorMessage)) {
    return true;
  }

  // Retryable: descriptive provider-unavailable patterns.
  return RETRYABLE_PROVIDER_ERROR_TEXT.some((substr) => lower.includes(substr));
}
