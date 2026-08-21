import { describe, expect, test } from 'bun:test';
import {
  BACKOFF_CAP_MS,
  BACKOFF_JITTER,
  BACKOFF_LADDER_MS,
  MAX_RESET_HORIZON_MS,
  RESET_BUFFER_MS,
  classifyLimitKind,
  computeCooldown,
  entryKey,
  extractResetTimestamp,
  isNonRetryableBillingError,
  resolveFallbackChain,
  selectNextFallback,
} from '../../../../src/lib/agent/fallback-recovery';
import type { FallbackModelEntry } from '@hyperneo/shared';

const A: FallbackModelEntry = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
const B: FallbackModelEntry = { provider: 'glm', model: 'glm-4.6' };
const C: FallbackModelEntry = { provider: 'minimax', model: 'abab6.5' };

describe('resolveFallbackChain', () => {
  test('modelFallbackMap override wins over global list', () => {
    const chain = resolveFallbackChain(
      'anthropic',
      'claude-sonnet-4-5',
      { 'anthropic/claude-sonnet-4-5': [B, C] },
      [A]
    );
    expect(chain).toEqual([B, C]);
  });

  test('global list used when map key absent', () => {
    const chain = resolveFallbackChain('glm', 'glm-4.6', { 'anthropic/x': [A] }, [B, C]);
    expect(chain).toEqual([B, C]);
  });

  test('an explicitly empty override disables fallback for that model', () => {
    const chain = resolveFallbackChain(
      'anthropic',
      'claude-sonnet-4-5',
      { 'anthropic/claude-sonnet-4-5': [] },
      [B]
    );
    expect(chain).toEqual([]);
  });

  test('both undefined → empty', () => {
    expect(resolveFallbackChain('anthropic', 'x', undefined, undefined)).toEqual([]);
  });

  test('returns a defensive copy', () => {
    const chain = resolveFallbackChain('anthropic', 'x', undefined, [B, C]);
    chain.push(A);
    const again = resolveFallbackChain('anthropic', 'x', undefined, [B, C]);
    expect(again).toEqual([B, C]);
  });
});

describe('entryKey', () => {
  test('joins provider and model', () => {
    expect(entryKey(A)).toBe('anthropic/claude-sonnet-4-5');
  });
});

describe('selectNextFallback', () => {
  test('returns first untried + available entry', () => {
    const sel = selectNextFallback([A, B, C], new Set(), () => true);
    expect(sel.next).toEqual(A);
    expect(sel.exhausted).toBe(false);
    expect(sel.skipReason).toBe('none');
  });

  test('skips tried entries', () => {
    const tried = new Set([entryKey(A)]);
    const sel = selectNextFallback([A, B, C], tried, () => true);
    expect(sel.next).toEqual(B);
  });

  test('skips the current (just-failed) model when caller pre-adds it', () => {
    const tried = new Set([entryKey(A)]);
    const sel = selectNextFallback([A, B], tried, () => true);
    expect(sel.next).toEqual(B);
  });

  test('skips unavailable entries', () => {
    const sel = selectNextFallback([A, B, C], new Set(), (e) => e !== A && e !== B);
    expect(sel.next).toEqual(C);
  });

  test('reports exhausted with last skip reason', () => {
    const tried = new Set([entryKey(A)]);
    const sel = selectNextFallback([A, B], tried, () => false);
    expect(sel.next).toBeNull();
    expect(sel.exhausted).toBe(true);
    expect(sel.skipReason).toBe('unavailable');
  });

  test('empty chain → exhausted with none', () => {
    const sel = selectNextFallback([], new Set(), () => true);
    expect(sel.next).toBeNull();
    expect(sel.exhausted).toBe(true);
    expect(sel.skipReason).toBe('none');
  });

  test('advances across successive calls as caller adds keys', () => {
    const tried = new Set<string>();
    let sel = selectNextFallback([A, B, C], tried, () => true);
    expect(sel.next).toEqual(A);
    tried.add(entryKey(sel.next!));
    sel = selectNextFallback([A, B, C], tried, () => true);
    expect(sel.next).toEqual(B);
    tried.add(entryKey(sel.next!));
    sel = selectNextFallback([A, B, C], tried, () => true);
    expect(sel.next).toEqual(C);
    tried.add(entryKey(sel.next!));
    sel = selectNextFallback([A, B, C], tried, () => true);
    expect(sel.next).toBeNull();
    expect(sel.exhausted).toBe(true);
  });
});

