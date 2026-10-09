import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { nudgedMessageId } from './ask-origin.ts';

export function neoSavedRulesKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${nudgedMessageId(messageId) ?? messageId}`;
}

const NEO_SAVED_RULE_TURNS = 50;

export function planNeoSavedRulesNote(
  turn: { sessionId?: string; messageId?: string },
  saved: readonly string[],
  noted: ReadonlyMap<string, readonly string[]>
): { key: string; rules: string[]; evict: string[] } | null {
  if (!turn.sessionId || !turn.messageId || !saved.length) return null;
  const key = neoSavedRulesKey(turn.sessionId, turn.messageId);
  const others = [...noted.keys()].filter((existing) => existing !== key);
  return {
    key,
    rules: [...new Set([...(noted.get(key) ?? []), ...saved])],
    evict: others.slice(0, Math.max(0, others.length + 1 - NEO_SAVED_RULE_TURNS)),
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
