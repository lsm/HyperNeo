import { describe, expect, it } from 'bun:test';
import {
  GLM_TRANSIENT_ERROR_SUBSTRINGS,
  normalizeGlmUpstreamError,
  normalizeOpenAiUpstreamError,
  normalizeUpstreamError,
} from '../../../../../src/lib/providers/shared/normalize-upstream-error';

describe('normalizeGlmUpstreamError', () => {
  describe('detects GLM transient overload signals', () => {
    it('maps error code 1305 to rate_limit_error', () => {
      const body = JSON.stringify({
        error: { code: '1305', message: '当前分组上游负载过高，触发限流' },
      });
      const result = normalizeGlmUpstreamError(body, 200);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('rate_limit_error');
      expect(result?.status).toBe(429);
      expect(result?.message).toContain('触发限流');
    });

    it('maps numeric error code 1305 to rate_limit_error', () => {
      const body = JSON.stringify({
        error: { code: 1305, message: 'QPS exceeded' },
      });
      const result = normalizeGlmUpstreamError(body, 200);
      expect(result?.type).toBe('rate_limit_error');
      expect(result?.status).toBe(429);
    });

    it('maps flat-shape code 1305 to rate_limit_error', () => {
      const body = JSON.stringify({ code: '1305', message: 'rate limited' });
      const result = normalizeGlmUpstreamError(body, 400);
      expect(result?.type).toBe('rate_limit_error');
      expect(result?.status).toBe(429);
    });

    it('maps 访问量过大 to overloaded_error', () => {
      const body = JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: '访问量过大，请稍后再试' },
      });
      const result = normalizeGlmUpstreamError(body, 200);
      expect(result?.type).toBe('overloaded_error');
      expect(result?.status).toBe(529);
      expect(result?.message).toContain('访问量过大');
    });

    it('maps 稍后再试 substring to overloaded_error even in non-JSON body', () => {
      const body = '服务繁忙，请稍后再试 (service busy)';
      const result = normalizeGlmUpstreamError(body, 200);
      expect(result?.type).toBe('overloaded_error');
      expect(result?.status).toBe(529);
    });

    it('detects 访问量过大 via raw-body substring fallback', () => {
      // Body where the GLM message is embedded but JSON.parse fails / is nested.
      const body = 'upstream said: 访问量过大 oh no';
      const result = normalizeGlmUpstreamError(body, 500);
      expect(result?.type).toBe('overloaded_error');
    });

    it('prefers rate_limit_error when code 1305 accompanies overload text', () => {
      const body = JSON.stringify({
        error: { code: '1305', message: '访问量过大，请稍后再试' },
      });
      const result = normalizeGlmUpstreamError(body, 200);
      expect(result?.type).toBe('rate_limit_error');
      expect(result?.status).toBe(429);
    });
  });

  describe('returns null for non-transient bodies', () => {
    it('ignores a normal invalid_request error', () => {
      const body = JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'missing field model' },
      });
      expect(normalizeGlmUpstreamError(body, 400)).toBeNull();
    });

    it('ignores an unrelated GLM error code', () => {
      const body = JSON.stringify({
        error: { code: '1301', message: 'invalid parameter' },
      });
      expect(normalizeGlmUpstreamError(body, 400)).toBeNull();
    });

    it('ignores empty body', () => {
      expect(normalizeGlmUpstreamError('', 500)).toBeNull();
    });

    it('ignores a normal Anthropic-shaped success-ish body', () => {
      const body = JSON.stringify({ type: 'message', id: 'msg_1' });
      expect(normalizeGlmUpstreamError(body, 200)).toBeNull();
    });
  });

  it('exposes GLM transient substrings for query-runner (B4) coordination', () => {
    expect(GLM_TRANSIENT_ERROR_SUBSTRINGS).toContain('访问量过大');
    expect(GLM_TRANSIENT_ERROR_SUBSTRINGS).toContain('稍后再试');
  });
});

