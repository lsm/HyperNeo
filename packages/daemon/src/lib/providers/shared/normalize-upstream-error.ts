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
 */
export const GLM_TRANSIENT_ERROR_SUBSTRINGS: readonly string[] = [
  // "访问量过大" — GLM capacity/overload message.
  '访问量过大',
  // "稍后再试" — "please try again later"; generic transient retry message.
  '稍后再试',
];

/**
 * GLM transient error code for minute-level QPS / rate limiting. Delivered as
 * `error.code` (or top-level `code`) in the response body, in either string
 * ("1305") or numeric (1305) form.
 */
const GLM_RATE_LIMIT_CODE = '1305';

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
  const messageField =
    readStringField(errorObj, 'message') ?? readStringField(parsed, 'message') ?? body;

  const isTransientCode = codeField === GLM_RATE_LIMIT_CODE;
  // Match the GLM-specific Chinese substrings against both the raw body and the
  // extracted message so we catch Anthropic-shaped envelopes that wrap the
  // original GLM message in `error.message`.
  const hasOverloadText =
    containsAny(body, GLM_TRANSIENT_ERROR_SUBSTRINGS) ||
    containsAny(messageField, GLM_TRANSIENT_ERROR_SUBSTRINGS);

  if (!isTransientCode && !hasOverloadText) return null;

  // GLM code 1305 is a rate / QPS code → rate_limit_error. The capacity /
  // overload messages (访问量过大 / 稍后再试) → overloaded_error. Both statuses
  // are retried by the SDK (429 explicitly, 529 via >= 500).
  if (isTransientCode) {
    return rateLimit(messageField);
  }
  return overloaded(messageField);
}

// OpenAI-compatible transient body signals. Used by the chat and responses
// bridges (custom OpenAI endpoints + Codex). Kept tight to avoid turning a
// genuine 4xx invalid_request into a retryable error on weak evidence.
const OPENAI_RATE_LIMIT_PATTERN = /rate_limit_exceeded|rate[ _-]?limit|too many requests/i;
const OPENAI_OVERLOAD_PATTERN =
  /overloaded|service unavailable|temporarily unavailable|try again (?:later|in)/i;
/** OpenAI error `type`/`code` values that indicate a transient server fault. */
const OPENAI_TRANSIENT_SERVER_TYPES = new Set(['server_error']);

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
  const errorObj =
    parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? (parsed.error as Record<string, unknown>)
      : undefined;
  const typeField = readStringField(errorObj, 'type')?.toLowerCase();
  const codeField = readStringField(errorObj, 'code')?.toLowerCase();
  const messageField = readStringField(errorObj, 'message') ?? body;

  const structuredType = typeField ?? codeField;
  const isRateType = structuredType === 'rate_limit_exceeded';
  const isServerType =
    structuredType !== undefined && OPENAI_TRANSIENT_SERVER_TYPES.has(structuredType);

  const isRateMessage = OPENAI_RATE_LIMIT_PATTERN.test(messageField);
  const isOverloadMessage = OPENAI_OVERLOAD_PATTERN.test(messageField);

  const isRate = isRateType || isRateMessage;
  const isOverload = isServerType || isOverloadMessage;

  if (!isRate && !isOverload) return null;

  // A hard 4xx (other than 429) usually means a permanent client error
  // (auth/not-found/bad-request). Only reclassify it when the body carries a
  // strong STRUCTURED transient signal; otherwise leave it to the status-based
  // mapping so we don't retry a genuine 401/404 indefinitely.
  const isHard4xx = status >= 400 && status < 500 && status !== 429;
  if (isHard4xx && !isRateType && !isServerType) return null;

  if (isRate && !isOverload) {
    return rateLimit(messageField);
  }
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
