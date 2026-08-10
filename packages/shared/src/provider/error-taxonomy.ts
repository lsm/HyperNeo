/**
 * Normalized provider error taxonomy registry.
 *
 * Single source of truth for classifying provider (LLM upstream) errors across
 * every surface that touches them: bridge HTTP servers (Anthropic-messages /
 * OpenAI chat / OpenAI responses / Ollama), the query-runner bounded retry,
 * the API error circuit breaker, and the space runtime's prompt-too-long
 * recovery. These paths used to keep independent copies of the same regexes,
 * status maps, and provider-code lists, and the copies drifted (e.g. the GLM
 * overload substrings diverged between the bridge normalizer and the
 * query-runner retry guard).
 *
 * The registry answers, for each class of provider error:
 *   - what it looks like   (HTTP statuses, structured provider codes, message
 *                           substrings/regexes — including localized strings)
 *   - what to do about it  (action: retry / compact / continue / surface)
 *   - how to emit it       (Anthropic wire type for bridge error envelopes)
 *
 * ## Signal trust contexts
 *
 * The same string is not equally trustworthy everywhere:
 *   - `providerCodes`     — structured `error.code` / `error.type` fields in a
 *                           response body or mid-stream error frame. Strong
 *                           evidence; trusted even on a hard 4xx status.
 *   - `bodySubstrings`    — message-field substrings trusted only when matching
 *                           against a provider response body (or an extracted
 *                           error/message/detail field). Too generic for loose
 *                           text (e.g. GLM's "稍后再试" = "try again later"
 *                           also appears on terminal validation errors).
 *   - `looseTextSubstrings` — substrings trusted in ANY surfaced error string
 *                           (SDK result text, stderr captures). Must be
 *                           specific enough to never false-positive.
 *
 * ## Body-embedded and mid-stream errors
 *
 * Many gateways (GLM especially) return transient failures as HTTP 200 with a
 * JSON error body, or as an `event: error` SSE frame mid-stream. The HTTP
 * status alone is useless there, so body/frame classification goes through the
 * code/substring signals below; the daemon-side normalizer
 * (`providers/shared/normalize-upstream-error.ts`) consumes this registry and
 * re-emits the error with a status the Claude Agent SDK retries (429 / 529 /
 * `x-should-retry: true`).
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Anthropic API error type discriminators (bridge error-envelope format). */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'not_implemented_error'
  | 'api_error'
  | 'overloaded_error';

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/** Provider-neutral error classification. */
export type ProviderErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'connection'
  | 'authentication'
  | 'permission'
  | 'quota_exceeded'
  | 'prompt_too_long'
  | 'request_too_large'
  | 'not_found'
  | 'not_implemented'
  | 'invalid_request'
  | 'unknown';

/**
 * What the system should do with a classified provider error:
 *   - `retry`    — transient; retry automatically with backoff (SDK-level
 *                  retry, bounded query-runner retry, or watchdog cooldown).
 *   - `compact`  — context overflow; compact the conversation, then continue.
 *   - `continue` — benign; do not treat as an error or interrupt the turn
 *                  (e.g. unknown heartbeat/metadata frames in a stream).
 *                  Reserved by the action vocabulary; no entry uses it yet.
 *   - `surface`  — terminal; show the user. Never auto-retried.
 */
export type ProviderErrorAction = 'retry' | 'compact' | 'continue' | 'surface';

/** One registry entry: a normalized error kind plus every signal that maps to it. */
export interface ProviderErrorTaxonomyEntry {
  kind: ProviderErrorKind;
  action: ProviderErrorAction;
  /** Anthropic wire type to emit when this kind crosses a bridge envelope. */
  anthropicType: AnthropicErrorType;
  /** Daemon provider id when the entry is provider-specific (e.g. 'glm'). */
  provider?: string;
  /** HTTP statuses that canonically indicate this kind. */
  httpStatuses?: readonly number[];
  /**
   * Structured `error.code` / `error.type` values (lowercased). Trusted even
   * when the HTTP status says otherwise (200-with-error-body, 4xx carrying an
   * overload code, mid-stream error frames).
   */
  providerCodes?: readonly string[];
  /** Message substrings trusted only in provider-body context. */
  bodySubstrings?: readonly string[];
  /** Message substrings trusted in any surfaced error text. */
  looseTextSubstrings?: readonly string[];
  /** Message regex (body/extracted-message context). */
  messagePattern?: RegExp;
  /** Why this classification and action are correct. */
  description: string;
}

