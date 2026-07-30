/**
 * Shared transient connection error patterns.
 *
 * Used by both query-runner.ts (includes-based matching for retry detection)
 * and api-error-circuit-breaker.ts (regex-based matching for error filtering).
 *
 * All pattern data lives in the provider error taxonomy registry
 * (`@hyperneo/shared/provider/error-taxonomy`) — this module is a thin
 * re-export adapter so the substring and regex forms can never drift.
 */

export {
  HTTP_4XX_STATUS_RE,
  HTTP_5XX_STATUS_RE,
  RETRYABLE_PROVIDER_ERROR_TEXT,
  TRANSIENT_CONNECTION_ERROR_REGEXES,
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
  isRetryableProviderError,
} from '@hyperneo/shared/provider/error-taxonomy';
