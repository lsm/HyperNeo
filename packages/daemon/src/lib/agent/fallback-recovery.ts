import type { FallbackModelEntry } from '@hyperneo/shared';

export type { FallbackModelEntry };

export const MAX_RESET_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export const RESET_BUFFER_MS = 30 * 1000;

export const BACKOFF_LADDER_MS: readonly number[] = [
  10 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
];

export const BACKOFF_CAP_MS = 8 * 60 * 60 * 1000;

export const BACKOFF_JITTER = 0.15;

const BACKOFF_FLOOR_MS = 60 * 1000;

export function entryKey(entry: FallbackModelEntry): string {
  return `${entry.provider}/${entry.model}`;
}

export function resolveFallbackChain(
  provider: string,
  model: string,
  modelFallbackMap: Record<string, FallbackModelEntry[]> | undefined,
  fallbackModels: FallbackModelEntry[] | undefined
): FallbackModelEntry[] {
  const key = entryKey({ provider, model });
  if (modelFallbackMap && Object.hasOwn(modelFallbackMap, key)) {
    return [...(modelFallbackMap[key] ?? [])];
  }
  if (fallbackModels && fallbackModels.length > 0) {
    return [...fallbackModels];
  }
  return [];
}

export type FallbackSkipReason = 'none' | 'tried' | 'unavailable';

export interface FallbackSelection {
  next: FallbackModelEntry | null;
  exhausted: boolean;
  skipReason: FallbackSkipReason;
}

export function selectNextFallback(
  chain: FallbackModelEntry[],
  triedKeys: ReadonlySet<string>,
  isAvailable: (entry: FallbackModelEntry) => boolean,
  keyFn: (entry: FallbackModelEntry) => string = entryKey
): FallbackSelection {
  if (chain.length === 0) {
    return { next: null, exhausted: true, skipReason: 'none' };
  }

  let lastSkip: FallbackSkipReason = 'none';
  for (const entry of chain) {
    if (triedKeys.has(keyFn(entry))) {
      lastSkip = 'tried';
      continue;
    }
    if (!isAvailable(entry)) {
      lastSkip = 'unavailable';
      continue;
    }
    return { next: entry, exhausted: false, skipReason: 'none' };
  }
  return { next: null, exhausted: true, skipReason: lastSkip };
}

export type ResetTimestampStrategy =
  | 'iso8601'
  | 'yyyymmdd-hms'
  | 'epoch-millis'
  | 'epoch-seconds'
  | 'relative-delay'
  | 'structured';

export interface ParsedReset {
  resetAtMs: number;
  strategy: ResetTimestampStrategy;
}

const ISO_WITH_TZ_RE =
  /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})/g;

const LOCAL_DATETIME_RE =
  /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?![Zz]|[+-]\d{2}|\.\d|\d)/g;

const EPOCH_MILLIS_RE = /\b\d{13}\b/g;

const EPOCH_SECONDS_RE = /\b\d{10}\b/g;

const RELATIVE_RESET_RE =
  /\b(?:reset|retry|try again|lifted|available)[^.]{0,60}?\bin\s+(\d{1,4})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/gi;

const RELATIVE_UNIT_MS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60 * 1000,
  min: 60 * 1000,
  hour: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

function relativeUnitMs(unit: string): number {
  const normalized = unit.toLowerCase().replace(/s$/, '');
  return RELATIVE_UNIT_MS[normalized] ?? 0;
}

function isValidReset(ms: number, now: number): boolean {
  if (!Number.isFinite(ms)) return false;
  return ms > now && ms < now + MAX_RESET_HORIZON_MS;
}

function parseLocalGroups(groups: RegExpMatchArray): number {
  const [, yyyy, mm, dd, hh, mi, ss] = groups;
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`).getTime();
}

function parseIsoWithTzGroups(groups: RegExpMatchArray): number {
  const [, yyyy, mm, dd, hh, mi, ss, tz] = groups;
  let offset = '';
  if (tz !== 'Z') {
    const raw = tz.replace(':', '');
    offset = `${raw.slice(0, 3)}:${raw.slice(3)}`;
  }
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${tz === 'Z' ? 'Z' : offset}`;
  return new Date(iso).getTime();
}

