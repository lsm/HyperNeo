import { describe, expect, test } from 'bun:test';
import {
  GLM_RATE_LIMIT_CODE,
  GLM_TRANSIENT_BODY_SUBSTRINGS,
  HTTP_4XX_STATUS_RE,
  HTTP_5XX_STATUS_RE,
  OVERLOAD_MESSAGE_PATTERN,
  PROMPT_TOO_LONG_RE,
  PROVIDER_ERROR_TAXONOMY,
  RATE_LIMIT_MESSAGE_PATTERN,
  RETRYABLE_PROVIDER_ERROR_TEXT,
  TERMINAL_PROVIDER_ERROR_TEXT,
  TRANSIENT_CONNECTION_ERROR_REGEXES,
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
  TRANSIENT_OVERLOAD_CODES,
  TRANSIENT_RATE_LIMIT_CODES,
  actionForProviderErrorKind,
  anthropicErrorTypeForHttpStatus,
  httpStatusForSymbolicErrorType,
  isOpenAiErrorTypeName,
  isProviderErrorCodeOrType,
  isRetryableProviderError,
  matchPromptTooLong,
  providerErrorKindForHttpStatus,
} from '../src/provider/error-taxonomy.ts';
import type { AnthropicErrorType, ProviderErrorKind } from '../src/provider/error-taxonomy.ts';

describe('PROVIDER_ERROR_TAXONOMY integrity', () => {
  test('every entry has a description and a valid action', () => {
    for (const entry of PROVIDER_ERROR_TAXONOMY) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(['retry', 'compact', 'continue', 'surface']).toContain(entry.action);
    }
  });

  test('provider-agnostic kinds are unique', () => {
    const generic = PROVIDER_ERROR_TAXONOMY.filter((e) => e.provider === undefined).map(
      (e) => e.kind
    );
    expect(new Set(generic).size).toBe(generic.length);
  });

  test('actionForProviderErrorKind agrees with the entries', () => {
    for (const entry of PROVIDER_ERROR_TAXONOMY) {
      expect(actionForProviderErrorKind(entry.kind)).toBe(entry.action);
    }
  });

  test('retryable kinds are exactly rate_limit/overloaded/server_error/connection', () => {
    const expected: Record<ProviderErrorKind, boolean> = {
      rate_limit: true,
      overloaded: true,
      server_error: true,
      connection: true,
      authentication: false,
      permission: false,
      quota_exceeded: false,
      prompt_too_long: false,
      request_too_large: false,
      not_found: false,
      not_implemented: false,
      invalid_request: false,
      unknown: false,
    };
    for (const [kind, retryable] of Object.entries(expected)) {
      expect(actionForProviderErrorKind(kind as ProviderErrorKind) === 'retry').toBe(retryable);
    }
  });

  test('every entry httpStatus maps back to the entry anthropicType (drift guard)', () => {
    for (const entry of PROVIDER_ERROR_TAXONOMY) {
      for (const status of entry.httpStatuses ?? []) {
        expect(anthropicErrorTypeForHttpStatus(status)).toBe(entry.anthropicType);
        expect(providerErrorKindForHttpStatus(status)).toBe(entry.kind);
      }
    }
  });

  test('prompt_too_long is the only compact-action kind', () => {
    const compact = PROVIDER_ERROR_TAXONOMY.filter((e) => e.action === 'compact').map(
      (e) => e.kind
    );
    expect(compact).toEqual(['prompt_too_long']);
  });
});

