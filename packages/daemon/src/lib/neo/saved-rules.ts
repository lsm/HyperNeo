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
  notes: NeoSavedRulesNotes
): { rules: string[]; keep: NeoSavedRulesKeep | null } {
  if (input.interim) return { rules: [], keep: null };
  const key = neoSavedRulesKey(input.producerInput.sessionId, input.producerInput.messageId);
  const current = notes.get(key);
  const replay = current?.published[input.publicationId];
  if (replay !== undefined) return { rules: replay, keep: null };
  const rules = current?.pending ?? [];
  return {
    rules,
    keep: {
      key,
      note: { pending: [], published: { ...current?.published, [input.publicationId]: rules } },
      evict: evictNeoSavedRules(notes, key),
    },
  };
}

export function planNeoSavedRules(before: readonly string[], after: readonly string[]): string[] {
  return after.filter((rule) => !before.includes(rule));
}

function withSavedLines(text: string, saved: readonly string[], limit: number): string {
  if (text.includes('Saved:')) return text;
  const next = `${text}\n\n${saved.map((rule) => `Saved: ${rule}`).join('\n')}`;
  return next.length > limit ? `${next.slice(0, limit - 1)}…` : next;
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
