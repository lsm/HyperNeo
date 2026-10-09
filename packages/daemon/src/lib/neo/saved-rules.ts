import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { nudgedMessageId } from './ask-origin.ts';

export function neoSavedRulesKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${nudgedMessageId(messageId) ?? messageId}`;
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
