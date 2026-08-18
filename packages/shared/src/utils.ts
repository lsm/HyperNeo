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

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonOptional<T>(raw: string | null | undefined): T | undefined {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function generateUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const DRAFT_CHAR_LIMIT = 100_000;

const CJK_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const ASCII_QUOTE = /['"`]/;

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

export function appendDraftText(existing: string, text: string): string {
  const needsSpace =
    existing.length > 0 &&
    !suppressLeadingSpace(existing) &&
    !/^\s/.test(text) &&
    !CJK_SCRIPT.test(existing.slice(-1)) &&
    !(text.length > 0 && CJK_SCRIPT.test(text[0] ?? ''));
  return `${existing}${needsSpace ? ' ' : ''}${text}`.slice(0, DRAFT_CHAR_LIMIT);
}

export function matchesDraftOrComposition(
  draft: string,
  pending: string,
  expected: string
): 'direct' | 'composition' | null {
  if (draft.trim() === expected.trim()) return 'direct';
  if (pending.trim() !== '') {
    const composed = composeDraftWhole(draft, pending);
    if (composed !== null && composed.trim() === expected.trim()) return 'composition';
  }
  return null;
}

export function composeDraftWhole(draft: string, pending: string): string | null {
  const composed = appendDraftText(draft, pending);
  return composed === `${draft}${pending}` || composed === `${draft} ${pending}` ? composed : null;
}
