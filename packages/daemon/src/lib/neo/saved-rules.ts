import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { nudgedMessageId } from './ask-origin.ts';

export function neoSavedRulesKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${nudgedMessageId(messageId) ?? messageId}`;
}

const NEO_SAVED_RULE_TURNS = 50;

export interface NeoSavedRulesNote {
  pending: string[];
  published: Readonly<Record<string, string[]>>;
}
type NeoSavedRulesNotes = ReadonlyMap<string, NeoSavedRulesNote>;
type NeoSavedRulesKeep = { key: string; note: NeoSavedRulesNote; evict: string[] };

function evictNeoSavedRules(notes: NeoSavedRulesNotes, key: string): string[] {
  const others = [...notes.keys()].filter((existing) => existing !== key);
  return others.slice(0, Math.max(0, others.length + 1 - NEO_SAVED_RULE_TURNS));
}

export function planNeoSavedRulesNote(
  turn: { sessionId?: string; messageId?: string },
  saved: readonly string[],
  notes: NeoSavedRulesNotes
): NeoSavedRulesKeep | null {
  if (!turn.sessionId || !turn.messageId || !saved.length) return null;
  const key = neoSavedRulesKey(turn.sessionId, turn.messageId);
  const current = notes.get(key);
  return {
    key,
    note: {
      pending: [...new Set([...(current?.pending ?? []), ...saved])],
      published: current?.published ?? {},
    },
    evict: evictNeoSavedRules(notes, key),
  };
}

export function planNeoSavedRulesAppend(
  input: NeoPublicationInput,
  notes: NeoSavedRulesNotes,
  current: { standingRules: readonly string[]; stored: boolean }
): { rules: string[]; keep: NeoSavedRulesKeep | null } {
  if (input.interim) return { rules: [], keep: null };
  const key = neoSavedRulesKey(input.producerInput.sessionId, input.producerInput.messageId);
  const note = notes.get(key);
  const replay = note?.published[input.publicationId];
  if (replay !== undefined) return { rules: replay, keep: null };
  if (current.stored || !note) return { rules: [], keep: null };
  const rules = note.pending.filter((rule) => current.standingRules.includes(rule));
  if (!rules.length) return { rules, keep: null };
  return {
    rules,
    keep: {
      key,
      note: { pending: [], published: { ...note.published, [input.publicationId]: rules } },
      evict: [],
    },
  };
}

export function planNeoSavedRules(before: readonly string[], after: readonly string[]): string[] {
  return after.filter((rule) => !before.includes(rule));
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function withSavedLines(text: string, saved: readonly string[], limit: number): string {
  const missing = saved.filter((rule) => !text.includes(`Saved: ${rule}`));
  if (!missing.length) return text;
  const lines = clip(missing.map((rule) => `Saved: ${rule}`).join('\n'), Math.floor(limit / 2));
  return `${clip(text, limit - lines.length - 2)}\n\n${lines}`;
}

export function withNeoSavedRules(
  input: NeoPublicationInput,
  saved: readonly string[]
): NeoPublicationInput {
  if (!saved.length || input.interim) return input;
  return {
    ...input,
    shortText: withSavedLines(input.shortText, saved, 2000),
    fullText: withSavedLines(input.fullText, saved, 16000),
  };
}
