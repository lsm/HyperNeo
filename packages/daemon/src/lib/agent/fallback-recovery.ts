/**
 * Fallback model chain + format-agnostic rate/usage-limit reset handling.
 *
 * Pure module (no session/DB deps) consumed by `rate-limit-watchdog.ts`. Kept
 * separate so the chain resolution, timestamp extraction, and backoff ladder
 * are fully unit-testable without an AgentSession or database.
 *
 * Background: `GlobalSettings.fallbackModels` / `modelFallbackMap`
 * (`@hyperneo/shared` settings.ts) were editable in the UI but had no runtime
 * consumers. On 429/usage-cap exhaustion this module resolves the chain, picks
 * the next untried model, and — when the chain is exhausted — computes a
 * cooldown from a reset time extracted format-agnostically from the error text
 * (never by matching vendor-specific phrasing) or an exponential backoff ladder.
 */

import type { FallbackModelEntry } from '@hyperneo/shared';

export type { FallbackModelEntry };

/** Maximum plausible quota-reset window. Parsed timestamps beyond this are rejected. */
export const MAX_RESET_HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Buffer added to a parsed reset time so we retry just after the window lifts. */
export const RESET_BUFFER_MS = 30 * 1000; // 30s

/** Backoff ladder (ms), indexed by cooldown step. Used when no reset time is known. */
export const BACKOFF_LADDER_MS: readonly number[] = [
  10 * 60 * 1000, // 10m
  30 * 60 * 1000, // 30m
  60 * 60 * 1000, // 1h
  2 * 60 * 60 * 1000, // 2h
  4 * 60 * 60 * 1000, // 4h
];

/** Hard cap for any single backoff wait. */
export const BACKOFF_CAP_MS = 8 * 60 * 60 * 1000; // 8h

/** Jitter fraction: actual wait = capped base * (1 ± BACKOFF_JITTER). */
export const BACKOFF_JITTER = 0.15;

/** Minimum backoff wait (floor) so jitter can't shrink a step below this. */
const BACKOFF_FLOOR_MS = 60 * 1000; // 1m

/**
 * Stable dedup key for a fallback entry. We never fall back to the same
 * provider+model that just failed, so this key is also the "tried" marker.
 */
export function entryKey(entry: FallbackModelEntry): string {
  return `${entry.provider}/${entry.model}`;
}

/**
 * Resolve the fallback chain for a (provider, model) pair.
 *
 * Priority: when the `modelFallbackMap` has an entry for
 * `"${provider}/${model}"` (by key PRESENCE, not length), that override wins —
 * including an explicitly empty chain, which the settings UI treats as
 * "disable fallback for this model" (a separate Delete action removes the key
 * to inherit the global list). Otherwise the global `fallbackModels` list is
 * used. Returns a defensive copy so callers cannot mutate the live arrays.
 *
 * Pure: both settings fields are passed in by the caller.
 */
export function resolveFallbackChain(
  provider: string,
  model: string,
  modelFallbackMap: Record<string, FallbackModelEntry[]> | undefined,
  fallbackModels: FallbackModelEntry[] | undefined
): FallbackModelEntry[] {
  const key = entryKey({ provider, model });
  if (modelFallbackMap && Object.hasOwn(modelFallbackMap, key)) {
    // Key present — honor it verbatim (empty = disable fallback for this model).
    return [...(modelFallbackMap[key] ?? [])];
  }
  if (fallbackModels && fallbackModels.length > 0) {
    return [...fallbackModels];
  }
  return [];
}

export type FallbackSkipReason = 'none' | 'tried' | 'unavailable';

export interface FallbackSelection {
  /** The chosen next entry, or null if the chain is exhausted. */
  next: FallbackModelEntry | null;
  /** True when no untried+available entry remains (caller falls through to cooldown). */
  exhausted: boolean;
  /** Why the candidate(s) were skipped, for logging. */
  skipReason: FallbackSkipReason;
}

/**
 * Pick the next chain entry to try.
 *
 * Iteration order = chain order. The first entry whose key is NOT in `triedKeys`
 * AND for which `isAvailable` returns true is returned. The caller must already
 * have added the current (failed) provider/model to `triedKeys` so we never
 * re-select it.
 *
 * `isAvailable` is a synchronous predicate; the watchdog pre-resolves async
 * provider availability into a Set before calling so this function stays pure.
 *
 * `keyFn` defaults to `entryKey` (raw `provider/model`). The watchdog passes a
 * canonical-ID key function so an alias (e.g. `sonnet`) and its canonical
 * fallback entry dedupe and the chain isn't re-entered in a loop.
 */
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

