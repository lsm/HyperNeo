import { describe, it, expect } from 'bun:test';
import {
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
  TRANSIENT_CONNECTION_ERROR_REGEXES,
  RETRYABLE_PROVIDER_ERROR_TEXT,
  HTTP_5XX_STATUS_RE,
  HTTP_4XX_STATUS_RE,
  isRetryableProviderError,
} from '../../../../src/lib/agent/transient-error-patterns';

describe('TRANSIENT_CONNECTION_ERROR_SUBSTRINGS / REGEXES', () => {
  it('keeps substring and regex arrays in sync (same count)', () => {
    expect(TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.length).toBe(
      TRANSIENT_CONNECTION_ERROR_REGEXES.length
    );
  });
});

describe('RETRYABLE_PROVIDER_ERROR_TEXT', () => {
  it('does not include bare numeric status codes (handled by regex)', () => {
    const joined = RETRYABLE_PROVIDER_ERROR_TEXT.join(' ');
    expect(joined).not.toContain('500');
    expect(joined).not.toContain('502');
    expect(joined).not.toContain('503');
    expect(joined).not.toContain('529');
  });

  it('does not include 4xx/auth/quota/model patterns', () => {
    const joined = RETRYABLE_PROVIDER_ERROR_TEXT.join(' ').toLowerCase();
    expect(joined).not.toContain('unauthorized');
    expect(joined).not.toContain('model_not_found');
    expect(joined).not.toContain('quota');
  });

  it('includes descriptive provider-unavailable signals', () => {
    const joined = RETRYABLE_PROVIDER_ERROR_TEXT.join(' ').toLowerCase();
    expect(joined).toContain('overloaded');
    expect(joined).toContain('service unavailable');
    expect(joined).toContain('gateway timeout');
  });
});

describe('HTTP status code regexes', () => {
  describe('HTTP_5XX_STATUS_RE', () => {
    it('matches standalone 5xx codes', () => {
      expect(HTTP_5XX_STATUS_RE.test('500 Internal Server Error')).toBe(true);
      expect(HTTP_5XX_STATUS_RE.test('502 Bad Gateway')).toBe(true);
      expect(HTTP_5XX_STATUS_RE.test('503 Service Unavailable')).toBe(true);
      expect(HTTP_5XX_STATUS_RE.test('504 Gateway Timeout')).toBe(true);
      expect(HTTP_5XX_STATUS_RE.test('529 Overloaded')).toBe(true);
      expect(HTTP_5XX_STATUS_RE.test('API Error: 500 {...}')).toBe(true);
    });

    it('does NOT match longer digit sequences (word-boundary guard)', () => {
      expect(HTTP_5XX_STATUS_RE.test('5000ms timeout')).toBe(false);
      expect(HTTP_5XX_STATUS_RE.test('token count: 15003')).toBe(false);
      expect(HTTP_5XX_STATUS_RE.test('port 5500 is in use')).toBe(false);
    });

    it('does NOT match 4xx codes', () => {
      expect(HTTP_5XX_STATUS_RE.test('401 Unauthorized')).toBe(false);
      expect(HTTP_5XX_STATUS_RE.test('429 Too Many Requests')).toBe(false);
    });
  });

  describe('HTTP_4XX_STATUS_RE', () => {
    it('matches standalone 4xx codes', () => {
      expect(HTTP_4XX_STATUS_RE.test('401 Unauthorized')).toBe(true);
      expect(HTTP_4XX_STATUS_RE.test('402 Payment Required')).toBe(true);
      expect(HTTP_4XX_STATUS_RE.test('403 Forbidden')).toBe(true);
      expect(HTTP_4XX_STATUS_RE.test('429 Too Many Requests')).toBe(true);
    });

    it('does NOT match longer digit sequences (word-boundary guard)', () => {
      expect(HTTP_4XX_STATUS_RE.test('4010 tokens used')).toBe(false);
      expect(HTTP_4XX_STATUS_RE.test('request id: 14029')).toBe(false);
    });
  });
});