describe('extractResetTimestamp', () => {
  const NOW = new Date('2026-01-01T00:00:00Z').getTime();

  test('ISO-8601 with Z', () => {
    const r = extractResetTimestamp('rate limited; retry after 2026-01-01T12:00:00Z', NOW);
    expect(r?.strategy).toBe('iso8601');
    expect(r?.resetAtMs).toBe(new Date('2026-01-01T12:00:00Z').getTime());
  });

  test('ISO-8601 with +08:00 offset', () => {
    const r = extractResetTimestamp('resets 2026-01-01T20:00:00+08:00', NOW);
    expect(r?.strategy).toBe('iso8601');
    expect(r?.resetAtMs).toBe(new Date('2026-01-01T12:00:00Z').getTime());
  });

  test('Chinese relay message — YYYY-MM-DD HH:mm:ss parsed as local time', () => {
    const msg =
      'Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-01-02 17:55:10 重置。]';
    const r = extractResetTimestamp(msg, NOW);
    expect(r?.strategy).toBe('yyyymmdd-hms');
    expect(r?.resetAtMs).toBe(new Date('2026-01-02T17:55:10').getTime());
  });

  test('does not match vendor phrasing — only the digit shape', () => {
    const r = extractResetTimestamp('已达到使用上限，请稍后重试', NOW);
    expect(r).toBeNull();
  });

  test('epoch millis (13 digits)', () => {
    const target = NOW + 3 * 60 * 60 * 1000;
    const r = extractResetTimestamp(`retry after ${target}`, NOW);
    expect(r?.strategy).toBe('epoch-millis');
    expect(r?.resetAtMs).toBe(target);
  });

  test('epoch seconds (10 digits)', () => {
    const target = NOW + 3 * 60 * 60 * 1000;
    const r = extractResetTimestamp(`retry-after: ${Math.floor(target / 1000)}`, NOW);
    expect(r?.strategy).toBe('epoch-seconds');
    expect(r?.resetAtMs).toBe(target);
  });

  test('relative delay in minutes', () => {
    const r = extractResetTimestamp('Your limit will reset in 3 minutes.', NOW);
    expect(r?.strategy).toBe('relative-delay');
    expect(r?.resetAtMs).toBe(NOW + 3 * 60 * 1000);
  });

  test('relative delay in hours with retry phrasing', () => {
    const r = extractResetTimestamp('too many requests — please retry in 2 hours', NOW);
    expect(r?.strategy).toBe('relative-delay');
    expect(r?.resetAtMs).toBe(NOW + 2 * 60 * 60 * 1000);
  });

  test('relative delay across a sentence with try-again phrasing', () => {
    const r = extractResetTimestamp(
      'Reached overall message rate limit. Please try again later. Your limit will reset in 3 minutes. (trace ID: 01a4b19cff4f3d160109fe9fae2e4b32)',
      NOW
    );
    expect(r?.strategy).toBe('relative-delay');
    expect(r?.resetAtMs).toBe(NOW + 3 * 60 * 1000);
  });

  test('relative delay beyond the horizon → null', () => {
    expect(extractResetTimestamp('Your limit will reset in 30 days', NOW)).toBeNull();
  });

  test('past date → null', () => {
    expect(extractResetTimestamp('resets 2020-01-01 00:00:00', NOW)).toBeNull();
  });

  test('far-future date (> 7 days) → null', () => {
    expect(extractResetTimestamp('resets 2099-12-31 23:59:59', NOW)).toBeNull();
  });

  test('no timestamp token → null', () => {
    expect(extractResetTimestamp('429 rate limit exceeded', NOW)).toBeNull();
  });

  test('4-digit relay code [1308] does not match epoch-seconds', () => {
    expect(extractResetTimestamp('error [1308] something', NOW)).toBeNull();
  });

  test('ISO with offset is preferred over local interpretation', () => {
    const r = extractResetTimestamp('reset 2026-01-01T12:00:00Z', NOW);
    expect(r?.resetAtMs).toBe(new Date('2026-01-01T12:00:00Z').getTime());
  });

  test('horizon boundary: just under 7 days accepted, over rejected', () => {
    const within = NOW + MAX_RESET_HORIZON_MS - 60_000;
    expect(extractResetTimestamp(`r ${within}`, NOW)?.resetAtMs).toBe(within);
    const beyond = NOW + MAX_RESET_HORIZON_MS + 60_000;
    expect(extractResetTimestamp(`r ${beyond}`, NOW)).toBeNull();
  });

  test('scans past a stale timestamp to find the future reset', () => {
    const past = new Date(NOW - 86_400_000).toISOString();
    const future = new Date(NOW + 3 * 3600_000).toISOString();
    const r = extractResetTimestamp(`requested ${past}; quota resets ${future}`, NOW);
    expect(r?.strategy).toBe('iso8601');
    expect(r?.resetAtMs).toBe(new Date(future).getTime());
  });

  test('scans past stale local-datetime tokens too', () => {
    const futureLocal = '2026-01-02 17:55:10';
    const r = extractResetTimestamp(`stale 2020-01-01 00:00:00 then resets ${futureLocal}`, NOW);
    expect(r?.strategy).toBe('yyyymmdd-hms');
    expect(r?.resetAtMs).toBe(new Date('2026-01-02T17:55:10').getTime());
  });

  test('does not reparse a zoned timestamp as a daemon-local reset', () => {
    const staleZoned = new Date('2026-01-01T05:00:00Z').getTime();
    const r = extractResetTimestamp('retry 2026-01-01T11:00:00+08:00 please', staleZoned);
    expect(r).toBeNull();
  });

  test('does not reparse a fractional-zoned timestamp as a daemon-local reset', () => {
    const staleZoned = new Date('2026-01-01T05:00:00Z').getTime();
    const r = extractResetTimestamp('retry 2026-01-01T11:00:00.000+08:00 please', staleZoned);
    expect(r).toBeNull();
  });

  test('a future fractional-zoned timestamp is parsed as ISO, not local', () => {
    const r = extractResetTimestamp('resets 2026-01-01T20:00:00.000+08:00', NOW);
    expect(r?.strategy).toBe('iso8601');
    expect(r?.resetAtMs).toBe(new Date('2026-01-01T12:00:00Z').getTime());
  });

  test('a fractional-second LOCAL datetime is accepted (truncated to whole seconds)', () => {
    const r = extractResetTimestamp('resets 2026-01-02 17:55:10.123', NOW);
    expect(r?.strategy).toBe('yyyymmdd-hms');
    expect(r?.resetAtMs).toBe(new Date('2026-01-02T17:55:10').getTime());
  });

  test('a local datetime followed by non-offset text still matches', () => {
    const r = extractResetTimestamp('resets 2026-01-02 17:55:10 重置', NOW);
    expect(r?.strategy).toBe('yyyymmdd-hms');
    expect(r?.resetAtMs).toBe(new Date('2026-01-02T17:55:10').getTime());
  });
});