export type ResetTimestampStrategy = 'iso8601' | 'yyyymmdd-hms' | 'epoch-millis' | 'epoch-seconds';

export interface ParsedReset {
  /** Epoch-ms of the parsed reset moment. */
  resetAtMs: number;
  /** Which strategy matched, for telemetry/logging. */
  strategy: ResetTimestampStrategy;
}

// ISO-8601 with an explicit offset or Z (most precise — unambiguous timezone).
// Global flag so `matchAll` can scan every candidate (a past request timestamp
// may precede the future quota reset in the same message).
const ISO_WITH_TZ_RE =
  /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})/g;

// YYYY-MM-DD HH:mm:ss with NO timezone (e.g. the Chinese relay shape). Parsed
// as daemon-local time. Tried only after ISO_WITH_TZ_RE so an explicit offset
// always wins. The `(\.\d+)?` consumes optional fractional seconds so a bare
// fractional LOCAL datetime (`17:55:10.123`) is accepted (truncated to whole
// seconds by parseLocalGroups). The trailing negative lookahead then rejects a
// following `Z` / `[+-]HH(:MM)` zone (a zoned timestamp the ISO pass rejected,
// e.g. stale `11:00+08:00`, can't be reparsed here as a local `11:00`). The
// `\.\d` term lets backtracking past the fractional still see the `.` and reject
// a zoned `11:00:00.000+08:00`; the bare `\d` term rejects the partial-fraction
// backtracking path (`11:00:00.00` leaving `0+08:00`) that would otherwise slip
// through, since a digit following the (shortened) fractional isn't a zone. A
// bare trailing `.` (sentence period) is still allowed — `\.\d` needs a digit.
const LOCAL_DATETIME_RE =
  /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?![Zz]|[+-]\d{2}|\.\d|\d)/g;

// 13-digit epoch millis (word-bounded to avoid UUID/request-id fragments).
const EPOCH_MILLIS_RE = /\b\d{13}\b/g;

// 10-digit epoch seconds (word-bounded; tried last to minimise false positives).
const EPOCH_SECONDS_RE = /\b\d{10}\b/g;

function isValidReset(ms: number, now: number): boolean {
  if (!Number.isFinite(ms)) return false;
  return ms > now && ms < now + MAX_RESET_HORIZON_MS;
}

function parseLocalGroups(groups: RegExpMatchArray): number {
  const [, yyyy, mm, dd, hh, mi, ss] = groups;
  // `new Date('YYYY-MM-DDTHH:mm:ss')` (no Z) parses as LOCAL time per ES spec
  // (V8/Node). Reconstruct with a T separator from the space-separated capture.
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`).getTime();
}

function parseIsoWithTzGroups(groups: RegExpMatchArray): number {
  const [, yyyy, mm, dd, hh, mi, ss, tz] = groups;
  // Normalise offset shape to `±HH:MM` (drop a bare `Z`).
  let offset = '';
  if (tz !== 'Z') {
    const raw = tz.replace(':', '');
    offset = `${raw.slice(0, 3)}:${raw.slice(3)}`;
  }
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${tz === 'Z' ? 'Z' : offset}`;
  return new Date(iso).getTime();
}

/**
 * Extract the first plausible quota-reset timestamp from an error message.
 *
 * Locale- and vendor-agnostic: matches digit/separator shapes only, NEVER
 * Chinese/English phrasing like "将在…重置" / "resets at". Vendors keep
 * changing phrasing; the digit shape is stable.
 *
 * For the relay example
 *   `Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-07-22 17:55:10 重置。]`
 * the `LOCAL_DATETIME_RE` strategy matches `2026-07-22 17:55:10` (the `[1308]`
 * code is 4 digits and never matches the epoch regexes).
 *
 * Accepts only timestamps in the future and within `MAX_RESET_HORIZON_MS`. Past
 * or far-future matches are rejected (returns null → caller uses backoff).
 */
