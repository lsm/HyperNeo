import { RATE_LIMIT_MESSAGE_PATTERN } from '@hyperneo/shared/provider/error-taxonomy';
import type { SDKRateLimitInfo } from '@hyperneo/shared/sdk';
import {
  extractResetTimestamp,
  isNonRetryableBillingError,
  MAX_RESET_HORIZON_MS,
  RESET_BUFFER_MS,
  USAGE_CAP_KEYWORDS,
  type CooldownDecision,
} from './fallback-recovery';

export type LimitErrorKind = 'rate_limit' | 'usage_limit';

export type LimitErrorConfidence = 'structured' | 'deterministic';

export interface LimitErrorAssessment {
  readonly isLimit: boolean;
  readonly kind: LimitErrorKind | null;
  readonly resetAtMs: number | null;
  readonly confidence: LimitErrorConfidence | null;
  readonly source: string;
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
}

const GLM_LIMIT_CODE_BRACKETS = ['[1305]', '[1308]'];

const LIMIT_TEXT_MARKERS = [...GLM_LIMIT_CODE_BRACKETS, '使用上限', '限额将在'];

export function normalizeEpochMs(value: number): number {
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function structuredResetAtMs(rateLimitInfo: SDKRateLimitInfo, now: number): number | null {
  const candidates = [rateLimitInfo.resetsAt, rateLimitInfo.overageResetsAt];
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    const ms = normalizeEpochMs(candidate);
    if (ms > now && ms < now + MAX_RESET_HORIZON_MS) return ms;
  }
  return null;
}

function looksLikeLimitText(rawText: string): boolean {
  if (/\b429\b/.test(rawText)) return true;
  if (RATE_LIMIT_MESSAGE_PATTERN.test(rawText)) return true;
  return LIMIT_TEXT_MARKERS.some((marker) => rawText.includes(marker));
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
  rateLimitType: string | undefined
): LimitErrorKind {
  if (rateLimitType) return limitKindForRateLimitType(rateLimitType);
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
  const textLimit = rawText !== '' && looksLikeLimitText(rawText);
  const statusLimit = signal.httpStatus === 429;
  const tagLimit = signal.sdkErrorTag === 'rate_limit';
  const blockingTerminal = signal.terminalReason === 'blocking_limit';

  const isLimit =
    structuredReset !== null || textLimit || statusLimit || tagLimit || blockingTerminal;
  if (!isLimit) {
    return { isLimit: false, kind: null, resetAtMs: null, confidence: null, source: 'none' };
  }

  const parsed = rawText !== '' ? extractResetTimestamp(rawText, now) : null;
  const resetAtMs = structuredReset ?? parsed?.resetAtMs ?? null;

  let source = 'text';
  if (structuredReset !== null) source = 'rate_limit_event';
  else if (tagLimit) source = 'sdk-error-tag';
  else if (statusLimit) source = 'http-status';
  else if (parsed) source = `parsed:${parsed.strategy}`;

  return {
    isLimit: true,
    kind: resolveLimitKind(rawText, resetAtMs, signal.rateLimitInfo?.rateLimitType),
    resetAtMs,
    confidence: structuredReset !== null ? 'structured' : 'deterministic',
    source,
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
  return isNonRetryableBillingError(rawText, now);
}