/**
 * Matches standalone 5xx HTTP status codes (500-599) with word boundaries so
 * longer digit sequences like "5000ms" or UUID fragments don't false-positive.
 * Covers 500, 502, 503, 504, 520, 529, …
 */
export const HTTP_5XX_STATUS_RE = /\b5\d{2}\b/;

/**
 * Matches standalone 4xx HTTP status codes (400-499) with word boundaries.
 * Used as a terminal guard — 4xx errors (auth, quota, validation) must never
 * be retried. 429 rate-limit is handled separately by the rate-limit watchdog.
 */
export const HTTP_4XX_STATUS_RE = /\b4\d{2}\b/;

/**
 * Canonical prompt-too-long detector. Matches both the Anthropic token-count
 * form ("prompt is too long: 200000 tokens > 128000 maximum", capturing both
 * counts) and the bare form ("Prompt is too long", e.g. Kimi — which surfaces
 * the overflow as a 400, a bare `result` string, or a `blocking_limit`
 * terminal reason with no token counts at all).
 */
export const PROMPT_TOO_LONG_RE =
  /prompt is too long(?::\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum)?/i;

/**
 * GLM (Zhipu AI / open.bigmodel.cn) minute-level QPS / rate-limit code.
 * Delivered as `error.code` (or top-level `code`), string or numeric.
 */
export const GLM_RATE_LIMIT_CODE = '1305';

/**
 * Bracketed form of the GLM rate-limit code for loose-text matching. The bare
 * number would false-positive on token counts, ports, and request ids, so only
 * the `[1305]` payload shape is trusted outside structured fields.
 */
const GLM_RATE_LIMIT_CODE_BRACKETED = '[1305]';

