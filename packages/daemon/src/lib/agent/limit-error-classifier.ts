import { RATE_LIMIT_MESSAGE_PATTERN } from '@hyperneo/shared/provider/error-taxonomy';
import type { SDKRateLimitInfo } from '@hyperneo/shared/sdk';
import {
  type CooldownDecision,
  extractResetTimestamp,
  isNonRetryableBillingError,
  MAX_RESET_HORIZON_MS,
  RESET_BUFFER_MS,
  USAGE_CAP_KEYWORDS,
} from './fallback-recovery';

export type LimitErrorKind = 'rate_limit' | 'usage_limit';

export type LimitErrorConfidence = 'structured' | 'deterministic';

export interface LimitErrorAssessment {
  readonly isLimit: boolean;
  readonly kind: LimitErrorKind | null;
  readonly resetAtMs: number | null;
  readonly confidence: LimitErrorConfidence | null;
  readonly source: string;
  readonly billingTerminal: boolean;
}

export interface LimitErrorSignal {
  readonly rawText?: string;
  readonly httpStatus?: number | null;
  readonly sdkErrorTag?: string;
  readonly terminalReason?: string;
  readonly rateLimitInfo?: SDKRateLimitInfo;
}

export interface LimitRetryHint {
  resetAtMs?: number | null;
  kind?: LimitErrorKind | null;
  billingTerminal?: boolean | null;
}

const GLM_LIMIT_CODE_BRACKETS = ['[1305]', '[1308]', '[1313]'];

const LIMIT_TEXT_MARKERS = [...GLM_LIMIT_CODE_BRACKETS, '使用上限', '限额将在', 'usage limit'];

const BILLING_CYCLE_RE = /billing cycle|purchase extra usage|upgrade your plan/i;

const PROMPT_TOO_LONG_RE = /prompt is too long/i;

const LIMIT_TERMINAL_REASONS = new Set(['blocking_limit', 'rapid_refill_breaker']);