describe('normalizeOpenAiUpstreamError', () => {
  it('maps rate_limit_exceeded type to rate_limit_error', () => {
    const body = JSON.stringify({
      error: { type: 'rate_limit_exceeded', message: 'You hit the limit' },
    });
    const result = normalizeOpenAiUpstreamError(body, 429);
    expect(result?.type).toBe('rate_limit_error');
    expect(result?.status).toBe(429);
  });

  it('maps server_error type to overloaded_error', () => {
    const body = JSON.stringify({
      error: { type: 'server_error', message: 'Internal error' },
    });
    const result = normalizeOpenAiUpstreamError(body, 500);
    expect(result?.type).toBe('overloaded_error');
    expect(result?.status).toBe(529);
  });

  it('maps overload text in a 200-with-body to overloaded_error', () => {
    const body = JSON.stringify({
      error: { message: 'The engine is currently overloaded, try again later' },
    });
    const result = normalizeOpenAiUpstreamError(body, 200);
    expect(result?.type).toBe('overloaded_error');
    expect(result?.status).toBe(529);
  });

  it('maps rate-limit message text to rate_limit_error', () => {
    const body = JSON.stringify({
      error: { message: 'Too Many Requests: rate limit reached' },
    });
    const result = normalizeOpenAiUpstreamError(body, 200);
    expect(result?.type).toBe('rate_limit_error');
    expect(result?.status).toBe(429);
  });

  it('does NOT reclassify a hard 4xx on weak message evidence', () => {
    // A 401 whose message happens to mention "rate limit" must stay
    // non-retryable — only a structured signal overrides a hard 4xx.
    const body = JSON.stringify({
      error: { type: 'invalid_request_error', message: 'rate limit header missing' },
    });
    expect(normalizeOpenAiUpstreamError(body, 401)).toBeNull();
  });

  it('reclassifies a hard 4xx when the structured type is rate_limit_exceeded', () => {
    const body = JSON.stringify({
      error: { type: 'rate_limit_exceeded', message: 'quota hit' },
    });
    const result = normalizeOpenAiUpstreamError(body, 400);
    expect(result?.type).toBe('rate_limit_error');
    expect(result?.status).toBe(429);
  });

  it('inspects error.code even when error.type is a non-transient category', () => {
    // OpenAI-compatible payloads can set type to a broad category while the
    // transient value lives in code. A `type ?? code` short-circuit would miss it.
    const body = JSON.stringify({
      error: { type: 'requests', code: 'rate_limit_exceeded', message: 'slow down' },
    });
    const result = normalizeOpenAiUpstreamError(body, 200);
    expect(result?.type).toBe('rate_limit_error');
    expect(result?.status).toBe(429);
  });

  it('inspects error.code for server_error even when error.type is present', () => {
    const body = JSON.stringify({
      error: { type: 'requests', code: 'server_error', message: 'down' },
    });
    const result = normalizeOpenAiUpstreamError(body, 500);
    expect(result?.type).toBe('overloaded_error');
  });

  it('recognizes Anthropic rate_limit_error as a structured transient type', () => {
    // The generic detector also serves the Anthropic pass-through bridge; an
    // Anthropic-shaped body is an explicit, unambiguous signal that must pass
    // the hard-4xx guard (a 400 carrying rate_limit_error should still retry).
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'rate limit exceeded' },
    });
    const result = normalizeOpenAiUpstreamError(body, 400);
    expect(result?.type).toBe('rate_limit_error');
    expect(result?.status).toBe(429);
  });

  it('recognizes Anthropic overloaded_error as a structured transient type', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded. Try again.' },
    });
    const result = normalizeOpenAiUpstreamError(body, 400);
    expect(result?.type).toBe('overloaded_error');
    expect(result?.status).toBe(529);
  });

  it('returns null for a normal invalid_request error', () => {
    const body = JSON.stringify({
      error: { type: 'invalid_request_error', message: 'bad model id' },
    });
    expect(normalizeOpenAiUpstreamError(body, 400)).toBeNull();
  });
});

describe('normalizeUpstreamError (combined)', () => {
  it('detects GLM signals first', () => {
    const body = JSON.stringify({ error: { code: '1305', message: '访问量过大' } });
    const result = normalizeUpstreamError(body, 200);
    expect(result?.type).toBe('rate_limit_error');
  });

  it('falls through to the OpenAI detector for OpenAI-shaped errors', () => {
    const body = JSON.stringify({
      error: { type: 'server_error', message: 'down' },
    });
    const result = normalizeUpstreamError(body, 500);
    expect(result?.type).toBe('overloaded_error');
  });

  it('returns null when no detector matches', () => {
    const body = JSON.stringify({ error: { message: 'not found' } });
    expect(normalizeUpstreamError(body, 404)).toBeNull();
  });
});