export const PROVIDER_ERROR_TAXONOMY: readonly ProviderErrorTaxonomyEntry[] = [
  {
    kind: 'rate_limit',
    action: 'retry',
    anthropicType: 'rate_limit_error',
    httpStatuses: [429],
    providerCodes: ['rate_limit_exceeded', 'rate_limit_error', '429'],
    messagePattern: /rate_limit_exceeded|rate[ _-]?limit|too many requests/i,
    description:
      'Request rate / quota window exceeded. Retried by the SDK (429), the ' +
      'bounded query-runner retry, or the rate-limit watchdog (cooldown + ' +
      'bounded auto-retries). Never an indefinite loop.',
  },
  {
    kind: 'rate_limit',
    provider: 'glm',
    action: 'retry',
    anthropicType: 'rate_limit_error',
    providerCodes: [GLM_RATE_LIMIT_CODE],
    looseTextSubstrings: [GLM_RATE_LIMIT_CODE_BRACKETED],
    description:
      'GLM minute-level QPS limiting (code 1305). The HTTP transport status ' +
      'may not survive into the surfaced error string, so the code is also ' +
      'matched in its bracketed `[1305]` payload shape in loose text.',
  },
  {
    kind: 'overloaded',
    action: 'retry',
    anthropicType: 'overloaded_error',
    httpStatuses: [529],
    // Structured values some gateways put in `error.type`/`error.code` for a
    // capacity fault — including HTTP status codes rendered as strings (e.g.
    // `{"error":{"code":429}}`-style bodies from proxies). Normalized to 529 /
    // overloaded_error so the SDK's >=500 retry fires.
    providerCodes: ['server_error', 'overloaded_error', '500', '502', '503', '504', '529'],
    messagePattern:
      /overloaded|service unavailable|temporarily unavailable|try again (?:later|in)|internal server error|bad gateway|gateway timeout/i,
    looseTextSubstrings: ['overloaded'],
    description:
      'Provider capacity overload (Anthropic 529 overloaded_error). Server-side ' +
      'and transient: always safe to retry with backoff.',
  },
  {
    kind: 'overloaded',
    provider: 'glm',
    action: 'retry',
    anthropicType: 'overloaded_error',
    // 访问量过大 = "access volume too high" (capacity); 稍后再试 = "please try
    // again later". The latter is trusted only in GLM response bodies — in
    // loose surfaced text it also appears on terminal validation errors
    // (e.g. "参数错误，请稍后再试" = "parameter error, try again later").
    bodySubstrings: ['访问量过大', '稍后再试'],
    // 当前访问量过大 already contains 访问量过大; kept explicit for parity with
    // the historical retry guard list.
    looseTextSubstrings: ['访问量过大', '当前访问量过大'],
    description:
      'GLM (Simplified Chinese) capacity/overload messages. Frequently arrive ' +
      'as 200-with-error-body, so body-substring evidence is required in ' +
      'addition to status mapping.',
  },
  {
    kind: 'server_error',
    action: 'retry',
    anthropicType: 'api_error',
    httpStatuses: [500, 502, 503, 504],
    looseTextSubstrings: [
      'internal server error',
      'bad gateway',
      'gateway timeout',
      'service unavailable',
      'temporarily unavailable',
    ],
    description:
      'Generic upstream 5xx. Transient; retried with bounded backoff. 501 is ' +
      'explicitly excluded (see not_implemented).',
  },
  {
    kind: 'connection',
    action: 'retry',
    anthropicType: 'api_error',
    // Mid-stream HTTP connection drops (network blip, server restart, timeout)
    // that escape the SDK's own retry logic. Also used by the API error
    // circuit breaker as its skip-list (transient errors are not counted).
    looseTextSubstrings: [
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
    ],
    description:
      'Transport-level connection failure, not a provider verdict. Retried ' +
      '(query-runner retry-once); never counted by the circuit breaker.',
  },
  {
    kind: 'authentication',
    action: 'surface',
    anthropicType: 'authentication_error',
    httpStatuses: [401],
    looseTextSubstrings: ['unauthorized', 'invalid_api_key'],
    description:
      'Credentials rejected. Terminal — retrying cannot help; the user must ' +
      'fix the API key / token.',
  },
  {
    kind: 'permission',
    action: 'surface',
    anthropicType: 'permission_error',
    httpStatuses: [403],
    description: 'Authenticated but not allowed. Terminal.',
  },
  {
    kind: 'quota_exceeded',
    action: 'surface',
    anthropicType: 'invalid_request_error',
    httpStatuses: [402],
    // 'quota' alone covers 'no quota' / 'quota exceeded' / 'insufficient_quota'.
    looseTextSubstrings: ['quota', 'insufficient_quota'],
    description:
      'Billing / spending-limit exhaustion (402, insufficient_quota). ' +
      'Terminal — never retried, even when a retryable signal co-occurs.',
  },
  {
    kind: 'prompt_too_long',
    action: 'compact',
    anthropicType: 'invalid_request_error',
    messagePattern: PROMPT_TOO_LONG_RE,
    description:
      'Context window overflow. Never plain-retried (the request cannot ' +
      'succeed unchanged): compact first, then continue. Surfaces as an ' +
      'Anthropic 400 with token counts, a bare Kimi string, a Kimi ' +
      '`blocking_limit` terminal reason, or a `<local-command-stderr>` user ' +
      'message. See matchPromptTooLong().',
  },
  {
    kind: 'request_too_large',
    action: 'surface',
    anthropicType: 'request_too_large',
    httpStatuses: [413],
    description:
      'Single request exceeds size limits (e.g. oversized images). ' +
      'Compaction cannot shrink one request; surface so the user can reduce it.',
  },
  {
    kind: 'not_found',
    action: 'surface',
    anthropicType: 'not_found_error',
    httpStatuses: [404],
    looseTextSubstrings: ['model_not_found'],
    description: 'Unknown model or resource. Terminal.',
  },
  {
    kind: 'not_implemented',
    action: 'surface',
    // `api_error`, not `not_implemented_error`: all four bridges emit
    // `api_error` for their own 501s, and nothing emits `not_implemented_error`
    // on the wire. The entry records reality rather than introducing a type
    // no consumer would ever see.
    anthropicType: 'api_error',
    httpStatuses: [501],
    looseTextSubstrings: ['not implemented'],
    description:
      'Route / feature unsupported by the upstream (returned by HyperNeo ' +
      'bridges for unsupported endpoints). Never transient.',
  },
  {
    kind: 'invalid_request',
    action: 'surface',
    anthropicType: 'invalid_request_error',
    httpStatuses: [400],
    description:
      'Malformed or invalid request (other 4xx). Terminal — the SDK captures ' +
      'these as user messages; retrying unchanged loops forever (the circuit ' +
      'breaker trips on repeats).',
  },
  {
    kind: 'unknown',
    action: 'surface',
    anthropicType: 'api_error',
    description:
      'Unclassified error. Default to terminal/surface — auto-retry requires ' +
      'positive transient evidence.',
  },
];

