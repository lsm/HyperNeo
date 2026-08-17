export const SHORT_ID_PREFIX = {
  TASK: 't',
  GOAL: 'g',
} as const;

export function formatShortId(prefix: string, counter: number): string {
  return `${prefix}-${counter}`;
}

export function parseShortId(shortId: string): { prefix: string; counter: number } | null {
  const match = shortId.match(/^([a-z])-(\d+)$/);
  if (!match) return null;
  const counter = parseInt(match[2], 10);
  if (counter < 1) return null;
  return { prefix: match[1], counter };
}

export function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Safely parse a JSON string, returning a fallback value on failure.
 * Use this for reading DB columns that should be JSON but may be corrupted.
 */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Safely parse a JSON string, returning undefined on failure or null input.
 * Use this for reading optional DB columns that should be JSON but may be corrupted.
 */
export function parseJsonOptional<T>(raw: string | null | undefined): T | undefined {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Generate a UUID v4 (browser and Node.js compatible)
 * Uses crypto.randomUUID() if available, otherwise falls back to a polyfill
 */
export function generateUUID(): string {
  // Try to use the native crypto.randomUUID() if available
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  // Fallback for older browsers and environments (UUID v4 format)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Composer/draft character cap shared by the web input and daemon draft writes. */
export const DRAFT_CHAR_LIMIT = 100_000;

const CJK_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const ASCII_QUOTE = /['"`]/;

// Suppress a separating space when the preceding text ends in whitespace or an
// opening bracket/quote (ASCII straight quotes count as opening only when they
// follow whitespace or start-of-text).
function suppressLeadingSpace(before: string): boolean {
  if (before.length === 0) return false;
  const last = before.slice(-1);
  if (/\s/.test(last)) return true;
  if (/\p{Ps}|\p{Pi}/u.test(last)) return true;
  if (ASCII_QUOTE.test(last)) {
    const prev = before.slice(-2, -1);
    return prev === '' || /\s/.test(prev);
  }
  return false;
}

/**
 * Append `text` to an existing draft string, inserting a single separating
 * space only when both sides are non-empty and neither boundary is CJK or a
 * join-suppressing character. CJK scripts need no inter-character space
 * (你好 + 世界 -> 你好世界). Capped to the shared draft character limit.
 *
 * Daemon-only callers: the staged-voice append, the `session.get`
 * composition, and the voice-aware send-clear matching all route through it —
 * and through `composeDraftWhole` — so every join in the voice-draft protocol
 * applies identical spacing rules.
 */
export function appendDraftText(existing: string, text: string): string {
  const needsSpace =
    existing.length > 0 &&
    !suppressLeadingSpace(existing) &&
    !/^\s/.test(text) &&
    !CJK_SCRIPT.test(existing.slice(-1)) &&
    !(text.length > 0 && CJK_SCRIPT.test(text[0] ?? ''));
  return `${existing}${needsSpace ? ' ' : ''}${text}`.slice(0, DRAFT_CHAR_LIMIT);
}

/**
 * Compose `draft` + `pending` with `appendDraftText`, returning the joined
 * string ONLY when it carries both whole — the join equals a plain (optionally
 * space-separated) concatenation and nothing was sliced off at the draft
 * character limit. Returns null when the composition would be truncated.
 *
 * This is the load-bearing predicate of the daemon-coordinated voice draft
 * protocol: it decides when `session.get` presents the staged transcript,
 * when `session.appendVoiceDraft` accepts a new entry, and when the send-clear
 * paths may consume the staging. Its two comparison literals encode
 * `appendDraftText`'s separator rules — keep them in lockstep.
 */
export function composeDraftWhole(draft: string, pending: string): string | null {
  const composed = appendDraftText(draft, pending);
  return composed === `${draft}${pending}` || composed === `${draft} ${pending}` ? composed : null;
}