export function normalizeEpochMs(value: number): number {
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function isRejectedRateLimitEvent(rateLimitInfo: SDKRateLimitInfo): boolean {
  return rateLimitInfo.status === 'rejected' || rateLimitInfo.overageStatus === 'rejected';
}

function isStructuredBillingTerminal(rateLimitInfo: SDKRateLimitInfo | undefined): boolean {
  if (!rateLimitInfo) return false;
  return (
    rateLimitInfo.errorCode === 'credits_required' ||
    rateLimitInfo.overageDisabledReason === 'out_of_credits'
  );
}

function structuredResetAtMs(rateLimitInfo: SDKRateLimitInfo, now: number): number | null {
  const candidates: Array<[boolean, number | undefined]> = [
    [rateLimitInfo.status === 'rejected', rateLimitInfo.resetsAt],
    [rateLimitInfo.overageStatus === 'rejected', rateLimitInfo.overageResetsAt],
  ];
  let earliest: number | null = null;
  for (const [rejected, candidate] of candidates) {
    if (!rejected) continue;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    const ms = normalizeEpochMs(candidate);
    if (ms > now && ms < now + MAX_RESET_HORIZON_MS) {
      if (earliest === null || ms < earliest) earliest = ms;
    }
  }
  return earliest;
}

const FRAMED_429_RE =
  /\b(?:status|code|http|error|failed|failure|rejected|returned)\W{0,10}429\b(?!\s*(?:ms|millisecond|second|sec|minute|min|hour|hr|s)\b)|\(\s*429\s*\)|\b429\b[^A-Za-z0-9]{0,3}(?:too many requests|rate[ _-]?limit)/i;

function looksLikeLimitText(rawText: string): boolean {
  if (FRAMED_429_RE.test(rawText)) return true;
  if (RATE_LIMIT_MESSAGE_PATTERN.test(rawText)) return true;
  const lower = rawText.toLowerCase();
  return LIMIT_TEXT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

function limitKindForRateLimitType(rateLimitType: string): LimitErrorKind {
  if (rateLimitType === 'five_hour') return 'usage_limit';
  if (rateLimitType === 'overage') return 'usage_limit';
  if (rateLimitType.startsWith('seven_day')) return 'usage_limit';
  return 'rate_limit';
}

function resolveLimitKind(
  rawText: string,
  resetAtMs: number | null,
  rateLimitType: string | undefined,
  billingTerminal: boolean
): LimitErrorKind {
  if (rateLimitType) return limitKindForRateLimitType(rateLimitType);
  if (billingTerminal) return 'usage_limit';
  if (resetAtMs !== null) return 'usage_limit';
  const lower = rawText.toLowerCase();
  return USAGE_CAP_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
    ? 'usage_limit'
    : 'rate_limit';
}

export function assessLimitError(
  signal: LimitErrorSignal,
  now: number = Date.now()
): LimitErrorAssessment {
  const rawText = signal.rawText ?? '';

  const structuredReset = signal.rateLimitInfo
    ? structuredResetAtMs(signal.rateLimitInfo, now)
    : null;
  const structuredRejected = signal.rateLimitInfo
    ? isRejectedRateLimitEvent(signal.rateLimitInfo)
    : false;
  const parsed = rawText !== '' ? extractResetTimestamp(rawText, now) : null;
  const resetAtMs = structuredReset ?? parsed?.resetAtMs ?? null;
  const tagBillingTerminal = signal.sdkErrorTag === 'billing_error';
  const billingTerminal =
    resetAtMs === null &&
    (signal.httpStatus === 402 ||
      tagBillingTerminal ||
      isStructuredBillingTerminal(signal.rateLimitInfo) ||
      (rawText !== '' && isBillingTerminal(rawText, now)));
  const textLimit = rawText !== '' && looksLikeLimitText(rawText);
  const statusLimit = signal.httpStatus === 429;
  const tagLimit = signal.sdkErrorTag === 'rate_limit';
  const terminalLimit =
    signal.terminalReason !== undefined &&
    LIMIT_TERMINAL_REASONS.has(signal.terminalReason) &&
    !PROMPT_TOO_LONG_RE.test(rawText);

  const isLimit =
    structuredRejected ||
    structuredReset !== null ||
    textLimit ||
    statusLimit ||
    tagLimit ||
    terminalLimit ||
    billingTerminal;
  if (!isLimit) {
    return {
      isLimit: false,
      kind: null,
      resetAtMs: null,
      confidence: null,
      source: 'none',
      billingTerminal: false,
    };
  }

  let source = 'text';
  if (structuredReset !== null || structuredRejected) source = 'rate_limit_event';
  else if (tagLimit) source = 'sdk-error-tag';
  else if (statusLimit) source = 'http-status';
  else if (parsed) source = `parsed:${parsed.strategy}`;
  else if (billingTerminal) source = 'billing';

  return {
    isLimit: true,
    kind: resolveLimitKind(
      rawText,
      resetAtMs,
      signal.rateLimitInfo?.rateLimitType,
      billingTerminal
    ),
    resetAtMs,
    confidence: structuredReset !== null || structuredRejected ? 'structured' : 'deterministic',
    source,
    billingTerminal,
  };
}

export function cooldownFromReset(resetAtMs: number, now: number = Date.now()): CooldownDecision {
  return {
    delayMs: Math.max(0, resetAtMs - now) + RESET_BUFFER_MS,
    retryAtMs: resetAtMs + RESET_BUFFER_MS,
    reason: 'parsed-reset',
    ladderIndex: -1,
    freeWait: true,
    reset: { resetAtMs, strategy: 'structured' },
  };
}

export function isBillingTerminal(rawText: string, now: number = Date.now()): boolean {
  if (extractResetTimestamp(rawText, now) !== null) return false;
  return isNonRetryableBillingError(rawText, now) || BILLING_CYCLE_RE.test(rawText);
}
