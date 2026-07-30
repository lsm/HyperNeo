/**
 * Per-bridge upstream-error normalization.
 *
 * Bridges used to classify upstream errors by HTTP status only
 * (`mapUpstreamStatus` / `mapOpenAIStatusToAnthropicError`). Many gateways —
 * GLM (open.bigmodel.cn) especially — return transient errors embedded in the
 * response BODY, not the status:
 *
 *   - 200-with-error-body: HTTP 200 but the body is a JSON error object instead
 *     of an SSE stream. The pass-through bridge forwarded it verbatim, so the
 *     SDK saw a 200 "success" and the error became terminal (no retry).
 *   - non-2xx-with-error-body: the status (e.g. 400) implied a non-retryable
 *     `invalid_request_error` even though the body carried an overload code.
 *   - mid-stream error frame: a 200 SSE stream that emits an `event: error`
 *     chunk mid-stream. The SDK cannot re-issue a started stream, so the
 *     query-runner (B4) must re-run the whole query — these helpers classify
 *     the body so that retry path can recognise it.
 *
 * `normalizeXxxUpstreamError(body, status)` inspects the BODY for
 * provider-specific transient signals and emits the Anthropic retryable type
 * (`overloaded_error` / `rate_limit_error`) plus a status the Claude Agent SDK
 * actually retries. Verified against the SDK's `shouldRetry`: it retries on
 * status 408, 409, 429 and any `>= 500`, and honours an `x-should-retry:
 * true` header — so `429` (rate_limit_error) and `529` (overloaded_error) both
 * trigger the SDK's built-in retry loop before the turn dies.
 */

import type { AnthropicErrorType } from './error-envelope.js';
import {
  GLM_RATE_LIMIT_CODE,
  GLM_TRANSIENT_BODY_SUBSTRINGS,
  OVERLOAD_MESSAGE_PATTERN,
  RATE_LIMIT_MESSAGE_PATTERN,
  TRANSIENT_OVERLOAD_CODES,
  TRANSIENT_RATE_LIMIT_CODES,
} from '@hyperneo/shared/provider/error-taxonomy';

/**
 * A normalized upstream error: the Anthropic error type to surface, the HTTP
 * status to emit (chosen so the SDK retries transient classifications), and a
 * human-readable message (usually the original provider message, preserved so
 * the user sees the real reason).
 */
export type NormalizedUpstreamError = {
  type: AnthropicErrorType;
  status: number;
  message: string;
};

/**
 * GLM (Zhipu AI / open.bigmodel.cn) transient overload/rate-limit body signals.
 *
 * Exported so the query-runner (B4) can recognise mid-stream GLM overload
 * errors that arrive as terminal in-stream SSE errors and re-issue the whole
 * query — the SDK cannot retry a stream it has already started. These
 * substrings are GLM-specific (Simplified Chinese) and safe to match against
 * any error string without false positives on other providers.
 *
 * Sourced from the provider error taxonomy registry (body-context signals) so
 * this list cannot drift from the query-runner's loose-text retry guard.
 */
export const GLM_TRANSIENT_ERROR_SUBSTRINGS: readonly string[] = GLM_TRANSIENT_BODY_SUBSTRINGS;

function rateLimit(message: string): NormalizedUpstreamError {
  return { type: 'rate_limit_error', status: 429, message };
}

function overloaded(message: string): NormalizedUpstreamError {
  return { type: 'overloaded_error', status: 529, message };
}

