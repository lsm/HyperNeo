import { fillPrompt, NEO_ASK_PROGRESS, NEO_CARD_PROGRESS } from '@hyperneo/prompts';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';

export function neoNoteChecklist(ask: NeoAsk): { id: string; state: string; text?: string }[] {
  return (ask.doneItems ?? [])
    .filter((item) => !item.removed)
    .map(({ id, text, state }) => (state === 'met' ? { id, state } : { id, state, text }));
}

export function neoAskProgressNote(
  ask: NeoAsk | null,
  what: string,
  data: Record<string, unknown>
): string {
  return ask
    ? `${fillPrompt(NEO_ASK_PROGRESS, { ask_id: ask.id, title: ask.title, what })}\n${JSON.stringify(
        { askId: ask.id, status: ask.status, items: neoNoteChecklist(ask), ...data }
      )}`
    : `${fillPrompt(NEO_CARD_PROGRESS, { what })}\n${JSON.stringify(data)}`;
}