describe('anthropicErrorTypeForHttpStatus', () => {
  const cases: Array<[number, AnthropicErrorType]> = [
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [402, 'invalid_request_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [408, 'invalid_request_error'],
    [413, 'request_too_large'],
    [422, 'invalid_request_error'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [501, 'api_error'],
    [502, 'api_error'],
    [503, 'api_error'],
    [529, 'overloaded_error'],
  ];
  for (const [status, expected] of cases) {
    test(`${status} → ${expected}`, () => {
      expect(anthropicErrorTypeForHttpStatus(status)).toBe(expected);
    });
  }
});

describe('httpStatusForSymbolicErrorType', () => {
  const cases: Array<[string, number]> = [
    ['authentication_error', 401],
    ['AUTHENTICATION_ERROR', 401],
    ['permission_error', 403],
    ['not_found_error', 404],
    ['request_too_large', 413],
    ['rate_limit_error', 429],
    ['rate_limit_exceeded', 429],
    ['overloaded_error', 529],
    ['server_error', 500],
    ['api_error', 500],
  ];
  for (const [symbol, expected] of cases) {
    test(`${symbol} → ${expected}`, () => {
      expect(httpStatusForSymbolicErrorType(symbol)).toBe(expected);
      expect(anthropicErrorTypeForHttpStatus(expected)).not.toBe('invalid_request_error');
    });
  }
  test('invalid_request_error resolves to 400 (its real type, not the retryable default)', () => {
    expect(httpStatusForSymbolicErrorType('invalid_request_error')).toBe(400);
    expect(anthropicErrorTypeForHttpStatus(400)).toBe('invalid_request_error');
  });
  test('returns undefined for unrecognized / empty / non-string symbols', () => {
    expect(httpStatusForSymbolicErrorType('not_a_real_type')).toBeUndefined();
    expect(httpStatusForSymbolicErrorType('')).toBeUndefined();
    expect(httpStatusForSymbolicErrorType(undefined)).toBeUndefined();
  });
});

describe('isOpenAiErrorTypeName', () => {
  test('admits recognized transient and terminal error type names', () => {
    expect(isOpenAiErrorTypeName('server_error')).toBe(true);
    expect(isOpenAiErrorTypeName('rate_limit_exceeded')).toBe(true);
    expect(isOpenAiErrorTypeName('overloaded_error')).toBe(true);
    expect(isOpenAiErrorTypeName('invalid_request_error')).toBe(true);
    expect(isOpenAiErrorTypeName('authentication_error')).toBe(true);
    expect(isOpenAiErrorTypeName('not_found_error')).toBe(true);
    expect(isOpenAiErrorTypeName('429')).toBe(true);
    expect(isOpenAiErrorTypeName('INVALID_REQUEST_ERROR')).toBe(true);
  });
  test('rejects non-error frame types (heartbeat/metadata/event discriminators)', () => {
    expect(isOpenAiErrorTypeName('ping')).toBe(false);
    expect(isOpenAiErrorTypeName('response.completed')).toBe(false);
    expect(isOpenAiErrorTypeName('response.output_text.delta')).toBe(false);
    expect(isOpenAiErrorTypeName('')).toBe(false);
    expect(isOpenAiErrorTypeName(undefined)).toBe(false);
  });
});

describe('isProviderErrorCodeOrType', () => {
  test('admits symbolic names, terminal provider codes, and numeric statuses', () => {
    expect(isProviderErrorCodeOrType('invalid_request_error')).toBe(true);
    expect(isProviderErrorCodeOrType('authentication_error')).toBe(true);
    expect(isProviderErrorCodeOrType('server_error')).toBe(true);
    expect(isProviderErrorCodeOrType('model_not_found')).toBe(true);
    expect(isProviderErrorCodeOrType('insufficient_quota')).toBe(true);
    expect(isProviderErrorCodeOrType(401)).toBe(true);
    expect(isProviderErrorCodeOrType('429')).toBe(true);
    expect(isProviderErrorCodeOrType(503)).toBe(true);
    expect(isProviderErrorCodeOrType('502')).toBe(true);
    expect(isProviderErrorCodeOrType('AUTHENTICATION_ERROR')).toBe(true);
  });
  test('rejects non-error values and out-of-range / embedded numbers', () => {
    expect(isProviderErrorCodeOrType('ping')).toBe(false);
    expect(isProviderErrorCodeOrType('completed')).toBe(false);
    expect(isProviderErrorCodeOrType('incomplete')).toBe(false);
    expect(isProviderErrorCodeOrType(200)).toBe(false);
    expect(isProviderErrorCodeOrType(302)).toBe(false);
    expect(isProviderErrorCodeOrType('4010')).toBe(false);
    expect(isProviderErrorCodeOrType('')).toBe(false);
    expect(isProviderErrorCodeOrType(undefined)).toBe(false);
    expect(isProviderErrorCodeOrType(null)).toBe(false);
  });
});

describe('providerErrorKindForHttpStatus', () => {
  const cases: Array<[number, ProviderErrorKind]> = [
    [200, 'unknown'],
    [400, 'invalid_request'],
    [401, 'authentication'],
    [402, 'quota_exceeded'],
    [403, 'permission'],
    [404, 'not_found'],
    [413, 'request_too_large'],
    [429, 'rate_limit'],
    [500, 'server_error'],
    [501, 'not_implemented'],
    [503, 'server_error'],
    [529, 'overloaded'],
  ];
  for (const [status, expected] of cases) {
    test(`${status} → ${expected}`, () => {
      expect(providerErrorKindForHttpStatus(status)).toBe(expected);
    });
  }
});

describe('matchPromptTooLong', () => {
  test('Anthropic token-count form captures both counts', () => {
    const match = matchPromptTooLong('prompt is too long: 200000 tokens > 128000 maximum');
    expect(match).toEqual({ actualTokens: 200000, maxTokens: 128000 });
  });

  test('singular "token" form is accepted', () => {
    const match = matchPromptTooLong('Prompt is too long: 130001 token > 130000 maximum');
    expect(match).toEqual({ actualTokens: 130001, maxTokens: 130000 });
  });

  test('bare Kimi form matches without counts', () => {
    const match = matchPromptTooLong('Prompt is too long');
    expect(match).toEqual({ actualTokens: undefined, maxTokens: undefined });
  });

  test('matches case-insensitively inside a larger message', () => {
    expect(matchPromptTooLong('API Error: 400 PROMPT IS TOO LONG: 5 tokens > 4 maximum')).toEqual({
      actualTokens: 5,
      maxTokens: 4,
    });
  });

  test('returns null for non-overflow text', () => {
    expect(matchPromptTooLong('rate limit exceeded')).toBeNull();
    expect(matchPromptTooLong('prompt is fine')).toBeNull();
    expect(matchPromptTooLong('')).toBeNull();
  });

  test('PROMPT_TOO_LONG_RE stays match-equivalent to the lenient phrase', () => {
    for (const text of ['prompt is too long', 'Prompt is too long', 'x PROMPT IS TOO LONG y']) {
      expect(PROMPT_TOO_LONG_RE.test(text)).toBe(true);
    }
  });
});

describe('GLM signals', () => {
  test('rate-limit code 1305 is registered for glm', () => {
    expect(GLM_RATE_LIMIT_CODE).toBe('1305');
    const glmEntry = PROVIDER_ERROR_TAXONOMY.find(
      (e) => e.provider === 'glm' && e.kind === 'rate_limit'
    );
    expect(glmEntry?.providerCodes).toContain('1305');
  });

  test('bracketed [1305] is the loose-text form (bare number is not)', () => {
    expect(RETRYABLE_PROVIDER_ERROR_TEXT).toContain('[1305]');
    expect(RETRYABLE_PROVIDER_ERROR_TEXT).not.toContain('1305');
  });

  test('localized overload strings are body-context, generic retry advice is body-only', () => {
    expect(GLM_TRANSIENT_BODY_SUBSTRINGS).toContain('访问量过大');
    expect(GLM_TRANSIENT_BODY_SUBSTRINGS).toContain('稍后再试');
    expect(RETRYABLE_PROVIDER_ERROR_TEXT).toContain('访问量过大');
    expect(RETRYABLE_PROVIDER_ERROR_TEXT).not.toContain('稍后再试');
  });
});

describe('derived loose-text tables', () => {
  test('RETRYABLE_PROVIDER_ERROR_TEXT has no bare numeric codes or terminal terms', () => {
    const joined = RETRYABLE_PROVIDER_ERROR_TEXT.join(' ').toLowerCase();
    for (const bad of ['500', '502', '503', '529', 'unauthorized', 'model_not_found', 'quota']) {
      expect(joined).not.toContain(bad);
    }
  });

  test('RETRYABLE_PROVIDER_ERROR_TEXT excludes connection patterns (separate retry path)', () => {
    for (const conn of TRANSIENT_CONNECTION_ERROR_SUBSTRINGS) {
      expect(RETRYABLE_PROVIDER_ERROR_TEXT).not.toContain(conn);
    }
  });

  test('TERMINAL_PROVIDER_ERROR_TEXT carries the auth/quota/model guards', () => {
    for (const guard of [
      'unauthorized',
      'invalid_api_key',
      'quota',
      'insufficient_quota',
      'model_not_found',
      'not implemented',
    ]) {
      expect(TERMINAL_PROVIDER_ERROR_TEXT).toContain(guard);
    }
  });

  test('connection substring and regex tables stay in sync', () => {
    expect(TRANSIENT_CONNECTION_ERROR_REGEXES.length).toBe(
      TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.length
    );
    for (let i = 0; i < TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.length; i++) {
      expect(
        TRANSIENT_CONNECTION_ERROR_REGEXES[i]!.test(TRANSIENT_CONNECTION_ERROR_SUBSTRINGS[i]!)
      ).toBe(true);
    }
  });

  test('transient code sets back the body/mid-stream normalizers', () => {
    for (const code of ['rate_limit_exceeded', 'rate_limit_error', '429']) {
      expect(TRANSIENT_RATE_LIMIT_CODES.has(code)).toBe(true);
    }
    for (const code of ['server_error', 'overloaded_error', '500', '502', '503', '504', '529']) {
      expect(TRANSIENT_OVERLOAD_CODES.has(code)).toBe(true);
    }
    expect(TRANSIENT_RATE_LIMIT_CODES.has('1305')).toBe(false);
  });

  test('message patterns classify body-embedded error text', () => {
    expect(RATE_LIMIT_MESSAGE_PATTERN.test('Rate limit exceeded, slow down')).toBe(true);
    expect(OVERLOAD_MESSAGE_PATTERN.test('the model is overloaded')).toBe(true);
    expect(OVERLOAD_MESSAGE_PATTERN.test('503 Service Unavailable')).toBe(true);
  });
});

describe('isRetryableProviderError', () => {
  const retryable = [
    '529 {"type":"error","error":{"type":"overloaded_error"}}',
    'Error: 529 Overloaded',
    'overloaded',
    '503 Service Unavailable',
    '500 Internal Server Error',
    'internal server error',
    'bad gateway',
    'gateway timeout',
    'temporarily unavailable',
    'API Error: 500 {"error":{"type":"api_error"}}',
    '[1305][该模型当前访问量过大，请您稍后再试]',
    '[1305]',
    '访问量过大',
    '当前访问量过大',
  ];
  for (const msg of retryable) {
    test(`retryable: ${msg}`, () => {
      expect(isRetryableProviderError(msg)).toBe(true);
    });
  }

  const terminal = [
    '401 Unauthorized',
    '403 Forbidden',
    'unauthorized',
    'invalid_api_key',
    'model_not_found: bad-model',
    '402 {"error":{"message":"insufficient_quota"}}',
    'quota exceeded',
    'insufficient_quota',
    '400 Bad Request',
    '429 Too Many Requests',
    '501 Not Implemented',
    'not implemented',
    'Some generic error with no status code',
    'prompt is too long: 1305 tokens > 1000 maximum',
    'request id: req_1305abc',
    'ECONNREFUSED 127.0.0.1:1305',
    '参数错误，请稍后再试',
    '请稍后再试',
    'Request timed out after 5000ms',
    'EADDRINUSE: port 5500 already in use',
    'prompt too long: 15003 tokens',
    '',
  ];
  for (const msg of terminal) {
    test(`terminal: ${JSON.stringify(msg)}`, () => {
      expect(isRetryableProviderError(msg)).toBe(false);
    });
  }

  test('terminal guard wins over a co-occurring retryable signal', () => {
    expect(isRetryableProviderError('500 error: invalid_api_key')).toBe(false);
    expect(isRetryableProviderError('401 overloaded after retry')).toBe(false);
    expect(isRetryableProviderError('503 due to quota limits')).toBe(false);
  });
});

describe('HTTP status regexes', () => {
  test('HTTP_5XX_STATUS_RE matches standalone 5xx only', () => {
    expect(HTTP_5XX_STATUS_RE.test('529 Overloaded')).toBe(true);
    expect(HTTP_5XX_STATUS_RE.test('5000ms timeout')).toBe(false);
    expect(HTTP_5XX_STATUS_RE.test('port 5500')).toBe(false);
    expect(HTTP_5XX_STATUS_RE.test('401 Unauthorized')).toBe(false);
  });

  test('HTTP_4XX_STATUS_RE matches standalone 4xx only', () => {
    expect(HTTP_4XX_STATUS_RE.test('429 Too Many Requests')).toBe(true);
    expect(HTTP_4XX_STATUS_RE.test('4010 tokens used')).toBe(false);
    expect(HTTP_4XX_STATUS_RE.test('request id: 14029')).toBe(false);
  });
});
