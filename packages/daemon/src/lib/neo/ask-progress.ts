import { fillPrompt, NEO_ASK_PROGRESS } from '@hyperneo/prompts';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { neoNoteChecklist } from './driver-work.ts';

export function neoAskProgressNote(
  ask: NeoAsk,
  what: string,
  data: Record<string, unknown>
): string {
  return `${fillPrompt(NEO_ASK_PROGRESS, { ask_id: ask.id, title: ask.title, what })}\n${JSON.stringify(
    { askId: ask.id, status: ask.status, items: neoNoteChecklist(ask), ...data }
  )}`;
}