export function extractResetTimestamp(
  errorMessage: string,
  now: number = Date.now()
): ParsedReset | null {
  if (!errorMessage) return null;

  // Each strategy scans EVERY match (not just the first): an error can contain
  // a past request timestamp followed by the future quota reset, and the first
  // token failing isValidReset must not abort the search.
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

  return null;
}

export type CooldownReason = 'parsed-reset' | 'backoff-ladder';

export interface CooldownDecision {
  /** ms from now until the retry should fire. */
  delayMs: number;
  /** Absolute retryAt epoch-ms (for state serialization / UI). */
  retryAtMs: number;
  /** Why this delay was chosen. */
  reason: CooldownReason;
  /** Ladder index (0-based) when reason==='backoff-ladder', else -1. */
  ladderIndex: number;
  /**
   * Whether this wait is "free" — does NOT count toward maxAutoRetries.
   * - parsed-reset: true (we know when the window lifts; waiting isn't a guess).
   * - backoff-ladder: false (each ladder step is one budgeted retry).
   */
  freeWait: boolean;
  /** Parsed reset (when reason==='parsed-reset'), for surfacing to the UI. */
  reset: ParsedReset | null;
}

/**
 * Decide the next cooldown delay after the fallback chain is exhausted.
 *
 * @param errorMessage The 429/usage-limit error text.
 * @param cooldownRetryCount Number of (non-free) cooldown steps already used.
 * @param now Injected for testability.
 * @param jitterFn Injected randomness so tests are deterministic. Defaults to
 *   Math.random scaled to [-1, 1].
 */
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

// Keywords (lowercased; ASCII + the Chinese cap/usage characters) that signal a
// usage CAP rather than a transient rate limit. Used to classify the paused
// status surfaced to the UI. ASCII-only matching is case-insensitive; the CJK
// characters are matched literally.
//
// Deliberately narrow: generic phrases like "exceeded" / "limit reached" appear
// in BOTH transient rate-limit messages ("rate limit exceeded, retry in 60s")
// and usage-cap messages, so they don't discriminate and are excluded. Only
// cap-specific terms classify as a usage_limit; everything else is a transient
// rate_limit.
const USAGE_CAP_KEYWORDS = [
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

/**
 * Classify a paused rate-limit episode as a short `rate_limit` or a
 * daily/weekly `usage_limit`, for surfacing the right task status.
 *
 * Heuristic: a known reset time (parsed timestamp) implies a CAP window, so it
 * is a `usage_limit`. Otherwise, cap/usage keywords in the message override to
 * `usage_limit`; the default is a transient `rate_limit`.
 */
export function classifyLimitKind(
  errorMessage: string,
  decision: CooldownDecision
): 'rate_limit' | 'usage_limit' {
  if (decision.reason === 'parsed-reset') {
    return 'usage_limit';
  }
  // Case-insensitive for ASCII keywords (toLowerCase) and a no-op for CJK
  // characters, so a single lowercased pass covers both — a second raw-message
  // pass would be identical for every CJK entry.
  const lower = errorMessage.toLowerCase();
  if (USAGE_CAP_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return 'usage_limit';
  }
  return 'rate_limit';
}

/**
 * Whether an error message is a NON-retryable billing/quota dead-end (true) vs.
 * a resettable rate/usage cap that should route to recovery (false).
 *
 * 402 and explicit quota phrases ('no quota' / 'quota exceeded' /
 * 'insufficient_quota') are billing — UNLESS the message also carries a
 * resettable timestamp (a future reset window parsed by `extractResetTimestamp`),
 * in which case it's a cap recovery can wait out, not a billing dead-end. Used
 * by QueryRunner to decide whether a 429 reaches `onRateLimitExhausted`; without
 * the reset carve-out, a `429 quota exceeded ... resets at <ts>` would be
 * terminal-billing and the reset parser + usage-limit classification would be
 * unreachable for it.
 */
export function isNonRetryableBillingError(
  errorMessage: string,
  now: number = Date.now()
): boolean {
  const lower = errorMessage.toLowerCase();
  const resettable = !!extractResetTimestamp(errorMessage, now);
  return (
    errorMessage.includes('402') ||
    (!resettable &&
      (lower.includes('no quota') ||
        lower.includes('quota exceeded') ||
        lower.includes('insufficient_quota')))
  );
}
