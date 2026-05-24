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
