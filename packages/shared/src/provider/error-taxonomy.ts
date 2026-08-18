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

export type ProviderErrorAction = 'retry' | 'compact' | 'continue' | 'surface';

export interface ProviderErrorTaxonomyEntry {
  kind: ProviderErrorKind;
  action: ProviderErrorAction;
  anthropicType: AnthropicErrorType;
  provider?: string;
  httpStatuses?: readonly number[];
  providerCodes?: readonly string[];
  bodySubstrings?: readonly string[];
  looseTextSubstrings?: readonly string[];
  messagePattern?: RegExp;
  description: string;
}

export const HTTP_5XX_STATUS_RE = /\b5\d{2}\b/;

export const HTTP_4XX_STATUS_RE = /\b4\d{2}\b/;

export const PROMPT_TOO_LONG_RE =
  /prompt is too long(?::\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum)?/i;

export const GLM_RATE_LIMIT_CODE = '1305';

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
    bodySubstrings: ['访问量过大', '稍后再试'],
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

function looseTextSubstringsOf(
  action: ProviderErrorAction,
  excludeKinds: readonly ProviderErrorKind[] = []
): readonly string[] {
  return PROVIDER_ERROR_TAXONOMY.filter(
    (entry) => entry.action === action && !excludeKinds.includes(entry.kind)
  ).flatMap((entry) => entry.looseTextSubstrings ?? []);
}

export const RETRYABLE_PROVIDER_ERROR_TEXT: readonly string[] = looseTextSubstringsOf('retry', [
  'connection',
]);

export const TERMINAL_PROVIDER_ERROR_TEXT: readonly string[] = looseTextSubstringsOf('surface');

export const GLM_TRANSIENT_BODY_SUBSTRINGS: readonly string[] = PROVIDER_ERROR_TAXONOMY.filter(
  (entry) => entry.provider === 'glm' && entry.kind === 'overloaded'
).flatMap((entry) => entry.bodySubstrings ?? []);

export const TRANSIENT_RATE_LIMIT_CODES: ReadonlySet<string> = new Set(
  PROVIDER_ERROR_TAXONOMY.filter(
    (entry) => entry.kind === 'rate_limit' && entry.provider === undefined
  ).flatMap((entry) => entry.providerCodes ?? [])
);

export const TRANSIENT_OVERLOAD_CODES: ReadonlySet<string> = new Set(
  PROVIDER_ERROR_TAXONOMY.filter(
    (entry) => entry.kind === 'overloaded' && entry.provider === undefined
  ).flatMap((entry) => entry.providerCodes ?? [])
);

export const RATE_LIMIT_MESSAGE_PATTERN: RegExp = PROVIDER_ERROR_TAXONOMY.find(
  (entry) => entry.kind === 'rate_limit' && entry.provider === undefined
)?.messagePattern as RegExp;

export const OVERLOAD_MESSAGE_PATTERN: RegExp = PROVIDER_ERROR_TAXONOMY.find(
  (entry) => entry.kind === 'overloaded' && entry.provider === undefined
)?.messagePattern as RegExp;

export const TRANSIENT_CONNECTION_ERROR_SUBSTRINGS: readonly string[] =
  PROVIDER_ERROR_TAXONOMY.filter((entry) => entry.kind === 'connection').flatMap(
    (entry) => entry.looseTextSubstrings ?? []
  );

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function looseTextSubstringToRegex(substring: string): RegExp {
  return new RegExp(escapeRegExp(substring).replace(/\s+/g, '\\s+'), 'i');
}

export const TRANSIENT_CONNECTION_ERROR_REGEXES: readonly RegExp[] =
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.map(looseTextSubstringToRegex);

export function actionForProviderErrorKind(kind: ProviderErrorKind): ProviderErrorAction {
  return PROVIDER_ERROR_TAXONOMY.find((entry) => entry.kind === kind)?.action ?? 'surface';
}

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

export function anthropicErrorTypeForHttpStatus(status: number): AnthropicErrorType {
  const kind = providerErrorKindForHttpStatus(status);
  return (
    PROVIDER_ERROR_TAXONOMY.find((entry) => entry.kind === kind && entry.provider === undefined)
      ?.anthropicType ?? 'api_error'
  );
}

const SYMBOLIC_ERROR_TYPE_TO_STATUS: Readonly<Record<string, number>> = {
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  overloaded_error: 529,
  invalid_request_error: 400,
  rate_limit_exceeded: 429,
  server_error: 500,
  api_error: 500,
};

export function httpStatusForSymbolicErrorType(type: string | undefined): number | undefined {
  if (typeof type !== 'string' || type.length === 0) return undefined;
  return SYMBOLIC_ERROR_TYPE_TO_STATUS[type.toLowerCase()];
}

const RECOGNIZED_ERROR_TYPE_NAMES: ReadonlySet<string> = new Set(
  PROVIDER_ERROR_TAXONOMY.flatMap((entry) => [
    ...(entry.anthropicType !== undefined ? [entry.anthropicType] : []),
    ...(entry.providerCodes ?? []),
  ]).map((name) => name.toLowerCase())
);

export function isOpenAiErrorTypeName(type: string | undefined): boolean {
  if (typeof type !== 'string' || type.length === 0) return false;
  return RECOGNIZED_ERROR_TYPE_NAMES.has(type.toLowerCase());
}

const TERMINAL_PROVIDER_CODE_NAMES: ReadonlySet<string> = new Set(
  TERMINAL_PROVIDER_ERROR_TEXT.map((s) => s.toLowerCase())
);

export function isProviderErrorCodeOrType(value: unknown): boolean {
  if (typeof value === 'string') {
    if (value.length === 0) return false;
    const v = value.toLowerCase();
    if (RECOGNIZED_ERROR_TYPE_NAMES.has(v)) return true;
    if (TERMINAL_PROVIDER_CODE_NAMES.has(v)) return true;
    if (HTTP_4XX_STATUS_RE.test(value) || HTTP_5XX_STATUS_RE.test(value)) return true;
    return false;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 400 && value < 600;
  }
  return false;
}

export interface PromptTooLongMatch {
  actualTokens: number | undefined;
  maxTokens: number | undefined;
}

export function matchPromptTooLong(text: string): PromptTooLongMatch | null {
  const match = PROMPT_TOO_LONG_RE.exec(text);
  if (!match) return null;
  return {
    actualTokens: match[1] !== undefined ? Number(match[1]) : undefined,
    maxTokens: match[2] !== undefined ? Number(match[2]) : undefined,
  };
}

export function isRetryableProviderError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();

  if (TERMINAL_PROVIDER_ERROR_TEXT.some((substr) => lower.includes(substr))) {
    return false;
  }

  if (HTTP_4XX_STATUS_RE.test(errorMessage)) {
    return false;
  }

  if (/\b501\b/.test(errorMessage)) {
    return false;
  }

  if (HTTP_5XX_STATUS_RE.test(errorMessage)) {
    return true;
  }

  return RETRYABLE_PROVIDER_ERROR_TEXT.some((substr) => lower.includes(substr));
}