/** Best-effort JSON object parse; returns undefined for non-JSON / non-object. */
function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read a string field from a maybe-object, coercing numbers to string. */
function readStringField(
  obj: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = obj?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * True when a Content-Type value denotes a JSON body — `application/json`,
 * `Application/JSON`, or any JSON-based media type such as
 * `application/problem+json` (RFC 7807) or `application/vnd.api+json`. HTTP
 * media types are case-insensitive, so the check is too. Used by the bridges to
 * decide when a 200 response is a body-embedded JSON error worth buffering and
 * normalizing (vs. a real SSE stream that must flow through unbuffered).
 */
export function isJsonContentType(contentType: string): boolean {
  return /application\/(?:[\w.+-]+\+)?json/i.test(contentType);
}

/**
 * Inspect a GLM upstream response body for transient overload/rate-limit
 * signals the HTTP status alone cannot convey. GLM frequently returns 200 with
 * an error body (no SSE), or a 4xx carrying an overload code — both surface as
 * terminal, non-retried errors without this normalization.
 *
 * Recognised GLM transient signals:
 *   - error code `1305` (minute-level QPS / rate limiting) → rate_limit_error
 *   - body/message containing `访问量过大` or `稍后再试` → overloaded_error
 *
 * @returns the retryable classification, or `null` when no transient signal is
 *   found (caller falls back to status-based mapping).
 */
export function normalizeGlmUpstreamError(
  body: string,
  _status: number
): NormalizedUpstreamError | null {
  if (!body) return null;

  // GLM emits errors in several shapes:
  //   {"error":{"code":"1305","message":"访问量过大，请稍后再试"}}
  //   {"code":"1305","message":"..."}                         (flat)
  //   {"type":"error","error":{"type":"...","message":"..."}} (Anthropic-shaped)
  const parsed = tryParseJsonObject(body);
  const errorObj =
    parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? (parsed.error as Record<string, unknown>)
      : undefined;
  const codeField = readStringField(errorObj, 'code') ?? readStringField(parsed, 'code');
  // Message for substring matching — extracted error/message/detail fields only,
  // NOT the raw body (a valid JSON success response whose content mentions the
  // GLM overload phrases must not be misclassified). The result message still
  // falls back to the body for context.
  const messageForMatching =
    readStringField(errorObj, 'message') ??
    readStringField(parsed, 'message') ??
    readStringField(errorObj, 'detail') ??
    readStringField(parsed, 'detail');
  const messageField = messageForMatching ?? body;

  const isTransientCode = codeField === GLM_RATE_LIMIT_CODE;
  // For JSON bodies, match ONLY against the extracted error/message fields. For
  // non-JSON bodies (plain-text errors from proxies), fall back to scanning the
  // raw text since there are no structured fields to read.
  const hasOverloadText = parsed
    ? messageForMatching !== undefined &&
      containsAny(messageForMatching, GLM_TRANSIENT_ERROR_SUBSTRINGS)
    : containsAny(body, GLM_TRANSIENT_ERROR_SUBSTRINGS);

  if (!isTransientCode && !hasOverloadText) return null;

  // GLM code 1305 is a rate / QPS code → rate_limit_error. The capacity /
  // overload messages (访问量过大 / 稍后再试) → overloaded_error. Both statuses
  // are retried by the SDK (429 explicitly, 529 via >= 500).
  if (isTransientCode) {
    return rateLimit(messageField);
  }
  return overloaded(messageField);
}

// Generic transient body signals. Used by the chat and responses bridges
// (custom OpenAI endpoints + Codex) AND by the combined `normalizeUpstreamError`
// the Anthropic-messages pass-through bridge calls. Kept tight to avoid turning
// a genuine 4xx invalid_request into a retryable error on weak evidence.
// Patterns and code sets come from the provider error taxonomy registry.
const OPENAI_RATE_LIMIT_PATTERN = RATE_LIMIT_MESSAGE_PATTERN;
const OPENAI_OVERLOAD_PATTERN = OVERLOAD_MESSAGE_PATTERN;
/**
 * Structured `error.type`/`error.code` values that mark a transient fault.
 * Includes OpenAI values (`rate_limit_exceeded`, `server_error`), Anthropic
 * values (`rate_limit_error`, `overloaded_error`), and the HTTP status codes
 * some gateways put in `error.code` (e.g. `{"error":{"code":429}}` on a 400) —
 * the generic detector also serves the Anthropic pass-through bridge, where an
 * Anthropic-shaped body is the strongest possible structured signal.
 */
const TRANSIENT_RATE_LIMIT_TYPES = TRANSIENT_RATE_LIMIT_CODES;
const TRANSIENT_OVERLOAD_TYPES = TRANSIENT_OVERLOAD_CODES;

/**
 * True if a string is a recognized transient error type/code — OpenAI
 * (`rate_limit_exceeded`, `server_error`), Anthropic (`rate_limit_error`,
 * `overloaded_error`), or an HTTP status code some gateways put in `code`
 * (`429`, `503`, `529`). Used to admit type-only flat error frames while still
 * ignoring unknown heartbeat/metadata frames (e.g. `{"type":"ping"}`).
 */
export function isOpenAiTransientErrorType(type: string): boolean {
  const t = type.toLowerCase();
  return TRANSIENT_RATE_LIMIT_TYPES.has(t) || TRANSIENT_OVERLOAD_TYPES.has(t);
}

/**
 * Inspect an OpenAI-compatible upstream response body for transient signals.
 * OpenAI / most proxies already convey transient failures via 429 / 5xx
 * statuses (which the SDK retries), so this primarily recovers the two cases
 * the status misses: a 200-with-error-body and a mid-stream `error` chunk.
 *
 * On a hard 4xx (auth / not-found / bad-request) only a STRONG structured
 * signal (`error.type`/`error.code` of `rate_limit_exceeded` or
 * `server_error`) is trusted — a stray transient word in a 401 message must
 * never become a retryable error. Message-substring evidence is honoured on
 * 200-with-body and 5xx, where there is no trustworthy status to defer to.
 *
 * @returns the retryable classification, or `null` when no transient signal is
 *   found.
 */
export function normalizeOpenAiUpstreamError(
  body: string,
  status: number
): NormalizedUpstreamError | null {
  if (!body) return null;

  const parsed = tryParseJsonObject(body);
  const errorValue = parsed?.error;
  const errorObj =
    errorValue && typeof errorValue === 'object' && !Array.isArray(errorValue)
      ? (errorValue as Record<string, unknown>)
      : undefined;
  // Some proxies return a STRING `error` value, e.g. `{"error":"Too Many
  // Requests"}` or `{"error":"rate_limit_exceeded"}`. Treat it as message
  // evidence, and — when it is a recognized transient type — as code evidence.
  const errorString = typeof errorValue === 'string' ? errorValue : undefined;
  // Read structured fields from the nested `error` object, falling back to the
  // top-level body — some upstreams emit a FLAT body like
  // `{"code":"rate_limit_exceeded","message":"slow down"}` with no `error`
  // wrapper, and those top-level fields are structured evidence too.
  // Also accept RFC 7807 problem+json fields: `detail` (message) and `status`
  // (HTTP status code), since the content-type gate already accepts
  // `application/problem+json`.
  const typeField = (
    readStringField(errorObj, 'type') ?? readStringField(parsed, 'type')
  )?.toLowerCase();
  const codeField = (
    readStringField(errorObj, 'code') ??
    readStringField(parsed, 'code') ??
    readStringField(errorObj, 'status') ??
    readStringField(parsed, 'status') ??
    errorString
  )?.toLowerCase();
  // Message for substring matching — use ONLY the extracted error/top-level
  // message (or problem+json `detail` / a string `error` value), NOT the raw body.
  const messageForMatching =
    readStringField(errorObj, 'message') ??
    readStringField(parsed, 'message') ??
    readStringField(errorObj, 'detail') ??
    readStringField(parsed, 'detail') ??
    errorString;
  // Result message falls back to the body so the surfaced error has context.
  const messageField = messageForMatching ?? body;

  // Inspect BOTH `type` and `code` independently. OpenAI-compatible payloads
  // sometimes set `error.type` to a broad category (e.g. "requests") while the
  // actionable transient value lives in `error.code` (e.g. "rate_limit_exceeded").
  // A `type ?? code` short-circuit would miss that combination. Recognise both
  // OpenAI (`rate_limit_exceeded`/`server_error`) and Anthropic
  // (`rate_limit_error`/`overloaded_error`) retryable type values — the latter is
  // an explicit, unambiguous signal that always passes the hard-4xx guard.
  const isRateType =
    (typeField !== undefined && TRANSIENT_RATE_LIMIT_TYPES.has(typeField)) ||
    (codeField !== undefined && TRANSIENT_RATE_LIMIT_TYPES.has(codeField));
  const isServerType =
    (typeField !== undefined && TRANSIENT_OVERLOAD_TYPES.has(typeField)) ||
    (codeField !== undefined && TRANSIENT_OVERLOAD_TYPES.has(codeField));

  const isRateMessage =
    messageForMatching !== undefined && OPENAI_RATE_LIMIT_PATTERN.test(messageForMatching);
  const isOverloadMessage =
    messageForMatching !== undefined && OPENAI_OVERLOAD_PATTERN.test(messageForMatching);

  const isRate = isRateType || isRateMessage;
  const isOverload = isServerType || isOverloadMessage;

  if (!isRate && !isOverload) return null;

  // An explicit client-side status (4xx, including 429) is a trustworthy
  // signal: a hard 4xx usually means a permanent client error
  // (auth/not-found/bad-request), and a 429 is already a rate limit. Only let a
  // STRONG STRUCTURED transient signal (error.type/error.code) override such a
  // status — never loose message substrings. Otherwise we'd either retry a
  // genuine 401/404 indefinitely, or let a "try again later" message override an
  // explicit 429 and mislabel it as overloaded_error.
  const isExplicitClientStatus = status >= 400 && status < 500;
  if (isExplicitClientStatus && !isRateType && !isServerType) return null;

  // Structured type evidence wins over loose message substrings: a body whose
  // `type` is `rate_limit_exceeded` must classify as rate_limit_error (429) even
  // if its message also matches the overload regex (e.g. "...try again in 20s").
  if (isRateType) return rateLimit(messageField);
  if (isServerType) return overloaded(messageField);
  // No structured signal — fall back to message evidence. This branch is only
  // reached where message evidence is trusted (200-with-body / 5xx), since the
  // hard-4xx guard above already returned for message-only hard-4xx matches.
  if (isRateMessage) return rateLimit(messageField);
  return overloaded(messageField);
}

/**
 * Combined helper for the generic Anthropic-messages pass-through bridge, which
 * does not know which provider is upstream. Tries the GLM detector first (its
 * signals are provider-specific and cannot false-positive), then the generic
 * OpenAI detector for Anthropic-compatible shims that wrap OpenAI-style errors.
 */
export function normalizeUpstreamError(
  body: string,
  status: number
): NormalizedUpstreamError | null {
  return normalizeGlmUpstreamError(body, status) ?? normalizeOpenAiUpstreamError(body, status);
}
