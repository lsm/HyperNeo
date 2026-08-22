import { describe, expect, it } from 'bun:test';
import { RESET_BUFFER_MS } from '../../../../src/lib/agent/fallback-recovery';
import {
  assessLimitError,
  cooldownFromReset,
  isBillingTerminal,
  normalizeEpochMs,
} from '../../../../src/lib/agent/limit-error-classifier';

const NOW = new Date('2026-08-21T15:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

function localResetText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const GLM_RESET_AT = NOW + 77 * 60 * 1000;
const GLM_1308_TEXT = `API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 ${localResetText(GLM_RESET_AT)} 重置。][2026082114402920b86e4852dc4a56]`;

describe('normalizeEpochMs', () => {
  it('multiplies epoch-seconds values into milliseconds', () => {
    expect(normalizeEpochMs(1779572400)).toBe(1779572400_000);
  });

  it('leaves epoch-milliseconds values untouched', () => {
    expect(normalizeEpochMs(1779572400_000)).toBe(1779572400_000);
  });
});

describe('assessLimitError', () => {
  it('detects the GLM 1308 Chinese usage-cap text and parses its reset time', () => {
    const assessment = assessLimitError({ rawText: GLM_1308_TEXT }, NOW);
    expect(assessment.isLimit).toBe(true);
    expect(assessment.kind).toBe('usage_limit');
    expect(assessment.resetAtMs).toBe(GLM_RESET_AT);
    expect(assessment.confidence).toBe('deterministic');
    expect(assessment.source).toBe('parsed:yyyymmdd-hms');
  });

  it('detects GLM bracketed provider codes without a 429 substring', () => {
    const assessment = assessLimitError({ rawText: 'upstream rejected [1305] try later' }, NOW);
    expect(assessment.isLimit).toBe(true);
    expect(assessment.kind).toBe('rate_limit');
    expect(assessment.resetAtMs).toBeNull();
  });

  it('parses a relative reset delay from a 400 authentication_error wrapper', () => {
    const assessment = assessLimitError(
      {
        rawText:
          'devin stream error permission_denied: Reached overall message rate limit. ' +
          'Please try again later. Your limit will reset in 3 minutes. ' +
          '(trace ID: 01a4b19cff4f3d160109fe9fae2e4b32)',
        httpStatus: 400,
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.resetAtMs).toBe(NOW + 3 * 60 * 1000);
    expect(assessment.source).toBe('parsed:relative-delay');
    expect(assessment.kind).toBe('usage_limit');
  });

  it('parses hourly relative delays from retry phrasing', () => {
    const assessment = assessLimitError(
      { rawText: 'too many requests — please retry in 2 hours' },
      NOW
    );
    expect(assessment.resetAtMs).toBe(NOW + 2 * 60 * 60 * 1000);
  });

  it('treats an HTTP 429 status as a limit even with an unparseable body', () => {
    const assessment = assessLimitError(
      { rawText: '<html>Blocked by firewall</html>', httpStatus: 429 },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.source).toBe('http-status');
    expect(assessment.resetAtMs).toBeNull();
    expect(assessment.kind).toBe('rate_limit');
  });

  it('treats the SDK rate_limit assistant error tag as a limit', () => {
    const assessment = assessLimitError(
      { rawText: 'provider said no', sdkErrorTag: 'rate_limit' },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.source).toBe('sdk-error-tag');
  });

  it('treats a blocking_limit terminal reason as a limit without text markers', () => {
    const assessment = assessLimitError(
      { rawText: 'You have hit a blocking limit.', terminalReason: 'blocking_limit' },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.source).toBe('text');
  });

  it('prefers a structured rate_limit_event reset over text parsing', () => {
    const resetsAtSeconds = Math.floor((NOW + 3 * HOUR) / 1000);
    const textReset = NOW + 6 * HOUR;
    const assessment = assessLimitError(
      {
        rawText: `rate limit — retry after ${new Date(textReset).toISOString()}`,
        rateLimitInfo: {
          status: 'rejected',
          resetsAt: resetsAtSeconds,
          rateLimitType: 'five_hour',
        },
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.confidence).toBe('structured');
    expect(assessment.source).toBe('rate_limit_event');
    expect(assessment.resetAtMs).toBe(resetsAtSeconds * 1000);
    expect(assessment.kind).toBe('usage_limit');
  });

  it('maps seven_day rate limit types to usage_limit', () => {
    const resetsAt = NOW + 5 * 24 * HOUR;
    const assessment = assessLimitError(
      {
        rawText: 'rate limit',
        rateLimitInfo: { status: 'rejected', resetsAt, rateLimitType: 'seven_day' },
      },
      NOW
    );
    expect(assessment.kind).toBe('usage_limit');
  });

  it('keeps a rejected event as limit evidence even when its reset timestamp is stale', () => {
    const assessment = assessLimitError(
      {
        rawText: 'no markers here',
        rateLimitInfo: { status: 'rejected', resetsAt: NOW - HOUR, rateLimitType: 'five_hour' },
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.resetAtMs).toBeNull();
  });

  it('honors structured credits-required billing evidence over generic result text', () => {
    const assessment = assessLimitError(
      {
        rawText: 'Error: upstream rejected the request',
        rateLimitInfo: { status: 'rejected', errorCode: 'credits_required' },
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(true);
    expect(assessment.kind).toBe('usage_limit');
  });

  it('honors structured out-of-credits overage evidence', () => {
    const assessment = assessLimitError(
      {
        rawText: 'Error: upstream rejected the request',
        rateLimitInfo: { status: 'rejected', overageDisabledReason: 'out_of_credits' },
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(true);
  });

  it('does not classify generic server errors as limits', () => {
    expect(assessLimitError({ rawText: 'Error: 500 Internal Server Error' }, NOW).isLimit).toBe(
      false
    );
    expect(assessLimitError({ rawText: 'ECONNREFUSED 127.0.0.1:80' }, NOW).isLimit).toBe(false);
    expect(assessLimitError({ rawText: '' }, NOW).isLimit).toBe(false);
  });

  it('classifies pure billing quota text as a limit with no reset (fallback-only routing)', () => {
    const assessment = assessLimitError({ rawText: 'insufficient_quota: add credits' }, NOW);
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(true);
    expect(assessment.resetAtMs).toBeNull();
  });

  it('detects a billing-cycle cap and routes it as a fallback-only limit', () => {
    const assessment = assessLimitError(
      {
        rawText:
          "Failed to authenticate. API Error: 403 You've reached your usage limit for this billing cycle. " +
          'Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan.',
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(true);
    expect(assessment.kind).toBe('usage_limit');
    expect(assessment.resetAtMs).toBeNull();
    expect(assessment.source).toBe('billing');
  });

  it('flags 402 quota errors as billing-terminal limits', () => {
    const assessment = assessLimitError(
      { rawText: '402 {"error":{"message":"insufficient_quota"}}' },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(true);
  });

  it('treats an HTTP 402 status as billing-terminal evidence with generic text', () => {
    const assessment = assessLimitError({ rawText: 'Payment Required', httpStatus: 402 }, NOW);
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(true);
    expect(assessment.kind).toBe('usage_limit');
  });

  it('keeps a resettable HTTP 402 response in the limit pipeline', () => {
    const assessment = assessLimitError(
      { rawText: 'Payment Required; retry after 2 hours', httpStatus: 402 },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(false);
    expect(assessment.resetAtMs).toBe(NOW + 2 * 60 * 60 * 1000);
  });

  it('routes the SDK billing_error tag as a billing-terminal limit', () => {
    const assessment = assessLimitError(
      { rawText: 'The request could not be completed', sdkErrorTag: 'billing_error' },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(true);
    expect(assessment.kind).toBe('usage_limit');
  });

  it('does not treat a bare 402 token without billing context as billing-terminal', () => {
    const assessment = assessLimitError(
      { rawText: 'request failed after 402 ms (req-402-abcdef)' },
      NOW
    );
    expect(assessment.isLimit).toBe(false);
  });

  it('does not classify an unrelated 429 duration as a limit', () => {
    const assessment = assessLimitError(
      { rawText: 'request failed after 429 ms (req-429-abcdef)' },
      NOW
    );
    expect(assessment.isLimit).toBe(false);
  });

  it('classifies framed textual 429 statuses as limits', () => {
    expect(assessLimitError({ rawText: 'API Error: Request rejected (429)' }, NOW).isLimit).toBe(
      true
    );
    expect(assessLimitError({ rawText: 'upstream error 429 for this key' }, NOW).isLimit).toBe(
      true
    );
    expect(assessLimitError({ rawText: 'Request failed: 429' }, NOW).isLimit).toBe(true);
    expect(assessLimitError({ rawText: '429 Too Many Requests — slow down' }, NOW).isLimit).toBe(
      true
    );
  });

  it('selects the earliest usable rejected reset across primary and overage windows', () => {
    const primaryReset = NOW + 5 * HOUR;
    const overageReset = NOW + 1 * HOUR;
    const assessment = assessLimitError(
      {
        rawText: 'no markers here',
        rateLimitInfo: {
          status: 'rejected',
          resetsAt: primaryReset,
          overageStatus: 'rejected',
          overageResetsAt: overageReset,
          rateLimitType: 'five_hour',
        },
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.resetAtMs).toBe(overageReset);
  });

  it('ignores allowed rate-limit telemetry as limit evidence', () => {
    const resetsAtSeconds = Math.floor((NOW + 5 * HOUR) / 1000);
    for (const status of ['allowed', 'allowed_warning'] as const) {
      const assessment = assessLimitError(
        {
          rawText: 'Error: 500 Internal Server Error',
          rateLimitInfo: { status, resetsAt: resetsAtSeconds, rateLimitType: 'five_hour' },
        },
        NOW
      );
      expect(assessment.isLimit).toBe(false);
    }
  });

  it('treats a rejected event without a reset timestamp as a limit', () => {
    const assessment = assessLimitError(
      {
        rawText: 'Error: upstream rejected the request',
        rateLimitInfo: { status: 'rejected', rateLimitType: 'five_hour' },
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.confidence).toBe('structured');
    expect(assessment.source).toBe('rate_limit_event');
    expect(assessment.resetAtMs).toBeNull();
  });

  it('treats a rejected overage status as limit evidence', () => {
    const assessment = assessLimitError(
      {
        rawText: 'Error: upstream rejected the request',
        rateLimitInfo: { status: 'allowed', overageStatus: 'rejected', rateLimitType: 'overage' },
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
  });

  it('matches usage-limit markers case-insensitively', () => {
    const assessment = assessLimitError({ rawText: 'Usage limit reached. Please try later.' }, NOW);
    expect(assessment.isLimit).toBe(true);
  });

  it('keeps resettable upgrade-advice limits off the billing-terminal path', () => {
    const assessment = assessLimitError(
      {
        rawText:
          '429 rate limit exceeded — your usage limit will reset in 3 hours. ' +
          'Upgrade your plan for higher limits.',
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
    expect(assessment.billingTerminal).toBe(false);
    expect(assessment.resetAtMs).not.toBeNull();
  });

  it('treats a rapid_refill_breaker terminal reason as a limit', () => {
    const assessment = assessLimitError(
      {
        rawText: 'Request interrupted: refill breaker tripped',
        terminalReason: 'rapid_refill_breaker',
      },
      NOW
    );
    expect(assessment.isLimit).toBe(true);
  });

  it('excludes prompt-too-long blocking results from limit recovery', () => {
    const assessment = assessLimitError(
      { rawText: 'Prompt is too long', terminalReason: 'blocking_limit' },
      NOW
    );
    expect(assessment.isLimit).toBe(false);
  });
});

describe('cooldownFromReset', () => {
  it('builds a free-wait cooldown at the reset time plus the buffer', () => {
    const resetAt = NOW + 2 * HOUR;
    const decision = cooldownFromReset(resetAt, NOW);
    expect(decision.freeWait).toBe(true);
    expect(decision.reason).toBe('parsed-reset');
    expect(decision.retryAtMs).toBe(resetAt + RESET_BUFFER_MS);
    expect(decision.delayMs).toBe(2 * HOUR + RESET_BUFFER_MS);
    expect(decision.reset).toEqual({ resetAtMs: resetAt, strategy: 'structured' });
  });

  it('clamps a already-passed reset to just the buffer', () => {
    const decision = cooldownFromReset(NOW - HOUR, NOW);
    expect(decision.delayMs).toBe(RESET_BUFFER_MS);
    expect(decision.retryAtMs).toBe(NOW - HOUR + RESET_BUFFER_MS);
  });
});

describe('isBillingTerminal', () => {
  it('flags 402 and non-resettable quota text', () => {
    expect(isBillingTerminal('402 Payment Required', NOW)).toBe(true);
    expect(isBillingTerminal('insufficient_quota', NOW)).toBe(true);
  });

  it('flags billing-cycle caps', () => {
    expect(isBillingTerminal("You've reached your usage limit for this billing cycle", NOW)).toBe(
      true
    );
  });

  it('does not flag resettable limit errors', () => {
    expect(isBillingTerminal(GLM_1308_TEXT, NOW)).toBe(false);
  });
});