describe('isRetryableProviderError', () => {
  describe('retryable (returns true)', () => {
    const retryable = [
      '529 {"type":"error","error":{"type":"overloaded_error"}}',
      'Error: 529 Overloaded',
      'overloaded',
      '503 Service Unavailable',
      'service unavailable',
      '500 Internal Server Error',
      'internal server error',
      '502 Bad Gateway',
      'bad gateway',
      '504 Gateway Timeout',
      'gateway timeout',
      'temporarily unavailable',
      'API Error: 500 {"error":{"type":"api_error"}}',
    ];

    for (const msg of retryable) {
      it(`returns true for: ${msg}`, () => {
        expect(isRetryableProviderError(msg)).toBe(true);
      });
    }
  });

  describe('terminal (returns false)', () => {
    const terminal = [
      '401 Unauthorized',
      '403 Forbidden',
      'unauthorized',
      'invalid_api_key',
      'model_not_found: bad-model',
      '402 {"error":{"message":"insufficient_quota"}}',
      'quota exceeded',
      'no quota',
      'insufficient_quota',
      '400 Bad Request',
      '429 Too Many Requests',
      '501 Not Implemented',
      '501 {"type":"error","error":{"type":"api_error","message":"Not implemented"}}',
      'not implemented',
      'Some generic error with no status code',
      'Exit code: 1',
      '',
    ];

    for (const msg of terminal) {
      it(`returns false for: ${msg}`, () => {
        expect(isRetryableProviderError(msg)).toBe(false);
      });
    }
  });

  describe('bounded numeric matching (no false positives)', () => {
    it('returns false for a timeout error containing "5000ms" (not 500)', () => {
      expect(isRetryableProviderError('Request timed out after 5000ms')).toBe(false);
    });

    it('returns false for a message containing "5500" in a port number', () => {
      expect(isRetryableProviderError('EADDRINUSE: port 5500 already in use')).toBe(false);
    });

    it('returns false for a token count containing "500" as substring of larger number', () => {
      expect(isRetryableProviderError('prompt too long: 15003 tokens')).toBe(false);
    });

    it('returns false for an auth error with "4010" (not 401)', () => {
      expect(isRetryableProviderError('rate window: 4010 requests')).toBe(false);
    });
  });

  describe('auth guard wins over retryable signal', () => {
    it('returns false when a 5xx signal co-occurs with invalid_api_key', () => {
      expect(isRetryableProviderError('500 error: invalid_api_key')).toBe(false);
    });

    it('returns false when "overloaded" co-occurs with 401', () => {
      expect(isRetryableProviderError('401 overloaded after retry')).toBe(false);
    });

    it('returns false when 503 co-occurs with quota', () => {
      expect(isRetryableProviderError('503 due to quota limits')).toBe(false);
    });
  });

  describe('case-insensitivity', () => {
    it('matches "Overloaded" with capital O', () => {
      expect(isRetryableProviderError('Error: Overloaded')).toBe(true);
    });

    it('matches "INTERNAL SERVER ERROR" uppercased', () => {
      expect(isRetryableProviderError('INTERNAL SERVER ERROR')).toBe(true);
    });

    it('excludes "UNAUTHORIZED" uppercased', () => {
      expect(isRetryableProviderError('UNAUTHORIZED')).toBe(false);
    });
  });

  describe('GLM (Zhipu) multi-language provider overload', () => {
    it('classifies the full GLM 1305 payload as retryable', () => {
      expect(isRetryableProviderError('[1305][该模型当前访问量过大，请您稍后再试]')).toBe(true);
    });

    const glmSignals = ['[1305]', '访问量过大', '当前访问量过大'];
    for (const signal of glmSignals) {
      it(`classifies GLM signal "${signal}" as retryable`, () => {
        expect(isRetryableProviderError(signal)).toBe(true);
      });
    }

    const glmFalsePositives = [
      'prompt is too long: 1305 tokens > 1000 maximum',
      'request id: req_1305abc',
      'ECONNREFUSED 127.0.0.1:1305',
      '参数错误，请稍后再试',
      '请稍后再试',
    ];
    for (const msg of glmFalsePositives) {
      it(`does NOT classify as retryable: ${msg}`, () => {
        expect(isRetryableProviderError(msg)).toBe(false);
      });
    }
  });
});