// ---------------------------------------------------------------------------
// Derived signal tables (consumed by daemon normalizers / retry guards)
// ---------------------------------------------------------------------------

function looseTextSubstringsOf(
  action: ProviderErrorAction,
  excludeKinds: readonly ProviderErrorKind[] = []
): readonly string[] {
  return PROVIDER_ERROR_TAXONOMY.filter(
    (entry) => entry.action === action && !excludeKinds.includes(entry.kind)
  ).flatMap((entry) => entry.looseTextSubstrings ?? []);
}

/**
 * Descriptive (non-numeric) substrings that indicate a retryable provider
 * error in ANY surfaced error text, for the query-runner's bounded provider
 * retry. Connection failures are excluded on purpose: they have their own
 * retry-once path (TRANSIENT_CONNECTION_ERROR_SUBSTRINGS) and must not enter
 * the bounded provider-retry budget. Numeric 5xx codes are matched separately
 * via HTTP_5XX_STATUS_RE to avoid false positives on bare digit substrings
 * (e.g. "5000ms", UUID fragments). 4xx/auth/quota/model_not_found signals are
 * terminal and live in TERMINAL_PROVIDER_ERROR_TEXT instead.
 */
export const RETRYABLE_PROVIDER_ERROR_TEXT: readonly string[] = looseTextSubstringsOf('retry', [
  'connection',
]);

/**
 * Loose-text substrings that mark a terminal (never-retryable) provider error:
 * auth, quota, model-not-found, not-implemented. These guards win even when a
 * retryable signal accidentally co-occurs in the same message.
 */
export const TERMINAL_PROVIDER_ERROR_TEXT: readonly string[] = looseTextSubstringsOf('surface');

/**
 * GLM transient overload/rate-limit message substrings, trusted in
 * provider-body context. Used by the bridge body normalizer and re-exported
 * for the query-runner so it can recognise mid-stream GLM overload errors that
 * arrive as terminal in-stream SSE errors.
 */
export const GLM_TRANSIENT_BODY_SUBSTRINGS: readonly string[] = PROVIDER_ERROR_TAXONOMY.filter(
  (entry) => entry.provider === 'glm' && entry.kind === 'overloaded'
).flatMap((entry) => entry.bodySubstrings ?? []);

/** Structured codes/types that mark a transient rate-limit fault. */
export const TRANSIENT_RATE_LIMIT_CODES: ReadonlySet<string> = new Set(
  PROVIDER_ERROR_TAXONOMY.filter(
    (entry) => entry.kind === 'rate_limit' && entry.provider === undefined
  ).flatMap((entry) => entry.providerCodes ?? [])
);

/** Structured codes/types that mark a transient overload/server fault. */
export const TRANSIENT_OVERLOAD_CODES: ReadonlySet<string> = new Set(
  PROVIDER_ERROR_TAXONOMY.filter(
    (entry) => entry.kind === 'overloaded' && entry.provider === undefined
  ).flatMap((entry) => entry.providerCodes ?? [])
);

/** Generic rate-limit message regex (body/extracted-message context). */
export const RATE_LIMIT_MESSAGE_PATTERN: RegExp = PROVIDER_ERROR_TAXONOMY.find(
  (entry) => entry.kind === 'rate_limit' && entry.provider === undefined
)?.messagePattern as RegExp;

/** Generic overload/server-fault message regex (body/extracted-message context). */
export const OVERLOAD_MESSAGE_PATTERN: RegExp = PROVIDER_ERROR_TAXONOMY.find(
  (entry) => entry.kind === 'overloaded' && entry.provider === undefined
)?.messagePattern as RegExp;