export function extractResetTimestamp(
  errorMessage: string,
  now: number = Date.now()
): ParsedReset | null {
  if (!errorMessage) return null;

  const isoMatches = errorMessage.matchAll(ISO_WITH_TZ_RE);
  for (const m of isoMatches) {
    const ms = parseIsoWithTzGroups(m);
    if (isValidReset(ms, now)) return { resetAtMs: ms, strategy: 'iso8601' };
  }

  const localMatches = errorMessage.matchAll(LOCAL_DATETIME_RE);
  for (const m of localMatches) {
    const ms = parseLocalGroups(m);
    if (isValidReset(ms, now)) return { resetAtMs: ms, strategy: 'yyyymmdd-hms' };
  }

  for (const m of errorMessage.matchAll(EPOCH_MILLIS_RE)) {
    const ms = Number.parseInt(m[0], 10);
    if (isValidReset(ms, now)) return { resetAtMs: ms, strategy: 'epoch-millis' };
  }

  for (const m of errorMessage.matchAll(EPOCH_SECONDS_RE)) {
    const ms = Number.parseInt(m[0], 10) * 1000;
    if (isValidReset(ms, now)) return { resetAtMs: ms, strategy: 'epoch-seconds' };
  }

  for (const m of errorMessage.matchAll(RELATIVE_RESET_RE)) {
    const delayMs = Number.parseInt(m[1], 10) * relativeUnitMs(m[2]);
    const ms = now + delayMs;
    if (delayMs > 0 && isValidReset(ms, now)) {
      return { resetAtMs: ms, strategy: 'relative-delay' };
    }
  }

  return null;
}

export type CooldownReason = 'parsed-reset' | 'backoff-ladder';

export interface CooldownDecision {
  delayMs: number;
  retryAtMs: number;
  reason: CooldownReason;
  ladderIndex: number;
  freeWait: boolean;
  reset: ParsedReset | null;
}

export function computeCooldown(
  errorMessage: string,
  cooldownRetryCount: number,
  now: number = Date.now(),
  jitterFn: () => number = () => Math.random() * 2 - 1
): CooldownDecision {
  const parsed = extractResetTimestamp(errorMessage, now);
  if (parsed) {
    const retryAtMs = parsed.resetAtMs + RESET_BUFFER_MS;
    const delayMs = Math.max(0, parsed.resetAtMs - now) + RESET_BUFFER_MS;
    return {
      delayMs,
      retryAtMs,
      reason: 'parsed-reset',
      ladderIndex: -1,
      freeWait: true,
      reset: parsed,
    };
  }

  const lastIndex = BACKOFF_LADDER_MS.length - 1;
  const ladderIndex = Math.min(cooldownRetryCount, lastIndex);
  const base = Math.min(BACKOFF_LADDER_MS[ladderIndex], BACKOFF_CAP_MS);
  const jitter = base * BACKOFF_JITTER * jitterFn();
  const delayMs = Math.max(BACKOFF_FLOOR_MS, Math.round(base + jitter));
  return {
    delayMs,
    retryAtMs: now + delayMs,
    reason: 'backoff-ladder',
    ladderIndex,
    freeWait: false,
    reset: null,
  };
}

export const USAGE_CAP_KEYWORDS = [
  'usage',
  'cap',
  'quota',
  'daily',
  'weekly',
  '上限',
  '额度',
  '小时',
  '周',
];

export function classifyLimitKind(
  errorMessage: string,
  decision: CooldownDecision
): 'rate_limit' | 'usage_limit' {
  if (decision.reason === 'parsed-reset') {
    return 'usage_limit';
  }
  const lower = errorMessage.toLowerCase();
  if (USAGE_CAP_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return 'usage_limit';
  }
  return 'rate_limit';
}

const HTTP_402_STATUS_RE = /\b402\b/;

export function isNonRetryableBillingError(
  errorMessage: string,
  now: number = Date.now()
): boolean {
  const lower = errorMessage.toLowerCase();
  const resettable = !!extractResetTimestamp(errorMessage, now);
  return (
    HTTP_402_STATUS_RE.test(errorMessage) ||
    (!resettable &&
      (lower.includes('no quota') ||
        lower.includes('quota exceeded') ||
        lower.includes('insufficient_quota')))
  );
}