describe('computeCooldown', () => {
  const NOW = new Date('2026-01-01T00:00:00Z').getTime();

  test('parsed-reset → free wait at reset time + buffer', () => {
    const reset = NOW + 5 * 60 * 60 * 1000;
    const d = computeCooldown(`resets 2026-01-01T05:00:00Z`, 0, NOW);
    expect(d.reason).toBe('parsed-reset');
    expect(d.freeWait).toBe(true);
    expect(d.ladderIndex).toBe(-1);
    expect(d.delayMs).toBe(5 * 60 * 60 * 1000 + RESET_BUFFER_MS);
    expect(d.retryAtMs).toBe(reset + RESET_BUFFER_MS);
    expect(d.reset?.strategy).toBe('iso8601');
  });

  test('parsed-reset in near future still adds buffer (never negative)', () => {
    const d = computeCooldown(`resets 2026-01-01T00:00:05Z`, 0, NOW);
    expect(d.delayMs).toBe(5000 + RESET_BUFFER_MS);
  });

  test('backoff ladder progression for steps 0..4', () => {
    const noJitter = () => 0;
    const expected = BACKOFF_LADDER_MS;
    for (let i = 0; i < expected.length; i++) {
      const d = computeCooldown('429 rate limit', i, NOW, noJitter);
      expect(d.reason).toBe('backoff-ladder');
      expect(d.freeWait).toBe(false);
      expect(d.ladderIndex).toBe(i);
      expect(d.delayMs).toBe(Math.min(expected[i], BACKOFF_CAP_MS));
    }
  });

  test('ladder caps at last entry for counts beyond the array', () => {
    const noJitter = () => 0;
    const d = computeCooldown('429', 99, NOW, noJitter);
    expect(d.ladderIndex).toBe(BACKOFF_LADDER_MS.length - 1);
    expect(d.delayMs).toBe(
      Math.min(BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1], BACKOFF_CAP_MS)
    );
  });

  test('delay never exceeds BACKOFF_CAP_MS even with max positive jitter', () => {
    const maxPos = () => 1;
    for (let i = 0; i < 10; i++) {
      const d = computeCooldown('429', i, NOW, maxPos);
      expect(d.delayMs).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    }
  });

  test('jitter stays within ±BACKOFF_JITTER of the (capped) base', () => {
    const base = Math.min(BACKOFF_LADDER_MS[0], BACKOFF_CAP_MS);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 1000; i++) {
      const d = computeCooldown('429', 0, NOW);
      min = Math.min(min, d.delayMs);
      max = Math.max(max, d.delayMs);
    }
    expect(min).toBeGreaterThanOrEqual(Math.round(base * (1 - BACKOFF_JITTER)));
    expect(max).toBeLessThanOrEqual(Math.round(base * (1 + BACKOFF_JITTER)));
  });

  test('backoff floor 1min even with max negative jitter', () => {
    const maxNeg = () => -1;
    const d = computeCooldown('429', 0, NOW, maxNeg);
    expect(d.delayMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe('classifyLimitKind', () => {
  test('parsed-reset → usage_limit', () => {
    const d = computeCooldown(
      'resets 2026-01-01T05:00:00Z',
      0,
      new Date('2026-01-01T00:00:00Z').getTime()
    );
    expect(classifyLimitKind('some message', d)).toBe('usage_limit');
  });

  test('backoff with usage keyword → usage_limit', () => {
    const d = { reason: 'backoff-ladder' } as ReturnType<typeof computeCooldown>;
    expect(classifyLimitKind('usage limit reached', d)).toBe('usage_limit');
  });

  test('backoff with Chinese 上限 keyword → usage_limit', () => {
    const d = { reason: 'backoff-ladder' } as ReturnType<typeof computeCooldown>;
    expect(classifyLimitKind('已达到使用上限', d)).toBe('usage_limit');
  });

  test('backoff with no cap signal → rate_limit', () => {
    const d = { reason: 'backoff-ladder' } as ReturnType<typeof computeCooldown>;
    expect(classifyLimitKind('429 too many requests', d)).toBe('rate_limit');
  });
});

describe('isNonRetryableBillingError', () => {
  const NOW = new Date('2026-01-01T00:00:00Z').getTime();
  const FUTURE = new Date('2026-01-01T05:00:00Z').toISOString();

  test('402 is always billing (even with a reset timestamp)', () => {
    expect(isNonRetryableBillingError('402 payment required', NOW)).toBe(true);
    expect(isNonRetryableBillingError(`402 quota exceeded resets at ${FUTURE}`, NOW)).toBe(true);
  });

  test('quota phrase with no reset timestamp is billing (non-resettable)', () => {
    expect(isNonRetryableBillingError('429 quota exceeded', NOW)).toBe(true);
    expect(isNonRetryableBillingError('You have no quota', NOW)).toBe(true);
    expect(isNonRetryableBillingError('insufficient_quota', NOW)).toBe(true);
  });

  test('quota phrase WITH a resettable timestamp routes to recovery (not billing)', () => {
    expect(isNonRetryableBillingError(`429 quota exceeded — resets at ${FUTURE}`, NOW)).toBe(false);
    expect(
      isNonRetryableBillingError(`rate limited; insufficient_quota; reset ${FUTURE}`, NOW)
    ).toBe(false);
  });

  test('a plain rate-limit 429 is not billing', () => {
    expect(isNonRetryableBillingError('429 rate limited', NOW)).toBe(false);
    expect(isNonRetryableBillingError('429 Too Many Requests', NOW)).toBe(false);
  });
});