/**
 * Substrings matching transient fetch/connection errors: mid-stream HTTP
 * connection drops (network blip, server restart, timeout) that should be
 * retried rather than surfaced as raw developer-facing error strings. Used by
 * the query-runner (includes-based matching, case-sensitive) for its
 * retry-once connection path.
 */
export const TRANSIENT_CONNECTION_ERROR_SUBSTRINGS: readonly string[] =
  PROVIDER_ERROR_TAXONOMY.filter((entry) => entry.kind === 'connection').flatMap(
    (entry) => entry.looseTextSubstrings ?? []
  );

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a loose-text substring into a case-insensitive regex with flexible
 * whitespace, for consumers that match with RegExp rather than includes()
 * (the API error circuit breaker's skip-list).
 */
export function looseTextSubstringToRegex(substring: string): RegExp {
  return new RegExp(escapeRegExp(substring).replace(/\s+/g, '\\s+'), 'i');
}

/**
 * Regex form of TRANSIENT_CONNECTION_ERROR_SUBSTRINGS, derived so the two can
 * never drift. Used by the circuit breaker to skip counting transient
 * connection errors.
 */
export const TRANSIENT_CONNECTION_ERROR_REGEXES: readonly RegExp[] =
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.map(looseTextSubstringToRegex);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Recommended action for a normalized error kind — the registry's answer to
 * "retry, compact, continue, or surface". Note: no runtime path classifies
 * into kinds and branches on action yet (message-level retryability goes
 * through isRetryableProviderError); this is the canonical query for future
 * kind-driven consumers such as provider adapters feeding a unified recovery
 * policy.
 */
export function actionForProviderErrorKind(kind: ProviderErrorKind): ProviderErrorAction {
  // Every kind has exactly one provider-agnostic entry; provider-specific
  // entries always repeat the same action.
  return PROVIDER_ERROR_TAXONOMY.find((entry) => entry.kind === kind)?.action ?? 'surface';
}

/**
 * Canonical HTTP status → normalized kind mapping. Provider-neutral; the
 * bridge envelope mapping (anthropicErrorTypeForHttpStatus) is derived from
 * this plus the taxonomy entries, so the two can never drift.
 */
export function providerErrorKindForHttpStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'authentication';
  if (status === 402) return 'quota_exceeded';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit';
  if (status === 501) return 'not_implemented';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

/**
 * Canonical HTTP status → Anthropic wire type for bridge error envelopes,
 * derived from providerErrorKindForHttpStatus + the taxonomy entries. Replaces
 * the per-bridge copies that drifted (403 was authentication_error in three
 * bridges and permission_error in one; 413 was missing in one). Follows the
 * real Anthropic API: 403 → permission_error, 413 → request_too_large.
 */
export function anthropicErrorTypeForHttpStatus(status: number): AnthropicErrorType {
  const kind = providerErrorKindForHttpStatus(status);
  return (
    PROVIDER_ERROR_TAXONOMY.find((entry) => entry.kind === kind && entry.provider === undefined)
      ?.anthropicType ?? 'api_error'
  );
}

/**
 * Hand-authored reverse map for symbolic error types/codes that are
 * UNAMBIGUOUS — each maps to exactly one HTTP status. A 200 JSON error may carry
 * only a symbolic classification with no numeric status (e.g.
 * `{"error":{"type":"authentication_error"}}`); resolving it here lets a bridge
 * surface the real status/type instead of defaulting to 400 invalid_request_error,
 * which would mislabel a credential/overload/rate-limit failure and count it
 * toward the fatal invalid-request circuit breaker.
 *
 * NOT derived from PROVIDER_ERROR_TAXONOMY: `api_error` and
 * `invalid_request_error` are each reused as the anthropicType across several
 * kinds, so a derived anthropicType→status map would collide. The single-intent
 * symbols are listed; `invalid_request_error` is included (→400) so a terminal
 * bad-request payload surfaces with its real type rather than the retryable
 * `api_error` default; anything unrecognized falls through to the caller's
 * default. `api_error` and `server_error` ARE included (mapped to 500) because
 * their honest classification is a retryable 5xx, never a 400 — leaving them to
 * fall through to 400 would be the exact fatal-breaker mislabel this map exists
 * to prevent.
 */
const SYMBOLIC_ERROR_TYPE_TO_STATUS: Readonly<Record<string, number>> = {
  // Anthropic wire types (each used by exactly one kind).
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  overloaded_error: 529,
  invalid_request_error: 400,
  // OpenAI / common symbolic codes with a single unambiguous intent.
  rate_limit_exceeded: 429,
  server_error: 500,
  api_error: 500,
};

/**
 * Resolve a symbolic error type/code (e.g. `authentication_error`,
 * `rate_limit_exceeded`) to its canonical HTTP status, or undefined when the
 * symbol is unrecognized (caller falls back to its default). Case-insensitive.
 */
export function httpStatusForSymbolicErrorType(type: string | undefined): number | undefined {
  if (typeof type !== 'string' || type.length === 0) return undefined;
  return SYMBOLIC_ERROR_TYPE_TO_STATUS[type.toLowerCase()];
}

/**
 * Every recognized error type/code name across the taxonomy (Anthropic wire
 * types + provider codes, lowercased), including numeric string codes some
 * gateways put in `type`/`code` (e.g. `"429"`). Used to tell a type-only flat
 * error frame (e.g. `{"type":"invalid_request_error"}`) from an unknown
 * heartbeat/metadata frame (e.g. `{"type":"ping"}`), regardless of whether the
 * type is transient or terminal. Derived from the taxonomy so it cannot drift.
 */
const RECOGNIZED_ERROR_TYPE_NAMES: ReadonlySet<string> = new Set(
  PROVIDER_ERROR_TAXONOMY.flatMap((entry) => [
    ...(entry.anthropicType !== undefined ? [entry.anthropicType] : []),
    ...(entry.providerCodes ?? []),
  ]).map((name) => name.toLowerCase())
);

/**
 * True if a string is a recognized error type/code name (transient OR
 * terminal) — OpenAI/Anthropic symbolic names plus the HTTP-status codes some
 * gateways put in `type`/`code`. Admits a flat error frame by its payload
 * `type` while still ignoring unknown heartbeat/metadata frames.
 */
export function isOpenAiErrorTypeName(type: string | undefined): boolean {
  if (typeof type !== 'string' || type.length === 0) return false;
  return RECOGNIZED_ERROR_TYPE_NAMES.has(type.toLowerCase());
}

// ---------------------------------------------------------------------------
// Prompt-too-long detection
// ---------------------------------------------------------------------------

export interface PromptTooLongMatch {
  /** Tokens the prompt would have consumed, when the provider reports it. */
  actualTokens: number | undefined;
  /** Model context-window maximum, when the provider reports it. */
  maxTokens: number | undefined;
}

/**
 * Canonical prompt-too-long matcher. Returns the token counts when the
 * provider reports the "N tokens > M maximum" form (Anthropic), or a match
 * with undefined counts for the bare form (Kimi). Null when the text is not a
 * prompt-overflow signal.
 */
export function matchPromptTooLong(text: string): PromptTooLongMatch | null {
  const match = PROMPT_TOO_LONG_RE.exec(text);
  if (!match) return null;
  return {
    actualTokens: match[1] !== undefined ? Number(match[1]) : undefined,
    maxTokens: match[2] !== undefined ? Number(match[2]) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Loose-text retryability (query-runner bounded retry)
// ---------------------------------------------------------------------------

/**
 * Detect whether a surfaced error message represents a retryable provider
 * error (5xx / overloaded / provider-unavailable). Used by the query-runner to
 * decide whether to fire a bounded retry with backoff.
 *
 * Excludes 4xx/auth/quota/model_not_found/not_implemented — those are terminal
 * and must never be retried, even if a retryable signal accidentally
 * co-occurs. Numeric status codes are matched with word boundaries so digit
 * sequences embedded in longer numbers ("5000ms timeout", "15003 tokens") do
 * not false-positive into a retry.
 */
export function isRetryableProviderError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();

  // Terminal text guards — auth/quota/model errors (non-numeric patterns).
  if (TERMINAL_PROVIDER_ERROR_TEXT.some((substr) => lower.includes(substr))) {
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
